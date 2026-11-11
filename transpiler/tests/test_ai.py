"""Tests for Gemini AI cell assistant."""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.request

from physpy.ai import build_user_message, call_gemini, list_gemini_models


def test_call_gemini_requires_api_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    res = call_gemini({"prompt": "add velocity calculation", "cell_source": "x = 1"})
    assert res["ok"] is False
    assert "Missing Gemini API key" in res["error"]


def test_build_user_message_includes_context_exports_and_cell():
    msg = build_user_message(
        {
            "context_before": "export g = 9.81 [m/s^2]",
            "exports": {"g": "9.81 m/s²"},
            "cell_source": "h = 5 [m]",
            "prompt": "oblicz predkosc koncowa",
        }
    )
    assert "export g = 9.81 [m/s^2]" in msg
    assert "- g: 9.81 m/s²" in msg
    assert "h = 5 [m]" in msg
    assert "oblicz predkosc koncowa" in msg


def test_call_gemini_parses_structured_json_response(monkeypatch):
    captured = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            payload = {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": json.dumps(
                                        {
                                            "code": "v = (2 * g * h)^0.5\nprint(v.to('m/s'))",
                                            "explanation": "Obliczono prędkość ze spadku swobodnego.",
                                        }
                                    )
                                }
                            ]
                        }
                    }
                ]
            }
            return json.dumps(payload).encode("utf-8")

    def fake_urlopen(req, timeout=45, context=None):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.header_items())
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return FakeResponse()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    res = call_gemini(
        {
            "api_key": "test-secret-key",
            "model": "gemini-2.5-flash",
            "prompt": "oblicz v",
            "cell_source": "h = 5 [m]",
        }
    )
    assert res["ok"] is True
    assert res["model"] == "gemini-2.5-flash"
    assert "v = (2 * g * h)^0.5" in res["code"]
    assert "Obliczono prędkość" in res["explanation"]
    assert captured["url"].endswith("/models/gemini-2.5-flash:generateContent")
    assert captured["headers"].get("X-goog-api-key") == "test-secret-key"


def test_call_gemini_reports_http_error(monkeypatch):
    def fake_urlopen(req, timeout=45, context=None):
        raise urllib.error.HTTPError(
            req.full_url,
            401,
            "Unauthorized",
            {},
            io.BytesIO(json.dumps({"error": {"message": "API key not valid."}}).encode("utf-8")),
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    res = call_gemini({"api_key": "bad-key", "prompt": "test"})
    assert res["ok"] is False
    assert "401" in res["error"]
    assert "API key not valid." in res["error"]


def test_list_gemini_models_filters_generate_content(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps(
                {
                    "models": [
                        {
                            "name": "models/embedding-001",
                            "displayName": "Embedding",
                            "supportedGenerationMethods": ["embedContent"],
                        },
                        {
                            "name": "models/gemini-3.8-flash",
                            "displayName": "Gemini 3.8 Flash",
                            "supportedGenerationMethods": ["generateContent", "countTokens"],
                        },
                        {
                            "name": "models/gemini-2.5-pro",
                            "displayName": "Gemini 2.5 Pro",
                            "supportedGenerationMethods": ["generateContent"],
                        },
                    ]
                }
            ).encode("utf-8")

    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=20, context=None: FakeResponse())
    res = list_gemini_models({"api_key": "test-key"})
    assert res["ok"] is True
    assert [m["id"] for m in res["models"]] == ["gemini-2.5-pro", "gemini-3.8-flash"]
