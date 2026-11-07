# PhysPy

Wieloplatformowy edytor i notatnik Pythona stworzony do obliczeń fizycznych i inżynierskich.
Piszesz czytelny kod matematyczno-fizyczny w czystym ASCII (`\rho_0`, `x^2`, `1000.0 [kg/m^3]`), edytor na żywo renderuje go jako notację fizyczną ($\rho_0$, $x^2$, `[kg/m³]`), a transpiler w locie tłumaczy go na czysty kod Pythona.

**Stack:** Tauri 2 (Rust) · CodeMirror 6 + KaTeX (TypeScript/Vite) · Transpiler `physpy` w Pythonie (`ast` + `tokenize` + `pint` + `matplotlib`)

---

## Najważniejsze możliwości

### 1. Składnia fizyczna i matematyczna
| Składnia PhysPy | Transpilowany Python | Opis |
|---|---|---|
| `\rho_0`, `\omega_0`, `\Delta x` | `ρ_0`, `ω_0`, `Δx` | Symbole greckie i fizyczne renderowane przez KaTeX (z autouzupełnianiem po wpisaniu `\`) |
| `1000.0 [kg/m^3]`, `p.to("kPa")` | `__physpy_unit__(1000.0, 'kg/m^3')` | Jednostki fizyczne oparte o `pint` (`pint.Quantity`) z automatyczną kontrolą wymiarową i konwersją `.to(...)` |
| `const g = 9.81 [m/s^2]` | stała niemodyfikowalna | Blokuje nadpisanie stałej na poziomie AST oraz **natychmiast podkreśla próbę zmiany na czerwono w edytorze** |
| `export x = ...`, `export const ...`, `export import ...` | zapis do sesji `__exports__` | Jawne współdzielenie zmiennych, stałych, funkcji, klas i importów między komórkami `# %%` |
| `2(\rho_0 + g)` | `2*(ρ_0 + g)` | Domyślne mnożenie przed nawiasem po literale liczbowym |
| `x^2`, `x^(n+1)` | `x**2`, `x**(n+1)` | Potęgowanie z symbolem `^` renderowane w edytorze jako indeks górny ($x^2$, $x^{n+1}$) |
| `x \|> f \|> g` | `g(f(x))` | Operator potoku (pipe) |
| `plot plt`, `plot fig`, `plot ax` | `__physpy_plot__(plt)` | Renderowanie wykresów `matplotlib` bezpośrednio pod komórką w notatniku |

### 2. Notatnik komórkowy (`# %%`) z izolacją zakresów
- Pliki `.ppy` dzielone są na komórki za pomocą `# %% Tytuł komórki` (zostają zwykłymi plikami tekstowymi przyjaznymi dla Gita).
- Domyślnie zmienne pomocnicze wewnątrz komórki są **lokalne tylko dla tej komórki** — nie zaśmiecają globalnej przestrzeni nazw.
- Aby przekazać zmienną, stałą, funkcję lub import do kolejnych komórek, użyj słowa kluczowego `export`:
  ```python
  # %% Stałe fizyczne i ciśnienie hydrostatyczne
  export import numpy as np
  export const \rho_0 = 1000.0 [kg/m^3]
  export const g = 9.81 [m/s^2]

  h = 12.5 [m]
  p = (\rho_0 * g * h).to("kPa")
  print(f"Ciśnienie hydrostatyczne: {p:.2f}")

  # %% Wahadło matematyczne
  L = 2.0 [m]
  export \omega_0 = np.sqrt(g / L)
  export T = (2 * np.pi / \omega_0).to("s")
  print(f"Okres drgań: {T:.2f}")
  ```

### 3. Środowisko desktopowe (IDE)
- **Zwijane drzewo plików (`⌘B`)** z obsługą tworzenia, zmiany nazw i usuwania plików/folderów z menu kontekstowego.
- **Karty edytora (Taby)** w stylu VS Code (`⌘N`, `⌘W`, środkowy przycisk myszy, menu pod prawym przyciskiem myszy).
- **Dolny panel Variables (`⌘J`)** — skanuje na żywo wszystkie deklaracje `export` oraz `export const` w pliku, pokazuje ich aktualne wartości (wraz z jednostkami `pint`), oznacza zmienne oczekujące na uruchomienie komórki oraz ostrzega o zduplikowanych eksportach.
- **Wybór interpretera Pythona** — okno modalne pozwalające przełączać środowisko Pythona (`.venv`, Conda, Homebrew, systemowy lub własna ścieżka).
- **Podgląd wygenerowanego Pythona** — boczny panel pokazujący wynik transpilacji w czasie rzeczywistym.

---

## Struktura projektu

```text
├── index.html, src/            # Frontend (Vite + TypeScript + CodeMirror 6 + KaTeX)
│   ├── main.ts                 # UI: komórki, taby, drzewo plików, panel Variables, dialog Pythona
│   ├── backend.ts              # Wrappery na komendy Tauri
│   └── editor/
│       ├── mathSymbols.ts      # Renderowanie \rho_0 → ρ₀ oraz x^2 → x² (KaTeX)
│       ├── constLint.ts        # Podświetlanie const/export, jednostek [unit] oraz błędów nadpisania const
│       ├── completion.ts       # Autouzupełnianie symboli po wpisaniu "\"
│       ├── symbols.ts          # Tabela symboli + konwersja do LaTeX
│       └── setup.ts            # Konfiguracja CodeMirror 6
├── src-tauri/                  # Backend desktopowy (Rust / Tauri 2)
│   └── src/lib.rs              # Proces roboczy Pythona (JSON-RPC), operacje plikowe, wykrywanie Pythona
├── transpiler/                 # Pakiet Pythona `physpy`
│   ├── src/physpy/
│   │   ├── symbols.json        # Wspólna tabela symboli (współdzielona z frontendem)
│   │   ├── symbols.py          # \rho_0 → ρ_0 (w tym wewnątrz f-stringów)
│   │   ├── consts.py           # Obsługa słowa kluczowego `const` + walidacja AST
│   │   ├── exports.py          # Obsługa słowa kluczowego `export` między komórkami
│   │   ├── units.py            # Jednostki fizyczne `1000.0 [kg/m^3]` (pint)
│   │   ├── plotting.py         # Komenda `plot plt` / `plot fig` (matplotlib → PNG)
│   │   ├── implicit_mul.py     # Domyślne mnożenie `2(a + b)` → `2*(a + b)`
│   │   ├── power.py            # Potęgowanie `x^2` → `x**2`
│   │   ├── pipe.py             # Operator potoku `x |> f` → `f(x)`
│   │   ├── notebook.py         # Dzielenie na komórki `# %%` i sesja wykonawcza
│   │   ├── pipeline.py         # Rejestr przebiegów transpilacji
│   │   ├── importer.py         # Import hook pozwalający robić `import modul` dla plików `.ppy`
│   │   └── cli.py              # CLI: `physpy run`, `physpy transpile`, `physpy worker`
│   └── tests/                  # Testy jednostkowe pytest
├── examples/demo.ppy           # Przykładowy notatnik fizyczny
└── .github/workflows/build.yml # CI/CD budujące instalatory na macOS, Windows i Linux
```

---

## Uruchomienie lokalne

### Wymagania
- **Node.js** 20+
- **Rust** (stable toolchain)
- **Python** 3.10+ oraz [`uv`](https://docs.astral.sh/uv/)

### Instalacja i start

```bash
# 1. Przygotowanie środowiska Pythona z bibliotekami (numpy, matplotlib, pint, pytest)
cd transpiler && uv sync && cd ..

# 2. Instalacja zależności frontendu
npm install

# 3. Uruchomienie aplikacji desktopowej w trybie deweloperskim
npm run tauri dev

# 4. Zbudowanie gotowej aplikacji desktopowej (.app / .dmg / .msi / .deb / .AppImage)
npm run tauri build
```

### Użycie samego transpilera z linii komend (CLI)

```bash
# Uruchomienie pliku .ppy
cd transpiler && uv run physpy run ../examples/demo.ppy

# Podgląd wygenerowanego kodu Pythona
cd transpiler && uv run physpy transpile ../examples/demo.ppy

# Uruchomienie testów
cd transpiler && uv run pytest
```
