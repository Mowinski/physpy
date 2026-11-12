import katex from "katex";
import "katex/dist/katex.min.css";
import "./styles.css";
import { EditorView } from "@codemirror/view";
import demo from "../examples/demo.ppy?raw";
import * as backend from "./backend";
import { createEditor, createViewer, setDoc, setDebugLine } from "./editor/setup";
import { replaceSymbolsInIdent } from "./editor/symbols";
import { type ConstLocation, setNotebookExportedConsts } from "./editor/constLint";
import { convertIpynbToPpy } from "./ipynbImport";
import { renderMarkdownWithLatex } from "./markdownLatex";
import { type CsvDelimiter, CsvEditorController, type CsvViewMode } from "./csvEditor";
import {
  generateStaticNotebookHtml,
  type CodeExportVisibility,
} from "./htmlExport";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type CellKind = "code" | "markdown" | "media" | "deps";
type CellCollapseMode = "expanded" | "output-only" | "collapsed";

export interface CellState {
  id: number;
  kind: CellKind;
  title: string;
  collapseMode: CellCollapseMode;
  view: EditorView;
  el: HTMLElement;
  btnCollapse: HTMLButtonElement;
  collapseSummaryEl: HTMLSpanElement;
  badgeEl: HTMLSpanElement;
  kindSelect: HTMLSelectElement;
  titleInput: HTMLInputElement;
  editorHost: HTMLDivElement;
  mdPreviewEl: HTMLDivElement;
  mdEditing: boolean;
  mediaWrap: HTMLDivElement;
  mediaInput: HTMLInputElement;
  mediaViewer: HTMLDivElement;
  mediaPath: string;
  mediaBlobUrl: string | null;
  pdfTall: boolean;
  depsWrap: HTMLDivElement;
  depsVenvBadge: HTMLSpanElement;
  depsLogPre: HTMLPreElement;
  venvPath: string;
  depsInstalling: boolean;
  btnRun: HTMLButtonElement;
  btnDebug: HTMLButtonElement;
  debugBar: HTMLDivElement;
  debugLineNumEl: HTMLElement;
  debugFilenameEl: HTMLElement;
  debugLocalsEl: HTMLDivElement;
  btnAi: HTMLButtonElement;
  aiWrap: HTMLDivElement;
  aiPromptInput: HTMLTextAreaElement;
  aiOpen: boolean;
  outputWrap: HTMLDivElement;
  staleBadgeEl: HTMLSpanElement;
  btnCopyOutput: HTMLButtonElement;
  tableModeGroup: HTMLDivElement;
  btnTableView: HTMLButtonElement;
  btnTextView: HTMLButtonElement;
  outputPre: HTMLPreElement;
  tablesWrap: HTMLDivElement;
  plotsWrap: HTMLDivElement;
  exportedBar: HTMLDivElement;
  latexWrap: HTMLDivElement;
  lastTables: backend.TableOutput[];
  lastFullStdout: string;
  lastNonTableStdout: string;
  lastStderr: string;
  lastExported: Record<string, string>;
  lastPlots: string[];
  lastLatex: string | null;
  tableViewMode: "table" | "text";
  runCount: number | null;
  outputStale: boolean;
}

interface SavedCellOutput {
  runCount: number | null;
  outputStale?: boolean;
  exported: Record<string, string>;
  stdout: string;
  nonTableStdout: string;
  stderr: string;
  tables: backend.TableOutput[];
  plots: string[];
  latex: string | null;
  tableViewMode: "table" | "text";
}

interface NotebookOutputsFile {
  version: 1;
  execCounter: number;
  allExports: Record<string, string>;
  cells: (SavedCellOutput | null)[];
}

type TabKind = "notebook" | "settings" | "csv";

interface TabDoc {
  id: number;
  kind?: TabKind;
  path: string | null;
  untitledName: string;
  content: string;
  dirty: boolean;
  interpreterInfo?: backend.PythonInterpreterInfo | null;
  collapsedCells?: CellCollapseMode[];
  savedOutputs?: NotebookOutputsFile | null;
  csvMode?: CsvViewMode;
  csvDelimiter?: CsvDelimiter;
  csvHasHeader?: boolean;
}

function isCsvPath(path: string | null | undefined): boolean {
  return !!path && /\.(csv|tsv)$/i.test(path.trim());
}

let nextCellId = 1;
let nextTabId = 1;
let untitledCounter = 1;
let execCounter = 0;
let currentPath: string | null = null;
let rootDir: string | null = null;
let dirty = false;
let sessionRuntimeExports: Record<string, string> = {};
const cells: CellState[] = [];
const tabs: TabDoc[] = [];
let activeTabId = 0;
const expandedDirs = new Set<string>();
let activeSettingsScope: "global" | "workspace" = "global";

const notebookEl = $<HTMLDivElement>("notebook");
const settingsViewEl = $<HTMLDivElement>("settings-view");
const csvViewEl = $<HTMLDivElement>("csv-view");
let csvEditor: CsvEditorController | null = null;

function getCsvEditor(): CsvEditorController {
  if (!csvEditor) {
    csvEditor = new CsvEditorController({
      container: csvViewEl,
      onChange: () => markDirty(),
      onSave: () => {
        void saveFile();
      },
      onBlur: () => handleEditorBlur(),
      onStateChange: (s) => {
        const cur = activeTab();
        if (cur && cur.kind === "csv") {
          cur.csvMode = s.mode;
          cur.csvDelimiter = s.delimiter;
          cur.csvHasHeader = s.hasHeader;
        }
      },
      openContextMenu: (x, y, items) => openContextMenu(x, y, items),
    });
  }
  return csvEditor;
}

function getActiveTabSerializedContent(): string {
  const cur = activeTab();
  if (cur?.kind === "csv") {
    return csvEditor ? csvEditor.getText() : cur.content;
  }
  return serializeDocument();
}
const btnCfgScopeGlobal = $<HTMLButtonElement>("btn-cfg-scope-global");
const btnCfgScopeWorkspace = $<HTMLButtonElement>("btn-cfg-scope-workspace");
const cfgFilePathEl = $<HTMLElement>("cfg-file-path");
const cfgFileBadgeEl = $<HTMLSpanElement>("cfg-file-badge");
const cfgFontFamilyInput = $<HTMLInputElement>("cfg-font-family");
const cfgFontSizeInput = $<HTMLInputElement>("cfg-font-size");
const cfgMatrixFontSizeInput = $<HTMLInputElement>("cfg-matrix-font-size");
const cfgLineNumbersInput = $<HTMLInputElement>("cfg-line-numbers");
const cfgFormatOnSaveInput = $<HTMLInputElement>("cfg-format-on-save");
const cfgPythonPathInput = $<HTMLInputElement>("cfg-python-path");
const cfgStartupDirInput = $<HTMLInputElement>("cfg-startup-dir");
const cfgStartupModeSelect = $<HTMLSelectElement>("cfg-startup-mode");
const cfgStartupFileInput = $<HTMLInputElement>("cfg-startup-file");
const cfgStartupFileRow = $<HTMLDivElement>("cfg-startup-file-row");
const cfgAutoSaveSelect = $<HTMLSelectElement>("cfg-auto-save");
const cfgAutoSaveDelayInput = $<HTMLInputElement>("cfg-auto-save-delay");
const cfgAutoSaveDelayRow = $<HTMLDivElement>("cfg-auto-save-delay-row");
const cfgAiProviderSelect = $<HTMLSelectElement>("cfg-ai-provider");
const cfgAiModelSelect = $<HTMLSelectElement>("cfg-ai-model-select");
const cfgAiModelInput = $<HTMLInputElement>("cfg-ai-model");
const btnCfgAiRefreshModels = $<HTMLButtonElement>("btn-cfg-ai-refresh-models");
const cfgAiModelsStatus = $<HTMLSpanElement>("cfg-ai-models-status");
const cfgAiApiKeyInput = $<HTMLInputElement>("cfg-ai-api-key");
const btnCfgAiToggleKey = $<HTMLButtonElement>("btn-cfg-ai-toggle-key");
const cfgAiSystemPromptInput = $<HTMLInputElement>("cfg-ai-system-prompt");
const cfgRawYamlInput = $<HTMLTextAreaElement>("cfg-raw-yaml");

const DEFAULT_AI_MODEL = "gemini-3.8-flash";
let fetchedAiModels: backend.GeminiModelInfo[] = [];
const tabsListEl = $<HTMLDivElement>("tabs-list");
const sidebarEl = $<HTMLElement>("sidebar");
const fileTreeEl = $<HTMLDivElement>("file-tree");
const sidebarRootNameEl = $<HTMLSpanElement>("sidebar-root-name");
const status = $<HTMLSpanElement>("status");
const pythonPane = $<HTMLDivElement>("python-pane");
const variablesDrawerEl = $<HTMLElement>("variables-drawer");
const variablesTbodyEl = $<HTMLTableSectionElement>("variables-tbody");
const variablesCountEl = $<HTMLSpanElement>("variables-count");
const btnVariablesEl = $<HTMLButtonElement>("btn-variables");
const btnWarningsEl = $<HTMLButtonElement>("btn-warnings");
const warningsCountEl = $<HTMLSpanElement>("warnings-count");
const tabDrawerVariablesEl = $<HTMLButtonElement>("tab-drawer-variables");
const tabDrawerWarningsEl = $<HTMLButtonElement>("tab-drawer-warnings");
const drawerVarsCountEl = $<HTMLSpanElement>("drawer-vars-count");
const drawerWarnCountEl = $<HTMLSpanElement>("drawer-warn-count");
const drawerPaneVariablesEl = $<HTMLDivElement>("drawer-pane-variables");
const drawerPaneWarningsEl = $<HTMLDivElement>("drawer-pane-warnings");
const warningsTbodyEl = $<HTMLTableSectionElement>("warnings-tbody");
const interpreterLabelEl = $<HTMLSpanElement>("interpreter-label");
const pythonDialog = $<HTMLDialogElement>("python-dialog");
const pythonListEl = $<HTMLDivElement>("python-list");
const pythonCustomInput = $<HTMLInputElement>("python-custom-input");
const pythonDialogError = $<HTMLParagraphElement>("python-dialog-error");
const ipynbDialog = $<HTMLDialogElement>("ipynb-dialog");
const ipynbStatusBanner = $<HTMLDivElement>("ipynb-status-banner");
const ipynbOptExport = $<HTMLInputElement>("ipynb-opt-export");
const ipynbOptPlt = $<HTMLInputElement>("ipynb-opt-plt");
const ipynbTargetInput = $<HTMLInputElement>("ipynb-target-input");
const ipynbPreviewEl = $<HTMLPreElement>("ipynb-preview");
const ipynbDialogError = $<HTMLParagraphElement>("ipynb-dialog-error");
const btnSaveIpynb = $<HTMLButtonElement>("btn-save-ipynb");
const matrixDialog = $<HTMLDialogElement>("matrix-dialog");
const matrixDialogForm = $<HTMLFormElement>("matrix-dialog-form");
const btnInsertMatrix = $<HTMLButtonElement>("btn-insert-matrix");
const btnCloseMatrixDialog = $<HTMLButtonElement>("btn-close-matrix-dialog");
const btnCancelMatrix = $<HTMLButtonElement>("btn-cancel-matrix");
const matrixRowsInput = $<HTMLInputElement>("matrix-rows-input");
const matrixColsInput = $<HTMLInputElement>("matrix-cols-input");
const matrixVarName = $<HTMLInputElement>("matrix-var-name");
const matrixInputsGrid = $<HTMLDivElement>("matrix-inputs-grid");
const matrixPreviewRender = $<HTMLDivElement>("matrix-preview-render");
const exportHtmlDialog = $<HTMLDialogElement>("export-html-dialog");
const exportHtmlForm = $<HTMLFormElement>("export-html-form");
const exportHtmlDocTitle = $<HTMLInputElement>("export-html-doc-title");
const exportHtmlCodeMode = $<HTMLSelectElement>("export-html-code-mode");
const exportHtmlCellList = $<HTMLDivElement>("export-html-cell-list");
const btnExportSelectAll = $<HTMLButtonElement>("btn-export-select-all");
const btnExportDeselectAll = $<HTMLButtonElement>("btn-export-deselect-all");
const btnExportSelectOutputs = $<HTMLButtonElement>("btn-export-select-outputs");
const btnCancelExportHtml = $<HTMLButtonElement>("btn-cancel-export-html");
const contextMenuEl = $<HTMLDivElement>("context-menu");
const contextMenuGroupEl = $<HTMLDivElement>("context-menu-group");
const viewer = createViewer($("python"));

let activeInterpreterPath: string | null = null;
let activeInterpreterInfo: backend.PythonInterpreterInfo | null = null;

function updateActiveInterpreterUI(info: backend.PythonInterpreterInfo) {
  activeInterpreterPath = info.path;
  activeInterpreterInfo = info;
  const cur = activeTab();
  if (cur && cur.kind !== "settings") {
    cur.interpreterInfo = info;
  }
  interpreterLabelEl.textContent = info.label;
  const btn = $("btn-interpreter");
  if (btn) btn.title = `Active Python: ${info.path}`;
}

function setStatus(text: string) {
  status.textContent = text;
}

function activeTab(): TabDoc | undefined {
  return tabs.find((t) => t.id === activeTabId);
}

function tabDisplayName(t: TabDoc): string {
  if (t.kind === "settings") return "Settings";
  return t.path?.split(/[\\/]/).pop() ?? t.untitledName;
}

function updateTitle() {
  const tab = activeTab();
  if (tab && tab.kind !== "settings") {
    tab.path = currentPath;
    tab.dirty = dirty;
  }
  const name = tab ? tabDisplayName(tab) : (currentPath?.split(/[\\/]/).pop() ?? "untitled.ppy");
  document.title = `${tab?.dirty ? "● " : ""}${name} — PhysPy`;
  renderTabsBar();
  highlightActiveFileInTree();
}

function requireTauri(): boolean {
  if (backend.inTauri) return true;
  setStatus("Running Python requires the desktop app (npm run tauri dev).");
  return false;
}

// --- Context Menu (Popover + focusgroup menu pattern) ----------------------

export interface MenuAction {
  label?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void | Promise<void>;
}

// Fallback for browsers without native `focusgroup` support
if (!("focusGroup" in HTMLElement.prototype)) {
  contextMenuGroupEl.setAttribute("role", "menu");
  contextMenuGroupEl.addEventListener(
    "keydown",
    (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...contextMenuGroupEl.querySelectorAll<HTMLButtonElement>("button")].filter(
        (item) => !item.disabled && item.getAttribute("aria-disabled") !== "true",
      );
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      event.preventDefault();
      event.stopImmediatePropagation();
      items[next].focus({ preventScroll: true });
    },
    true,
  );
}

let contextMenuOpenedAt = 0;

function closeContextMenu() {
  if (contextMenuEl.matches(":popover-open")) {
    contextMenuEl.hidePopover();
  }
}

window.addEventListener(
  "pointerdown",
  (e) => {
    if (performance.now() - contextMenuOpenedAt < 150) return;
    if (
      contextMenuEl.matches(":popover-open") &&
      !contextMenuEl.contains(e.target as Node)
    ) {
      closeContextMenu();
    }
  },
  true,
);

window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && contextMenuEl.matches(":popover-open")) {
      e.preventDefault();
      closeContextMenu();
    }
  },
  true,
);

window.addEventListener("resize", closeContextMenu);

function openContextMenu(x: number, y: number, items: MenuAction[]) {
  contextMenuOpenedAt = performance.now();
  contextMenuGroupEl.innerHTML = "";
  for (const item of items) {
    if (item.separator) {
      contextMenuGroupEl.append(document.createElement("hr"));
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    if (!("focusGroup" in HTMLElement.prototype)) {
      btn.setAttribute("role", "menuitem");
    }
    if (item.danger) btn.classList.add("danger");
    if (item.disabled) btn.disabled = true;

    const lbl = document.createElement("span");
    lbl.textContent = item.label ?? "";
    btn.append(lbl);

    if (item.shortcut) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.setAttribute("aria-hidden", "true");
      hint.textContent = item.shortcut;
      btn.append(hint);
    }

    btn.addEventListener("pointermove", () => {
      if (!btn.disabled) btn.focus({ preventScroll: true });
    });
    btn.addEventListener("click", (e) => {
      // Ignore stray click generated when releasing macOS Ctrl+click that opened the menu
      if (e.ctrlKey && performance.now() - contextMenuOpenedAt < 300) {
        return;
      }
      closeContextMenu();
      void item.run?.();
    });
    contextMenuGroupEl.append(btn);
  }

  const targetX = x + 2;
  const targetY = y + 2;
  contextMenuEl.style.left = `${targetX}px`;
  contextMenuEl.style.top = `${targetY}px`;
  if (!contextMenuEl.matches(":popover-open")) {
    contextMenuEl.showPopover();
  }

  // Clamp inside viewport so the menu never clips off-screen
  const rect = contextMenuEl.getBoundingClientRect();
  const clampedX = Math.max(4, Math.min(targetX, window.innerWidth - rect.width - 6));
  const clampedY = Math.max(4, Math.min(targetY, window.innerHeight - rect.height - 6));
  contextMenuEl.style.left = `${clampedX}px`;
  contextMenuEl.style.top = `${clampedY}px`;

  const firstBtn = contextMenuGroupEl.querySelector<HTMLButtonElement>("button:not([disabled])");
  firstBtn?.focus({ preventScroll: true });
}

// --- Tabs Management -------------------------------------------------------

function saveActiveTabSnapshot() {
  const cur = activeTab();
  if (cur && cur.kind !== "settings") {
    cur.content = getActiveTabSerializedContent();
    if (cur.kind !== "csv") {
      cur.collapsedCells = cells.map((c) => c.collapseMode);
      cur.savedOutputs = snapshotNotebookOutputs();
    }
    if (cur.kind === "csv" && csvEditor) {
      const s = csvEditor.getState();
      cur.csvMode = s.mode;
      cur.csvDelimiter = s.delimiter;
      cur.csvHasHeader = s.hasHeader;
    }
    cur.path = currentPath;
    cur.dirty = dirty;
    if (currentConfig?.auto_save === "onFocusChange" || currentConfig?.auto_save === "onWindowChange") {
      void triggerAutoSave("onFocusChange");
    }
  }
  saveSessionState();
}

function saveSessionState() {
  try {
    const fileTabs = tabs
      .filter((t) => t.kind !== "settings" && t.path)
      .map((t) => t.path!);
    const activeTabObj = activeTab();
    const activePath = activeTabObj && activeTabObj.kind !== "settings" ? activeTabObj.path : null;
    const session = {
      rootDir,
      fileTabs,
      activePath,
    };
    localStorage.setItem("physpy_session", JSON.stringify(session));
  } catch {
    // Ignore localStorage errors
  }
}

function renderTabsBar() {
  tabsListEl.innerHTML = "";
  for (const tab of tabs) {
    const isSelected = tab.id === activeTabId;
    const item = document.createElement("div");
    item.className = "tab-item" + (isSelected ? " active" : "");
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", String(isSelected));
    item.title = tab.kind === "settings" ? "PhysPy Configuration (Global & Local)" : (tab.path ?? tab.untitledName);

    const icon = document.createElement("span");
    icon.className = "tab-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = tab.kind === "settings" ? "⚙" : fileIcon(tabDisplayName(tab));

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tabDisplayName(tab);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tab-close" + (tab.dirty ? " is-dirty" : "");
    closeBtn.setAttribute("aria-label", `Close ${tabDisplayName(tab)}`);
    closeBtn.textContent = tab.dirty ? "●" : "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    item.append(icon, label, closeBtn);

    item.addEventListener("click", (e) => {
      if (e.button !== 0 || e.ctrlKey) return;
      if (tab.id !== activeTabId) switchToTab(tab.id);
    });
    item.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab.id);
      }
    });
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = tabs.indexOf(tab);
      openContextMenu(e.clientX, e.clientY, [
        { label: "Close", shortcut: "⌘W", run: () => closeTab(tab.id) },
        {
          label: "Close Others",
          disabled: tabs.length <= 1,
          run: () => closeTabsWhere((t) => t.id !== tab.id),
        },
        {
          label: "Close to the Right",
          disabled: idx >= tabs.length - 1,
          run: () => closeTabsWhere((_, i) => i > idx),
        },
        {
          label: "Close Saved",
          run: () => closeTabsWhere((t) => !t.dirty),
        },
        { separator: true },
        {
          label: "Save",
          shortcut: "⌘S",
          run: async () => {
            if (tab.id !== activeTabId) switchToTab(tab.id);
            await saveFile();
          },
        },
        {
          label: "Copy Path",
          disabled: !tab.path,
          run: () => {
            if (tab.path) void navigator.clipboard?.writeText(tab.path);
          },
        },
      ]);
    });

    tabsListEl.append(item);
  }
}

function createNewTab(opts?: { path?: string | null; content?: string; dirty?: boolean }): TabDoc {
  saveActiveTabSnapshot();
  const kind: TabKind = isCsvPath(opts?.path) ? "csv" : "notebook";
  const tab: TabDoc = {
    id: nextTabId++,
    kind,
    path: opts?.path ?? null,
    untitledName: `untitled-${untitledCounter++}.ppy`,
    content: opts?.content ?? (kind === "csv" ? "" : "# %% Cell 1\n"),
    dirty: opts?.dirty ?? false,
  };
  tabs.push(tab);
  switchToTab(tab.id);
  return tab;
}

function openSettingsTab(initialScope?: "global" | "workspace"): boolean {
  if (initialScope) {
    activeSettingsScope = initialScope;
  }
  const existing = tabs.find((t) => t.kind === "settings");
  if (existing) {
    switchToTab(existing.id);
    void loadSettingsScope(activeSettingsScope);
    return true;
  }
  saveActiveTabSnapshot();
  const tab: TabDoc = {
    id: nextTabId++,
    kind: "settings",
    path: null,
    untitledName: "Settings",
    content: "",
    dirty: false,
  };
  tabs.push(tab);
  switchToTab(tab.id);
  return true;
}

function switchToTab(tabId: number) {
  const target = tabs.find((t) => t.id === tabId);
  if (!target) return;
  clearTimeout(autoSaveTimer);
  if (activeTabId && activeTabId !== tabId) {
    saveActiveTabSnapshot();
  }
  activeTabId = target.id;
  if (target.kind === "settings") {
    notebookEl.hidden = true;
    csvViewEl.hidden = true;
    settingsViewEl.hidden = false;
    updateTitle();
    void loadSettingsScope(activeSettingsScope);
    return;
  }
  if (target.kind === "csv") {
    settingsViewEl.hidden = true;
    notebookEl.hidden = true;
    csvViewEl.hidden = false;
    currentPath = target.path;
    dirty = target.dirty;
    getCsvEditor().load(target.content, {
      path: target.path,
      mode: target.csvMode ?? "table",
      delimiter: target.csvDelimiter,
      hasHeader: target.csvHasHeader ?? true,
      dirty: target.dirty,
    });
    updateTitle();
    getCsvEditor().focus();
    saveSessionState();
    return;
  }
  settingsViewEl.hidden = true;
  csvViewEl.hidden = true;
  notebookEl.hidden = false;
  currentPath = target.path;
  dirty = target.dirty;
  loadDocumentIntoCells(target.content, target.collapsedCells, target.savedOutputs, target.id);
  updateTitle();

  if (target.interpreterInfo && target.interpreterInfo.path !== activeInterpreterPath) {
    const info = target.interpreterInfo;
    void backend.setPythonInterpreter(info.path).then(() => {
      updateActiveInterpreterUI(info);
    });
  } else if (!target.interpreterInfo && activeInterpreterInfo) {
    target.interpreterInfo = activeInterpreterInfo;
  }

  void refreshPython();
  if (cells[0] && cells[0].collapseMode === "expanded") {
    cells[0].view.focus();
  }
  saveSessionState();
}

