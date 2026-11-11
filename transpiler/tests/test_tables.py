"""Tests for `table <expr>` rewriting and DataFrame/Series extraction."""

from __future__ import annotations

import sys
import types

import pint
import pytest

from physpy.notebook import NotebookSession
from physpy.tables import extract_table_data, rewrite_tables


def test_rewrite_tables_statement_and_safety():
    assert rewrite_tables("table df\n") == "__physpy_table__(df)\n"
    assert rewrite_tables("table df.head(5)\n") == "__physpy_table__(df.head(5))\n"
    unchanged = "table = 123\ny = table(df)\nz = df.table\nw = arr[0]\n"
    assert rewrite_tables(unchanged) == unchanged


def _install_fake_pandas(monkeypatch):
    """Install a minimal fake pandas module sufficient to test DataFrame extraction."""
    import math

    class FakeDtype:
        def __init__(self, kind: str = "O", units=None):
            self.kind = kind
            self.units = units

    class FakeSeries:
        def __init__(self, data, name=None, index=None, dtype=None):
            self._data = list(data)
            self.name = name
            self.index = index if index is not None else FakeIndex(list(range(len(self._data))))
            if dtype is not None:
                self.dtype = dtype
            else:
                first = next((x for x in self._data if x is not None), None)
                if isinstance(first, (int, float)) and not isinstance(first, bool):
                    self.dtype = FakeDtype("f")
                else:
                    self.dtype = FakeDtype("O")

        def __iter__(self):
            return iter(self._data)

        def __len__(self):
            return len(self._data)

        def to_frame(self, name=None):
            col = name if name is not None else (self.name or "value")
            return FakeDataFrame({col: self}, index=self.index)

        def __str__(self):
            return "\n".join(f"{i}  {v}" for i, v in zip(self.index, self._data))

    class FakeIndex(list):
        def __init__(self, items, name=None):
            super().__init__(items)
            self.name = name
            self.names = [name]

    class _ILocDF:
        def __init__(self, df):
            self._df = df

        def __getitem__(self, key):
            if isinstance(key, tuple):
                rows_sel, col_pos = key
                col_name = self._df.columns[col_pos]
                return self._df._cols[col_name]
            if isinstance(key, slice):
                sub = {k: FakeSeries(list(v)[key], name=k, dtype=v.dtype) for k, v in self._df._cols.items()}
                return FakeDataFrame(sub, index=FakeIndex(list(self._df.index)[key], name=self._df.index.name))
            raise NotImplementedError

    class FakeDataFrame:
        def __init__(self, data: dict, index=None):
            self._cols = {}
            n = 0
            for k, v in data.items():
                if isinstance(v, FakeSeries):
                    self._cols[k] = v
                    n = len(v)
                else:
                    ser = FakeSeries(v, name=k)
                    self._cols[k] = ser
                    n = len(ser)
            self.columns = list(self._cols.keys())
            self.index = index if index is not None else FakeIndex(list(range(n)))
            self.iloc = _ILocDF(self)

        def __len__(self):
            return len(self.index)

        def __str__(self):
            header = "   " + "  ".join(str(c) for c in self.columns)
            lines = [header]
            for r in range(len(self)):
                vals = [str(list(self._cols[c])[r]) for c in self.columns]
                lines.append(f"{self.index[r]}  " + "  ".join(vals))
            return "\n".join(lines)

    class FakeApiTypes:
        @staticmethod
        def is_numeric_dtype(dt):
            return getattr(dt, "kind", "O") in ("i", "u", "f", "b")

    fake_pd = types.SimpleNamespace(
        DataFrame=FakeDataFrame,
        Series=FakeSeries,
        FakeDtype=FakeDtype,
        api=types.SimpleNamespace(types=FakeApiTypes),
        isna=lambda x: x is None or (isinstance(x, float) and math.isnan(x)),
    )
    monkeypatch.setitem(sys.modules, "pandas", fake_pd)
    return fake_pd


def test_extract_table_data_with_pint_units_and_truncation(monkeypatch):
    pd = _install_fake_pandas(monkeypatch)
    ureg = pint.get_application_registry()
    df = pd.DataFrame(
        {
            "Temperatura": pd.Series(
                [ureg.Quantity(20.0, "degC"), ureg.Quantity(25.0, "degC")],
                dtype=pd.FakeDtype("O", units=ureg.Unit("degC")),
            ),
            "Napiecie": pd.Series(
                [ureg.Quantity(0.02, "mV"), ureg.Quantity(1.07, "mV")],
            ),
            "Uwaga": ["ok", None],
        }
    )

    tbl = extract_table_data(df, max_rows=1)
    assert tbl["total_rows"] == 2
    assert tbl["truncated"] is True
    assert len(tbl["rows"]) == 1
    assert tbl["columns"] == [
        {"name": "Temperatura", "unit": "°C", "is_numeric": True},
        {"name": "Napiecie", "unit": "mV", "is_numeric": True},
        {"name": "Uwaga", "unit": None, "is_numeric": False},
    ]
    assert tbl["rows"][0] == {"index": "0", "cells": ["20", "0.02", "ok"]}


def test_notebook_session_captures_print_display_table_and_last_expr(monkeypatch):
    pd = _install_fake_pandas(monkeypatch)
    session = NotebookSession()
    session.exports["pd"] = pd

    res = session.run_cell(
        "df = pd.DataFrame({'a': [1.0, 2.0], 'b': ['x', 'y']})\n"
        "print('Naglowek:')\n"
        "print(df)\n"
        "table df\n"
        "df\n"
    )
    assert res.code == 0, res.stderr
    assert len(res.tables) == 3
    assert "Naglowek:\n" == res.non_table_stdout
    assert "Naglowek:\n" in res.stdout
    assert "a  b" in res.stdout
