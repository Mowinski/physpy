/**
 * Converts a Jupyter Notebook (`.ipynb`) JSON document into PhysPy (`.ppy`) format.
 */

export interface IpynbImportOptions {
  /** Automatically add `export` to top-level imports, defs, classes, and variables used in later cells. */
  autoExport: boolean;
  /** Rewrite `plt.show()` into `plot plt`. */
  convertPltShow: boolean;
}

export interface IpynbConversionResult {
  ok: boolean;
  error?: string;
  ppySource: string;
  codeCellCount: number;
  markdownCellCount: number;
  autoExportedNames: string[];
  convertedPlotsCount: number;
}

interface RawIpynbCell {
  cell_type?: string;
  source?: string | string[];
}

interface RawIpynbRoot {
  cells?: RawIpynbCell[];
  nbformat?: number;
}

function normalizeSource(src: string | string[] | undefined): string {
  if (!src) return "";
  if (Array.isArray(src)) return src.join("");
  if (typeof src === "string") return src;
  return "";
}

const PY_KEYWORDS = new Set([
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
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
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
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "export",
  "const",
  "plot",
]);

/** Extract all identifiers referenced anywhere in a cell's code (ignoring comments). */
function extractReferencedIdentifiers(code: string): Set<string> {
  const out = new Set<string>();
  const noComments = code.replace(/#.*$/gm, "");
  for (const m of noComments.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
    const id = m[1];
    if (!PY_KEYWORDS.has(id)) {
      out.add(id);
    }
  }
  return out;
}

/** Extract top-level assigned names, defs, classes, and imports on a single unindented line. */
function extractTopLevelDefinedNames(line: string): {
  kind: "import" | "def" | "assign" | null;
  names: string[];
} {
  const clean = line.replace(/#.*$/, "");
  if (!clean.trim() || /^\s/.test(clean)) {
    return { kind: null, names: [] };
  }
  const trimmed = clean.trim();
  if (/^(?:export|const)\b/.test(trimmed)) {
    return { kind: null, names: [] };
  }

  // 1. `import a, b as c`
  const impMatch = trimmed.match(/^import\s+(.+)$/);
  if (impMatch) {
    const names: string[] = [];
    for (const part of impMatch[1].split(",")) {
      const p = part.trim();
      const asM = p.match(/^([A-Za-z0-9_.]+)\s+as\s+([A-Za-z_]\w*)$/);
      if (asM) names.push(asM[2]);
      else if (p) names.push(p.split(".")[0].trim());
    }
    return { kind: "import", names: names.filter(Boolean) };
  }

  // 2. `from mod import a, b as c`
  const fromMatch = trimmed.match(/^from\s+[A-Za-z0-9_.]+\s+import\s+(.+)$/);
  if (fromMatch && !fromMatch[1].includes("(")) {
    const names: string[] = [];
    for (const part of fromMatch[1].split(",")) {
      const p = part.trim();
      if (!p || p === "*") continue;
      const asM = p.match(/^([A-Za-z0-9_.]+)\s+as\s+([A-Za-z_]\w*)$/);
      if (asM) names.push(asM[2]);
      else names.push(p);
    }
    return { kind: "import", names: names.filter(Boolean) };
  }

  // 3. `def foo(` or `class Bar`
  const defMatch = trimmed.match(/^(?:def|class)\s+([A-Za-z_]\w*)\b/);
  if (defMatch) {
    return { kind: "def", names: [defMatch[1]] };
  }

  // 4. Top-level simple assignment `a = ...` or `a, b = ...`
  const assignMatch = trimmed.match(
    /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)\s*(.+)$/,
  );
  if (assignMatch) {
    const names = assignMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => !PY_KEYWORDS.has(s));
    return { kind: "assign", names };
  }

  return { kind: null, names: [] };
}

