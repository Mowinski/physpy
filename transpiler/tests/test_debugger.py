"""Unit and integration tests for the PhysPy interactive debugger, CLI, importer, and worker RPC."""

from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from physpy import importer
from physpy.cli import main as cli_main
from physpy.debugger import (
     debug_cell,
    extract_cell_index_from_filename,
    is_external_library,
)
from physpy.notebook import RPC_PREFIX, NotebookSession, run_worker


def test_is_external_library() -> None:
    assert is_external_library(None) is True
    assert is_external_library("") is True
    assert is_external_library("<cell 1>") is False
    assert is_external_library("demo.ppy#cell-2") is False
    assert is_external_library("/path/to/site-packages/numpy/__init__.py") is True
    assert is_external_library("/usr/lib/python3.13/math.py") is True
    assert is_external_library("<frozen importlib._bootstrap>") is True
    assert is_external_library("<string>") is True
    assert is_external_library("/Users/kamil/project/my_script.ppy") is False


def test_extract_cell_index_from_filename() -> None:
    assert extract_cell_index_from_filename(None) is None
    assert extract_cell_index_from_filename("notebook.ppy#cell-3") == 3
    assert extract_cell_index_from_filename("<cell 5>") == 5
    assert extract_cell_index_from_filename("plain.py") is None


def test_debug_cell_step_over_and_locals() -> None:
    session = NotebookSession()
    events: list[dict[str, Any]] = []
    actions = iter(["step_over", "step_over", "continue"])

    def send_fn(payload: dict[str, Any]) -> None:
        events.append(payload)

    def read_cmd_fn() -> dict[str, Any]:
        return {"action": next(actions, "continue")}

    src = "x = 10\ny = x + 5\nexport z = y * 2\nprint(z)\n"
    res = debug_cell(
        session=session,
        source=src,
        filename="test.ppy#cell-1",
        cell_index=1,
        send_fn=send_fn,
        read_cmd_fn=read_cmd_fn,
    )
    assert res.code == 0
    assert res.stdout.strip() == "30"
    assert res.exported == {"z": "30"}
    assert session.exports["z"] == 30
    assert len(events) >= 2
    assert events[0]["event"] == "paused"
    assert events[0]["cell_index"] == 1
    # After first line executes, x should be in locals on second pause
    assert events[1]["locals"].get("x") == "10"


def test_debug_cell_step_into_and_step_out() -> None:
    session = NotebookSession()
    events: list[dict[str, Any]] = []
    actions = iter(["step_over", "step_into", "step_out", "continue"])

    src = (
        "def double(v):\n"
        "    tmp = v * 2\n"
        "    return tmp\n"
        "ans = double(21)\n"
        "ans\n"
    )
    res = debug_cell(
        session=session,
        source=src,
        filename="test.ppy#cell-2",
        cell_index=2,
        send_fn=lambda p: events.append(p),
        read_cmd_fn=lambda: {"action": next(actions, "continue")},
    )
    assert res.code == 0
    assert res.stdout.strip() == "42"
    assert any("v" in ev.get("locals", {}) for ev in events)


def test_debug_cell_stop_aborts_cleanly() -> None:
    session = NotebookSession()
    events: list[dict[str, Any]] = []

    src = "a = 1\nb = 2\nprint('should not print')\n"
    res = debug_cell(
        session=session,
        source=src,
        filename="test.ppy#cell-1",
        cell_index=1,
        send_fn=lambda p: events.append(p),
        read_cmd_fn=lambda: {"action": "stop"},
    )
    assert res.code == 0
    assert "should not print" not in res.stdout
    assert len(events) == 1


def test_debug_cell_syntax_and_runtime_errors() -> None:
    session = NotebookSession()
    # TranspileError
    res_err = debug_cell(
        session=session,
        source="x = \\unknownsymbolxyz\n",
        filename="test.ppy#cell-1",
        cell_index=1,
        send_fn=lambda _: None,
        read_cmd_fn=lambda: {"action": "continue"},
    )
    assert res_err.code == 2
    assert "error:" in res_err.stderr

    # Runtime exception during debugging
    res_rt = debug_cell(
        session=session,
        source="x = 1 / 0\n",
        filename="test.ppy#cell-1",
        cell_index=1,
        send_fn=lambda _: None,
        read_cmd_fn=lambda: {"action": "continue"},
    )
    assert res_rt.code == 1
    assert "ZeroDivisionError" in res_rt.stderr


