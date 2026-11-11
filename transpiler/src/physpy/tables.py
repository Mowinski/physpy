"""Table command and structured DataFrame / Series extraction for PhysPy.

Supports:
- ``table df`` / ``table df.head()`` (rewritten at statement start like ``plot ...``)
- Automatic extraction for ``pandas.DataFrame`` / ``pandas.Series`` passed to
  ``print(...)``, ``display(...)``, ``disp(...)``, or evaluated as a cell's final expression.
"""

from __future__ import annotations

import math
import sys
from typing import Any

from .plotting import rewrite_stmt_command

TABLE_KW = "table"
TABLE_FN = "__physpy_table__"
MAX_TABLE_ROWS = 500


def rewrite_tables(src: str) -> str:
    """Rewrite statement-level ``table <expr>`` into ``__physpy_table__(<expr>)``."""
    return rewrite_stmt_command(src, TABLE_KW, TABLE_FN)


def is_tabular_object(val: Any) -> bool:
    """Return True when ``val`` is a loaded ``pandas.DataFrame`` or ``pandas.Series``."""
    pd = sys.modules.get("pandas")
    if pd is None:
        return False
    return isinstance(val, (pd.DataFrame, pd.Series))


def _format_unit(unit: Any) -> str | None:
    if unit is None:
        return None
    try:
        rendered = f"{unit:~P}".strip()
        if not rendered or rendered == "dimensionless":
            return None
        return rendered
    except Exception:
        s = str(unit).strip()
        return None if not s or s == "dimensionless" else s


def _is_quantity(val: Any) -> bool:
    return hasattr(val, "_REGISTRY") and hasattr(val, "magnitude") and hasattr(val, "units")


def _is_na(val: Any, pd: Any) -> bool:
    if val is None:
        return True
    try:
        res = pd.isna(val)
        return bool(res) if isinstance(res, (bool,)) or not hasattr(res, "__len__") else False
    except Exception:
        return False


def _format_scalar(val: Any, pd: Any) -> str:
    if _is_na(val, pd):
        return "NaN"
    if isinstance(val, bool):
        return str(val)
    if isinstance(val, int):
        return str(val)
    if isinstance(val, float) or type(val).__module__ == "numpy" and getattr(type(val), "__name__", "").startswith(("float", "int", "uint")):
        try:
            fval = float(val)
            if math.isnan(fval):
                return "NaN"
            if math.isinf(fval):
                return "inf" if fval > 0 else "-inf"
            if isinstance(val, int) or getattr(type(val), "__name__", "").startswith(("int", "uint")):
                return str(int(val))
            return f"{fval:.12g}"
        except Exception:
            return str(val)
    if _is_quantity(val):
        try:
            return f"{val:~P}"
        except Exception:
            return str(val)
    return str(val)


def _infer_object_unit(values: list[Any], pd: Any) -> Any | None:
    first_unit: Any | None = None
    for v in values:
        if _is_na(v, pd):
            continue
        if not _is_quantity(v):
            return None
        if first_unit is None:
            first_unit = v.units
        elif v.units != first_unit:
            return None
    return first_unit


def _col_is_numeric(ser: Any, pd: Any, has_unit: bool) -> bool:
    if has_unit:
        return True
    try:
        if pd.api.types.is_numeric_dtype(ser.dtype):
            return True
    except Exception:
        pass
    return False


def extract_table_data(val: Any, max_rows: int = MAX_TABLE_ROWS) -> dict[str, Any]:
    """Serialize a ``pandas.DataFrame`` / ``pandas.Series`` (or list of dicts) into table JSON."""
    pd = sys.modules.get("pandas")
    if pd is None:
        try:
            import pandas as pd  # type: ignore[no-redef]
        except ImportError as exc:
            raise TypeError(f"table requires pandas, got {type(val).__name__}") from exc

    if isinstance(val, pd.Series):
        col_name = val.name if val.name is not None else "value"
        df = val.to_frame(name=col_name)
        raw_text = str(val)
    elif isinstance(val, pd.DataFrame):
        df = val
        raw_text = str(val)
    elif isinstance(val, (list, tuple)) and (len(val) == 0 or isinstance(val[0], dict)):
        df = pd.DataFrame(val)
        raw_text = str(df)
    else:
        raise TypeError(f"table expected a pandas DataFrame or Series, got {type(val).__name__}")

    total_rows = len(df)
    truncated = total_rows > max_rows
    df_view = df.iloc[:max_rows] if truncated else df

    if hasattr(df_view.index, "names") and len(df_view.index.names) > 1:
        index_name = ", ".join("" if n is None else str(n) for n in df_view.index.names)
    else:
        index_name = "" if df_view.index.name is None else str(df_view.index.name)

    columns_meta: list[dict[str, Any]] = []
    col_cells: list[list[str]] = []

    for col_idx, col_label in enumerate(df_view.columns):
        ser = df_view.iloc[:, col_idx]
        name_str = " / ".join(str(part) for part in col_label) if isinstance(col_label, tuple) else str(col_label)

        raw_vals = list(ser)
        dtype_unit = getattr(ser.dtype, "units", None)
        shared_unit = dtype_unit if dtype_unit is not None else _infer_object_unit(raw_vals, pd)
        unit_str = _format_unit(shared_unit)
        is_numeric = _col_is_numeric(ser, pd, shared_unit is not None)

        formatted_col: list[str] = []
        for item in raw_vals:
            if shared_unit is not None and _is_quantity(item):
                formatted_col.append(_format_scalar(item.magnitude, pd))
            else:
                formatted_col.append(_format_scalar(item, pd))

        columns_meta.append(
            {
                "name": name_str,
                "unit": unit_str,
                "is_numeric": is_numeric,
            }
        )
        col_cells.append(formatted_col)

    rows_out: list[dict[str, Any]] = []
    for row_pos in range(len(df_view)):
        idx_val = df_view.index[row_pos]
        idx_str = ", ".join(str(x) for x in idx_val) if isinstance(idx_val, tuple) else str(idx_val)
        rows_out.append(
            {
                "index": idx_str,
                "cells": [col_cells[col_pos][row_pos] for col_pos in range(len(columns_meta))],
            }
        )

    return {
        "index_name": index_name,
        "columns": columns_meta,
        "rows": rows_out,
        "total_rows": total_rows,
        "truncated": truncated,
        "raw_text": raw_text,
    }
