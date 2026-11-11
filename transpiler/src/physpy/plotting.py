"""Plot command: ``plot plt``, ``plot fig``, ``plot ax``, ``plot ax.plot(x, y)``.

Rewrites a statement starting with ``plot <expr>`` into ``__physpy_plot__(<expr>)``.
Regular assignments (``plot = 1``) or function calls without whitespace
(``plot(x, y)``) are left untouched.
"""

from __future__ import annotations

import base64
import io
import tokenize
from typing import Any

PLOT_KW = "plot"
PLOT_FN = "__physpy_plot__"


def _is_stmt_start(prev_tok: tokenize.TokenInfo | None) -> bool:
    if prev_tok is None:
        return True
    return prev_tok.type in (
        tokenize.NEWLINE,
        tokenize.NL,
        tokenize.INDENT,
        tokenize.DEDENT,
        tokenize.ENCODING,
    ) or (prev_tok.type == tokenize.OP and prev_tok.string == ";")


def rewrite_stmt_command(src: str, keyword: str, func_name: str) -> str:
    """Rewrite statement-level ``<keyword> <expr>`` into ``<func_name>(<expr>)``."""
    if keyword not in src:
        return src

    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    edits: list[tuple[tuple[int, int], tuple[int, int], str]] = []

    i = 0
    n = len(toks)
    while i < n:
        tok = toks[i]
        prev = toks[i - 1] if i > 0 else None
        if tok.type == tokenize.NAME and tok.string == keyword and _is_stmt_start(prev):
            nxt = toks[i + 1] if i + 1 < n else None
            if (
                nxt is not None
                and nxt.start[0] == tok.start[0]
                and nxt.type not in (tokenize.NEWLINE, tokenize.NL, tokenize.COMMENT, tokenize.ENDMARKER)
                and not (
                    nxt.type == tokenize.OP
                    and (
                        nxt.string in ("=", ".", "[", ":", ";", ",")
                        or nxt.string.endswith("=")
                        or (nxt.string == "(" and nxt.start == tok.end)
                    )
                )
            ):
                # Find the end of the statement at paren depth 0 on the same line
                j = i + 1
                depth = 0
                end_tok = nxt
                while j < n:
                    t = toks[j]
                    if t.type == tokenize.OP and t.string in "([{":
                        depth += 1
                    elif t.type == tokenize.OP and t.string in ")]}":
                        depth = max(0, depth - 1)
                    elif depth == 0 and (
                        t.type in (tokenize.NEWLINE, tokenize.NL, tokenize.COMMENT, tokenize.ENDMARKER)
                        or (t.type == tokenize.OP and t.string == ";")
                    ):
                        break
                    end_tok = t
                    j += 1

                if tok.start[0] == end_tok.end[0]:
                    edits.append((tok.start, nxt.start, f"{func_name}("))
                    edits.append((end_tok.end, end_tok.end, ")"))
                i = j
                continue
        i += 1

    if not edits:
        return src

    lines = src.splitlines(keepends=True)
    for (r1, c1), (r2, c2), replacement in reversed(edits):
        lines[r1 - 1] = lines[r1 - 1][:c1] + replacement + lines[r1 - 1][c2:]
    return "".join(lines)


def rewrite_plots(src: str) -> str:
    return rewrite_stmt_command(src, PLOT_KW, PLOT_FN)


def resolve_figure(target: Any) -> Any:
    """Extract a ``matplotlib.figure.Figure`` from a module, Figure, Axes, or Artist list."""
    if target is None:
        raise TypeError("plot got None (pass `plt`, a `Figure`, an `Axes`, or `ax.plot(...)`)")

    # 1. Already a Figure
    if hasattr(target, "savefig") and hasattr(target, "axes"):
        return target

    # 2. matplotlib.pyplot module (`plot plt`)
    if hasattr(target, "gcf") and callable(target.gcf):
        return target.gcf()

    # 3. Axes or Artist (`plot ax`)
    if hasattr(target, "get_figure") and callable(target.get_figure):
        fig = target.get_figure()
        if fig is not None:
            return fig
    if hasattr(target, "figure") and hasattr(target.figure, "savefig"):
        return target.figure

    # 4. Sequence of Artists returned by `plt.plot(...)` / `ax.plot(...)`
    if isinstance(target, (list, tuple)) and len(target) > 0:
        first = target[0]
        if hasattr(first, "figure") and hasattr(first.figure, "savefig"):
            return first.figure

    raise TypeError(
        f"plot expected a matplotlib Figure, Axes, or pyplot (`plt`), got {type(target).__name__}"
    )


def render_plot_png_base64(target: Any) -> str:
    """Render ``target`` into a base64-encoded PNG image and close the figure."""
    fig = resolve_figure(target)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=140, bbox_inches="tight")
    try:
        import matplotlib.pyplot as plt

        plt.close(fig)
    except Exception:
        pass
    return base64.b64encode(buf.getvalue()).decode("ascii")
