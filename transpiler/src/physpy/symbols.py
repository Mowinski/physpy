"""Source pass: ``\\rho_0`` -> ``ρ_0``.

``\\`` is a line-continuation character in Python, so the standard ``tokenize``
module cannot handle ``\\rho``. This pass therefore runs *before* tokenization
and uses a small scanner that skips strings and comments.

Line numbers are preserved (no newlines are added or removed), so tracebacks
point at the right line of the original file.
"""

from __future__ import annotations

import json
import re
import unicodedata
from importlib import resources

from .errors import TranspileError, position

# name -> display character, shared with the editor frontend.
SYMBOLS: dict[str, str] = json.loads(
    resources.files(__package__).joinpath("symbols.json").read_text(encoding="utf-8")
)

# name -> Python identifier. Python NFKC-normalizes identifiers, so we store the
# normalized form explicitly (e.g. two glyphs that normalize to the same letter
# would silently become the same variable - see tests/test_symbols.py).
IDENTIFIERS: dict[str, str] = {
    name: unicodedata.normalize("NFKC", char) for name, char in SYMBOLS.items()
}

# \name followed by an optional identifier tail, e.g. \rho_0, \omega_max, \m_0, \i
SYMBOL_RE = re.compile(r"\\([A-Za-z]+)(\w*)")

# Optional string prefix + opening quote.
STRING_START_RE = re.compile(r"(?i)([rbuft]{0,2})('''|\"\"\"|'|\")")

# Check if preceding text ends with a numeric literal (int or float)
NUMERIC_END_RE = re.compile(r"(?:^|[^\w.])(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*$")


def resolve_symbol(name: str, tail: str, src: str, i: int) -> str:
    """Resolve \\name tail to its Python equivalent.

    - \\i -> '1j' (or '* 1j' if immediately preceded by a number literal, e.g. 2\\i -> 2* 1j)
    - \\rho_0 -> 'ρ_0' (known Greek letters and special symbols from symbols.json)
    - \\m_0, \\m_e, \\v_max -> 'm_0', 'm_e', 'v_max' (Latin variables with subscripts)
    """
    if name == "i" and not tail:
        if NUMERIC_END_RE.search(src[:i]):
            return "* 1j"
        return "1j"
    if name in IDENTIFIERS:
        return IDENTIFIERS[name] + tail
    if tail.startswith("_"):
        return f"{name}{tail}"
    raise TranspileError(f"unknown symbol \\{name}", *position(src, i))


def _scan_string(src: str, i: int, quote: str, is_fstring: bool, out: list[str]) -> int:
    """Append string body starting at ``i`` to ``out`` and return index past closing quote."""
    n = len(src)
    brace_depth = 0
    while i < n:
        c = src[i]
        if brace_depth == 0 and src.startswith(quote, i):
            out.append(quote)
            return i + len(quote)
        if len(quote) == 1 and c == "\n" and brace_depth == 0:
            return i
        if is_fstring:
            if c == "{":
                if i + 1 < n and src[i + 1] == "{":
                    out.append("{{")
                    i += 2
                    continue
                brace_depth += 1
                out.append(c)
                i += 1
                continue
            if c == "}" and brace_depth > 0:
                brace_depth -= 1
                out.append(c)
                i += 1
                continue
            if brace_depth > 0 and c == "\\":
                m = SYMBOL_RE.match(src, i)
                if m:
                    name, tail = m.groups()
                    out.append(resolve_symbol(name, tail, src, i))
                    i = m.end()
                    continue
        if c == "\\":
            out.append(src[i : i + 2])
            i += 2
            continue
        out.append(c)
        i += 1
    return n


def rewrite_symbols(src: str) -> str:
    out: list[str] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]

        if c == "#":
            end = src.find("\n", i)
            end = n if end == -1 else end
            out.append(src[i:end])
            i = end
            continue

        if c in "'\"" or c.isalpha():
            prev_is_ident = i > 0 and (src[i - 1].isalnum() or src[i - 1] == "_")
            m = None if prev_is_ident else STRING_START_RE.match(src, i)
            if m:
                prefix, quote = m.groups()
                out.append(m.group(0))
                is_fstring = "f" in prefix.lower() and "r" not in prefix.lower()
                i = _scan_string(src, m.end(), quote, is_fstring, out)
                continue

        if c == "\\":
            m = SYMBOL_RE.match(src, i)
            if m:
                name, tail = m.groups()
                out.append(resolve_symbol(name, tail, src, i))
                i = m.end()
                continue

        out.append(c)
        i += 1
    return "".join(out)
