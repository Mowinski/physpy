import { describe, expect, it } from "vitest";
import { parseLatexLog } from "../src/latexLogParser";

describe("parseLatexLog", () => {
  it("extracts classic TeX errors with line number and context", () => {
    const log = [
      "This is pdfTeX, Version 3.141592653",
      "(./main.tex",
      "! Undefined control sequence.",
      "l.42 \\badcommand",
      "                {arg}",
      "! Missing $ inserted.",
      "l.55 x_1",
      ")",
    ].join("\n");

    const parsed = parseLatexLog(log);
    expect(parsed.errorCount).toBe(2);
    expect(parsed.warningCount).toBe(0);
    expect(parsed.entries).toEqual([
      {
        severity: "error",
        file: "./main.tex",
        line: 42,
        message: "Undefined control sequence.",
        context: "\\badcommand",
      },
      {
        severity: "error",
        file: "./main.tex",
        line: 55,
        message: "Missing $ inserted.",
        context: "x_1",
      },
    ]);
  });

  it("extracts -file-line-error entries", () => {
    const log = [
      "./sections/intro.tex:18: LaTeX Error: File `missing.sty' not found.",
      "l.18 \\usepackage{missing}",
    ].join("\n");

    const parsed = parseLatexLog(log);
    expect(parsed.errorCount).toBe(1);
    expect(parsed.entries[0]).toEqual({
      severity: "error",
      file: "./sections/intro.tex",
      line: 18,
      message: "LaTeX Error: File `missing.sty' not found.",
      context: "\\usepackage{missing}",
    });
  });

  it("extracts LaTeX/Package warnings with continuation lines and box notices", () => {
    const log = [
      "(./paper.tex",
      "LaTeX Warning: Reference `fig:missing' on page 2 undefined on input line 73.",
      "",
      "Package hyperref Warning: Token not allowed in a PDF string (Unicode):",
      "(hyperref)                removing `math shift' on input line 12.",
      "",
      "Overfull \\hbox (14.2pt too wide) in paragraph at lines 90--94",
      ")",
    ].join("\n");

    const parsed = parseLatexLog(log);
    expect(parsed.errorCount).toBe(0);
    expect(parsed.warningCount).toBe(2);
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[0]).toMatchObject({
      severity: "warning",
      file: "./paper.tex",
      line: 73,
    });
    expect(parsed.entries[1]).toMatchObject({
      severity: "warning",
      file: "./paper.tex",
      line: 12,
    });
    expect(parsed.entries[1].message).toContain("removing `math shift'");
    expect(parsed.entries[2]).toMatchObject({
      severity: "info",
      file: "./paper.tex",
      line: 90,
    });
  });

  it("returns empty entries for a clean log", () => {
    const parsed = parseLatexLog("Output written on main.pdf (3 pages, 45123 bytes).\n");
    expect(parsed.entries).toEqual([]);
    expect(parsed.errorCount).toBe(0);
    expect(parsed.warningCount).toBe(0);
  });
});
