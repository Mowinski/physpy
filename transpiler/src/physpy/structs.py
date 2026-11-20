"""PhysPy ``struct`` syntax and ``Pomiar`` (value + uncertainty) type.

- ``struct WynikiPret:`` -> ``class WynikiPret(__physpy_struct__(...)):`` (auto ``@dataclass``,
  fields without defaults get ``= None``, and ``field: [unit]`` annotations auto-convert
  assigned values to that Pint unit).
- ``Pomiar(val, u)`` -> value + uncertainty object with unit conversion (``.to(...)`` / ``-> [unit]``),
  Gaussian error propagation, and clean formatting.
"""

from __future__ import annotations

import builtins
import dataclasses
import math
import re
from typing import Any

from .units import convert_quantity, make_quantity

STRUCT_FN = "__physpy_struct__"
POMIAR_NAME = "Pomiar"

_STRUCT_HEADER_RE = re.compile(
    r"^([ \t]*)(export[ \t]+)?struct[ \t]+([A-Za-z_]\w*)(?:\(([^)]*)\))?[ \t]*:[ \t]*(#.*)?$"
)
_FIELD_UNIT_RE = re.compile(
    r"^([ \t]*)([A-Za-z_]\w*)[ \t]*:[ \t]*\[([^[\]\n]+)\](?:[ \t]*=[ \t]*(.+?))?[ \t]*(#.*)?$"
)
_FIELD_TYPED_RE = re.compile(
    r"^([ \t]*)([A-Za-z_]\w*)[ \t]*:[ \t]*([^=\n#]+?)[ \t]*(#.*)?$"
)
_FIELD_BARE_RE = re.compile(
    r"^([ \t]*)([A-Za-z_]\w*)[ \t]*(#.*)?$"
)


def _is_quantity(val: Any) -> bool:
    return hasattr(val, "_REGISTRY") and hasattr(val, "magnitude") and hasattr(val, "units")


def _fmt_num(x: float) -> str:
    if not math.isfinite(x):
        return str(x)
    return f"{x:.6g}"


class Pomiar:
    """Physical measurement combining a value, uncertainty, and optional Pint unit."""

    def __init__(self, val: Any, u: Any = 0.0, unit: str | None = None) -> None:
        if unit is not None and not _is_quantity(val):
            val = make_quantity(val, unit)

        if _is_quantity(val):
            if _is_quantity(u):
                u = u.to(val.units)
            else:
                u = val._REGISTRY.Quantity(float(u), val.units)
        elif _is_quantity(u):
            val = u._REGISTRY.Quantity(float(val), u.units)

        self.val = val
        self.u = u

    @property
    def value(self) -> Any:
        return self.val

    @property
    def uncertainty(self) -> Any:
        return self.u

    @property
    def units(self) -> Any:
        return self.val.units if _is_quantity(self.val) else None

    @property
    def rel(self) -> float:
        """Relative uncertainty in percent (%)."""
        v_mag = float(self.val.magnitude) if _is_quantity(self.val) else float(self.val)
        u_mag = float(self.u.magnitude) if _is_quantity(self.u) else float(self.u)
        if v_mag == 0:
            return float("inf") if u_mag != 0 else 0.0
        return abs(u_mag / v_mag) * 100.0

    def to(self, unit_str: str) -> Pomiar:
        """Convert both value and uncertainty to ``unit_str``."""
        if _is_quantity(self.val):
            return Pomiar(self.val.to(unit_str), self.u.to(unit_str))
        return Pomiar(make_quantity(self.val, unit_str), make_quantity(self.u, unit_str))

    def _parts(self) -> tuple[float, float, str]:
        if _is_quantity(self.val):
            v = float(self.val.magnitude)
            u = float(self.u.to(self.val.units).magnitude)
            unit_s = f"{self.val.units:~P}".strip()
            if unit_s == "dimensionless":
                unit_s = ""
            return v, u, unit_s
        return float(self.val), float(self.u), ""

    def __add__(self, other: Any) -> Pomiar:
        if isinstance(other, Pomiar):
            v = self.val + other.val
            u1 = self.u.to(v.units) if _is_quantity(v) else self.u
            u2 = other.u.to(v.units) if _is_quantity(v) else other.u
            return Pomiar(v, (u1**2 + u2**2) ** 0.5)
        return Pomiar(self.val + other, self.u)

    def __radd__(self, other: Any) -> Pomiar:
        return self.__add__(other)

    def __sub__(self, other: Any) -> Pomiar:
        if isinstance(other, Pomiar):
            v = self.val - other.val
            u1 = self.u.to(v.units) if _is_quantity(v) else self.u
            u2 = other.u.to(v.units) if _is_quantity(v) else other.u
            return Pomiar(v, (u1**2 + u2**2) ** 0.5)
        return Pomiar(self.val - other, self.u)

    def __rsub__(self, other: Any) -> Pomiar:
        return Pomiar(other - self.val, self.u)

    def __mul__(self, other: Any) -> Pomiar:
        if isinstance(other, Pomiar):
            v = self.val * other.val
            rel1 = (self.u / self.val) ** 2
            rel2 = (other.u / other.val) ** 2
            return Pomiar(v, abs(v) * (rel1 + rel2) ** 0.5)
        return Pomiar(self.val * other, abs(other) * self.u)

    def __rmul__(self, other: Any) -> Pomiar:
        return self.__mul__(other)

    def __truediv__(self, other: Any) -> Pomiar:
        if isinstance(other, Pomiar):
            v = self.val / other.val
            rel1 = (self.u / self.val) ** 2
            rel2 = (other.u / other.val) ** 2
            return Pomiar(v, abs(v) * (rel1 + rel2) ** 0.5)
        return Pomiar(self.val / other, self.u / abs(other))

    def __neg__(self) -> Pomiar:
        return Pomiar(-self.val, self.u)

    def __eq__(self, other: Any) -> bool:
        if not isinstance(other, Pomiar):
            return False
        return bool(self.val == other.val and self.u == other.u)

    def __str__(self) -> str:
        v, u, unit_s = self._parts()
        core = f"{_fmt_num(v)} ± {_fmt_num(u)}"
        return f"{core} {unit_s}" if unit_s else core

    def __repr__(self) -> str:
        return str(self)


