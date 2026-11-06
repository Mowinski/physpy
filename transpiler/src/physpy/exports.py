"""Explicit variable export across cells: ``export \\rho_0 = 1000``.

Cells in PhysPy are isolated by default: local variables die at the end of the
cell. Only variables marked with ``export`` are copied into ``__exports__`` and
made available to subsequent cells.

Supported forms (at statement start):
- ``export x = expr``           -> ``__exports__['x'] = x = expr``
- ``export x, y = expr``        -> ``__exports__['x'], __exports__['y'] = x, y = expr``
- ``export x, y``               -> ``__exports__.update({'x': x, 'y': y})``
- ``export import math``        -> ``import math; __exports__['math'] = math``
- ``export def f(...): ...``    -> ``def f(...): ...`` + records ``f`` in ``__exports__``
"""

from __future__ import annotations

import ast
import io
import tokenize

from .errors import TranspileError

EXPORT_KW = "export"
EXPORT_MARKER = "__physpy_export__"


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


def rewrite_exports(src: str) -> str:
    """Rewrite leading ``export ...`` statements into valid Python with markers."""
    if EXPORT_KW not in src:
        return src

    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    edits: list[tuple[tuple[int, int], tuple[int, int], str]] = []

    i = 0
    n = len(toks)
    while i < n:
        tok = toks[i]
        prev = toks[i - 1] if i > 0 else None
        if tok.type == tokenize.NAME and tok.string == EXPORT_KW and _is_stmt_start(prev):
            nxt = toks[i + 1] if i + 1 < n else None
            if nxt is None or nxt.type in (tokenize.NEWLINE, tokenize.NL, tokenize.ENDMARKER):
                raise TranspileError("expected variable name or statement after 'export'", *tok.start)

            # Case 1: `export def name...` or `export class name...`
            if nxt.type == tokenize.NAME and nxt.string in ("def", "class"):
                name_tok = toks[i + 2] if i + 2 < n else None
                if name_tok is None or name_tok.type != tokenize.NAME:
                    raise TranspileError(f"expected name after 'export {nxt.string}'", *nxt.start)
                # Decorate with @__physpy_export__ on the same line is invalid in Python,
                # so we replace `export ` with nothing and transform in AST using line number,
                # OR we wrap via AST pass. Let's mark the def/class name with a prefix!
                edits.append((tok.start, nxt.start, ""))
                edits.append((name_tok.start, name_tok.end, f"{EXPORT_MARKER}{name_tok.string}"))
                i += 3
                continue

            # Case 2: `export import a, b as c`
            if nxt.type == tokenize.NAME and nxt.string == "import":
                edits.append((tok.start, nxt.start, f"{EXPORT_MARKER} = 1; "))
                i += 2
                continue

            # Collect tokens up to `=`, `;`, or NEWLINE at paren depth 0
            j = i + 1
            depth = 0
            eq_tok: tokenize.TokenInfo | None = None
            names: list[str] = []
            valid_names = True
            while j < n:
                t = toks[j]
                if t.type == tokenize.OP and t.string in "([{":
                    depth += 1
                elif t.type == tokenize.OP and t.string in ")]}":
                    depth = max(0, depth - 1)
                elif depth == 0:
                    if t.type == tokenize.OP and t.string == "=":
                        eq_tok = t
                        break
                    if t.type in (tokenize.NEWLINE, tokenize.NL, tokenize.ENDMARKER) or (
                        t.type == tokenize.OP and t.string == ";"
                    ):
                        break
                    if t.type == tokenize.NAME:
                        names.append(t.string)
                    elif t.type == tokenize.OP and t.string == ",":
                        pass
                    else:
                        valid_names = False
                j += 1

            if not names or not valid_names:
                raise TranspileError("invalid 'export' target", *tok.start)

            if eq_tok is not None:
                # `export a, b = expr` -> `__physpy_export__[a, b] = a, b = expr` (valid Subscript target)
                target_str = ", ".join(names)
                edits.append(
                    (
                        tok.start,
                        eq_tok.end,
                        f"{EXPORT_MARKER}[{target_str}] = {target_str} =",
                    )
                )
                i = j + 1
                continue
            else:
                # `export a, b` -> `__physpy_export__(a, b)`
                end_tok = toks[j - 1]
                target_str = ", ".join(names)
                edits.append((tok.start, end_tok.end, f"{EXPORT_MARKER}({target_str})"))
                i = j
                continue

        i += 1

    if not edits:
        return src

    lines = src.splitlines(keepends=True)
    for (r1, c1), (r2, c2), replacement in reversed(edits):
        if r1 == r2:
            lines[r1 - 1] = lines[r1 - 1][:c1] + replacement + lines[r1 - 1][c2:]
        else:
            raise TranspileError("multiline 'export' header is not supported", r1, c1)
    return "".join(lines)


