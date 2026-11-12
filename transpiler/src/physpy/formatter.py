"""Code formatter for PhysPy and standard Python cells.

Formats Python code and PhysPy-extended code (preserving `export`, `\\symbol`, `plot`,
and `table` syntax) using `black` with line-length limit disabled (very high limit)
so mathematical expressions and physical equations remain on single readable lines.
"""

from __future__ import annotations

import re
from typing import Any

try:
    import black
    _HAS_BLACK = True
except ImportError:
    black = None  # type: ignore[assignment]
    _HAS_BLACK = False

_EXPORT_MARKER = "<__PPY_EXP_MARKER__>"
_SYM_PREFIX = "__physpy_sym_"
_SYM_SUFFIX = "__"
_SYMBOL_RE = re.compile(r"\\([A-Za-z]+)(\w*)")
_STRING_START_RE = re.compile(r"(?i)([rbuft]{0,2})('''|\"\"\"|'|\")")


def _mask_symbols(src: str) -> str:
    """Mask \\symbol outside strings and comments into valid Python identifiers."""
    out: list[str] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        # Skip comments
        if c == "#":
            end = src.find("\n", i)
            end = n if end == -1 else end
            out.append(src[i:end])
            i = end
            continue

        # Skip strings
        m_str = _STRING_START_RE.match(src, i)
        if m_str:
            prefix, quote = m_str.groups()
            out.append(prefix + quote)
            i = m_str.end()
            # scan string until closing quote
            while i < n:
                if src.startswith(quote, i):
                    out.append(quote)
                    i += len(quote)
                    break
                if len(quote) == 1 and src[i] == "\n":
                    break
                if src[i] == "\\":
                    out.append(src[i : i + 2])
                    i += 2
                    continue
                out.append(src[i])
                i += 1
            continue

        # Check for LaTeX symbol: \name
        if c == "\\":
            m_sym = _SYMBOL_RE.match(src, i)
            if m_sym:
                name, tail = m_sym.groups()
                out.append(f"{_SYM_PREFIX}{name}{tail}{_SYM_SUFFIX}")
                i = m_sym.end()
                continue

        out.append(c)
        i += 1

    return "".join(out)


def _unmask_symbols(src: str) -> str:
    """Restore __physpy_sym_name__ back to \\name."""
    pattern = re.compile(rf"{_SYM_PREFIX}([A-Za-z]+)(\w*){_SYM_SUFFIX}")
    return pattern.sub(r"\\\1\2", src)


def format_physpy_code(src: str, line_length: int = 999999) -> str:
    """Format PhysPy/Python source code with Black without line length limits.

    If the source cannot be parsed (e.g. invalid syntax or unbalanced parentheses while editing),
    the original source is returned untouched.
    """
    if not _HAS_BLACK:
        return src
    if not src or not src.strip():
        return src

    # 1. Mask exports
    lines = src.splitlines(keepends=True)
    masked_lines: list[str] = []
    export_flags: list[bool] = []

    for line in lines:
        m_exp = re.match(r"^([ \t]*)export[ \t]+(.*)$", line)
        if m_exp:
            indent, rest = m_exp.groups()
            export_flags.append(True)
            masked_lines.append(f"{indent}{rest.rstrip()}\n")
        else:
            export_flags.append(False)
            masked_lines.append(line)

    masked_code = "".join(masked_lines)

    # 2. Mask symbols (\name -> __physpy_sym_name__)
    masked_code = _mask_symbols(masked_code)

    # 3. Mask plot and table keywords
    masked_code = re.sub(r"(?m)^([ \t]*)plot[ \t]+([^\n#]+)", r"\1__physpy_plot__(\2)", masked_code)
    masked_code = re.sub(r"(?m)^([ \t]*)table[ \t]+([^\n#]+)", r"\1__physpy_table__(\2)", masked_code)

    # 4. Attach export marker comments to the exported statements
    pass1_lines = masked_code.splitlines(keepends=True)
    pass2_lines: list[str] = []
    for exp, line in zip(export_flags, pass1_lines):
        if exp and line.strip():
            stripped = line.rstrip("\r\n")
            pass2_lines.append(f"{stripped}  # {_EXPORT_MARKER}\n")
        else:
            pass2_lines.append(line)

    prep_code = "".join(pass2_lines)

    # 5. Format using Black
    try:
        mode = black.Mode(line_length=line_length)
        formatted = black.format_str(prep_code, mode=mode)
    except Exception:
        # Syntax error, unbalanced brackets, or unparseable construct: safely return original
        return src

    # 6. Unmask plot and table
    unmasked = re.sub(r"(?m)^([ \t]*)__physpy_plot__\((.*)\)$", r"\1plot \2", formatted)
    unmasked = re.sub(r"(?m)^([ \t]*)__physpy_table__\((.*)\)$", r"\1table \2", unmasked)

    # 7. Unmask export markers
    out_lines: list[str] = []
    for line in unmasked.splitlines(keepends=True):
        if _EXPORT_MARKER in line:
            cleaned = (
                line.replace(f"  # {_EXPORT_MARKER}", "")
                .replace(f" # {_EXPORT_MARKER}", "")
                .replace(f"# {_EXPORT_MARKER}", "")
                .replace(_EXPORT_MARKER, "")
            )
            m_ind = re.match(r"^([ \t]*)(.*)$", cleaned)
            if m_ind:
                ind, body = m_ind.groups()
                out_lines.append(f"{ind}export {body.rstrip()}\n")
            else:
                out_lines.append(cleaned)
        else:
            out_lines.append(line)

    final_code = "".join(out_lines)

    # 8. Unmask symbols
    final_code = _unmask_symbols(final_code)

    # Match trailing newline with original input
    if not src.endswith("\n") and final_code.endswith("\n"):
        final_code = final_code[:-1]

    return final_code


def format_cells_batch(cells: list[str], line_length: int = 999999) -> list[str]:
    """Format a batch of cells, returning a list of formatted source strings."""
    return [format_physpy_code(c, line_length=line_length) for c in cells]
