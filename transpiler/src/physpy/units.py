"""Physical units via ``pint``: ``1000.0 [kg/m^3]`` -> ``__physpy_unit__(1000.0, 'kg/m^3')``.

In standard Python, a numeric literal cannot be subscripted (``1000.0[...]`` is
always a ``TypeError``), so ``NUMBER [unit]`` on the same line is completely
unambiguous and never collides with list/dict/array indexing (``arr[i]``).
"""

from __future__ import annotations

import builtins
import io
import json
import math
import os
import re
import sys
import tokenize
from importlib import resources
from pathlib import Path
from typing import Any

UNIT_FN = "__physpy_unit__"
CONVERT_FN = "__physpy_convert__"
CONST_FN = "__physpy_const__"

PHYSICAL_CONSTANTS: dict[str, dict[str, Any]] = json.loads(
    resources.files(__package__).joinpath("physical_constants.json").read_text(encoding="utf-8")
)

_CONSTANT_OVERRIDES: dict[str, float] = {}

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


def convert_quantity(value: Any, unit_str: str) -> Any:
    """Convert ``value`` to ``unit_str`` (or attach ``unit_str`` if plain scalar/array)."""
    normalized = _MICRO_SPACE_RE.sub(r"μ\1", unit_str.strip())
    if hasattr(value, "to"):
        return value.to(normalized)
    return get_ureg().Quantity(value, normalized)


def set_constant_overrides(overrides: dict[str, Any] | None) -> dict[str, float]:
    """Set session-wide numeric overrides for built-in physical constants."""
    _CONSTANT_OVERRIDES.clear()
    if not overrides:
        return {}
    for name, raw_val in overrides.items():
        if name not in PHYSICAL_CONSTANTS:
            continue
        if isinstance(raw_val, bool):
            continue
        try:
            val = float(raw_val)
        except (TypeError, ValueError):
            continue
        if math.isfinite(val):
            _CONSTANT_OVERRIDES[name] = val
    return dict(_CONSTANT_OVERRIDES)


def get_constant_overrides() -> dict[str, float]:
    """Return a copy of active physical constant overrides."""
    return dict(_CONSTANT_OVERRIDES)


def get_effective_constant_value(name: str) -> float:
    """Return the active numeric value (override or default) for a physical constant."""
    if name not in PHYSICAL_CONSTANTS:
        raise KeyError(f"unknown physical constant: {name}")
    if name in _CONSTANT_OVERRIDES:
        return _CONSTANT_OVERRIDES[name]
    return float(PHYSICAL_CONSTANTS[name]["value"])


def _parse_constants_from_yaml(text: str) -> dict[str, float]:
    """Extract ``constants:`` section entries from a PhysPy YAML config string."""
    out: dict[str, float] = {}
    in_constants = False
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip())
        if indent == 0:
            in_constants = False
        if ":" not in stripped:
            continue
        key, val_raw = stripped.split(":", 1)
        key = key.strip()
        val_clean = val_raw.split("#", 1)[0].strip()
        if indent == 0:
            if key == "constants" and not val_clean:
                in_constants = True
            continue
        if in_constants and key in PHYSICAL_CONSTANTS:
            unquoted = val_clean.strip("\"'")
            try:
                num = float(unquoted)
            except ValueError:
                continue
            if math.isfinite(num):
                out[key] = num
    return out


def load_constant_overrides_from_config(workspace_dir: str | None = None) -> dict[str, float]:
    """Load hierarchical constant overrides from global and workspace YAML configs."""
    merged: dict[str, float] = {}
    home = Path.home()
    global_cfg = home / ".physpy" / "config.yaml"
    if global_cfg.is_file():
        try:
            merged.update(_parse_constants_from_yaml(global_cfg.read_text(encoding="utf-8")))
        except OSError:
            pass
    if workspace_dir:
        ws_path = Path(workspace_dir)
        for fname in (".physpy-config.yaml", ".physpy-config.yml"):
            ws_cfg = ws_path / fname
            if ws_cfg.is_file():
                try:
                    merged.update(_parse_constants_from_yaml(ws_cfg.read_text(encoding="utf-8")))
                except OSError:
                    pass
                break
    return merged