class _StructBase:
    __physpy_units__: dict[str, str] = {}

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        dataclasses.dataclass(cls)

    def __post_init__(self) -> None:
        units_map = getattr(type(self), "__physpy_units__", {})
        for fname, unit_str in units_map.items():
            val = getattr(self, fname, None)
            if val is not None:
                object.__setattr__(self, fname, convert_quantity(val, unit_str))

    def __setattr__(self, name: str, value: Any) -> None:
        units_map = getattr(type(self), "__physpy_units__", {})
        if value is not None and name in units_map:
            value = convert_quantity(value, units_map[name])
        super().__setattr__(name, value)


def make_struct_base(units_map: dict[str, str] | None = None) -> type[_StructBase]:
    if not units_map:
        return _StructBase
    return type("_PhysPyStructBase", (_StructBase,), {"__physpy_units__": dict(units_map)})


setattr(builtins, STRUCT_FN, make_struct_base)
setattr(builtins, POMIAR_NAME, Pomiar)


def _split_comment_outside_strings(line: str) -> tuple[str, str]:
    quote: str | None = None
    i = 0
    while i < len(line):
        ch = line[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        else:
            if ch in ("'", '"'):
                quote = ch
            elif ch == "#":
                return line[:i], line[i:]
        i += 1
    return line, ""


def rewrite_structs(src: str) -> str:
    """Rewrite ``struct Name:`` blocks into ``@dataclass`` classes with ``None`` defaults."""
    if "struct" not in src:
        return src

    lines = src.splitlines(keepends=True)
    n = len(lines)
    i = 0
    out: list[str] = []

    while i < n:
        line = lines[i]
        raw_no_nl = line.rstrip("\r\n")
        nl = line[len(raw_no_nl) :]
        m_hdr = _STRUCT_HEADER_RE.match(raw_no_nl)
        if not m_hdr:
            out.append(line)
            i += 1
            continue

        indent, export_kw, struct_name, orig_bases, hdr_comment = m_hdr.groups()
        export_kw = export_kw or ""
        hdr_comment = f"  {hdr_comment}" if hdr_comment else ""
        base_indent_len = len(indent)
        header_out_idx = len(out)
        out.append("")  # placeholder for rewritten class header
        i += 1

        unit_fields: dict[str, str] = {}
        body_indent_len: int | None = None

        while i < n:
            bline = lines[i]
            b_no_nl = bline.rstrip("\r\n")
            b_nl = bline[len(b_no_nl) :]
            stripped = b_no_nl.strip()

            if not stripped or stripped.startswith("#"):
                out.append(bline)
                i += 1
                continue

            cur_indent_len = len(b_no_nl) - len(b_no_nl.lstrip(" \t"))
            if cur_indent_len <= base_indent_len:
                break

            if body_indent_len is None:
                body_indent_len = cur_indent_len

            # Only rewrite top-level fields of the struct body (skip nested defs/methods)
            if cur_indent_len == body_indent_len and not stripped.startswith(
                ("def ", "async def ", "class ", "@", "pass", '"""', "'''")
            ):
                code_part, comment_part = _split_comment_outside_strings(b_no_nl)
                comment_suffix = f"  {comment_part.strip()}" if comment_part else ""

                m_unit = _FIELD_UNIT_RE.match(code_part)
                if m_unit:
                    f_ind, fname, unit_str, default_val, _ = m_unit.groups()
                    unit_fields[fname] = unit_str.strip()
                    default_expr = default_val.strip() if default_val else "None"
                    out.append(f"{f_ind}{fname}: object = {default_expr}{comment_suffix}{b_nl}")
                    i += 1
                    continue

                if "=" not in code_part:
                    m_typed = _FIELD_TYPED_RE.match(code_part)
                    if m_typed:
                        f_ind, fname, ftype, _ = m_typed.groups()
                        ftype_s = ftype.strip()
                        if "| None" not in ftype_s and "Optional" not in ftype_s:
                            ftype_s = f"{ftype_s} | None"
                        out.append(f"{f_ind}{fname}: {ftype_s} = None{comment_suffix}{b_nl}")
                        i += 1
                        continue

                    m_bare = _FIELD_BARE_RE.match(code_part)
                    if m_bare:
                        f_ind, fname, _ = m_bare.groups()
                        out.append(f"{f_ind}{fname}: object = None{comment_suffix}{b_nl}")
                        i += 1
                        continue

            out.append(bline)
            i += 1

        struct_call = f"{STRUCT_FN}({unit_fields!r})" if unit_fields else f"{STRUCT_FN}()"
        bases = f"{orig_bases.strip()}, {struct_call}" if orig_bases and orig_bases.strip() else struct_call
        out[header_out_idx] = f"{indent}{export_kw}class {struct_name}({bases}):{hdr_comment}{nl}"

    return "".join(out)
