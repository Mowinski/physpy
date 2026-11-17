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
from .units import CONST_FN, PHYSICAL_CONSTANTS

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

# Accent commands -> Unicode combining marks (valid Python identifier characters).
ACCENTS: dict[str, str] = {
    "bar": "\u0304",
    "overline": "\u0304",
    "hat": "\u0302",
    "vec": "\u20d7",
    "dot": "\u0307",
    "ddot": "\u0308",
    "tilde": "\u0303",
    "prime": "\u02b9",
    "dprime": "\u02ba",
}

_ACCENT_ALT = "|".join(ACCENTS)
_ACCENT_CALL = rf"\\({_ACCENT_ALT})\{{((?:\\[A-Za-z]+\w*|[A-Za-z_]\w*))\}}"
_ACCENT_CALL_NONCAP = rf"\\(?:{_ACCENT_ALT})\{{(?:\\[A-Za-z]+\w*|[A-Za-z_]\w*)\}}"
_ACCENT_CALL_RE = re.compile(_ACCENT_CALL)
_PLAIN_SYMBOL_RE = re.compile(r"\\([A-Za-z]+)(\w*)")
_CONST_CALL_RE = re.compile(r"\\const\{([A-Za-z0-9_]+)\}")
_TAIL_PATTERN = rf"(?:_{_ACCENT_CALL_NONCAP}|[A-Za-z0-9]|_(?!\\))*"

# \name tail or \accent{inner} tail, e.g. \rho_0, \bar{u}, \bar{u}_a, \u_\bar{t}
SYMBOL_RE = re.compile(
    rf"\\(?:({_ACCENT_ALT})\{{((?:\\[A-Za-z]+\w*|[A-Za-z_]\w*))\}}|([A-Za-z]+))({_TAIL_PATTERN})"
)

# Optional string prefix + opening quote.
STRING_START_RE = re.compile(r"(?i)([rbuft]{0,2})('''|\"\"\"|'|\")")

# Check if preceding text ends with a numeric literal (int or float)
NUMERIC_END_RE = re.compile(r"(?:^|[^\w.])(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*$")


def _resolve_tail(tail: str, src: str, i: int) -> str:
    if "\\" not in tail:
        return tail
    return _ACCENT_CALL_RE.sub(
        lambda m: resolve_accent_symbol(m.group(1), m.group(2), "", src, i),
        tail,
    )


def resolve_symbol(name: str, tail: str, src: str, i: int) -> str:
    """Resolve \\name tail to its Python equivalent.

    - \\i -> '1j' (or '* 1j' if immediately preceded by a number literal, e.g. 2\\i -> 2* 1j)
    - \\rho_0 -> 'ρ_0' (known Greek letters and special symbols from symbols.json)
    - \\m_0, \\m_e, \\v_max -> 'm_0', 'm_e', 'v_max' (Latin variables with subscripts)
    - \\u_\\bar{t} -> 'u_t̄' (subscript with LaTeX accent)
    """
    if name == "i" and not tail:
        if NUMERIC_END_RE.search(src[:i]):
            return "* 1j"
        return "1j"
    resolved_tail = _resolve_tail(tail, src, i)
    if name in IDENTIFIERS:
        return unicodedata.normalize("NFKC", IDENTIFIERS[name] + resolved_tail)
    if tail.startswith("_"):
        return unicodedata.normalize("NFKC", f"{name}{resolved_tail}")
    raise TranspileError(f"unknown symbol \\{name}", *position(src, i))


def resolve_accent_symbol(accent: str, inner: str, tail: str, src: str, i: int) -> str:
    """Resolve \\accent{inner}tail (e.g. \\bar{u}_a, \\hat{\\theta}) to a Python identifier."""
    if inner.startswith("\\"):
        m_inner = _PLAIN_SYMBOL_RE.fullmatch(inner)
        if not m_inner:
            raise TranspileError(f"invalid symbol {inner}", *position(src, i))
        inner_name, inner_tail = m_inner.groups()
        if inner_name == "i" and not inner_tail:
            raise TranspileError(f"cannot apply \\{accent} to imaginary unit \\i", *position(src, i))
        if inner_name in IDENTIFIERS:
            base = IDENTIFIERS[inner_name] + inner_tail
        elif inner_tail.startswith("_"):
            base = f"{inner_name}{inner_tail}"
        else:
            raise TranspileError(f"unknown symbol \\{inner_name}", *position(src, i))
    else:
        base = inner
    resolved_tail = _resolve_tail(tail, src, i)
    return unicodedata.normalize("NFKC", base + ACCENTS[accent] + resolved_tail)


def _resolve_match(m: re.Match[str], src: str, i: int) -> str:
    accent, inner, name, tail = m.groups()
    if accent is not None:
        return resolve_accent_symbol(accent, inner, tail, src, i)
    return resolve_symbol(name, tail, src, i)


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
                m_const = _CONST_CALL_RE.match(src, i)
                if m_const:
                    cname = m_const.group(1)
                    if cname not in PHYSICAL_CONSTANTS:
                        raise TranspileError(f"unknown physical constant \\const{{{cname}}}", *position(src, i))
                    out.append(f"{CONST_FN}({cname!r})")
                    i = m_const.end()
                    continue
                m = SYMBOL_RE.match(src, i)
                if m:
                    out.append(_resolve_match(m, src, i))
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
            m_const = _CONST_CALL_RE.match(src, i)
            if m_const:
                cname = m_const.group(1)
                if cname not in PHYSICAL_CONSTANTS:
                    raise TranspileError(f"unknown physical constant \\const{{{cname}}}", *position(src, i))
                out.append(f"{CONST_FN}({cname!r})")
                i = m_const.end()
                continue
            m = SYMBOL_RE.match(src, i)
            if m:
                out.append(_resolve_match(m, src, i))
                i = m.end()
                continue

        out.append(c)
        i += 1
    return "".join(out)
