import "katex/dist/katex.min.css";
import "./styles.css";
import type { EditorView } from "@codemirror/view";
import demo from "../examples/demo.ppy?raw";
import * as backend from "./backend";
import { createEditor, createViewer, setDoc } from "./editor/setup";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface CellState {
  id: number;
  title: string;
  view: EditorView;
  el: HTMLElement;
  badgeEl: HTMLSpanElement;
  titleInput: HTMLInputElement;
  outputWrap: HTMLDivElement;
  outputPre: HTMLPreElement;
  plotsWrap: HTMLDivElement;
  exportedBar: HTMLDivElement;
  runCount: number | null;
}

let nextCellId = 1;
let execCounter = 0;
let currentPath: string | null = null;
let dirty = false;
const cells: CellState[] = [];

const notebookEl = $<HTMLDivElement>("notebook");
const status = $<HTMLSpanElement>("status");
const pythonPane = $<HTMLDivElement>("python-pane");
const exportsListEl = $<HTMLDivElement>("exports-list");
const viewer = createViewer($("python"));

function setStatus(text: string) {
  status.textContent = text;
}

function updateTitle() {
  const name = currentPath?.split(/[\\/]/).pop() ?? "untitled.ppy";
  document.title = `${dirty ? "● " : ""}${name} — PhysPy`;
}

function requireTauri(): boolean {
  if (backend.inTauri) return true;
  setStatus("Running Python requires the desktop app (npm run tauri dev).");
  return false;
}

// --- Parsing & serializing `# %%` cells ------------------------------------

interface ParsedCell {
  title: string;
  source: string;
}

const CELL_HEADER_RE = /^# %%[^\S\n]*(.*)$/gm;

function parseDocument(src: string): ParsedCell[] {
  const matches = [...src.matchAll(CELL_HEADER_RE)];
  if (matches.length === 0) {
    return [{ title: "", source: src }];
  }
  const out: ParsedCell[] = [];
  if (matches[0].index! > 0) {
    const pre = src.slice(0, matches[0].index!);
    if (pre.trim()) {
      out.push({ title: "", source: pre.replace(/\n+$/, "") });
    }
  }
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const title = m[1].trim();
    let bodyStart = m.index! + m[0].length;
    if (src[bodyStart] === "\n") bodyStart++;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index! : src.length;
    const body = src.slice(bodyStart, bodyEnd).replace(/\n+$/, "");
    out.push({ title, source: body });
  }
  return out.length ? out : [{ title: "", source: "" }];
}

function serializeDocument(): string {
  return (
    cells
      .map((c) => {
        const header = c.title.trim() ? `# %% ${c.title.trim()}` : "# %%";
        const body = c.view.state.doc.toString().replace(/\n+$/, "");
        return `${header}\n${body}\n`;
      })
      .join("\n")
      .replace(/\n+$/, "") + "\n"
  );
}

// --- Exports bar rendering -------------------------------------------------

function renderSessionExports(allExports: Record<string, string>) {
  exportsListEl.innerHTML = "";
  const entries = Object.entries(allExports);
  if (entries.length === 0) {
    const empty = document.createElement("span");
    empty.className = "exports-empty";
    empty.innerHTML = "none (use <code>export x = …</code> in a cell)";
    exportsListEl.append(empty);
    return;
  }
  for (const [name, val] of entries) {
    const pill = document.createElement("span");
    pill.className = "export-pill";
    pill.innerHTML = `<strong></strong> = <span></span>`;
    pill.querySelector("strong")!.textContent = name;
    pill.querySelector("span")!.textContent = val;
    exportsListEl.append(pill);
  }
}

// --- Cell lifecycle --------------------------------------------------------

function renumberCells() {
  cells.forEach((c, idx) => {
    const num = c.runCount ?? " ";
    c.badgeEl.textContent = `In [${num}]`;
    c.badgeEl.title = `Cell ${idx + 1}`;
  });
}

function markDirty() {
  dirty = true;
  updateTitle();
  clearTimeout(transpileTimer);
  transpileTimer = window.setTimeout(refreshPython, 400);
}

