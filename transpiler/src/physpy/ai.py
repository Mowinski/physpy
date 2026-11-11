"""Gemini AI code assistant for PhysPy notebook cells."""

from __future__ import annotations

import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"

PHYSPY_SYSTEM_PROMPT = """You are an AI coding assistant embedded inside PhysPy, a physics & engineering Python notebook environment.
Your job is to write or modify the active PhysPy code cell according to the user's request and the notebook context.

PhysPy syntax rules (always prefer idiomatic PhysPy syntax when appropriate):
- Physical units are written as bracket literals after numbers: `g = 9.81 [m/s^2]`, `r = 220 [\\Omega]`, `dt = 5 [delta_degC]` (powered by `pint`, and compatible with `pint-pandas` columns `.astype("pint[mV]")`).
- Percentages are literals: `5%` compiles to `0.05` (so `0.05% * v` works directly).
- Greek & subscript identifiers use TeX escapes: `\\alpha`, `\\rho_0`, `\\Delta_T`.
- Matrix literals use `mat[...]`: `M = mat[1, 2; 3, 4]`.
- Cells have isolated namespaces: only variables marked `export x = ...`, `export const \\g = ...`, or `export import ...` persist across cells.
- Plots can use `plot plt` / `plot fig` / `plot ax` (rendered inline as PNG).
- Pandas DataFrames/Series can be displayed as interactive tables via `table df`, `display(df)`, `print(df)`, or leaving `df` as the last expression.
- Power operator `^` is supported in PhysPy math expressions (`x^2`, `10^-3`).

Return ONLY valid JSON matching the requested schema with:
- `code`: the complete updated code for the active cell (ready to replace or insert cleanly; never wrap in markdown fences inside JSON).
- `explanation`: a concise 1-2 sentence explanation in the same language as the user's prompt.
"""

_FENCE_RE = re.compile(r"```(?:[a-zA-Z0-9_+-]+)?\s*\n(.*?)```", re.DOTALL)


def _build_ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    try:
        import certifi

        cafile = certifi.where()
        if os.path.isfile(cafile):
            ctx.load_verify_locations(cafile=cafile)
            return ctx
    except Exception:
        pass
    if os.path.isfile("/etc/ssl/cert.pem"):
        try:
            ctx.load_verify_locations(cafile="/etc/ssl/cert.pem")
        except Exception:
            pass
    return ctx


def resolve_api_key(explicit_key: str | None) -> str:
    if explicit_key and explicit_key.strip():
        return explicit_key.strip()
    for env_name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        val = os.environ.get(env_name, "").strip()
        if val:
            return val
    return ""


def _strip_code_fences(text: str) -> str:
    m = _FENCE_RE.search(text)
    if m:
        return m.group(1).strip()
    return text.strip()


