export interface IdentOccurrence {
  start: number;
  end: number;
  name: string;
  isAttr: boolean;
  isKwarg: boolean;
  inUnit: boolean;
}

const KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "const",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "export",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "plot",
  "raise",
  "return",
  "table",
  "try",
  "while",
  "with",
  "yield",
]);

const STRING_PREFIX_RE = /^([rbuft]{0,2})('''|"""|'|")/i;
const LATEX_IDENT_RE = /^\\[A-Za-z]+\w*/;
const PLAIN_IDENT_RE = /^[A-Za-z_]\w*/;
const NUMBER_RE = /^(?:\d+(?:_\d+)*(?:\.\d*(?:_\d+)*)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?/;

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

function prevNonSpaceChar(src: string, idx: number): string | undefined {
  let j = idx - 1;
  while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
  return j >= 0 ? src[j] : undefined;
}

function nextNonSpaceChar(src: string, idx: number): { ch: string | undefined; nextCh: string | undefined } {
  let j = idx;
  while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
  return { ch: src[j], nextCh: src[j + 1] };
}

function scanCodeSlice(
  src: string,
  startOffset: number,
  endOffset: number,
  out: IdentOccurrence[],
): void {
  let i = startOffset;
  let parenDepth = 0;
  let defHeaderDepth: number | null = null;
  let unitBracketDepth = 0;
  let lastWasNumber = false;

  while (i < endOffset) {
    const c = src[i];

    // Comments
    if (c === "#") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 || nl >= endOffset ? endOffset : nl + 1;
      lastWasNumber = false;
      continue;
    }

    // Strings
    const mStr = STRING_PREFIX_RE.exec(src.slice(i, endOffset));
    if (mStr) {
      const [full, prefix, quote] = mStr;
      const isF = prefix.toLowerCase().includes("f");
      i += full.length;
      let braceDepth = 0;
      let exprStart = -1;
      while (i < endOffset) {
        if (braceDepth === 0 && src.startsWith(quote, i)) {
          i += quote.length;
          break;
        }
        if (quote.length === 1 && src[i] === "\n" && braceDepth === 0) {
          i += 1;
          break;
        }
        if (isF) {
          if (src[i] === "{") {
            if (src[i + 1] === "{") {
              i += 2;
              continue;
            }
            if (braceDepth === 0) exprStart = i + 1;
            braceDepth++;
            i++;
            continue;
          }
          if (src[i] === "}" && braceDepth > 0) {
            braceDepth--;
            if (braceDepth === 0 && exprStart !== -1) {
              scanCodeSlice(src, exprStart, i, out);
              exprStart = -1;
            }
            i++;
            continue;
          }
        }
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      lastWasNumber = false;
      continue;
    }

    if (c === "\n") {
      unitBracketDepth = 0;
      lastWasNumber = false;
      i++;
      continue;
    }

    if (c === " " || c === "\t") {
      i++;
      continue;
    }

    if (c === "(" || c === "[" || c === "{") {
      if (c === "[" && lastWasNumber && unitBracketDepth === 0) {
        unitBracketDepth = 1;
      } else if (unitBracketDepth > 0 && c === "[") {
        unitBracketDepth++;
      }
      parenDepth++;
      lastWasNumber = false;
      i++;
      continue;
    }

    if (c === ")" || c === "]" || c === "}") {
      if (unitBracketDepth > 0 && c === "]") {
        unitBracketDepth--;
      }
      if (defHeaderDepth !== null && c === ")" && parenDepth === defHeaderDepth) {
        defHeaderDepth = null;
      }
      parenDepth = Math.max(0, parenDepth - 1);
      lastWasNumber = false;
      i++;
      continue;
    }

    // Numeric literal (for detecting `10 [mV]` unit brackets)
    if (/\d/.test(c) || (c === "." && i + 1 < endOffset && /\d/.test(src[i + 1]))) {
      if (!isWordChar(src[i - 1])) {
        const mNum = NUMBER_RE.exec(src.slice(i, endOffset));
        if (mNum) {
          i += mNum[0].length;
          lastWasNumber = true;
          continue;
        }
      }
    }

    // LaTeX symbol identifier: \alpha, \V_0, \alpha_AB_o
    if (c === "\\") {
      const mLatex = LATEX_IDENT_RE.exec(src.slice(i, endOffset));
      if (mLatex) {
        const name = mLatex[0];
        const start = i;
        const end = i + name.length;
        i = end;
        lastWasNumber = false;
        if (name === "\\i") continue;

        const isAttr = prevNonSpaceChar(src, start) === ".";
        const { ch: nxt, nextCh } = nextNonSpaceChar(src, end);
        const isKwarg =
          parenDepth > 0 &&
          defHeaderDepth === null &&
          nxt === "=" &&
          nextCh !== "=";
        out.push({
          start,
          end,
          name,
          isAttr,
          isKwarg,
          inUnit: unitBracketDepth > 0,
        });
        continue;
      }
    }

    // Plain identifier
    if (/[A-Za-z_]/.test(c)) {
      const mPlain = PLAIN_IDENT_RE.exec(src.slice(i, endOffset));
      if (mPlain) {
        const name = mPlain[0];
        const start = i;
        const end = i + name.length;
        i = end;
        lastWasNumber = false;

        if (name === "def" && prevNonSpaceChar(src, start) !== ".") {
          defHeaderDepth = parenDepth + 1;
        }
        if (KEYWORDS.has(name)) continue;

        const isAttr = prevNonSpaceChar(src, start) === ".";
        const { ch: nxt, nextCh } = nextNonSpaceChar(src, end);
        const isKwarg =
          parenDepth > 0 &&
          defHeaderDepth === null &&
          nxt === "=" &&
          nextCh !== "=";
        out.push({
          start,
          end,
          name,
          isAttr,
          isKwarg,
          inUnit: unitBracketDepth > 0,
        });
        continue;
      }
    }

    lastWasNumber = false;
    i++;
  }
}

export function scanIdentifiers(src: string): IdentOccurrence[] {
  const out: IdentOccurrence[] = [];
  scanCodeSlice(src, 0, src.length, out);
  return out;
}

export function findVariableAtOffset(src: string, offset: number): string | null {
  const tokens = scanIdentifiers(src);
  for (const tok of tokens) {
    if (tok.isAttr || tok.isKwarg || tok.inUnit) continue;
    if (offset >= tok.start && offset <= tok.end) {
      return tok.name;
    }
  }
  return null;
}

export function findVariableOccurrences(
  src: string,
  varName: string,
): Array<{ from: number; to: number }> {
  const tokens = scanIdentifiers(src);
  const ranges: Array<{ from: number; to: number }> = [];
  for (const tok of tokens) {
    if (tok.isAttr || tok.isKwarg || tok.inUnit) continue;
    if (tok.name === varName) {
      ranges.push({ from: tok.start, to: tok.end });
    }
  }
  return ranges;
}

export function validateVariableName(name: string): { ok: true; name: string } | { ok: false; reason: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, reason: "Nazwa zmiennej nie może być pusta." };
  }
  if (!/^(?:\\[A-Za-z]+\w*|[A-Za-z_]\w*)$/.test(trimmed)) {
    return {
      ok: false,
      reason: "Niepoprawna nazwa zmiennej (dozwolone litery, cyfry, _, lub symbol \\nazwa).",
    };
  }
  if (trimmed === "\\i" || KEYWORDS.has(trimmed)) {
    return { ok: false, reason: `"${trimmed}" jest zarezerwowanym słowem kluczowym.` };
  }
  return { ok: true, name: trimmed };
}

/** Find the first definition site (`def`, `class`, `import`, `for`, or assignment `=`) of `varName` in `src`. */
export function findVariableDefinition(
  src: string,
  varName: string,
): { from: number; to: number } | null {
  const occurrences = findVariableOccurrences(src, varName);
  if (occurrences.length === 0) return null;

  for (const occ of occurrences) {
    // Check line start up to `occ.from`
    const lineStart = src.lastIndexOf("\n", occ.from - 1) + 1;
    const beforeOnLine = src.slice(lineStart, occ.from);
    const afterStart = occ.to;
    const lineEndIdx = src.indexOf("\n", afterStart);
    const afterOnLine = src.slice(afterStart, lineEndIdx === -1 ? src.length : lineEndIdx);

    // `def name` or `class name` or `export def name`
    if (/(?:^|[ \t;])(?:export[ \t]+)?(?:def|class)[ \t]+$/.test(beforeOnLine)) {
      return occ;
    }
    // `for name in ...` or `for a, name in ...`
    if (/(?:^|[ \t;])for[ \t]+(?:[^=\n]*,[ \t]*)?$/.test(beforeOnLine)) {
      return occ;
    }
    // `import ... as name` or `from ... import name`
    if (/(?:^|[ \t;])(?:export[ \t]+)?(?:from[ \t]+[\w.]+[ \t]+)?import[ \t]+/.test(beforeOnLine)) {
      return occ;
    }
    // Assignment: `name = ...`, `export name = ...`, `const name = ...`, `a, name = ...`
    if (
      /^[ \t]*(?:export[ \t]+)?(?:const[ \t]+)?(?:[^=\n#()\[\]]*,[ \t]*)?$/.test(beforeOnLine) &&
      /^[ \t]*(?:\+|-|\*|\/|\/\/|%|\*\*|&|\||\^)?=(?!=)/.test(afterOnLine)
    ) {
      return occ;
    }
  }
  return null;
}

/** Collect all variable/function/import names exported via `export ...` in a single cell. */
export function getExportedNamesInCell(src: string): Set<string> {
  const exported = new Set<string>();
  const lines = src.split(/\r?\n/);
  for (const rawLine of lines) {
    // Split on `;` only at top level? Simple statement check per line/semicolon:
    const stmts = rawLine.split(";");
    for (const stmt of stmts) {
      const m = /^[ \t]*export[ \t]+(.+)$/.exec(stmt);
      if (!m) continue;
      let rest = m[1].replace(/#.*$/, "").trim();
      if (!rest) continue;

      // `export def name(...)` or `export class name...`
      const mDef = /^(?:def|class)[ \t]+(\\[A-Za-z]+\w*|[A-Za-z_]\w*)/.exec(rest);
      if (mDef) {
        exported.add(mDef[1]);
        continue;
      }

      // `export from pkg import a, b as c`
      const mFrom = /^from[ \t]+[\w.]+[ \t]+import[ \t]+(.+)$/.exec(rest);
      if (mFrom) {
        for (const part of mFrom[1].split(",")) {
          const asMatch = /\bas[ \t]+([A-Za-z_]\w*)$/.exec(part.trim());
          const nameMatch = /^([A-Za-z_]\w*)/.exec(part.trim());
          if (asMatch) exported.add(asMatch[1]);
          else if (nameMatch) exported.add(nameMatch[1]);
        }
        continue;
      }

      // `export import pkg, other as alias`
      const mImp = /^import[ \t]+(.+)$/.exec(rest);
      if (mImp) {
        for (const part of mImp[1].split(",")) {
          const asMatch = /\bas[ \t]+([A-Za-z_]\w*)$/.exec(part.trim());
          const nameMatch = /^([A-Za-z_]\w*)/.exec(part.trim());
          if (asMatch) exported.add(asMatch[1]);
          else if (nameMatch) exported.add(nameMatch[1]);
        }
        continue;
      }

      // `export [const] a, b = ...` or `export \alpha_AB_o = ...`
      if (rest.startsWith("const ") || rest.startsWith("const\t")) {
        rest = rest.slice(5).trim();
      }
      const eqIdx = rest.indexOf("=");
      const lhs = eqIdx === -1 ? rest : rest.slice(0, eqIdx);
      for (const item of lhs.split(",")) {
        const clean = item.trim();
        const mIdent = /^(\\[A-Za-z]+\w*|[A-Za-z_]\w*)$/.exec(clean);
        if (mIdent) exported.add(mIdent[1]);
      }
    }
  }
  return exported;
}
