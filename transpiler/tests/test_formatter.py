from physpy.formatter import format_cells_batch, format_physpy_code


def test_format_standard_python_operators():
    src = "def morse_potencial(r):\n    return D_e * (np.exp(-2*β*(r-r_e)) - 2*np.exp(-β * (r- r_e )))\n"
    res = format_physpy_code(src)
    assert "return D_e * (np.exp(-2 * β * (r - r_e)) - 2 * np.exp(-β * (r - r_e)))" in res


def test_format_physpy_exports_and_symbols():
    src = """export energies=np.linspace(\\V_0/4,4*\\V_0,1000)
export S_values=[]
export R_values=[]

for energy in energies:
    S_energy,R_energy=calculate_scattering(energy,\\V_0,a,m,\\hbar)
    S_values.append(abs(S_energy)**2)
    R_values.append(abs(R_energy)**2)

plot plt
"""
    res = format_physpy_code(src)
    assert "export energies = np.linspace(\\V_0 / 4, 4 * \\V_0, 1000)" in res
    assert "export S_values = []" in res
    assert "export R_values = []" in res
    assert "S_energy, R_energy = calculate_scattering(energy, \\V_0, a, m, \\hbar)" in res
    assert "plot plt" in res


def test_format_exports_variants():
    src = """export import math
export from math import sqrt, pi
export def my_func(x,y=1):
    return x+y
export a,b = 1,2
export a,b
"""
    res = format_physpy_code(src)
    assert "export import math" in res
    assert "export from math import sqrt, pi" in res
    assert "export def my_func(x, y=1):" in res
    assert "export a, b = 1, 2" in res
    assert "export a, b" in res


def test_format_syntax_error_safe_fallback():
    broken = "def incomplete(r:\n    broken * * *"
    res = format_physpy_code(broken)
    assert res == broken


def test_format_batch():
    cells = [
        "x=1+2\n",
        "export y=x*3\n",
    ]
    res = format_cells_batch(cells)
    assert res[0].strip() == "x = 1 + 2"
    assert res[1].strip() == "export y = x * 3"
