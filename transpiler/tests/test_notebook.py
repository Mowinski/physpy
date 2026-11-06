import pytest

from physpy import TranspileError, transpile
from physpy.notebook import NotebookSession, split_cells


def test_export_assignment():
    out = transpile("export \\rho_0 = 1000\n")
    assert "ρ_0 = 1000" in out
    assert "__exports__.update({'ρ_0': ρ_0})" in out


def test_export_multiple_names():
    out = transpile("export a, b = 1, 2\n")
    assert "a, b = (1, 2)" in out
    assert "__exports__.update({'a': a, 'b': b})" in out


def test_export_existing_variable():
    out = transpile("x = 5\nexport x\n")
    assert "__exports__.update({'x': x})" in out


def test_export_import():
    out = transpile("export import math\n")
    assert "import math" in out
    assert "__exports__.update({'math': math})" in out


def test_export_function():
    out = transpile("export def f(x):\n    return x^2\n")
    assert "def f(x):" in out
    assert "__exports__.update({'f': f})" in out


def test_invalid_export_raises():
    with pytest.raises(TranspileError):
        transpile("export\n")


def test_cell_isolation_and_explicit_export():
    session = NotebookSession()

    # Cell 1: exports \rho_0 and g, keeps `secret` local
    r1 = session.run_cell("export \\rho_0 = 1000.0\nexport g = 9.81\nsecret = 42\n")
    assert r1.code == 0
    assert r1.exported == {"ρ_0": "1000.0", "g": "9.81"}
    assert "secret" not in r1.all_exports

    # Cell 2: can read \rho_0 and g, cannot read `secret`
    r2 = session.run_cell("p = \\rho_0 * g * 10\nprint(int(p))\n")
    assert r2.code == 0
    assert r2.stdout.strip() == "98100"

    r3 = session.run_cell("print(secret)\n")
    assert r3.code == 1
    assert "NameError" in r3.stderr


def test_split_cells():
    src = "# %% Constants\nexport \\rho_0 = 1000\n\n# %% Pressure\np = \\rho_0 * 10\n"
    cells = split_cells(src)
    assert len(cells) == 2
    assert cells[0].title == "Constants"
    assert "export \\rho_0" in cells[0].source
    assert cells[1].title == "Pressure"