function closeTab(tabId: number) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  if (tabs.length === 1) {
    // Keep one clean untitled tab open
    tabs[0].kind = "notebook";
    tabs[0].path = null;
    tabs[0].untitledName = `untitled-${untitledCounter++}.ppy`;
    tabs[0].content = "# %% Cell 1\n";
    tabs[0].dirty = false;
    tabs[0].collapsedCells = undefined;
    tabs[0].savedOutputs = undefined;
    activeTabId = 0;
    switchToTab(tabs[0].id);
    saveSessionState();
    return;
  }
  const wasActive = tabId === activeTabId;
  tabs.splice(idx, 1);
  if (wasActive) {
    const nextIdx = Math.min(idx, tabs.length - 1);
    activeTabId = 0;
    switchToTab(tabs[nextIdx].id);
  } else {
    renderTabsBar();
  }
  saveSessionState();
}

function closeTabsWhere(predicate: (t: TabDoc, idx: number) => boolean) {
  saveActiveTabSnapshot();
  const remaining = tabs.filter((t, i) => !predicate(t, i));
  if (remaining.length === 0) {
    tabs.length = 0;
    createNewTab({ path: null, content: "# %% Cell 1\n" });
    return;
  }
  tabs.length = 0;
  tabs.push(...remaining);
  if (!tabs.some((t) => t.id === activeTabId)) {
    activeTabId = 0;
    switchToTab(tabs[tabs.length - 1].id);
  } else {
    renderTabsBar();
  }
}

// --- Python Interpreter Modal Dialog --------------------------------------

// Fallback for browsers without native `<dialog closedby="any">` support (e.g. WebKit)
function attachDialogLightDismiss(dialog: HTMLDialogElement) {
  if ("closedBy" in HTMLDialogElement.prototype) return;
  const outside = (e: PointerEvent) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (e) => {
    pressedOutside = outside(e);
  });
  dialog.addEventListener("pointerup", (e) => {
    if (pressedOutside && outside(e)) dialog.close();
  });
}

attachDialogLightDismiss(pythonDialog);
attachDialogLightDismiss(ipynbDialog);
attachDialogLightDismiss(matrixDialog);
attachDialogLightDismiss(exportHtmlDialog);

let currentConfig: backend.AppConfig | null = null;
let autoSaveTimer: number | undefined;

async function triggerAutoSave(reason: string) {
  if (!dirty || !currentPath || !backend.inTauri) return;
  const cur = activeTab();
  if (!cur || cur.kind === "settings") return;

  const serialized = getActiveTabSerializedContent();
  try {
    await backend.writeFileByPath(currentPath, serialized);
    dirty = false;
    cur.content = serialized;
    cur.dirty = false;
    if (cur.kind === "csv") csvEditor?.markSaved();
    updateTitle();
    setStatus(`Auto-saved (${reason}) ${currentPath.split(/[\\/]/).pop()}`);
    void refreshFileTree();
  } catch (err) {
    console.error(`Auto-save failed (${reason}):`, err);
  }
}

function handleEditorBlur() {
  if (currentConfig?.auto_save === "onFocusChange" || currentConfig?.auto_save === "onWindowChange") {
    setTimeout(() => {
      const active = document.activeElement;
      const insideEditor =
        active && (active.closest(".cm-editor") || active.closest(".cell-card") || active.closest("#csv-view"));
      if (!insideEditor) {
        void triggerAutoSave("onFocusChange");
      }
    }, 60);
  }
}

window.addEventListener("blur", () => {
  if (currentConfig?.auto_save === "onWindowChange") {
    void triggerAutoSave("onWindowChange");
  }
});

async function applyHierarchicalConfig(
  workspaceDir: string | null,
  isInitialBoot = false,
): Promise<backend.AppConfig | null> {
  if (!backend.inTauri) return null;
  try {
    const cfg = await backend.loadConfig(workspaceDir);
    currentConfig = cfg;
    if (cfg.font_family) {
      document.documentElement.style.setProperty("--editor-font-family", cfg.font_family);
    }
    if (cfg.font_size && cfg.font_size >= 8 && cfg.font_size <= 48) {
      document.documentElement.style.setProperty("--editor-font-size", `${cfg.font_size}px`);
    }
    const matrixScale =
      cfg.matrix_font_size && cfg.matrix_font_size >= 50 && cfg.matrix_font_size <= 300
        ? cfg.matrix_font_size
        : 135;
    document.documentElement.style.setProperty("--editor-matrix-font-size", `${matrixScale}%`);
    notebookEl.classList.toggle("hide-line-numbers", !cfg.line_numbers);

    if (isInitialBoot && !rootDir && cfg.resolved_startup_dir) {
      rootDir = cfg.resolved_startup_dir;
    }
    if (isInitialBoot && cfg.python_path && !activeInterpreterPath) {
      try {
        const info = await backend.setPythonInterpreter(cfg.python_path);
        updateActiveInterpreterUI(info);
      } catch {
        // ignore invalid python_path
      }
    }
    await refreshInterpreterBadge();
    return cfg;
  } catch {
    return null;
  }
}

// --- Settings Tab (Global ~/.physpy/config.yaml & Local .physpy-config.yaml) ---

function markSettingsTabDirty(isDirty: boolean) {
  const sTab = tabs.find((t) => t.kind === "settings");
  if (sTab) {
    sTab.dirty = isDirty;
    updateTitle();
  }
}

function updateStartupFileRowVisibility() {
  if (cfgStartupFileRow) {
    cfgStartupFileRow.style.display =
      cfgStartupModeSelect.value === "file" ? "flex" : "none";
  }
}

function updateAutoSaveDelayRowVisibility() {
  if (cfgAutoSaveDelayRow) {
    cfgAutoSaveDelayRow.style.display =
      cfgAutoSaveSelect.value === "afterDelay" ? "flex" : "none";
  }
}

function buildYamlFromSettingsForm(): string {
  const scopeTitle =
    activeSettingsScope === "workspace"
      ? "PhysPy Workspace Configuration (.physpy-config.yaml)"
      : "PhysPy Global Configuration (~/.physpy/config.yaml)";
  const fontFam = cfgFontFamilyInput.value.trim().replace(/'/g, "''");
  const fontSize = Number(cfgFontSizeInput.value) || 14.5;
  const matrixSize = Number(cfgMatrixFontSizeInput.value) || 135;
  const lineNums = cfgLineNumbersInput.checked;
  const formatOnSave = cfgFormatOnSaveInput.checked;
  const pyPath = cfgPythonPathInput.value.trim().replace(/"/g, '\\"');
  const startDir = (cfgStartupDirInput.value.trim() || "~").replace(/"/g, '\\"');
  const startMode = cfgStartupModeSelect.value || "restore";
  const startFile = cfgStartupFileInput.value.trim().replace(/"/g, '\\"');
  const autoSave = cfgAutoSaveSelect.value || "off";
  const autoSaveDelay = Number(cfgAutoSaveDelayInput.value) || 1000;
  const aiProvider = (cfgAiProviderSelect.value || "gemini").trim();
  const aiModel = (cfgAiModelInput.value.trim() || DEFAULT_AI_MODEL).replace(/"/g, '\\"');
  const aiApiKey = cfgAiApiKeyInput.value.trim().replace(/"/g, '\\"');
  const aiSystemPrompt = cfgAiSystemPromptInput.value.trim().replace(/"/g, '\\"');

  const lines = [
    `# ${scopeTitle}`,
    "",
    "# 1. Editor font family, size (px), and matrix KaTeX font size (%)",
    `font_family: '${fontFam}'`,
    `font_size: ${fontSize}`,
    `matrix_font_size: ${matrixSize}`,
    "",
    "# 2. Show line numbers in notebook cells (true / false)",
    `line_numbers: ${lineNums}`,
    "",
    "# 3. Format code cells on save (true / false)",
    `format_on_save: ${formatOnSave}`,
    "",
    "# 4. Default Python interpreter path (leave empty for automatic detection)",
    `python_path: "${pyPath}"`,
    "",
    "# 4. Default directory where PhysPy opens on startup (~ expands to $HOME)",
    `startup_dir: "${startDir}"`,
    "",
    "# 5. What to open on startup: restore (previous session) | empty (nothing) | demo (demo.ppy) | file (startup_file)",
    `startup_mode: ${startMode}`,
    `startup_file: "${startFile}"`,
    "",
    "# 6. Auto Save: off (never) | afterDelay (every X ms) | onFocusChange | onWindowChange",
    `auto_save: ${autoSave}`,
    `auto_save_delay: ${autoSaveDelay}`,
    "",
    "# 7. AI Cell Assistant (Gemini)",
    `ai_provider: ${aiProvider}`,
    `ai_model: "${aiModel}"`,
  ];
  if (activeSettingsScope === "global" || aiApiKey) {
    lines.push(`ai_api_key: "${aiApiKey}"`);
  }
  lines.push(`ai_system_prompt: "${aiSystemPrompt}"`, "");
  return lines.join("\n");
}

function renderAiModelSelectOptions(selectedModel: string) {
  const target = selectedModel.trim() || DEFAULT_AI_MODEL;
  cfgAiModelInput.value = target;
  cfgAiModelSelect.innerHTML = "";

  const candidates: { id: string; label: string }[] =
    fetchedAiModels.length > 0
      ? fetchedAiModels.map((m) => ({
          id: m.id,
          label: m.display_name && m.display_name !== m.id ? `${m.id} — ${m.display_name}` : m.id,
        }))
      : [{ id: DEFAULT_AI_MODEL, label: `${DEFAULT_AI_MODEL} (Default)` }];

  const hasTarget = candidates.some((c) => c.id === target);
  if (!hasTarget && fetchedAiModels.length === 0) {
    candidates.unshift({ id: target, label: target });
  }

  for (const item of candidates) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.label;
    cfgAiModelSelect.append(opt);
  }

  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "Custom model ID…";
  cfgAiModelSelect.append(customOpt);

  if (candidates.some((c) => c.id === target)) {
    cfgAiModelSelect.value = target;
    cfgAiModelInput.hidden = true;
  } else {
    cfgAiModelSelect.value = "__custom__";
    cfgAiModelInput.hidden = false;
  }
}

async function refreshAiModelsList(silent = false) {
  if (!backend.inTauri) return;
  const currentModel = cfgAiModelInput.value.trim() || DEFAULT_AI_MODEL;
  const typedKey = cfgAiApiKeyInput.value.trim() || null;

  btnCfgAiRefreshModels.disabled = true;
  btnCfgAiRefreshModels.textContent = "Loading…";
  if (!silent) {
    cfgAiModelsStatus.textContent = "Fetching available models from Gemini API…";
    cfgAiModelsStatus.style.color = "";
  }
  try {
    const models = await backend.listAiModels(typedKey, rootDir);
    fetchedAiModels = models;
    renderAiModelSelectOptions(currentModel);
    cfgAiModelsStatus.textContent = `✓ Loaded ${models.length} models from Gemini API`;
    cfgAiModelsStatus.style.color = "#98c379";
  } catch (err) {
    if (!silent) {
      cfgAiModelsStatus.textContent = String(err);
      cfgAiModelsStatus.style.color = "#e06c75";
    }
  } finally {
    btnCfgAiRefreshModels.disabled = false;
    btnCfgAiRefreshModels.textContent = "↻ Fetch Models";
  }
}

function syncSettingsFormFromYamlText(yamlText: string) {
  for (const rawLine of yamlText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();
    // Strip inline comment outside quotes
    if (!val.startsWith('"') && !val.startsWith("'")) {
      val = val.replace(/\s+#.*$/, "").trim();
    }
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
    }
    if (key === "font_family" || key === "fontFamily") {
      cfgFontFamilyInput.value = val;
    } else if (key === "font_size" || key === "fontSize") {
      const n = parseFloat(val);
      if (!Number.isNaN(n)) cfgFontSizeInput.value = String(n);
    } else if (key === "matrix_font_size" || key === "matrixFontSize") {
      const n = parseFloat(val.replace("%", ""));
      if (!Number.isNaN(n)) cfgMatrixFontSizeInput.value = String(n);
    } else if (key === "line_numbers" || key === "lineNumbers") {
      cfgLineNumbersInput.checked = /^(true|yes|on|1)$/i.test(val);
    } else if (key === "format_on_save" || key === "formatOnSave" || key === "linter_on_save") {
      cfgFormatOnSaveInput.checked = /^(true|yes|on|1)$/i.test(val);
    } else if (key === "python_path" || key === "pythonPath") {
      cfgPythonPathInput.value = val;
    } else if (key === "startup_dir" || key === "startupDir" || key === "default_dir") {
      cfgStartupDirInput.value = val;
    } else if (key === "startup_mode" || key === "startupMode") {
      const m = val.toLowerCase();
      if (["restore", "empty", "demo", "file"].includes(m)) {
        cfgStartupModeSelect.value = m;
      }
    } else if (key === "startup_file" || key === "startupFile") {
      cfgStartupFileInput.value = val;
    } else if (
      key === "auto_save" ||
      key === "autoSave" ||
      key === "files.autoSave" ||
      key === "autosave"
    ) {
      const m = val.toLowerCase();
      if (["off", "afterdelay", "onfocuschange", "onwindowchange"].includes(m)) {
        cfgAutoSaveSelect.value =
          m === "afterdelay"
            ? "afterDelay"
            : m === "onfocuschange"
              ? "onFocusChange"
              : m === "onwindowchange"
                ? "onWindowChange"
                : "off";
      }
    } else if (
      key === "auto_save_delay" ||
      key === "autoSaveDelay" ||
      key === "autosave_delay"
    ) {
      const n = parseInt(val, 10);
      if (!Number.isNaN(n)) cfgAutoSaveDelayInput.value = String(n);
    } else if (key === "ai_provider" || key === "aiProvider" || key === "ai.provider") {
      if (val.toLowerCase() === "gemini") cfgAiProviderSelect.value = "gemini";
    } else if (key === "ai_model" || key === "aiModel" || key === "ai.model" || key === "gemini_model") {
      renderAiModelSelectOptions(val || DEFAULT_AI_MODEL);
    } else if (key === "ai_api_key" || key === "aiApiKey" || key === "ai.api_key" || key === "gemini_api_key") {
      cfgAiApiKeyInput.value = val;
    } else if (key === "ai_system_prompt" || key === "aiSystemPrompt" || key === "ai.system_prompt") {
      cfgAiSystemPromptInput.value = val;
    }
  }
  updateStartupFileRowVisibility();
  updateAutoSaveDelayRowVisibility();
}

async function loadSettingsScope(scope: "global" | "workspace") {
  activeSettingsScope = scope;
  btnCfgScopeGlobal.classList.toggle("active", scope === "global");
  btnCfgScopeWorkspace.classList.toggle("active", scope === "workspace");

  if (!backend.inTauri) {
    cfgFilePathEl.textContent =
      scope === "global" ? "~/.physpy/config.yaml" : ".physpy-config.yaml";
    cfgFileBadgeEl.textContent = "Browser mode";
    return;
  }

  try {
    const data = await backend.readConfigScope(scope, rootDir);
    cfgFilePathEl.textContent = data.file_path;
    if (data.exists) {
      cfgFileBadgeEl.className = "settings-badge";
      cfgFileBadgeEl.textContent = "Active file on disk";
    } else {
      cfgFileBadgeEl.className = "settings-badge missing";
      cfgFileBadgeEl.textContent = "Will be created on Save";
    }

    cfgFontFamilyInput.value = data.parsed.font_family;
    cfgFontSizeInput.value = String(data.parsed.font_size);
    cfgMatrixFontSizeInput.value = String(data.parsed.matrix_font_size || 135);
    cfgLineNumbersInput.checked = data.parsed.line_numbers;
    cfgFormatOnSaveInput.checked = data.parsed.format_on_save !== false;
    cfgPythonPathInput.value = data.parsed.python_path;
    cfgStartupDirInput.value = data.parsed.startup_dir;
    cfgStartupModeSelect.value = data.parsed.startup_mode || "restore";
    cfgStartupFileInput.value = data.parsed.startup_file || "";
    cfgAutoSaveSelect.value = (data.parsed.auto_save as any) || "off";
    cfgAutoSaveDelayInput.value = String(data.parsed.auto_save_delay || 1000);
    cfgAiProviderSelect.value = data.parsed.ai_provider || "gemini";
    renderAiModelSelectOptions(data.parsed.ai_model || DEFAULT_AI_MODEL);
    cfgAiApiKeyInput.value = scope === "global" ? data.parsed.ai_api_key || "" : "";
    cfgAiSystemPromptInput.value = data.parsed.ai_system_prompt || "";
    cfgRawYamlInput.value = data.raw_yaml;
    syncSettingsFormFromYamlText(data.raw_yaml);
    updateStartupFileRowVisibility();
    updateAutoSaveDelayRowVisibility();
    markSettingsTabDirty(false);
    if (data.effective.ai_api_key || cfgAiApiKeyInput.value.trim()) {
      void refreshAiModelsList(true);
    }
  } catch (e) {
    setStatus(`Failed to read config: ${String(e)}`);
  }
}

async function saveSettingsScope() {
  if (!requireTauri()) return;
  try {
    const prevStartup = rootDir;
    const saved = await backend.saveConfigScope(
      activeSettingsScope,
      rootDir,
      cfgRawYamlInput.value,
    );
    cfgFilePathEl.textContent = saved.file_path;
    cfgFileBadgeEl.className = "settings-badge";
    cfgFileBadgeEl.textContent = "Saved";
    markSettingsTabDirty(false);

    const eff = await applyHierarchicalConfig(rootDir);
    if (eff && eff.resolved_startup_dir && eff.resolved_startup_dir !== prevStartup && activeSettingsScope === "global") {
      rootDir = eff.resolved_startup_dir;
    }
    await refreshFileTree();
    setStatus(`Saved & applied ${saved.file_path}`);
  } catch (e) {
    setStatus(`Failed to save config: ${String(e)}`);
  }
}

for (const inputEl of [
  cfgFontFamilyInput,
  cfgFontSizeInput,
  cfgMatrixFontSizeInput,
  cfgLineNumbersInput,
  cfgFormatOnSaveInput,
  cfgPythonPathInput,
  cfgStartupDirInput,
  cfgStartupFileInput,
  cfgAutoSaveDelayInput,
  cfgAiProviderSelect,
  cfgAiModelInput,
  cfgAiApiKeyInput,
  cfgAiSystemPromptInput,
]) {
  inputEl.addEventListener("input", () => {
    cfgRawYamlInput.value = buildYamlFromSettingsForm();
    markSettingsTabDirty(true);
  });
  inputEl.addEventListener("change", () => {
    cfgRawYamlInput.value = buildYamlFromSettingsForm();
    markSettingsTabDirty(true);
  });
}

cfgMatrixFontSizeInput.addEventListener("input", () => {
  const val = Number(cfgMatrixFontSizeInput.value);
  if (val >= 50 && val <= 300) {
    document.documentElement.style.setProperty("--editor-matrix-font-size", `${val}%`);
  }
});

cfgAiModelSelect.addEventListener("change", () => {
  if (cfgAiModelSelect.value === "__custom__") {
    cfgAiModelInput.hidden = false;
    cfgAiModelInput.focus();
  } else {
    cfgAiModelInput.hidden = true;
    cfgAiModelInput.value = cfgAiModelSelect.value || DEFAULT_AI_MODEL;
  }
  cfgRawYamlInput.value = buildYamlFromSettingsForm();
  markSettingsTabDirty(true);
});

btnCfgAiRefreshModels.addEventListener("click", () => void refreshAiModelsList(false));

cfgAiApiKeyInput.addEventListener("change", () => {
  if (cfgAiApiKeyInput.value.trim()) {
    void refreshAiModelsList(true);
  }
});

btnCfgAiToggleKey.addEventListener("click", () => {
  const isHidden = cfgAiApiKeyInput.type === "password";
  cfgAiApiKeyInput.type = isHidden ? "text" : "password";
  btnCfgAiToggleKey.textContent = isHidden ? "Hide" : "Show";
});

cfgStartupModeSelect.addEventListener("change", () => {
  updateStartupFileRowVisibility();
  cfgRawYamlInput.value = buildYamlFromSettingsForm();
  markSettingsTabDirty(true);
});

cfgAutoSaveSelect.addEventListener("change", () => {
  updateAutoSaveDelayRowVisibility();
  cfgRawYamlInput.value = buildYamlFromSettingsForm();
  markSettingsTabDirty(true);
});

cfgRawYamlInput.addEventListener("input", () => {
  syncSettingsFormFromYamlText(cfgRawYamlInput.value);
  markSettingsTabDirty(true);
});

btnCfgScopeGlobal.addEventListener("click", () => void loadSettingsScope("global"));
btnCfgScopeWorkspace.addEventListener("click", () => void loadSettingsScope("workspace"));
$("btn-cfg-reload").addEventListener("click", () => void loadSettingsScope(activeSettingsScope));
$("btn-cfg-save").addEventListener("click", () => void saveSettingsScope());

$("btn-cfg-browse-python").addEventListener("click", async () => {
  if (!requireTauri()) return;
  const picked = await backend.pickPythonBinary(rootDir);
  if (picked) {
    cfgPythonPathInput.value = picked;
    cfgRawYamlInput.value = buildYamlFromSettingsForm();
    markSettingsTabDirty(true);
  }
});

$("btn-cfg-browse-dir").addEventListener("click", async () => {
  if (!requireTauri()) return;
  const picked = await backend.pickFolder(rootDir);
  if (picked) {
    cfgStartupDirInput.value = picked;
    cfgRawYamlInput.value = buildYamlFromSettingsForm();
    markSettingsTabDirty(true);
  }
});

$("btn-cfg-browse-startup-file")?.addEventListener("click", async () => {
  if (!requireTauri()) return;
  const picked = await backend.pickPythonBinary(rootDir);
  if (picked) {
    cfgStartupFileInput.value = picked;
    cfgRawYamlInput.value = buildYamlFromSettingsForm();
    markSettingsTabDirty(true);
  }
});

async function refreshInterpreterBadge() {
  if (!backend.inTauri) return;
  try {
    const res = await backend.listPythonInterpreters(rootDir);
    const active =
      (activeInterpreterPath ? res.interpreters.find((i) => i.path === activeInterpreterPath) : null) ??
      res.interpreters.find((i) => i.path === res.current);
    if (active) {
      updateActiveInterpreterUI(active);
    }
  } catch {
    // ignore at startup
  }
}

async function autoSelectWorkspacePython(folderPath: string) {
  if (!backend.inTauri) return;
  try {
    const res = await backend.listPythonInterpreters(folderPath);
    const wsVenv = res.interpreters.find((i) => i.label.includes("(workspace "));
    if (wsVenv && wsVenv.path !== res.current) {
      const info = await backend.setPythonInterpreter(wsVenv.path);
      updateActiveInterpreterUI(info);
      await resetSession(true);
      setStatus(`Opened folder ${folderPath} · Switched Python to ${info.label}`);
    } else {
      await refreshInterpreterBadge();
    }
  } catch {
    // ignore
  }
}

async function openPythonDialog(): Promise<boolean> {
  if (!requireTauri()) return true;
  pythonDialogError.hidden = true;
  pythonListEl.innerHTML = `<div class="tree-empty">Scanning Python environments…</div>`;
  pythonDialog.returnValue = "";
  pythonDialog.showModal();

  try {
    const res = await backend.listPythonInterpreters(rootDir);
    pythonCustomInput.value = res.current;
    pythonListEl.innerHTML = "";
    for (const item of res.interpreters) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "python-option" + (item.path === res.current ? " selected" : "");
      btn.innerHTML = `<span class="py-opt-label"></span><code class="py-opt-path"></code>`;
      btn.querySelector(".py-opt-label")!.textContent = item.label;
      btn.querySelector(".py-opt-path")!.textContent = item.path;
      btn.addEventListener("click", () => {
        pythonCustomInput.value = item.path;
        for (const el of pythonListEl.querySelectorAll(".python-option")) {
          el.classList.toggle("selected", el === btn);
        }
      });
      btn.addEventListener("dblclick", () => {
        pythonCustomInput.value = item.path;
        void applyPythonSelection();
      });
      pythonListEl.append(btn);
    }
  } catch (e) {
    pythonListEl.innerHTML = `<div class="tree-empty">${String(e)}</div>`;
  }
  return true;
}

async function applyPythonSelection() {
  const chosen = pythonCustomInput.value.trim();
  if (!chosen) return;
  try {
    const info = await backend.setPythonInterpreter(chosen);
    updateActiveInterpreterUI(info);
    $("btn-interpreter").title = `Active Python: ${info.path}`;
    await resetSession(true);
    setStatus(`Switched Python interpreter to ${info.label} (${info.path})`);
    pythonDialog.close();
  } catch (e) {
    pythonDialogError.hidden = false;
    pythonDialogError.textContent = String(e);
  }
}

pythonDialog.addEventListener("close", () => {
  pythonDialog.returnValue = "";
});

$<HTMLFormElement>("python-dialog-form").addEventListener("submit", (e) => {
  const submitter = e.submitter as HTMLButtonElement | null;
  if (submitter?.value === "apply") {
    e.preventDefault();
    void applyPythonSelection();
  }
});

$("btn-browse-python").addEventListener("click", async () => {
  const picked = await backend.pickPythonBinary(rootDir);
  if (picked) {
    pythonCustomInput.value = picked;
  }
});

// --- Jupyter Notebook (.ipynb -> .ppy) Import Modal Dialog ----------------

let activeIpynbRawJson = "";
let activeIpynbConvertedPpy = "";

function refreshIpynbPreview() {
  if (!activeIpynbRawJson) return;
  const res = convertIpynbToPpy(activeIpynbRawJson, {
    autoExport: ipynbOptExport.checked,
    convertPltShow: ipynbOptPlt.checked,
  });
  activeIpynbConvertedPpy = res.ppySource;

  if (!res.ok) {
    ipynbStatusBanner.className = "ipynb-status-banner is-error";
    ipynbStatusBanner.textContent = `✗ Import failed: ${res.error ?? "Unknown error"}`;
    ipynbPreviewEl.textContent = "";
    btnSaveIpynb.disabled = true;
    return;
  }

  const details: string[] = [
    `${res.codeCellCount} code cell${res.codeCellCount === 1 ? "" : "s"}`,
  ];
  if (res.markdownCellCount > 0) {
    details.push(`${res.markdownCellCount} markdown block${res.markdownCellCount === 1 ? "" : "s"}`);
  }
  if (res.autoExportedNames.length > 0) {
    details.push(`auto-exported: ${res.autoExportedNames.join(", ")}`);
  }
  if (res.convertedPlotsCount > 0) {
    details.push(`${res.convertedPlotsCount} plt.show() → plot plt`);
  }

  ipynbStatusBanner.className = "ipynb-status-banner is-ok";
  ipynbStatusBanner.textContent = `✓ Successfully converted to PhysPy format (${details.join(" · ")})`;
  ipynbPreviewEl.textContent = res.ppySource;
  btnSaveIpynb.disabled = false;
}

async function openIpynbImportDialog(ipynbPath: string) {
  if (!requireTauri()) return;
  ipynbDialogError.hidden = true;
  activeIpynbRawJson = "";
  activeIpynbConvertedPpy = "";
  const defaultTarget = ipynbPath.replace(/\.ipynb$/i, "") + ".ppy";
  ipynbTargetInput.value = defaultTarget;
  ipynbStatusBanner.className = "ipynb-status-banner";
  ipynbStatusBanner.textContent = "Reading Jupyter Notebook…";
  ipynbPreviewEl.textContent = "";
  btnSaveIpynb.disabled = true;
  ipynbDialog.returnValue = "";
  ipynbDialog.showModal();

  try {
    activeIpynbRawJson = await backend.readFileByPath(ipynbPath);
    refreshIpynbPreview();
  } catch (e) {
    ipynbStatusBanner.className = "ipynb-status-banner is-error";
    ipynbStatusBanner.textContent = `✗ Could not read file: ${String(e)}`;
    btnSaveIpynb.disabled = true;
  }
}

async function saveImportedIpynb() {
  const targetPath = ipynbTargetInput.value.trim();
  if (!targetPath) {
    ipynbDialogError.hidden = false;
    ipynbDialogError.textContent = "Please provide a destination .ppy file path.";
    return;
  }
  if (!activeIpynbConvertedPpy) return;
  const finalPath = targetPath.endsWith(".ppy") ? targetPath : `${targetPath}.ppy`;
  try {
    await backend.writeFileByPath(finalPath, activeIpynbConvertedPpy);
    ipynbDialog.close();
    await refreshFileTree();
    await openFileByPath(finalPath);
    setStatus(`Imported Jupyter Notebook to ${finalPath}`);
  } catch (e) {
    ipynbDialogError.hidden = false;
    ipynbDialogError.textContent = `Failed to save file: ${String(e)}`;
  }
}

ipynbOptExport.addEventListener("change", refreshIpynbPreview);
ipynbOptPlt.addEventListener("change", refreshIpynbPreview);

$("btn-browse-ipynb-target").addEventListener("click", async () => {
  const picked = await backend.pickSavePpyPath(ipynbTargetInput.value.trim() || "imported.ppy");
  if (picked) {
    ipynbTargetInput.value = picked;
  }
});

ipynbDialog.addEventListener("close", () => {
  ipynbDialog.returnValue = "";
});

$<HTMLFormElement>("ipynb-dialog-form").addEventListener("submit", (e) => {
  const submitter = e.submitter as HTMLButtonElement | null;
  if (submitter?.value === "save") {
    e.preventDefault();
    void saveImportedIpynb();
  }
});

// --- Matrix Dialog (Visual Grid Editor) -----------------------------------

let matrixCurrentTargetView: EditorView | null = null;

function getMatrixDimensions(): { rows: number; cols: number } {
  const r = Math.max(1, Math.min(8, parseInt(matrixRowsInput.value, 10) || 2));
  const c = Math.max(1, Math.min(8, parseInt(matrixColsInput.value, 10) || 2));
  return { rows: r, cols: c };
}

function updateMatrixPreview() {
  const { rows, cols } = getMatrixDimensions();
  const latexRows: string[] = [];

  for (let r = 0; r < rows; r++) {
    const rowVals: string[] = [];
    for (let c = 0; c < cols; c++) {
      const inp = matrixInputsGrid.querySelector<HTMLInputElement>(`input[data-r="${r}"][data-c="${c}"]`);
      const val = inp?.value.trim() || "0";
      rowVals.push(val.replace(/j\b/g, "i").replace(/\\([a-zA-Z]+)/g, "$1"));
    }
    latexRows.push(rowVals.join(" & "));
  }

  const varName = matrixVarName.value.trim();
  const prefix = varName ? `${varName} = ` : "";
  const latex = `${prefix}\\begin{pmatrix}\n${latexRows.join(" \\\\[0.5em]\n")}\n\\end{pmatrix}`;

  try {
    katex.render(latex, matrixPreviewRender, { displayMode: true, throwOnError: false });
  } catch (err) {
    matrixPreviewRender.textContent = latex;
  }
}

function buildMatrixInputsGrid(preserveExisting = true) {
  const { rows, cols } = getMatrixDimensions();
  const existingValues: Map<string, string> = new Map();

  if (preserveExisting) {
    const currentInputs = matrixInputsGrid.querySelectorAll<HTMLInputElement>("input");
    currentInputs.forEach((inp) => {
      const r = inp.getAttribute("data-r");
      const c = inp.getAttribute("data-c");
      if (r !== null && c !== null) {
        existingValues.set(`${r},${c}`, inp.value);
      }
    });
  }

  matrixInputsGrid.innerHTML = "";
  matrixInputsGrid.style.gridTemplateColumns = `repeat(${cols}, minmax(60px, 1fr))`;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "matrix-cell-inp";
      inp.setAttribute("data-r", String(r));
      inp.setAttribute("data-c", String(c));
      inp.placeholder = "0";
      inp.spellcheck = false;

      const prevVal = existingValues.get(`${r},${c}`);
      inp.value = prevVal !== undefined ? prevVal : (r === c ? "1" : "0");

      inp.addEventListener("input", () => updateMatrixPreview());
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (r === rows - 1 && c === cols - 1) {
            submitMatrixDialog();
          } else {
            const nextC = (c + 1) % cols;
            const nextR = nextC === 0 ? r + 1 : r;
            const nextInp = matrixInputsGrid.querySelector<HTMLInputElement>(`input[data-r="${nextR}"][data-c="${nextC}"]`);
            nextInp?.focus();
            nextInp?.select();
          }
        } else if (e.key === "ArrowRight" && inp.selectionStart === inp.value.length) {
          const nextInp = matrixInputsGrid.querySelector<HTMLInputElement>(`input[data-r="${r}"][data-c="${c + 1}"]`);
          if (nextInp) { nextInp.focus(); nextInp.select(); }
        } else if (e.key === "ArrowLeft" && inp.selectionStart === 0) {
          const prevInp = matrixInputsGrid.querySelector<HTMLInputElement>(`input[data-r="${r}"][data-c="${c - 1}"]`);
          if (prevInp) { prevInp.focus(); prevInp.select(); }
        } else if (e.key === "ArrowDown") {
          const downInp = matrixInputsGrid.querySelector<HTMLInputElement>(`input[data-r="${r + 1}"][data-c="${c}"]`);
          if (downInp) { downInp.focus(); downInp.select(); }
        } else if (e.key === "ArrowUp") {
          const upInp = matrixInputsGrid.querySelector<HTMLInputElement>(`input[data-r="${r - 1}"][data-c="${c}"]`);
          if (upInp) { upInp.focus(); upInp.select(); }
        }
      });

      matrixInputsGrid.append(inp);
    }
  }

  updateMatrixPreview();
}

