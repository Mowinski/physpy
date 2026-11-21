"""Cell splitting (`# %%`) and isolated cell execution with explicit `export`."""

from __future__ import annotations

import ast
import builtins
import contextlib
import copy
import io
import json
import linecache
import os
import re
import sys
import traceback
import warnings
from dataclasses import dataclass, field
from typing import Any

from . import importer
from .complete import get_completions, get_signature
from .errors import TranspileError
from .matrix import MATRIX_FN, make_matrix, to_matrix_latex
from .pipeline import compile_source, to_ast
from .plotting import PLOT_FN, copy_figure, render_plot_bundle, resolve_figure
from .symbols import IDENTIFIERS
from .tables import TABLE_FN, extract_table_data, is_tabular_object
from .units import UNIT_FN, make_quantity, reset_ureg

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
    tables: list[dict[str, Any]] = field(default_factory=list)  # structured DataFrame tables
    non_table_stdout: str = ""  # stdout excluding auto-captured `print(df)` blocks
    plot_meta: list[dict[str, Any]] = field(default_factory=list)  # SVG/PDF/axes metadata per plot


class _CellStdout(io.StringIO):
    """Captures full stdout while optionally excluding auto-captured table prints."""

    def __init__(self, non_table_buf: io.StringIO) -> None:
        super().__init__()
        self._non_table = non_table_buf
        self.suppress_non_table = False

    def write(self, s: str) -> int:
        if not self.suppress_non_table:
            self._non_table.write(s)
        return super().write(s)


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
    r = " ".join(r.split())
    return r if len(r) <= 240 else r[:237] + "..."


def _full_repr(val: Any) -> str:
    """Return an untruncated human-readable string representation of ``val``."""
    import pprint

    try:
        np = sys.modules.get("numpy")
        if hasattr(val, "_REGISTRY") and hasattr(val, "magnitude") and hasattr(val, "units"):
            mag = val.magnitude
            if np is not None and isinstance(mag, np.ndarray):
                arr_str = np.array2string(mag, threshold=sys.maxsize, max_line_width=100)
                unit_str = f"{val.units:~P}".strip()
                return f"{arr_str} {unit_str}" if unit_str and unit_str != "dimensionless" else arr_str
            return f"{val:~P}"
        if np is not None and isinstance(val, np.ndarray):
            return np.array2string(val, threshold=sys.maxsize, max_line_width=100)
        if isinstance(val, (dict, list, tuple)):
            return pprint.pformat(val, width=100, sort_dicts=False)
        return repr(val)
    except BaseException:
        try:
            return repr(val)
        except BaseException:
            return f"<{type(val).__name__}>"


@dataclass
class PlotReplEntry:
    """Stores an isolated deep copy of a Figure created by `plot ...` for interactive modal REPL."""

    plot_id: str
    base_fig: Any
    work_fig: Any
    history: list[str] = field(default_factory=list)
    ns: dict[str, Any] = field(default_factory=dict)


_IDEMPOTENT_PLOT_PREFIXES: tuple[tuple[str, ...], ...] = (
    ("ax.set_title(",),
    ("ax.set_xlabel(",),
    ("ax.set_ylabel(",),
    ("ax.set_xlim(",),
    ("ax.set_ylim(",),
    ("ax.set_xscale(",),
    ("ax.set_yscale(",),
    ("ax.grid(",),
    ("ax.legend(", "if ax.get_legend():"),
    ("ax.title.set_fontsize(",),
)


_SERIES_LABEL_RE = re.compile(r"^(ax\.(?:lines|collections)\[\d+\]\.set_label\()")


def _record_plot_history(history: list[str], snippet: str) -> None:
    if "\n" not in snippet:
        m = _SERIES_LABEL_RE.match(snippet)
        if m:
            prefix = m.group(1)
            for idx, existing in enumerate(history):
                if "\n" not in existing and existing.startswith(prefix):
                    history[idx] = snippet
                    return
            history.append(snippet)
            return
        for group in _IDEMPOTENT_PLOT_PREFIXES:
            if any(snippet.startswith(p) for p in group):
                for idx, existing in enumerate(history):
                    if "\n" not in existing and any(existing.startswith(p) for p in group):
                        history[idx] = snippet
                        return
                break
    history.append(snippet)


def _is_matplotlib_artist_result(val: Any) -> bool:
    """Return True if ``val`` is a Matplotlib Artist/Axes/Figure or a sequence of Artists."""
    try:
        from matplotlib.artist import Artist

        if isinstance(val, Artist):
            return True
        if isinstance(val, (list, tuple)) and val and all(isinstance(x, Artist) for x in val):
            return True
    except Exception:
        pass
    return False


