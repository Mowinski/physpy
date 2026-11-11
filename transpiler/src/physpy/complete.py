"""Live Python + PhysPy autocomplete and function signature inspection."""

from __future__ import annotations

import ast
import builtins
import importlib
import inspect
import keyword
import re
from dataclasses import dataclass, field
from typing import Any

from .pipeline import to_source

_EXPORT_PREFIX_RE = re.compile(r"^([ \t]*)export[ \t]+", re.MULTILINE)
_VALID_ATTR_CHAIN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")
_SIG_LINE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*\([^)]*\)\s*(?:->.*)?$")

_MODULE_CACHE: dict[str, Any] = {}

_PHYSPY_BUILTINS: dict[str, dict[str, Any]] = {
    "export": {
        "kind": "keyword",
        "detail": "export var = value / export import mod",
        "doc": "Export a variable, function, or import from this cell so subsequent cells can use it.",
    },
    "const": {
        "kind": "keyword",
        "detail": "const NAME = value",
        "doc": "Declare a constant whose reassignment triggers a warning across notebook cells.",
    },
    "plot": {
        "kind": "function",
        "detail": "(x, y, ..., title=..., xlabel=..., ylabel=...)",
        "signature": "(x, y, *args, title='', xlabel='', ylabel='', label=None, kind='line', **kwargs)",
        "params": [
            {"name": "x", "label": "x"},
            {"name": "y", "label": "y"},
            {"name": "*args", "label": "*args"},
            {"name": "title", "label": "title=''"},
            {"name": "xlabel", "label": "xlabel=''"},
            {"name": "ylabel", "label": "ylabel=''"},
            {"name": "label", "label": "label=None"},
            {"name": "kind", "label": "kind='line'"},
            {"name": "**kwargs", "label": "**kwargs"},
        ],
        "doc": "PhysPy quick plot helper — renders an inline matplotlib figure inside the cell output.",
    },
    "table": {
        "kind": "function",
        "detail": "(data, headers=...)",
        "signature": "(data, headers=None, title=None)",
        "params": [
            {"name": "data", "label": "data"},
            {"name": "headers", "label": "headers=None"},
            {"name": "title", "label": "title=None"},
        ],
        "doc": "Render structured tabular data cleanly in cell output.",
    },
    "matrix": {
        "kind": "function",
        "detail": "(rows)",
        "signature": "(rows, dtype=None)",
        "params": [
            {"name": "rows", "label": "rows"},
            {"name": "dtype", "label": "dtype=None"},
        ],
        "doc": "Create a 2D PhysPy/NumPy matrix rendered with KaTeX in cell output.",
    },
}


@dataclass
class _AstScope:
    imports: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    defs: dict[str, dict[str, Any]] = field(default_factory=dict)
    variables: dict[str, str] = field(default_factory=dict)


def _preprocess_for_ast(src: str) -> str:
    """Best-effort conversion from PhysPy source to parseable Python."""
    try:
        return to_source(src)
    except BaseException:
        return _EXPORT_PREFIX_RE.sub(r"\1", src)


def _tolerant_parse(src: str) -> ast.Module | None:
    """Parse Python/PhysPy source, dropping up to 3 broken/incomplete lines."""
    lines = _preprocess_for_ast(src).splitlines()
    for _ in range(4):
        candidate = "\n".join(lines)
        try:
            return ast.parse(candidate)
        except SyntaxError as exc:
            lineno = exc.lineno or len(lines)
            idx = max(0, min(len(lines) - 1, lineno - 1))
            if not lines:
                return None
            if not lines[idx].strip():
                lines.pop(idx)
            else:
                lines[idx] = ""
        except BaseException:
            return None
    return None


def _format_ast_arg(arg: ast.arg, default: ast.expr | None = None, prefix: str = "") -> str:
    text = f"{prefix}{arg.arg}"
    if arg.annotation is not None:
        try:
            text += f": {ast.unparse(arg.annotation)}"
        except BaseException:
            pass
    if default is not None:
        try:
            d_str = ast.unparse(default)
            if len(d_str) > 36:
                d_str = "…"
            text += f"={d_str}"
        except BaseException:
            text += "=…"
    return text