function openMatrixDialog(targetView?: EditorView) {
  if (targetView) {
    matrixCurrentTargetView = targetView;
  } else {
    const focused = cells.find((c) => c.view.hasFocus);
    matrixCurrentTargetView = focused ? focused.view : (cells[0]?.view ?? null);
  }

  buildMatrixInputsGrid(false);
  matrixDialog.showModal();
  setTimeout(() => {
    const first = matrixInputsGrid.querySelector<HTMLInputElement>("input");
    first?.focus();
    first?.select();
  }, 50);
}

function submitMatrixDialog() {
  const { rows, cols } = getMatrixDimensions();
  const rowLines: string[] = [];

  for (let r = 0; r < rows; r++) {
    const rowVals: string[] = [];
    for (let c = 0; c < cols; c++) {
      const inp = matrixInputsGrid.querySelector<HTMLInputElement>(`input[data-r="${r}"][data-c="${c}"]`);
      const val = inp?.value.trim() || "0";
      rowVals.push(val);
    }
    rowLines.push(rowVals.join(", "));
  }

  let code = "";
  const varName = matrixVarName.value.trim();
  const assign = varName ? `${varName} = ` : "";

  if (rows === 1) {
    code = `${assign}[${rowLines[0]}]`;
  } else {
    const formatted = rowLines.map((line, idx) => {
      const isLast = idx === rows - 1;
      return `    ${line}${isLast ? "" : " ;"}`;
    }).join("\n");
    code = `${assign}[\n${formatted}\n]`;
  }

  if (matrixCurrentTargetView) {
    const state = matrixCurrentTargetView.state;
    const sel = state.selection.main;
    matrixCurrentTargetView.dispatch({
      changes: { from: sel.from, to: sel.to, insert: code },
      selection: { anchor: sel.from + code.length },
    });
    matrixCurrentTargetView.focus();
  }

  matrixDialog.close();
  markDirty();
}

btnInsertMatrix.addEventListener("click", () => openMatrixDialog());
btnCloseMatrixDialog.addEventListener("click", () => matrixDialog.close());
btnCancelMatrix.addEventListener("click", () => matrixDialog.close());
matrixRowsInput.addEventListener("change", () => buildMatrixInputsGrid(true));
matrixColsInput.addEventListener("change", () => buildMatrixInputsGrid(true));
matrixVarName.addEventListener("input", () => updateMatrixPreview());

document.querySelectorAll<HTMLButtonElement>(".matrix-preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const r = btn.getAttribute("data-r");
    const c = btn.getAttribute("data-c");
    if (r && c) {
      matrixRowsInput.value = r;
      matrixColsInput.value = c;
      buildMatrixInputsGrid(false);
    }
  });
});

matrixDialogForm.addEventListener("submit", (e) => {
  const submitter = e.submitter as HTMLButtonElement | null;
  if (submitter?.value === "insert") {
    e.preventDefault();
    submitMatrixDialog();
  }
});

// --- Static HTML Export Dialog ----------------------------------------------

function openExportHtmlDialog() {
  const tab = activeTab();
  if (!tab || tab.kind === "settings" || tab.kind === "csv") {
    setStatus("Static HTML export is available for Python notebooks.");
    return;
  }

  // Pre-fill default title based on current filename
  const baseName = currentPath
    ? currentPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? ""
    : tab.untitledName.replace(/\.[^.]+$/, "");
  exportHtmlDocTitle.value = baseName;
  exportHtmlCodeMode.value = "folded";

  // Build cell selection list
  exportHtmlCellList.innerHTML = "";
  if (cells.length === 0) {
    exportHtmlCellList.innerHTML = `<div style="padding:10px;color:var(--dim);font-size:12px;">Notebook has no cells.</div>`;
  } else {
    cells.forEach((c, idx) => {
      const row = document.createElement("label");
      row.className = "export-cell-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.cellId = String(c.id);

      const idxSpan = document.createElement("span");
      idxSpan.className = "export-cell-idx";
      idxSpan.textContent = `#${idx + 1}`;

      const kindBadge = document.createElement("span");
      kindBadge.className = `export-cell-kind ${c.kind}`;
      kindBadge.textContent =
        c.kind === "markdown"
          ? "MD"
          : c.kind === "media"
            ? "MEDIA"
            : c.kind === "deps"
              ? "DEPS"
              : "CODE";

      const descSpan = document.createElement("span");
      descSpan.className = "export-cell-preview";
      const rawText =
        c.title.trim() ||
        c.view.state.doc.sliceString(0, 60).trim().replace(/\s+/g, " ") ||
        "(empty)";
      descSpan.textContent = rawText;
      descSpan.title = rawText;

      const pillsWrap = document.createElement("span");
      pillsWrap.className = "export-cell-badges";

      const hasPlots = Boolean(c.lastPlots && c.lastPlots.length > 0);
      const hasTables = Boolean(c.lastTables && c.lastTables.length > 0);
      const hasOut = Boolean(
        c.lastFullStdout.trim() || c.lastNonTableStdout.trim() || c.lastLatex,
      );
      const hasErr = Boolean(c.lastStderr.trim());

      if (hasPlots) {
        const p = document.createElement("span");
        p.className = "export-output-pill";
        p.textContent = "plot";
        pillsWrap.appendChild(p);
      }
      if (hasTables) {
        const p = document.createElement("span");
        p.className = "export-output-pill";
        p.textContent = "table";
        pillsWrap.appendChild(p);
      }
      if (hasOut) {
        const p = document.createElement("span");
        p.className = "export-output-pill";
        p.textContent = "out";
        pillsWrap.appendChild(p);
      }
      if (hasErr) {
        const p = document.createElement("span");
        p.className = "export-output-pill";
        p.style.color = "var(--danger)";
        p.textContent = "err";
        pillsWrap.appendChild(p);
      }

      row.append(cb, idxSpan, kindBadge, descSpan, pillsWrap);
      exportHtmlCellList.appendChild(row);
    });
  }

  exportHtmlDialog.showModal();
}

btnExportSelectAll.addEventListener("click", () => {
  exportHtmlCellList.querySelectorAll<HTMLInputElement>("input[type='checkbox']").forEach((cb) => {
    cb.checked = true;
  });
});

btnExportDeselectAll.addEventListener("click", () => {
  exportHtmlCellList.querySelectorAll<HTMLInputElement>("input[type='checkbox']").forEach((cb) => {
    cb.checked = false;
  });
});

btnExportSelectOutputs.addEventListener("click", () => {
  cells.forEach((c) => {
    const cb = exportHtmlCellList.querySelector<HTMLInputElement>(
      `input[data-cell-id="${c.id}"]`,
    );
    if (!cb) return;
    if (c.kind === "markdown" || c.kind === "media") {
      cb.checked = true;
    } else if (c.kind === "code") {
      const hasContent = Boolean(
        (c.lastPlots && c.lastPlots.length > 0) ||
          (c.lastTables && c.lastTables.length > 0) ||
          c.lastFullStdout.trim() ||
          c.lastNonTableStdout.trim() ||
          c.lastLatex ||
          c.lastStderr.trim(),
      );
      cb.checked = hasContent;
    } else {
      cb.checked = false;
    }
  });
});

btnCancelExportHtml.addEventListener("click", () => {
  exportHtmlDialog.close();
});

exportHtmlForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const selectedIds = new Set<number>();
  exportHtmlCellList
    .querySelectorAll<HTMLInputElement>("input[type='checkbox']:checked")
    .forEach((cb) => {
      const id = Number(cb.dataset.cellId);
      if (!Number.isNaN(id)) selectedIds.add(id);
    });

  if (selectedIds.size === 0) {
    setStatus("No cells selected for HTML export.");
    return;
  }

  const title = exportHtmlDocTitle.value.trim();
  const codeVisibility = (exportHtmlCodeMode.value || "folded") as CodeExportVisibility;
  const notebookName = currentPath
    ? currentPath.split(/[\\/]/).pop() ?? "notebook.ppy"
    : (activeTab()?.untitledName ?? "notebook.ppy");

  exportHtmlDialog.close();

  try {
    const html = generateStaticNotebookHtml(cells, {
      title,
      notebookName,
      documentPath: currentPath,
      codeVisibility,
      selectedCellIds: selectedIds,
    });

    let defaultPath: string;
    if (currentPath) {
      defaultPath = currentPath.replace(/\.ppy$/i, "") + ".html";
    } else {
      defaultPath = notebookName.replace(/\.ppy$/i, "") + ".html";
    }

    const saved = await backend.exportHtmlFile(html, defaultPath);
    if (saved) {
      setStatus(`Exported static HTML report to ${saved}`);
    }
  } catch (err) {
    setStatus(`Failed to export HTML: ${String(err)}`);
  }
});

// --- Collapsible File Explorer Sidebar ------------------------------------

function toggleSidebar(): boolean {
  sidebarEl.hidden = !sidebarEl.hidden;
  return true;
}

function highlightActiveFileInTree() {
  for (const row of fileTreeEl.querySelectorAll<HTMLElement>(".tree-row")) {
    row.classList.toggle("active", row.dataset.path === currentPath);
  }
}

function isMediaFilename(name: string): boolean {
  return /\.(pdf|png|jpe?g|webp|svg|gif)$/i.test(name);
}

function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".ppy")) return "📘";
  if (lower.endsWith(".ipynb")) return "📓";
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return "📊";
  if (lower.endsWith(".py")) return "🐍";
  if (lower.endsWith(".pdf")) return "📕";
  if (/\.(png|jpe?g|webp|svg|gif)$/.test(lower)) return "🖼";
  if (lower.endsWith(".md") || lower.endsWith(".txt")) return "📄";
  if (lower.endsWith(".json") || lower.endsWith(".toml") || lower.endsWith(".yaml")) return "⚙";
  return "•";
}

async function promptNewFileIn(dirPath: string) {
  const name = window.prompt("New file name:", "notebook.ppy")?.trim();
  if (!name) return;
  const fullPath = `${dirPath.replace(/\/+$/, "")}/${name}`;
  const initialContent = isCsvPath(name) ? "" : "# %% Cell 1\n";
  try {
    await backend.writeFileByPath(fullPath, initialContent);
    expandedDirs.add(dirPath);
    await refreshFileTree();
    await openFileByPath(fullPath);
  } catch (e) {
    setStatus(`Error creating file: ${String(e)}`);
  }
}

async function promptNewFolderIn(dirPath: string) {
  const name = window.prompt("New folder name:", "new-folder")?.trim();
  if (!name) return;
  const fullPath = `${dirPath.replace(/\/+$/, "")}/${name}`;
  try {
    await backend.createDir(fullPath);
    expandedDirs.add(dirPath);
    await refreshFileTree();
    setStatus(`Created folder ${fullPath}`);
  } catch (e) {
    setStatus(`Error creating folder: ${String(e)}`);
  }
}

async function promptRenameEntry(entry: backend.DirEntryItem) {
  const newName = window.prompt("Rename to:", entry.name)?.trim();
  if (!newName || newName === entry.name) return;
  const parentDir = entry.path.replace(/[\\/][^\\/]+$/, "");
  const newPath = `${parentDir}/${newName}`;
  try {
    await backend.renamePath(entry.path, newPath);
    for (const t of tabs) {
      if (t.path === entry.path) t.path = newPath;
    }
    if (currentPath === entry.path) currentPath = newPath;
    updateTitle();
    await refreshFileTree();
    setStatus(`Renamed to ${newName}`);
  } catch (e) {
    setStatus(`Rename failed: ${String(e)}`);
  }
}

async function confirmDeleteEntry(entry: backend.DirEntryItem) {
  if (!window.confirm(`Delete "${entry.name}"?`)) return;
  try {
    await backend.deletePath(entry.path);
    const openTab = tabs.find((t) => t.path === entry.path);
    if (openTab) closeTab(openTab.id);
    await refreshFileTree();
    setStatus(`Deleted ${entry.name}`);
  } catch (e) {
    setStatus(`Delete failed: ${String(e)}`);
  }
}

