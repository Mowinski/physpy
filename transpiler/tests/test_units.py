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


def test_unit_conversion_arrow():
    session = NotebookSession()
    res = session.run_cell(
        "def f(x: int) -> list[int]:\n"
        "    return [x]\n"
        "u1 = 1.5 [V] -> [mV]\n"
        "a = 20\n"
        "N = 4\n"
        "u2 = (a / N) -> [mV]\n"
        "u3 = u1 -> [V]\n"
        "print(f'{u1:.0f}', f'{u2:.0f}', f'{u3:.1f}')\n"
    )
    assert res.code == 0, res.stderr
    assert res.stdout.strip() == "1500 mV 5 mV 1.5 V"


def test_builtin_physical_constants():
    from physpy.units import PHYSICAL_CONSTANTS, get_physical_constant

    # Every constant in physical_constants.json must resolve to a valid pint Quantity.
    for name in PHYSICAL_CONSTANTS:
        q = get_physical_constant(name)
        assert hasattr(q, "units")

    session = NotebookSession()
    res = session.run_cell(
        "g = 10\n"
        "h = 2 [m]\n"
        "v = (2 * \\const{g} * h)**0.5\n"
        "p = \\const{atm} -> [hPa]\n"
        "print(f'{v:.2f}', '|', f'{p:.2f}', '|', g)\n"
    )
    assert res.code == 0, res.stderr
    assert "6.26 m/s | 1013.25 hPa | 10" in res.stdout


def test_unknown_physical_constant_raises():
    res = NotebookSession().run_cell("x = \\const{nope}\n")
    assert res.code == 2
    assert "unknown physical constant" in res.stderr


def test_physical_constant_overrides(tmp_path):
    from physpy.units import (
        get_constant_overrides,
        get_effective_constant_value,
        load_constant_overrides_from_config,
        set_constant_overrides,
    )

    try:
        applied = set_constant_overrides(
            {
                "g": 9.8123,
                "G": "6.67e-11",
                "unknown_const": 123,
                "c": float("nan"),
                "h": True,
            }
        )
        assert applied == {"g": 9.8123, "G": 6.67e-11}
        assert get_constant_overrides() == {"g": 9.8123, "G": 6.67e-11}
        assert get_effective_constant_value("g") == 9.8123
        assert get_effective_constant_value("c") == 299792458.0

        session = NotebookSession()
        res = session.run_cell("print(f'{\\const{g}.magnitude:.4f}', \\const{g}.units)\n")
        assert res.code == 0, res.stderr
        assert "9.8123 m/s²" in res.stdout

        # Session reset preserves configured constant overrides
        session.reset()
        res2 = session.run_cell("print(f'{\\const{g}.magnitude:.4f}')\n")
        assert res2.code == 0, res2.stderr
        assert "9.8123" in res2.stdout

        # Workspace YAML config loading
        ws_cfg = tmp_path / ".physpy-config.yaml"
        ws_cfg.write_text("constants:\n  g: 1.62\n  atm: 100000\n", encoding="utf-8")
        loaded = load_constant_overrides_from_config(str(tmp_path))
        assert loaded["g"] == 1.62
        assert loaded["atm"] == 100000.0
    finally:
        set_constant_overrides({})


def test_custom_physical_constants(tmp_path):
    from physpy.units import (
        get_custom_constants,
        get_effective_constant_value,
        has_constant,
        load_custom_constants_from_config,
        set_constant_overrides,
        set_custom_constants,
    )

    try:
        applied = set_custom_constants(
            {
                "rho_w": {"value": 1000, "unit": "kg/m^3", "label": "water density"},
                "k_custom": {"value": 42.5, "unit": ""},
                "g": {"value": 1.0, "unit": "m/s^2"},  # cannot shadow built-in
                "bad name!": {"value": 1.0, "unit": "m"},
            }
        )
        assert set(applied.keys()) == {"rho_w", "k_custom"}
        assert applied["k_custom"]["unit"] == "dimensionless"
        assert has_constant("rho_w")
        assert get_custom_constants()["rho_w"]["value"] == 1000.0

        session = NotebookSession()
        res = session.run_cell(
            "V = 2 [m^3]\n"
            "m = \\const{rho_w} * V\n"
            "print(f'{m:.0f}', '|', f'{\\const{k_custom}.magnitude:.1f}')\n"
        )
        assert res.code == 0, res.stderr
        assert "2000 kg | 42.5" in res.stdout

        # Override on custom constant
        set_constant_overrides({"rho_w": 1025})
        assert get_effective_constant_value("rho_w") == 1025.0

        # Workspace YAML loading for custom_constants
        ws_cfg = tmp_path / ".physpy-config.yaml"
        ws_cfg.write_text(
            "custom_constants:\n"
            "  c_water:\n"
            "    value: 4184\n"
            "    unit: \"J/(kg*K)\"\n"
            "    label: \"specific heat\"\n",
            encoding="utf-8",
        )
        loaded_custom = load_custom_constants_from_config(str(tmp_path))
        assert loaded_custom["c_water"]["value"] == 4184.0
        assert loaded_custom["c_water"]["unit"] == "J/(kg*K)"
        assert loaded_custom["c_water"]["label"] == "specific heat"
    finally:
        set_constant_overrides({})
        set_custom_constants({})