def _signature_from_ast_args(args: ast.arguments) -> tuple[str, list[dict[str, str]]]:
    params: list[dict[str, str]] = []
    pos_all = list(args.posonlyargs) + list(args.args)
    pos_defaults: list[ast.expr | None] = [None] * (len(pos_all) - len(args.defaults)) + list(
        args.defaults
    )
    for idx, (arg, default) in enumerate(zip(pos_all, pos_defaults)):
        params.append({"name": arg.arg, "label": _format_ast_arg(arg, default)})
        if args.posonlyargs and idx == len(args.posonlyargs) - 1:
            params.append({"name": "/", "label": "/"})

    if args.vararg is not None:
        params.append({"name": f"*{args.vararg.arg}", "label": _format_ast_arg(args.vararg, prefix="*")})
    elif args.kwonlyargs:
        params.append({"name": "*", "label": "*"})

    for arg, default in zip(args.kwonlyargs, args.kw_defaults):
        params.append({"name": arg.arg, "label": _format_ast_arg(arg, default)})

    if args.kwarg is not None:
        params.append({"name": f"**{args.kwarg.arg}", "label": _format_ast_arg(args.kwarg, prefix="**")})

    sig_str = f"({', '.join(p['label'] for p in params)})"
    return sig_str, [p for p in params if p["name"] not in ("/", "*")]


def _extract_ast_scope(doc_source: str, cell_source: str) -> _AstScope:
    scope = _AstScope()
    combined = f"{doc_source}\n\n{cell_source}" if doc_source.strip() else cell_source
    tree = _tolerant_parse(combined)
    if tree is None:
        return scope

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                bound = alias.asname or alias.name.split(".")[0]
                scope.imports[bound] = (alias.name, None)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    bound = alias.asname or alias.name
                    scope.imports[bound] = (node.module, alias.name)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            sig_str, params = _signature_from_ast_args(node.args)
            doc = ast.get_docstring(node) or ""
            scope.defs[node.name] = {
                "kind": "function",
                "name": node.name,
                "signature": sig_str,
                "params": params,
                "doc": _shorten_doc(doc),
            }
        elif isinstance(node, ast.ClassDef):
            doc = ast.get_docstring(node) or ""
            sig_str = "(...)"
            params: list[dict[str, str]] = []
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == "__init__":
                    init_args = ast.arguments(
                        posonlyargs=item.args.posonlyargs[1:] if item.args.posonlyargs else [],
                        args=item.args.args[1:] if (not item.args.posonlyargs and item.args.args) else item.args.args,
                        vararg=item.args.vararg,
                        kwonlyargs=item.args.kwonlyargs,
                        kw_defaults=item.args.kw_defaults,
                        kwarg=item.args.kwarg,
                        defaults=item.args.defaults,
                    )
                    sig_str, params = _signature_from_ast_args(init_args)
                    break
            scope.defs[node.name] = {
                "kind": "class",
                "name": node.name,
                "signature": sig_str,
                "params": params,
                "doc": _shorten_doc(doc),
            }
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    if isinstance(node.value, ast.Lambda):
                        sig_str, params = _signature_from_ast_args(node.value.args)
                        scope.defs[target.id] = {
                            "kind": "function",
                            "name": target.id,
                            "signature": sig_str,
                            "params": params,
                            "doc": "",
                        }
                    else:
                        scope.variables.setdefault(target.id, "variable")
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            try:
                scope.variables.setdefault(node.target.id, ast.unparse(node.annotation))
            except BaseException:
                scope.variables.setdefault(node.target.id, "variable")

    return scope


def _import_cached(module_name: str) -> Any:
    if module_name in _MODULE_CACHE:
        return _MODULE_CACHE[module_name]
    try:
        mod = importlib.import_module(module_name)
    except BaseException:
        return None
    _MODULE_CACHE[module_name] = mod
    return mod


def _safe_getattr(obj: Any, attr: str) -> tuple[bool, Any]:
    try:
        val = inspect.getattr_static(obj, attr)
        if isinstance(val, (property, classmethod, staticmethod)) or inspect.isroutine(val) or inspect.isclass(val):
            try:
                return True, getattr(obj, attr)
            except BaseException:
                return True, val
        return True, val
    except BaseException:
        pass
    try:
        return True, getattr(obj, attr)
    except BaseException:
        return False, None


