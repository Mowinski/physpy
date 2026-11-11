"""Tests for Python + PhysPy live autocomplete and signature inspection."""

from __future__ import annotations

from physpy.complete import get_completions, get_signature


def test_signature_from_stdlib_import_and_alias():
    src = "import math as m\nval = m.pow("
    sig = get_signature("m.pow", cell_source=src)
    assert sig is not None
    assert sig["name"] == "m.pow"
    param_names = [p["name"] for p in sig["params"]]
    assert param_names[:2] == ["x", "y"]


def test_signature_from_user_ast_def_and_lambda():
    doc = (
        "# %% Helpers\n"
        "export def energy(mass: float, vel=0.0, *, scale=1):\n"
        "    '''Compute kinetic energy.'''\n"
        "    return 0.5 * mass * vel**2 * scale\n\n"
        "export blad = lambda v, tol=0.05: tol * v\n"
    )
    sig_fn = get_signature("energy", cell_source="energy(", doc_source=doc)
    assert sig_fn is not None
    assert [p["name"] for p in sig_fn["params"]] == ["mass", "vel", "scale"]
    assert "mass: float" in sig_fn["signature"]
    assert "Compute kinetic energy" in sig_fn["doc"]

    sig_lam = get_signature("blad", cell_source="blad(", doc_source=doc)
    assert sig_lam is not None
    assert [p["name"] for p in sig_lam["params"]] == ["v", "tol"]


def test_signature_from_runtime_exports_and_physpy_helpers():
    class Sensor:
        def calibrate(self, offset: float, gain: float = 1.0) -> float:
            """Calibrate raw reading."""
            return offset * gain

    sig = get_signature("sensor.calibrate", exports={"sensor": Sensor()})
    assert sig is not None
    assert [p["name"] for p in sig["params"]] == ["offset", "gain"]
    assert "Calibrate raw reading" in sig["doc"]

    plot_sig = get_signature("plot")
    assert plot_sig is not None
    assert any(p["name"] == "xlabel" for p in plot_sig["params"])


def test_completions_dot_attribute_and_locals():
    src = "import math\ndef helper(alpha, beta=1):\n    return alpha + beta\nmath."
    items = get_completions(prefix="sq", attr_target="math", cell_source=src)
    labels = [item["label"] for item in items]
    assert "sqrt" in labels
    sqrt_item = next(item for item in items if item["label"] == "sqrt")
    assert sqrt_item["kind"] == "function"

    bare_items = get_completions(prefix="hel", cell_source=src)
    bare_labels = [item["label"] for item in bare_items]
    assert "helper" in bare_labels
    helper_item = next(item for item in bare_items if item["label"] == "helper")
    assert "(alpha, beta=1)" in helper_item["detail"]
