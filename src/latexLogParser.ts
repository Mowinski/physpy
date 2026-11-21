export type LatexLogSeverity = "error" | "warning" | "info";

export interface LatexLogEntry {
  severity: LatexLogSeverity;
  file: string | null;
  line: number | null;
  message: string;
  context?: string;
}

export interface ParsedLatexLog {
  entries: LatexLogEntry[];
  errorCount: number;
  warningCount: number;
}

const FILE_LINE_ERR_RE = /^(.+?\.(?:tex|sty|cls|bib|ltx|dtx)):(\d+):\s+(.+)$/;
const LINE_NUM_RE = /^l\.(\d+)\s*(.*)$/;
const INPUT_LINE_RE = /on input line (\d+)/i;
const LINES_RANGE_RE = /at lines? (\d+)(?:--\d+)?/i;
const BOX_WARNING_RE = /^(Overfull|Underfull)\s+\\(hbox|vbox)\s+\([^)]+\)\s+(.*)$/;
const LATEX_WARN_RE =
  /^(LaTeX(?: Font)? Warning|Package\s+\S+\s+Warning|Class\s+\S+\s+Warning):\s*(.*)$/;

/**
 * Best-effort parser for pdflatex / xelatex / lualatex / latexmk build logs.
 * Extracts errors, warnings, and overfull/underfull box notices into structured rows.
 */
export function parseLatexLog(rawLog: string): ParsedLatexLog {
  const lines = rawLog.replace(/\r\n?/g, "\n").split("\n");
  const entries: LatexLogEntry[] = [];
  const fileStack: Array<string | null> = [];

  const currentFile = (): string | null => {
    for (let k = fileStack.length - 1; k >= 0; k--) {
      if (fileStack[k] !== null) return fileStack[k];
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Track open/close parens for active .tex/.sty/.cls file best-effort
    updateFileStack(line, fileStack);

    // 1. -file-line-error style: ./main.tex:42: Undefined control sequence.
    const flMatch = trimmed.match(FILE_LINE_ERR_RE);
    if (flMatch) {
      const file = flMatch[1].trim();
      const lineNum = Number.parseInt(flMatch[2], 10);
      const message = flMatch[3].trim();
      const context = findNearbyLineContext(lines, i + 1, 4);
      entries.push({
        severity: "error",
        file,
        line: Number.isFinite(lineNum) ? lineNum : null,
        message,
        context: context?.context,
      });
      continue;
    }

    // 2. Classic TeX error: ! Undefined control sequence.
    if (line.startsWith("! ")) {
      const message = line.slice(2).trim();
      // Skip duplicate summary if TeX immediately repeats "!  ==> Fatal error occurred"
      const nearby = findNearbyLineContext(lines, i + 1, 6);
      entries.push({
        severity: "error",
        file: currentFile(),
        line: nearby?.line ?? null,
        message,
        context: nearby?.context,
      });
      if (nearby) {
        i = nearby.consumedIndex;
      }
      continue;
    }

    // 3. LaTeX / Package / Class Warning
    const warnMatch = trimmed.match(LATEX_WARN_RE);
    if (warnMatch) {
      let fullMsg = `${warnMatch[1]}: ${warnMatch[2]}`.trim();
      // Merge immediate continuation lines (indented or "(PackageName)   ...")
      let j = i + 1;
      while (j < lines.length && j <= i + 4) {
        const nextLine = lines[j];
        const nextTrimmed = nextLine.trim();
        if (!nextTrimmed) break;
        if (
          nextLine.startsWith("               ") ||
          /^\([A-Za-z0-9_-]+\)\s+/.test(nextTrimmed)
        ) {
          fullMsg += " " + nextTrimmed.replace(/^\([A-Za-z0-9_-]+\)\s+/, "");
          j++;
        } else {
          break;
        }
      }
      i = j - 1;
      const lineMatch = fullMsg.match(INPUT_LINE_RE);
      entries.push({
        severity: "warning",
        file: currentFile(),
        line: lineMatch ? Number.parseInt(lineMatch[1], 10) : null,
        message: fullMsg,
      });
      continue;
    }

    // 4. Overfull / Underfull hbox/vbox
    const boxMatch = trimmed.match(BOX_WARNING_RE);
    if (boxMatch) {
      const lineMatch = trimmed.match(LINES_RANGE_RE);
      entries.push({
        severity: "info",
        file: currentFile(),
        line: lineMatch ? Number.parseInt(lineMatch[1], 10) : null,
        message: trimmed,
      });
      continue;
    }
  }

  let errorCount = 0;
  let warningCount = 0;
  for (const e of entries) {
    if (e.severity === "error") errorCount++;
    else if (e.severity === "warning") warningCount++;
  }

  return { entries, errorCount, warningCount };
}

function findNearbyLineContext(
  lines: string[],
  startIdx: number,
  maxLookahead: number,
): { line: number; context?: string; consumedIndex: number } | null {
  const end = Math.min(lines.length, startIdx + maxLookahead);
  for (let j = startIdx; j < end; j++) {
    const m = lines[j].match(LINE_NUM_RE);
    if (m) {
      const lineNum = Number.parseInt(m[1], 10);
      const snippet = m[2].trim();
      return {
        line: Number.isFinite(lineNum) ? lineNum : 0,
        context: snippet || undefined,
        consumedIndex: j,
      };
    }
  }
  return null;
}

function updateFileStack(line: string, stack: Array<string | null>): void {
  // Track balanced parentheses: file openings like `(./main.tex` push a filename,
  // non-file parens like `(Unicode)` push `null`, and `)` pops the matching entry.
  if (line.startsWith("! ")) return;
  const fileOpenRe = /^\(([^\s()]+\.(?:tex|sty|cls|bib|ltx|aux|bbl|toc|out))/;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "(") {
      const m = line.slice(i).match(fileOpenRe);
      if (m) {
        stack.push(m[1]);
        i += m[0].length - 1;
      } else {
        stack.push(null);
      }
    } else if (ch === ")") {
      if (stack.length > 0) stack.pop();
    }
  }
}
