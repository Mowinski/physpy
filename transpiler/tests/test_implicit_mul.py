import pytest

from physpy import to_source, transpile


@pytest.mark.parametrize(
    ("src", "expected"),
    [
        ("y = 2(a + b)", "y = 2 * (a + b)"),
        ("y = 2 (a + b)", "y = 2 * (a + b)"),
        ("y = 2.5e3(x)", "y = 2500.0 * x"),
        ("y = 3j(x)", "y = 3j * x"),
        ("y = 2(a)(b)", "y = 2 * a(b)"),  # only the literal gets `*`
        ("print(2(3))", "print(2 * 3)"),
    ],
)
def test_number_before_paren(src, expected):
    assert transpile(src) == expected


@pytest.mark.parametrize(
    "src",
    [
        "y = f(x)",           # regular call
        "y = x2(a)",          # identifier ending with a digit
        "y = (a)(b)",         # call of a parenthesized expression
        "y = f(2)(3)",        # call of a call result
        's = "2(3)"',         # inside a string
        "y = 2  # 2(3)",      # inside a comment
    ],
)
def test_untouched(src):
    assert to_source(src) == src


def test_with_symbols():
    assert transpile("\\alpha = 2*\\rho_0 + 2(\\rho_0 + g)") == "α = 2 * ρ_0 + 2 * (ρ_0 + g)"


def test_multiline_parenthesis_keeps_lines():
    src = "y = 2(\n    a +\n    b\n)\n"
    out = to_source(src)
    assert out.count("\n") == src.count("\n")
    assert out.startswith("y = 2*(")