def _resolve_target(expr: str, scope: _AstScope, exports: dict[str, Any]) -> tuple[bool, Any]:
    if not expr or not _VALID_ATTR_CHAIN_RE.match(expr):
        return False, None
    parts = expr.split(".")
    root = parts[0]

    obj: Any = None
    found = False
    if root in exports:
        obj = exports[root]
        found = True
    elif root in scope.imports:
        mod_name, attr_name = scope.imports[root]
        mod = _import_cached(mod_name)
        if mod is not None:
            if attr_name:
                found, obj = _safe_getattr(mod, attr_name)
            else:
                obj = mod
                found = True
    elif hasattr(builtins, root):
        obj = getattr(builtins, root)
        found = True

    if not found:
        return False, None

    for part in parts[1:]:
        ok, nxt = _safe_getattr(obj, part)
        if not ok:
            return False, None
        obj = nxt

    return True, obj


def _shorten_doc(raw: str | None, max_chars: int = 280) -> str:
    if not raw:
        return ""
    lines = [line.strip() for line in raw.strip().splitlines()]
    # Drop leading echoed signature lines common in numpy/C docstrings
    while lines and (_SIG_LINE_RE.match(lines[0]) or not lines[0]):
        lines.pop(0)
    if not lines:
        return ""
    paragraph: list[str] = []
    for line in lines:
        if not line:
            if paragraph:
                break
            continue
        if line.startswith(("Parameters", "----------", "Returns", "Notes", "Examples", ">>>")):
            break
        paragraph.append(line)
        if sum(len(x) for x in paragraph) >= max_chars:
            break
    joined = " ".join(paragraph)
    if len(joined) > max_chars:
        return joined[: max_chars - 1].rstrip() + "…"
    return joined


def _format_param_from_inspect(param: inspect.Parameter) -> str:
    prefix = ""
    if param.kind == inspect.Parameter.VAR_POSITIONAL:
        prefix = "*"
    elif param.kind == inspect.Parameter.VAR_KEYWORD:
        prefix = "**"
    text = f"{prefix}{param.name}"

    if param.annotation is not inspect.Parameter.empty:
        ann = getattr(param.annotation, "__name__", None) or str(param.annotation)
        ann = ann.replace("typing.", "")
        if len(ann) <= 28:
            text += f": {ann}"

    if param.default is not inspect.Parameter.empty:
        if isinstance(param.default, str):
            d_str = repr(param.default)
        elif hasattr(param.default, "__name__"):
            d_str = param.default.__name__
        else:
            d_str = repr(param.default)
        if len(d_str) > 30:
            d_str = "…"
        text += f"={d_str}"
    return text


def _signature_from_docstring(doc: str, name: str) -> tuple[str, list[dict[str, str]]] | None:
    if not doc:
        return None
    for raw_line in doc.splitlines()[:6]:
        line = raw_line.strip()
        if "(" not in line or ")" not in line:
            continue
        l_idx = line.find("(")
        r_idx = line.rfind(")")
        if l_idx < 0 or r_idx <= l_idx:
            continue
        head = line[:l_idx].strip()
        if head and head.split(".")[-1] != name.split(".")[-1]:
            continue
        inside = line[l_idx + 1 : r_idx].strip()
        raw_parts = _split_top_level_commas(inside)
        params: list[dict[str, str]] = []
        labels: list[str] = []
        for part in raw_parts:
            part = part.strip()
            if not part:
                continue
            labels.append(part)
            if part in ("/", "*"):
                continue
            pname = part.split("=")[0].split(":")[0].strip()
            params.append({"name": pname, "label": part})
        return f"({', '.join(labels)})", params
    return None


