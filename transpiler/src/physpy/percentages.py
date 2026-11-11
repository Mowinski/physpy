"""Percentage literal rewrite: ``5%`` -> ``0.05``, ``12.5%`` -> ``0.125``.

Transforms standalone number literals followed by ``%`` into decimal float values.
Preserves Python's modulo operator ``a % b``, string formatting ``"%s" % val``,
and comments.
"""

from __future__ import annotations

import io
import tokenize


def rewrite_percentages(src: str) -> str:
    """Rewrite numeric percentages like 5% or 12.5% to float decimals (0.05, 0.125)."""
    if "%" not in src:
        return src

    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except (tokenize.TokenError, IndentationError):
        return src

    edits: list[tuple[tuple[int, int], tuple[int, int], str]] = []

    for i in range(len(toks) - 1):
        t_num = toks[i]
        t_op = toks[i + 1]

        if t_num.type != tokenize.NUMBER:
            continue
        if t_op.type != tokenize.OP or t_op.string != "%":
            continue

        is_attached = t_num.end == t_op.start
        t_next = toks[i + 2] if i + 2 < len(toks) else None

        # Check if this % is the binary modulo operator
        is_modulo = False
        if t_next:
            if not is_attached:
                # e.g. "10 % 3" or "10 % x" or "10 % (a + b)"
                if t_next.type in (tokenize.NUMBER, tokenize.NAME) or (
                    t_next.type == tokenize.OP and t_next.string in ("(", "[")
                ):
                    is_modulo = True
            else:
                # Attached without spaces: e.g. "10%3" -> standard Python modulo
                if t_next.type == tokenize.NUMBER or (
                    t_next.type == tokenize.NAME
                    and t_next.string
                    not in (
                        "and",
                        "or",
                        "if",
                        "else",
                        "for",
                        "in",
                        "is",
                        "not",
                    )
                ):
                    is_modulo = True

        if is_modulo:
            continue

        num_str = t_num.string
        try:
            val = float(num_str) * 0.01
            # Format cleanly as float decimal
            repl = f"{val:g}"
            if "." not in repl and "e" not in repl:
                repl += ".0"
        except ValueError:
            repl = f"({num_str} * 0.01)"

        edits.append((t_num.start, t_op.end, repl))

    if not edits:
        return src

    lines = src.splitlines(keepends=True)
    for (r1, c1), (r2, c2), repl in reversed(edits):
        lines[r1 - 1] = lines[r1 - 1][:c1] + repl + lines[r2 - 1][c2:]

    return "".join(lines)
