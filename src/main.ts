import katex from "katex";
import "katex/dist/katex.min.css";
import "./styles.css";
import type { EditorView } from "@codemirror/view";
import demo from "../examples/demo.ppy?raw";
import * as backend from "./backend";
import { createEditor, createViewer, setDoc } from "./editor/setup";
import { replaceSymbolsInIdent } from "./editor/symbols";
import { type ConstLocation, setNotebookExportedConsts } from "./editor/constLint";
import { convertIpynbToPpy } from "./ipynbImport";
import { renderMarkdownWithLatex } from "./markdownLatex";
import { type CsvDelimiter, CsvEditorController, type CsvViewMode } from "./csvEditor";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type CellKind = "code" | "markdown" | "media" | "deps";

interface CellState {
  id: number;
  kind: CellKind;
  title: string;
  view: EditorView;
  el: HTMLElement;
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
  outputWrap: HTMLDivElement;
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
  tableViewMode: "table" | "text";
  runCount: number | null;
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
const cfgPythonPathInput = $<HTMLInputElement>("cfg-python-path");
const cfgStartupDirInput = $<HTMLInputElement>("cfg-startup-dir");
const cfgStartupModeSelect = $<HTMLSelectElement>("cfg-startup-mode");
const cfgStartupFileInput = $<HTMLInputElement>("cfg-startup-file");
const cfgStartupFileRow = $<HTMLDivElement>("cfg-startup-file-row");
const cfgAutoSaveSelect = $<HTMLSelectElement>("cfg-auto-save");
const cfgAutoSaveDelayInput = $<HTMLInputElement>("cfg-auto-save-delay");
const cfgAutoSaveDelayRow = $<HTMLDivElement>("cfg-auto-save-delay-row");
const cfgRawYamlInput = $<HTMLTextAreaElement>("cfg-raw-yaml");
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
  loadDocumentIntoCells(target.content);
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
  cells[0]?.view.focus();
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
  const pyPath = cfgPythonPathInput.value.trim().replace(/"/g, '\\"');
  const startDir = (cfgStartupDirInput.value.trim() || "~").replace(/"/g, '\\"');
  const startMode = cfgStartupModeSelect.value || "restore";
  const startFile = cfgStartupFileInput.value.trim().replace(/"/g, '\\"');
  const autoSave = cfgAutoSaveSelect.value || "off";
  const autoSaveDelay = Number(cfgAutoSaveDelayInput.value) || 1000;

  return [
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
    "# 3. Default Python interpreter path (leave empty for automatic detection)",
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
  ].join("\n");
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
    cfgPythonPathInput.value = data.parsed.python_path;
    cfgStartupDirInput.value = data.parsed.startup_dir;
    cfgStartupModeSelect.value = data.parsed.startup_mode || "restore";
    cfgStartupFileInput.value = data.parsed.startup_file || "";
    cfgAutoSaveSelect.value = (data.parsed.auto_save as any) || "off";
    cfgAutoSaveDelayInput.value = String(data.parsed.auto_save_delay || 1000);
    cfgRawYamlInput.value = data.raw_yaml;
    syncSettingsFormFromYamlText(data.raw_yaml);
    updateStartupFileRowVisibility();
    updateAutoSaveDelayRowVisibility();
    markSettingsTabDirty(false);
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
  cfgPythonPathInput,
  cfgStartupDirInput,
  cfgStartupFileInput,
  cfgAutoSaveDelayInput,
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
    } else if (c.kind === "media") {
      c.badgeEl.textContent = "📄 [doc]";
    } else {
      const num = c.runCount ?? " ";
      c.badgeEl.textContent = `In [${num}]`;
    }
    c.badgeEl.title = `Cell ${idx + 1} (${c.kind})`;
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
    cell.btnRun.innerHTML = "▶ Run <kbd>⌘↵</kbd>";
    cell.btnRun.title = "Run this code cell (Cmd+Enter or Shift+Enter)";
  } else if (cell.kind === "markdown") {
    cell.depsWrap.hidden = true;
    cell.mediaWrap.hidden = true;
    cell.outputWrap.hidden = true;
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
    cell.mediaWrap.hidden = false;
    cell.btnRun.innerHTML = "📂 Choose File…";
    cell.btnRun.title = "Choose a PDF or image file to embed in this cell";
    void renderMediaCellViewer(cell);
  }
  renumberCells();
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
    markDirty();
  });

  const actions = document.createElement("div");
  actions.className = "cell-actions";

  const btnRun = document.createElement("button");
  btnRun.type = "button";
  btnRun.className = "cell-btn run";
  btnRun.innerHTML = "▶ Run <kbd>⌘↵</kbd>";
  btnRun.title = "Run this cell (Cmd+Enter or Shift+Enter)";

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

  actions.append(btnRun, btnAdd, btnUp, btnDown, btnDel);
  header.append(badgeEl, kindSelect, titleInput, actions);

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

  outputActions.append(tableModeGroup, btnCopyOutput);

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
  card.append(header, depsWrap, editorHost, mdPreviewEl, mediaWrap, outputWrap);

  const view = createEditor({
    parent: editorHost,
    doc: initial.kind === "media" ? "" : initial.source,
    keys: [
      { key: "Mod-Enter", run: () => (void runSingleCell(state, false), true) },
      { key: "Shift-Enter", run: () => (void runSingleCell(state, true), true) },
      { key: "Mod-Shift-Enter", run: () => (void runAllCells(), true) },
      { key: "Mod-s", run: () => (void saveFile(), true) },
      { key: "Mod-o", run: () => (void openFile(), true) },
      { key: "Mod-Shift-o", run: () => (void changeRootFolder(), true) },
      { key: "Mod-n", run: () => (createNewTab(), true) },
      { key: "Mod-w", run: () => (closeTab(activeTabId), true) },
      { key: "Mod-b", run: () => toggleSidebar() },
      { key: "Mod-j", run: () => toggleVariablesDrawer() },
      { key: "Mod-Shift-j", run: () => toggleWarningsDrawer() },
      { key: "Mod-Shift-m", run: () => (openMatrixDialog(), true) },
      { key: "Mod-p", run: () => togglePython() },
    ],
    onChange: markDirty,
    onBlur: () => handleEditorBlur(),
  });

  const state: CellState = {
    id,
    kind: initial.kind,
    title: initial.title,
    view,
    el: card,
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
    outputWrap,
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
    tableViewMode: "table",
    runCount: null,
  };

  btnTableView.addEventListener("click", () => {
    state.tableViewMode = "table";
    applyCellOutputView(state);
  });
  btnTextView.addEventListener("click", () => {
    state.tableViewMode = "text";
    applyCellOutputView(state);
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

  btnRun.addEventListener("click", () => {
    if (state.kind === "markdown") {
      if (state.mdEditing) {
        const curDoc = state.view.state.doc.toString();
        if (looksLikeCommentedMarkdownCell(curDoc)) {
          setDoc(state.view, uncommentMarkdownBlock(curDoc));
        }
      }
      state.mdEditing = !state.mdEditing;
      applyCellKindUI(state);
      if (state.mdEditing) state.view.focus();
      return;
    }
    if (state.kind === "media") {
      void pickMediaForCell();
      return;
    }
    void runSingleCell(state, false);
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
        label: "Clear Output",
        disabled: Boolean(state.outputWrap.hidden),
        run: () => {
          state.outputWrap.hidden = true;
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
  markDirty();
}

function deleteCell(cell: CellState) {
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
    applyCellKindUI(cell);
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
    if (c.mediaBlobUrl) URL.revokeObjectURL(c.mediaBlobUrl);
    c.view.destroy();
    c.el.remove();
  }
  cells.length = 0;
  const parsedCells = parseDocument(src);
  for (const parsed of parsedCells) {
    try {
      createCellCard(parsed);
    } catch (err) {
      console.error("Failed to render cell:", parsed.title, err);
    }
  }
  renderSessionExports();

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

async function runSingleCell(cell: CellState, advanceFocus: boolean): Promise<boolean> {
  const idx = cells.indexOf(cell);

  if (cell.kind === "deps") {
    const ok = await runDepsCell(cell);
    if (advanceFocus && idx + 1 < cells.length) {
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

    const structuredTables = res.tables ?? [];
    const tables =
      structuredTables.length > 0
        ? structuredTables
        : !res.stderr && res.stdout
          ? parseStdoutPipeTables(res.stdout)
          : [];
    const pipeFallbackUsed = structuredTables.length === 0 && tables.length > 0;

    cell.lastTables = tables;
    cell.lastFullStdout = res.stdout;
    cell.lastNonTableStdout = pipeFallbackUsed
      ? ""
      : (res.non_table_stdout ?? (structuredTables.length > 0 ? "" : res.stdout));
    cell.lastStderr = res.stderr;
    cell.tableViewMode = "table";

    if (tables.length > 0) {
      renderCellTables(cell.tablesWrap, tables);
    } else {
      cell.tablesWrap.innerHTML = "";
    }
    applyCellOutputView(cell);

    cell.plotsWrap.innerHTML = "";
    const plots = res.plots ?? [];
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
        const stem = (cell.title || `cell-${idx + 1}`)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "_")
          .replace(/^_+|_+$/g, "") || `plot_${idx + 1}`;
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

    if (res.latex) {
      cell.latexWrap.hidden = false;
      cell.latexWrap.dataset.latex = res.latex;
      cell.latexWrap.innerHTML = "";
      try {
        katex.render(res.latex, cell.latexWrap, { displayMode: true, throwOnError: false });
      } catch (err) {
        cell.latexWrap.textContent = res.latex;
      }
    } else {
      cell.latexWrap.hidden = true;
      delete cell.latexWrap.dataset.latex;
      cell.latexWrap.innerHTML = "";
    }

    const hasCopyableText = Boolean(
      res.stdout || res.stderr || res.latex || exportedEntries.length > 0 || tables.length > 0,
    );
    const hasOut = Boolean(hasCopyableText || plots.length > 0);
    cell.outputWrap.hidden = !hasOut;
    cell.btnCopyOutput.hidden = !hasCopyableText;

    renderSessionExports(res.all_exports);
    setStatus(`Cell ${idx + 1} finished (exit code ${res.code})`);

    if (advanceFocus) {
      if (idx + 1 < cells.length) {
        cells[idx + 1].view.focus();
      } else {
        const next = createCellCard({ kind: "code", title: "", source: "" });
        markDirty();
        next.view.focus();
      }
    }
    return res.code === 0;
  } catch (e) {
    cell.outputWrap.hidden = false;
    cell.outputPre.hidden = false;
    cell.outputPre.textContent = String(e);
    cell.btnCopyOutput.hidden = false;
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
    c.outputWrap.classList.remove("has-table-toggle");
    c.tableModeGroup.hidden = true;
    c.btnCopyOutput.hidden = true;
    c.tablesWrap.hidden = true;
    c.tablesWrap.innerHTML = "";
    c.lastTables = [];
    c.lastFullStdout = "";
    c.lastNonTableStdout = "";
    c.lastStderr = "";
    c.latexWrap.hidden = true;
    delete c.latexWrap.dataset.latex;
    c.latexWrap.innerHTML = "";
  }
  renumberCells();
  renderSessionExports({});
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

async function saveFile(): Promise<boolean> {
  if (!requireTauri()) return true;
  if (activeTab()?.kind === "settings") {
    await saveSettingsScope();
    return true;
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
      if (cur.kind === "csv") csvEditor?.markSaved();
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
  } else if (actionId === "menu_close_tab") {
    closeTab(activeTabId);
  }
});

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    openSettingsTab();
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
  cells[0]?.view.focus();
}

void initializeAppStartup();