async function renderTreeBranch(container: HTMLElement, dirPath: string, depth: number) {
  container.innerHTML = "";
  let entries: backend.DirEntryItem[];
  try {
    entries = await backend.listDir(dirPath);
  } catch (e) {
    const errEl = document.createElement("div");
    errEl.className = "tree-empty";
    errEl.textContent = String(e);
    container.append(errEl);
    return;
  }

  if (entries.length === 0 && depth === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "tree-empty";
    emptyEl.textContent = "Empty folder";
    container.append(emptyEl);
    return;
  }

  for (const entry of entries) {
    const itemWrap = document.createElement("div");
    itemWrap.className = "tree-item";

    const row = document.createElement("div");
    row.className = `tree-row ${entry.is_dir ? "is-dir" : "is-file"}`;
    row.style.paddingLeft = `${10 + depth * 14}px`;
    row.dataset.path = entry.path;
    row.title = entry.path;
    if (entry.path === currentPath) row.classList.add("active");

    const icon = document.createElement("span");
    icon.className = "tree-icon";

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = entry.name;

    row.append(icon, label);
    itemWrap.append(row);

    if (entry.is_dir) {
      const childrenWrap = document.createElement("div");
      childrenWrap.className = "tree-children";
      const isOpen = expandedDirs.has(entry.path);
      childrenWrap.hidden = !isOpen;
      icon.textContent = isOpen ? "▾ 📁" : "▸ 📁";
      itemWrap.append(childrenWrap);

      if (isOpen) {
        void renderTreeBranch(childrenWrap, entry.path, depth + 1);
      }

      const toggleDir = async () => {
        if (expandedDirs.has(entry.path)) {
          expandedDirs.delete(entry.path);
          childrenWrap.hidden = true;
          icon.textContent = "▸ 📁";
        } else {
          expandedDirs.add(entry.path);
          childrenWrap.hidden = false;
          icon.textContent = "▾ 📁";
          await renderTreeBranch(childrenWrap, entry.path, depth + 1);
        }
      };

      row.addEventListener("click", () => void toggleDir());
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, [
          {
            label: expandedDirs.has(entry.path) ? "Collapse Folder" : "Expand Folder",
            run: toggleDir,
          },
          { label: "New File…", run: () => promptNewFileIn(entry.path) },
          { label: "New Folder…", run: () => promptNewFolderIn(entry.path) },
          { separator: true },
          { label: "Rename…", run: () => promptRenameEntry(entry) },
          { label: "Delete Folder", danger: true, run: () => confirmDeleteEntry(entry) },
          { separator: true },
          {
            label: "Copy Path",
            run: () => void navigator.clipboard?.writeText(entry.path),
          },
        ]);
      });
    } else {
      const isIpynb = entry.name.toLowerCase().endsWith(".ipynb");
      const isMedia = isMediaFilename(entry.name);
      icon.textContent = fileIcon(entry.name);
      row.addEventListener("click", () => {
        if (isIpynb) {
          void openIpynbImportDialog(entry.path);
        } else if (isMedia) {
          insertMediaCellWithFile(entry.path);
        } else {
          void openFileByPath(entry.path);
        }
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const parentDir = entry.path.replace(/[\\/][^\\/]+$/, "");
        const actions: MenuAction[] = [];
        if (isIpynb) {
          actions.push(
            {
              label: "✨ Import to PhysPy (.ppy)…",
              run: () => openIpynbImportDialog(entry.path),
            },
            { separator: true },
          );
        }
        if (isMedia) {
          actions.push(
            {
              label: "📄 Embed in Notebook as Media Cell",
              run: () => insertMediaCellWithFile(entry.path),
            },
            { separator: true },
          );
        }
        if (!isMedia) {
          actions.push({
            label: isIpynb ? "Open Raw JSON in Tab" : "Open in Tab",
            run: () => openFileByPath(entry.path),
          });
        }
        actions.push(
          { label: "New File…", run: () => promptNewFileIn(parentDir) },
          { label: "New Folder…", run: () => promptNewFolderIn(parentDir) },
          { separator: true },
          { label: "Rename…", run: () => promptRenameEntry(entry) },
          { label: "Delete File", danger: true, run: () => confirmDeleteEntry(entry) },
          { separator: true },
          {
            label: "Copy Path",
            run: () => void navigator.clipboard?.writeText(entry.path),
          },
        );
        openContextMenu(e.clientX, e.clientY, actions);
      });
    }

    container.append(itemWrap);
  }
}

fileTreeEl.addEventListener("contextmenu", (e) => {
  if (e.target !== fileTreeEl || !rootDir) return;
  e.preventDefault();
  openContextMenu(e.clientX, e.clientY, [
    { label: "New File…", run: () => promptNewFileIn(rootDir!) },
    { label: "New Folder…", run: () => promptNewFolderIn(rootDir!) },
    { separator: true },
    { label: "Refresh Explorer", run: () => refreshFileTree() },
  ]);
});

async function refreshFileTree() {
  if (!backend.inTauri) {
    fileTreeEl.innerHTML = `<div class="tree-empty">Browser mode</div>`;
    return;
  }
  if (!rootDir) {
    try {
      rootDir = await backend.initialRootDir();
    } catch {
      rootDir = ".";
    }
  }
  const folderName = rootDir.split(/[\\/]/).filter(Boolean).pop() ?? rootDir;
  sidebarRootNameEl.textContent = folderName;
  sidebarRootNameEl.title = rootDir;
  await renderTreeBranch(fileTreeEl, rootDir, 0);
}

async function changeRootFolder(): Promise<boolean> {
  if (!requireTauri()) return true;
  const picked = await backend.pickFolder();
  if (picked) {
    rootDir = picked;
    expandedDirs.clear();
    sidebarEl.hidden = false;
    await refreshFileTree();
    setStatus(`Opened folder ${picked}`);
    const cfg = await applyHierarchicalConfig(picked);
    if (!cfg?.python_path) {
      await autoSelectWorkspacePython(picked);
    }
  }
  return true;
}

async function openFileByPath(path: string) {
  if (!requireTauri()) return;
  if (/\.physpy-config\.ya?ml$/i.test(path)) {
    openSettingsTab("workspace");
    return;
  }
  if (/\.physpy[\\/]config\.ya?ml$/i.test(path)) {
    openSettingsTab("global");
    return;
  }
  const existing = tabs.find((t) => t.path === path);
  if (existing) {
    switchToTab(existing.id);
    setStatus(`Switched to ${path}`);
    return;
  }
  try {
    const contents = await backend.readFileByPath(path);
    // Replace current tab if it is an untouched untitled tab
    const cur = activeTab();
    if (cur && !cur.path && !cur.dirty && tabs.length === 1) {
      await resetSession(true);
      cur.kind = isCsvPath(path) ? "csv" : "notebook";
      cur.path = path;
      cur.content = contents;
      cur.dirty = false;
      cur.csvMode = undefined;
      cur.csvDelimiter = undefined;
      cur.csvHasHeader = undefined;
      activeTabId = 0;
      switchToTab(cur.id);
    } else {
      createNewTab({ path, content: contents, dirty: false });
    }
    setStatus(`Opened ${path}`);
    void refreshPython();
  } catch (e) {
    setStatus(`Cannot open file: ${String(e)}`);
  }
}

// --- Parsing & serializing `# %%` cells ------------------------------------

interface ParsedCell {
  kind: CellKind;
  title: string;
  source: string;
  venv?: string;
}

const CELL_HEADER_RE = /^# %%[^\S\n]*(.*)$/gm;

