import { type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { StreamLanguage, indentUnit } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as backend from "./backend";
import { SYMBOLS } from "./editor/symbols";
import { parseLatexLog, type LatexLogEntry } from "./latexLogParser";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface LatexStreamState {
  inMath: "$" | "$$" | "\\[" | "\\(" | null;
  expectEnvName: boolean;
}

const STRUCTURE_COMMANDS = new Set([
  "documentclass",
  "usepackage",
  "input",
  "include",
  "bibliography",
  "bibliographystyle",
  "addbibresource",
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
  "title",
  "author",
  "date",
  "maketitle",
  "tableofcontents",
  "label",
  "ref",
  "eqref",
  "pageref",
  "cite",
  "parencite",
  "textcite",
  "caption",
  "includegraphics",
  "newcommand",
  "renewcommand",
  "DeclareMathOperator",
]);

const latexStreamLanguage = StreamLanguage.define<LatexStreamState>({
  name: "latex",
  startState(): LatexStreamState {
    return { inMath: null, expectEnvName: false };
  },
  token(stream, state): string | null {
    if (stream.eatSpace()) return null;

    // Comment to end of line
    if (stream.peek() === "%") {
      stream.skipToEnd();
      return "comment";
    }

    // Environment name inside {env} after \begin or \end
    if (state.expectEnvName && stream.peek() === "{") {
      stream.next();
      state.expectEnvName = false;
      stream.eatWhile(/[A-Za-z0-9*_-]/);
      if (stream.peek() === "}") stream.next();
      return "typeName";
    }
    state.expectEnvName = false;

    // Handle $ and $$ math delimiters
    if (stream.match("$$")) {
      if (state.inMath === "$$") {
        state.inMath = null;
      } else if (state.inMath === null) {
        state.inMath = "$$";
      }
      return "keyword";
    }
    if (stream.peek() === "$") {
      stream.next();
      if (state.inMath === "$") {
        state.inMath = null;
      } else if (state.inMath === null) {
        state.inMath = "$";
      }
      return "keyword";
    }

    // Backslash commands
    if (stream.peek() === "\\") {
      stream.next();
      if (stream.match("[")) {
        state.inMath = "\\[";
        return "keyword";
      }
      if (stream.match("]")) {
        if (state.inMath === "\\[") state.inMath = null;
        return "keyword";
      }
      if (stream.match("(")) {
        state.inMath = "\\(";
        return "keyword";
      }
      if (stream.match(")")) {
        if (state.inMath === "\\(") state.inMath = null;
        return "keyword";
      }

      if (stream.eatWhile(/[A-Za-z@]+/)) {
        const cmd = stream.current().slice(1);
        if (cmd === "begin" || cmd === "end") {
          state.expectEnvName = true;
          return "keyword";
        }
        if (STRUCTURE_COMMANDS.has(cmd)) {
          return "keyword";
        }
        return state.inMath ? "atom" : "macroName";
      }
      // Single escaped special char like \{, \}, \%, \&, \\
      stream.next();
      return "operator";
    }

    // Numbers
    if (stream.match(/^\d+(?:\.\d+)?/)) {
      return "number";
    }

    // Brackets and alignment operators
    const ch = stream.next();
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]") {
      return "bracket";
    }
    if (ch === "&" || ch === "~" || ch === "^" || ch === "_") {
      return "operator";
    }

    return state.inMath ? "string" : null;
  },
});

interface LatexSnippetSpec {
  label: string;
  detail: string;
  insert: string;
  cursorOffset?: number;
  type?: string;
}

