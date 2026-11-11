"""Cell splitting (`# %%`) and isolated cell execution with explicit `export`."""

from __future__ import annotations

import ast
import contextlib
import io
import json
import linecache
import os
import re
import sys
import traceback
import warnings
from dataclasses import dataclass
from typing import Any

from . import importer
from .errors import TranspileError
from .matrix import MATRIX_FN, make_matrix, to_matrix_latex
from .pipeline import compile_source, to_ast
from .plotting import PLOT_FN, render_plot_png_base64
from .symbols import IDENTIFIERS
from .units import UNIT_FN, make_quantity

CELL_HEADER_RE = re.compile(r"^# %%[^\S\n]*(.*)$", re.MULTILINE)
EXPORT_IMPORT_RE = re.compile(r"^[ \t]*export[ \t]+(?:import|from)\b.*$", re.MULTILINE)

# Reverse map: normalized Greek identifier -> `\name` for pretty display in UI badges
REVERSE_SYMBOLS: dict[str, str] = {ident: f"\\{name}" for name, ident in IDENTIFIERS.items()}


@dataclass
class Cell:
    title: str
    source: str
    start_line: int  # 1-based line number in the full file


@dataclass
class CellResult:
    stdout: str
    stderr: str
    code: int
    exported: dict[str, str]  # newly exported in this cell: name -> short repr
    all_exports: dict[str, str]  # all active exports in session: name -> short repr
    plots: list[str]  # base64-encoded PNG images produced by `plot ...`
    latex: str | None = None  # KaTeX/LaTeX string for matrix/expression display


def split_cells(src: str) -> list[Cell]:
    """Split a `.ppy` document on `# %%` markers. If none, returns one cell."""
    matches = list(CELL_HEADER_RE.finditer(src))
    if not matches:
        return [Cell(title="", source=src, start_line=1)]

    cells: list[Cell] = []
    # Content before the first `# %%`, if non-empty
    if matches[0].start() > 0:
        pre = src[: matches[0].start()]
        if pre.strip():
            cells.append(Cell(title="", source=pre.rstrip("\n") + "\n", start_line=1))

    for idx, m in enumerate(matches):
        title = m.group(1).strip()
        body_start = m.end()
        if body_start < len(src) and src[body_start] == "\n":
            body_start += 1
        body_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(src)
        body = src[body_start:body_end]
        start_line = src.count("\n", 0, body_start) + 1
        cells.append(Cell(title=title, source=body, start_line=start_line))

    return cells or [Cell(title="", source="", start_line=1)]


RPC_PREFIX = "__PHYSPY_RPC_RES__:"


def _short_repr(val: Any) -> str:
    try:
        if hasattr(val, "_REGISTRY") and hasattr(val, "magnitude") and hasattr(val, "units"):
            r = f"{val:~P}"
        else:
            r = repr(val)
    except BaseException:
        try:
            r = f"<{type(val).__name__}>"
        except BaseException:
            r = "<unknown>"
    return r if len(r) <= 48 else r[:45] + "..."


