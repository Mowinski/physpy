# Kontekst projektu PhysPy (dla agenta / kolejnych sesji)

Dokument podsumowuje architekturę, zrealizowane funkcje oraz bieżący stan repozytorium `/Users/kamil/Projects/python-physicis`.

---

## 1. Architektura (3 warstwy)
- **Frontend (`src/`, `index.html`)**: Vite + TypeScript + CodeMirror 6 + KaTeX.
  - `src/main.ts` — komórki notebooka (`code`, `markdown`, `deps`, `media`), pasek `exported`, panel **Variables** / **Warnings**, przypięte wykresy + tryb **Compare**, panel AI, zapis `.ppyout`.
  - `src/editor/` — `setup.ts` (konfiguracja CodeMirror i `codeModeCompartment`), `symbols.ts`, `mathSymbols.ts`, `matrixConceal.ts`, `constLint.ts`, `completion.ts`, `pythonAssist.ts`, `codeIntelligence.ts`, `debuggerExtension.ts`.
  - `src/markdownLatex.ts` — renderowanie Markdown + KaTeX (`renderMarkdownWithLatex`) oraz LaTeXa w `stdout` komórek (`renderStdoutWithLatexHtml`).
  - `src/refactor.ts` — skaner identyfikatorów (`scanIdentifiers`) używany przy refaktoryzacji zmiennych oraz podświetlaniu `const`.
  - `src/htmlExport.ts` — eksport notebooka do pojedynczego pliku HTML.
- **Backend desktopowy (`src-tauri/src/lib.rs`)**: Tauri 2 (Rust), trwały worker Pythona przez JSON-RPC (`try_with_worker`), komendy FS, `ai_assist`, `inspect_variable`, konfiguracja `.venv`.
- **Transpiler & Runtime (`transpiler/src/physpy/`)**:
  - Kolejność source passów w `pipeline.py`: `rewrite_symbols` → `rewrite_structs` → `rewrite_number_spaces` → `rewrite_consts` → `rewrite_exports` → `rewrite_plots` → `rewrite_tables` → `rewrite_units` → `rewrite_matrix_literals` → `rewrite_percentages` → `rewrite_implicit_mul` → `rewrite_powers` → `rewrite_pipe_tokens`.
  - AST passy: `ConstTransformer` → `ExportTransformer` → `PipeTransformer`.
  - `symbols.json` oraz `physical_constants.json` są wspólnym źródłem prawdy między frontendem (`src/editor/symbols.ts`) a Pythonem (`symbols.py`, `units.py`).

---

## 2. Zrealizowane funkcje

### Składnia PhysPy i transpiler
- **Symbole greckie/fizyczne, akcenty i primy (`symbols.py`, `symbols.ts`, `completion.ts`):**
  - Klasyczne `\rho_0`, `\Delta_p1`, `\hbar`, jednostka urojona `\i` (`1j`, `2\i`).
  - Akcenty i primy ze znakami łączącymi Unicode: `\bar`, `\overline`, `\hat`, `\vec`, `\dot`, `\ddot`, `\tilde`, `\prime` (`ʹ`), `\dprime` (`ʺ`), również w indeksach dolnych (np. `\u_\bar{t}`, `\u_\prime{t}`).
- **Wbudowane stałe fizyczne (`physical_constants.json`, `units.py`, `symbols.py`):**
  - `\const{name}` (20 stałych CODATA/SI: `g`, `c`, `h`, `hbar`, `k_B`, `N_A`, `R`, `e`, `m_e`, `m_p`, `m_n`, `u`, `G`, `eps_0`, `mu_0`, `sigma`, `F`, `R_inf`, `a_0`, `atm`) zwraca `pint.Quantity` (`__physpy_const__('name')`) bez kolizji ze zmiennymi użytkownika.
- **Jednostki fizyczne (`units.py`):**
  - Literały `liczba [jednostka]`, konwersja strzałką `wyrażenie -> [jednostka]` (`__physpy_convert__`).