const LATEX_SNIPPETS: LatexSnippetSpec[] = [
  {
    label: "\\begin{equation}",
    detail: "Numbered equation environment",
    insert: "\\begin{equation}\n\t\n\\end{equation}",
    cursorOffset: 17,
    type: "keyword",
  },
  {
    label: "\\begin{equation*}",
    detail: "Unnumbered equation environment",
    insert: "\\begin{equation*}\n\t\n\\end{equation*}",
    cursorOffset: 18,
    type: "keyword",
  },
  {
    label: "\\begin{align}",
    detail: "Multi-line aligned equations",
    insert: "\\begin{align}\n\t\n\\end{align}",
    cursorOffset: 14,
    type: "keyword",
  },
  {
    label: "\\begin{align*}",
    detail: "Unnumbered aligned equations",
    insert: "\\begin{align*}\n\t\n\\end{align*}",
    cursorOffset: 15,
    type: "keyword",
  },
  {
    label: "\\begin{figure}",
    detail: "Figure with centering, caption & label",
    insert:
      "\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\textwidth]{}\n\t\\caption{}\n\t\\label{fig:}\n\\end{figure}",
    cursorOffset: 72,
    type: "keyword",
  },
  {
    label: "\\begin{table}",
    detail: "Table with tabular, caption & label",
    insert:
      "\\begin{table}[htbp]\n\t\\centering\n\t\\caption{}\n\t\\label{tab:}\n\t\\begin{tabular}{cc}\n\t\t\\hline\n\t\tA & B \\\\\n\t\t\\hline\n\t\t1 & 2 \\\\\n\t\t\\hline\n\t\\end{tabular}\n\\end{table}",
    cursorOffset: 42,
    type: "keyword",
  },
  {
    label: "\\begin{itemize}",
    detail: "Bulleted list",
    insert: "\\begin{itemize}\n\t\\item \n\\end{itemize}",
    cursorOffset: 23,
    type: "keyword",
  },
  {
    label: "\\begin{enumerate}",
    detail: "Numbered list",
    insert: "\\begin{enumerate}\n\t\\item \n\\end{enumerate}",
    cursorOffset: 25,
    type: "keyword",
  },
  {
    label: "\\begin{bmatrix}",
    detail: "Bracketed matrix [ ... ]",
    insert: "\\begin{bmatrix}\n\ta & b \\\\\n\tc & d\n\\end{bmatrix}",
    cursorOffset: 17,
    type: "keyword",
  },
  {
    label: "\\begin{pmatrix}",
    detail: "Parenthesized matrix ( ... )",
    insert: "\\begin{pmatrix}\n\ta & b \\\\\n\tc & d\n\\end{pmatrix}",
    cursorOffset: 17,
    type: "keyword",
  },
  { label: "\\section{}", detail: "Section heading", insert: "\\section{}", cursorOffset: 9, type: "keyword" },
  { label: "\\subsection{}", detail: "Subsection heading", insert: "\\subsection{}", cursorOffset: 12, type: "keyword" },
  { label: "\\subsubsection{}", detail: "Subsubsection heading", insert: "\\subsubsection{}", cursorOffset: 15, type: "keyword" },
  { label: "\\usepackage{}", detail: "Load LaTeX package", insert: "\\usepackage{}", cursorOffset: 12, type: "keyword" },
  { label: "\\input{}", detail: "Include sub-file .tex", insert: "\\input{}", cursorOffset: 7, type: "keyword" },
  { label: "\\include{}", detail: "Include chapter .tex", insert: "\\include{}", cursorOffset: 9, type: "keyword" },
  { label: "\\includegraphics{}", detail: "Insert image/plot", insert: "\\includegraphics[width=0.8\\textwidth]{}", cursorOffset: 38, type: "keyword" },
  { label: "\\frac{}{}", detail: "Fraction a/b", insert: "\\frac{}{}", cursorOffset: 6, type: "function" },
  { label: "\\sqrt{}", detail: "Square root", insert: "\\sqrt{}", cursorOffset: 6, type: "function" },
  { label: "\\textbf{}", detail: "Bold text", insert: "\\textbf{}", cursorOffset: 8, type: "function" },
  { label: "\\textit{}", detail: "Italic text", insert: "\\textit{}", cursorOffset: 8, type: "function" },
  { label: "\\emph{}", detail: "Emphasized text", insert: "\\emph{}", cursorOffset: 6, type: "function" },
  { label: "\\mathrm{}", detail: "Roman upright math font (units)", insert: "\\mathrm{}", cursorOffset: 8, type: "function" },
  { label: "\\vec{}", detail: "Vector arrow above", insert: "\\vec{}", cursorOffset: 5, type: "function" },
  { label: "\\hat{}", detail: "Hat accent above", insert: "\\hat{}", cursorOffset: 5, type: "function" },
  { label: "\\bar{}", detail: "Bar accent above", insert: "\\bar{}", cursorOffset: 5, type: "function" },
  { label: "\\dot{}", detail: "Time derivative dot", insert: "\\dot{}", cursorOffset: 5, type: "function" },
  { label: "\\ddot{}", detail: "Second time derivative double dot", insert: "\\ddot{}", cursorOffset: 6, type: "function" },
  { label: "\\label{}", detail: "Cross-reference label", insert: "\\label{}", cursorOffset: 7, type: "keyword" },
  { label: "\\ref{}", detail: "Reference to label", insert: "\\ref{}", cursorOffset: 5, type: "keyword" },
  { label: "\\eqref{}", detail: "Equation reference (1)", insert: "\\eqref{}", cursorOffset: 7, type: "keyword" },
  { label: "\\cite{}", detail: "Bibliography citation", insert: "\\cite{}", cursorOffset: 6, type: "keyword" },
  { label: "\\sum_{}^{}", detail: "Summation with limits", insert: "\\sum_{}^{}", cursorOffset: 6, type: "function" },
  { label: "\\int_{}^{}", detail: "Integral with limits", insert: "\\int_{}^{}", cursorOffset: 6, type: "function" },
  { label: "\\left( \\right)", detail: "Auto-sized parentheses", insert: "\\left(  \\right)", cursorOffset: 7, type: "function" },
  { label: "\\left[ \\right]", detail: "Auto-sized brackets", insert: "\\left[  \\right]", cursorOffset: 7, type: "function" },
  { label: "\\partial", detail: "Partial derivative ∂", insert: "\\partial", type: "variable" },
  { label: "\\nabla", detail: "Nabla / del ∇", insert: "\\nabla", type: "variable" },
  { label: "\\infty", detail: "Infinity ∞", insert: "\\infty", type: "variable" },
  { label: "\\pm", detail: "Plus-minus ±", insert: "\\pm", type: "variable" },
  { label: "\\times", detail: "Multiplication ×", insert: "\\times", type: "variable" },
  { label: "\\cdot", detail: "Centered dot ·", insert: "\\cdot", type: "variable" },
  { label: "\\approx", detail: "Approximately equal ≈", insert: "\\approx", type: "variable" },
];