def _split_top_level_commas(text: str) -> list[str]:
    parts: list[str] = []
    cur: list[str] = []
    depth = 0
    in_quote: str | None = None
    escaped = False
    for ch in text:
        if escaped:
            cur.append(ch)
            escaped = False
            continue
        if in_quote:
            cur.append(ch)
            if ch == "\\":
                escaped = True
            elif ch == in_quote:
                in_quote = None
            continue
        if ch in ("'", '"'):
            in_quote = ch
            cur.append(ch)
        elif ch in ("(", "[", "{"):
            depth += 1
            cur.append(ch)
        elif ch in (")", "]", "}"):
            depth = max(0, depth - 1)
            cur.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if cur:
        parts.append("".join(cur))
    return parts


def _extract_callable_signature(obj: Any, display_name: str) -> dict[str, Any] | None:
    if not callable(obj):
        return None
    raw_doc = ""
    try:
        raw_doc = inspect.getdoc(obj) or ""
    except BaseException:
        raw_doc = ""

    params: list[dict[str, str]] = []
    labels: list[str] = []
    parsed = False
    try:
        sig = inspect.signature(obj)
        for p in sig.parameters.values():
            lbl = _format_param_from_inspect(p)
            labels.append(lbl)
            pname = (
                f"*{p.name}"
                if p.kind == inspect.Parameter.VAR_POSITIONAL
                else f"**{p.name}"
                if p.kind == inspect.Parameter.VAR_KEYWORD
                else p.name
            )
            params.append({"name": pname, "label": lbl})
        parsed = True
    except (ValueError, TypeError):
        pass

    if parsed:
        return {
            "name": display_name,
            "signature": f"({', '.join(labels)})",
            "params": params,
            "doc": _shorten_doc(raw_doc),
        }

    doc_sig = _signature_from_docstring(raw_doc, display_name)
    if doc_sig is not None:
        sig_str, doc_params = doc_sig
        return {
            "name": display_name,
            "signature": sig_str,
            "params": doc_params,
            "doc": _shorten_doc(raw_doc),
        }

    return {
        "name": display_name,
        "signature": "(...)",
        "params": [],
        "doc": _shorten_doc(raw_doc),
    }


def _describe_attr_detail(obj: Any, attr_name: str) -> tuple[str, str, str]:
    """Return `(kind, detail, short_doc)` for an object or attribute."""
    if inspect.ismodule(obj):
        return "module", "module", _shorten_doc(getattr(obj, "__doc__", None), 180)
    if inspect.isclass(obj):
        sig_info = _extract_callable_signature(obj, attr_name)
        return "class", sig_info["signature"] if sig_info else "(...)", (sig_info or {}).get("doc", "")
    if callable(obj):
        sig_info = _extract_callable_signature(obj, attr_name)
        kind = "method" if inspect.ismethod(obj) or inspect.ismethoddescriptor(obj) else "function"
        sig_text = sig_info["signature"] if sig_info else "(...)"
        if len(sig_text) > 56:
            sig_text = sig_text[:53] + "…)"
        return kind, sig_text, (sig_info or {}).get("doc", "")
    type_name = type(obj).__name__
    return "property", type_name, ""