- **Stałe międzykomórkowe (`consts.py`, `notebook.py`):**
  - `NotebookSession.const_owners` śledzi komórkę-właściciela każdej stałej `export const` / `const export`, dzięki czemu ponowne uruchomienie tej samej komórki działa bez błędu `cannot reassign constant`, a inne komórki nadal mają blokadę nadpisania.
- **Struktury danych `struct` i typ `Pomiar` (`structs.py`, `tables.py`, `formatter.py`):**
  - `struct Nazwa:` (oraz `export struct Nazwa:`) tworzy automatycznie `@dataclass` z domyślnym `= None` dla pól bez wartości i automatyczną konwersją jednostek dla pól `pole: [jednostka]`.
  - Wbudowany typ `Pomiar(val, u)` z `.val`, `.u`, `.rel` (%), `.to(...)` / `-> [jednostka]` i propagacją niepewności (`+`, `-`, `*`, `/`).
  - `table` obsługuje `pandas.DataFrame`/`Series` oraz listy obiektów `struct` / `@dataclass` / `dict` (z wyciąganiem wspólnych jednostek do nagłówków i formatowaniem `Pomiar`).
- **Formater (`formatter.py`):**
  - Obsługuje `black` z zachowaniem `export`, `struct`, `plot`, `table`, symboli/akcentów/primów, `\const{...}` i `-> [jednostka]`.

### Edytor i interfejs IDE
- **Renderowanie matematyki (`mathSymbols.ts`, `setup.ts`, `styles.css`):**
  - Podgląd KaTeX dla symboli, potęg, `sqrt(...)` / `np.sqrt(...)` (wieloznakowe identyfikatory jako `\text{...}`), strzałek `-> [jednostka]`.
  - Kliknięcie w widget LaTeXa ustawia kursor na końcu surowego tokena (`pos + raw.length`); `updateDOM()` zwraca `false` + `display: inline-block` na `.cm-math-*`, co eliminuje nakładanie się widgetów po edycji.
  - Komórki Markdown (`kind === "markdown"`) nie renderują LaTeXa ani składni Pythona w locie — dopiero po kliknięciu **Render**.
  - Zmienne `const` podświetlane są na złoto (`#e5c07b`) za pomocą `.cm-const-var` w `constLint.ts`.
- **Wyjście komórek i panele:**
  - `print(...)` renderuje wzory `$ ... $` i `$$ ... $$` przez KaTeX w wyjściu komórki i eksporcie HTML (`dataset.rawOutput` zachowuje czysty tekst do kopiowania).
  - Pasek `exported (N)` jest zwinięty domyślnie i otwiera po kliknięciu posortowaną alfabetycznie tabelę z oczyszczonymi floatami (`_short_repr` do 240 znaków).
  - Panel **Variables** (`⌘J`): sortowanie po `Variable` lub `Defined in`, przypinanie zmiennych `📌` na górze (zapis w `localStorage`), przycisk `⤢` otwierający modal z pełną, nieuciętą wartością (`inspect_variable` → `inspect_var`).
  - Sticky nagłówki komórek z menu `+` (Above / Below) oraz galeria przypiętych wykresów z kolejnością, zmianą nazw i trybem **Compare**.
  - Modal wykresu (`plot-lightbox-dialog`) z bocznym panelem **Figure REPL (copy)** i szybkimi przełącznikami (**Quick Controls**): każda komenda `plot ...` tworzy w `NotebookSession.plot_store` izolowaną kopię (`copy_figure` z `FigureCanvasAgg`) pod unikalnym `plot_id` (`base_fig` + `work_fig`). W modalu można wykonywać kod Pythona/PhysPy w trybie REPL na `fig`, `ax`, `axes`, `plt` (z autouzupełnianiem), wyklikać zmianę tytułu, etykiet osi, siatki, skali lin/log, legendy oraz rozmiaru czcionki, podejrzeć i skopiować skumulowany kod (`📋 Copy Code`, z deduplikacją powtarzających się setterów) oraz przywrócić stan początkowy (`↺ Reset`) bez modyfikowania wykresu w samej komórce.
