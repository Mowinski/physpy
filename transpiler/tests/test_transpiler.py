import unicodedata

import pytest

from physpy import TranspileError, to_source, transpile
from physpy.symbols import IDENTIFIERS


def test_basic_symbol():
    assert to_source("\\rho_0 = 1000\n") == "ρ_0 = 1000\n"


def test_keyword_names_are_safe():
    # `lambda` is a Python keyword, `λ` is a normal identifier.
    assert to_source("\\lambda = 5e-7") == "λ = 5e-7"


def test_strings_and_comments_untouched():
    src = 'x = "\\rho" + r"\\alpha"  # \\beta\ny = \'\'\'\n\\gamma\n\'\'\'\n'
    assert to_source(src) == src


def test_line_continuation_untouched():
    src = "x = 1 + \\\n    2\n"
    assert to_source(src) == src


def test_line_numbers_preserved():
    src = "a = 1\n\\rho = 2\nb = '''\n\\x\n'''\n\\omega = 3\n"
    assert to_source(src).count("\n") == src.count("\n")


def test_unknown_symbol_reports_position():
    with pytest.raises(TranspileError) as exc:
        to_source("x = 1\ny = \\foo_1\n")
    assert (exc.value.line, exc.value.col) == (2, 5)


def test_identifiers_are_valid_and_unique():
    # Python NFKC-normalizes identifiers: two different glyphs (e.g. ϕ and φ)
    # could silently become the same variable. Guard against that.
    idents = list(IDENTIFIERS.values())
    assert len(set(idents)) == len(idents)
    for ident in idents:
        assert ident.isidentifier()
        assert unicodedata.normalize("NFKC", ident) == ident


def test_pipe_operator():
    assert transpile("y = x |> f |> g") == "y = g(f(x))"
    assert transpile("y = a + b |> str") == "y = str(a + b)"


def test_symbols_and_pipe_together():
    assert transpile("\\rho_0 |> print") == "print(ρ_0)"