function uncommentMarkdownBlock(raw: string): string {
  const lines = raw.split("\n");
  const allCommented = lines.every((l) => !l.trim() || /^\s*#/.test(l));
  if (!allCommented) return raw;
  return lines.map((l) => l.replace(/^\s*# ?/, "")).join("\n");
}

function looksLikeCommentedMarkdownCell(raw: string): boolean {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  if (!lines.every((l) => /^\s*#/.test(l))) return false;
  return lines.some((l) => /^\s*#\s*(\$\$|\\\[|#{1,6}\s)/.test(l));
}

function extractMediaPathFromBlock(raw: string): string {
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*#\s*@media:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  const stripped = uncommentMarkdownBlock(raw).trim();
  return stripped.split("\n")[0]?.trim() ?? "";
}

function parseCellHeaderTag(rawTitle: string): { kind: CellKind; title: string } {
  const mdMatch = rawTitle.match(/^\[(?:markdown|md)\]\s*(.*)$/i);
  if (mdMatch) return { kind: "markdown", title: mdMatch[1].trim() };
  const mediaMatch = rawTitle.match(/^\[(?:media|pdf|image)\]\s*(.*)$/i);
  if (mediaMatch) return { kind: "media", title: mediaMatch[1].trim() };
  const depsMatch = rawTitle.match(/^\[(?:deps|dependencies|packages|requirements)\]\s*(.*)$/i);
  if (depsMatch) return { kind: "deps", title: depsMatch[1].trim() };
  return { kind: "code", title: rawTitle.trim() };
}

function parseDocument(src: string): ParsedCell[] {
  const matches = [...src.matchAll(CELL_HEADER_RE)];
  if (matches.length === 0) {
    return [{ kind: "code", title: "", source: src }];
  }
  const out: ParsedCell[] = [];
  if (matches[0].index! > 0) {
    const pre = src.slice(0, matches[0].index!);
    if (pre.trim()) {
      out.push({ kind: "code", title: "", source: pre.replace(/\n+$/, "") });
    }
  }
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    let { kind, title } = parseCellHeaderTag(m[1].trim());
    let bodyStart = m.index! + m[0].length;
    if (src[bodyStart] === "\n") bodyStart++;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index! : src.length;
    const rawBody = src.slice(bodyStart, bodyEnd).replace(/\n+$/, "");
    if (kind === "code" && looksLikeCommentedMarkdownCell(rawBody)) {
      kind = "markdown";
    }
    let source = rawBody;
    let venv = "";
    if (kind === "markdown") {
      source = uncommentMarkdownBlock(rawBody);
    } else if (kind === "media") {
      source = extractMediaPathFromBlock(rawBody);
    } else if (kind === "deps") {
      const remaining: string[] = [];
      for (const line of rawBody.split("\n")) {
        const vMatch = line.match(/^\s*#\s*@venv:\s*(.+)$/);
        if (vMatch) {
          venv = vMatch[1].trim();
        } else {
          remaining.push(line.replace(/^\s*#\s?/, ""));
        }
      }
      source = remaining.join("\n").trim();
    }
    out.push({ kind, title, source, venv });
  }
  return out.length ? out : [{ kind: "code", title: "", source: "" }];
}

function serializeDocument(): string {
  return (
    cells
      .map((c) => {
        const t = c.title.trim();
        if (c.kind === "markdown") {
          const header = t ? `# %% [markdown] ${t}` : "# %% [markdown]";
          const rawMd = c.view.state.doc.toString().replace(/\n+$/, "");
          const commented = rawMd
            ? rawMd
                .split("\n")
                .map((line) => (line.length > 0 ? `# ${line}` : "#"))
                .join("\n")
            : "#";
          return `${header}\n${commented}\n`;
        }
        if (c.kind === "media") {
          const header = t ? `# %% [media] ${t}` : "# %% [media]";
          const p = c.mediaPath.trim();
          return `${header}\n# @media: ${p}\n`;
        }
        if (c.kind === "deps") {
          const header = t ? `# %% [deps] ${t}` : "# %% [deps]";
          const venvLine = c.venvPath ? `# @venv: ${c.venvPath}\n` : "";
          const rawDeps = c.view.state.doc.toString().replace(/\n+$/, "");
          const commented = rawDeps
            ? rawDeps
                .split("\n")
                .map((line) => (line.length > 0 ? `# ${line}` : "#"))
                .join("\n")
            : "";
          return `${header}\n${venvLine}${commented}\n`;
        }
        const header = t ? `# %% ${t}` : "# %%";
        const body = c.view.state.doc.toString().replace(/\n+$/, "");
        return `${header}\n${body}\n`;
      })
      .join("\n")
      .replace(/\n+$/, "") + "\n"
  );
}

// --- Static + Runtime Exports Scanner & Variables Drawer -------------------

interface ScannedExport {
  name: string;
  isConst: boolean;
  occurrences: { cellIndex: number; line: number }[];
}

function parseImportTargets(clause: string): string[] {
  const out: string[] = [];
  for (const part of clause.split(",")) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === "*") continue;
    const asMatch = trimmed.match(/^([A-Za-z0-9_.]+)\s+as\s+([A-Za-z_]\w*)$/);
    if (asMatch) {
      out.push(asMatch[2]);
    } else {
      out.push(trimmed.split(".")[0].trim());
    }
  }
  return out.filter(Boolean);
}

function scanExportsInCells(): Map<string, ScannedExport> {
  const map = new Map<string, ScannedExport>();
  const exportedConstsMap = new Map<string, ConstLocation[]>();

  const record = (rawName: string, cellIndex: number, line: number, isConst = false) => {
    const name = replaceSymbolsInIdent(rawName.trim());
    if (!name) return;
    let entry = map.get(name);
    if (!entry) {
      entry = { name, isConst, occurrences: [] };
      map.set(name, entry);
    } else if (isConst) {
      entry.isConst = true;
    }
    entry.occurrences.push({ cellIndex, line });

    if (isConst) {
      let cList = exportedConstsMap.get(name);
      if (!cList) {
        cList = [];
        exportedConstsMap.set(name, cList);
      }
      cList.push({ cellIndex, line });
    }
  };

  cells.forEach((cell, idx) => {
    if (cell.kind !== "code") return;
    const cellIndex = idx + 1;
    const lines = cell.view.state.doc.toString().split("\n");
    lines.forEach((rawLine, lineIdx) => {
      const codePart = rawLine.replace(/#.*$/, "").trim();
      const kwMatch = codePart.match(/^(export\s+const|const\s+export|export)\b\s*(.*)$/);
      if (!kwMatch) return;
      const isConst = /\bconst\b/.test(kwMatch[1]);
      const rest = kwMatch[2].trim();
      if (!rest) return;
      const lineNo = lineIdx + 1;

      // 1. `export def foo(...):` or `export class Bar...:`
      const defMatch = rest.match(/^(?:def|class)\s+((?:\\[A-Za-z]+\w*|[A-Za-z_]\w*))/);
      if (defMatch) {
        record(defMatch[1], cellIndex, lineNo, isConst);
        return;
      }

      // 2. `export from mod import a, b as c`
      const fromMatch = rest.match(/^from\s+[A-Za-z0-9_.]+\s+import\s+(.+)$/);
      if (fromMatch) {
        for (const n of parseImportTargets(fromMatch[1])) record(n, cellIndex, lineNo, isConst);
        return;
      }

      // 3. `export import a, b as c`
      const impMatch = rest.match(/^import\s+(.+)$/);
      if (impMatch) {
        for (const n of parseImportTargets(impMatch[1])) record(n, cellIndex, lineNo, isConst);
        return;
      }

      // 4. `export [const] a, b = ...` or `export a, b`
      const lhs = rest.split("=")[0].trim();
      for (const piece of lhs.split(",")) {
        const tok = piece.trim();
        if (/^(?:\\[A-Za-z]+\w*|[A-Za-z_]\w*)$/.test(tok)) {
          record(tok, cellIndex, lineNo, isConst);
        }
      }
    });
  });

  setNotebookExportedConsts(
    exportedConstsMap,
    cells.map((c) => c.view),
  );
  return map;
}

type DrawerTab = "variables" | "warnings";
let activeDrawerTab: DrawerTab = "variables";

interface NotebookWarning {
  id: string;
  type: string;
  symbol: string;
  message: string;
  locations: Array<{ cellIndex: number; line: number }>;
}

function setDrawerTab(tab: DrawerTab) {
  activeDrawerTab = tab;
  const isVars = tab === "variables";

  tabDrawerVariablesEl.classList.toggle("active", isVars);
  tabDrawerVariablesEl.setAttribute("aria-selected", String(isVars));
  drawerPaneVariablesEl.hidden = !isVars;

  tabDrawerWarningsEl.classList.toggle("active", !isVars);
  tabDrawerWarningsEl.setAttribute("aria-selected", String(!isVars));
  drawerPaneWarningsEl.hidden = isVars;

  if (!variablesDrawerEl.hidden) {
    btnVariablesEl.classList.toggle("active-toggle", isVars);
    btnWarningsEl.classList.toggle("active-toggle", !isVars);
    btnVariablesEl.setAttribute("aria-expanded", String(isVars));
    btnWarningsEl.setAttribute("aria-expanded", String(!isVars));
  }
}

function openDrawerTab(tab: DrawerTab) {
  if (variablesDrawerEl.hidden) {
    variablesDrawerEl.hidden = false;
    setDrawerTab(tab);
  } else if (activeDrawerTab === tab) {
    closeDrawer();
  } else {
    setDrawerTab(tab);
  }
}

function closeDrawer(): boolean {
  variablesDrawerEl.hidden = true;
  btnVariablesEl.classList.remove("active-toggle");
  btnWarningsEl.classList.remove("active-toggle");
  btnVariablesEl.setAttribute("aria-expanded", "false");
  btnWarningsEl.setAttribute("aria-expanded", "false");
  return true;
}

function toggleVariablesDrawer(): boolean {
  openDrawerTab("variables");
  return true;
}

function toggleWarningsDrawer(): boolean {
  openDrawerTab("warnings");
  return true;
}

function jumpToCellLine(cellIndex: number, line: number) {
  const cell = cells[cellIndex - 1];
  if (!cell) return;
  if (cell.collapseMode !== "expanded") {
    setCellCollapseMode(cell, "expanded");
  }
  cell.el.scrollIntoView({ behavior: "smooth", block: "center" });
  cell.view.focus();
  if (line > 0 && line <= cell.view.state.doc.lines) {
    const lineObj = cell.view.state.doc.line(line);
    cell.view.dispatch({
      selection: { anchor: lineObj.from },
      scrollIntoView: true,
    });
  }
}

function renderNotebookWarnings(warnings: NotebookWarning[]) {
  warningsTbodyEl.innerHTML = "";
  const count = warnings.length;

  warningsCountEl.textContent = String(count);
  warningsCountEl.hidden = count === 0;

  drawerWarnCountEl.textContent = String(count);
  drawerWarnCountEl.hidden = count === 0;

  if (count === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "warnings-empty";
    td.innerHTML = "✓ No warnings detected in this notebook";
    tr.append(td);
    warningsTbodyEl.append(tr);
    return;
  }

  for (const warn of warnings) {
    const tr = document.createElement("tr");

    const tdType = document.createElement("td");
    const typeBadge = document.createElement("span");
    typeBadge.className = "warn-badge-tag";
    typeBadge.textContent = warn.type;
    tdType.append(typeBadge);

    const tdSymbol = document.createElement("td");
    tdSymbol.className = "warn-symbol-cell";
    const code = document.createElement("code");
    code.textContent = warn.symbol;
    tdSymbol.append(code);

    const tdMsg = document.createElement("td");
    tdMsg.className = "warn-msg-cell";
    tdMsg.textContent = warn.message;

    const tdLoc = document.createElement("td");
    tdLoc.className = "warn-loc-cell";
    for (const loc of warn.locations) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "warn-loc-link";
      btn.textContent = `Cell ${loc.cellIndex}:${loc.line}`;
      btn.title = `Jump to Cell ${loc.cellIndex}, line ${loc.line}`;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        jumpToCellLine(loc.cellIndex, loc.line);
      });
      tdLoc.append(btn);
    }

    tr.append(tdType, tdSymbol, tdMsg, tdLoc);
    warningsTbodyEl.append(tr);
  }
}

function renderSessionExports(allExports?: Record<string, string>) {
  if (allExports !== undefined) {
    sessionRuntimeExports = allExports;
  }
  const scanned = scanExportsInCells();
  // Also include any runtime exports that might still be in session
  for (const k of Object.keys(sessionRuntimeExports)) {
    if (!scanned.has(k)) {
      scanned.set(k, { name: k, isConst: false, occurrences: [] });
    }
  }

  variablesTbodyEl.innerHTML = "";
  const items = [...scanned.values()];

  variablesCountEl.textContent = String(items.length);
  variablesCountEl.hidden = items.length === 0;
  drawerVarsCountEl.textContent = String(items.length);

  if (items.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "exports-empty";
    td.innerHTML = "No exported variables in this file (use <code>export x = …</code> in a cell)";
    tr.append(td);
    variablesTbodyEl.append(tr);
  } else {
    for (const item of items) {
      const hasValue = Object.prototype.hasOwnProperty.call(sessionRuntimeExports, item.name);
      const val = sessionRuntimeExports[item.name];

      const tr = document.createElement("tr");

      const th = document.createElement("th");
      th.scope = "row";
      th.className = "var-name";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = item.name;
      th.append(nameSpan);
      if (item.isConst) {
        const cBadge = document.createElement("span");
        cBadge.className = "const-badge";
        cBadge.textContent = "const";
        th.append(cBadge);
      }

      const tdCells = document.createElement("td");
      tdCells.className = "var-cells";
      tdCells.textContent =
        item.occurrences.length > 0
          ? item.occurrences.map((o) => `Cell ${o.cellIndex}:${o.line}`).join(", ")
          : "session";

      const tdVal = document.createElement("td");
      tdVal.className = "var-value";
      if (hasValue) {
        tdVal.textContent = val;
      } else {
        const pending = document.createElement("span");
        pending.className = "var-pending";
        pending.textContent = "no value yet (cell not run)";
        tdVal.append(pending);
      }

      tr.append(th, tdCells, tdVal);
      variablesTbodyEl.append(tr);
    }
  }

  // Collect warnings for Warnings tab
  const notebookWarnings: NotebookWarning[] = [];
  for (const item of items) {
    if (item.occurrences.length > 1) {
      notebookWarnings.push({
        id: `dup-${item.name}`,
        type: item.isConst ? "Const Reassigned" : "Duplicate Export",
        symbol: item.name,
        message: item.isConst
          ? `Constant '${item.name}' is exported ${item.occurrences.length} times across cells. Constants should only be defined once.`
          : `Variable '${item.name}' is exported ${item.occurrences.length} times. The later export will overwrite earlier values.`,
        locations: item.occurrences,
      });
    }
  }

  renderNotebookWarnings(notebookWarnings);
}

// --- Cell lifecycle --------------------------------------------------------

function renumberCells() {
  cells.forEach((c, idx) => {
    if (c.kind === "markdown") {
      c.badgeEl.textContent = "M↓ [md]";
      c.badgeEl.classList.remove("is-stale");
      c.badgeEl.title = `Cell ${idx + 1} (${c.kind})`;
    } else if (c.kind === "media") {
      c.badgeEl.textContent = "📄 [doc]";
      c.badgeEl.classList.remove("is-stale");
      c.badgeEl.title = `Cell ${idx + 1} (${c.kind})`;
    } else if (c.outputStale) {
      const num = c.runCount !== null ? `${c.runCount}*` : "*";
      c.badgeEl.textContent = `In [${num}]`;
      c.badgeEl.classList.add("is-stale");
      c.badgeEl.title = `Cell ${idx + 1} (cached output from .ppyout — not executed in current Python session)`;
    } else {
      const num = c.runCount ?? " ";
      c.badgeEl.textContent = `In [${num}]`;
      c.badgeEl.classList.remove("is-stale");
      c.badgeEl.title = `Cell ${idx + 1} (${c.kind})`;
    }
  });
}

function markDirty() {
  dirty = true;
  updateTitle();
  if (activeTab()?.kind !== "csv") {
    renderSessionExports();
    clearTimeout(transpileTimer);
    transpileTimer = window.setTimeout(refreshPython, 400);
  }

  if (currentConfig?.auto_save === "afterDelay") {
    clearTimeout(autoSaveTimer);
    const delay = Math.max(100, currentConfig.auto_save_delay || 1000);
    autoSaveTimer = window.setTimeout(() => {
      void triggerAutoSave("afterDelay");
    }, delay);
  }
}

function mimeForPath(filePath: string): string {
  const lower = filePath.toLowerCase().split("?")[0];
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function toWorkspaceRelativeIfPossible(absPath: string): string {
  const baseDir = currentPath
    ? currentPath.replace(/[\\/][^\\/]+$/, "")
    : (rootDir ?? "");
  if (!baseDir) return absPath;
  const normBase = baseDir.replace(/\/+$/, "") + "/";
  if (absPath.startsWith(normBase)) {
    return absPath.slice(normBase.length);
  }
  return absPath;
}

async function renderMediaCellViewer(cell: CellState) {
  if (cell.mediaBlobUrl) {
    URL.revokeObjectURL(cell.mediaBlobUrl);
    cell.mediaBlobUrl = null;
  }
  cell.mediaViewer.innerHTML = "";
  const rawPath = cell.mediaPath.trim();
  if (!rawPath) {
    const empty = document.createElement("div");
    empty.className = "cell-media-empty";
    empty.textContent = "No PDF or image selected yet. Click “📂 Choose PDF / Image…” above to embed an instruction manual or figure.";
    cell.mediaViewer.append(empty);
    return;
  }

  const mime = mimeForPath(rawPath);
  const isPdf = mime === "application/pdf";

  if (/^(https?:|data:|blob:)/i.test(rawPath)) {
    if (isPdf) {
      const iframe = document.createElement("iframe");
      iframe.className = "cell-pdf-frame" + (cell.pdfTall ? " tall" : "");
      iframe.src = rawPath;
      cell.mediaViewer.append(iframe);
    } else {
      const img = document.createElement("img");
      img.className = "cell-media-img";
      img.src = rawPath;
      img.alt = cell.title || rawPath;
      cell.mediaViewer.append(img);
    }
    return;
  }

  if (!backend.inTauri) {
    const empty = document.createElement("div");
    empty.className = "cell-media-empty";
    empty.textContent = `Local file preview requires the desktop app: ${rawPath}`;
    cell.mediaViewer.append(empty);
    return;
  }

  try {
    const baseDir = currentPath
      ? currentPath.replace(/[\\/][^\\/]+$/, "")
      : rootDir;
    const bytes = await backend.readBinaryFile(rawPath, baseDir);
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    const url = URL.createObjectURL(blob);
    cell.mediaBlobUrl = url;

    if (isPdf) {
      const iframe = document.createElement("iframe");
      iframe.className = "cell-pdf-frame" + (cell.pdfTall ? " tall" : "");
      iframe.src = url;
      iframe.title = cell.title || rawPath;
      cell.mediaViewer.append(iframe);
    } else {
      const img = document.createElement("img");
      img.className = "cell-media-img";
      img.src = url;
      img.alt = cell.title || rawPath;
      cell.mediaViewer.append(img);
    }
  } catch (e) {
    const err = document.createElement("div");
    err.className = "cell-media-empty";
    err.style.color = "var(--danger)";
    err.textContent = `Could not load "${rawPath}": ${String(e)}`;
    cell.mediaViewer.append(err);
  }
}

const COLLAPSED_STORAGE_KEY = "physpy_collapsed_cells";

function loadCollapsedModesForPath(filePath: string | null): Map<number, CellCollapseMode> | null {
  if (!filePath) return null;
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, unknown>;
    const entry = map[filePath];
    const out = new Map<number, CellCollapseMode>();
    if (Array.isArray(entry)) {
      for (const n of entry) {
        if (typeof n === "number" && Number.isInteger(n) && n >= 0) {
          out.set(n, "collapsed");
        }
      }
      return out.size > 0 ? out : null;
    }
    if (entry && typeof entry === "object") {
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
        const idx = Number(k);
        if (
          Number.isInteger(idx) &&
          idx >= 0 &&
          (v === "output-only" || v === "collapsed")
        ) {
          out.set(idx, v);
        }
      }
      return out.size > 0 ? out : null;
    }
    return null;
  } catch {
    return null;
  }
}

function persistCollapsedStateForActiveTab() {
  const cur = activeTab();
  if (cur && cur.kind !== "settings" && cur.kind !== "csv") {
    cur.collapsedCells = cells.map((c) => c.collapseMode);
  }
  if (!currentPath) return;
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    const map: Record<string, unknown> = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const nonExpanded: Record<number, "output-only" | "collapsed"> = {};
    let hasAny = false;
    cells.forEach((c, idx) => {
      if (c.collapseMode === "output-only" || c.collapseMode === "collapsed") {
        nonExpanded[idx] = c.collapseMode;
        hasAny = true;
      }
    });
    if (hasAny) {
      map[currentPath] = nonExpanded;
    } else {
      delete map[currentPath];
    }
    const keys = Object.keys(map);
    if (keys.length > 50) {
      for (const oldKey of keys.slice(0, keys.length - 50)) {
        delete map[oldKey];
      }
    }
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore localStorage quota/parse errors
  }
}

function canShowOutputOnly(cell: CellState): boolean {
  return cell.kind === "code" && !cell.outputWrap.hidden;
}

function nextCellCollapseMode(cell: CellState, forceHeaderOnly = false): CellCollapseMode {
  if (forceHeaderOnly) {
    return cell.collapseMode === "collapsed" ? "expanded" : "collapsed";
  }
  if (cell.collapseMode === "expanded") {
    return canShowOutputOnly(cell) ? "output-only" : "collapsed";
  }
  if (cell.collapseMode === "output-only") {
    return "collapsed";
  }
  return "expanded";
}

function buildCellCollapseSummary(cell: CellState): { text: string; hasError: boolean } {
  const src = cell.view.state.doc.toString();
  const lines = src.split("\n");
  if (cell.collapseMode === "output-only") {
    const lineLabel = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
    return { text: `⟨⟩ ${lineLabel} hidden`, hasError: false };
  }
  if (cell.kind === "media") {
    const name = cell.mediaPath.split(/[\\/]/).filter(Boolean).pop() || "No file selected";
    return { text: name, hasError: false };
  }
  const firstLine = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  const clipped = firstLine.length > 44 ? firstLine.slice(0, 41) + "…" : firstLine;

  if (cell.kind === "deps") {
    const pkgCount = lines.filter((l) => l.trim() && !l.trim().startsWith("#")).length;
    const venvTag = cell.venvPath || ".venv";
    return { text: `${pkgCount} pkg${pkgCount === 1 ? "" : "s"} · ${venvTag}`, hasError: false };
  }

  const lineLabel = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  if (cell.kind === "markdown") {
    const text = !cell.title.trim() && clipped ? `${clipped} · ${lineLabel}` : lineLabel;
    return { text, hasError: false };
  }

  const hasError = Boolean(cell.lastStderr.trim());
  const hasOut = !cell.outputWrap.hidden;
  const outTag = hasError ? " · err" : hasOut ? (cell.outputStale ? " · cached" : " · out") : "";
  const base = !cell.title.trim() && clipped ? `${clipped} · ${lineLabel}` : lineLabel;
  return { text: `${base}${outTag}`, hasError };
}

function updateCellCollapseUI(cell: CellState) {
  const mode = cell.collapseMode;
  cell.el.classList.toggle("collapsed", mode === "collapsed");
  cell.el.classList.toggle("output-only", mode === "output-only");

  if (mode === "expanded") {
    cell.btnCollapse.textContent = "▾";
    cell.btnCollapse.setAttribute("aria-expanded", "true");
    cell.btnCollapse.title = canShowOutputOnly(cell)
      ? "Hide code (output only), or Alt+Click to collapse whole cell"
      : "Collapse cell (Cmd+Opt+[ or double-click header)";
    cell.collapseSummaryEl.hidden = true;
    cell.collapseSummaryEl.classList.remove("has-error", "is-output-only");
    return;
  }

  if (mode === "output-only") {
    cell.btnCollapse.textContent = "◫";
    cell.btnCollapse.setAttribute("aria-expanded", "false");
    cell.btnCollapse.title = "Output only — click to collapse whole cell (or click chip to show code)";
    const summary = buildCellCollapseSummary(cell);
    cell.collapseSummaryEl.textContent = summary.text;
    cell.collapseSummaryEl.classList.remove("has-error");
    cell.collapseSummaryEl.classList.add("is-output-only");
    cell.collapseSummaryEl.title = "Click to show code";
    cell.collapseSummaryEl.hidden = false;
    return;
  }

  cell.btnCollapse.textContent = "▸";
  cell.btnCollapse.setAttribute("aria-expanded", "false");
  cell.btnCollapse.title = "Expand cell (Cmd+Opt+] or double-click header)";
  const summary = buildCellCollapseSummary(cell);
  cell.collapseSummaryEl.textContent = summary.text;
  cell.collapseSummaryEl.classList.remove("is-output-only");
  cell.collapseSummaryEl.classList.toggle("has-error", summary.hasError);
  cell.collapseSummaryEl.title = "Click to expand cell";
  cell.collapseSummaryEl.hidden = false;
}

function isReportViewActive(): boolean {
  if (cells.length === 0) return false;
  let hasHideableCode = false;
  for (const c of cells) {
    if (c.kind === "code" || c.kind === "deps") {
      hasHideableCode = true;
      const expected: CellCollapseMode = canShowOutputOnly(c) ? "output-only" : "collapsed";
      if (c.collapseMode !== expected) return false;
    } else if (c.kind === "markdown" && c.mdEditing) {
      return false;
    }
  }
  return hasHideableCode;
}

function updateCollapseToolbarButtons() {
  const btn = document.getElementById("btn-toggle-collapse-all") as HTMLButtonElement | null;
  if (btn) {
    const allCollapsed = cells.length > 0 && cells.every((c) => c.collapseMode === "collapsed");
    btn.textContent = allCollapsed ? "⊞ Expand All" : "⊟ Collapse All";
    btn.title = allCollapsed ? "Expand all cells" : "Collapse all cells";
  }
  const btnReport = document.getElementById("btn-report-view") as HTMLButtonElement | null;
  if (btnReport) {
    const active = isReportViewActive();
    btnReport.classList.toggle("active-toggle", active);
    btnReport.title = active
      ? "Exit Report View (expand all cells)"
      : "Report View: hide code, keep outputs & rendered Markdown";
  }
}

function setCellCollapseMode(cell: CellState, mode: CellCollapseMode, persist = true) {
  const normalized: CellCollapseMode =
    mode === "output-only" && cell.kind !== "code" ? "collapsed" : mode;
  if (cell.collapseMode === normalized) {
    if (normalized !== "expanded") updateCellCollapseUI(cell);
    return;
  }
  cell.collapseMode = normalized;
  updateCellCollapseUI(cell);
  updateCollapseToolbarButtons();
  if (persist) {
    persistCollapsedStateForActiveTab();
  }
}

function setAllCellsCollapseMode(mode: "expanded" | "collapsed") {
  for (const cell of cells) {
    cell.collapseMode = mode;
    updateCellCollapseUI(cell);
  }
  updateCollapseToolbarButtons();
  persistCollapsedStateForActiveTab();
}

function applyReportView() {
  for (const cell of cells) {
    if (cell.kind === "code") {
      cell.collapseMode = canShowOutputOnly(cell) ? "output-only" : "collapsed";
    } else if (cell.kind === "deps") {
      cell.collapseMode = "collapsed";
    } else if (cell.kind === "markdown") {
      if (cell.mdEditing) {
        const curDoc = cell.view.state.doc.toString();
        if (looksLikeCommentedMarkdownCell(curDoc)) {
          setDoc(cell.view, uncommentMarkdownBlock(curDoc));
        }
        cell.mdEditing = false;
        applyCellKindUI(cell);
      }
      cell.collapseMode = "expanded";
    } else {
      cell.collapseMode = "expanded";
    }
    updateCellCollapseUI(cell);
  }
  updateCollapseToolbarButtons();
  persistCollapsedStateForActiveTab();
}

function toggleReportView() {
  if (isReportViewActive()) {
    setAllCellsCollapseMode("expanded");
  } else {
    applyReportView();
  }
}

function updateMarkdownPreview(cell: CellState) {
  cell.mdPreviewEl.innerHTML = renderMarkdownWithLatex(cell.view.state.doc.toString());
}

function applyCellKindUI(cell: CellState) {
  cell.el.classList.remove("kind-code", "kind-markdown", "kind-media", "kind-deps");
  cell.el.classList.add(`kind-${cell.kind}`);
  cell.kindSelect.value = cell.kind;

  if (cell.kind === "code") {
    cell.editorHost.hidden = false;
    cell.mdPreviewEl.hidden = true;
    cell.mediaWrap.hidden = true;
    cell.depsWrap.hidden = true;
    cell.btnAi.hidden = false;
    cell.btnDebug.hidden = false;
    cell.aiWrap.hidden = !cell.aiOpen;
    cell.btnRun.innerHTML = "▶ Run <kbd>⌘↵</kbd>";
    cell.btnRun.title = "Run this code cell (Cmd+Enter or Shift+Enter)";
  } else if (cell.kind === "markdown") {
    cell.depsWrap.hidden = true;
    cell.mediaWrap.hidden = true;
    cell.outputWrap.hidden = true;
    cell.btnAi.hidden = true;
    cell.btnDebug.hidden = true;
    cell.aiWrap.hidden = true;
    updateMarkdownPreview(cell);
    cell.editorHost.hidden = !cell.mdEditing;
    cell.mdPreviewEl.hidden = cell.mdEditing;
    if (cell.mdEditing) {
      cell.btnRun.innerHTML = "✓ Render <kbd>⌘↵</kbd>";
      cell.btnRun.title = "Render Markdown + LaTeX (Cmd+Enter or Shift+Enter)";
    } else {
      cell.btnRun.innerHTML = "✎ Edit";
      cell.btnRun.title = "Edit Markdown + LaTeX source (or double-click preview)";
    }
  } else if (cell.kind === "deps") {
    cell.editorHost.hidden = false;
    cell.mdPreviewEl.hidden = true;
    cell.mediaWrap.hidden = true;
    cell.outputWrap.hidden = true;
    cell.btnAi.hidden = true;
    cell.btnDebug.hidden = true;
    cell.aiWrap.hidden = true;
    cell.depsWrap.hidden = false;
    cell.depsVenvBadge.textContent = cell.venvPath || ".venv";
    cell.btnRun.innerHTML = "⚡ Install <kbd>⌘↵</kbd>";
    cell.btnRun.title = "Install packages into virtual environment (Cmd+Enter)";
    cell.badgeEl.textContent = "Pkg";
  } else {
    cell.depsWrap.hidden = true;
    cell.editorHost.hidden = true;
    cell.mdPreviewEl.hidden = true;
    cell.outputWrap.hidden = true;
    cell.btnAi.hidden = true;
    cell.btnDebug.hidden = true;
    cell.aiWrap.hidden = true;
    cell.mediaWrap.hidden = false;
    cell.btnRun.innerHTML = "📂 Choose File…";
    cell.btnRun.title = "Choose a PDF or image file to embed in this cell";
    void renderMediaCellViewer(cell);
  }
  renumberCells();
  if (cell.kind !== "code" && cell.collapseMode === "output-only") {
    cell.collapseMode = "expanded";
  }
  updateCellCollapseUI(cell);
}

function createCellCard(initial: ParsedCell, insertAt?: number): CellState {
  const id = nextCellId++;
  const card = document.createElement("div");
  card.className = "cell-card";

  const header = document.createElement("div");
  header.className = "cell-header";

  const btnCollapse = document.createElement("button");
  btnCollapse.type = "button";
  btnCollapse.className = "cell-collapse-btn";
  btnCollapse.textContent = "▾";
  btnCollapse.setAttribute("aria-expanded", "true");
  btnCollapse.title = "Collapse cell (Cmd+Opt+[ or double-click header)";

  const badgeEl = document.createElement("span");
  badgeEl.className = "cell-badge";
  badgeEl.textContent = "In [ ]";

  const kindSelect = document.createElement("select");
  kindSelect.className = "cell-kind-select";
  kindSelect.title = "Cell type (Code, Markdown + LaTeX, PDF / Image, or Packages)";
  kindSelect.innerHTML = `
    <option value="code">⚛ Code</option>
    <option value="markdown">M↓ Markdown + LaTeX</option>
    <option value="media">📄 PDF / Image</option>
    <option value="deps">📦 Packages</option>
  `;
  kindSelect.value = initial.kind;

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "cell-title";
  titleInput.placeholder = "Cell title (optional)…";
  titleInput.value = initial.title;
  titleInput.addEventListener("input", () => {
    state.title = titleInput.value;
    if (state.collapseMode !== "expanded") updateCellCollapseUI(state);
    markDirty();
  });

  const collapseSummaryEl = document.createElement("span");
  collapseSummaryEl.className = "cell-collapse-summary";
  collapseSummaryEl.hidden = true;
  collapseSummaryEl.title = "Click to expand cell";

  const actions = document.createElement("div");
  actions.className = "cell-actions";

  const btnAi = document.createElement("button");
  btnAi.type = "button";
  btnAi.className = "cell-btn ai";
  btnAi.innerHTML = "✨ AI <kbd>⌘K</kbd>";
  btnAi.title = "Ask Gemini AI to edit or generate code for this cell (Cmd+K)";

  const btnRun = document.createElement("button");
  btnRun.type = "button";
  btnRun.className = "cell-btn run";
  btnRun.innerHTML = "▶ Run <kbd>⌘↵</kbd>";
  btnRun.title = "Run this cell (Cmd+Enter or Shift+Enter)";

  const btnDebug = document.createElement("button");
  btnDebug.type = "button";
  btnDebug.className = "cell-btn debug";
  btnDebug.innerHTML = "🐞 Debug";
  btnDebug.title = "Step-by-step debugger (F10/F11)";
  btnDebug.addEventListener("click", () => {
    void startCellDebugging(state);
  });

  const btnAdd = document.createElement("button");
  btnAdd.type = "button";
  btnAdd.className = "cell-btn";
  btnAdd.textContent = "+ Below";
  btnAdd.title = "Insert a cell below";

  const btnUp = document.createElement("button");
  btnUp.type = "button";
  btnUp.className = "cell-btn";
  btnUp.textContent = "↑";
  btnUp.title = "Move cell up";

  const btnDown = document.createElement("button");
  btnDown.type = "button";
  btnDown.className = "cell-btn";
  btnDown.textContent = "↓";
  btnDown.title = "Move cell down";

  const btnDel = document.createElement("button");
  btnDel.type = "button";
  btnDel.className = "cell-btn danger";
  btnDel.textContent = "✕";
  btnDel.title = "Delete cell";

  actions.append(btnAi, btnDebug, btnRun, btnAdd, btnUp, btnDown, btnDel);
  header.append(btnCollapse, badgeEl, kindSelect, titleInput, collapseSummaryEl, actions);

  // Step Debugger Control Bar
  const debugBar = document.createElement("div");
  debugBar.className = "cell-debug-bar";
  debugBar.hidden = true;

  const debugBarLeft = document.createElement("div");
  debugBarLeft.className = "debug-bar-left";

  const debugStatusPill = document.createElement("span");
  debugStatusPill.className = "debug-status-pill";
  const debugStatusDot = document.createElement("span");
  debugStatusDot.className = "dot";
  const debugStatusText = document.createElement("span");
  debugStatusText.innerHTML = 'Paused at line <strong class="debug-line-num">1</strong>';
  debugStatusPill.append(debugStatusDot, debugStatusText);

  const debugLineNumEl = debugStatusText.querySelector<HTMLElement>(".debug-line-num")!;
  const debugFilenameEl = document.createElement("span");
  debugFilenameEl.className = "debug-filename-pill";
  debugBarLeft.append(debugStatusPill, debugFilenameEl);

  const debugBarActions = document.createElement("div");
  debugBarActions.className = "debug-bar-actions";

  const btnStepOver = document.createElement("button");
  btnStepOver.type = "button";
  btnStepOver.className = "debug-btn primary";
  btnStepOver.innerHTML = "↷ Step <kbd>F10</kbd>";
  btnStepOver.title = "Step Over: execute next line in this cell (F10)";
  btnStepOver.addEventListener("click", () => void handleDebugAction("step_over"));

  const btnStepInto = document.createElement("button");
  btnStepInto.type = "button";
  btnStepInto.className = "debug-btn";
  btnStepInto.innerHTML = "⤓ Into <kbd>F11</kbd>";
  btnStepInto.title = "Step Into: step inside function (F11)";
  btnStepInto.addEventListener("click", () => void handleDebugAction("step_into"));

  const btnStepOut = document.createElement("button");
  btnStepOut.type = "button";
  btnStepOut.className = "debug-btn";
  btnStepOut.innerHTML = "⤒ Out <kbd>⇧F11</kbd>";
  btnStepOut.title = "Step Out: return from current function (Shift+F11)";
  btnStepOut.addEventListener("click", () => void handleDebugAction("step_out"));

  const btnContinue = document.createElement("button");
  btnContinue.type = "button";
  btnContinue.className = "debug-btn";
  btnContinue.innerHTML = "▶ Continue <kbd>F5</kbd>";
  btnContinue.title = "Continue execution to the end of cell (F5)";
  btnContinue.addEventListener("click", () => void handleDebugAction("continue"));

  const btnStop = document.createElement("button");
  btnStop.type = "button";
  btnStop.className = "debug-btn danger";
  btnStop.innerHTML = "⏹ Stop <kbd>Esc</kbd>";
  btnStop.title = "Stop debugging session (Escape or Shift+F5)";
  btnStop.addEventListener("click", () => void handleDebugAction("stop"));

  debugBarActions.append(btnStepOver, btnStepInto, btnStepOut, btnContinue, btnStop);

  const debugLocalsEl = document.createElement("div");
  debugLocalsEl.className = "debug-locals-preview";
  debugLocalsEl.hidden = true;

  debugBar.append(debugBarLeft, debugBarActions, debugLocalsEl);

  // AI Cell Assistant prompt & proposal drawer
  const aiWrap = document.createElement("div");
  aiWrap.className = "cell-ai-wrap";
  aiWrap.hidden = true;

  const aiPromptRow = document.createElement("div");
  aiPromptRow.className = "cell-ai-prompt-row";

  const aiBadge = document.createElement("span");
  aiBadge.className = "cell-ai-badge";
  aiBadge.textContent = "✨ Gemini";

  const aiPromptInput = document.createElement("textarea");
  aiPromptInput.className = "cell-ai-input";
  aiPromptInput.rows = 1;
  aiPromptInput.placeholder =
    "Opisz co zmienić lub dopisać w tej komórce… (Enter = wyślij, Shift+Enter = nowa linia, Esc = zamknij)";

  const aiContextLabel = document.createElement("label");
  aiContextLabel.className = "cell-ai-context-toggle";
  aiContextLabel.title = "Dołącz poprzednie komórki i aktywne zmienne export do kontekstu";
  const aiContextCheck = document.createElement("input");
  aiContextCheck.type = "checkbox";
  aiContextCheck.checked = true;
  const aiContextSpan = document.createElement("span");
  aiContextSpan.textContent = "Context";
  aiContextLabel.append(aiContextCheck, aiContextSpan);

  const btnAiGenerate = document.createElement("button");
  btnAiGenerate.type = "button";
  btnAiGenerate.className = "cell-btn run cell-ai-generate";
  btnAiGenerate.textContent = "Generate";

  const btnAiClose = document.createElement("button");
  btnAiClose.type = "button";
  btnAiClose.className = "cell-btn";
  btnAiClose.textContent = "✕";
  btnAiClose.title = "Close AI prompt";

  aiPromptRow.append(aiBadge, aiPromptInput, aiContextLabel, btnAiGenerate, btnAiClose);

  const aiStatusBar = document.createElement("div");
  aiStatusBar.className = "cell-ai-status";
  aiStatusBar.hidden = true;

  const aiProposal = document.createElement("div");
  aiProposal.className = "cell-ai-proposal";
  aiProposal.hidden = true;

  const aiProposalHeader = document.createElement("div");
  aiProposalHeader.className = "cell-ai-proposal-header";

  const aiExplanation = document.createElement("span");
  aiExplanation.className = "cell-ai-explanation";

  const aiProposalActions = document.createElement("div");
  aiProposalActions.className = "cell-ai-proposal-actions";

  const btnAiAccept = document.createElement("button");
  btnAiAccept.type = "button";
  btnAiAccept.className = "cell-btn run";
  btnAiAccept.textContent = "✓ Replace Cell";
  btnAiAccept.title = "Replace current cell code with this suggestion";

  const btnAiInsertBelow = document.createElement("button");
  btnAiInsertBelow.type = "button";
  btnAiInsertBelow.className = "cell-btn";
  btnAiInsertBelow.textContent = "+ Insert Below";
  btnAiInsertBelow.title = "Insert suggestion as a new cell below";

  const btnAiCopy = document.createElement("button");
  btnAiCopy.type = "button";
  btnAiCopy.className = "cell-btn";
  btnAiCopy.textContent = "Copy";

  const btnAiDiscard = document.createElement("button");
  btnAiDiscard.type = "button";
  btnAiDiscard.className = "cell-btn";
  btnAiDiscard.textContent = "Discard";

  aiProposalActions.append(btnAiAccept, btnAiInsertBelow, btnAiCopy, btnAiDiscard);
  aiProposalHeader.append(aiExplanation, aiProposalActions);

  const aiPreviewPre = document.createElement("pre");
  aiPreviewPre.className = "cell-ai-preview";

  aiProposal.append(aiProposalHeader, aiPreviewPre);
  aiWrap.append(aiPromptRow, aiStatusBar, aiProposal);

  // Packages / Dependencies toolbar & view
  const depsWrap = document.createElement("div");
  depsWrap.className = "cell-deps-wrap";
  depsWrap.hidden = true;

  const depsBar = document.createElement("div");
  depsBar.className = "cell-deps-bar";

  const venvLabel = document.createElement("span");
  venvLabel.className = "cell-deps-venv-label";
  venvLabel.innerHTML = "🐍 Venv:";

  const depsVenvBadge = document.createElement("span");
  depsVenvBadge.className = "cell-deps-venv-badge";
  depsVenvBadge.textContent = initial.venv || ".venv";

  const depsActions = document.createElement("div");
  depsActions.className = "cell-deps-actions";

  const btnSelectVenv = document.createElement("button");
  btnSelectVenv.type = "button";
  btnSelectVenv.className = "cell-btn";
  btnSelectVenv.textContent = "📂 Choose Venv…";
  btnSelectVenv.title = "Select an existing virtual environment or Python executable";

  const btnCreateVenv = document.createElement("button");
  btnCreateVenv.type = "button";
  btnCreateVenv.className = "cell-btn";
  btnCreateVenv.textContent = "+ Create .venv";
  btnCreateVenv.title = "Create a fresh .venv in this document folder (via uv / venv)";

  const btnSyncDeps = document.createElement("button");
  btnSyncDeps.type = "button";
  btnSyncDeps.className = "cell-btn run";
  btnSyncDeps.textContent = "⚡ Install / Sync";
  btnSyncDeps.title = "Install requirements to venv and sync requirements.txt";

  depsActions.append(btnSelectVenv, btnCreateVenv, btnSyncDeps);
  depsBar.append(venvLabel, depsVenvBadge, depsActions);

  const depsHint = document.createElement("div");
  depsHint.className = "cell-deps-hint";
  depsHint.innerHTML = "List dependencies line by line (e.g. <code>numpy</code>, <code>scipy&gt;=1.10</code>). Auto-syncs to <code>requirements.txt</code>.";

  const depsLogPre = document.createElement("pre");
  depsLogPre.className = "cell-deps-log";
  depsLogPre.hidden = true;

  depsWrap.append(depsBar, depsHint, depsLogPre);

  const editorHost = document.createElement("div");
  editorHost.className = "cell-editor";

  const mdPreviewEl = document.createElement("div");
  mdPreviewEl.className = "cell-md-preview";
  mdPreviewEl.hidden = true;
  mdPreviewEl.title = "Double-click to edit Markdown + LaTeX";

  const mediaWrap = document.createElement("div");
  mediaWrap.className = "cell-media-wrap";
  mediaWrap.hidden = true;

  const mediaBar = document.createElement("div");
  mediaBar.className = "cell-media-bar";

  const mediaInput = document.createElement("input");
  mediaInput.type = "text";
  mediaInput.className = "cell-media-input";
  mediaInput.placeholder = "Path to .pdf or image (.png, .jpg, .svg, .webp)…";
  mediaInput.value = initial.kind === "media" ? initial.source : "";

  const btnBrowseMedia = document.createElement("button");
  btnBrowseMedia.type = "button";
  btnBrowseMedia.className = "cell-btn";
  btnBrowseMedia.textContent = "📂 Choose PDF / Image…";

  const btnToggleTall = document.createElement("button");
  btnToggleTall.type = "button";
  btnToggleTall.className = "cell-btn";
  btnToggleTall.textContent = "↕ Expand Height";
  btnToggleTall.title = "Toggle taller PDF viewer height";

  mediaBar.append(mediaInput, btnBrowseMedia, btnToggleTall);

  const mediaViewer = document.createElement("div");
  mediaViewer.className = "cell-media-viewer";
  mediaWrap.append(mediaBar, mediaViewer);

const COPY_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"></rect><path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"></path></svg>`;
const CHECK_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3.5 8.5 6.5 11.5 12.5 4.5"></polyline></svg>`;

  const outputWrap = document.createElement("div");
  outputWrap.className = "cell-output-wrap";
  outputWrap.hidden = true;

  const outputActions = document.createElement("div");
  outputActions.className = "cell-output-actions";

  const tableModeGroup = document.createElement("div");
  tableModeGroup.className = "cell-output-mode-toggle";
  tableModeGroup.hidden = true;

  const btnTableView = document.createElement("button");
  btnTableView.type = "button";
  btnTableView.className = "cell-output-mode-btn active";
  btnTableView.textContent = "Table";
  btnTableView.title = "View output as table";

  const btnTextView = document.createElement("button");
  btnTextView.type = "button";
  btnTextView.className = "cell-output-mode-btn";
  btnTextView.textContent = "Text";
  btnTextView.title = "View raw text output";

  tableModeGroup.append(btnTableView, btnTextView);

  const btnCopyOutput = document.createElement("button");
  btnCopyOutput.type = "button";
  btnCopyOutput.className = "cell-copy-output-btn";
  btnCopyOutput.title = "Copy output";
  btnCopyOutput.setAttribute("aria-label", "Copy output");
  btnCopyOutput.innerHTML = COPY_ICON_SVG;
  btnCopyOutput.hidden = true;

  const staleBadgeEl = document.createElement("span");
  staleBadgeEl.className = "cell-output-stale-badge";
  staleBadgeEl.textContent = "cached · not run";
  staleBadgeEl.title = "Output restored from .ppyout — run cell to execute in current Python session";
  staleBadgeEl.hidden = true;

  outputActions.append(staleBadgeEl, tableModeGroup, btnCopyOutput);

  const exportedBar = document.createElement("div");
  exportedBar.className = "cell-exported";
  exportedBar.hidden = true;

  const outputPre = document.createElement("pre");
  outputPre.className = "cell-output";

  const tablesWrap = document.createElement("div");
  tablesWrap.className = "cell-tables-wrap";
  tablesWrap.hidden = true;

  const plotsWrap = document.createElement("div");
  plotsWrap.className = "cell-plots";
  plotsWrap.hidden = true;

  const latexWrap = document.createElement("div");
  latexWrap.className = "cell-latex-output";
  latexWrap.hidden = true;

  outputWrap.append(outputActions, exportedBar, latexWrap, outputPre, tablesWrap, plotsWrap);
  card.append(header, debugBar, aiWrap, depsWrap, editorHost, mdPreviewEl, mediaWrap, outputWrap);

  const view = createEditor({
    parent: editorHost,
    doc: initial.kind === "media" ? "" : initial.source,
    keys: [
      { key: "Mod-Enter", run: () => (void runSingleCell(state, false), true) },
      { key: "Shift-Enter", run: () => (void runSingleCell(state, true), true) },
      { key: "Mod-Shift-Enter", run: () => (void runAllCells(), true) },
      {
        key: "Mod-k",
        run: () => {
          if (state.kind !== "code") return false;
          openAiPanel();
          return true;
        },
      },
      { key: "F10", run: () => (activeDebugSession ? (void handleDebugAction("step_over"), true) : false) },
      { key: "F11", run: () => (activeDebugSession ? (void handleDebugAction("step_into"), true) : false) },
      { key: "Shift-F11", run: () => (activeDebugSession ? (void handleDebugAction("step_out"), true) : false) },
      { key: "F5", run: () => (activeDebugSession ? (void handleDebugAction("continue"), true) : false) },
      { key: "Mod-s", run: () => (void saveFile(), true) },
      { key: "Mod-o", run: () => (void openFile(), true) },
      { key: "Mod-Shift-o", run: () => (void changeRootFolder(), true) },
      { key: "Mod-n", run: () => (createNewTab(), true) },
      { key: "Mod-w", run: () => (closeTab(activeTabId), true) },
      { key: "Mod-b", run: () => toggleSidebar() },
      { key: "Mod-j", run: () => toggleVariablesDrawer() },
      { key: "Mod-Shift-j", run: () => toggleWarningsDrawer() },
      { key: "Mod-Shift-m", run: () => (openMatrixDialog(), true) },
      { key: "Mod-Shift-e", run: () => (openExportHtmlDialog(), true) },
      { key: "Mod-Shift-d", run: () => (void startCellDebugging(state), true) },
      { key: "Mod-p", run: () => togglePython() },
      { key: "Mod-Alt-[", run: () => (setCellCollapseMode(state, nextCellCollapseMode(state)), true) },
      { key: "Mod-Alt-]", run: () => (setCellCollapseMode(state, "expanded"), true) },
    ],
    onChange: markDirty,
    onBlur: () => handleEditorBlur(),
    pythonAssist: {
      isEnabled: () => state.kind === "code",
      getDocSource: () =>
        cells
          .filter((c) => c !== state && c.kind === "code")
          .map((c) => c.view.state.doc.toString())
          .join("\n\n"),
      complete: (req) =>
        backend.inTauri ? backend.completePython(req) : Promise.resolve([]),
      signature: (req) =>
        backend.inTauri ? backend.signaturePython(req) : Promise.resolve(null),
    },
  });

  const state: CellState = {
    id,
    kind: initial.kind,
    title: initial.title,
    collapseMode: "expanded",
    view,
    el: card,
    btnCollapse,
    collapseSummaryEl,
    badgeEl,
    kindSelect,
    titleInput,
    editorHost,
    mdPreviewEl,
    mdEditing: initial.kind === "markdown" ? !initial.source.trim() : true,
    mediaWrap,
    mediaInput,
    mediaViewer,
    mediaPath: initial.kind === "media" ? initial.source.trim() : "",
    mediaBlobUrl: null,
    pdfTall: false,
    depsWrap,
    depsVenvBadge,
    depsLogPre,
    venvPath: initial.venv || "",
    depsInstalling: false,
    btnRun,
    btnDebug,
    debugBar,
    debugLineNumEl,
    debugFilenameEl,
    debugLocalsEl,
    btnAi,
    aiWrap,
    aiPromptInput,
    aiOpen: false,
    outputWrap,
    staleBadgeEl,
    btnCopyOutput,
    tableModeGroup,
    btnTableView,
    btnTextView,
    outputPre,
    tablesWrap,
    plotsWrap,
    exportedBar,
    latexWrap,
    lastTables: [],
    lastFullStdout: "",
    lastNonTableStdout: "",
    lastStderr: "",
    lastExported: {},
    lastPlots: [],
    lastLatex: null,
    tableViewMode: "table",
    runCount: null,
    outputStale: false,
  };

  btnTableView.addEventListener("click", () => {
    state.tableViewMode = "table";
    applyCellOutputView(state);
    scheduleWriteOutputsSidecar();
  });
  btnTextView.addEventListener("click", () => {
    state.tableViewMode = "text";
    applyCellOutputView(state);
    scheduleWriteOutputsSidecar();
  });

  let copyFeedbackTimer: number | undefined;
  btnCopyOutput.addEventListener("click", async () => {
    const textToCopy =
      state.lastTables.length > 0 && state.tableViewMode === "table"
        ? tablesToTsv(state.lastTables)
        : (!outputPre.hidden && outputPre.textContent) ||
          (!latexWrap.hidden && latexWrap.dataset.latex) ||
          (!exportedBar.hidden && exportedBar.textContent?.replace(/^↳ exported:\s*/, "")) ||
          (state.lastTables.length > 0
            ? state.lastTables.map((t) => t.raw_text).join("\n\n")
            : "") ||
          "";
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      btnCopyOutput.innerHTML = CHECK_ICON_SVG;
      btnCopyOutput.classList.add("copied");
      setStatus(
        state.lastTables.length > 0 && state.tableViewMode === "table"
          ? "Copied table (TSV) to clipboard"
          : "Copied output to clipboard",
      );
      clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = window.setTimeout(() => {
        btnCopyOutput.innerHTML = COPY_ICON_SVG;
        btnCopyOutput.classList.remove("copied");
      }, 1500);
    } catch (err) {
      setStatus(`Failed to copy output: ${String(err)}`);
    }
  });

  let proposedAiCode = "";

  const openAiPanel = (open?: boolean) => {
    if (state.kind !== "code") return;
    state.aiOpen = open !== undefined ? open : !state.aiOpen;
    if (state.aiOpen && state.collapseMode !== "expanded") {
      setCellCollapseMode(state, "expanded");
    }
    state.aiWrap.hidden = !state.aiOpen;
    if (state.aiOpen) {
      state.aiPromptInput.focus();
    } else {
      state.view.focus();
    }
  };

  const runAiRequest = async () => {
    if (!requireTauri()) return;
    const promptText = aiPromptInput.value.trim();
    if (!promptText) {
      aiStatusBar.hidden = false;
      aiStatusBar.className = "cell-ai-status error";
      aiStatusBar.textContent = "Wpisz polecenie dla Gemini przed wysłaniem.";
      aiPromptInput.focus();
      return;
    }

    const idx = cells.indexOf(state);
    const contextBefore = aiContextCheck.checked
      ? cells
          .slice(0, Math.max(0, idx))
          .filter((c) => c.kind === "code" && c.view.state.doc.toString().trim().length > 0)
          .map((c, i) => `# --- Cell ${i + 1}${c.title ? `: ${c.title}` : ""} ---\n${c.view.state.doc.toString()}`)
          .join("\n\n")
      : "";
    const exportsCtx = aiContextCheck.checked ? { ...sessionRuntimeExports } : {};

    btnAiGenerate.disabled = true;
    btnAiGenerate.textContent = "Thinking…";
    aiStatusBar.hidden = false;
    aiStatusBar.className = "cell-ai-status loading";
    aiStatusBar.textContent = "Asking Gemini…";
    aiProposal.hidden = true;

    try {
      const res = await backend.aiAssist({
        prompt: promptText,
        cellSource: state.view.state.doc.toString(),
        contextBefore,
        exports: exportsCtx,
        workspaceDir: rootDir,
      });
      proposedAiCode = res.code;
      aiStatusBar.hidden = true;
      aiExplanation.textContent =
        res.explanation || `Suggested code${res.model ? ` (${res.model})` : ""}`;
      aiPreviewPre.textContent = proposedAiCode;
      aiProposal.hidden = false;
    } catch (err) {
      const msg = String(err);
      aiStatusBar.hidden = false;
      aiStatusBar.className = "cell-ai-status error";
      aiStatusBar.textContent = msg;
      if (/api key|GEMINI_API_KEY|ai_api_key/i.test(msg)) {
        const btnCfg = document.createElement("button");
        btnCfg.type = "button";
        btnCfg.className = "cell-ai-settings-link";
        btnCfg.textContent = "Open Settings →";
        btnCfg.addEventListener("click", () => openSettingsTab("global"));
        aiStatusBar.append(" ", btnCfg);
      }
    } finally {
      btnAiGenerate.disabled = false;
      btnAiGenerate.textContent = "Generate";
    }
  };

  btnAi.addEventListener("click", () => openAiPanel());
  btnAiClose.addEventListener("click", () => openAiPanel(false));
  btnAiGenerate.addEventListener("click", () => void runAiRequest());
  aiPromptInput.addEventListener("input", () => {
    aiPromptInput.style.height = "auto";
    aiPromptInput.style.height = `${Math.min(120, Math.max(30, aiPromptInput.scrollHeight))}px`;
  });
  aiPromptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runAiRequest();
    } else if (e.key === "Escape") {
      e.preventDefault();
      openAiPanel(false);
    }
  });
  btnAiAccept.addEventListener("click", () => {
    if (!proposedAiCode) return;
    setDoc(state.view, proposedAiCode);
    markDirty();
    aiProposal.hidden = true;
    openAiPanel(false);
    setStatus("Applied AI code suggestion (Cmd+Z to undo)");
  });
  btnAiInsertBelow.addEventListener("click", () => {
    if (!proposedAiCode) return;
    const idx = cells.indexOf(state);
    const created = createCellCard({ kind: "code", title: "", source: proposedAiCode }, idx + 1);
    markDirty();
    aiProposal.hidden = true;
    openAiPanel(false);
    created.view.focus();
    setStatus("Inserted AI suggestion below");
  });
  btnAiCopy.addEventListener("click", async () => {
    if (!proposedAiCode) return;
    try {
      await navigator.clipboard.writeText(proposedAiCode);
      setStatus("Copied AI suggestion to clipboard");
    } catch (err) {
      setStatus(`Copy failed: ${String(err)}`);
    }
  });
  btnAiDiscard.addEventListener("click", () => {
    proposedAiCode = "";
    aiProposal.hidden = true;
    aiStatusBar.hidden = true;
  });

  btnSelectVenv.addEventListener("click", async () => {
    if (!requireTauri()) return;
    const baseDir = currentPath
      ? currentPath.replace(/[\\/][^\\/]+$/, "")
      : (rootDir ?? "");
    const picked = await backend.pickFolder(baseDir);
    if (picked) {
      const rel = await backend.computeRelativePath(baseDir, picked);
      state.venvPath = rel;
      depsVenvBadge.textContent = rel;
      const info = await backend.resolveVenv(baseDir, rel);
      if (info) {
        await backend.setPythonInterpreter(info.path);
        updateActiveInterpreterUI(info);
        depsLogPre.textContent = `✓ Active Python switched to: ${info.label}\n(${info.path})`;
        depsLogPre.className = "cell-deps-log success";
        depsLogPre.hidden = false;
      } else {
        depsLogPre.textContent = `Selected folder: ${rel}\n(Note: No Python executable detected inside yet)`;
        depsLogPre.className = "cell-deps-log";
        depsLogPre.hidden = false;
      }
      markDirty();
    }
  });

  btnCreateVenv.addEventListener("click", async () => {
    if (!requireTauri()) return;
    const baseDir = currentPath
      ? currentPath.replace(/[\\/][^\\/]+$/, "")
      : (rootDir ?? "");
    setStatus("Creating virtualenv .venv…");
    depsLogPre.textContent = "Creating virtual environment .venv…";
    depsLogPre.className = "cell-deps-log";
    depsLogPre.hidden = false;
    try {
      const info = await backend.createVenv(baseDir, ".venv");
      state.venvPath = ".venv";
      depsVenvBadge.textContent = ".venv";
      updateActiveInterpreterUI(info);
      depsLogPre.textContent = `✓ Created virtual environment .venv successfully!\nActive Python: ${info.label}`;
      depsLogPre.className = "cell-deps-log success";
      setStatus("✓ Created .venv");
      markDirty();
    } catch (err) {
      depsLogPre.textContent = `✕ Failed to create venv: ${String(err)}`;
      depsLogPre.className = "cell-deps-log error";
      setStatus("✕ Failed to create venv");
    }
  });

  btnSyncDeps.addEventListener("click", () => void runDepsCell(state));

  kindSelect.addEventListener("change", () => {
    const newKind = kindSelect.value as CellKind;
    state.kind = newKind;
    if (newKind === "markdown") {
      const curDoc = state.view.state.doc.toString();
      const uncommented = uncommentMarkdownBlock(curDoc);
      if (uncommented !== curDoc) {
        setDoc(state.view, uncommented);
      }
      state.mdEditing = !uncommented.trim();
    }
    applyCellKindUI(state);
    markDirty();
  });

  mdPreviewEl.addEventListener("dblclick", () => {
    state.mdEditing = true;
    applyCellKindUI(state);
    state.view.focus();
  });

  const pickMediaForCell = async () => {
    if (!requireTauri()) return;
    const picked = await backend.pickMediaFile();
    if (picked) {
      const rel = toWorkspaceRelativeIfPossible(picked);
      state.mediaPath = rel;
      state.mediaInput.value = rel;
      if (!state.title.trim()) {
        const baseName = picked.split(/[\\/]/).pop() ?? "";
        state.title = baseName;
        state.titleInput.value = baseName;
      }
      await renderMediaCellViewer(state);
      markDirty();
    }
  };

  btnBrowseMedia.addEventListener("click", () => void pickMediaForCell());
  mediaInput.addEventListener("change", () => {
    state.mediaPath = mediaInput.value.trim();
    void renderMediaCellViewer(state);
    markDirty();
  });
  mediaInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      state.mediaPath = mediaInput.value.trim();
      void renderMediaCellViewer(state);
      markDirty();
    }
  });
  btnToggleTall.addEventListener("click", () => {
    state.pdfTall = !state.pdfTall;
    btnToggleTall.textContent = state.pdfTall ? "↕ Compact Height" : "↕ Expand Height";
    const frame = state.mediaViewer.querySelector(".cell-pdf-frame");
    if (frame) {
      frame.classList.toggle("tall", state.pdfTall);
    }
  });

  btnRun.addEventListener("click", (e) => {
    if (state.kind === "markdown") {
      if (state.mdEditing) {
        const curDoc = state.view.state.doc.toString();
        if (looksLikeCommentedMarkdownCell(curDoc)) {
          setDoc(state.view, uncommentMarkdownBlock(curDoc));
        }
      }
      state.mdEditing = !state.mdEditing;
      if (state.mdEditing && state.collapseMode !== "expanded") {
        setCellCollapseMode(state, "expanded");
      }
      applyCellKindUI(state);
      if (state.mdEditing) state.view.focus();
      return;
    }
    if (state.kind === "media") {
      void pickMediaForCell();
      return;
    }
    if (e.altKey && state.kind === "code") {
      void startCellDebugging(state);
      return;
    }
    void runSingleCell(state, false);
  });

  btnCollapse.addEventListener("click", (e) => {
    e.stopPropagation();
    setCellCollapseMode(state, nextCellCollapseMode(state, e.altKey));
  });
  collapseSummaryEl.addEventListener("click", (e) => {
    e.stopPropagation();
    setCellCollapseMode(state, "expanded");
  });
  header.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("input, select, button, .cell-actions")) return;
    setCellCollapseMode(state, nextCellCollapseMode(state, e.altKey));
  });

  btnAdd.addEventListener("click", () => {
    const idx = cells.indexOf(state);
    const created = createCellCard({ kind: "code", title: "", source: "" }, idx + 1);
    markDirty();
    created.view.focus();
  });
  btnUp.addEventListener("click", () => moveCell(state, -1));
  btnDown.addEventListener("click", () => moveCell(state, 1));
  btnDel.addEventListener("click", () => deleteCell(state));

  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const idx = cells.indexOf(state);
    openContextMenu(e.clientX, e.clientY, [
      {
        label:
          state.kind === "markdown"
            ? state.mdEditing
              ? "✓ Render Markdown"
              : "✎ Edit Markdown"
            : state.kind === "media"
              ? "📂 Choose PDF / Image…"
              : state.kind === "deps"
                ? "⚡ Install Packages"
                : "▶ Run Cell",
        shortcut: state.kind === "media" ? undefined : "⌘↵",
        run: () => void runSingleCell(state, false),
      },
      {
        label: "🐞 Debug Cell",
        shortcut: "⇧⌘D",
        disabled: state.kind !== "code",
        run: () => void startCellDebugging(state),
      },
      { label: "▶▶ Run All Cells", shortcut: "⇧⌘↵", run: () => void runAllCells() },
      { separator: true },
      {
        label: "Insert Code Cell Below",
        run: () => {
          const created = createCellCard({ kind: "code", title: "", source: "" }, idx + 1);
          markDirty();
          created.view.focus();
        },
      },
      {
        label: "Insert Packages Cell Below",
        run: () => {
          const created = createCellCard(
            { kind: "deps", title: "Dependencies", source: "numpy\nscipy\nmatplotlib" },
            idx + 1,
          );
          markDirty();
          created.view.focus();
        },
      },
      {
        label: "Insert Markdown + LaTeX Cell Below",
        run: () => {
          const created = createCellCard(
            {
              kind: "markdown",
              title: "Notes",
              source: "## Formula\n\n$$E = m c^2$$",
            },
            idx + 1,
          );
          created.mdEditing = true;
          applyCellKindUI(created);
          markDirty();
          created.view.focus();
        },
      },
      {
        label: "Insert PDF / Image Cell Below",
        run: () => {
          const created = createCellCard({ kind: "media", title: "", source: "" }, idx + 1);
          markDirty();
          void runSingleCell(created, false);
        },
      },
      { separator: true },
      {
        label: "Duplicate Cell",
        run: () => {
          const created = createCellCard(
            {
              kind: state.kind,
              title: state.title,
              source:
                state.kind === "media" ? state.mediaPath : state.view.state.doc.toString(),
            },
            idx + 1,
          );
          markDirty();
          created.view.focus();
        },
      },
      {
        label: "Move Cell Up",
        disabled: idx <= 0,
        run: () => moveCell(state, -1),
      },
      {
        label: "Move Cell Down",
        disabled: idx >= cells.length - 1,
        run: () => moveCell(state, 1),
      },
      { separator: true },
      {
        label: "Expand Cell",
        disabled: state.collapseMode === "expanded",
        run: () => setCellCollapseMode(state, "expanded"),
      },
      {
        label: "Hide Code (Output Only)",
        disabled: !canShowOutputOnly(state) || state.collapseMode === "output-only",
        run: () => setCellCollapseMode(state, "output-only"),
      },
      {
        label: "Collapse Cell",
        disabled: state.collapseMode === "collapsed",
        run: () => setCellCollapseMode(state, "collapsed"),
      },
      { separator: true },
      {
        label: "Report View (Hide Code, Keep Outputs)",
        run: () => applyReportView(),
      },
      {
        label: "Collapse All Cells",
        disabled: cells.every((c) => c.collapseMode === "collapsed"),
        run: () => setAllCellsCollapseMode("collapsed"),
      },
      {
        label: "Expand All Cells",
        disabled: cells.every((c) => c.collapseMode === "expanded"),
        run: () => setAllCellsCollapseMode("expanded"),
      },
      { separator: true },
      {
        label: "Clear Output",
        disabled: Boolean(state.outputWrap.hidden),
        run: () => {
          state.outputWrap.hidden = true;
          state.outputStale = false;
          state.outputWrap.classList.remove("is-stale");
          state.staleBadgeEl.hidden = true;
          state.runCount = null;
          state.lastTables = [];
          state.lastFullStdout = "";
          state.lastNonTableStdout = "";
          state.lastStderr = "";
          state.lastExported = {};
          state.lastPlots = [];
          state.lastLatex = null;
          state.tablesWrap.innerHTML = "";
          state.plotsWrap.innerHTML = "";
          state.latexWrap.innerHTML = "";
          state.exportedBar.hidden = true;
          renumberCells();
          if (state.collapseMode === "output-only") {
            setCellCollapseMode(state, "collapsed");
          } else if (state.collapseMode !== "expanded") {
            updateCellCollapseUI(state);
          }
          scheduleWriteOutputsSidecar();
        },
      },
      {
        label: "Delete Cell",
        danger: true,
        run: () => deleteCell(state),
      },
    ]);
  });

  if (insertAt !== undefined && insertAt < cells.length) {
    notebookEl.insertBefore(card, cells[insertAt].el);
    cells.splice(insertAt, 0, state);
  } else {
    notebookEl.append(card);
    cells.push(state);
  }
  applyCellKindUI(state);
  updateCellCollapseUI(state);
  updateCollapseToolbarButtons();
  return state;
}

