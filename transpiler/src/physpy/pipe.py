"""Example extension: pipe operator ``x |> f |> g`` -> ``g(f(x))``.

Two-stage pattern useful for most operator-like extensions:
1. token pass  - rewrite ``|>`` to the marker ``| __pipe__ |`` (valid Python,
                 inherits the precedence of ``|``),
2. AST pass    - turn ``BinOp(BinOp(x, |, __pipe__), |, f)`` into ``f(x)``.
"""

from __future__ import annotations

import ast
import io
import tokenize

PIPE_MARKER = "__pipe__"


def rewrite_pipe_tokens(src: str) -> str:
    if "|>" not in src:
        return src
    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    edits = [
        (a.start, b.end)
        for a, b in zip(toks, toks[1:])
        if a.type == b.type == tokenize.OP
        and a.string == "|"
        and b.string == ">"
        and a.end == b.start
    ]
    lines = src.splitlines(keepends=True)
    for (row, c1), (_, c2) in reversed(edits):
        lines[row - 1] = lines[row - 1][:c1] + f"| {PIPE_MARKER} |" + lines[row - 1][c2:]
    return "".join(lines)


class PipeTransformer(ast.NodeTransformer):
    def visit_BinOp(self, node: ast.BinOp) -> ast.AST:
        self.generic_visit(node)
        left = node.left
        if (
            isinstance(node.op, ast.BitOr)
            and isinstance(left, ast.BinOp)
            and isinstance(left.op, ast.BitOr)
            and isinstance(left.right, ast.Name)
            and left.right.id == PIPE_MARKER
        ):
            return ast.copy_location(ast.Call(node.right, [left.left], []), node)
        return node
