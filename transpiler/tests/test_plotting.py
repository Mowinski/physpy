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
