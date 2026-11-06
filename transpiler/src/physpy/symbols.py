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

# \name followed by an optional identifier tail, e.g. \rho_0, \omega_max
SYMBOL_RE = re.compile(r"\\([A-Za-z]+)(\w*)")

# Optional string prefix + opening quote.
STRING_START_RE = re.compile(r"(?i)(?:rb|br|fr|rf|tr|rt|[rbuft])?('''|\"\"\"|'|\")")


def _skip_string(src: str, i: int, quote: str) -> int:
    """Return the index just past the string whose body starts at ``i``."""
    n = len(src)
    while i < n:
        c = src[i]
        if c == "\\":  # escapes (also in raw strings, for tokenization purposes)
            i += 2
            continue
        if src.startswith(quote, i):
            return i + len(quote)
        if len(quote) == 1 and c == "\n":  # unterminated - let Python report it
            return i
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
                end = _skip_string(src, m.end(), m.group(1))
                out.append(src[i:end])
                i = end
                continue

        if c == "\\":
            m = SYMBOL_RE.match(src, i)
            if m:
                name, tail = m.groups()
                if name not in IDENTIFIERS:
                    raise TranspileError(f"unknown symbol \\{name}", *position(src, i))
                out.append(IDENTIFIERS[name] + tail)
                i = m.end()
                continue

        out.append(c)
        i += 1
    return "".join(out)