class NotebookSession:
    """Holds only explicitly `export`-ed variables (and exported `const` names) between cell runs."""

    MAX_STORED_PLOTS = 64

    def __init__(self) -> None:
        os.environ["MPLBACKEND"] = "Agg"
        try:
            import matplotlib

            matplotlib.use("Agg", force=True)
        except Exception:
            pass
        self.exports: dict[str, Any] = {}
        self.const_owners: dict[str, str] = {}
        self.plot_store: dict[str, PlotReplEntry] = {}
        self._plot_seq: int = 0

    @property
    def consts(self) -> set[str]:
        return set(self.const_owners)

    def reset(self) -> None:
        self.exports.clear()
        self.const_owners.clear()
        self.plot_store.clear()
        self._plot_seq = 0
        linecache.clearcache()
        reset_ureg()
        try:
            import matplotlib.pyplot as plt

            plt.close("all")
        except Exception:
            pass

    def run_cell(self, source: str, filename: str = "<cell>") -> CellResult:
        non_table_buf = io.StringIO()
        out_buf = _CellStdout(non_table_buf)
        err_buf = io.StringIO()

        try:
            if filename == "<cell>":
                other_consts = set(self.const_owners)
                redeclarable = {name for name, owner in self.const_owners.items() if owner == filename}
            else:
                other_consts = {name for name, owner in self.const_owners.items() if owner != filename}
                redeclarable = set()
            tree = to_ast(
                source,
                filename,
                predeclared_consts=other_consts,
                redeclarable_consts=redeclarable,
            )
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
        cell_plot_meta: list[dict[str, Any]] = []
        cell_tables: list[dict[str, Any]] = []
        cell_latex: str | None = None

        def _capture_plot(target: Any) -> None:
            fig = resolve_figure(target)
            self._plot_seq += 1
            plot_id = f"plot_{self._plot_seq}"
            try:
                base_copy = copy_figure(fig)
                work_copy = copy_figure(base_copy)
                self.plot_store[plot_id] = PlotReplEntry(
                    plot_id=plot_id,
                    base_fig=base_copy,
                    work_fig=work_copy,
                )
                while len(self.plot_store) > self.MAX_STORED_PLOTS:
                    oldest_key = next(iter(self.plot_store))
                    del self.plot_store[oldest_key]
            except Exception:
                pass
            bundle = render_plot_bundle(fig, close_fig=True)
            cell_plots.append(bundle["png"])
            cell_plot_meta.append(
                {
                    "plot_id": plot_id,
                    "svg": bundle["svg"],
                    "pdf": bundle["pdf"],
                    "axes": bundle["axes"],
                }
            )

        def _capture_table(target: Any) -> None:
            cell_tables.append(extract_table_data(target))

        def _display_val(val: Any) -> None:
            nonlocal cell_latex
            if is_tabular_object(val):
                cell_tables.append(extract_table_data(val))
                return
            mat_latex = to_matrix_latex(val)
            if mat_latex:
                cell_latex = mat_latex
            elif hasattr(val, "_repr_latex_"):
                raw = val._repr_latex_()
                if raw:
                    cell_latex = str(raw).strip("$")
            else:
                out_buf.write(f"{val}\n")

        def _cell_print(*args: Any, sep: str = " ", end: str = "\n", file: Any = None, flush: bool = False) -> None:
            if file is None and len(args) == 1 and is_tabular_object(args[0]):
                tbl = extract_table_data(args[0])
                cell_tables.append(tbl)
                out_buf.suppress_non_table = True
                try:
                    out_buf.write(tbl["raw_text"] + end)
                    if flush:
                        out_buf.flush()
                finally:
                    out_buf.suppress_non_table = False
                return
            builtins.print(*args, sep=sep, end=end, file=file, flush=flush)

        # Cell starts ONLY with builtins and previously exported variables!
        cell_ns: dict[str, Any] = {
            "__name__": "__main__",
            "__file__": filename,
            "__builtins__": __builtins__,
            **self.exports,
            "__exports__": cell_exports,
            "__consts__": cell_consts,
            PLOT_FN: _capture_plot,
            TABLE_FN: _capture_table,
            UNIT_FN: make_quantity,
            MATRIX_FN: make_matrix,
            "print": _cell_print,
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
                            if is_tabular_object(last_val):
                                cell_tables.append(extract_table_data(last_val))
                            else:
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
        if exit_code == 0:
            for stale in [k for k, owner in self.const_owners.items() if owner == filename and k not in cell_consts]:
                del self.const_owners[stale]
        for cname in cell_consts:
            self.const_owners[cname] = filename
        return CellResult(
            stdout=out_buf.getvalue(),
            stderr=err_buf.getvalue(),
            code=exit_code,
            exported={k: _short_repr(v) for k, v in cell_exports.items()},
            all_exports=self.summary(),
            plots=cell_plots,
            latex=cell_latex,
            tables=cell_tables,
            non_table_stdout=non_table_buf.getvalue(),
            plot_meta=cell_plot_meta,
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

    def completion_exports(self) -> dict[str, Any]:
        """Return exports augmented with `fig`, `ax`, `axes`, `plt`, `np` when a plot exists."""
        merged = dict(self.exports)
        if self.plot_store:
            latest = list(self.plot_store.values())[-1]
            merged.setdefault("fig", latest.work_fig)
            axes_list = list(getattr(latest.work_fig, "axes", []))
            merged.setdefault("axes", axes_list)
            if axes_list:
                merged.setdefault("ax", axes_list[0])
            for k, v in latest.ns.items():
                merged.setdefault(k, v)
        try:
            import matplotlib.pyplot as plt

            merged.setdefault("plt", plt)
        except Exception:
            pass
        try:
            import numpy as np

            merged.setdefault("np", np)
        except Exception:
            pass
        return merged

    def eval_plot_code(self, plot_id: str, source: str) -> dict[str, Any]:
        """Execute ``source`` against the working copy of ``plot_id`` in REPL mode and re-render."""
        entry = self.plot_store.get(plot_id)
        if entry is None:
            return {
                "ok": False,
                "error": "Plot copy is no longer in session memory (re-run the cell to recreate it).",
            }

        filename = f"<{plot_id}-repl>"
        out_buf = io.StringIO()
        err_buf = io.StringIO()

        try:
            tree = to_ast(
                source,
                filename,
                predeclared_consts=set(self.const_owners),
            )
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
            return {
                "ok": True,
                "code": 2,
                "stdout": "",
                "stderr": exc.format(filename) + "\n",
                "png": "",
                "plot_meta": None,
                "history": list(entry.history),
            }
        except SyntaxError as exc:
            return {
                "ok": True,
                "code": 2,
                "stdout": "",
                "stderr": f"{filename}:{exc.lineno}:{exc.offset}: syntax error: {exc.msg}\n",
                "png": "",
                "plot_meta": None,
                "history": list(entry.history),
            }

        linecache.cache[filename] = (
            len(source),
            None,
            source.splitlines(keepends=True),
            filename,
        )

        axes_list = list(getattr(entry.work_fig, "axes", []))
        default_ax = axes_list[0] if axes_list else None
        extra_mods: dict[str, Any] = {}
        try:
            import matplotlib.pyplot as plt

            extra_mods["plt"] = plt
        except Exception:
            pass
        try:
            import numpy as np

            extra_mods["np"] = np
        except Exception:
            pass

        dummy_exports: dict[str, Any] = {}
        dummy_consts: set[str] = set()
        reserved_keys = {
            "__name__",
            "__file__",
            "__builtins__",
            "__exports__",
            "__consts__",
            PLOT_FN,
            TABLE_FN,
            UNIT_FN,
            MATRIX_FN,
            "fig",
            "axes",
        }
        repl_ns: dict[str, Any] = {
            "__name__": "__main__",
            "__file__": filename,
            "__builtins__": __builtins__,
            **extra_mods,
            **self.exports,
            **entry.ns,
            "__exports__": dummy_exports,
            "__consts__": dummy_consts,
            PLOT_FN: lambda *_a, **_kw: None,
            TABLE_FN: lambda *_a, **_kw: None,
            UNIT_FN: make_quantity,
            MATRIX_FN: make_matrix,
            "fig": entry.work_fig,
            "axes": axes_list,
        }
        if "ax" not in entry.ns or entry.ns.get("ax") is None:
            repl_ns["ax"] = default_ax

        exit_code = 0
        with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
            try:
                exec(code_main, repl_ns)
                if code_last is not None:
                    last_val = eval(code_last, repl_ns)
                    if (
                        last_val is not None
                        and not _is_matplotlib_artist_result(last_val)
                        and not out_buf.getvalue().strip()
                    ):
                        out_buf.write(f"{_short_repr(last_val)}\n")
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

        if exit_code == 0:
            for k, v in repl_ns.items():
                if k in reserved_keys or k.startswith("__"):
                    continue
                if k in self.exports and self.exports[k] is v:
                    continue
                if k in extra_mods and extra_mods[k] is v:
                    continue
                if k == "ax" and v is default_ax:
                    continue
                entry.ns[k] = v
            stripped = source.strip()
            if stripped:
                _record_plot_history(entry.history, stripped)

        try:
            bundle = render_plot_bundle(entry.work_fig, close_fig=False)
        except Exception as exc:
            return {
                "ok": True,
                "code": 1,
                "stdout": out_buf.getvalue(),
                "stderr": err_buf.getvalue() + f"\nFailed to re-render figure: {exc}\n",
                "png": "",
                "plot_meta": None,
                "history": list(entry.history),
            }

        return {
            "ok": True,
            "code": exit_code,
            "stdout": out_buf.getvalue(),
            "stderr": err_buf.getvalue(),
            "png": bundle["png"],
            "plot_meta": {
                "plot_id": plot_id,
                "svg": bundle["svg"],
                "pdf": bundle["pdf"],
                "axes": bundle["axes"],
            },
            "history": list(entry.history),
        }

    def reset_plot(self, plot_id: str) -> dict[str, Any]:
        """Reset the working figure of ``plot_id`` back to its initial ``plot`` snapshot."""
        entry = self.plot_store.get(plot_id)
        if entry is None:
            return {
                "ok": False,
                "error": "Plot copy is no longer in session memory (re-run the cell to recreate it).",
            }
        entry.work_fig = copy_figure(entry.base_fig)
        entry.history.clear()
        entry.ns.clear()
        bundle = render_plot_bundle(entry.work_fig, close_fig=False)
        return {
            "ok": True,
            "png": bundle["png"],
            "plot_meta": {
                "plot_id": plot_id,
                "svg": bundle["svg"],
                "pdf": bundle["pdf"],
                "axes": bundle["axes"],
            },
            "history": [],
        }


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
                    "plot_meta": res.plot_meta,
                    "latex": res.latex,
                    "tables": res.tables,
                    "non_table_stdout": res.non_table_stdout,
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
        elif cmd == "complete":
            items = get_completions(
                prefix=str(req.get("prefix", "")),
                attr_target=req.get("attr_target"),
                cell_source=str(req.get("cell_source", "")),
                doc_source=str(req.get("doc_source", "")),
                exports=session.completion_exports(),
            )
            resp = {"ok": True, "items": items}
        elif cmd == "signature":
            sig = get_signature(
                expr=str(req.get("expr", "")),
                cell_source=str(req.get("cell_source", "")),
                doc_source=str(req.get("doc_source", "")),
                exports=session.completion_exports(),
            )
            resp = {"ok": True, "signature": sig}
        elif cmd == "eval_plot":
            plot_id = str(req.get("plot_id", ""))
            source = str(req.get("source", ""))
            doc_source = str(req.get("doc_source", ""))
            if doc_source:
                session.ensure_global_imports(doc_source)
            resp = session.eval_plot_code(plot_id, source)
        elif cmd == "reset_plot":
            plot_id = str(req.get("plot_id", ""))
            resp = session.reset_plot(plot_id)
        elif cmd == "check_plot":
            plot_id = str(req.get("plot_id", ""))
            resp = {"ok": True, "available": bool(plot_id and plot_id in session.plot_store)}
        elif cmd == "format_code":
            from .formatter import format_physpy_code

            source = str(req.get("source", ""))
            line_length = int(req.get("line_length", 999999))
            formatted = format_physpy_code(source, line_length=line_length)
            resp = {"ok": True, "formatted": formatted}
        elif cmd == "format_cells":
            from .formatter import format_cells_batch

            raw_cells = req.get("cells", [])
            line_length = int(req.get("line_length", 999999))
            formatted_cells = format_cells_batch(
                [str(c) for c in raw_cells], line_length=line_length
            )
            resp = {"ok": True, "cells": formatted_cells}
        elif cmd == "inspect_var":
            var_name = str(req.get("name", ""))
            if var_name in session.exports:
                val = session.exports[var_name]
                resp = {
                    "ok": True,
                    "info": {
                        "name": var_name,
                        "type": type(val).__name__,
                        "value": _full_repr(val),
                    },
                }
            else:
                resp = {"ok": True, "info": None}
        elif cmd == "debug_start":
            from .debugger import debug_cell

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

            def _send_rpc(payload: dict[str, Any]) -> None:
                sys.__stdout__.write(f"{RPC_PREFIX}{json.dumps(payload)}\n")
                sys.__stdout__.flush()

            def _read_cmd() -> dict[str, Any]:
                while True:
                    line = sys.__stdin__.readline()
                    if not line:
                        return {"action": "stop"}
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        return json.loads(line)
                    except Exception:
                        return {"action": "stop"}

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
                res = debug_cell(session, source, label, cell_index, _send_rpc, _read_cmd)
                resp = {
                    "ok": True,
                    "event": "finished",
                    "result": {
                        "stdout": res.stdout,
                        "stderr": res.stderr,
                        "code": res.code,
                        "exported": res.exported,
                        "all_exports": res.all_exports,
                        "plots": res.plots,
                        "plot_meta": res.plot_meta,
                        "latex": res.latex,
                        "tables": res.tables,
                        "non_table_stdout": res.non_table_stdout,
                    },
                }
            except Exception as exc:
                resp = {
                    "ok": False,
                    "event": "error",
                    "error": f"Internal debugger error: {traceback.format_exc()}",
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
