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
        to_source("x = 1\ny = \\foo\n")
    assert (exc.value.line, exc.value.col) == (2, 5)


def test_subscript_variables():
    assert to_source("\\m_0 = 10\n") == "m_0 = 10\n"
    assert to_source("\\m_e = 1822\n") == "m_e = 1822\n"
    assert to_source("\\v_max = 300\n") == "v_max = 300\n"
    assert to_source("\\E_kin = 0.5 * \\m_0 * \\v_max**2\n") == "E_kin = 0.5 * m_0 * v_max**2\n"


def test_imaginary_unit():
    assert to_source("z = \\i\n") == "z = 1j\n"
    assert to_source("z = 2 * \\i\n") == "z = 2 * 1j\n"
    assert to_source("z = 2\\i\n") == "z = 2* 1j\n"
    assert to_source("z = 3.5\\i\n") == "z = 3.5* 1j\n"
    assert to_source("z = \\i_0\n") == "z = i_0\n"
    assert to_source("z = (1 + 2\\i)\n") == "z = (1 + 2* 1j)\n"
    assert to_source("z = -\\i\n") == "z = -1j\n"


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


def test_accented_symbols():
    code = "\\bar{u} = 5\n\\bar{u}_a = 1\n\\overline{czas} = 2\n\\hat{\\theta} = 3\n\\vec{v} = 4\n\\dot{x} = 6\n\\ddot{x} = 7\n\\tilde{p} = 8\n"
    compiled = transpile(code)
    ns: dict = {}
    exec(compile(compiled, "<test>", "exec"), ns)
    assert ns[unicodedata.normalize("NFKC", "u\u0304")] == 5
    assert ns[unicodedata.normalize("NFKC", "u\u0304_a")] == 1
    assert ns[unicodedata.normalize("NFKC", "czas\u0304")] == 2
    assert ns[unicodedata.normalize("NFKC", "θ\u0302")] == 3
    assert ns[unicodedata.normalize("NFKC", "v\u20d7")] == 4
    assert ns[unicodedata.normalize("NFKC", "x\u0307")] == 6
    assert ns[unicodedata.normalize("NFKC", "x\u0308")] == 7
    assert ns[unicodedata.normalize("NFKC", "p\u0303")] == 8


def test_accented_subscript_symbols():
    code = "\\u_\\bar{t} = 11\n\\sigma_\\hat{x} = 12\n\\bar{u}_\\bar{t} = 13\n"
    compiled = transpile(code)
    ns: dict = {}
    exec(compile(compiled, "<test>", "exec"), ns)
    assert ns[unicodedata.normalize("NFKC", "u_t\u0304")] == 11
    assert ns[unicodedata.normalize("NFKC", "σ_x\u0302")] == 12
    assert ns[unicodedata.normalize("NFKC", "u\u0304_t\u0304")] == 13


def test_prime_and_dprime_symbols():
    code = "\\prime{t} = 21\n\\dprime{t} = 22\n\\prime{\\theta}_0 = 23\n\\u_\\prime{t} = 24\n"
    compiled = transpile(code)
    ns: dict = {}
    exec(compile(compiled, "<test>", "exec"), ns)
    assert ns[unicodedata.normalize("NFKC", "t\u02b9")] == 21
    assert ns[unicodedata.normalize("NFKC", "t\u02ba")] == 22
    assert ns[unicodedata.normalize("NFKC", "θ\u02b9_0")] == 23
    assert ns[unicodedata.normalize("NFKC", "u_t\u02b9")] == 24


def test_accented_symbol_errors():
    with pytest.raises(TranspileError):
        to_source("x = \\bar{\\unknown}\n")
    with pytest.raises(TranspileError):
        to_source("x = \\bar{\\i}\n")


def test_pi_constant():
    assert to_source("a = \\pi\n") == "a = 3.141592653589793\n"
    assert to_source("c = 2\\pi * r\n") == "c = 2* 3.141592653589793 * r\n"
    assert to_source("c = 2.5\\pi\n") == "c = 2.5* 3.141592653589793\n"
    assert to_source("x = -\\pi\n") == "x = -3.141592653589793\n"
    assert to_source("\\pi_0 = 1\n") == "π_0 = 1\n"