const LATEX_COMPLETIONS: Completion[] = [
  ...LATEX_SNIPPETS.map((s): Completion => ({
    label: s.label,
    detail: s.detail,
    type: s.type ?? "keyword",
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      const cursor = from + (s.cursorOffset ?? s.insert.length);
      view.dispatch({
        changes: { from, to, insert: s.insert },
        selection: { anchor: cursor },
      });
    },
  })),
  ...Object.entries(SYMBOLS).map(([name, char]): Completion => ({
    label: `\\${name}`,
    detail: char,
    type: "variable",
  })),
];

function latexCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/\\[A-Za-z{]*$/);
  if (!word) return null;
  return {
    from: word.from,
    options: LATEX_COMPLETIONS,
    validFor: /^\\[A-Za-z]*$/,
  };
}

export type LatexEngine = "pdflatex" | "xelatex" | "lualatex" | "latexmk";

export interface LatexEditorOptions {
  container: HTMLElement;
  getWorkspaceDir: () => string | null;
  onChange: () => void;
  onSave: () => Promise<void> | void;
  onBlur?: () => void;
  setStatus: (msg: string) => void;
}

interface StoredLatexConfig {
  buildOnSave: boolean;
  targetFile: string;
  engine: LatexEngine;
  showPdf: boolean;
  wordWrap: boolean;
}

const LATEX_CFG_STORAGE_KEY = "physpy_latex_build_config_v1";

export class LatexEditorController {
  private readonly root: HTMLElement;
  private readonly opts: LatexEditorOptions;
  private readonly indentCompartment = new Compartment();
  private readonly wrapCompartment = new Compartment();

  private readonly buildOnSaveCheck: HTMLInputElement;
  private readonly targetInput: HTMLInputElement;
  private readonly btnBrowseTarget: HTMLButtonElement;
  private readonly btnUseCurrent: HTMLButtonElement;
  private readonly engineSelect: HTMLSelectElement;
  private readonly btnBuild: HTMLButtonElement;
  private readonly btnToggleWrap: HTMLButtonElement;
  private readonly btnTogglePdf: HTMLButtonElement;
  private readonly btnToggleLog: HTMLButtonElement;
  private readonly btnSave: HTMLButtonElement;
  private readonly buildBadgeEl: HTMLSpanElement;
  private wordWrapEnabled = true;

  private readonly editorHost: HTMLDivElement;
  private readonly editorView: EditorView;
  private readonly pdfPane: HTMLDivElement;
  private readonly pdfHeaderLabel: HTMLSpanElement;
  private readonly pdfZoomLabel: HTMLButtonElement;
  private readonly pdfScrollEl: HTMLDivElement;
  private readonly pdfEmptyEl: HTMLDivElement;
  private readonly logDrawer: HTMLDivElement;
  private readonly logSummaryEl: HTMLSpanElement;
  private readonly btnLogViewMode: HTMLButtonElement;
  private readonly logTableWrap: HTMLDivElement;
  private readonly logPre: HTMLPreElement;
  private showRawLog = false;

  private currentFilePath: string | null = null;
  private suppressChange = false;
  private isBuilding = false;
  private pdfScale = 1.15;
  private lastPdfBytes: Uint8Array | null = null;
  private lastPdfLabel = "";
  private lastRenderedTarget = "";
  private pdfRenderSeq = 0;