function insertMediaCellWithFile(filePath: string) {
  const rel = toWorkspaceRelativeIfPossible(filePath);
  const fileName = filePath.split(/[\\/]/).pop() ?? "Media";
  const created = createCellCard({
    kind: "media",
    title: fileName,
    source: rel,
  });
  markDirty();
  created.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  setStatus(`Embedded ${fileName} in media cell`);
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
  persistCollapsedStateForActiveTab();
  scheduleWriteOutputsSidecar();
  markDirty();
}

function deleteCell(cell: CellState) {
  if (activeDebugSession?.targetCell === cell) {
    void handleDebugAction("stop");
    endDebugSession();
  }
  if (cell.mediaBlobUrl) {
    URL.revokeObjectURL(cell.mediaBlobUrl);
    cell.mediaBlobUrl = null;
  }
  if (cells.length <= 1) {
    cell.kind = "code";
    setDoc(cell.view, "");
    cell.titleInput.value = "";
    cell.title = "";
    cell.mediaPath = "";
    cell.mediaInput.value = "";
    cell.outputWrap.hidden = true;
    cell.outputStale = false;
    cell.outputWrap.classList.remove("is-stale");
    cell.staleBadgeEl.hidden = true;
    cell.runCount = null;
    cell.lastTables = [];
    cell.lastFullStdout = "";
    cell.lastNonTableStdout = "";
    cell.lastStderr = "";
    cell.lastExported = {};
    cell.lastPlots = [];
    cell.lastLatex = null;
    setCellCollapseMode(cell, "expanded");
    applyCellKindUI(cell);
    scheduleWriteOutputsSidecar();
    markDirty();
    return;
  }
  const idx = cells.indexOf(cell);
  if (idx < 0) return;
  cell.view.destroy();
  cell.el.remove();
  cells.splice(idx, 1);
  renumberCells();
  persistCollapsedStateForActiveTab();
  updateCollapseToolbarButtons();
  scheduleWriteOutputsSidecar();
  markDirty();
}

