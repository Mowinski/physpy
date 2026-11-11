"""Physical units via ``pint``: ``1000.0 [kg/m^3]`` -> ``__physpy_unit__(1000.0, 'kg/m^3')``.

In standard Python, a numeric literal cannot be subscripted (``1000.0[...]`` is
always a ``TypeError``), so ``NUMBER [unit]`` on the same line is completely
unambiguous and never collides with list/dict/array indexing (``arr[i]``).
"""

from __future__ import annotations

import builtins
import io
import re
import sys
import tokenize
from typing import Any

UNIT_FN = "__physpy_unit__"

_UREG: Any = None
_MICRO_SPACE_RE = re.compile(r"μ\s+([A-Za-zΩ]+)")


def _configure_ureg(ureg: Any) -> None:
    """Apply PhysPy defaults to a ``pint.UnitRegistry`` without replacing it."""
    ureg.autoconvert_offset_to_baseunit = True
    ureg.formatter.default_format = "~P"

    orig_fmt = ureg.formatter.format_quantity
    if not getattr(orig_fmt, "_physpy_wrapped", False):

        def _fmt_quantity(q: Any, qspec: str = "", **kwargs: Any) -> str:
            if qspec and not any(c in qspec for c in "~PDCLHX"):
                qspec = qspec + "~P"
            return orig_fmt(q, qspec, **kwargs)

        _fmt_quantity._physpy_wrapped = True  # type: ignore[attr-defined]
        ureg.formatter.format_quantity = _fmt_quantity

    try:
        ureg.setup_matplotlib(True)
    except Exception:
        pass


def _unwrap_ureg(reg: Any) -> Any:
    return reg.get() if callable(getattr(reg, "get", None)) else reg


def get_ureg() -> Any:
    """Return the shared session-wide ``pint.UnitRegistry`` aligned with pint / pint-pandas."""
    global _UREG
    import pint

    app_reg = pint.get_application_registry()
    ureg = _unwrap_ureg(app_reg)

    # If pint_pandas is loaded and PintType.ureg was pointed at a custom UnitRegistry,
    # follow it so PhysPy `[unit]` literals stay compatible with pint-pandas columns.
    pp = sys.modules.get("pint_pandas")
    if pp is not None:
        pp_ureg = getattr(getattr(pp, "PintType", None), "ureg", None)
        if pp_ureg is not None and pp_ureg is not app_reg:
            ureg = _unwrap_ureg(pp_ureg)

    if _UREG is not ureg:
        _configure_ureg(ureg)
        _UREG = ureg
    return _UREG


def reset_ureg() -> None:
    """Reset PhysPy, pint application registry, and pint-pandas cache on session reset."""
    global _UREG
    _UREG = None

    pint_mod = sys.modules.get("pint")
    if pint_mod is not None:
        try:
            pint_mod.set_application_registry(
                pint_mod.UnitRegistry(autoconvert_offset_to_baseunit=True)
            )
        except Exception:
            pass

    pp = sys.modules.get("pint_pandas")
    if pp is not None:
        pint_type = getattr(pp, "PintType", None)
        if pint_type is not None:
            if pint_mod is not None:
                try:
                    pint_type.ureg = pint_mod.get_application_registry()
                except Exception:
                    pass
            cache = getattr(pint_type, "_cache", None)
            if isinstance(cache, dict):
                cache.clear()


def make_quantity(value: Any, unit_str: str) -> Any:
    """Create a ``pint.Quantity`` from ``value`` and ``unit_str``."""
    normalized = _MICRO_SPACE_RE.sub(r"μ\1", unit_str.strip())
    return get_ureg().Quantity(value, normalized)


# Make `__physpy_unit__` available in builtins so any compiled `.ppy` module or test works.
setattr(builtins, UNIT_FN, make_quantity)


def _find_value_start(toks: list[tokenize.TokenInfo], num_idx: int) -> tuple[int, int]:
    """Return start (row, col) of the numeric value at ``num_idx``.

    Includes a leading ``NUMBER ^`` or ``NUMBER ^ -`` on the same line so that
    scientific powers like ``10^5 [Pa]`` or ``10^-3 [m]`` bind as ``(10**5) [Pa]``.
    """
    num_tok = toks[num_idx]
    line = num_tok.start[0]

    # Case 1: `10 ^ 5 [Pa]` or `10 ** 5 [Pa]`
    if (
        num_idx >= 2
        and toks[num_idx - 1].type == tokenize.OP
        and toks[num_idx - 1].string in ("^", "**")
        and toks[num_idx - 2].type == tokenize.NUMBER
        and toks[num_idx - 2].start[0] == line
    ):
        return toks[num_idx - 2].start

    # Case 2: `10 ^ -3 [m]` or `10 ** -3 [m]`
    if (
        num_idx >= 3
        and toks[num_idx - 1].type == tokenize.OP
        and toks[num_idx - 1].string in ("+", "-")
        and toks[num_idx - 2].type == tokenize.OP
        and toks[num_idx - 2].string in ("^", "**")
        and toks[num_idx - 3].type == tokenize.NUMBER
        and toks[num_idx - 3].start[0] == line
    ):
        return toks[num_idx - 3].start

    return num_tok.start


def rewrite_units(src: str) -> str:
    """Rewrite ``NUMBER [unit]`` on a single line into ``__physpy_unit__(NUMBER, 'unit')``."""
    if "[" not in src:
        return src

    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    lines = src.splitlines(keepends=True)
    edits: list[tuple[int, int, int, str]] = []  # (row_1based, start_col, end_col, replacement)

    i = 0
    n = len(toks)
    while i < n:
        tok = toks[i]
        if (
            tok.type == tokenize.NUMBER
            and i + 1 < n
            and toks[i + 1].type == tokenize.OP
            and toks[i + 1].string == "["
            and toks[i + 1].start[0] == tok.end[0]
        ):
            lbracket = toks[i + 1]
            row = tok.end[0]
            j = i + 2
            depth = 1
            rbracket: tokenize.TokenInfo | None = None
            while j < n:
                t = toks[j]
                if t.start[0] != row or t.type in (
                    tokenize.NEWLINE,
                    tokenize.NL,
                    tokenize.COMMENT,
                    tokenize.ENDMARKER,
                ):
                    break
                if t.type == tokenize.OP and t.string == "[":
                    depth += 1
                elif t.type == tokenize.OP and t.string == "]":
                    depth -= 1
                    if depth == 0:
                        rbracket = t
                        break
                j += 1

            if rbracket is not None:
                line_str = lines[row - 1]
                unit_raw = line_str[lbracket.end[1] : rbracket.start[1]].strip()
                if unit_raw:
                    val_start = _find_value_start(toks, i)
                    num_raw = line_str[val_start[1] : tok.end[1]]
                    replacement = f"{UNIT_FN}({num_raw}, {unit_raw!r})"
                    edits.append((row, val_start[1], rbracket.end[1], replacement))
                    i = j + 1
                    continue
        i += 1

    if not edits:
        return src

    for row, c1, c2, replacement in reversed(edits):
        lines[row - 1] = lines[row - 1][:c1] + replacement + lines[row - 1][c2:]
    return "".join(lines)
