# Baza pomysłów (Backlog)

Lista pomysłów odłożonych do przyszłej rozbudowy PhysPy:

## AI Assistant w komórkach
- **Wsparcie kolejnych dostawców AI (multi-provider):**
  - OpenAI i dowolne endpointy OpenAI-compatible (OpenRouter, Groq, LM Studio, własne proxy) z konfigurowalnym `ai_base_url`
  - Anthropic (Claude)
  - Lokalna Ollama (wybór lokalnych modeli bez klucza API)
- **„Fix with AI” dla błędów w komórce:**
  - Przycisk bezpośrednio przy błędzie (`stderr`) w outputcie komórki, który automatycznie wysyła kod komórki, traceback i kontekst zmiennych sesji do modelu z prośbą o propozycję poprawki.
