"""Exponent syntax: ``x^2`` -> ``x**2``, ``x^(n+1)`` -> ``x**(n+1)``.

Note: In plain Python ``^`` is bitwise XOR. In PhysPy ``^`` is exponentiation
(matches mathematical notation and the editor's superscript rendering).
For bitwise XOR, use ``operator.xor(a, b)``.
"""

from __future__ import annotations

import io
import tokenize


def rewrite_powers(src: str) -> str:
    if "^" not in src:
        return src
    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    # Replace standalone `^` operator tokens (not `^=`).
    edits = [
        (t.start, t.end)
        for t in toks
        if t.type == tokenize.OP and t.string == "^"
    ]
    lines = src.splitlines(keepends=True)
    for (row, c1), (_, c2) in reversed(edits):
        lines[row - 1] = lines[row - 1][:c1] + "**" + lines[row - 1][c2:]
    return "".join(lines)