function createCellCard(initial: ParsedCell, insertAt?: number): CellState {
  const id = nextCellId++;
  const card = document.createElement("div");
  card.className = "cell-card";

  const header = document.createElement("div");
  header.className = "cell-header";

  const badgeEl = document.createElement("span");
  badgeEl.className = "cell-badge";
  badgeEl.textContent = "In [ ]";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "cell-title";
  titleInput.placeholder = "Cell title (optional)…";
  titleInput.value = initial.title;
  titleInput.addEventListener("input", () => {
    state.title = titleInput.value;
    markDirty();
  });

  const actions = document.createElement("div");
  actions.className = "cell-actions";

  const btnRun = document.createElement("button");
  btnRun.className = "cell-btn run";
  btnRun.innerHTML = "▶ Run <kbd>⌘↵</kbd>";
  btnRun.title = "Run this cell (Cmd+Enter or Shift+Enter)";

  const btnAdd = document.createElement("button");
  btnAdd.className = "cell-btn";
  btnAdd.textContent = "+ Below";
  btnAdd.title = "Insert a cell below";

  const btnUp = document.createElement("button");
  btnUp.className = "cell-btn";
  btnUp.textContent = "↑";
  btnUp.title = "Move cell up";

  const btnDown = document.createElement("button");
  btnDown.className = "cell-btn";
  btnDown.textContent = "↓";
  btnDown.title = "Move cell down";

  const btnDel = document.createElement("button");
  btnDel.className = "cell-btn danger";
  btnDel.textContent = "✕";
  btnDel.title = "Delete cell";

  actions.append(btnRun, btnAdd, btnUp, btnDown, btnDel);
  header.append(badgeEl, titleInput, actions);

  const editorHost = document.createElement("div");
  editorHost.className = "cell-editor";

  const outputWrap = document.createElement("div");
  outputWrap.className = "cell-output-wrap";
  outputWrap.hidden = true;

  const exportedBar = document.createElement("div");
  exportedBar.className = "cell-exported";
  exportedBar.hidden = true;

  const outputPre = document.createElement("pre");
  outputPre.className = "cell-output";

  const plotsWrap = document.createElement("div");
  plotsWrap.className = "cell-plots";
  plotsWrap.hidden = true;

  outputWrap.append(exportedBar, outputPre, plotsWrap);
  card.append(header, editorHost, outputWrap);

  const view = createEditor({
    parent: editorHost,
    doc: initial.source,
    keys: [
      { key: "Mod-Enter", run: () => (void runSingleCell(state, false), true) },
      { key: "Shift-Enter", run: () => (void runSingleCell(state, true), true) },
      { key: "Mod-Shift-Enter", run: () => (void runAllCells(), true) },
      { key: "Mod-s", run: () => (void saveFile(), true) },
      { key: "Mod-o", run: () => (void openFile(), true) },
      { key: "Mod-p", run: () => togglePython() },
    ],
    onChange: markDirty,
  });

  const state: CellState = {
    id,
    title: initial.title,
    view,
    el: card,
    badgeEl,
    titleInput,
    outputWrap,
    outputPre,
    plotsWrap,
    exportedBar,
    runCount: null,
  };

  btnRun.addEventListener("click", () => void runSingleCell(state, false));
  btnAdd.addEventListener("click", () => {
    const idx = cells.indexOf(state);
    const created = createCellCard({ title: "", source: "" }, idx + 1);
    markDirty();
    created.view.focus();
  });
  btnUp.addEventListener("click", () => moveCell(state, -1));
  btnDown.addEventListener("click", () => moveCell(state, 1));
  btnDel.addEventListener("click", () => deleteCell(state));

  if (insertAt !== undefined && insertAt < cells.length) {
    notebookEl.insertBefore(card, cells[insertAt].el);
    cells.splice(insertAt, 0, state);
  } else {
    notebookEl.append(card);
    cells.push(state);
  }
  renumberCells();
  return state;
}

function moveCell(cell: CellState, delta: -1 | 1) {
  const idx = cells.indexOf(cell);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= cells.length) return;
  cells.splice(idx, 1);
  cells.splice(target, 0, cell);
  if (delta === -1) {
    notebookEl.insertBefore(cell.el, cells[target + 1].el);
  } else {
    notebookEl.insertBefore(cell.el, cells[target - 1].el.nextSibling);
  }
  renumberCells();
  markDirty();
}

function deleteCell(cell: CellState) {
  if (cells.length <= 1) {
    setDoc(cell.view, "");
    cell.titleInput.value = "";
    cell.title = "";
    cell.outputWrap.hidden = true;
    markDirty();
    return;
  }
  const idx = cells.indexOf(cell);
  if (idx < 0) return;
  cell.view.destroy();
  cell.el.remove();
  cells.splice(idx, 1);
  renumberCells();
  markDirty();
}

function loadDocumentIntoCells(src: string) {
  for (const c of cells) {
    c.view.destroy();
    c.el.remove();
  }
  cells.length = 0;
  for (const parsed of parseDocument(src)) {
    createCellCard(parsed);
  }
}

// --- Execution -------------------------------------------------------------

