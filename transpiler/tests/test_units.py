"""Tests for physical units syntax (`1000.0 [kg/m^3]`) powered by `pint`."""

from __future__ import annotations

import pint
import pytest

from physpy.notebook import NotebookSession
from physpy.pipeline import transpile
from physpy.units import rewrite_units


def test_rewrite_units_basic():
    src = "x = 1000.0 [kg/m^3]\n"
    assert rewrite_units(src) == "x = __physpy_unit__(1000.0, 'kg/m^3')\n"


def test_rewrite_units_multiple_on_same_line():
    src = "v = 100 [m] / 9.58 [s]\n"
    assert rewrite_units(src) == "v = __physpy_unit__(100, 'm') / __physpy_unit__(9.58, 's')\n"


def test_rewrite_units_power_of_ten():
    src = "p_0 = 10^5 [Pa]\nl = 10^-3 [m]\n"
    out = transpile(src)
    assert "__physpy_unit__(10 ** 5, 'Pa')" in out
    assert "__physpy_unit__(10 ** (-3), 'm')" in out


def test_rewrite_units_leaves_list_and_array_indexing_alone():
    src = "arr = [1, 2, 3]\ny = arr[0] + [10, 20][1]\n"
    assert rewrite_units(src) == src


def test_units_hydrostatic_pressure_and_conversion():
    session = NotebookSession()
    res1 = session.run_cell(
        "export const \\rho_0 = 1000.0 [kg/m^3]\n"
        "export const g = 9.81 [m/s^2]\n"
        "h = 12.5 [m]\n"
        "p = (\\rho_0 * g * h).to('kPa')\n"
        "print(f'{p:.2f}')\n"
    )
    assert res1.code == 0, res1.stderr
    assert res1.stdout.strip() == "122.62 kPa"
    assert res1.all_exports["ρ_0"] == "1000.0 kg/m³"
    assert res1.all_exports["g"] == "9.81 m/s²"


def test_units_dimensionality_error_on_incompatible_addition():
    session = NotebookSession()
    res = session.run_cell("bad = 10 [m] + 5 [s]\n")
    assert res.code == 1
    assert "DimensionalityError" in res.stderr


def test_units_with_greek_symbols_inside_brackets():
    session = NotebookSession()
    res = session.run_cell(
        "r = 220 [\\Omega]\n"
        "w = 500 [\\mu m].to('mm')\n"
        "print(r, '|', w)\n"
    )
    assert res.code == 0, res.stderr
    assert "220 Ω | 0.5 mm" in res.stdout


def test_units_share_pint_application_registry():
    app_reg = pint.get_application_registry()
    pre_existing = app_reg.Quantity(2.0, "mV")

    session = NotebookSession()
    res = session.run_cell(
        "import pint\n"
        "offset = 0.02 [mV]\n"
        "other = pint.get_application_registry().Quantity(1.5, 'mV')\n"
        "total = offset + other\n"
        "print(f'{total:.2f}')\n"
    )
    assert res.code == 0, res.stderr
    assert res.stdout.strip() == "1.52 mV"

    res2 = session.run_cell("export add_pre = lambda x: x + 0.5 [mV]\n")
    assert res2.code == 0, res2.stderr
    sum_with_pre = session.exports["add_pre"](pre_existing)
    assert sum_with_pre.magnitude == pytest.approx(2.5)
    assert pre_existing._REGISTRY is sum_with_pre._REGISTRY


def test_units_follow_pint_pandas_custom_ureg_and_restore_on_reset(monkeypatch):
    import sys
    import types

    class FakePintType:
        ureg = pint.UnitRegistry()
        _cache = {"stale": object()}

    fake_pp = types.SimpleNamespace(PintType=FakePintType)
    monkeypatch.setitem(sys.modules, "pint_pandas", fake_pp)

    session = NotebookSession()
    res = session.run_cell(
        "import pint_pandas\n"
        "q = 0.01 [mV]\n"
        "same = (q._REGISTRY is pint_pandas.PintType.ureg)\n"
        "print(same)\n"
    )
    assert res.code == 0, res.stderr
    assert res.stdout.strip() == "True"

    session.reset()
    assert FakePintType._cache == {}
    assert FakePintType.ureg is pint.get_application_registry()

    res_after = session.run_cell(
        "import pint\n"
        "q = 1.0 [mV]\n"
        "other = pint.get_application_registry().Quantity(2.0, 'mV')\n"
        "print(f'{q + other:.1f}')\n"
    )
    assert res_after.code == 0, res_after.stderr
    assert res_after.stdout.strip() == "3.0 mV"