def _export_dict_update(names: list[str], loc_node: ast.AST) -> ast.Expr:
    """Build ``__exports__.update({'x': x, ...})``."""
    call = ast.Call(
        func=ast.Attribute(
            value=ast.Name(id="__exports__", ctx=ast.Load()),
            attr="update",
            ctx=ast.Load(),
        ),
        args=[
            ast.Dict(
                keys=[ast.Constant(value=name) for name in names],
                values=[ast.Name(id=name, ctx=ast.Load()) for name in names],
            )
        ],
        keywords=[],
    )
    return ast.copy_location(ast.Expr(value=call), loc_node)


class ExportTransformer(ast.NodeTransformer):
    """Turn ``__physpy_export__`` markers into ``__exports__`` updates."""

    def _transform_body(self, stmts: list[ast.stmt]) -> list[ast.stmt]:
        out: list[ast.stmt] = []
        i = 0
        while i < len(stmts):
            stmt = self.visit(stmts[i])

            # `export import ...` -> marker `__physpy_export__ = 1` followed by `import ...`
            if (
                isinstance(stmt, ast.Assign)
                and len(stmt.targets) == 1
                and isinstance(stmt.targets[0], ast.Name)
                and stmt.targets[0].id == EXPORT_MARKER
                and i + 1 < len(stmts)
                and isinstance(stmts[i + 1], ast.Import)
            ):
                imp = stmts[i + 1]
                names = [alias.asname or alias.name.split(".")[0] for alias in imp.names]
                out.append(imp)
                out.append(_export_dict_update(names, imp))
                i += 2
                continue

            # `export x = expr` -> `__physpy_export__[x] = x = expr`
            if (
                isinstance(stmt, ast.Assign)
                and len(stmt.targets) >= 2
                and isinstance(stmt.targets[0], ast.Subscript)
                and isinstance(stmt.targets[0].value, ast.Name)
                and stmt.targets[0].value.id == EXPORT_MARKER
            ):
                slc = stmt.targets[0].slice
                elts = slc.elts if isinstance(slc, ast.Tuple) else [slc]
                names = [e.id for e in elts if isinstance(e, ast.Name)]
                stmt.targets = stmt.targets[1:]
                out.append(stmt)
                out.append(_export_dict_update(names, stmt))
                i += 1
                continue

            # `export x, y` -> Expr(Call(__physpy_export__, [x, y]))
            if (
                isinstance(stmt, ast.Expr)
                and isinstance(stmt.value, ast.Call)
                and isinstance(stmt.value.func, ast.Name)
                and stmt.value.func.id == EXPORT_MARKER
            ):
                names = [arg.id for arg in stmt.value.args if isinstance(arg, ast.Name)]
                out.append(_export_dict_update(names, stmt))
                i += 1
                continue

            # `export def f` / `export class C`
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and stmt.name.startswith(
                EXPORT_MARKER
            ):
                real_name = stmt.name[len(EXPORT_MARKER) :]
                stmt.name = real_name
                out.append(stmt)
                out.append(_export_dict_update([real_name], stmt))
                i += 1
                continue

            out.append(stmt)
            i += 1
        return out

    def visit_Module(self, node: ast.Module) -> ast.Module:
        node.body = self._transform_body(node.body)
        return node
