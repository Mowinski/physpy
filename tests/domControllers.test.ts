// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "mock-worker.js",
}));

import { CsvEditorController } from "../src/csvEditor";
import { LatexEditorController } from "../src/latexEditor";
import { generateStaticNotebookHtml } from "../src/htmlExport";
import {
  createEditor,
  createViewer,
  reconfigureEditorCodeMode,
  reconfigureEditorIndent,
  setDebugLine,
  setDoc,
  setGlobalIndentConfig,
} from "../src/editor/setup";
import { setNotebookExportedConsts } from "../src/editor/constLint";
import type { CellState } from "../src/main";

beforeAll(() => {
  if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => {} }) as DOMRect;
  }
});

describe("DOM & Editor Controllers (jsdom)", () => {
  describe("CsvEditorController", () => {
    it("loads CSV data, renders spreadsheet table, adds rows/cols, sorts, and switches between table & text mode", () => {
      const container = document.createElement("div");
      document.body.append(container);
      const onChange = vi.fn();
      const onSave = vi.fn();
      const states: any[] = [];

      const ctrl = new CsvEditorController({
        container,
        onChange,
        onSave,
        onStateChange: (s) => states.push(s),
        openContextMenu: () => {},
      });

      ctrl.load("Name,Score\nAlice,20\nBob,5\nCharlie,100\n", {
        path: "scores.csv",
      });

      expect(ctrl.getState()).toEqual({
        mode: "table",
        delimiter: ",",
        hasHeader: true,
      });
      expect(container.querySelector(".csv-stats")?.textContent).toBe("3 rows × 2 cols");

      // Sort by Score ascending (numeric sort: 5, 20, 100)
      const sortBtns = container.querySelectorAll<HTMLButtonElement>(".csv-sort-btn");
      expect(sortBtns.length).toBe(2);
      sortBtns[1].click();
      expect(onChange).toHaveBeenCalled();

      const serializedSorted = ctrl.getText();
      expect(serializedSorted).toBe("Name,Score\nBob,5\nAlice,20\nCharlie,100\n");

      // Switch to text mode and back
      ctrl.switchMode("text");
      expect(ctrl.getState().mode).toBe("text");
      expect(ctrl.getText()).toContain("Charlie,100");

      ctrl.switchMode("table");
      expect(ctrl.getState().mode).toBe("table");

      // Add row and column via toolbar buttons
      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".csv-btn"));
      const btnAddRow = buttons.find((b) => b.textContent === "+ Row")!;
      const btnAddCol = buttons.find((b) => b.textContent === "+ Col")!;
      btnAddRow.click();
      btnAddCol.click();

      expect(container.querySelector(".csv-stats")?.textContent).toBe("4 rows × 3 cols");
      expect(ctrl.getText()).toContain("Name,Score,Column 3");

      container.remove();
    });
  });

  describe("CodeMirror 6 Setup, Math Conceal, Matrix Conceal, Const Linter & Debugger Line", () => {
    it("creates a PhysPy code editor with live math symbols, matrix widgets, const lint, and debug line highlighting", () => {
      const host = document.createElement("div");
      document.body.append(host);

      setGlobalIndentConfig(false, 4);
      const view = createEditor({
        parent: host,
        doc: [
          "export const \\rho_0 = 1000 [kg/m^3]",
          "\\rho_0 = 500",
          "M = [1, 2; 3, 4]",
          "y = sqrt(x^2 + 1)",
        ].join("\n"),
        isCode: true,
      });

      // Move cursor to end so widgets on earlier lines are concealed/rendered
      view.dispatch({ selection: { anchor: view.state.doc.length } });

      // Check that const reassignment error widget is rendered
      expect(host.querySelector(".cm-const-error")).not.toBeNull();
      expect(host.querySelector(".cm-const-error-msg")?.textContent).toContain(
        "cannot reassign constant 'ρ_0'",
      );

      // Check unit literal highlight
      expect(host.querySelector(".cm-unit-literal")).not.toBeNull();

      // Check matrix KaTeX widget
      expect(host.querySelector(".cm-math-matrix")).not.toBeNull();

      // Set debugger active line
      view.dispatch({ effects: setDebugLine.of(1) });
      expect(host.querySelector(".cm-debug-active-line")).not.toBeNull();
      view.dispatch({ effects: setDebugLine.of(null) });
      expect(host.querySelector(".cm-debug-active-line")).toBeNull();

      // Test notebook-wide exported const conflict detection
      setNotebookExportedConsts(new Map([["g", [{ cellIndex: 1, line: 1 }]]]), [view]);
      setDoc(view, "g = 10\n");
      expect(host.querySelector(".cm-const-error-msg")?.textContent).toContain(
        "cannot reassign constant 'g'",
      );
      setNotebookExportedConsts(new Map(), [view]);

      // Test indent and code mode reconfiguration
      reconfigureEditorIndent(view, true, 2);
      reconfigureEditorCodeMode(view, false);

      const viewerHost = document.createElement("div");
      const roViewer = createViewer(viewerHost);
      setDoc(roViewer, "x = 42");
      expect(roViewer.state.doc.toString()).toBe("x = 42");

      view.destroy();
      roViewer.destroy();
      host.remove();
    });
  });

  describe("htmlExport (generateStaticNotebookHtml)", () => {
    it("exports markdown, code, deps, and media cells with tables, plots, LaTeX, and stdout", () => {
      const host1 = document.createElement("div");
      const host2 = document.createElement("div");
      const host3 = document.createElement("div");
      const host4 = document.createElement("div");
      const latexWrap = document.createElement("div");
      latexWrap.innerHTML = "<span class='katex-mock'>[1 2; 3 4]</span>";

      const mdView = createEditor({ parent: host1, doc: "# Lab Report\nFormula $E = mc^2$", isCode: false });
      const codeView = createEditor({ parent: host2, doc: "export const g = 9.81 [m/s^2]\nprint(g)", isCode: true });
      const depsView = createEditor({ parent: host3, doc: "numpy\npint\n", isCode: false });
      const mediaView = createEditor({ parent: host4, doc: "", isCode: false });

      const fakeCells = [
        {
          id: 1,
          kind: "markdown",
          title: "Intro",
          view: mdView,
        },
        {
          id: 2,
          kind: "code",
          title: "Gravity Calculation",
          view: codeView,
          lastExported: { g: "9.81 m/s²" },
          lastLatex: "\\begin{pmatrix}1 & 2\\end{pmatrix}",
          latexWrap,
          lastPlots: ["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="],
          lastTables: [
            {
              index_name: "#",
              columns: [{ name: "U", unit: "mV", is_numeric: true }],
              rows: [{ index: "0", cells: ["1.25"] }],
              total_rows: 1,
              truncated: false,
              raw_text: "0  1.25",
            },
          ],
          tableViewMode: "table",
          lastNonTableStdout: "Result: $g = 9.81$\n",
          lastFullStdout: "Result: $g = 9.81$\n",
          lastStderr: "Warning: check calibration",
        },
        {
          id: 3,
          kind: "deps",
          title: "Environment",
          view: depsView,
          venvPath: ".venv",
        },
        {
          id: 4,
          kind: "media",
          title: "Setup Diagram",
          view: mediaView,
          mediaPath: "diagram.png",
        },
      ] as unknown as CellState[];

      const html = generateStaticNotebookHtml(fakeCells, {
        title: "Physics Experiment #1",
        notebookName: "experiment.ppy",
        documentPath: "/tmp/experiment.ppy",
        codeVisibility: "folded",
        selectedCellIds: new Set([1, 2, 3, 4]),
      });

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<title>Physics Experiment #1</title>");
      expect(html).toContain("Gravity Calculation");
      expect(html).toContain("↳ exported: g = 9.81 m/s²");
      expect(html).toContain("katex-mock");
      expect(html).toContain("data:image/png;base64,");
      expect(html).toContain('<span class="nb-unit">[mV]</span>');
      expect(html).toContain("Warning: check calibration");
      expect(html).toContain("2 packages");
      expect(html).toContain('src="diagram.png"');

      // Test hidden codeVisibility mode
      const htmlHidden = generateStaticNotebookHtml(fakeCells, {
        title: "Results Only",
        notebookName: "experiment.ppy",
        documentPath: null,
        codeVisibility: "hidden",
        selectedCellIds: new Set([2, 3]),
      });
      expect(htmlHidden).not.toContain('<details class="nb-code-details"');
      expect(htmlHidden).toContain("↳ exported: g = 9.81 m/s²");

      mdView.destroy();
      codeView.destroy();
      depsView.destroy();
      mediaView.destroy();
    });
  });

  describe("LatexEditorController", () => {
    it("loads LaTeX documents, tracks dirty state, resolves custom build targets, and toggles panes", () => {
      const container = document.createElement("div");
      document.body.append(container);
      const onChange = vi.fn();
      const onSave = vi.fn();
      const setStatus = vi.fn();

      const ctrl = new LatexEditorController({
        container,
        getWorkspaceDir: () => "/workspace",
        onChange,
        onSave,
        setStatus,
      });

      const texSrc = "\\documentclass{article}\n\\begin{document}\n$E = mc^2$\n\\end{document}\n";
      ctrl.load(texSrc, { path: "/workspace/report.tex", dirty: false });

      expect(ctrl.serialize()).toBe(texSrc);
      expect(ctrl.shouldBuildOnSave()).toBe(true);
      expect(ctrl.resolveTargetPath()).toBe("/workspace/report.tex");

      // Custom target override
      const targetInput = container.querySelector<HTMLInputElement>(".latex-target-input")!;
      targetInput.value = "main.tex";
      expect(ctrl.resolveTargetPath()).toBe("main.tex");

      // Mark dirty / saved
      ctrl.markSaved(false);
      expect(container.textContent).toContain("💾 Save*");
      ctrl.markSaved(true);
      expect(container.textContent).toContain("💾 Saved");

      // Scroll to offset
      ctrl.scrollToOffset(10);

      container.remove();
    });
  });
});