export function convertIpynbToPpy(
  rawJson: string,
  options: IpynbImportOptions = { autoExport: true, convertPltShow: true },
): IpynbConversionResult {
  let parsed: RawIpynbRoot;
  try {
    parsed = JSON.parse(rawJson) as RawIpynbRoot;
  } catch (e) {
    return {
      ok: false,
      error: `Invalid JSON in .ipynb file: ${e instanceof Error ? e.message : String(e)}`,
      ppySource: "",
      codeCellCount: 0,
      markdownCellCount: 0,
      autoExportedNames: [],
      convertedPlotsCount: 0,
    };
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.cells)) {
    return {
      ok: false,
      error: 'Not a valid Jupyter Notebook: missing top-level "cells" array.',
      ppySource: "",
      codeCellCount: 0,
      markdownCellCount: 0,
      autoExportedNames: [],
      convertedPlotsCount: 0,
    };
  }

  let codeCellCount = 0;
  let markdownCellCount = 0;
  let convertedPlotsCount = 0;
  const autoExportedSet = new Set<string>();

  // Collect code and markdown cells in order
  interface PreparedCell {
    kind: "code" | "markdown";
    title: string;
    codeLines: string[];
    markdownText: string;
  }

  const prepared: PreparedCell[] = [];

  for (const rawCell of parsed.cells) {
    const type = rawCell.cell_type ?? "code";
    const text = normalizeSource(rawCell.source).replace(/\r\n/g, "\n").replace(/\n+$/, "");

    if (type === "markdown" || type === "raw") {
      if (!text.trim()) continue;
      markdownCellCount++;
      const firstHeading = text.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() ?? "";
      prepared.push({
        kind: "markdown",
        title: firstHeading || `Notes ${markdownCellCount}`,
        codeLines: [],
        markdownText: text,
      });
      continue;
    }

    if (type === "code") {
      codeCellCount++;
      const codeLines = text ? text.split("\n") : [];
      prepared.push({
        kind: "code",
        title: `Cell ${codeCellCount}`,
        codeLines,
        markdownText: "",
      });
    }
  }

  if (prepared.length === 0) {
    prepared.push({
      kind: "code",
      title: "Cell 1",
      codeLines: [],
      markdownText: "",
    });
  }

  // Precompute which identifiers are referenced in each cell
  const cellRefs: Set<string>[] = prepared.map((c) =>
    c.kind === "code" ? extractReferencedIdentifiers(c.codeLines.join("\n")) : new Set<string>(),
  );

  const isUsedInLaterCell = (name: string, fromCellIdx: number): boolean => {
    for (let j = fromCellIdx + 1; j < cellRefs.length; j++) {
      if (cellRefs[j].has(name)) return true;
    }
    return false;
  };

  const outBlocks: string[] = [];

  prepared.forEach((cell, cellIdx) => {
    if (cell.kind === "markdown") {
      const header = cell.title ? `# %% [markdown] ${cell.title}` : "# %% [markdown]";
      const commentedMd = cell.markdownText
        .split("\n")
        .map((line) => (line.length > 0 ? `# ${line}` : "#"))
        .join("\n");
      outBlocks.push(commentedMd ? `${header}\n${commentedMd}` : header);
      return;
    }

    const transformedLines: string[] = [];

    for (const rawLine of cell.codeLines) {
      const trimmed = rawLine.trim();

      // Comment out IPython `%magic` or `!shell` commands
      if (/^[%!]\w/.test(trimmed)) {
        transformedLines.push(`# [Jupyter magic] ${rawLine}`);
        continue;
      }

      // Rewrite `plt.show()` -> `plot plt`
      if (options.convertPltShow && /^(\s*)plt\.show\(\s*\)\s*(#.*)?$/.test(rawLine)) {
        const indent = rawLine.match(/^(\s*)/)?.[1] ?? "";
        const comment = rawLine.match(/(#.*)$/)?.[1] ?? "";
        transformedLines.push(`${indent}plot plt${comment ? "  " + comment : ""}`);
        convertedPlotsCount++;
        continue;
      }

      if (options.autoExport) {
        const defInfo = extractTopLevelDefinedNames(rawLine);
        if (defInfo.kind && defInfo.names.length > 0) {
          const usedLater = defInfo.names.some((n) => isUsedInLaterCell(n, cellIdx));
          if (usedLater) {
            for (const n of defInfo.names) {
              if (isUsedInLaterCell(n, cellIdx)) autoExportedSet.add(n);
            }
            transformedLines.push(`export ${rawLine}`);
            continue;
          }
        }
      }

      transformedLines.push(rawLine);
    }

    const header = cell.title ? `# %% ${cell.title}` : "# %%";
    const body = transformedLines.join("\n").replace(/\n+$/, "");
    outBlocks.push(body ? `${header}\n${body}` : header);
  });

  return {
    ok: true,
    ppySource: outBlocks.join("\n\n") + "\n",
    codeCellCount,
    markdownCellCount,
    autoExportedNames: [...autoExportedSet],
    convertedPlotsCount,
  };
}