function getOutputsSidecarPath(notebookPath: string): string {
  const sepIdx = Math.max(notebookPath.lastIndexOf("/"), notebookPath.lastIndexOf("\\"));
  const dir = sepIdx >= 0 ? notebookPath.slice(0, sepIdx + 1) : "";
  const file = sepIdx >= 0 ? notebookPath.slice(sepIdx + 1) : notebookPath;
  const dotIdx = file.lastIndexOf(".");
  const stem = dotIdx > 0 ? file.slice(0, dotIdx) : file;
  return `${dir}.${stem}.ppyout`;
}

function serializeCellOutput(cell: CellState): SavedCellOutput | null {
  const hasAny =
    !cell.outputWrap.hidden ||
    cell.runCount !== null ||
    cell.lastPlots.length > 0 ||
    cell.lastTables.length > 0 ||
    Boolean(cell.lastLatex) ||
    Boolean(cell.lastFullStdout) ||
    Boolean(cell.lastStderr) ||
    Object.keys(cell.lastExported).length > 0;
  if (!hasAny) return null;
  return {
    runCount: cell.runCount,
    outputStale: cell.outputStale,
    exported: { ...cell.lastExported },
    stdout: cell.lastFullStdout,
    nonTableStdout: cell.lastNonTableStdout,
    stderr: cell.lastStderr,
    tables: cell.lastTables,
    plots: [...cell.lastPlots],
    latex: cell.lastLatex,
    tableViewMode: cell.tableViewMode,
  };
}

function snapshotNotebookOutputs(): NotebookOutputsFile {
  return {
    version: 1,
    execCounter,
    allExports: { ...sessionRuntimeExports },
    cells: cells.map(serializeCellOutput),
  };
}

function applySavedCellOutput(
  cell: CellState,
  out: SavedCellOutput,
  cellIdx: number,
  fromDisk = false,
): boolean {
  cell.runCount = out.runCount;
  cell.outputStale = fromDisk ? true : Boolean(out.outputStale);
  cell.lastExported = { ...(out.exported ?? {}) };
  const exportedEntries = Object.entries(cell.lastExported);
  if (exportedEntries.length > 0) {
    cell.exportedBar.hidden = false;
    cell.exportedBar.textContent =
      "↳ exported: " + exportedEntries.map(([k, v]) => `${k} = ${v}`).join(", ");
  } else {
    cell.exportedBar.hidden = true;
    cell.exportedBar.textContent = "";
  }

  cell.lastTables = out.tables ?? [];
  cell.lastFullStdout = out.stdout ?? "";
  cell.lastNonTableStdout = out.nonTableStdout ?? "";
  cell.lastStderr = out.stderr ?? "";
  cell.tableViewMode = out.tableViewMode ?? "table";

  if (cell.lastTables.length > 0) {
    renderCellTables(cell.tablesWrap, cell.lastTables);
  } else {
    cell.tablesWrap.innerHTML = "";
  }
  applyCellOutputView(cell);

  cell.plotsWrap.innerHTML = "";
  const plots = out.plots ?? [];
  cell.lastPlots = [...plots];
  plots.forEach((b64, plotIdx) => {
    const img = document.createElement("img");
    img.className = "cell-plot";
    img.src = `data:image/png;base64,${b64}`;
    img.alt = "matplotlib plot";
    img.title = "Right-click to save or copy plot image";
    img.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const baseDir = currentPath
        ? currentPath.replace(/[\\/][^\\/]+$/, "")
        : (rootDir ?? "");
      const stem = (cell.title || `cell-${cellIdx + 1}`)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "") || `plot_${cellIdx + 1}`;
      const fileName = plots.length > 1 ? `${stem}_${plotIdx + 1}.png` : `${stem}.png`;
      const defaultPath = baseDir ? `${baseDir.replace(/\/+$/, "")}/${fileName}` : fileName;

      openContextMenu(e.clientX, e.clientY, [
        {
          label: "💾 Save Plot Image As…",
          run: async () => {
            try {
              const saved = await backend.savePlotPng(b64, defaultPath);
              if (saved) {
                setStatus(`Saved plot to ${saved}`);
                await refreshFileTree();
              }
            } catch (err) {
              setStatus(`Failed to save plot: ${String(err)}`);
            }
          },
        },
        {
          label: "📋 Copy Image to Clipboard",
          run: async () => {
            try {
              const resp = await fetch(`data:image/png;base64,${b64}`);
              const blob = await resp.blob();
              await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
              setStatus("Copied plot image to clipboard");
            } catch (err) {
              setStatus(`Could not copy image: ${String(err)}`);
            }
          },
        },
      ]);
    });
    cell.plotsWrap.append(img);
  });
  cell.plotsWrap.hidden = plots.length === 0;

  cell.lastLatex = out.latex ?? null;
  if (cell.lastLatex) {
    cell.latexWrap.hidden = false;
    cell.latexWrap.dataset.latex = cell.lastLatex;
    cell.latexWrap.innerHTML = "";
    try {
      katex.render(cell.lastLatex, cell.latexWrap, { displayMode: true, throwOnError: false });
    } catch {
      cell.latexWrap.textContent = cell.lastLatex;
    }
  } else {
    cell.latexWrap.hidden = true;
    delete cell.latexWrap.dataset.latex;
    cell.latexWrap.innerHTML = "";
  }

  const hasCopyableText = Boolean(
    cell.lastFullStdout ||
      cell.lastStderr ||
      cell.lastLatex ||
      exportedEntries.length > 0 ||
      cell.lastTables.length > 0,
  );
  const hasOut = Boolean(hasCopyableText || plots.length > 0);
  cell.outputWrap.hidden = !hasOut;
  cell.outputWrap.classList.toggle("is-stale", hasOut && cell.outputStale);
  cell.staleBadgeEl.hidden = !(hasOut && cell.outputStale);
  cell.btnCopyOutput.hidden = !hasCopyableText;
  return hasOut;
}

function restoreNotebookOutputs(snapshot: NotebookOutputsFile, fromDisk = false) {
  if (!fromDisk && typeof snapshot.execCounter === "number" && snapshot.execCounter > execCounter) {
    execCounter = snapshot.execCounter;
  }
  const count = Math.min(cells.length, snapshot.cells?.length ?? 0);
  for (let i = 0; i < count; i++) {
    const out = snapshot.cells[i];
    if (out) {
      applySavedCellOutput(cells[i], out, i, fromDisk);
      updateCellCollapseUI(cells[i]);
    }
  }
  renumberCells();
  updateCollapseToolbarButtons();
  if (!fromDisk && snapshot.allExports && Object.keys(snapshot.allExports).length > 0) {
    renderSessionExports(snapshot.allExports);
  }
}

let outputsSaveTimer: number | undefined;

async function writeOutputsSidecarNow(notebookPath: string | null = currentPath): Promise<void> {
  if (!backend.inTauri || !notebookPath || isCsvPath(notebookPath)) return;
  const sidecarPath = getOutputsSidecarPath(notebookPath);
  const snapshot = snapshotNotebookOutputs();
  const hasAnyCellOutput = snapshot.cells.some((c) => c !== null);
  const hasExports = Object.keys(snapshot.allExports).length > 0;
  if (!hasAnyCellOutput && !hasExports) {
    try {
      await backend.deletePath(sidecarPath);
    } catch {
      // Sidecar may not exist
    }
    return;
  }
  try {
    await backend.writeFileByPath(sidecarPath, JSON.stringify(snapshot));
  } catch (err) {
    console.warn("Failed to write outputs sidecar:", sidecarPath, err);
  }
}

function scheduleWriteOutputsSidecar(immediate = false): void {
  clearTimeout(outputsSaveTimer);
  if (!backend.inTauri || !currentPath || isCsvPath(currentPath)) return;
  const targetPath = currentPath;
  if (immediate) {
    void writeOutputsSidecarNow(targetPath);
    return;
  }
  outputsSaveTimer = window.setTimeout(() => {
    void writeOutputsSidecarNow(targetPath);
  }, 200);
}

async function loadOutputsSidecarForTab(tabId: number, filePath: string): Promise<void> {
  if (!backend.inTauri || isCsvPath(filePath)) return;
  try {
    const raw = await backend.readFileByPath(getOutputsSidecarPath(filePath));
    const parsed = JSON.parse(raw) as NotebookOutputsFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.cells)) return;
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
      tab.savedOutputs = {
        ...parsed,
        cells: parsed.cells.map((c) => (c ? { ...c, outputStale: true } : null)),
      };
    }
    if (activeTabId === tabId && currentPath === filePath) {
      restoreNotebookOutputs(parsed, true);
    }
  } catch {
    // Missing or unreadable sidecar is normal for new/clean notebooks
  }
}

function loadDocumentIntoCells(
  src: string,
  collapsedModes?: CellCollapseMode[],
  savedOutputs?: NotebookOutputsFile | null,
  tabId?: number,
) {
  for (const c of cells) {
    if (c.mediaBlobUrl) URL.revokeObjectURL(c.mediaBlobUrl);
    c.view.destroy();
    c.el.remove();
  }
  cells.length = 0;
  const parsedCells = parseDocument(src);
  const savedModes = collapsedModes ? null : loadCollapsedModesForPath(currentPath);
  parsedCells.forEach((parsed, idx) => {
    try {
      const card = createCellCard(parsed);
      const targetMode = collapsedModes ? collapsedModes[idx] : savedModes?.get(idx);
      if (targetMode && targetMode !== "expanded") {
        setCellCollapseMode(card, targetMode, false);
      }
    } catch (err) {
      console.error("Failed to render cell:", parsed.title, err);
    }
  });
  updateCollapseToolbarButtons();
  renderSessionExports();
  if (savedOutputs) {
    restoreNotebookOutputs(savedOutputs, false);
  } else if (savedOutputs === undefined && currentPath && backend.inTauri) {
    void loadOutputsSidecarForTab(tabId ?? activeTabId, currentPath);
  }

  // If document defines dependencies with a venv, auto-resolve & activate that venv
  const deps = parsedCells.find((c) => c.kind === "deps");
  const cur = activeTab();
  if (deps && deps.venv && backend.inTauri) {
    const baseDir = currentPath
      ? currentPath.replace(/[\\/][^\\/]+$/, "")
      : (rootDir ?? "");
    void backend.resolveVenv(baseDir, deps.venv).then((info) => {
      if (info) {
        if (cur) cur.interpreterInfo = info;
        if (info.path !== activeInterpreterPath) {
          void backend.setPythonInterpreter(info.path).then(() => {
            updateActiveInterpreterUI(info);
          });
        }
      }
    });
  }
}

// --- Execution -------------------------------------------------------------

async function runDepsCell(cell: CellState): Promise<boolean> {
  if (!requireTauri()) return true;
  const reqs = cell.view.state.doc.toString().trim();
  if (!reqs) {
    setStatus("No packages specified in dependencies cell");
    return true;
  }
  const baseDir = currentPath
    ? currentPath.replace(/[\\/][^\\/]+$/, "")
    : (rootDir ?? "");
  cell.depsLogPre.hidden = false;
  cell.depsLogPre.className = "cell-deps-log";
  cell.depsLogPre.textContent = "Installing dependencies…";
  setStatus("Installing dependencies into virtual environment…");

  try {
    if (!cell.venvPath) {
      cell.venvPath = ".venv";
      cell.depsVenvBadge.textContent = ".venv";
    }
    let info = await backend.resolveVenv(baseDir, cell.venvPath);
    if (!info) {
      cell.depsLogPre.textContent = `Virtual environment '${cell.venvPath}' not found. Creating it now…\n`;
      info = await backend.createVenv(baseDir, cell.venvPath);
      updateActiveInterpreterUI(info);
    } else if (info.path !== activeInterpreterPath) {
      await backend.setPythonInterpreter(info.path);
      updateActiveInterpreterUI(info);
    }

    const res = await backend.installRequirements(info.path, reqs, baseDir, true);
    cell.depsLogPre.textContent = res.log;
    if (res.success) {
      cell.depsLogPre.className = "cell-deps-log success";
      setStatus("✓ Packages installed and synced to requirements.txt");
      return true;
    } else {
      cell.depsLogPre.className = "cell-deps-log error";
      setStatus("✕ Package installation failed (see log in cell)");
      return false;
    }
  } catch (err) {
    cell.depsLogPre.textContent = `✕ Error: ${String(err)}`;
    cell.depsLogPre.className = "cell-deps-log error";
    setStatus("✕ Error installing dependencies");
    return false;
  }
}

function tablesToTsv(tables: backend.TableOutput[]): string {
  return tables
    .map((t) => {
      const headers = t.columns.map((c) => (c.unit ? `${c.name} [${c.unit}]` : c.name));
      const lines = [headers.join("\t"), ...t.rows.map((r) => r.cells.join("\t"))];
      return lines.join("\n");
    })
    .join("\n\n");
}

function parseStdoutPipeTables(stdout: string): backend.TableOutput[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 3) return [];
  if (!lines.every((l) => l.startsWith("|") && l.endsWith("|"))) return [];

  const splitRow = (line: string) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());

  const headers = splitRow(lines[0]);
  const sep = splitRow(lines[1]);
  if (
    headers.length === 0 ||
    sep.length !== headers.length ||
    !sep.every((s) => /^:?-{2,}:?$/.test(s))
  ) {
    return [];
  }

  const dataRows = lines.slice(2).map(splitRow);
  if (dataRows.some((r) => r.length !== headers.length)) return [];

  const isNumericCol = headers.map((_, ci) =>
    dataRows.every((r) => r[ci] === "" || /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(r[ci])),
  );

  return [
    {
      index_name: "",
      columns: headers.map((name, ci) => ({
        name,
        unit: null,
        is_numeric: isNumericCol[ci],
      })),
      rows: dataRows.map((cells, ri) => ({
        index: String(ri),
        cells,
      })),
      total_rows: dataRows.length,
      truncated: false,
      raw_text: stdout,
    },
  ];
}

