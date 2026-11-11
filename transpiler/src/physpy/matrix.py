"""Matrix literal syntax (Matlab/Julia-style): ``[a, b; c, d]`` -> ``__physpy_matrix__([[a, b], [c, d]])``.

Supports:
- Single-line: ``[1, 2; 3, 4]``
- Multiline:
    M = [
        a, b ;
        c, d
    ]
- Trailing semicolons before `]`: ``[1, 2; 3, 4;]``
- Column vectors: ``[1; 2; 3]``
- Arbitrary expressions and parentheses inside elements: ``[(i*k + k_3)/(2*k_3), (-i*k + k_3)/(2*k_3) ; ...]``
- Nested indexing like ``[ a[0], a[1] ; b[0], b[1] ]`` (brackets without direct semicolons are left intact)

Also provides runtime matrix helpers and LaTeX formatting for cell outputs.
"""

from __future__ import annotations

import io
import tokenize
from typing import Any

MATRIX_FN = "__physpy_matrix__"


def rewrite_matrix_literals(src: str) -> str:
    """Rewrite any `[...]` containing at least one `;` at bracket depth 1 into `__physpy_matrix__([[...]])`."""
    if ";" not in src or "[" not in src:
        return src

    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except tokenize.TokenError:
        return src

    # Stack holds tracking dicts for '[' and marker dicts for '(' and '{'
    stack: list[dict[str, Any]] = []
    matrix_brackets: list[tuple[tokenize.TokenInfo, tokenize.TokenInfo, list[tokenize.TokenInfo]]] = []

    for tok in toks:
        if tok.type == tokenize.OP:
            if tok.string == "[":
                stack.append({"kind": "[", "open_tok": tok, "semicolons": []})
            elif tok.string in "({":
                stack.append({"kind": tok.string})
            elif tok.string in ")}":
                if stack and stack[-1].get("kind") in ("(", "{"):
                    stack.pop()
            elif tok.string == "]":
                if stack:
                    top = stack.pop()
                    if top.get("kind") == "[":
                        semis = top.get("semicolons", [])
                        if semis:
                            matrix_brackets.append((top["open_tok"], tok, semis))
            elif tok.string == ";":
                if stack and stack[-1].get("kind") == "[":
                    stack[-1]["semicolons"].append(tok)

    if not matrix_brackets:
        return src

    edits: list[tuple[tuple[int, int], tuple[int, int], str]] = []

    for open_tok, close_tok, semis in matrix_brackets:
        last_semi = semis[-1]
        trailing = True
        try:
            idx_semi = toks.index(last_semi)
            idx_close = toks.index(close_tok)
            for t in toks[idx_semi + 1:idx_close]:
                if t.type not in (tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT):
                    trailing = False
                    break
        except ValueError:
            trailing = False

        active_semis = semis[:-1] if trailing else semis

        # Replace `[` with `__physpy_matrix__([[`
        edits.append((open_tok.start, open_tok.end, f"{MATRIX_FN}([[" ))
        # Replace each active `;` with `], [`
        for s in active_semis:
            edits.append((s.start, s.end, "], ["))
        # If there is a trailing semicolon, erase it
        if trailing:
            edits.append((last_semi.start, last_semi.end, ""))
        # Replace `]` with `]])`
        edits.append((close_tok.start, close_tok.end, "]])"))

    # Sort descending by start line and col to apply cleanly without offset drift
    edits.sort(key=lambda e: (e[0][0], e[0][1]), reverse=True)
    lines = src.splitlines(keepends=True)
    for (r1, c1), (r2, c2), repl in edits:
        lines[r1 - 1] = lines[r1 - 1][:c1] + repl + lines[r1 - 1][c2:]

    return "".join(lines)


def make_matrix(data: Any) -> Any:
    """Runtime constructor: returns a numpy ndarray if numpy is available, else nested list."""
    try:
        import numpy as np
        return np.array(data)
    except Exception:
        return data


