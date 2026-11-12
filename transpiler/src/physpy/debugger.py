"""Interactive step-by-step debugger for PhysPy cells using Python's bdb."""

from __future__ import annotations

import ast
import bdb
import builtins
import contextlib
import io
import json
import linecache
import os
import re
import sys
import traceback
import warnings
from typing import Any, Callable

from . import importer
from .errors import TranspileError
from .matrix import MATRIX_FN, make_matrix, to_matrix_latex
from .notebook import CellResult, NotebookSession, _CellStdout, _short_repr
from .pipeline import to_ast
from .plotting import PLOT_FN, render_plot_png_base64
from .tables import TABLE_FN, extract_table_data, is_tabular_object
from .units import UNIT_FN, make_quantity

RPC_PREFIX = "__PHYSPY_RPC_RES__:"

INTERNAL_NAMES = {
    "__name__",
    "__file__",
    "__builtins__",
    "__exports__",
    "__consts__",
    "__doc__",
    "__package__",
    "__loader__",
    "__spec__",
    "__annotations__",
    PLOT_FN,
    TABLE_FN,
    UNIT_FN,
    MATRIX_FN,
    "print",
    "display",
    "disp",
}


def is_external_library(filename: str | None) -> bool:
    """True if filename belongs to Python stdlib, site-packages, or internal frozen modules."""
    if not filename:
        return True
    if "<cell" in filename or "#cell-" in filename:
        return False
    if (
        "site-packages" in filename
        or "dist-packages" in filename
        or "lib/python" in filename
        or "Frameworks/Python" in filename
        or filename.startswith("<frozen")
        or filename == "<string>"
    ):
        return True
    return False


def extract_cell_index_from_filename(filename: str | None) -> int | None:
    if not filename:
        return None
    m = re.search(r"#cell-(\d+)", filename)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    m = re.search(r"<cell\s*(\d+)>", filename)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    return None


class CellDebugger(bdb.Bdb):
    def __init__(
        self,
        session: NotebookSession,
        target_cell_index: int,
        target_filename: str,
        send_fn: Callable[[dict[str, Any]], None],
        read_cmd_fn: Callable[[], dict[str, Any]],
    ) -> None:
        super().__init__()
        self.session = session
        self.target_cell_index = target_cell_index
        self.target_filename = target_filename
        self.send_fn = send_fn
        self.read_cmd_fn = read_cmd_fn
        self.aborted = False

    def _format_locals(self, frame: Any) -> dict[str, str]:
        res: dict[str, str] = {}
        locs = frame.f_locals
        for k, v in locs.items():
            if k in INTERNAL_NAMES or k.startswith("__"):
                continue
            res[k] = _short_repr(v)
        return res

    def user_line(self, frame: Any) -> None:
        fn = frame.f_code.co_filename
        if is_external_library(fn):
            self.set_next(frame)
            return

        cell_idx = extract_cell_index_from_filename(fn) or self.target_cell_index
        locals_map = self._format_locals(frame)

        # Notify UI of pause on line
        self.send_fn({
            "ok": True,
            "event": "paused",
            "line": frame.f_lineno,
            "filename": fn,
            "cell_index": cell_idx,
            "locals": locals_map,
        })

        # Wait for user action from UI
        cmd = self.read_cmd_fn()
        action = cmd.get("action", "step_over")

        if action == "step_into":
            self.set_step()
        elif action == "step_out":
            self.set_return(frame)
        elif action == "continue":
            self.set_continue()
        elif action == "stop":
            self.aborted = True
            self.set_quit()
        else:  # "step_over"
            self.set_next(frame)

    def user_call(self, frame: Any, args: Any) -> None:
        fn = frame.f_code.co_filename
        if is_external_library(fn):
            self.set_next(frame)
            return
        self.set_step()

    def user_return(self, frame: Any, return_value: Any) -> None:
        pass

    def user_exception(self, frame: Any, exc_info: Any) -> None:
        pass


def debug_cell(
    session: NotebookSession,
    source: str,
    filename: str,
    cell_index: int,
    send_fn: Callable[[dict[str, Any]], None],
    read_cmd_fn: Callable[[], dict[str, Any]],
) -> CellResult:
    non_table_buf = io.StringIO()
    out_buf = _CellStdout(non_table_buf)
    err_buf = io.StringIO()

    try:
        tree = to_ast(source, filename, predeclared_consts=session.consts)
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
            all_exports=session.summary(),
            plots=[],
            latex=None,
        )
    except SyntaxError as exc:
        return CellResult(
            stdout="",
            stderr=f"{filename}:{exc.lineno}:{exc.offset}: syntax error: {exc.msg}\n",
            code=2,
            exported={},
            all_exports=session.summary(),
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
    cell_tables: list[dict[str, Any]] = []
    cell_latex: str | None = None

    def _capture_plot(target: Any) -> None:
        cell_plots.append(render_plot_png_base64(target))

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

    def _cell_print(
        *args: Any,
        sep: str = " ",
        end: str = "\n",
        file: Any = None,
        flush: bool = False,
    ) -> None:
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

    cell_ns: dict[str, Any] = {
        "__name__": "__main__",
        "__file__": filename,
        "__builtins__": __builtins__,
        **session.exports,
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

    def _showwarning(
        message: Any,
        category: Any,
        fpath: str,
        lno: int,
        file: Any = None,
        line: Any = None,
    ) -> None:
        formatted = warnings.formatwarning(message, category, fpath, lno, line)
        err_buf.write(formatted)

    old_showwarning = warnings.showwarning
    warnings.showwarning = _showwarning

    debugger = CellDebugger(
        session=session,
        target_cell_index=cell_index,
        target_filename=filename,
        send_fn=send_fn,
        read_cmd_fn=read_cmd_fn,
    )
    debugger.set_step()

    exit_code = 0
    try:
        with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
            try:
                debugger.run(code_main, cell_ns)
                if not debugger.aborted and code_last is not None:
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
            except bdb.BdbQuit:
                # User intentionally stopped the debugger session
                pass
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
        try:
            import matplotlib.pyplot as plt

            plt.close("all")
        except Exception:
            pass

    # Save exports
    for k, v in cell_exports.items():
        session.exports[k] = v
    for k in cell_consts:
        session.consts.add(k)

    return CellResult(
        stdout=out_buf.getvalue(),
        stderr=err_buf.getvalue(),
        code=exit_code,
        exported={k: _short_repr(v) for k, v in cell_exports.items()},
        all_exports=session.summary(),
        plots=cell_plots,
        latex=cell_latex,
        tables=cell_tables,
        non_table_stdout=non_table_buf.getvalue(),
    )
