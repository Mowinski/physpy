import numpy as np
import pytest

from physpy import transpile
from physpy.notebook import NotebookSession


def test_matrix_single_line_transpile():
    src = "M = [1, 2; 3, 4]\n"
    out = transpile(src)
    assert "__physpy_matrix__" in out
    assert "[[1, 2], [3, 4]]" in out


def test_matrix_multiline_transpile():
    src = """M = [
    1, 2 ;
    3, 4
]
"""
    out = transpile(src)
    assert "__physpy_matrix__" in out
    assert "[[1, 2], [3, 4]]" in out


def test_matrix_with_trailing_semicolon():
    src = """M = [
    1, 2 ;
    3, 4 ;
]
"""
    out = transpile(src)
    assert "__physpy_matrix__" in out
    assert "[[1, 2], [3, 4]]" in out


def test_matrix_column_vector():
    src = "v = [1; 2; 3]\n"
    out = transpile(src)
    assert "__physpy_matrix__" in out
    assert "[[1], [2], [3]]" in out


def test_matrix_with_complex_and_greek_symbols():
    src = """M = [
    (i * k + k_3)/(2 * k_3), (-i * k + k_3)/(2 * k_3) ;
    (-i * k + k_3)/(2 * k_3), (i * k + k_3)/(2 * k_3)
]
"""
    out = transpile(src)
    assert "__physpy_matrix__" in out
    assert "(i * k + k_3) / (2 * k_3)" in out


def test_matrix_nested_indexing_not_broken():
    src = "M = [ a[0], a[1] ; b[0], b[1] ]\n"
    out = transpile(src)
    assert "__physpy_matrix__" in out
    assert "a[0]" in out
    assert "b[1]" in out


def test_regular_python_lists_untouched():
    src = "lst = [1, 2, 3]\nval = arr[0]\n"
    out = transpile(src)
    assert "__physpy_matrix__" not in out
    assert "lst = [1, 2, 3]" in out
    assert "val = arr[0]" in out


def test_matrix_execution_and_latex_output():
    session = NotebookSession()
    res = session.run_cell("""
M = [
    1, 2 ;
    3, 4
]
M
""")
    assert res.code == 0
    assert res.latex is not None
    assert "\\begin{pmatrix}" in res.latex
    assert "1 & 2 \\\\" in res.latex
    assert "3 & 4" in res.latex
    assert "\\end{pmatrix}" in res.latex


def test_matrix_complex_numbers_latex():
    session = NotebookSession()
    res = session.run_cell("""
M = [
    1 + 2j, -1j ;
    0, 4.5
]
M
""")
    assert res.code == 0
    assert res.latex is not None
    assert "1 + 2i" in res.latex
    assert "-i" in res.latex
    assert "4.5" in res.latex


def test_matrix_explicit_display_call():
    session = NotebookSession()
    res = session.run_cell("""
M = [1, 2; 3, 4]
display(M)
""")
    assert res.code == 0
    assert res.latex is not None
    assert "\\begin{pmatrix}" in res.latex
