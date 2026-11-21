import pytest

from physpy import to_source, transpile
from physpy.notebook import NotebookSession


@pytest.mark.parametrize(
    ("src", "expected"),
    [
        ("plot plt", "__physpy_plot__(plt)"),
        ("plot fig", "__physpy_plot__(fig)"),
        ("plot ax", "__physpy_plot__(ax)"),
        ("plot ax.plot(x, y)", "__physpy_plot__(ax.plot(x, y))"),
        ("if True:\n    plot plt", "if True:\n    __physpy_plot__(plt)"),
    ],
)
def test_plot_statement_rewrite(src, expected):
    assert transpile(src) == expected


@pytest.mark.parametrize(
    "src",
    [
        "plot = 42",
        "plot += 1",
        "plot(x, y)",
        "plt.plot(x, y)",
        's = "plot plt"',
        "# plot plt",
    ],
)
def test_non_plot_statements_untouched(src):
    assert to_source(src) == src


def test_plot_matplotlib_pyplot_and_figure():
    session = NotebookSession()
    r1 = session.run_cell(
        "import matplotlib.pyplot as plt\n"
        "plt.plot([0, 1, 2], [0, 1, 4])\n"
        "plot plt\n"
    )
    assert r1.code == 0, r1.stderr
    assert len(r1.plots) == 1
    assert len(r1.plots[0]) > 100

    r2 = session.run_cell(
        "import matplotlib.pyplot as plt\n"
        "fig, ax = plt.subplots()\n"
        "ax.plot([1, 2, 3], [2, 4, 6])\n"
        "plot fig\n"
    )
    assert r2.code == 0, r2.stderr
    assert len(r2.plots) == 1


def test_plot_creates_isolated_figure_copies_for_modal_repl():
    session = NotebookSession()
    res = session.run_cell(
        "import matplotlib.pyplot as plt\n"
        "export fig, ax = plt.subplots()\n"
        "ax.plot([0, 1, 2], [0, 1, 2])\n"
        "ax.set_title('First')\n"
        "plot fig\n"
        "ax.plot([0, 1, 2], [0, 2, 4])\n"
        "ax.set_title('Second')\n"
        "plot fig\n"
    )
    assert res.code == 0, res.stderr
    assert len(res.plot_meta) == 2
    p1_id = res.plot_meta[0]["plot_id"]
    p2_id = res.plot_meta[1]["plot_id"]
    assert p1_id != p2_id

    # Snapshot #1 has 1 line; Snapshot #2 has 2 lines
    assert len(session.plot_store[p1_id].work_fig.axes[0].lines) == 1
    assert len(session.plot_store[p2_id].work_fig.axes[0].lines) == 2

    # Mutate plot #1 via REPL (`ax`, `fig`, PhysPy syntax)
    repl1 = session.eval_plot_code(p1_id, "ax.set_xlim(0, 50)\nax.set_xlabel('t [s]')")
    assert repl1["ok"] is True
    assert repl1["code"] == 0, repl1["stderr"]
    assert repl1["history"] == ["ax.set_xlim(0, 50)\nax.set_xlabel('t [s]')"]
    assert repl1["plot_meta"]["axes"][0]["xlim"] == [0.0, 50.0]
    assert repl1["plot_meta"]["axes"][0]["xlabel"] == "t [s]"

    # Cumulative REPL command + non-Artist expression output
    repl2 = session.eval_plot_code(p1_id, "ax.set_ylim(-5, 25)\nax.get_ylim()")
    assert repl2["ok"] is True
    assert repl2["code"] == 0
    assert "-5.0" in repl2["stdout"] and "25.0" in repl2["stdout"]
    assert len(repl2["history"]) == 2

    # Exported `fig` in session and plot #2 remain untouched
    assert session.exports["fig"].axes[0].get_title() == "Second"
    assert session.plot_store[p2_id].work_fig.axes[0].get_xlim() != (0.0, 50.0)

    # Reset plot #1 back to its initial snapshot
    reset_res = session.reset_plot(p1_id)
    assert reset_res["ok"] is True
    assert reset_res["history"] == []
    assert reset_res["plot_meta"]["axes"][0]["xlim"] != [0.0, 50.0]
    assert reset_res["plot_meta"]["axes"][0]["xlabel"] == ""
