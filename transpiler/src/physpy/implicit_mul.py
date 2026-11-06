"""Implicit multiplication: ``2(a + b)`` -> ``2*(a + b)``.

A numeric literal followed by ``(`` is never valid at runtime in Python
(``int`` is not callable), so this rewrite cannot change the meaning of
existing, working code.

Deliberately NOT handled (ambiguous with valid Python):
- ``(a)(b)``  - calling the result of an expression,
- ``x(y)``    - a regular function call.
"""

from __future__ import annotations

import io
import tokenize


def rewrite_implicit_mul(src: str) -> str:
    if "(" not in src:
        return src
    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    inserts = [
        a.end
        for a, b in zip(toks, toks[1:])
        if a.type == tokenize.NUMBER
        and b.type == tokenize.OP
        and b.string == "("
        and a.end[0] == b.start[0]  # same line
    ]
    lines = src.splitlines(keepends=True)
    for row, col in reversed(inserts):
        lines[row - 1] = lines[row - 1][:col] + "*" + lines[row - 1][col:]
    return "".join(lines)