- **AI Assistant i boczny panel AI Chat (`ai.py`, `lib.rs`, `backend.ts`, `main.ts`):**
  - Timeout zapytań Gemini zwiększony do `180 s`.
  - Podgląd szacowanych tokenów (`~X tok`) przed wysłaniem oraz dokładne zużycie (`↑ input tok · ↓ output tok`) z `usageMetadata` po odpowiedzi.
  - Prawy panel **✨ AI Chat** (`⇧⌘K` / przycisk na górnym pasku): wieloturowy czat z Gemini (`call_gemini_chat` / `ai_chat`) korzystający z zapisanego klucza `ai_api_key` i modelu z ustawień, z obsługą wielu sesji (`+ New Session`, przełączanie zakładek sesji, zamykanie/kasowanie sesji `✕` / `🗑 Delete`), opcjonalnym dołączaniem kontekstu notebooka i zmiennych `export`, renderowaniem Markdown + KaTeX oraz przyciskami `📋 Copy` i `+ Cell` przy blokach kodu.
- **Edytor LaTeX (`.tex`, `.bib`, `.sty`, `.cls`) (`src/latexEditor.ts`, `lib.rs`, `main.ts`):**
  - Kolorowanie składni LaTeX (`StreamLanguage`: komentarze `%`, tryby matematyczne `$...$`/`$$...$$`/`\[...\]`, środowiska `\begin{...}`/`\end{...}`, komendy strukturalne i makra) oraz autouzupełnianie środowisk, komend i symboli greckich po wpisaniu `\`.
  - Konfigurowalny **`Target .tex`** z opcją **`Rebuild on Save`** (`📌 Pin Current` lub `📂 Browse…`) oraz wyborem silnika (`pdflatex`, `xelatex`, `lualatex`, `latexmk -pdf`) — zapisanie dowolnego pliku automatycznie przebudowuje wskazany plik `.tex` (lub aktualnie otwarty plik `.tex`, gdy pole docelowe jest puste), odświeża podgląd PDF na `<canvas>` (`pdfjs-dist`, z zachowaniem pozycji scrolla po przebudowaniu) i zapisuje log kompilacji (`📋 Log`).
- **Podgląd plików graficznych (`#image-view`, `main.ts`):**
  - Otwieranie plików `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`, `.gif`, `.bmp`, `.ico` w dedykowanej zakładce z zoomem, przesuwaniem, przełącznikiem tła (`checker / white / dark`), odświeżaniem z dysku i przyciskiem `📋 \includegraphics`.
- **Przypisanie interpretera Pythona / `.venv` per-plik poza plikiem `.ppy` (`~/.physpy/file_interpreters.json`, `lib.rs`, `main.ts`):**
  - Wybór interpretera w modalu `🐍 Python` zapisuje powiązanie `{ "/ścieżka/do/pliku.ppy": "/ścieżka/do/venv/bin/python3" }` w katalogu użytkownika `~/.physpy/file_interpreters.json` (bez dopisywania metadanych do samego pliku `.ppy`). Otwarcie pliku, przełączenie karty lub uruchomienie komórki automatycznie przełącza workera Pythona na przypisany dla tego pliku `.venv` (oznaczony na pasku ikoną `📌`, z opcją `Unbind File`).

---

## 3. Komendy weryfikacji i buildu
- Testy Pythona: `cd transpiler && .venv/bin/pytest -q` (ostatni wynik: `146 passed`).
- TypeScript: `npx tsc --noEmit` (ostatni wynik: 0 błędów).
- Build i instalacja macOS `.app`:
  `npm run tauri build -- --bundles app && rm -rf /Applications/PhysPy.app && cp -R src-tauri/target/release/bundle/macos/PhysPy.app /Applications/PhysPy.app`