class NotebookSession:
    """Holds only explicitly `export`-ed variables (and exported `const` names) between cell runs."""

    def __init__(self) -> None:
        os.environ["MPLBACKEND"] = "Agg"
        try:
            import matplotlib

            matplotlib.use("Agg", force=True)
        except Exception:
            pass
        self.exports: dict[str, Any] = {}
        self.consts: set[str] = set()

    def reset(self) -> None:
        self.exports.clear()
        self.consts.clear()
        linecache.clearcache()
        try:
            import matplotlib.pyplot as plt

            plt.close("all")
        except Exception:
            pass

    def run_cell(self, source: str, filename: str = "<cell>") -> CellResult:
        out_buf = io.StringIO()
        err_buf = io.StringIO()

        try:
            tree = to_ast(source, filename, predeclared_consts=self.consts)
            has_last_expr = bool(tree.body and isinstance(tree.body[-1], ast.Expr))
            if has_last_expr:
                main_body = tree.body[:-1]
                last_expr = tree.body[-1].value
                mod_main = ast.Module(body=main_body, type_ignores=[])
                mod_last = ast.Expression(body=last_expr)
                ast.fix_missing_locations(mod_main)
                ast.fix_missing_locations(mod_last)
                code_main = compile(mod_main, filename, "exec")
                code_last = compile(mod_last, filename, "eval")
            else:
                code_main = compile(tree, filename, "exec")
                code_last = None
        except TranspileError as exc:
            return CellResult(
                stdout="",
                stderr=exc.format(filename) + "\n",
                code=2,
                exported={},
                all_exports=self.summary(),
                plots=[],
                latex=None,
            )
        except SyntaxError as exc:
            return CellResult(
                stdout="",
                stderr=f"{filename}:{exc.lineno}:{exc.offset}: syntax error: {exc.msg}\n",
                code=2,
                exported={},
                all_exports=self.summary(),
                plots=[],
                latex=None,
            )

        linecache.cache[filename] = (
            len(source),
            None,
            source.splitlines(keepends=True),
            filename,
        )
        importer.install()

        cell_exports: dict[str, Any] = {}
        cell_consts: set[str] = set()
        cell_plots: list[str] = []
        cell_latex: str | None = None

        def _capture_plot(target: Any) -> None:
            cell_plots.append(render_plot_png_base64(target))

        def _display_val(val: Any) -> None:
            nonlocal cell_latex
            mat_latex = to_matrix_latex(val)
            if mat_latex:
                cell_latex = mat_latex
            elif hasattr(val, "_repr_latex_"):
                raw = val._repr_latex_()
                if raw:
                    cell_latex = str(raw).strip("$")
            else:
                out_buf.write(f"{val}\n")

        # Cell starts ONLY with builtins and previously exported variables!
        cell_ns: dict[str, Any] = {
            "__name__": "__main__",
            "__file__": filename,
            "__builtins__": __builtins__,
            **self.exports,
            "__exports__": cell_exports,
            "__consts__": cell_consts,
            PLOT_FN: _capture_plot,
            UNIT_FN: make_quantity,
            MATRIX_FN: make_matrix,
            "display": _display_val,
            "disp": _display_val,
        }

        # Intercept warnings so they land cleanly in cell's stderr instead of polluting stdout
        def _showwarning(message: Any, category: Any, fpath: str, lno: int, file: Any = None, line: Any = None) -> None:
            formatted = warnings.formatwarning(message, category, fpath, lno, line)
            err_buf.write(formatted)

        old_showwarning = warnings.showwarning
        warnings.showwarning = _showwarning

        exit_code = 0
        try:
            with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
                try:
                    exec(code_main, cell_ns)
                    if code_last is not None:
                        last_val = eval(code_last, cell_ns)
                        if last_val is not None:
                            mat_latex = to_matrix_latex(last_val)
                            if mat_latex:
                                cell_latex = mat_latex
                            elif hasattr(last_val, "_repr_latex_"):
                                raw = last_val._repr_latex_()
                                if raw:
                                    cell_latex = str(raw).strip("$")
                            elif not out_buf.getvalue().strip():
                                out_buf.write(f"{last_val}\n")
                except SystemExit as exc:
                    exit_code = exc.code if isinstance(exc.code, int) else 0
                except BaseException:
                    tb = traceback.format_exc().splitlines(keepends=True)
                    user_frames = tb[1:]
                    for i, line in enumerate(user_frames):
                        if f'File "{filename}"' in line:
                            user_frames = user_frames[i:]
                            break
                    err_buf.write(tb[0] + "".join(user_frames))
                    exit_code = 1
        finally:
            warnings.showwarning = old_showwarning
            # Clean up all matplotlib figures to prevent figure leaks and memory accumulation
            try:
                import matplotlib.pyplot as plt

                plt.close("all")
            except Exception:
                pass

        # Commit exports and consts from this cell into the session
        self.exports.update(cell_exports)
        self.consts.update(cell_consts)
        return CellResult(
            stdout=out_buf.getvalue(),
            stderr=err_buf.getvalue(),
            code=exit_code,
            exported={k: _short_repr(v) for k, v in cell_exports.items()},
            all_exports=self.summary(),
            plots=cell_plots,
            latex=cell_latex,
        )

    def ensure_global_imports(self, full_document: str) -> None:
        """Ensure any `export import ...` / `export from ... import ...` in the file are loaded."""
        lines = EXPORT_IMPORT_RE.findall(full_document)
        if not lines:
            return
        snippet = "\n".join(line.lstrip() for line in lines) + "\n"
        try:
            code = compile_source(snippet, "<exported-imports>")
            cell_exports: dict[str, Any] = {}
            ns: dict[str, Any] = {
                "__builtins__": __builtins__,
                **self.exports,
                "__exports__": cell_exports,
            }
            exec(code, ns)
            self.exports.update(cell_exports)
        except Exception:
            pass

    def summary(self) -> dict[str, str]:
        return {k: _short_repr(v) for k, v in self.exports.items()}


def run_worker() -> int:
    """Persistent JSON-lines RPC loop used by the Tauri desktop app."""
    session = NotebookSession()
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            req = json.loads(raw_line)
        except Exception as exc:
            sys.stdout.write(f"{RPC_PREFIX}{json.dumps({'ok': False, 'error': str(exc)})}\n")
            sys.stdout.flush()
            continue

        cmd = req.get("cmd")
        resp: dict[str, Any]
        if cmd == "reset":
            session.reset()
            resp = {"ok": True, "all_exports": {}}
        elif cmd == "run_cell":
            path = req.get("path")
            cwd = req.get("cwd")
            cell_index = req.get("cell_index", 1)
            source = req.get("source", "")
            doc_source = req.get("doc_source", "")
            work_dir: str | None = None
            if path and os.path.exists(path):
                work_dir = os.path.dirname(os.path.abspath(path))
                label = f"{os.path.basename(path)}#cell-{cell_index}"
            elif path and os.path.isdir(os.path.dirname(os.path.abspath(path))):
                work_dir = os.path.dirname(os.path.abspath(path))
                label = f"{os.path.basename(path)}#cell-{cell_index}"
            else:
                if cwd and os.path.isdir(cwd):
                    work_dir = os.path.abspath(cwd)
                label = f"<cell {cell_index}>"

            orig_dir = os.getcwd()
            try:
                if work_dir:
                    try:
                        os.chdir(work_dir)
                    except OSError:
                        pass
                    if work_dir not in sys.path:
                        sys.path.insert(0, work_dir)
                if doc_source:
                    session.ensure_global_imports(doc_source)
                res = session.run_cell(source, label)
                resp = {
                    "ok": True,
                    "stdout": res.stdout,
                    "stderr": res.stderr,
                    "code": res.code,
                    "exported": res.exported,
                    "all_exports": res.all_exports,
                    "plots": res.plots,
                    "latex": res.latex,
                }
            except Exception as exc:
                resp = {
                    "ok": False,
                    "error": f"Internal execution error: {traceback.format_exc()}",
                }
            finally:
                try:
                    os.chdir(orig_dir)
                except OSError:
                    pass
        else:
            resp = {"ok": False, "error": f"unknown command: {cmd}"}

        sys.stdout.write(f"{RPC_PREFIX}{json.dumps(resp)}\n")
        sys.stdout.flush()
    return 0