function renderCellTables(container: HTMLDivElement, tables: backend.TableOutput[]): void {
  container.innerHTML = "";
  for (const tbl of tables) {
    const card = document.createElement("div");
    card.className = "cell-table-card";

    const scroll = document.createElement("div");
    scroll.className = "cell-table-scroll";

    const table = document.createElement("table");
    table.className = "csv-table cell-output-table";

    const thead = document.createElement("thead");
    const headTr = document.createElement("tr");

    const cornerTh = document.createElement("th");
    cornerTh.className = "csv-corner-th";
    cornerTh.textContent = tbl.index_name || "#";
    headTr.append(cornerTh);

    for (const col of tbl.columns) {
      const th = document.createElement("th");
      const inner = document.createElement("div");
      inner.className = "cell-table-th-inner";

      const nameSpan = document.createElement("span");
      nameSpan.className = "cell-table-th-name";
      nameSpan.textContent = col.name;
      inner.append(nameSpan);

      if (col.unit) {
        const unitSpan = document.createElement("span");
        unitSpan.className = "cell-table-unit";
        unitSpan.textContent = `[${col.unit}]`;
        inner.append(unitSpan);
      }

      th.append(inner);
      headTr.append(th);
    }
    thead.append(headTr);
    table.append(thead);

    const tbody = document.createElement("tbody");
    for (const row of tbl.rows) {
      const tr = document.createElement("tr");
      const idxTh = document.createElement("th");
      idxTh.className = "csv-row-th";
      idxTh.textContent = row.index;
      tr.append(idxTh);

      row.cells.forEach((val, ci) => {
        const td = document.createElement("td");
        td.className = tbl.columns[ci]?.is_numeric ? "cell-table-td num" : "cell-table-td";
        td.textContent = val;
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(tbody);
    scroll.append(table);
    card.append(scroll);

    const footer = document.createElement("div");
    footer.className = "cell-table-footer";
    const rowWord = tbl.total_rows === 1 ? "row" : "rows";
    const colWord = tbl.columns.length === 1 ? "column" : "columns";
    footer.textContent = tbl.truncated
      ? `Showing first ${tbl.rows.length} of ${tbl.total_rows} ${rowWord} × ${tbl.columns.length} ${colWord}`
      : `${tbl.total_rows} ${rowWord} × ${tbl.columns.length} ${colWord}`;
    card.append(footer);

    container.append(card);
  }
}

function setOutputPreContent(pre: HTMLPreElement, stdout: string, stderr: string): void {
  pre.innerHTML = "";
  if (stdout) pre.append(stdout);
  if (stderr) {
    const err = document.createElement("span");
    err.className = "stderr";
    err.textContent = stderr;
    pre.append(err);
  }
}

function applyCellOutputView(cell: CellState): void {
  const hasTables = cell.lastTables.length > 0;
  cell.tableModeGroup.hidden = !hasTables;
  cell.outputWrap.classList.toggle("has-table-toggle", hasTables);

  if (hasTables) {
    cell.btnTableView.classList.toggle("active", cell.tableViewMode === "table");
    cell.btnTextView.classList.toggle("active", cell.tableViewMode === "text");
    if (cell.tableViewMode === "table") {
      cell.tablesWrap.hidden = false;
      setOutputPreContent(cell.outputPre, cell.lastNonTableStdout, cell.lastStderr);
      cell.outputPre.hidden = !(cell.lastNonTableStdout || cell.lastStderr);
    } else {
      cell.tablesWrap.hidden = true;
      const fullText =
        cell.lastFullStdout || cell.lastTables.map((t) => t.raw_text).join("\n\n");
      setOutputPreContent(cell.outputPre, fullText, cell.lastStderr);
      cell.outputPre.hidden = !(fullText || cell.lastStderr);
    }
  } else {
    cell.tablesWrap.hidden = true;
    setOutputPreContent(cell.outputPre, cell.lastFullStdout, cell.lastStderr);
    cell.outputPre.hidden = !(cell.lastFullStdout || cell.lastStderr);
  }
}

// --- Cell Step Debugger -----------------------------------------------------

interface ActiveDebugSession {
  targetCell: CellState;
  currentHighlightedCell: CellState;
  currentLine: number | null;
  busy: boolean;
}

let activeDebugSession: ActiveDebugSession | null = null;

function clearAllDebugHighlights() {
  for (const c of cells) {
    c.view.dispatch({ effects: setDebugLine.of(null) });
    c.debugBar.hidden = true;
    c.el.classList.remove("is-debugging");
  }
}

function endDebugSession() {
  clearAllDebugHighlights();
  activeDebugSession = null;
}

function renderDebugLocals(localsEl: HTMLElement, locals: Record<string, string> | undefined) {
  localsEl.innerHTML = "";
  if (!locals || Object.keys(locals).length === 0) {
    localsEl.hidden = true;
    return;
  }
  localsEl.hidden = false;
  const label = document.createElement("span");
  label.className = "debug-locals-label";
  label.textContent = "Locals:";
  localsEl.appendChild(label);

  for (const [k, v] of Object.entries(locals)) {
    const pill = document.createElement("span");
    pill.className = "debug-local-pill";
    pill.innerHTML = `<strong>${k}</strong> = ${v}`;
    pill.title = `${k}: ${v}`;
    localsEl.appendChild(pill);
  }
}

function handleDebugEvent(ev: backend.DebugEvent) {
  if (!activeDebugSession) return;
  activeDebugSession.busy = false;

  if (ev.event === "paused") {
    const line = ev.line ?? 1;
    activeDebugSession.currentLine = line;

    // Determine target cell
    let targetCell = activeDebugSession.targetCell;
    if (typeof ev.cell_index === "number" && ev.cell_index >= 1 && ev.cell_index <= cells.length) {
      targetCell = cells[ev.cell_index - 1];
    }

    if (activeDebugSession.currentHighlightedCell !== targetCell) {
      activeDebugSession.currentHighlightedCell.view.dispatch({ effects: setDebugLine.of(null) });
      activeDebugSession.currentHighlightedCell = targetCell;
    }

    if (targetCell.collapseMode !== "expanded") {
      setCellCollapseMode(targetCell, "expanded");
    }

    const docLines = targetCell.view.state.doc.lines;
    const clampedLine = Math.max(1, Math.min(line, docLines));
    const lineObj = targetCell.view.state.doc.line(clampedLine);

    targetCell.view.dispatch({
      effects: [setDebugLine.of(clampedLine), EditorView.scrollIntoView(lineObj.from)],
    });

    const initiatingCell = activeDebugSession.targetCell;
    initiatingCell.debugBar.hidden = false;
    initiatingCell.el.classList.add("is-debugging");
    initiatingCell.debugLineNumEl.textContent = String(clampedLine);

    if (targetCell !== initiatingCell) {
      const idx = cells.indexOf(targetCell);
      initiatingCell.debugFilenameEl.textContent = `(in Cell ${idx + 1})`;
    } else {
      initiatingCell.debugFilenameEl.textContent = "";
    }

    renderDebugLocals(initiatingCell.debugLocalsEl, ev.locals);
    setStatus(`Paused at line ${clampedLine}`);
  } else if (ev.event === "finished") {
    const cell = activeDebugSession.targetCell;
    const idx = cells.indexOf(cell);
    endDebugSession();

    if (ev.result) {
      const res = ev.result;
      const structuredTables = res.tables ?? [];
      const tables =
        structuredTables.length > 0
          ? structuredTables
          : !res.stderr && res.stdout
            ? parseStdoutPipeTables(res.stdout)
            : [];
      const pipeFallbackUsed = structuredTables.length === 0 && tables.length > 0;

      applySavedCellOutput(
        cell,
        {
          runCount: ++execCounter,
          exported: res.exported,
          stdout: res.stdout,
          nonTableStdout: pipeFallbackUsed
            ? ""
            : (res.non_table_stdout ?? (structuredTables.length > 0 ? "" : res.stdout)),
          stderr: res.stderr,
          tables,
          plots: res.plots ?? [],
          latex: res.latex ?? null,
          tableViewMode: "table",
        },
        idx,
      );
      renumberCells();
      renderSessionExports(res.all_exports);
      scheduleWriteOutputsSidecar();
    }
    setStatus(`Debugging cell ${idx + 1} completed.`);
  } else if (ev.event === "error") {
    setStatus(`Debugger error: ${ev.error || "Unknown error"}`);
    endDebugSession();
  }
}

async function startCellDebugging(cell: CellState) {
  if (cell.kind !== "code") return;
  if (!requireTauri()) return;

  if (activeDebugSession) {
    await handleDebugAction("stop");
  }

  const idx = cells.indexOf(cell);
  setStatus(`Starting debugger on cell ${idx + 1}…`);
  if (cell.collapseMode !== "expanded") {
    setCellCollapseMode(cell, "expanded");
  }

  activeDebugSession = {
    targetCell: cell,
    currentHighlightedCell: cell,
    currentLine: 1,
    busy: true,
  };

  cell.debugBar.hidden = false;
  cell.el.classList.add("is-debugging");
  cell.debugLineNumEl.textContent = "1";
  cell.debugFilenameEl.textContent = "";

  try {
    const ev = await backend.debugStartCell(
      cell.view.state.doc.toString(),
      currentPath,
      rootDir,
      idx + 1,
      serializeDocument(),
    );
    handleDebugEvent(ev);
  } catch (err) {
    setStatus(`Failed to start debugger: ${String(err)}`);
    endDebugSession();
  }
}

async function handleDebugAction(action: backend.DebugAction) {
  if (!activeDebugSession) return;
  if (activeDebugSession.busy) return;
  activeDebugSession.busy = true;

  try {
    const ev = await backend.debugAction(action);
    handleDebugEvent(ev);
  } catch (err) {
    setStatus(`Debug error: ${String(err)}`);
    endDebugSession();
  }
}

function getFocusedOrActiveCell(): CellState | undefined {
  const focused = cells.find((c) => c.view.hasFocus);
  if (focused) return focused;
  const inDom = cells.find((c) => c.el.contains(document.activeElement));
  if (inDom) return inDom;
  return cells.find((c) => c.kind === "code") ?? cells[0];
}

function debugActiveCell() {
  const target = getFocusedOrActiveCell();
  if (target && target.kind === "code") {
    void startCellDebugging(target);
  } else {
    setStatus("Select a Python code cell to debug.");
  }
}

async function runSingleCell(cell: CellState, advanceFocus: boolean): Promise<boolean> {
  const idx = cells.indexOf(cell);

  if (cell.kind === "deps") {
    const ok = await runDepsCell(cell);
    if (advanceFocus && idx + 1 < cells.length) {
      if (cells[idx + 1].collapseMode !== "expanded") setCellCollapseMode(cells[idx + 1], "expanded");
      cells[idx + 1].view.focus();
    }
    return ok;
  }

  if (cell.kind === "markdown") {
    const curDoc = cell.view.state.doc.toString();
    if (looksLikeCommentedMarkdownCell(curDoc)) {
      setDoc(cell.view, uncommentMarkdownBlock(curDoc));
    }
    cell.mdEditing = false;
    applyCellKindUI(cell);
    setStatus(`Rendered Markdown cell ${idx + 1}`);
    if (advanceFocus && idx + 1 < cells.length) {
      if (cells[idx + 1].collapseMode !== "expanded") setCellCollapseMode(cells[idx + 1], "expanded");
      cells[idx + 1].view.focus();
    }
    return true;
  }

  if (cell.kind === "media") {
    await renderMediaCellViewer(cell);
    return true;
  }

  if (!requireTauri()) return true;
  setStatus(`Running cell ${idx + 1}…`);
  cell.el.classList.add("running");

  try {
    const res = await backend.runCell(
      cell.view.state.doc.toString(),
      currentPath,
      rootDir,
      idx + 1,
      serializeDocument(),
    );
    const structuredTables = res.tables ?? [];
    const tables =
      structuredTables.length > 0
        ? structuredTables
        : !res.stderr && res.stdout
          ? parseStdoutPipeTables(res.stdout)
          : [];
    const pipeFallbackUsed = structuredTables.length === 0 && tables.length > 0;

    const hasOut = applySavedCellOutput(
      cell,
      {
        runCount: ++execCounter,
        exported: res.exported,
        stdout: res.stdout,
        nonTableStdout: pipeFallbackUsed
          ? ""
          : (res.non_table_stdout ?? (structuredTables.length > 0 ? "" : res.stdout)),
        stderr: res.stderr,
        tables,
        plots: res.plots ?? [],
        latex: res.latex ?? null,
        tableViewMode: "table",
      },
      idx,
    );
    renumberCells();
    renderSessionExports(res.all_exports);
    scheduleWriteOutputsSidecar();
    setStatus(`Cell ${idx + 1} finished (exit code ${res.code})`);
    if (res.code !== 0 && cell.collapseMode !== "expanded") {
      setCellCollapseMode(cell, "expanded");
    } else if (cell.collapseMode === "output-only" && !hasOut) {
      setCellCollapseMode(cell, "collapsed");
    } else {
      updateCellCollapseUI(cell);
    }

    if (advanceFocus) {
      if (idx + 1 < cells.length) {
        if (cells[idx + 1].collapseMode !== "expanded") setCellCollapseMode(cells[idx + 1], "expanded");
        cells[idx + 1].view.focus();
      } else {
        const next = createCellCard({ kind: "code", title: "", source: "" });
        markDirty();
        next.view.focus();
      }
    }
    return res.code === 0;
  } catch (e) {
    if (cell.collapseMode !== "expanded") setCellCollapseMode(cell, "expanded");
    cell.outputStale = false;
    cell.outputWrap.classList.remove("is-stale");
    cell.staleBadgeEl.hidden = true;
    cell.lastStderr = String(e);
    cell.outputWrap.hidden = false;
    cell.outputPre.hidden = false;
    cell.outputPre.textContent = String(e);
    cell.btnCopyOutput.hidden = false;
    scheduleWriteOutputsSidecar();
    setStatus("Error");
    return false;
  } finally {
    cell.el.classList.remove("running");
  }
}

async function resetSession(quiet = false): Promise<boolean> {
  endDebugSession();
  if (!requireTauri()) return true;
  await backend.resetSession();
  execCounter = 0;
  for (const c of cells) {
    c.runCount = null;
    c.outputStale = false;
    c.outputWrap.hidden = true;
    c.outputWrap.classList.remove("has-table-toggle", "is-stale");
    c.staleBadgeEl.hidden = true;
    c.tableModeGroup.hidden = true;
    c.btnCopyOutput.hidden = true;
    c.tablesWrap.hidden = true;
    c.tablesWrap.innerHTML = "";
    c.lastTables = [];
    c.lastFullStdout = "";
    c.lastNonTableStdout = "";
    c.lastStderr = "";
    c.lastExported = {};
    c.lastPlots = [];
    c.lastLatex = null;
    c.plotsWrap.innerHTML = "";
    c.plotsWrap.hidden = true;
    c.exportedBar.hidden = true;
    c.latexWrap.hidden = true;
    delete c.latexWrap.dataset.latex;
    c.latexWrap.innerHTML = "";
    if (!quiet && c.collapseMode === "output-only") {
      c.collapseMode = "collapsed";
    }
    updateCellCollapseUI(c);
  }
  renumberCells();
  updateCollapseToolbarButtons();
  if (!quiet) persistCollapsedStateForActiveTab();
  renderSessionExports({});
  if (!quiet) scheduleWriteOutputsSidecar(true);
  if (!quiet) setStatus("Session reset (all exported variables cleared)");
  return true;
}

async function runAllCells(): Promise<boolean> {
  if (!requireTauri()) return true;
  if (activeTab()?.kind === "csv" || activeTab()?.kind === "settings") return true;
  await resetSession(true);
  for (const c of cells) {
    if (c.kind === "deps") {
      const ok = await runDepsCell(c);
      if (!ok) break;
      continue;
    }
    if (c.kind === "markdown") {
      c.mdEditing = false;
      applyCellKindUI(c);
      continue;
    }
    if (c.kind === "media") {
      await renderMediaCellViewer(c);
      continue;
    }
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
    const existing = tabs.find((t) => t.path === file.path);
    if (existing) {
      switchToTab(existing.id);
    } else {
      createNewTab({ path: file.path, content: file.contents, dirty: false });
    }
  }
  return true;
}

async function formatNotebookCells(): Promise<boolean> {
  if (!backend.inTauri) return false;
  const cur = activeTab();
  if (!cur || cur.kind !== "notebook") return false;
  const codeCells = cells.filter((c) => c.kind === "code");
  if (codeCells.length === 0) return false;
  const rawSources = codeCells.map((c) => c.view.state.doc.toString());
  try {
    const formattedSources = await backend.formatCells(rawSources);
    let changed = false;
    for (let i = 0; i < codeCells.length; i++) {
      const cell = codeCells[i];
      const oldText = rawSources[i];
      const newText = formattedSources[i];
      if (newText !== undefined && newText !== oldText) {
        cell.view.dispatch({
          changes: { from: 0, to: cell.view.state.doc.length, insert: newText },
        });
        changed = true;
      }
    }
    if (changed) {
      markDirty();
    }
    return changed;
  } catch (err) {
    console.warn("formatNotebookCells failed:", err);
    return false;
  }
}

async function saveFile(): Promise<boolean> {
  if (!requireTauri()) return true;
  if (activeTab()?.kind === "settings") {
    await saveSettingsScope();
    return true;
  }
  const cur = activeTab();
  if (cur && cur.kind === "notebook") {
    const shouldFormat = currentConfig ? currentConfig.format_on_save !== false : true;
    if (shouldFormat) {
      await formatNotebookCells();
    }
  }
  const serialized = getActiveTabSerializedContent();
  const path = await backend.saveFile(serialized, currentPath);
  if (path) {
    currentPath = path;
    dirty = false;
    const cur = activeTab();
    if (cur) {
      cur.path = path;
      cur.content = serialized;
      cur.dirty = false;
      if (cur.kind === "csv") {
        csvEditor?.markSaved();
      } else {
        cur.savedOutputs = snapshotNotebookOutputs();
        void writeOutputsSidecarNow(path);
      }
    }
    updateTitle();
    setStatus(`Saved ${path}`);
    void refreshFileTree();
  }
  return true;
}

// --- Boot ------------------------------------------------------------------

const wrap = (fn: () => Promise<boolean> | boolean) => () => (void fn(), true);

$("btn-sidebar").addEventListener("click", wrap(toggleSidebar));
$("btn-collapse-sidebar").addEventListener("click", wrap(toggleSidebar));
$("btn-change-folder").addEventListener("click", () => void changeRootFolder());
$("btn-refresh-tree").addEventListener("click", () => void refreshFileTree());
$("btn-new-tab").addEventListener("click", () => createNewTab());
$("btn-run-all").addEventListener("click", wrap(runAllCells));
$("btn-reset").addEventListener("click", wrap(() => resetSession(false)));
function handleToggleCollapseAll() {
  const cur = activeTab();
  if (cur && (cur.kind === "settings" || cur.kind === "csv")) return;
  const allCollapsed = cells.length > 0 && cells.every((c) => c.collapseMode === "collapsed");
  setAllCellsCollapseMode(allCollapsed ? "expanded" : "collapsed");
}

function handleReportView() {
  const cur = activeTab();
  if (cur && (cur.kind === "settings" || cur.kind === "csv")) return;
  toggleReportView();
}

$("btn-variables").addEventListener("click", wrap(toggleVariablesDrawer));
$("btn-warnings").addEventListener("click", wrap(toggleWarningsDrawer));
$("tab-drawer-variables").addEventListener("click", () => setDrawerTab("variables"));
$("tab-drawer-warnings").addEventListener("click", () => setDrawerTab("warnings"));
$("btn-close-variables").addEventListener("click", wrap(closeDrawer));
$("btn-interpreter").addEventListener("click", wrap(openPythonDialog));
$("btn-python").addEventListener("click", wrap(togglePython));

backend.onMenuOpenSettings(() => {
  openSettingsTab();
});

backend.onMenuAction((actionId) => {
  if (actionId === "menu_new_tab") {
    createNewTab();
  } else if (actionId === "menu_open_file") {
    void openFile();
  } else if (actionId === "menu_open_folder") {
    void changeRootFolder();
  } else if (actionId === "menu_save") {
    void saveFile();
  } else if (actionId === "menu_export_html") {
    openExportHtmlDialog();
  } else if (actionId === "menu_close_tab") {
    closeTab(activeTabId);
  } else if (actionId === "menu_toggle_collapse_all") {
    handleToggleCollapseAll();
  } else if (actionId === "menu_report_view") {
    handleReportView();
  } else if (actionId === "menu_variables") {
    toggleVariablesDrawer();
  } else if (actionId === "menu_warnings") {
    toggleWarningsDrawer();
  } else if (actionId === "menu_python_code") {
    togglePython();
  } else if (actionId === "menu_toggle_sidebar") {
    toggleSidebar();
  } else if (actionId === "menu_run_cell") {
    const target = getFocusedOrActiveCell();
    if (target) void runSingleCell(target, false);
  } else if (actionId === "menu_run_all") {
    void runAllCells();
  } else if (actionId === "menu_debug_cell") {
    debugActiveCell();
  } else if (actionId === "menu_reset_session") {
    void resetSession(false);
  } else if (actionId === "menu_format_document") {
    void formatNotebookCells().then((changed) => {
      if (changed) setStatus("Formatted notebook cells");
    });
  }
});

window.addEventListener("keydown", (e) => {
  if (activeDebugSession) {
    if (e.key === "F10") {
      e.preventDefault();
      void handleDebugAction("step_over");
      return;
    }
    if (e.key === "F11" && !e.shiftKey) {
      e.preventDefault();
      void handleDebugAction("step_into");
      return;
    }
    if (e.key === "F11" && e.shiftKey) {
      e.preventDefault();
      void handleDebugAction("step_out");
      return;
    }
    if (e.key === "F5" && !e.shiftKey) {
      e.preventDefault();
      void handleDebugAction("continue");
      return;
    }
    if (e.key === "Escape" || (e.key === "F5" && e.shiftKey)) {
      e.preventDefault();
      void handleDebugAction("stop");
      return;
    }
  }

  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    openSettingsTab();
  } else if (e.shiftKey && e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    void formatNotebookCells().then((changed) => {
      if (changed) setStatus("Formatted notebook cells");
    });
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && activeTab()?.kind === "settings") {
    e.preventDefault();
    void saveSettingsScope();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && activeTab()?.kind === "csv") {
    e.preventDefault();
    void saveFile();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j" && e.shiftKey) {
    if (!document.activeElement?.closest(".cm-editor")) {
      e.preventDefault();
      toggleWarningsDrawer();
    }
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j" && !e.shiftKey) {
    if (!document.activeElement?.closest(".cm-editor")) {
      e.preventDefault();
      toggleVariablesDrawer();
    }
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "m" && e.shiftKey) {
    if (!document.activeElement?.closest(".cm-editor")) {
      e.preventDefault();
      openMatrixDialog();
    }
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e" && e.shiftKey) {
    if (!document.activeElement?.closest(".cm-editor")) {
      e.preventDefault();
      openExportHtmlDialog();
    }
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && e.shiftKey) {
    if (!document.activeElement?.closest(".cm-editor")) {
      e.preventDefault();
      debugActiveCell();
    }
  }
});

async function initializeAppStartup() {
  const cfg = await applyHierarchicalConfig(null, true);
  const startupMode = cfg?.startup_mode || "restore";

  let restoredAny = false;

  if (startupMode === "restore") {
    try {
      const raw = localStorage.getItem("physpy_session");
      if (raw) {
        const session = JSON.parse(raw);
        if (session.rootDir && typeof session.rootDir === "string") {
          rootDir = session.rootDir;
        }
        if (Array.isArray(session.fileTabs) && session.fileTabs.length > 0) {
          for (const filePath of session.fileTabs) {
            try {
              const contents = await backend.readFileByPath(filePath);
              createNewTab({ path: filePath, content: contents, dirty: false });
              restoredAny = true;
            } catch {
              // File might have been moved or deleted
            }
          }
          if (session.activePath && typeof session.activePath === "string") {
            const found = tabs.find((t) => t.path === session.activePath);
            if (found) {
              switchToTab(found.id);
            }
          }
        }
      }
    } catch {
      // Ignore session restore error
    }
  } else if (startupMode === "file" && cfg?.startup_file) {
    try {
      const contents = await backend.readFileByPath(cfg.startup_file);
      createNewTab({ path: cfg.startup_file, content: contents, dirty: false });
      restoredAny = true;
    } catch (e) {
      setStatus(`Could not open startup file ${cfg.startup_file}: ${String(e)}`);
    }
  } else if (startupMode === "demo") {
    createNewTab({ path: null, content: demo, dirty: false });
    tabs[0].untitledName = "demo.ppy";
    restoredAny = true;
  }

  // Fallback: if empty mode, or nothing was restored/found
  if (!restoredAny) {
    if (startupMode === "empty") {
      createNewTab({ path: null, content: "# %% Cell 1\n", dirty: false });
    } else {
      createNewTab({ path: null, content: demo, dirty: false });
      tabs[0].untitledName = "demo.ppy";
    }
  }

  updateTitle();
  await refreshFileTree();
  setStatus(backend.inTauri ? "Ready — Shift+Enter or Cmd+Enter runs a cell" : "Browser mode: editing only");
  if (cells[0] && cells[0].collapseMode === "expanded") {
    cells[0].view.focus();
  }
}

void initializeAppStartup();