def format_scalar_latex(val: Any) -> str:
    """Format numeric/complex scalar values cleanly for LaTeX output in physics notation."""
    try:
        import numpy as np
        is_complex = isinstance(val, (complex, np.complexfloating))
        is_float = isinstance(val, (float, np.floating))
    except ImportError:
        is_complex = isinstance(val, complex)
        is_float = isinstance(val, float)

    if is_complex:
        r, i = float(val.real), float(val.imag)
        if abs(r) < 1e-12 and abs(i) < 1e-12:
            return "0"
        if abs(r) < 1e-12:
            if abs(i - 1.0) < 1e-12:
                return "i"
            elif abs(i - (-1.0)) < 1e-12:
                return "-i"
            return f"{i:g}i"
        if abs(i) < 1e-12:
            return f"{r:g}"
        sign = "+" if i > 0 else "-"
        i_abs = abs(i)
        i_str = "i" if abs(i_abs - 1.0) < 1e-12 else f"{i_abs:g}i"
        return f"{r:g} {sign} {i_str}"

    if is_float:
        if abs(val) < 1e-12:
            return "0"
        return f"{val:g}"

    if hasattr(val, "_repr_latex_"):
        try:
            raw = val._repr_latex_()
            if raw:
                return str(raw).strip("$")
        except Exception:
            pass

    return str(val)


def to_matrix_latex(target: Any, max_dim: int = 12) -> str | None:
    """Convert a 2D/1D numpy ndarray, nested list, or SymPy matrix to a KaTeX pmatrix string."""
    if target is None:
        return None

    # 1. SymPy Matrix or object with _repr_latex_
    if hasattr(target, "_repr_latex_") and callable(target._repr_latex_):
        try:
            raw = target._repr_latex_()
            if raw and isinstance(raw, str) and ("\\begin" in raw or "\\left" in raw or "matrix" in raw):
                s = raw.strip()
                if s.startswith("$") and s.endswith("$"):
                    s = s[1:-1].strip()
                if s.startswith("\\displaystyle"):
                    s = s[len("\\displaystyle"):].strip()
                return s
        except Exception:
            pass

    # 2. NumPy ndarray or objects convertible to ndarray
    try:
        import numpy as np
        is_arr = isinstance(target, np.ndarray)
    except ImportError:
        is_arr = False

    if not is_arr:
        # Check if it is a 2D list of numbers
        if (
            isinstance(target, (list, tuple))
            and len(target) > 0
            and all(isinstance(row, (list, tuple)) for row in target)
        ):
            try:
                import numpy as np
                target = np.array(target)
                is_arr = True
            except Exception:
                pass

    if not is_arr:
        return None

    # Handle 1D vector (display as column vector)
    if target.ndim == 1:
        if len(target) == 0:
            return None
        if len(target) > max_dim:
            items = [format_scalar_latex(x) for x in target[:max_dim]] + ["\\vdots"]
        else:
            items = [format_scalar_latex(x) for x in target]
        return "\\begin{pmatrix}\n" + " \\\\\n".join(items) + "\n\\end{pmatrix}"

    # Handle 2D matrix
    if target.ndim == 2:
        nrows, ncols = target.shape
        if nrows == 0 or ncols == 0:
            return None
        r_limit = min(nrows, max_dim)
        c_limit = min(ncols, max_dim)

        rows: list[str] = []
        for r_idx in range(r_limit):
            row_vals = [format_scalar_latex(target[r_idx, c_idx]) for c_idx in range(c_limit)]
            if ncols > max_dim:
                row_vals.append("\\dots")
            rows.append(" & ".join(row_vals))

        if nrows > max_dim:
            dots_row = ["\\vdots"] * c_limit
            if ncols > max_dim:
                dots_row.append("\\ddots")
            rows.append(" & ".join(dots_row))

        has_frac = any("\\frac" in r for r in rows)
        sep = " \\\\[0.85em]\n" if has_frac else " \\\\[0.35em]\n"
        return "\\begin{pmatrix}\n" + sep.join(rows) + "\n\\end{pmatrix}"

    return None