def get_signature(
    expr: str,
    cell_source: str = "",
    doc_source: str = "",
    exports: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Resolve function/class/method signature and parameter metadata for `expr`."""
    expr = expr.strip()
    if not expr:
        return None

    if expr in _PHYSPY_BUILTINS and "params" in _PHYSPY_BUILTINS[expr]:
        info = _PHYSPY_BUILTINS[expr]
        return {
            "name": expr,
            "signature": info["signature"],
            "params": info["params"],
            "doc": info["doc"],
        }

    live_exports = exports or {}
    scope = _extract_ast_scope(doc_source, cell_source)

    found, obj = _resolve_target(expr, scope, live_exports)
    if found:
        res = _extract_callable_signature(obj, expr)
        if res is not None:
            return res

    if "." not in expr and expr in scope.defs:
        d = scope.defs[expr]
        return {
            "name": expr,
            "signature": d["signature"],
            "params": d["params"],
            "doc": d.get("doc", ""),
        }

    return None


def get_completions(
    prefix: str = "",
    attr_target: str | None = None,
    cell_source: str = "",
    doc_source: str = "",
    exports: dict[str, Any] | None = None,
    limit: int = 80,
) -> list[dict[str, str]]:
    """Return completion candidates for bare identifiers or `attr_target.prefix`."""
    live_exports = exports or {}
    scope = _extract_ast_scope(doc_source, cell_source)
    pref_lower = prefix.lower()
    include_private = prefix.startswith("_")

    items: dict[str, tuple[int, dict[str, str]]] = {}

    if attr_target:
        found, target_obj = _resolve_target(attr_target, scope, live_exports)
        if not found:
            return []
        try:
            names = dir(target_obj)
        except BaseException:
            return []

        # Also offer DataFrame column names as high-signal completions when available
        cols = getattr(target_obj, "columns", None)
        if cols is not None:
            try:
                for col in list(cols)[:40]:
                    col_name = str(col)
                    if col_name.isidentifier() and col_name.lower().startswith(pref_lower):
                        items[col_name] = (
                            3,
                            {
                                "label": col_name,
                                "kind": "property",
                                "detail": "column",
                                "doc": f"DataFrame column '{col_name}'",
                            },
                        )
            except BaseException:
                pass

        candidate_names = [
            n
            for n in names
            if (include_private or not n.startswith("_"))
            and (not pref_lower or n.lower().startswith(pref_lower))
            and n not in items
        ]
        # Prefer normal lowercase/camelCase symbols ahead of ALL_CAPS constants on empty prefix
        candidate_names.sort(key=lambda n: (1 if n.isupper() else 0, 0 if n.startswith(prefix) else 1, n.lower()))

        for name in candidate_names[: max(limit, 160)]:
            ok, val = _safe_getattr(target_obj, name)
            if ok:
                kind, detail, doc = _describe_attr_detail(val, name)
            else:
                kind, detail, doc = "property", "", ""
            score = 2 if name.startswith(prefix) else 1
            items[name] = (
                score,
                {"label": name, "kind": kind, "detail": detail, "doc": doc},
            )
            if len(items) >= limit:
                break
    else:
        def _add(label: str, score: int, kind: str, detail: str = "", doc: str = "") -> None:
            if pref_lower and not label.lower().startswith(pref_lower):
                return
            if not include_private and label.startswith("_"):
                return
            prev = items.get(label)
            if prev is None or score > prev[0]:
                items[label] = (
                    score,
                    {"label": label, "kind": kind, "detail": detail, "doc": doc},
                )

        # 1. Live session exports (highest priority)
        for name, val in live_exports.items():
            kind, detail, doc = _describe_attr_detail(val, name)
            if kind == "property":
                kind = "variable"
            _add(name, 4, kind, detail, doc)

        # 2. User AST defs & variables from notebook
        for name, info in scope.defs.items():
            _add(name, 3, info["kind"], info["signature"], info.get("doc", ""))
        for name, var_type in scope.variables.items():
            _add(name, 3, "variable", var_type, "")

        # 3. Imported symbols / aliases
        for name, (mod_name, attr_name) in scope.imports.items():
            found, val = _resolve_target(name, scope, {})
            if found:
                kind, detail, doc = _describe_attr_detail(val, name)
            else:
                kind, detail, doc = "module" if attr_name is None else "variable", mod_name, ""
            _add(name, 3, kind, detail, doc)

        # 4. PhysPy special helpers
        for name, info in _PHYSPY_BUILTINS.items():
            _add(name, 2, info["kind"], info["detail"], info["doc"])

        # 5. Builtin functions & types (matching prefix so dropdown stays focused)
        if prefix or not items:
            for name in dir(builtins):
                if name.startswith("_"):
                    continue
                if pref_lower and not name.lower().startswith(pref_lower):
                    continue
                val = getattr(builtins, name)
                if callable(val) or isinstance(val, (bool, type)):
                    kind, detail, doc = _describe_attr_detail(val, name)
                    _add(name, 1, kind, detail, doc)
            for kw in keyword.kwlist:
                _add(kw, 0, "keyword", "keyword", "")

    ordered = sorted(
        items.values(),
        key=lambda entry: (
            -entry[0],
            1 if entry[1]["label"].isupper() else 0,
            0 if entry[1]["label"].startswith(prefix) else 1,
            entry[1]["label"].lower(),
        ),
    )
    return [entry[1] for entry in ordered[:limit]]
