import pytest

from physpy import compile_source, transpile
from physpy.numbers import rewrite_number_spaces


@pytest.mark.parametrize(
    ("src", "expected"),
    [
        ("x = 3 012 123", "x = 3012123"),
        ("x = 3 012 123.123 423", "x = 3012123.123423"),
        ("x = 1 005", "x = 1005"),
        ("x = 1.005 002", "x = 1.005002"),
        ("x = .123 456", "x = .123456"),
        ("x = 1 000.", "x = 1000."),
        ("x = 6.022 140 76e23", "x = 6.02214076e23"),
        ("x = 1 000e-3", "x = 1000e-3"),
        ("x = 1 000_000", "x = 1000_000"),
        ('s = "3 012 123.123 423"', 's = "3 012 123.123 423"'),
        ("# 3 012 123", "# 3 012 123"),
        ('s = f"{3 012 123}"', 's = f"{3012123}"'),
    ],
)
def test_rewrite_number_spaces(src: str, expected: str) -> None:
    assert rewrite_number_spaces(src) == expected


@pytest.mark.parametrize(
    "src",
    [
        "x1 2",
        "var_1 2",
        "0x10 20",
        "1 0x10",
        "1 2foo",
        "1\n2",
    ],
)
def test_rewrite_number_spaces_untouched(src: str) -> None:
    assert rewrite_number_spaces(src) == src


def test_numbers_with_physpy_features() -> None:
    src = (
        "c = 299 792 458 [m/s]\n"
        "p = 1 250%\n"
        "sq = 1 000^2\n"
        "mul = 2 000(3 + 1)\n"
        "z = 1 000 + 2 000\\i\n"
        "m = [1 000, 2 000; 3 000, 4 000]\n"
    )
    py = transpile(src)
    assert "__physpy_unit__(299792458, 'm/s')" in py
    assert "p = 12.5" in py
    assert "1000 ** 2" in py
    assert "2000 * (3 + 1)" in py
    assert "1000 + 2000 * 1j" in py
    assert "__physpy_matrix__([[1000, 2000], [3000, 4000]])" in py


def test_numbers_compile_and_run() -> None:
    ns: dict = {}
    code = compile_source("x = 3 012 123.123 423\ny = 1 000 + 2 000")
    exec(code, ns)
    assert ns["x"] == pytest.approx(3012123.123423)
    assert ns["y"] == 3000