async function runSingleCell(cell: CellState, advanceFocus: boolean): Promise<boolean> {
  if (!requireTauri()) return true;
  const idx = cells.indexOf(cell);
  setStatus(`Running cell ${idx + 1}…`);
  cell.el.classList.add("running");

  try {
    const res = await backend.runCell(cell.view.state.doc.toString(), currentPath, idx + 1);
    cell.runCount = ++execCounter;
    renumberCells();

    const exportedEntries = Object.entries(res.exported);
    if (exportedEntries.length > 0) {
      cell.exportedBar.hidden = false;
      cell.exportedBar.textContent =
        "↳ exported: " + exportedEntries.map(([k, v]) => `${k} = ${v}`).join(", ");
    } else {
      cell.exportedBar.hidden = true;
    }

    cell.outputPre.innerHTML = "";
    if (res.stdout) cell.outputPre.append(res.stdout);
    if (res.stderr) {
      const err = document.createElement("span");
      err.className = "stderr";
      err.textContent = res.stderr;
      cell.outputPre.append(err);
    }

    cell.plotsWrap.innerHTML = "";
    const plots = res.plots ?? [];
    for (const b64 of plots) {
      const img = document.createElement("img");
      img.className = "cell-plot";
      img.src = `data:image/png;base64,${b64}`;
      img.alt = "matplotlib plot";
      cell.plotsWrap.append(img);
    }
    cell.plotsWrap.hidden = plots.length === 0;

    const hasOut = Boolean(
      res.stdout || res.stderr || exportedEntries.length > 0 || plots.length > 0,
    );
    cell.outputWrap.hidden = !hasOut;
    cell.outputPre.hidden = !(res.stdout || res.stderr);

    renderSessionExports(res.all_exports);
    setStatus(`Cell ${idx + 1} finished (exit code ${res.code})`);

    if (advanceFocus) {
      if (idx + 1 < cells.length) {
        cells[idx + 1].view.focus();
      } else {
        const next = createCellCard({ title: "", source: "" });
        markDirty();
        next.view.focus();
      }
    }
    return res.code === 0;
  } catch (e) {
    cell.outputWrap.hidden = false;
    cell.outputPre.hidden = false;
    cell.outputPre.textContent = String(e);
    setStatus("Error");
    return false;
  } finally {
    cell.el.classList.remove("running");
  }
}

async function resetSession(quiet = false): Promise<boolean> {
  if (!requireTauri()) return true;
  await backend.resetSession();
  execCounter = 0;
  for (const c of cells) {
    c.runCount = null;
    c.outputWrap.hidden = true;
  }
  renumberCells();
  renderSessionExports({});
  if (!quiet) setStatus("Session reset (all exported variables cleared)");
  return true;
}

async function runAllCells(): Promise<boolean> {
  if (!requireTauri()) return true;
  await resetSession(true);
  for (const c of cells) {
    const ok = await runSingleCell(c, false);
    if (!ok) break;
  }
  return true;
}

// --- Python preview & File I/O ---------------------------------------------

let transpileTimer: number | undefined;
async function refreshPython() {
  if (pythonPane.hidden || !backend.inTauri) return;
  try {
    setDoc(viewer, await backend.transpile(serializeDocument()));
  } catch (e) {
    setDoc(viewer, `# ${String(e).trim().replace(/\n/g, "\n# ")}`);
  }
}

function togglePython(): boolean {
  pythonPane.hidden = !pythonPane.hidden;
  void refreshPython();
  return true;
}

async function openFile(): Promise<boolean> {
  if (!requireTauri()) return true;
  const file = await backend.openFile();
  if (file) {
    currentPath = file.path;
    await resetSession(true);
    loadDocumentIntoCells(file.contents);
    dirty = false;
    updateTitle();
    void refreshPython();
  }
  return true;
}

async function saveFile(): Promise<boolean> {
  if (!requireTauri()) return true;
  const path = await backend.saveFile(serializeDocument(), currentPath);
  if (path) {
    currentPath = path;
    dirty = false;
    updateTitle();
    setStatus(`Saved ${path}`);
  }
  return true;
}

// --- Boot ------------------------------------------------------------------

const wrap = (fn: () => Promise<boolean> | boolean) => () => (void fn(), true);

$("btn-open").addEventListener("click", wrap(openFile));
$("btn-save").addEventListener("click", wrap(saveFile));
$("btn-run-all").addEventListener("click", wrap(runAllCells));
$("btn-reset").addEventListener("click", wrap(() => resetSession(false)));
$("btn-add-cell").addEventListener("click", () => {
  const c = createCellCard({ title: "", source: "" });
  markDirty();
  c.view.focus();
});
$("btn-python").addEventListener("click", wrap(togglePython));

loadDocumentIntoCells(demo);
dirty = false;
updateTitle();
setStatus(backend.inTauri ? "Ready — Shift+Enter or Cmd+Enter runs a cell" : "Browser mode: editing only");
cells[0]?.view.focus();
