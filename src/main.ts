import "katex/dist/katex.min.css";
import "./styles.css";
import type { EditorView } from "@codemirror/view";
import demo from "../examples/demo.ppy?raw";
import * as backend from "./backend";
import { createEditor, createViewer, setDoc } from "./editor/setup";
import { SYMBOLS, SYMBOL_RE } from "./editor/symbols";
import { type ConstLocation, setNotebookExportedConsts } from "./editor/constLint";

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
if (!("closedBy" in HTMLDialogElement.prototype)) {
  const outside = (e: PointerEvent, dialog: HTMLDialogElement) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  pythonDialog.addEventListener("pointerdown", (e) => {
    pressedOutside = outside(e, pythonDialog);
  });
  pythonDialog.addEventListener("pointerup", (e) => {
    if (pressedOutside && outside(e, pythonDialog)) pythonDialog.close();
  });
}

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

function fileIcon(name: string): string {
  if (name.endsWith(".ppy")) return "⚛";
  if (name.endsWith(".py")) return "🐍";
  if (name.endsWith(".md") || name.endsWith(".txt")) return "📄";
  if (name.endsWith(".json") || name.endsWith(".toml") || name.endsWith(".yaml")) return "⚙";
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
      icon.textContent = fileIcon(entry.name);
      row.addEventListener("click", () => {
        void openFileByPath(entry.path);
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const parentDir = entry.path.replace(/[\\/][^\\/]+$/, "");
        openContextMenu(e.clientX, e.clientY, [
          { label: "Open in Tab", run: () => openFileByPath(entry.path) },
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
        ]);
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
    const num = c.runCount ?? " ";
    c.badgeEl.textContent = `In [${num}]`;
    c.badgeEl.title = `Cell ${idx + 1}`;
  });
}

function markDirty() {
  dirty = true;
  updateTitle();
  renderSessionExports();
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

  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const idx = cells.indexOf(state);
    openContextMenu(e.clientX, e.clientY, [
      { label: "▶ Run Cell", shortcut: "⌘↵", run: () => void runSingleCell(state, false) },
      { label: "▶▶ Run All Cells", shortcut: "⇧⌘↵", run: () => void runAllCells() },
      { separator: true },
      {
        label: "Insert Cell Above",
        run: () => {
          const created = createCellCard({ title: "", source: "" }, idx);
          markDirty();
          created.view.focus();
        },
      },
      {
        label: "Insert Cell Below",
        run: () => {
          const created = createCellCard({ title: "", source: "" }, idx + 1);
          markDirty();
          created.view.focus();
        },
      },
      {
        label: "Duplicate Cell",
        run: () => {
          const created = createCellCard(
            { title: state.title, source: state.view.state.doc.toString() },
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
  renderSessionExports();
}

// --- Execution -------------------------------------------------------------

async function runSingleCell(cell: CellState, advanceFocus: boolean): Promise<boolean> {
  if (!requireTauri()) return true;
  const idx = cells.indexOf(cell);
  setStatus(`Running cell ${idx + 1}…`);
  cell.el.classList.add("running");

  try {
    const res = await backend.runCell(
      cell.view.state.doc.toString(),
      currentPath,
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
  const c = createCellCard({ title: "", source: "" });
  markDirty();
  c.view.focus();
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