def test_debug_cell_captures_plots_tables_and_matrices() -> None:
    session = NotebookSession()
    src = (
        "import matplotlib.pyplot as plt\n"
        "plt.plot([0, 1], [0, 1])\n"
        "plot plt\n"
        "rows = [{'a': 1, 'b': 2}]\n"
        "table rows\n"
        "M = [1, 2; 3, 4]\n"
        "M\n"
    )
    res = debug_cell(
        session=session,
        source=src,
        filename="test.ppy#cell-1",
        cell_index=1,
        send_fn=lambda _: None,
        read_cmd_fn=lambda: {"action": "continue"},
    )
    assert res.code == 0
    assert len(res.plots) == 1
    assert len(res.tables) == 1
    assert res.latex is not None and "\\begin{pmatrix}" in res.latex


def test_ppy_importer_loads_custom_ppy_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mod_file = tmp_path / "custom_phys_mod.ppy"
    mod_file.write_text(
        "\\rho_0 = 1000.0\n"
        "def kinetic(m, v):\n"
        "    return 0.5 * m * v^2\n",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    importer.install()

    import importlib

    mod = importlib.import_module("custom_phys_mod")
    assert getattr(mod, "ρ_0") == 1000.0
    assert mod.kinetic(2.0, 3.0) == 9.0


def test_cli_transpile_and_run(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ppy_file = tmp_path / "sample.ppy"
    ppy_file.write_text(
        "# %% Cell 1\n"
        "export \\alpha = 5\n"
        "# %% Cell 2\n"
        "print(\\alpha^2)\n",
        encoding="utf-8",
    )

    rc_t = cli_main(["transpile", str(ppy_file)])
    assert rc_t == 0
    out_t = capsys.readouterr().out
    assert "α = 5" in out_t
    assert "α ** 2" in out_t

    rc_r = cli_main(["run", str(ppy_file)])
    assert rc_r == 0
    out_r = capsys.readouterr().out
    assert out_r.strip() == "25"


def test_cli_syntax_error_returns_code_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    bad_file = tmp_path / "bad.ppy"
    bad_file.write_text("x = \\nonexistentsym\n", encoding="utf-8")

    rc = cli_main(["transpile", str(bad_file)])
    assert rc == 2
    err = capsys.readouterr().err
    assert "error:" in err


def test_worker_json_rpc_full_lifecycle(monkeypatch: pytest.MonkeyPatch) -> None:
    requests = [
        {"cmd": "run_cell", "cell_index": 1, "source": "export const \\rho_0 = 1000 [kg/m^3]\nexport arr = [1, 2; 3, 4]\n"},
        {"cmd": "inspect_var", "name": "ρ_0"},
        {"cmd": "inspect_var", "name": "arr"},
        {"cmd": "inspect_var", "name": "missing_var"},
        {"cmd": "complete", "prefix": "ar", "attr_target": None, "cell_source": "ar", "doc_source": ""},
        {"cmd": "signature", "expr": "abs", "cell_source": "abs(", "doc_source": ""},
        {"cmd": "format_code", "source": "x=1+2\n"},
        {"cmd": "format_cells", "cells": ["a=1*2\n", "export b=3+4\n"]},
        {"cmd": "run_cell", "cell_index": 2, "source": "import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 2])\nplot fig\n"},
        {"cmd": "check_plot", "plot_id": "plot_1"},
        {"cmd": "eval_plot", "plot_id": "plot_1", "source": "ax.set_title('Updated Title')"},
        {"cmd": "reset_plot", "plot_id": "plot_1"},
        {"cmd": "reset"},
        {"cmd": "check_plot", "plot_id": "plot_1"},
        {"cmd": "unknown_cmd_xyz"},
    ]
    stdin_text = "\n".join(json.dumps(r) for r in requests) + "\n{invalid json\n"
    fake_in = io.StringIO(stdin_text)
    fake_out = io.StringIO()

    monkeypatch.setattr(sys, "stdin", fake_in)
    monkeypatch.setattr(sys, "stdout", fake_out)

    rc = run_worker()
    assert rc == 0

    responses = []
    for line in fake_out.getvalue().splitlines():
        if line.startswith(RPC_PREFIX):
            responses.append(json.loads(line[len(RPC_PREFIX) :]))

    assert len(responses) == len(requests) + 1
    # 0: run_cell 1
    assert responses[0]["ok"] is True
    assert responses[0]["code"] == 0
    assert "ρ_0" in responses[0]["exported"]

    # 1: inspect_var ρ_0
    assert responses[1]["ok"] is True
    assert responses[1]["info"]["name"] == "ρ_0"
    assert "1000" in responses[1]["info"]["value"]

    # 2: inspect_var arr
    assert responses[2]["ok"] is True
    assert responses[2]["info"]["type"] == "ndarray"

    # 3: inspect_var missing
    assert responses[3]["ok"] is True
    assert responses[3]["info"] is None

    # 4: complete
    assert responses[4]["ok"] is True
    assert any(it["label"] == "arr" for it in responses[4]["items"])

    # 5: signature
    assert responses[5]["ok"] is True
    assert responses[5]["signature"]["name"] == "abs"

    # 6: format_code
    assert responses[6]["ok"] is True
    assert responses[6]["formatted"].strip() == "x = 1 + 2"

    # 7: format_cells
    assert responses[7]["ok"] is True
    assert [c.strip() for c in responses[7]["cells"]] == ["a = 1 * 2", "export b = 3 + 4"]

    # 8: run_cell 2 with plot
    assert responses[8]["ok"] is True
    assert len(responses[8]["plots"]) == 1
    assert responses[8]["plot_meta"][0]["plot_id"] == "plot_1"

    # 9: check_plot plot_1 -> True
    assert responses[9] == {"ok": True, "available": True}

    # 10: eval_plot
    assert responses[10]["ok"] is True
    assert responses[10]["plot_meta"]["axes"][0]["title"] == "Updated Title"

    # 11: reset_plot
    assert responses[11]["ok"] is True
    assert responses[11]["history"] == []

    # 12: reset
    assert responses[12] == {"ok": True, "all_exports": {}}

    # 13: check_plot after reset -> False
    assert responses[13] == {"ok": True, "available": False}

    # 14: unknown command
    assert responses[14]["ok"] is False
    assert "unknown command" in responses[14]["error"]

    # 15: invalid JSON
    assert responses[15]["ok"] is False


def test_worker_debug_start_rpc(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify the `debug_start` command inside `run_worker` pauses and finishes via RPC."""
    req = {
        "cmd": "debug_start",
        "cell_index": 1,
        "source": "a = 10\nb = a * 3\nexport c = b\n",
    }
    fake_in = io.StringIO(json.dumps(req) + "\n")
    fake_out = io.StringIO()
    # `debug_start` reads step actions from `sys.__stdin__` and emits pause events to `sys.__stdout__`
    fake_raw_in = io.StringIO(json.dumps({"action": "step_over"}) + "\n" + json.dumps({"action": "continue"}) + "\n")
    fake_raw_out = io.StringIO()

    monkeypatch.setattr(sys, "stdin", fake_in)
    monkeypatch.setattr(sys, "stdout", fake_out)
    monkeypatch.setattr(sys, "__stdin__", fake_raw_in)
    monkeypatch.setattr(sys, "__stdout__", fake_raw_out)

    rc = run_worker()
    assert rc == 0

    pause_events = [
        json.loads(line[len(RPC_PREFIX) :])
        for line in fake_raw_out.getvalue().splitlines()
        if line.startswith(RPC_PREFIX)
    ]
    assert len(pause_events) >= 1
    assert pause_events[0]["event"] == "paused"

    final_events = [
        json.loads(line[len(RPC_PREFIX) :])
        for line in fake_out.getvalue().splitlines()
        if line.startswith(RPC_PREFIX)
    ]
    assert len(final_events) == 1
    assert final_events[0]["ok"] is True
    assert final_events[0]["event"] == "finished"
    assert final_events[0]["result"]["exported"] == {"c": "30"}

