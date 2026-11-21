"""Plot command: ``plot plt``, ``plot fig``, ``plot ax``, ``plot ax.plot(x, y)``.

Rewrites a statement starting with ``plot <expr>`` into ``__physpy_plot__(<expr>)``.
Regular assignments (``plot = 1``) or function calls without whitespace
(``plot(x, y)``) are left untouched.
"""

from __future__ import annotations

import base64
import copy
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


def _extract_axes_meta(fig: Any, pad_inches: float = 0.1) -> list[dict[str, Any]]:
    """Extract normalized top-left bounding boxes and axis limits for interactive cursor readout."""
    axes_meta: list[dict[str, Any]] = []
    try:
        _ensure_agg_canvas(fig)
        fig.canvas.draw()
        renderer = fig.canvas.get_renderer()
        fig_bbox = fig.get_tightbbox(renderer)
        if fig_bbox is None:
            return axes_meta
        dpi = float(fig.dpi)
        img_x0 = float(fig_bbox.x0) * dpi - pad_inches * dpi
        img_y0 = float(fig_bbox.y0) * dpi - pad_inches * dpi
        img_w = (float(fig_bbox.width) + 2.0 * pad_inches) * dpi
        img_h = (float(fig_bbox.height) + 2.0 * pad_inches) * dpi
        if img_w <= 0 or img_h <= 0:
            return axes_meta

        for ax in getattr(fig, "axes", []):
            try:
                ax_box = ax.get_window_extent(renderer)
                xlim = [float(v) for v in ax.get_xlim()]
                ylim = [float(v) for v in ax.get_ylim()]
                grid_on = bool(
                    getattr(ax.xaxis, "_major_tick_kw", {}).get("gridOn", False)
                    or getattr(ax.yaxis, "_major_tick_kw", {}).get("gridOn", False)
                )
                leg = ax.get_legend()
                legend_on = bool(leg is not None and leg.get_visible())
                try:
                    fontsize = round(float(ax.xaxis.label.get_fontsize()), 1)
                except Exception:
                    fontsize = 10.0
                axes_meta.append(
                    {
                        "left": (float(ax_box.x0) - img_x0) / img_w,
                        "right": (float(ax_box.x1) - img_x0) / img_w,
                        "top": 1.0 - (float(ax_box.y1) - img_y0) / img_h,
                        "bottom": 1.0 - (float(ax_box.y0) - img_y0) / img_h,
                        "xlim": xlim,
                        "ylim": ylim,
                        "xscale": str(ax.get_xscale()),
                        "yscale": str(ax.get_yscale()),
                        "xlabel": str(ax.get_xlabel() or ""),
                        "ylabel": str(ax.get_ylabel() or ""),
                        "title": str(ax.get_title() or ""),
                        "grid": grid_on,
                        "legend": legend_on,
                        "fontsize": fontsize,
                    }
                )
            except Exception:
                continue
    except Exception:
        pass
    return axes_meta


def _ensure_agg_canvas(fig: Any) -> Any:
    """Ensure ``fig`` has a ``FigureCanvasAgg`` attached (needed after ``deepcopy``)."""
    try:
        from matplotlib.backends.backend_agg import FigureCanvasAgg

        if not isinstance(getattr(fig, "canvas", None), FigureCanvasAgg):
            FigureCanvasAgg(fig)
    except Exception:
        pass
    return fig


def copy_figure(target: Any) -> Any:
    """Resolve ``target`` to a ``matplotlib.figure.Figure`` and return an isolated deep copy."""
    fig = resolve_figure(target)
    cloned = copy.deepcopy(fig)
    return _ensure_agg_canvas(cloned)


def render_plot_bundle(target: Any, *, close_fig: bool = True) -> dict[str, Any]:
    """Render ``target`` into PNG (base64), SVG (text), PDF (base64), and axes metadata."""
    fig = resolve_figure(target)
    pad_inches = 0.1
    axes_meta = _extract_axes_meta(fig, pad_inches=pad_inches)

    png_buf = io.BytesIO()
    fig.savefig(png_buf, format="png", dpi=140, bbox_inches="tight", pad_inches=pad_inches)

    svg_text = ""
    try:
        svg_buf = io.BytesIO()
        fig.savefig(svg_buf, format="svg", bbox_inches="tight", pad_inches=pad_inches)
        svg_text = svg_buf.getvalue().decode("utf-8")
    except Exception:
        svg_text = ""

    pdf_b64 = ""
    try:
        pdf_buf = io.BytesIO()
        fig.savefig(pdf_buf, format="pdf", bbox_inches="tight", pad_inches=pad_inches)
        pdf_b64 = base64.b64encode(pdf_buf.getvalue()).decode("ascii")
    except Exception:
        pdf_b64 = ""

    if close_fig:
        try:
            import matplotlib.pyplot as plt

            plt.close(fig)
        except Exception:
            pass

    return {
        "png": base64.b64encode(png_buf.getvalue()).decode("ascii"),
        "svg": svg_text,
        "pdf": pdf_b64,
        "axes": axes_meta,
    }


def render_plot_png_base64(target: Any) -> str:
    """Render ``target`` into a base64-encoded PNG image and close the figure."""
    return render_plot_bundle(target)["png"]
