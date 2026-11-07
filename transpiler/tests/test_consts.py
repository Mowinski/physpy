import pytest

from physpy import TranspileError, transpile
from physpy.notebook import NotebookSession


def test_const_declaration_transpiles():
    out = transpile("const g = 9.81\nprint(g)\n")
    assert "g = 9.81" in out


def test_export_const_declaration():
    out = transpile("export const \\rho_0 = 1000\n")
    assert "ρ_0 = 1000" in out
    assert "__exports__.update({'ρ_0': ρ_0})" in out
    assert "__consts__.update({'ρ_0'})" in out


def test_reassign_const_raises():
    with pytest.raises(TranspileError) as exc:
        transpile("const g = 9.81\ng = 10.0\n")
    assert "cannot reassign constant 'g'" in exc.value.message
    assert exc.value.line == 2


def test_augassign_const_raises():
    with pytest.raises(TranspileError) as exc:
        transpile("const \\rho_0 = 1000\n\\rho_0 += 1\n")
    assert "cannot reassign constant 'ρ_0'" in exc.value.message


def test_redeclare_const_raises():
    with pytest.raises(TranspileError):
        transpile("const g = 9.81\nconst g = 10\n")


def test_const_without_value_raises():
    with pytest.raises(TranspileError):
        transpile("const g\n")


def test_export_const_protected_across_cells():
    session = NotebookSession()
    r1 = session.run_cell("export const g = 9.81\n")
    assert r1.code == 0

    r2 = session.run_cell("g = 10.0\n")
    assert r2.code == 2
    assert "cannot reassign constant 'g'" in r2.stderr
