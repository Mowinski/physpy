import "katex/dist/katex.min.css";
import "./styles.css";
import type { EditorView } from "@codemirror/view";
import demo from "../examples/demo.ppy?raw";
import * as backend from "./backend";
import { createEditor, createViewer, setDoc } from "./editor/setup";
import { SYMBOLS, SYMBOL_RE } from "./editor/symbols";
import { type ConstLocation, setNotebookExportedConsts } from "./editor/constLint";
import { convertIpynbToPpy } from "./ipynbImport";
import { renderMarkdownWithLatex } from "./markdownLatex";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type CellKind = "code" | "markdown" | "media";

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
  btnRun: HTMLButtonElement;
  outputWrap: HTMLDivElement;
  outputPre: HTMLPreElement;
  plotsWrap: HTMLDivElement;
  exportedBar: HTMLDivElement;
  runCount: number | null;
}

interface TabDoc {
  id: number;
  path: string | null;
  untitledName: string;
  content: string;
  dirty: boolean;
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

const notebookEl = $<HTMLDivElement>("notebook");
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
const contextMenuEl = $<HTMLDivElement>("context-menu");
const contextMenuGroupEl = $<HTMLDivElement>("context-menu-group");
const viewer = createViewer($("python"));

function setStatus(text: string) {
  status.textContent = text;
}

function activeTab(): TabDoc | undefined {
  return tabs.find((t) => t.id === activeTabId);
}

function tabDisplayName(t: TabDoc): string {
  return t.path?.split(/[\\/]/).pop() ?? t.untitledName;
}

function updateTitle() {
  const tab = activeTab();
  if (tab) {
    tab.path = currentPath;
    tab.dirty = dirty;
  }
  const name = tab ? tabDisplayName(tab) : (currentPath?.split(/[\\/]/).pop() ?? "untitled.ppy");
  document.title = `${dirty ? "● " : ""}${name} — PhysPy`;
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
  if (cur) {
    cur.content = serializeDocument();
    cur.path = currentPath;
    cur.dirty = dirty;
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
    item.title = tab.path ?? tab.untitledName;

    const icon = document.createElement("span");
    icon.className = "tab-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = fileIcon(tabDisplayName(tab));

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
  const tab: TabDoc = {
    id: nextTabId++,
    path: opts?.path ?? null,
    untitledName: `untitled-${untitledCounter++}.ppy`,
    content: opts?.content ?? "# %% Cell 1\n",
    dirty: opts?.dirty ?? false,
  };
  tabs.push(tab);
  switchToTab(tab.id);
  return tab;
}

function switchToTab(tabId: number) {
  const target = tabs.find((t) => t.id === tabId);
  if (!target) return;
  if (activeTabId && activeTabId !== tabId) {
    saveActiveTabSnapshot();
  }
  activeTabId = target.id;
  currentPath = target.path;
  dirty = target.dirty;
  loadDocumentIntoCells(target.content);
  updateTitle();
  void refreshPython();
  cells[0]?.view.focus();
}

function closeTab(tabId: number) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  if (tabs.length === 1) {
    // Keep one clean untitled tab open
    tabs[0].path = null;
    tabs[0].untitledName = `untitled-${untitledCounter++}.ppy`;
    tabs[0].content = "# %% Cell 1\n";
    tabs[0].dirty = false;
    activeTabId = 0;
    switchToTab(tabs[0].id);
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

async function refreshInterpreterBadge() {
  if (!backend.inTauri) return;
  try {
    const res = await backend.listPythonInterpreters(rootDir);
    const active = res.interpreters.find((i) => i.path === res.current) ?? res.interpreters[0];
    if (active) {
      interpreterLabelEl.textContent = active.label;
      $("btn-interpreter").title = `Active Python: ${active.path}`;
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
      interpreterLabelEl.textContent = info.label;
      $("btn-interpreter").title = `Active Python: ${info.path}`;
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
    interpreterLabelEl.textContent = info.label;
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
  const picked = await backend.pickPythonBinary();
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
  if (lower.endsWith(".ppy")) return "⚛";
  if (lower.endsWith(".ipynb")) return "📓";
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
  try {
    await backend.writeFileByPath(fullPath, "# %% Cell 1\n");
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
    await autoSelectWorkspacePython(picked);
  }
  return true;
}

async function openFileByPath(path: string) {
  if (!requireTauri()) return;
  const existing = tabs.find((t) => t.path === path);
  if (existing) {
    switchToTab(existing.id);
    setStatus(`Switched to ${path}`);
    return;
  }
  try {
    const contents = await backend.readFileByPath(path);
    await resetSession(true);
    // Replace current tab if it is an untouched untitled tab
    const cur = activeTab();
    if (cur && !cur.path && !cur.dirty && tabs.length === 1) {
      cur.path = path;
      cur.content = contents;
      cur.dirty = false;
      currentPath = path;
      dirty = false;
      loadDocumentIntoCells(contents);
      updateTitle();
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
    if (kind === "markdown") {
      source = uncommentMarkdownBlock(rawBody);
    } else if (kind === "media") {
      source = extractMediaPathFromBlock(rawBody);
    }
    out.push({ kind, title, source });
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

function replaceSymbolsInIdent(raw: string): string {
  return raw.replace(SYMBOL_RE, (full, name: string, tail: string) =>
    name in SYMBOLS ? SYMBOLS[name].normalize("NFKC") + tail : full,
  );
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

function toggleVariablesDrawer(): boolean {
  variablesDrawerEl.hidden = !variablesDrawerEl.hidden;
  btnVariablesEl.setAttribute("aria-expanded", String(!variablesDrawerEl.hidden));
  btnVariablesEl.classList.toggle("active-toggle", !variablesDrawerEl.hidden);
  return true;
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
  const duplicateCount = items.filter((it) => it.occurrences.length > 1).length;

  variablesCountEl.textContent =
    duplicateCount > 0 ? `${items.length} ⚠` : String(items.length);
  variablesCountEl.classList.toggle("has-warning", duplicateCount > 0);
  variablesCountEl.hidden = items.length === 0;

  if (items.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "exports-empty";
    td.innerHTML = "No exported variables in this file (use <code>export x = …</code> in a cell)";
    tr.append(td);
    variablesTbodyEl.append(tr);
    return;
  }

  for (const item of items) {
    const isDup = item.occurrences.length > 1;
    const hasValue = Object.prototype.hasOwnProperty.call(sessionRuntimeExports, item.name);
    const val = sessionRuntimeExports[item.name];

    const tr = document.createElement("tr");
    if (isDup) tr.className = "row-duplicate";

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
    if (isDup) {
      const warn = document.createElement("span");
      warn.className = "dup-badge";
      warn.textContent = `⚠ exported ${item.occurrences.length}×`;
      warn.title =
        "Exported multiple times: " +
        item.occurrences.map((o) => `Cell ${o.cellIndex} (line ${o.line})`).join(", ");
      th.append(warn);
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
  renderSessionExports();
  clearTimeout(transpileTimer);
  transpileTimer = window.setTimeout(refreshPython, 400);
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
  cell.el.classList.remove("kind-code", "kind-markdown", "kind-media");
  cell.el.classList.add(`kind-${cell.kind}`);
  cell.kindSelect.value = cell.kind;

  if (cell.kind === "code") {
    cell.editorHost.hidden = false;
    cell.mdPreviewEl.hidden = true;
    cell.mediaWrap.hidden = true;
    cell.btnRun.innerHTML = "▶ Run <kbd>⌘↵</kbd>";
    cell.btnRun.title = "Run this code cell (Cmd+Enter or Shift+Enter)";
  } else if (cell.kind === "markdown") {
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
  } else {
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
  kindSelect.title = "Cell type (Code, Markdown + LaTeX, or PDF / Image)";
  kindSelect.innerHTML = `
    <option value="code">⚛ Code</option>
    <option value="markdown">M↓ Markdown + LaTeX</option>
    <option value="media">📄 PDF / Image</option>
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
  card.append(header, editorHost, mdPreviewEl, mediaWrap, outputWrap);

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
      { key: "Mod-p", run: () => togglePython() },
    ],
    onChange: markDirty,
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
    btnRun,
    outputWrap,
    outputPre,
    plotsWrap,
    exportedBar,
    runCount: null,
  };

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
  for (const parsed of parseDocument(src)) {
    createCellCard(parsed);
  }
  renderSessionExports();
}

// --- Execution -------------------------------------------------------------

async function runSingleCell(cell: CellState, advanceFocus: boolean): Promise<boolean> {
  const idx = cells.indexOf(cell);

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
  const serialized = serializeDocument();
  const path = await backend.saveFile(serialized, currentPath);
  if (path) {
    currentPath = path;
    dirty = false;
    const cur = activeTab();
    if (cur) {
      cur.path = path;
      cur.content = serialized;
      cur.dirty = false;
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
$("btn-open").addEventListener("click", wrap(openFile));
$("btn-open-folder").addEventListener("click", wrap(changeRootFolder));
$("btn-save").addEventListener("click", wrap(saveFile));
$("btn-run-all").addEventListener("click", wrap(runAllCells));
$("btn-reset").addEventListener("click", wrap(() => resetSession(false)));
$("btn-add-cell").addEventListener("click", () => {
  const c = createCellCard({ kind: "code", title: "", source: "" });
  markDirty();
  c.view.focus();
});
$("btn-add-md-cell").addEventListener("click", () => {
  const c = createCellCard({
    kind: "markdown",
    title: "Notes",
    source: "## Theoretical Background\n\nEnter Markdown and LaTeX formulas, e.g. $\\eta = \\frac{\\pi R^4 \\Delta p}{8 L Q}$ or:\n\n$$E = m c^2$$",
  });
  c.mdEditing = true;
  applyCellKindUI(c);
  markDirty();
  c.view.focus();
});
$("btn-add-media-cell").addEventListener("click", async () => {
  let pickedPath = "";
  let title = "Attachment";
  if (backend.inTauri) {
    const picked = await backend.pickMediaFile();
    if (picked) {
      pickedPath = toWorkspaceRelativeIfPossible(picked);
      title = picked.split(/[\\/]/).pop() ?? "Attachment";
    }
  }
  const c = createCellCard({
    kind: "media",
    title,
    source: pickedPath,
  });
  markDirty();
  c.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("btn-variables").addEventListener("click", wrap(toggleVariablesDrawer));
$("btn-close-variables").addEventListener("click", wrap(toggleVariablesDrawer));
$("btn-interpreter").addEventListener("click", wrap(openPythonDialog));
$("btn-python").addEventListener("click", wrap(togglePython));

createNewTab({ path: null, content: demo, dirty: false });
tabs[0].untitledName = "demo.ppy";
updateTitle();
void refreshFileTree();
void refreshInterpreterBadge();
setStatus(backend.inTauri ? "Ready — Shift+Enter or Cmd+Enter runs a cell" : "Browser mode: editing only");
cells[0]?.view.focus();
