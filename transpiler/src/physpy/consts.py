"""Immutable constants: ``const g = 9.81``, ``export const \\rho_0 = 1000``.

Reassigning or mutating a ``const`` variable via ``=``, ``+=``, ``for``, or ``del``
raises a ``TranspileError`` at compile time. When combined with ``export``
(``export const g = 9.81``), the constant is also protected across subsequent
notebook cells.
"""

from __future__ import annotations

import ast
import io
import tokenize

from .errors import TranspileError
from .exports import EXPORT_MARKER

CONST_KW = "const"
CONST_MARKER = "__physpy_const__"


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


def rewrite_consts(src: str) -> str:
    """Rewrite ``const x = expr`` and ``export const x = expr`` into valid Python markers."""
    if CONST_KW not in src:
        return src

    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    edits: list[tuple[tuple[int, int], tuple[int, int], str]] = []

    i = 0
    n = len(toks)
    while i < n:
        tok = toks[i]
        prev = toks[i - 1] if i > 0 else None
        if _is_stmt_start(prev) and tok.type == tokenize.NAME:
            is_export_const = (
                tok.string in ("export", "const")
                and i + 1 < n
                and toks[i + 1].type == tokenize.NAME
                and {tok.string, toks[i + 1].string} == {"export", "const"}
            )
            is_plain_const = tok.string == CONST_KW and not is_export_const

            if is_export_const or is_plain_const:
                header_end_idx = i + 2 if is_export_const else i + 1
                j = header_end_idx
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

                if eq_tok is None:
                    raise TranspileError(
                        "const declaration requires an initial value (e.g. 'const g = 9.81')",
                        *tok.start,
                    )
                if not names or not valid_names:
                    raise TranspileError("invalid 'const' target", *tok.start)

                target_str = ", ".join(names)
                if is_export_const:
                    replacement = (
                        f"{CONST_MARKER}[{target_str}] = {EXPORT_MARKER}[{target_str}] = {target_str} ="
                    )
                else:
                    replacement = f"{CONST_MARKER}[{target_str}] = {target_str} ="

                edits.append((tok.start, eq_tok.end, replacement))
                i = j + 1
                continue

        i += 1

    if not edits:
        return src

    lines = src.splitlines(keepends=True)
    for (r1, c1), (r2, c2), replacement in reversed(edits):
        if r1 == r2:
            lines[r1 - 1] = lines[r1 - 1][:c1] + replacement + lines[r1 - 1][c2:]
        else:
            raise TranspileError("multiline 'const' header is not supported", r1, c1)
    return "".join(lines)


def _extract_store_names(target: ast.AST) -> list[tuple[str, ast.AST]]:
    """Return all ``(name, node)`` pairs being assigned/deleted in ``target``."""
    out: list[tuple[str, ast.AST]] = []
    if isinstance(target, ast.Name):
        out.append((target.id, target))
    elif isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            out.extend(_extract_store_names(elt))
    elif isinstance(target, ast.Starred):
        out.extend(_extract_store_names(target.value))
    return out


def _const_set_update(names: list[str], loc_node: ast.AST) -> ast.Expr:
    """Build ``__consts__.update({'g', ...})`` for exported constants."""
    call = ast.Call(
        func=ast.Attribute(
            value=ast.Name(id="__consts__", ctx=ast.Load()),
            attr="update",
            ctx=ast.Load(),
        ),
        args=[ast.Set(elts=[ast.Constant(value=name) for name in names])],
        keywords=[],
    )
    return ast.copy_location(ast.Expr(value=call), loc_node)


class ConstTransformer(ast.NodeTransformer):
    """Enforce ``const`` immutability and strip ``__physpy_const__`` markers."""

    def __init__(self, predeclared_consts: set[str] | None = None) -> None:
        super().__init__()
        self.consts: set[str] = set(predeclared_consts or ())

    def _guard_name(self, name: str, node: ast.AST) -> None:
        if name in self.consts:
            line = getattr(node, "lineno", 1)
            col = getattr(node, "col_offset", 0) + 1
            raise TranspileError(f"cannot reassign constant '{name}'", line, col)

    def _transform_body(self, stmts: list[ast.stmt]) -> list[ast.stmt]:
        out: list[ast.stmt] = []
        for raw_stmt in stmts:
            # Check if this statement is a `const` declaration (`__physpy_const__[...] = ...`)
            if (
                isinstance(raw_stmt, ast.Assign)
                and len(raw_stmt.targets) >= 2
                and isinstance(raw_stmt.targets[0], ast.Subscript)
                and isinstance(raw_stmt.targets[0].value, ast.Name)
                and raw_stmt.targets[0].value.id == CONST_MARKER
            ):
                slc = raw_stmt.targets[0].slice
                elts = slc.elts if isinstance(slc, ast.Tuple) else [slc]
                names = [e.id for e in elts if isinstance(e, ast.Name)]
                for name in names:
                    self._guard_name(name, raw_stmt)
                raw_stmt.targets = raw_stmt.targets[1:]
                # Visit value expressions before registering consts
                raw_stmt.value = self.visit(raw_stmt.value)

                is_also_exported = (
                    len(raw_stmt.targets) >= 2
                    and isinstance(raw_stmt.targets[0], ast.Subscript)
                    and isinstance(raw_stmt.targets[0].value, ast.Name)
                    and raw_stmt.targets[0].value.id == EXPORT_MARKER
                )
                self.consts.update(names)
                out.append(raw_stmt)
                if is_also_exported:
                    out.append(_const_set_update(names, raw_stmt))
                continue

            out.append(self.visit(raw_stmt))
        return out

    def visit_Module(self, node: ast.Module) -> ast.Module:
        node.body = self._transform_body(node.body)
        return node

    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.FunctionDef:
        self._guard_name(node.name, node)
        node.body = self._transform_body(node.body)
        return node

    def visit_ClassDef(self, node: ast.ClassDef) -> ast.ClassDef:
        self._guard_name(node.name, node)
        node.body = self._transform_body(node.body)
        return node

    def visit_Assign(self, node: ast.Assign) -> ast.Assign:
        for target in node.targets:
            if (
                isinstance(target, ast.Subscript)
                and isinstance(target.value, ast.Name)
                and target.value.id == EXPORT_MARKER
            ):
                continue
            for name, name_node in _extract_store_names(target):
                self._guard_name(name, name_node)
        self.generic_visit(node)
        return node

    def visit_AugAssign(self, node: ast.AugAssign) -> ast.AugAssign:
        for name, name_node in _extract_store_names(node.target):
            self._guard_name(name, name_node)
        self.generic_visit(node)
        return node

    def visit_AnnAssign(self, node: ast.AnnAssign) -> ast.AnnAssign:
        for name, name_node in _extract_store_names(node.target):
            self._guard_name(name, name_node)
        self.generic_visit(node)
        return node

    def visit_NamedExpr(self, node: ast.NamedExpr) -> ast.NamedExpr:
        self._guard_name(node.target.id, node.target)
        self.generic_visit(node)
        return node

    def visit_For(self, node: ast.For) -> ast.For:
        for name, name_node in _extract_store_names(node.target):
            self._guard_name(name, name_node)
        node.body = self._transform_body(node.body)
        node.orelse = self._transform_body(node.orelse)
        return node

    def visit_Delete(self, node: ast.Delete) -> ast.Delete:
        for target in node.targets:
            for name, name_node in _extract_store_names(target):
                self._guard_name(name, name_node)
        return node
