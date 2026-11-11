"""Transpilation pipeline: source passes -> ast.parse -> AST passes."""

from __future__ import annotations

import ast
from collections.abc import Callable
from types import CodeType

from .consts import ConstTransformer, rewrite_consts
from .exports import ExportTransformer, rewrite_exports
from .implicit_mul import rewrite_implicit_mul
from .matrix import rewrite_matrix_literals
from .percentages import rewrite_percentages
from .pipe import PipeTransformer, rewrite_pipe_tokens
from .plotting import rewrite_plots
from .power import rewrite_powers
from .symbols import rewrite_symbols
from .units import rewrite_units

# Text -> text. Must preserve line numbers. Order matters:
# rewrite_symbols must run first, because tokenize cannot handle `\rho`.
SOURCE_PASSES: list[Callable[[str], str]] = [
    rewrite_symbols,
    rewrite_consts,
    rewrite_exports,
    rewrite_plots,
    rewrite_units,
    rewrite_matrix_literals,
    rewrite_percentages,
    rewrite_implicit_mul,
    rewrite_powers,
    rewrite_pipe_tokens,
]

# ast.NodeTransformer subclasses, applied in order.
AST_PASSES: list[type[ast.NodeTransformer]] = [
    ConstTransformer,
    ExportTransformer,
    PipeTransformer,
]


def to_source(src: str) -> str:
    """Apply only the source passes (keeps comments and formatting)."""
    for p in SOURCE_PASSES:
        src = p(src)
    return src


def to_ast(
    src: str,
    filename: str = "<input>",
    predeclared_consts: set[str] | None = None,
) -> ast.Module:
    tree = ast.parse(to_source(src), filename=filename)
    for transformer_cls in AST_PASSES:
        if transformer_cls is ConstTransformer:
            tree = ConstTransformer(predeclared_consts).visit(tree)
        else:
            tree = transformer_cls().visit(tree)
    return ast.fix_missing_locations(tree)


def transpile(src: str, filename: str = "<input>") -> str:
    """Return plain Python code equivalent to the PhysPy ``src``."""
    return ast.unparse(to_ast(src, filename))


def compile_source(
    src: str,
    filename: str = "<input>",
    predeclared_consts: set[str] | None = None,
) -> CodeType:
    return compile(to_ast(src, filename, predeclared_consts), filename, "exec")