  constructor(opts: LatexEditorOptions) {
    this.opts = opts;
    this.root = opts.container;
    this.root.innerHTML = "";
    this.root.className = "latex-editor-root";

    const savedCfg = this.loadStoredConfig();

    const toolbar = document.createElement("div");
    toolbar.className = "csv-toolbar latex-toolbar";

    const buildOnSaveLabel = document.createElement("label");
    buildOnSaveLabel.className = "csv-toolbar-checkbox";
    buildOnSaveLabel.title = "Automatically compile the target .tex file every time you save (Cmd+S)";
    this.buildOnSaveCheck = document.createElement("input");
    this.buildOnSaveCheck.type = "checkbox";
    this.buildOnSaveCheck.checked = savedCfg.buildOnSave;
    const bosSpan = document.createElement("span");
    bosSpan.textContent = "Rebuild on Save";
    buildOnSaveLabel.append(this.buildOnSaveCheck, bosSpan);

    const targetGroup = document.createElement("div");
    targetGroup.className = "latex-target-group";
    const targetLabel = document.createElement("span");
    targetLabel.className = "latex-toolbar-label";
    targetLabel.textContent = "Target .tex:";
    this.targetInput = document.createElement("input");
    this.targetInput.type = "text";
    this.targetInput.className = "latex-target-input";
    this.targetInput.placeholder = "Current file (or e.g. main.tex)";
    this.targetInput.title =
      "Which .tex file to compile on save. Leave empty to compile the currently open .tex file, or specify a root file (e.g. main.tex).";
    this.targetInput.value = savedCfg.targetFile;
    this.targetInput.spellcheck = false;

    this.btnUseCurrent = document.createElement("button");
    this.btnUseCurrent.type = "button";
    this.btnUseCurrent.className = "latex-small-btn";
    this.btnUseCurrent.textContent = "📌 Pin Current";
    this.btnUseCurrent.title = "Set the currently open .tex file as the fixed build target";

    this.btnBrowseTarget = document.createElement("button");
    this.btnBrowseTarget.type = "button";
    this.btnBrowseTarget.className = "latex-small-btn";
    this.btnBrowseTarget.textContent = "📂 Browse…";
    this.btnBrowseTarget.title = "Choose which .tex file is compiled on every save";

    targetGroup.append(targetLabel, this.targetInput, this.btnUseCurrent, this.btnBrowseTarget);

    const engineGroup = document.createElement("label");
    engineGroup.className = "csv-toolbar-field";
    engineGroup.textContent = "Engine:";
    this.engineSelect = document.createElement("select");
    this.engineSelect.className = "csv-select";
    this.engineSelect.innerHTML = `
      <option value="pdflatex">pdflatex</option>
      <option value="xelatex">xelatex</option>
      <option value="lualatex">lualatex</option>
      <option value="latexmk">latexmk -pdf</option>
    `;
    this.engineSelect.value = savedCfg.engine;
    engineGroup.append(this.engineSelect);

    this.btnBuild = document.createElement("button");
    this.btnBuild.type = "button";
    this.btnBuild.className = "primary";
    this.btnBuild.textContent = "▶ Build PDF";
    this.btnBuild.title = "Save and compile the target .tex file now (Cmd+Enter)";

    this.buildBadgeEl = document.createElement("span");
    this.buildBadgeEl.className = "latex-build-badge";
    this.buildBadgeEl.hidden = true;

    const spacer = document.createElement("div");
    spacer.className = "csv-toolbar-spacer";

    this.wordWrapEnabled = savedCfg.wordWrap;
    this.btnToggleWrap = document.createElement("button");
    this.btnToggleWrap.type = "button";
    this.btnToggleWrap.className = `latex-small-btn${this.wordWrapEnabled ? " is-active" : ""}`;
    this.btnToggleWrap.textContent = "↩ Wrap";
    this.btnToggleWrap.title = "Toggle line wrapping so long paragraphs fit inside the editor window";

    this.btnTogglePdf = document.createElement("button");
    this.btnTogglePdf.type = "button";
    this.btnTogglePdf.className = `latex-small-btn${savedCfg.showPdf ? " is-active" : ""}`;
    this.btnTogglePdf.textContent = "📄 PDF Preview";
    this.btnTogglePdf.title = "Toggle live PDF preview pane";

    this.btnToggleLog = document.createElement("button");
    this.btnToggleLog.type = "button";
    this.btnToggleLog.className = "latex-small-btn";
    this.btnToggleLog.textContent = "📋 Log";
    this.btnToggleLog.title = "Toggle LaTeX compiler output log";

    this.btnSave = document.createElement("button");
    this.btnSave.type = "button";
    this.btnSave.textContent = "💾 Save";
    this.btnSave.title = "Save file (Cmd+S)";

    toolbar.append(
      buildOnSaveLabel,
      targetGroup,
      engineGroup,
      this.btnBuild,
      this.buildBadgeEl,
      spacer,
      this.btnToggleWrap,
      this.btnTogglePdf,
      this.btnToggleLog,
      this.btnSave,
    );

    const splitWrap = document.createElement("div");
    splitWrap.className = "latex-split-wrap";

    this.editorHost = document.createElement("div");
    this.editorHost.className = "latex-editor-pane";

    this.pdfPane = document.createElement("div");
    this.pdfPane.className = "latex-pdf-pane";
    this.pdfPane.hidden = !savedCfg.showPdf;

    const pdfHeader = document.createElement("div");
    pdfHeader.className = "latex-pdf-header";
    this.pdfHeaderLabel = document.createElement("span");
    this.pdfHeaderLabel.textContent = "PDF Preview";

    const zoomGroup = document.createElement("div");
    zoomGroup.className = "latex-pdf-zoom-group";
    const btnZoomOut = document.createElement("button");
    btnZoomOut.type = "button";
    btnZoomOut.className = "latex-pdf-zoom-btn";
    btnZoomOut.textContent = "−";
    btnZoomOut.title = "Zoom out";
    btnZoomOut.addEventListener("click", () => {
      this.setPdfZoom(Math.max(0.5, Math.round((this.pdfScale - 0.15) * 100) / 100));
    });

    this.pdfZoomLabel = document.createElement("button");
    this.pdfZoomLabel.type = "button";
    this.pdfZoomLabel.className = "latex-pdf-zoom-btn";
    this.pdfZoomLabel.textContent = "100%";
    this.pdfZoomLabel.title = "Reset zoom";
    this.pdfZoomLabel.addEventListener("click", () => {
      this.setPdfZoom(1.15);
    });

    const btnZoomIn = document.createElement("button");
    btnZoomIn.type = "button";
    btnZoomIn.className = "latex-pdf-zoom-btn";
    btnZoomIn.textContent = "+";
    btnZoomIn.title = "Zoom in";
    btnZoomIn.addEventListener("click", () => {
      this.setPdfZoom(Math.min(3.0, Math.round((this.pdfScale + 0.15) * 100) / 100));
    });

    zoomGroup.append(btnZoomOut, this.pdfZoomLabel, btnZoomIn);
    pdfHeader.append(this.pdfHeaderLabel, zoomGroup);

    this.pdfScrollEl = document.createElement("div");
    this.pdfScrollEl.className = "latex-pdf-scroll";
    this.pdfScrollEl.hidden = true;

    this.pdfEmptyEl = document.createElement("div");
    this.pdfEmptyEl.className = "latex-pdf-empty";
    this.pdfEmptyEl.textContent =
      "Save (⌘S) or click ▶ Build PDF to compile the target .tex file and preview the PDF here.";

    this.pdfPane.append(pdfHeader, this.pdfScrollEl, this.pdfEmptyEl);
    splitWrap.append(this.editorHost, this.pdfPane);

    this.logDrawer = document.createElement("div");
    this.logDrawer.className = "latex-log-drawer";
    this.logDrawer.hidden = true;

    const logHeader = document.createElement("div");
    logHeader.className = "latex-log-header";
    const logTitleGroup = document.createElement("div");
    logTitleGroup.className = "latex-log-title-group";
    const logTitle = document.createElement("span");
    logTitle.textContent = "LaTeX Build Log";
    this.logSummaryEl = document.createElement("span");
    this.logSummaryEl.className = "latex-log-summary";
    logTitleGroup.append(logTitle, this.logSummaryEl);

    const logActions = document.createElement("div");
    logActions.className = "latex-log-actions";
    this.btnLogViewMode = document.createElement("button");
    this.btnLogViewMode.type = "button";
    this.btnLogViewMode.className = "latex-small-btn";
    this.btnLogViewMode.textContent = "Raw Log";
    this.btnLogViewMode.title = "Switch between parsed error table and raw compiler log";
    this.btnLogViewMode.addEventListener("click", () => {
      this.showRawLog = !this.showRawLog;
      this.syncLogViewMode();
    });

    const btnCloseLog = document.createElement("button");
    btnCloseLog.type = "button";
    btnCloseLog.className = "sidebar-icon-btn";
    btnCloseLog.textContent = "✕";
    btnCloseLog.addEventListener("click", () => {
      this.logDrawer.hidden = true;
      this.btnToggleLog.classList.remove("is-active");
    });
    logActions.append(this.btnLogViewMode, btnCloseLog);
    logHeader.append(logTitleGroup, logActions);

    this.logTableWrap = document.createElement("div");
    this.logTableWrap.className = "latex-log-table-wrap";
    const emptyLogMsg = document.createElement("div");
    emptyLogMsg.className = "latex-log-empty";
    emptyLogMsg.textContent = "No build log yet.";
    this.logTableWrap.append(emptyLogMsg);

    this.logPre = document.createElement("pre");
    this.logPre.className = "latex-log-pre";
    this.logPre.textContent = "No build log yet.";
    this.logPre.hidden = true;
    this.logDrawer.append(logHeader, this.logTableWrap, this.logPre);

    this.root.append(toolbar, splitWrap, this.logDrawer);

    const extensions: Extension[] = [
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            void this.opts.onSave();
            return true;
          },
          preventDefault: true,
        },
        {
          key: "Mod-Enter",
          run: () => {
            void this.saveAndBuildNow();
            return true;
          },
          preventDefault: true,
        },
        {
          key: "Shift-Enter",
          run: () => {
            void this.saveAndBuildNow();
            return true;
          },
          preventDefault: true,
        },
      ]),
      basicSetup,
      keymap.of([indentWithTab]),
      this.indentCompartment.of([indentUnit.of("  "), EditorState.tabSize.of(2)]),
      this.wrapCompartment.of(this.wordWrapEnabled ? [EditorView.lineWrapping] : []),
      latexStreamLanguage,
      EditorState.languageData.of(() => [{ autocomplete: latexCompletionSource }]),
      oneDark,
      EditorView.domEventHandlers({
        blur: () => {
          this.opts.onBlur?.();
          return false;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !this.suppressChange) {
          this.opts.onChange();
        }
      }),
    ];

    this.editorView = new EditorView({
      parent: this.editorHost,
      state: EditorState.create({ doc: "", extensions }),
    });

    this.bindEvents();
  }

  private bindEvents(): void {
    this.buildOnSaveCheck.addEventListener("change", () => {
      this.saveStoredConfig();
    });

    this.targetInput.addEventListener("change", () => {
      this.saveStoredConfig();
    });

    this.engineSelect.addEventListener("change", () => {
      this.saveStoredConfig();
    });

    this.btnUseCurrent.addEventListener("click", async () => {
      if (!this.currentFilePath) return;
      const ws = this.opts.getWorkspaceDir();
      if (ws && backend.inTauri) {
        try {
          const rel = await backend.computeRelativePath(ws, this.currentFilePath);
          this.targetInput.value = rel;
        } catch {
          this.targetInput.value = this.currentFilePath;
        }
      } else {
        this.targetInput.value = this.currentFilePath;
      }
      this.saveStoredConfig();
      this.opts.setStatus(`Pinned LaTeX build target to ${this.targetInput.value}`);
    });

    this.btnBrowseTarget.addEventListener("click", async () => {
      if (!backend.inTauri) return;
      const picked = await backend.pickLatexTargetFile(
        this.opts.getWorkspaceDir() ?? this.currentFilePath,
      );
      if (!picked) return;
      const ws = this.opts.getWorkspaceDir();
      if (ws) {
        try {
          const rel = await backend.computeRelativePath(ws, picked);
          this.targetInput.value = rel.startsWith("..") ? picked : rel;
        } catch {
          this.targetInput.value = picked;
        }
      } else {
        this.targetInput.value = picked;
      }
      this.saveStoredConfig();
      this.opts.setStatus(`Set LaTeX build target on save: ${this.targetInput.value}`);
    });

    this.btnBuild.addEventListener("click", () => {
      void this.saveAndBuildNow();
    });

    this.btnToggleWrap.addEventListener("click", () => {
      this.wordWrapEnabled = !this.wordWrapEnabled;
      this.btnToggleWrap.classList.toggle("is-active", this.wordWrapEnabled);
      this.editorView.dispatch({
        effects: this.wrapCompartment.reconfigure(
          this.wordWrapEnabled ? [EditorView.lineWrapping] : [],
        ),
      });
      this.saveStoredConfig();
    });

    this.btnTogglePdf.addEventListener("click", () => {
      this.pdfPane.hidden = !this.pdfPane.hidden;
      this.btnTogglePdf.classList.toggle("is-active", !this.pdfPane.hidden);
      this.saveStoredConfig();
    });

    this.btnToggleLog.addEventListener("click", () => {
      this.logDrawer.hidden = !this.logDrawer.hidden;
      this.btnToggleLog.classList.toggle("is-active", !this.logDrawer.hidden);
    });

    this.btnSave.addEventListener("click", () => {
      void this.opts.onSave();
    });
  }

  private loadStoredConfig(): StoredLatexConfig {
    try {
      const raw = localStorage.getItem(LATEX_CFG_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          buildOnSave: parsed.buildOnSave !== false,
          targetFile: typeof parsed.targetFile === "string" ? parsed.targetFile : "",
          engine:
            parsed.engine === "xelatex" ||
            parsed.engine === "lualatex" ||
            parsed.engine === "latexmk"
              ? parsed.engine
              : "pdflatex",
          showPdf: parsed.showPdf !== false,
          wordWrap: parsed.wordWrap !== false,
        };
      }
    } catch {
      // Ignore storage errors
    }
    return {
      buildOnSave: true,
      targetFile: "",
      engine: "pdflatex",
      showPdf: true,
      wordWrap: true,
    };
  }

  private saveStoredConfig(): void {
    try {
      const cfg: StoredLatexConfig = {
        buildOnSave: this.buildOnSaveCheck.checked,
        targetFile: this.targetInput.value.trim(),
        engine: (this.engineSelect.value as LatexEngine) || "pdflatex",
        showPdf: !this.pdfPane.hidden,
        wordWrap: this.wordWrapEnabled,
      };
      localStorage.setItem(LATEX_CFG_STORAGE_KEY, JSON.stringify(cfg));
    } catch {
      // Ignore storage errors
    }
  }

  public load(content: string, opts: { path: string | null; dirty: boolean }): void {
    const prevTarget = this.resolveTargetPath(this.currentFilePath) ?? "";
    this.currentFilePath = opts.path;
    this.suppressChange = true;
    this.editorView.dispatch({
      changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
    });
    this.suppressChange = false;
    this.markSaved(!opts.dirty);

    const nextTarget = this.resolveTargetPath(this.currentFilePath) ?? "";
    // Load existing compiled PDF preview if target changed or no PDF rendered yet
    if (nextTarget !== prevTarget || !this.lastPdfBytes) {
      void this.tryLoadExistingPdfPreview();
    }
  }

  public serialize(): string {
    return this.editorView.state.doc.toString();
  }

  public focus(): void {
    this.editorView.focus();
  }

  public scrollToOffset(offset: number): void {
    const safePos = Math.max(0, Math.min(this.editorView.state.doc.length, offset));
    this.editorView.dispatch({
      selection: { anchor: safePos },
      scrollIntoView: true,
    });
    this.editorView.focus();
  }

  public markSaved(saved = true): void {
    this.btnSave.textContent = saved ? "💾 Saved" : "💾 Save*";
  }

  public shouldBuildOnSave(): boolean {
    return this.buildOnSaveCheck.checked;
  }

  public resolveTargetPath(fallbackPath?: string | null): string | null {
    const customTarget = this.targetInput.value.trim();
    if (customTarget) {
      return customTarget;
    }
    return fallbackPath ?? this.currentFilePath;
  }

  private async tryLoadExistingPdfPreview(): Promise<void> {
    if (!backend.inTauri) return;
    const target = this.resolveTargetPath(this.currentFilePath);
    if (!target || !/\.tex$/i.test(target)) return;
    const pdfCandidate = target.replace(/\.tex$/i, ".pdf");
    const baseDir =
      this.opts.getWorkspaceDir() ??
      (this.currentFilePath ? this.currentFilePath.replace(/[\\/][^\\/]+$/, "") : null);
    try {
      const bytes = await backend.readBinaryFile(pdfCandidate, baseDir);
      this.showPdfBytes(bytes, pdfCandidate.split(/[\\/]/).pop() || "output.pdf");
    } catch {
      // PDF does not exist yet
    }
  }

  private setPdfZoom(nextScale: number): void {
    this.pdfScale = nextScale;
    const pct = Math.round((this.pdfScale / 1.15) * 100);
    this.pdfZoomLabel.textContent = `${pct}%`;
    if (this.lastPdfBytes) {
      void this.renderPdfDocument(this.lastPdfBytes, this.lastPdfLabel, true);
    }
  }

  private showPdfBytes(bytes: number[] | Uint8Array, label: string): void {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const currentTarget = this.resolveTargetPath(this.currentFilePath) ?? label;
    const preserveScroll = this.lastRenderedTarget === currentTarget;
    this.lastRenderedTarget = currentTarget;
    this.lastPdfBytes = u8;
    this.lastPdfLabel = label;
    void this.renderPdfDocument(u8, label, preserveScroll);
  }

  private async renderPdfDocument(
    bytes: Uint8Array,
    label: string,
    preserveScroll: boolean,
  ): Promise<void> {
    const seq = ++this.pdfRenderSeq;
    const prevScrollTop = preserveScroll ? this.pdfScrollEl.scrollTop : 0;
    const prevScrollLeft = preserveScroll ? this.pdfScrollEl.scrollLeft : 0;

    try {
      // Pass a copy of bytes because pdf.js worker transfers the ArrayBuffer
      const dataCopy = bytes.slice();
      const loadingTask = pdfjsLib.getDocument({ data: dataCopy });
      const pdfDoc = await loadingTask.promise;
      if (seq !== this.pdfRenderSeq) {
        void loadingTask.destroy();
        return;
      }

      const numPages = pdfDoc.numPages;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const existingWraps = Array.from(
        this.pdfScrollEl.querySelectorAll<HTMLDivElement>(".latex-pdf-page-wrap"),
      );

      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        if (seq !== this.pdfRenderSeq) {
          void loadingTask.destroy();
          return;
        }
        const viewport = page.getViewport({ scale: this.pdfScale });
        const cssWidth = Math.floor(viewport.width);
        const cssHeight = Math.floor(viewport.height);

        const offCanvas = document.createElement("canvas");
        offCanvas.className = "latex-pdf-canvas";
        offCanvas.width = Math.floor(cssWidth * dpr);
        offCanvas.height = Math.floor(cssHeight * dpr);
        offCanvas.style.width = `${cssWidth}px`;
        offCanvas.style.height = `${cssHeight}px`;

        const ctx = offCanvas.getContext("2d");
        if (ctx) {
          ctx.scale(dpr, dpr);
          await page.render({
            canvasContext: ctx,
            canvas: offCanvas,
            viewport,
          }).promise;
        }

        if (seq !== this.pdfRenderSeq) {
          void loadingTask.destroy();
          return;
        }

        const existingWrap = existingWraps[pageNum - 1];
        if (existingWrap) {
          existingWrap.style.width = `${cssWidth}px`;
          existingWrap.style.height = `${cssHeight}px`;
          const oldCanvas = existingWrap.querySelector("canvas");
          if (oldCanvas) {
            existingWrap.replaceChild(offCanvas, oldCanvas);
          } else {
            existingWrap.append(offCanvas);
          }
        } else {
          const wrap = document.createElement("div");
          wrap.className = "latex-pdf-page-wrap";
          wrap.style.width = `${cssWidth}px`;
          wrap.style.height = `${cssHeight}px`;
          wrap.append(offCanvas);
          this.pdfScrollEl.append(wrap);
        }
      }

      // Remove extra pages if the new document has fewer pages
      while (this.pdfScrollEl.children.length > numPages) {
        this.pdfScrollEl.lastElementChild?.remove();
      }

      this.pdfScrollEl.hidden = false;
      this.pdfEmptyEl.hidden = true;

      if (preserveScroll) {
        this.pdfScrollEl.scrollTop = prevScrollTop;
        this.pdfScrollEl.scrollLeft = prevScrollLeft;
      } else {
        this.pdfScrollEl.scrollTop = 0;
      }

      const now = new Date().toLocaleTimeString();
      this.pdfHeaderLabel.textContent = `📄 ${label} · ${numPages} ${numPages === 1 ? "page" : "pages"} (${now})`;
      void loadingTask.destroy();
    } catch (err) {
      console.warn("PDF render error:", err);
    }
  }

  public async saveAndBuildNow(): Promise<void> {
    await this.opts.onSave();
    // If buildOnSave is off, trigger the build explicitly after saving
    if (!this.buildOnSaveCheck.checked) {
      await this.triggerBuild(this.currentFilePath);
    }
  }

  public async triggerBuild(savedFilePath?: string | null): Promise<void> {
    if (!backend.inTauri || this.isBuilding) return;
    const target = this.resolveTargetPath(savedFilePath ?? this.currentFilePath);
    if (!target) {
      this.opts.setStatus("Save the .tex file or specify a target .tex file first.");
      return;
    }

    const baseDir =
      this.opts.getWorkspaceDir() ??
      (savedFilePath
        ? savedFilePath.replace(/[\\/][^\\/]+$/, "")
        : this.currentFilePath
          ? this.currentFilePath.replace(/[\\/][^\\/]+$/, "")
          : null);
    const engine = (this.engineSelect.value as LatexEngine) || "pdflatex";

    this.isBuilding = true;
    this.btnBuild.disabled = true;
    this.btnBuild.textContent = "⏳ Building…";
    this.buildBadgeEl.hidden = false;
    this.buildBadgeEl.className = "latex-build-badge is-building";
    this.buildBadgeEl.textContent = `Building ${target.split(/[\\/]/).pop()}…`;

    try {
      const res = await backend.buildLatex(target, baseDir, engine);
      this.renderBuildLog(res.log || "", !res.success);
      if (res.success) {
        this.buildBadgeEl.className = "latex-build-badge is-ok";
        const shortTarget = res.resolved_target.split(/[\\/]/).pop() || target;
        this.buildBadgeEl.textContent = `✓ Built ${shortTarget}`;
        this.opts.setStatus(`LaTeX build succeeded (${engine}): ${shortTarget}`);
        if (res.pdf_path) {
          try {
            const bytes = await backend.readBinaryFile(res.pdf_path, null);
            this.showPdfBytes(bytes, res.pdf_path.split(/[\\/]/).pop() || "output.pdf");
          } catch (readErr) {
            console.warn("Could not read compiled PDF:", readErr);
          }
        }
      } else {
        this.buildBadgeEl.className = "latex-build-badge is-err";
        this.buildBadgeEl.textContent = "✕ Build failed";
        this.logDrawer.hidden = false;
        this.btnToggleLog.classList.add("is-active");
        this.opts.setStatus(`LaTeX build failed (${engine}) — see Build Log`);
      }
    } catch (err) {
      this.renderBuildLog(String(err), true);
      this.buildBadgeEl.className = "latex-build-badge is-err";
      this.buildBadgeEl.textContent = "✕ Build error";
      this.logDrawer.hidden = false;
      this.btnToggleLog.classList.add("is-active");
      this.opts.setStatus(`LaTeX build error: ${String(err)}`);
    } finally {
      this.isBuilding = false;
      this.btnBuild.disabled = false;
      this.btnBuild.textContent = "▶ Build PDF";
    }
  }

  private syncLogViewMode(): void {
    this.logTableWrap.hidden = this.showRawLog;
    this.logPre.hidden = !this.showRawLog;
    this.btnLogViewMode.textContent = this.showRawLog ? "Errors Table" : "Raw Log";
    this.btnLogViewMode.classList.toggle("is-active", this.showRawLog);
  }

  private jumpToLine(lineNum: number): void {
    const doc = this.editorView.state.doc;
    if (lineNum < 1 || lineNum > doc.lines) return;
    const lineInfo = doc.line(lineNum);
    this.editorView.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
    });
    this.editorView.focus();
  }

  private renderBuildLog(rawLog: string, failed: boolean): void {
    this.logPre.textContent = rawLog || "(no compiler output)";
    const parsed = parseLatexLog(rawLog);
    const entries: LatexLogEntry[] = [...parsed.entries];

    if (failed && entries.length === 0 && rawLog.trim()) {
      const firstLine =
        rawLog
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find(Boolean) || "LaTeX build failed";
      entries.push({
        severity: "error",
        file: null,
        line: null,
        message: firstLine,
      });
    }

    const errCount = entries.filter((e) => e.severity === "error").length;
    const warnCount = entries.filter((e) => e.severity === "warning").length;
    const infoCount = entries.filter((e) => e.severity === "info").length;

    const summaryParts: string[] = [];
    if (errCount > 0) summaryParts.push(`${errCount} error${errCount === 1 ? "" : "s"}`);
    if (warnCount > 0) summaryParts.push(`${warnCount} warning${warnCount === 1 ? "" : "s"}`);
    if (infoCount > 0) summaryParts.push(`${infoCount} box`);
    this.logSummaryEl.textContent = summaryParts.length > 0 ? `(${summaryParts.join(", ")})` : "(No issues)";
    this.logSummaryEl.className = `latex-log-summary${errCount > 0 ? " has-errors" : warnCount > 0 ? " has-warnings" : ""}`;

    this.logTableWrap.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "latex-log-empty";
      empty.textContent = rawLog.trim()
        ? "No errors or warnings detected in build log."
        : "(no compiler output)";
      this.logTableWrap.append(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "latex-log-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const col of ["Type", "Line", "File", "Message"]) {
      const th = document.createElement("th");
      th.textContent = col;
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    for (const entry of entries) {
      const tr = document.createElement("tr");
      tr.className = `is-${entry.severity}${entry.line !== null ? " is-clickable" : ""}`;
      if (entry.line !== null) {
        tr.title = `Jump to line ${entry.line}`;
        tr.addEventListener("click", () => this.jumpToLine(entry.line!));
      }

      const tdType = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `latex-log-badge is-${entry.severity}`;
      badge.textContent =
        entry.severity === "error" ? "Error" : entry.severity === "warning" ? "Warning" : "Info";
      tdType.append(badge);

      const tdLine = document.createElement("td");
      tdLine.className = "latex-log-line";
      tdLine.textContent = entry.line !== null ? String(entry.line) : "—";

      const tdFile = document.createElement("td");
      tdFile.className = "latex-log-file";
      if (entry.file) {
        tdFile.textContent = entry.file.split(/[\\/]/).pop() || entry.file;
        tdFile.title = entry.file;
      } else {
        tdFile.textContent = "—";
      }

      const tdMsg = document.createElement("td");
      tdMsg.className = "latex-log-msg";
      const msgMain = document.createElement("div");
      msgMain.textContent = entry.message;
      tdMsg.append(msgMain);
      if (entry.context) {
        const msgCtx = document.createElement("code");
        msgCtx.className = "latex-log-ctx";
        msgCtx.textContent = entry.context;
        tdMsg.append(msgCtx);
      }

      tr.append(tdType, tdLine, tdFile, tdMsg);
      tbody.append(tr);
    }
    table.append(tbody);
    this.logTableWrap.append(table);
  }
}
