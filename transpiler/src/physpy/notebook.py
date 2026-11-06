"""Cell splitting (`# %%`) and isolated cell execution with explicit `export`."""

from __future__ import annotations

import contextlib
import io
import json
import linecache
import os
import re
import sys
import traceback
from dataclasses import dataclass
from typing import Any

from . import importer
from .errors import TranspileError
from .pipeline import compile_source
from .plotting import PLOT_FN, render_plot_png_base64
from .symbols import IDENTIFIERS

CELL_HEADER_RE = re.compile(r"^# %%[^\S\n]*(.*)$", re.MULTILINE)

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


def _short_repr(val: Any) -> str:
    try:
        r = repr(val)
    except Exception:
        r = f"<{type(val).__name__}>"
    return r if len(r) <= 48 else r[:45] + "..."


class NotebookSession:
    """Holds only explicitly `export`-ed variables between cell runs."""

    def __init__(self) -> None:
        os.environ.setdefault("MPLBACKEND", "Agg")
        self.exports: dict[str, Any] = {}

    def reset(self) -> None:
        self.exports.clear()

    def run_cell(self, source: str, filename: str = "<cell>") -> CellResult:
        out_buf = io.StringIO()
        err_buf = io.StringIO()

        try:
            code = compile_source(source, filename)
        except TranspileError as exc:
            return CellResult(
                stdout="",
                stderr=exc.format(filename) + "\n",
                code=2,
                exported={},
                all_exports=self.summary(),
                plots=[],
            )
        except SyntaxError as exc:
            return CellResult(
                stdout="",
                stderr=f"{filename}:{exc.lineno}:{exc.offset}: syntax error: {exc.msg}\n",
                code=2,
                exported={},
                all_exports=self.summary(),
                plots=[],
            )

        linecache.cache[filename] = (
            len(source),
            None,
            source.splitlines(keepends=True),
            filename,
        )
        importer.install()

        cell_exports: dict[str, Any] = {}
        cell_plots: list[str] = []

        def _capture_plot(target: Any) -> None:
            cell_plots.append(render_plot_png_base64(target))

        # Cell starts ONLY with builtins and previously exported variables!
        cell_ns: dict[str, Any] = {
            "__name__": "__main__",
            "__file__": filename,
            "__builtins__": __builtins__,
            **self.exports,
            "__exports__": cell_exports,
            PLOT_FN: _capture_plot,
        }

        exit_code = 0
        with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
            try:
                exec(code, cell_ns)
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

        # Commit exports from this cell into the session
        self.exports.update(cell_exports)
        return CellResult(
            stdout=out_buf.getvalue(),
            stderr=err_buf.getvalue(),
            code=exit_code,
            exported={k: _short_repr(v) for k, v in cell_exports.items()},
            all_exports=self.summary(),
            plots=cell_plots,
        )

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
            sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}) + "\n")
            sys.stdout.flush()
            continue

        cmd = req.get("cmd")
        if cmd == "reset":
            session.reset()
            resp: dict[str, Any] = {"ok": True, "all_exports": {}}
        elif cmd == "run_cell":
            path = req.get("path")
            cell_index = req.get("cell_index", 1)
            source = req.get("source", "")
            if path and os.path.exists(path):
                script_dir = os.path.dirname(os.path.abspath(path))
                if script_dir not in sys.path:
                    sys.path.insert(0, script_dir)
                label = f"{os.path.basename(path)}#cell-{cell_index}"
            else:
                label = f"<cell {cell_index}>"
            res = session.run_cell(source, label)
            resp = {
                "ok": True,
                "stdout": res.stdout,
                "stderr": res.stderr,
                "code": res.code,
                "exported": res.exported,
                "all_exports": res.all_exports,
                "plots": res.plots,
            }
        else:
            resp = {"ok": False, "error": f"unknown command: {cmd}"}

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return 0
