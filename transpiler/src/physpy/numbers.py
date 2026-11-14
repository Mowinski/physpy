"""Source pass: space-separated thousands/fractional digit groups in numbers.

Allows SI-style space grouping in numeric literals, e.g.:
``3 012 123.123 423`` -> ``3012123.123423``
``6.022 140 76e23`` -> ``6.02214076e23``

Runs before tokenization (right after ``rewrite_symbols``) so groups with
leading zeros like ``1 005`` or ``1.005 002`` are collapsed before Python's
``tokenize`` sees them. Strings and comments are left untouched (except
expressions inside f-string ``{...}``). Line numbers are preserved.
"""

from __future__ import annotations

import re

_STRING_START_RE = re.compile(r"(?i)([rbuft]{0,2})('''|\"\"\"|'|\")")

# Group of digits with optional underscores, not followed by a non-exp/non-j letter
# (prevents merging e.g. `1 0x10` or `1 2foo`).
_GROUP = r"\d+(?:_\d+)*(?![A-DF-IK-Za-df-ik-z])"
_SPACE_GROUP = rf"[ \t]+{_GROUP}"

_NUMBER_RE = re.compile(
    rf"(?:"
    rf"\d+(?:_\d+)*(?:{_SPACE_GROUP})*(?:\.(?:\d+(?:_\d+)*(?:{_SPACE_GROUP})*)?)?(?:[eE][+-]?\d+(?:_\d+)*)?"
    rf"|\.\d+(?:_\d+)*(?:{_SPACE_GROUP})*(?:[eE][+-]?\d+(?:_\d+)*)?"
    rf")"
)


def _collapse_number_spaces(num_str: str) -> str:
    return num_str.replace(" ", "").replace("\t", "")


def _scan_string(src: str, i: int, quote: str, is_fstring: bool, out: list[str]) -> int:
    """Copy string literal starting at ``i`` (past opening quote) into ``out``."""
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
            if brace_depth > 0 and (c.isdigit() or c == "."):
                prev = src[i - 1] if i > 0 else ""
                if not (prev.isalnum() or prev in ("_", ".")):
                    m = _NUMBER_RE.match(src, i)
                    if m:
                        out.append(_collapse_number_spaces(m.group(0)))
                        i = m.end()
                        continue
        if c == "\\":
            out.append(src[i : i + 2])
            i += 2
            continue
        out.append(c)
        i += 1
    return n


def rewrite_number_spaces(src: str) -> str:
    """Collapse spaces/tabs between digit groups in numeric literals."""
    if " " not in src and "\t" not in src:
        return src

    out: list[str] = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c == "#":
            end = src.find("\n", i)
            end = n if end == -1 else end
            out.append(src[i:end])
            i = end
            continue

        m_str = _STRING_START_RE.match(src, i)
        if m_str:
            prefix, quote = m_str.groups()
            out.append(prefix + quote)
            i = _scan_string(src, m_str.end(), quote, "f" in prefix.lower(), out)
            continue

        if c.isdigit() or (c == "." and i + 1 < n and src[i + 1].isdigit()):
            prev = src[i - 1] if i > 0 else ""
            if not (prev.isalnum() or prev in ("_", ".")):
                m = _NUMBER_RE.match(src, i)
                if m:
                    out.append(_collapse_number_spaces(m.group(0)))
                    i = m.end()
                    continue

        out.append(c)
        i += 1

    return "".join(out)
