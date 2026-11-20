# Baza pomysłów (Backlog)

Lista pomysłów odłożonych do przyszłej rozbudowy PhysPy:

## AI Assistant w komórkach
- **Wsparcie kolejnych dostawców AI (multi-provider):**
  - OpenAI i dowolne endpointy OpenAI-compatible (OpenRouter, Groq, LM Studio, własne proxy) z konfigurowalnym `ai_base_url`
  - Anthropic (Claude)
  - Lokalna Ollama (wybór lokalnych modeli bez klucza API)
- **„Fix with AI” dla błędów w komórce:**
  - Przycisk bezpośrednio przy błędzie (`stderr`) w outputcie komórki, który automatycznie wysyła kod komórki, traceback i kontekst zmiennych sesji do modelu z prośbą o propozycję poprawki.

## Składnia PhysPy
- **Brakujące symbole fizyczne i stałe:**
  - `\varepsilon` ($\varepsilon$) i `\ell` ($\ell$ — czytelniejsze od `l` przy długościach, nie myli się z `1`)
  - `\infty` ($\infty$) transpilowane do `float("inf")` / `np.inf`
  - `\deg` ($^\circ$, np. `30\deg` jako kąt w stopniach)
- **Zapis pomiaru z niepewnością (`+-` / `\pm`):**
  - *(Wbudowany typ `Pomiar(val, u)` jest już zaimplementowany w `structs.py`)* — pozostaje skrócony operator `+-` / `\pm` (renderowany w edytorze jako $\pm$), np. `R = (0.5 +- 0.003) [mm]` lub skrót dla niepewności typu B z rozkładu jednostajnego (dzielenie przez $\sqrt{3}$).
