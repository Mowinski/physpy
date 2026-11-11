import pytest

from physpy import transpile
from physpy.notebook import NotebookSession


def test_simple_percentages():
    assert "0.05" in transpile("x = 5%\n")
    assert "0.125" in transpile("x = 12.5%\n")
    assert "0.005" in transpile("x = 0.5%\n")
    assert "1.0" in transpile("x = 100%\n")
    assert "0.0" in transpile("x = 0%\n")


def test_percentages_in_expressions():
    out = transpile("cost = 100 * 5%\n")
    assert "100 * 0.05" in out

    out = transpile("p = 10% + 20%\n")
    assert "0.1 + 0.2" in out

    out = transpile("arr = [5%, 10%, 15%]\n")
    assert "[0.05, 0.1, 0.15]" in out

    out = transpile("res = (1 + 5%) * 200\n")
    assert "(1 + 0.05) * 200" in out


def test_percentages_with_conditions():
    out = transpile("if rate > 5%:\n    pass\n")
    assert "if rate > 0.05:" in out


def test_modulo_operator_preserved():
    # Modulo with whitespace
    out = transpile("m = 10 % 3\n")
    assert "10 % 3" in out
    assert "0.03" not in out

    # Modulo with variable
    out = transpile("m = a % b\n")
    assert "a % b" in out

    # Modulo with expression
    out = transpile("m = 10 % (x + 1)\n")
    assert "10 % (x + 1)" in out


def test_string_formatting_with_percent_preserved():
    out = transpile('msg = "Value: %d" % 42\n')
    assert "% 42" in out


def test_comments_preserved():
    from physpy.pipeline import to_source

    out = to_source("# 5% discount\nx = 1\n")
    assert "# 5% discount" in out


def test_notebook_execution_with_percentages():
    session = NotebookSession()
    res = session.run_cell("""
export p = 5%
export total = 200 * (1 + 10%)
""")
    assert res.code == 0
    assert abs(float(res.exported["p"]) - 0.05) < 1e-6
    assert abs(float(res.exported["total"]) - 220.0) < 1e-6