def get_physical_constant(name: str) -> Any:
    """Return a ``pint.Quantity`` for a built-in physical constant from ``physical_constants.json``."""
    entry = PHYSICAL_CONSTANTS.get(name)
    if entry is None:
        raise KeyError(f"unknown physical constant: {name}")
    value = _CONSTANT_OVERRIDES.get(name, entry["value"])
    return make_quantity(value, entry["unit"])


# Make `__physpy_unit__`, `__physpy_convert__`, and `__physpy_const__` available in builtins.
setattr(builtins, UNIT_FN, make_quantity)
setattr(builtins, CONVERT_FN, convert_quantity)
setattr(builtins, CONST_FN, get_physical_constant)


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

    if edits:
        for row, c1, c2, replacement in reversed(edits):
            lines[row - 1] = lines[row - 1][:c1] + replacement + lines[row - 1][c2:]
        src = "".join(lines)

    return _rewrite_unit_conversions(src)


def _find_postfix_start(toks: list[tokenize.TokenInfo], arrow_idx: int, row: int) -> tuple[int, int] | None:
    """Return start (row, col) of the postfix expression immediately before ``->`` on ``row``."""
    k = arrow_idx - 1
    while k >= 0 and toks[k].type in (tokenize.NL, tokenize.NEWLINE):
        k -= 1
    if k < 0 or toks[k].start[0] != row:
        return None

    while k >= 0 and toks[k].start[0] == row:
        t = toks[k]
        if t.type == tokenize.OP and t.string in (")", "]"):
            close_ch = t.string
            open_ch = "(" if close_ch == ")" else "["
            depth = 1
            k -= 1
            while k >= 0 and depth > 0:
                if toks[k].type == tokenize.OP:
                    if toks[k].string == close_ch:
                        depth += 1
                    elif toks[k].string == open_ch:
                        depth -= 1
                k -= 1
            if depth != 0:
                return None
            # If preceded by a NAME or `.` on the same row, continue to include `fn(...)` / `obj.fn(...)`
            if k >= 0 and toks[k].start[0] == row and toks[k].type == tokenize.NAME:
                continue
            start_idx = k + 1
            return toks[start_idx].start if toks[start_idx].start[0] == row else None
        if t.type == tokenize.NAME:
            if k >= 2 and toks[k - 1].type == tokenize.OP and toks[k - 1].string == "." and toks[k - 2].start[0] == row:
                k -= 2
                continue
            return t.start
        if t.type == tokenize.NUMBER:
            return _find_value_start(toks, k)
        return None
    return None


def _rewrite_unit_conversions(src: str) -> str:
    """Rewrite ``expr -> [unit]`` on a single line into ``__physpy_convert__(expr, 'unit')``."""
    if "->" not in src or "[" not in src:
        return src

    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    lines = src.splitlines(keepends=True)
    edits: list[tuple[int, int, int, str]] = []

    i = 0
    n = len(toks)
    while i < n:
        tok = toks[i]
        if (
            tok.type == tokenize.OP
            and tok.string == "->"
            and i + 1 < n
            and toks[i + 1].type == tokenize.OP
            and toks[i + 1].string == "["
            and toks[i + 1].start[0] == tok.end[0]
        ):
            row = tok.end[0]
            lbracket = toks[i + 1]
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
                lhs_start = _find_postfix_start(toks, i, row)
                if lhs_start is not None:
                    line_str = lines[row - 1]
                    unit_raw = line_str[lbracket.end[1] : rbracket.start[1]].strip()
                    lhs_raw = line_str[lhs_start[1] : tok.start[1]].strip()
                    if unit_raw and lhs_raw:
                        replacement = f"{CONVERT_FN}({lhs_raw}, {unit_raw!r})"
                        edits.append((row, lhs_start[1], rbracket.end[1], replacement))
                        i = j + 1
                        continue
        i += 1

    if not edits:
        return src

    for row, c1, c2, replacement in reversed(edits):
        lines[row - 1] = lines[row - 1][:c1] + replacement + lines[row - 1][c2:]
    return "".join(lines)