def build_user_message(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    context_before = str(payload.get("context_before") or "").strip()
    if context_before:
        parts.append(f"### Preceding cells in notebook\n```physpy\n{context_before}\n```")

    exports = payload.get("exports")
    if isinstance(exports, dict) and exports:
        lines = [f"- {k}: {v}" for k, v in list(exports.items())[:40]]
        parts.append("### Active exported variables in current session\n" + "\n".join(lines))

    cell_source = str(payload.get("cell_source") or "")
    if cell_source.strip():
        parts.append(f"### Current active cell code\n```physpy\n{cell_source}\n```")
    else:
        parts.append("### Current active cell code\n(empty cell)")

    prompt = str(payload.get("prompt") or "").strip()
    parts.append(f"### User request\n{prompt}")
    return "\n\n".join(parts)


def _extract_candidate_text(resp_json: dict[str, Any]) -> str:
    candidates = resp_json.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        block_reason = (resp_json.get("promptFeedback") or {}).get("blockReason")
        if block_reason:
            raise RuntimeError(f"Gemini blocked the prompt ({block_reason}).")
        raise RuntimeError("Gemini returned no candidates.")
    first = candidates[0]
    content = first.get("content") or {}
    parts = content.get("parts") or []
    texts = [p.get("text", "") for p in parts if isinstance(p, dict) and p.get("text")]
    return "\n".join(texts).strip()


def _format_http_error(exc: urllib.error.HTTPError) -> str:
    err_body = exc.read().decode("utf-8", errors="replace")
    msg = f"Gemini HTTP {exc.code}"
    try:
        err_json = json.loads(err_body)
        detail = (err_json.get("error") or {}).get("message")
        if detail:
            return f"Gemini API error ({exc.code}): {detail}"
    except Exception:
        pass
    if err_body.strip():
        return f"{msg}: {err_body.strip()[:300]}"
    return msg


def call_gemini(payload: dict[str, Any]) -> dict[str, Any]:
    provider = str(payload.get("provider") or "gemini").strip().lower()
    if provider not in ("", "gemini"):
        return {"ok": False, "error": f"Unsupported AI provider '{provider}'. Currently only 'gemini' is supported."}

    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "Prompt cannot be empty."}

    api_key = resolve_api_key(payload.get("api_key"))
    if not api_key:
        return {
            "ok": False,
            "error": (
                "Missing Gemini API key. Set `ai_api_key` in Settings (~/.physpy/config.yaml) "
                "or set the GEMINI_API_KEY environment variable."
            ),
        }

    model = str(payload.get("model") or DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL
    custom_sys = str(payload.get("custom_system_prompt") or "").strip()
    system_text = PHYSPY_SYSTEM_PROMPT + (f"\nAdditional user instructions:\n{custom_sys}\n" if custom_sys else "")
    user_text = build_user_message(payload)

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model, safe='')}:generateContent"
    body = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "code": {"type": "STRING"},
                    "explanation": {"type": "STRING"},
                },
                "required": ["code"],
            },
        },
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=45, context=_build_ssl_context()) as resp:
            raw_resp = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": _format_http_error(exc)}
    except urllib.error.URLError as exc:
        return {"ok": False, "error": f"Network error calling Gemini: {exc.reason}"}
    except Exception as exc:
        return {"ok": False, "error": f"Failed calling Gemini: {exc}"}

    try:
        resp_json = json.loads(raw_resp)
        raw_text = _extract_candidate_text(resp_json)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    code = ""
    explanation = ""
    try:
        parsed = json.loads(raw_text)
        if isinstance(parsed, dict) and isinstance(parsed.get("code"), str):
            code = _strip_code_fences(parsed["code"])
            explanation = str(parsed.get("explanation") or "").strip()
        else:
            code = _strip_code_fences(raw_text)
    except Exception:
        code = _strip_code_fences(raw_text)

    if not code:
        return {"ok": False, "error": "Gemini returned an empty code suggestion."}

    return {
        "ok": True,
        "code": code,
        "explanation": explanation,
        "model": model,
    }


def list_gemini_models(payload: dict[str, Any]) -> dict[str, Any]:
    """Fetch available Gemini models supporting ``generateContent`` for the API key."""
    provider = str(payload.get("provider") or "gemini").strip().lower()
    if provider not in ("", "gemini"):
        return {"ok": False, "error": f"Unsupported AI provider '{provider}'."}

    api_key = resolve_api_key(payload.get("api_key"))
    if not api_key:
        return {
            "ok": False,
            "error": (
                "Missing Gemini API key. Paste `ai_api_key` or set the GEMINI_API_KEY environment variable."
            ),
        }

    url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200"
    req = urllib.request.Request(
        url,
        headers={"x-goog-api-key": api_key},
        method="GET",
    )

    try:
        with urllib.request.urlopen(req, timeout=20, context=_build_ssl_context()) as resp:
            raw_resp = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": _format_http_error(exc)}
    except urllib.error.URLError as exc:
        return {"ok": False, "error": f"Network error calling Gemini: {exc.reason}"}
    except Exception as exc:
        return {"ok": False, "error": f"Failed listing Gemini models: {exc}"}

    try:
        resp_json = json.loads(raw_resp)
    except Exception as exc:
        return {"ok": False, "error": f"Invalid JSON from Gemini models API: {exc}"}

    raw_models = resp_json.get("models")
    if not isinstance(raw_models, list):
        return {"ok": False, "error": "Gemini models API returned no model list."}

    models: list[dict[str, str]] = []
    seen: set[str] = set()
    for m in raw_models:
        if not isinstance(m, dict):
            continue
        methods = m.get("supportedGenerationMethods") or []
        if "generateContent" not in methods:
            continue
        name = str(m.get("name") or "")
        model_id = name[len("models/") :] if name.startswith("models/") else name
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        display_name = str(m.get("displayName") or model_id).strip()
        models.append({"id": model_id, "display_name": display_name})

    models.sort(key=lambda item: (0 if item["id"].startswith("gemini-") else 1, item["id"]))
    return {"ok": True, "models": models}


def run_ai_cli() -> int:
    """Read JSON request from stdin, invoke Gemini, and print JSON response to stdout."""
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict):
            raise ValueError("Expected JSON object on stdin")
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"Invalid AI request JSON: {exc}"}))
        return 1

    action = str(payload.get("action") or "generate").strip().lower()
    result = list_gemini_models(payload) if action == "list_models" else call_gemini(payload)
    print(json.dumps(result))
    return 0 if result.get("ok") else 1
