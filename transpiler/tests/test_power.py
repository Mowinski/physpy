import pytest

from physpy import to_source, transpile


@pytest.mark.parametrize(
    ("src", "expected"),
    [
        ("y = x^2", "y = x ** 2"),
        ("y = x^-2", "y = x ** (-2)"),
        ("y = x^n", "y = x ** n"),
        ("y = x^(n + 1)", "y = x ** (n + 1)"),
        ("y = \\rho_0^2", "y = ρ_0 ** 2"),
        ("y = 2 * x^2 + 1", "y = 2 * x ** 2 + 1"),  # precedence: ^ binds tighter than *
        ("E = m * c^2", "E = m * c ** 2"),
    ],
)
def test_power_rewrite(src, expected):
    assert transpile(src) == expected


@pytest.mark.parametrize(
    "src",
    [
        "y = a ** 2",          # standard Python power still works
        's = "x^2"',           # inside string
        "y = 1  # x^2",        # inside comment
        "x ^= 1",              # augmented XOR assignment untouched
    ],
)
def test_power_untouched(src):
    assert to_source(src) == src
