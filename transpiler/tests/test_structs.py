from physpy.formatter import format_physpy_code
from physpy.notebook import NotebookSession


def test_struct_defaults_and_unit_conversion():
    session = NotebookSession()
    r1 = session.run_cell(
        "export struct WynikiPret:\n"
        "    name: str\n"
        "    a: [mm]\n"
        "    \\u_a: [mm]\n"
        "    E: [GPa]\n"
        "    note\n",
        filename="nb.ppy#cell-1",
    )
    assert r1.code == 0, r1.stderr

    r2 = session.run_cell(
        "p = WynikiPret(name='brązowy', a=0.01 [m], E=110)\n"
        "print(p.name, '|', f'{p.a:.1f}', '|', f'{p.E:.0f}', '|', p.u_a, '|', p.note)\n",
        filename="nb.ppy#cell-2",
    )
    assert r2.code == 0, r2.stderr
    assert r2.stdout.strip() == "brązowy | 10.0 mm | 110 GPa | None | None"


def test_pomiar_arithmetic_and_unit_conversion():
    session = NotebookSession()
    res = session.run_cell(
        "a = Pomiar(9.885 [mm], 0.033 [mm])\n"
        "a_cm = a -> [cm]\n"
        "b = Pomiar(2.0 [mm], 0.04 [mm])\n"
        "s = a + b\n"
        "print(a, '|', a_cm, '|', f'{a.rel:.2f}%', '|', s)\n"
    )
    assert res.code == 0, res.stderr
    assert "9.885 ± 0.033 mm" in res.stdout
    assert "0.9885 ± 0.0033 cm" in res.stdout
    assert "0.33%" in res.stdout
    assert "11.885 ± 0.0518556 mm" in res.stdout


def test_table_from_list_of_structs_and_pomiar():
    session = NotebookSession()
    res = session.run_cell(
        "struct Pret:\n"
        "    material: str\n"
        "    a: [mm]\n"
        "    E\n"
        "\n"
        "wyniki = [\n"
        "    Pret(material='brązowy', a=Pomiar(9.885 [mm], 0.033 [mm]), E=Pomiar(110 [GPa], 2 [GPa])),\n"
        "    Pret(material='szary', a=Pomiar(0.00995 [m], 0.00003 [m]), E=Pomiar(205 [GPa], 4 [GPa])),\n"
        "]\n"
        "table wyniki\n"
    )
    assert res.code == 0, res.stderr
    assert len(res.tables) == 1
    tbl = res.tables[0]
    cols = {c["name"]: c for c in tbl["columns"]}
    assert cols["a"]["unit"] == "mm"
    assert cols["E"]["unit"] == "GPa"
    assert tbl["rows"][0]["cells"] == ["brązowy", "9.885 ± 0.033", "110 ± 2"]
    assert tbl["rows"][1]["cells"] == ["szary", "9.95 ± 0.03", "205 ± 4"]


def test_format_struct_with_units():
    src = "export struct WynikiPret:\n    a:[mm]\n    \\u_a:[mm]\n"
    formatted = format_physpy_code(src)
    assert "export struct WynikiPret:" in formatted
    assert "a: [mm]" in formatted
    assert "\\u_a: [mm]" in formatted
