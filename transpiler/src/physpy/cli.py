"""Command line interface.

    physpy transpile FILE|-          print plain Python
    physpy run FILE|- [--filename P] transpile and execute

Exit codes: 0 ok, 1 runtime error in user code, 2 PhysPy/Python syntax error.
"""

from __future__ import annotations

import argparse
import linecache
import os
import sys
import traceback

from . import importer
from .ai import run_ai_cli
from .errors import TranspileError
from .notebook import NotebookSession, run_worker, split_cells
from .pipeline import compile_source, transpile


def _read(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    with open(path, encoding="utf-8") as f:
        return f.read()


def _report_syntax(exc: Exception, filename: str) -> int:
    if isinstance(exc, TranspileError):
        print(exc.format(filename), file=sys.stderr)
    else:  # SyntaxError
        print(f"{filename}:{exc.lineno}:{exc.offset}: syntax error: {exc.msg}", file=sys.stderr)
    return 2


def cmd_transpile(args: argparse.Namespace) -> int:
    filename = args.filename or ("<stdin>" if args.file == "-" else args.file)
    try:
        print(transpile(_read(args.file), filename))
    except (TranspileError, SyntaxError) as exc:
        return _report_syntax(exc, filename)
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    filename = args.filename or ("<editor>" if args.file == "-" else args.file)
    src = _read(args.file)

    script_dir = os.path.dirname(os.path.abspath(filename)) if os.path.exists(filename) else os.getcwd()
    try:
        os.chdir(script_dir)
    except OSError:
        pass
    sys.path.insert(0, script_dir)
    importer.install()
    sys.argv = [filename]

    cells = split_cells(src)
    # Multi-cell or `export`/`global`-using file: run cell by cell with isolated scopes
    session = NotebookSession()
    session.ensure_global_imports(src)
    for idx, cell in enumerate(cells, start=1):
        label = filename if len(cells) == 1 else f"{filename}#cell-{idx}"
        res = session.run_cell(cell.source, label)
        if res.stdout:
            print(res.stdout, end="")
        if res.stderr:
            print(res.stderr, end="", file=sys.stderr)
        if res.code != 0:
            return res.code
    return 0


def _user_frames(lines: list[str], filename: str) -> list[str]:
    for i, line in enumerate(lines):
        if f'File "{filename}"' in line:
            return lines[i:]
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="physpy")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, func in (("transpile", cmd_transpile), ("run", cmd_run)):
        p = sub.add_parser(name)
        p.add_argument("file", help="source file or '-' for stdin")
        p.add_argument("--filename", help="name used in error messages and tracebacks")
        p.set_defaults(func=func)
    w = sub.add_parser("worker", help="run persistent JSON-RPC cell worker")
    w.set_defaults(func=lambda _args: run_worker())
    a = sub.add_parser("ai", help="run Gemini AI code suggestion from JSON stdin")
    a.set_defaults(func=lambda _args: run_ai_cli())
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
