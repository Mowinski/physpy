import { EditorView } from "@codemirror/view";
import { createPlainTextEditor, setDoc } from "./editor/setup";
import {
  type CsvDelimiter,
  detectCsvDelimiter,
  parseCsv,
  serializeCsv,
} from "./csvParser";

export { type CsvDelimiter, detectCsvDelimiter, parseCsv, serializeCsv };
export type CsvViewMode = "table" | "text";

export interface CsvStateSnapshot {
  mode: CsvViewMode;
  delimiter: CsvDelimiter;
  hasHeader: boolean;
}

export interface CsvMenuAction {
  label?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void | Promise<void>;
}

export interface CsvEditorOptions {
  container: HTMLElement;
  onChange: () => void;
  onSave: () => void;
  onBlur?: () => void;
  onStateChange?: (state: CsvStateSnapshot) => void;
  openContextMenu: (x: number, y: number, items: CsvMenuAction[]) => void;
}

function excelColName(index: number): string {
  let n = index;
  let label = "";
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

function setEditablePlaintext(el: HTMLElement) {
  el.contentEditable = "plaintext-only";
  if (!el.isContentEditable) {
    el.contentEditable = "true";
  }
  el.spellcheck = false;
}

export class CsvEditorController {
  private readonly root: HTMLElement;
  private readonly opts: CsvEditorOptions;

  private readonly btnModeTable: HTMLButtonElement;
  private readonly btnModeText: HTMLButtonElement;
  private readonly delimiterSelect: HTMLSelectElement;
  private readonly headerCheckbox: HTMLInputElement;
  private readonly btnAddRow: HTMLButtonElement;
  private readonly btnAddCol: HTMLButtonElement;
  private readonly statsEl: HTMLSpanElement;
  private readonly btnSave: HTMLButtonElement;

  private readonly tableWrapper: HTMLDivElement;
  private readonly tableEl: HTMLTableElement;
  private readonly tableFooter: HTMLDivElement;
  private readonly textContainer: HTMLDivElement;
  private readonly textEditor: EditorView;

  private rows: string[][] = [[""]];
  private mode: CsvViewMode = "table";
  private delimiter: CsvDelimiter = ",";
  private hasHeader = true;
  private lineEnding = "\n";
  private hadTrailingNewline = true;
  private sortState: { col: number; asc: boolean } | null = null;
  private visibleRowLimit = 500;
  private suppressTextChange = false;
  private isDirtyRawText = false;

  constructor(opts: CsvEditorOptions) {
    this.opts = opts;
    this.root = opts.container;
    this.root.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "csv-toolbar";

    const modeGroup = document.createElement("div");
    modeGroup.className = "csv-mode-switcher";
    modeGroup.setAttribute("role", "tablist");
    modeGroup.setAttribute("aria-label", "CSV view mode");

    this.btnModeTable = document.createElement("button");
    this.btnModeTable.type = "button";
    this.btnModeTable.className = "csv-mode-btn active";
    this.btnModeTable.setAttribute("role", "tab");
    this.btnModeTable.setAttribute("aria-selected", "true");
    this.btnModeTable.textContent = "📊 Table";

    this.btnModeText = document.createElement("button");
    this.btnModeText.type = "button";
    this.btnModeText.className = "csv-mode-btn";
    this.btnModeText.setAttribute("role", "tab");
    this.btnModeText.setAttribute("aria-selected", "false");
    this.btnModeText.textContent = "📝 Text";

    modeGroup.append(this.btnModeTable, this.btnModeText);

    const delimLabel = document.createElement("label");
    delimLabel.className = "csv-toolbar-field";
    delimLabel.textContent = "Delimiter:";
    this.delimiterSelect = document.createElement("select");
    this.delimiterSelect.className = "csv-select";
    this.delimiterSelect.title = "CSV column delimiter";
    this.delimiterSelect.innerHTML = `
      <option value=",">, (Comma)</option>
      <option value=";">; (Semicolon)</option>
      <option value="&#9;">Tab (\\t)</option>
    `;
    delimLabel.append(this.delimiterSelect);

    const headerLabel = document.createElement("label");
    headerLabel.className = "csv-toolbar-check";
    this.headerCheckbox = document.createElement("input");
    this.headerCheckbox.type = "checkbox";
    this.headerCheckbox.checked = true;
    const headerSpan = document.createElement("span");
    headerSpan.textContent = "Header row";
    headerLabel.append(this.headerCheckbox, headerSpan);

    this.btnAddRow = document.createElement("button");
    this.btnAddRow.type = "button";
    this.btnAddRow.className = "csv-btn";
    this.btnAddRow.textContent = "+ Row";
    this.btnAddRow.title = "Append empty row";

    this.btnAddCol = document.createElement("button");
    this.btnAddCol.type = "button";
    this.btnAddCol.className = "csv-btn";
    this.btnAddCol.textContent = "+ Col";
    this.btnAddCol.title = "Append empty column";

    const spacer = document.createElement("div");
    spacer.className = "csv-toolbar-spacer";

    this.statsEl = document.createElement("span");
    this.statsEl.className = "csv-stats";

    this.btnSave = document.createElement("button");
    this.btnSave.type = "button";
    this.btnSave.className = "csv-btn primary";
    this.btnSave.innerHTML = "💾 Save <kbd>⌘S</kbd>";
    this.btnSave.title = "Save CSV file (Cmd+S)";

    toolbar.append(
      modeGroup,
      delimLabel,
      headerLabel,
      this.btnAddRow,
      this.btnAddCol,
      spacer,
      this.statsEl,
      this.btnSave,
    );

    this.tableWrapper = document.createElement("div");
    this.tableWrapper.className = "csv-table-wrapper";
    this.tableWrapper.tabIndex = 0;
    this.tableWrapper.setAttribute("role", "region");
    this.tableWrapper.setAttribute("aria-label", "CSV spreadsheet editor");

    this.tableEl = document.createElement("table");
    this.tableEl.className = "csv-table";

    this.tableFooter = document.createElement("div");
    this.tableFooter.className = "csv-table-footer";
    this.tableFooter.hidden = true;

    this.tableWrapper.append(this.tableEl, this.tableFooter);

    this.textContainer = document.createElement("div");
    this.textContainer.className = "csv-text-container";
    this.textContainer.hidden = true;

    this.textEditor = createPlainTextEditor({
      parent: this.textContainer,
      doc: "",
      onChange: () => {
        if (this.suppressTextChange) return;
        this.isDirtyRawText = true;
        this.opts.onChange();
      },
      onBlur: () => {
        this.opts.onBlur?.();
      },
      keys: [
        {
          key: "Mod-s",
          run: () => {
            this.opts.onSave();
            return true;
          },
        },
      ],
    });

    this.root.append(toolbar, this.tableWrapper, this.textContainer);

    // Wire toolbar controls
    this.btnModeTable.addEventListener("click", () => this.switchMode("table"));
    this.btnModeText.addEventListener("click", () => this.switchMode("text"));
    this.btnSave.addEventListener("click", () => this.opts.onSave());

    this.delimiterSelect.addEventListener("change", () => {
      const next = (this.delimiterSelect.value === "\t" ? "\t" : this.delimiterSelect.value) as CsvDelimiter;
      if (next === this.delimiter) return;
      if (this.mode === "text" || !this.isDirtyRawText) {
        // Re-parse existing raw text using the new delimiter (non-destructive re-interpretation)
        const raw = this.mode === "text" ? this.textEditor.state.doc.toString() : serializeCsv(this.rows, this.delimiter, this.lineEnding, this.hadTrailingNewline);
        this.delimiter = next;
        this.rows = parseCsv(raw, this.delimiter);
        this.sortState = null;
        if (this.mode === "table") this.renderTable();
        this.updateStats();
      } else {
        // Already edited in table: switch serialization delimiter and mark dirty
        this.delimiter = next;
        this.opts.onChange();
      }
      this.notifyState();
    });

    this.headerCheckbox.addEventListener("change", () => {
      this.hasHeader = this.headerCheckbox.checked;
      this.sortState = null;
      if (this.mode === "table") this.renderTable();
      this.updateStats();
      this.notifyState();
    });

    this.btnAddRow.addEventListener("click", () => {
      const cols = this.colCount();
      this.rows.push(new Array<string>(cols).fill(""));
      const dataCount = this.hasHeader ? Math.max(0, this.rows.length - 1) : this.rows.length;
      if (dataCount > this.visibleRowLimit) {
        this.visibleRowLimit = dataCount;
      }
      this.isDirtyRawText = true;
      this.renderTable();
      this.updateStats();
      this.opts.onChange();
      this.focusCell(this.rows.length - 1, 0);
    });

    this.btnAddCol.addEventListener("click", () => {
      const colIdx = this.colCount();
      this.rows.forEach((r, idx) => {
        r.push(idx === 0 && this.hasHeader ? `Column ${colIdx + 1}` : "");
      });
      this.isDirtyRawText = true;
      this.renderTable();
      this.updateStats();
      this.opts.onChange();
      this.focusCell(0, colIdx);
    });
  }

  load(
    text: string,
    opts?: {
      path?: string | null;
      mode?: CsvViewMode;
      delimiter?: CsvDelimiter;
      hasHeader?: boolean;
      dirty?: boolean;
    },
  ) {
    this.lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
    this.hadTrailingNewline = text.endsWith("\n") || text.endsWith("\r");
    this.delimiter = opts?.delimiter ?? detectCsvDelimiter(text, opts?.path);
    this.delimiterSelect.value = this.delimiter;
    this.hasHeader = opts?.hasHeader ?? true;
    this.headerCheckbox.checked = this.hasHeader;
    this.mode = opts?.mode ?? "table";
    this.sortState = null;
    this.visibleRowLimit = 500;
    this.isDirtyRawText = opts?.dirty ?? false;

    this.rows = parseCsv(text, this.delimiter);
    this.suppressTextChange = true;
    setDoc(this.textEditor, text);
    this.suppressTextChange = false;

    this.applyModeVisibility();
    if (this.mode === "table") {
      this.renderTable();
    }
    this.updateStats();
    this.notifyState();
  }

  switchMode(next: CsvViewMode) {
    if (next === this.mode) return;
    if (next === "text") {
      const csv = serializeCsv(this.rows, this.delimiter, this.lineEnding, this.hadTrailingNewline);
      this.suppressTextChange = true;
      setDoc(this.textEditor, csv);
      this.suppressTextChange = false;
      this.mode = "text";
      this.applyModeVisibility();
      this.textEditor.focus();
    } else {
      const raw = this.textEditor.state.doc.toString();
      this.lineEnding = raw.includes("\r\n") ? "\r\n" : "\n";
      this.hadTrailingNewline = raw.endsWith("\n") || raw.endsWith("\r");
      this.rows = parseCsv(raw, this.delimiter);
      this.sortState = null;
      this.mode = "table";
      this.applyModeVisibility();
      this.renderTable();
      this.updateStats();
    }
    this.notifyState();
  }

  getText(): string {
    if (this.mode === "text") {
      return this.textEditor.state.doc.toString();
    }
    return serializeCsv(this.rows, this.delimiter, this.lineEnding, this.hadTrailingNewline);
  }

  getState(): CsvStateSnapshot {
    return {
      mode: this.mode,
      delimiter: this.delimiter,
      hasHeader: this.hasHeader,
    };
  }

  markSaved() {
    this.isDirtyRawText = false;
  }

  focus() {
    if (this.mode === "text") {
      this.textEditor.focus();
    } else {
      const firstCell = this.tableEl.querySelector<HTMLElement>("tbody td");
      if (firstCell) firstCell.focus();
      else this.tableWrapper.focus();
    }
  }

  private notifyState() {
    this.opts.onStateChange?.(this.getState());
  }

  private colCount(): number {
    return this.rows[0]?.length ?? 1;
  }

  private applyModeVisibility() {
    const isTable = this.mode === "table";
    this.tableWrapper.hidden = !isTable;
    this.textContainer.hidden = isTable;
    this.btnModeTable.classList.toggle("active", isTable);
    this.btnModeTable.setAttribute("aria-selected", String(isTable));
    this.btnModeText.classList.toggle("active", !isTable);
    this.btnModeText.setAttribute("aria-selected", String(!isTable));
    this.btnAddRow.hidden = !isTable;
    this.btnAddCol.hidden = !isTable;
  }

  private updateStats() {
    const dataRows = this.hasHeader ? Math.max(0, this.rows.length - 1) : this.rows.length;
    const cols = this.colCount();
    this.statsEl.textContent = `${dataRows} ${dataRows === 1 ? "row" : "rows"} × ${cols} ${cols === 1 ? "col" : "cols"}`;
  }

  private renderTable() {
    const cols = this.colCount();
    this.tableEl.innerHTML = "";

    const thead = document.createElement("thead");
    const headTr = document.createElement("tr");

    // Top-left corner cell
    const cornerTh = document.createElement("th");
    cornerTh.scope = "col";
    cornerTh.className = "csv-corner-th";
    cornerTh.textContent = "#";
    headTr.append(cornerTh);

    for (let c = 0; c < cols; c++) {
      const th = document.createElement("th");
      th.scope = "col";
      th.dataset.col = String(c);

      const thInner = document.createElement("div");
      thInner.className = "csv-th-inner";

      if (this.hasHeader) {
        const textSpan = document.createElement("span");
        textSpan.className = "csv-th-text";
        textSpan.textContent = this.rows[0][c] ?? "";
        setEditablePlaintext(textSpan);
        textSpan.dataset.row = "0";
        textSpan.dataset.col = String(c);
        textSpan.addEventListener("input", () => {
          this.rows[0][c] = textSpan.textContent ?? "";
          this.isDirtyRawText = true;
          this.opts.onChange();
        });
        textSpan.addEventListener("keydown", (e) => this.handleCellKeyDown(e, 0, c));
        textSpan.addEventListener("blur", () => this.opts.onBlur?.());
        thInner.append(textSpan);
      } else {
        const labelSpan = document.createElement("span");
        labelSpan.className = "csv-th-label";
        labelSpan.textContent = excelColName(c);
        thInner.append(labelSpan);
      }

      const sortBtn = document.createElement("button");
      sortBtn.type = "button";
      sortBtn.className = "csv-sort-btn";
      const isSorted = this.sortState?.col === c;
      sortBtn.classList.toggle("sorted", isSorted);
      sortBtn.textContent = isSorted ? (this.sortState!.asc ? "▲" : "▼") : "⇅";
      sortBtn.title = "Sort column";
      sortBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const asc = this.sortState?.col === c ? !this.sortState.asc : true;
        this.sortColumn(c, asc);
      });
      thInner.append(sortBtn);

      th.append(thInner);
      th.addEventListener("contextmenu", (e) => this.openCellContextMenu(e, 0, c, true));
      headTr.append(th);
    }
    thead.append(headTr);

    const tbody = document.createElement("tbody");
    const startRow = this.hasHeader ? 1 : 0;
    const totalDataRows = Math.max(0, this.rows.length - startRow);
    const renderCount = Math.min(totalDataRows, this.visibleRowLimit);

    for (let i = 0; i < renderCount; i++) {
      const r = startRow + i;
      const tr = document.createElement("tr");

      const rowTh = document.createElement("th");
      rowTh.scope = "row";
      rowTh.className = "csv-row-th";
      rowTh.textContent = String(i + 1);
      rowTh.addEventListener("contextmenu", (e) => this.openCellContextMenu(e, r, 0, false));
      tr.append(rowTh);

      for (let c = 0; c < cols; c++) {
        const td = document.createElement("td");
        td.dataset.row = String(r);
        td.dataset.col = String(c);
        td.textContent = this.rows[r][c] ?? "";
        setEditablePlaintext(td);

        td.addEventListener("input", () => {
          this.rows[r][c] = td.textContent ?? "";
          this.isDirtyRawText = true;
          this.opts.onChange();
        });
        td.addEventListener("keydown", (e) => this.handleCellKeyDown(e, r, c));
        td.addEventListener("blur", () => this.opts.onBlur?.());
        td.addEventListener("contextmenu", (e) => this.openCellContextMenu(e, r, c, false));
        tr.append(td);
      }

      tbody.append(tr);
    }

    this.tableEl.append(thead, tbody);

    // Large CSV footer
    if (totalDataRows > renderCount) {
      this.tableFooter.hidden = false;
      this.tableFooter.innerHTML = "";
      const info = document.createElement("span");
      info.textContent = `Showing ${renderCount} of ${totalDataRows} rows`;
      const btnMore = document.createElement("button");
      btnMore.type = "button";
      btnMore.className = "csv-btn";
      btnMore.textContent = "Load 500 more";
      btnMore.addEventListener("click", () => {
        this.visibleRowLimit += 500;
        this.renderTable();
      });
      const btnAll = document.createElement("button");
      btnAll.type = "button";
      btnAll.className = "csv-btn";
      btnAll.textContent = "Show all";
      btnAll.addEventListener("click", () => {
        this.visibleRowLimit = totalDataRows;
        this.renderTable();
      });
      this.tableFooter.append(info, btnMore, btnAll);
    } else {
      this.tableFooter.hidden = true;
    }
  }

  private handleCellKeyDown(e: KeyboardEvent, r: number, c: number) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      this.opts.onSave();
      return;
    }
    if (e.key === "Escape") {
      (e.currentTarget as HTMLElement).blur();
      return;
    }
    if (e.key === "Enter" && !e.altKey) {
      e.preventDefault();
      const targetRow = e.shiftKey ? r - 1 : r + 1;
      if (targetRow >= 0 && targetRow < this.rows.length) {
        this.focusCell(targetRow, c);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const target = e.currentTarget as HTMLElement;
      const text = target.textContent ?? "";
      // Only jump rows on single-line cells so multiline editing still moves cursor natively
      if (!text.includes("\n")) {
        const nextRow = e.key === "ArrowDown" ? r + 1 : r - 1;
        if (nextRow >= 0 && nextRow < this.rows.length) {
          e.preventDefault();
          this.focusCell(nextRow, c);
        }
      }
    }
  }

  private focusCell(r: number, c: number) {
    const sel =
      r === 0 && this.hasHeader
        ? `.csv-th-text[data-row="0"][data-col="${c}"]`
        : `tbody td[data-row="${r}"][data-col="${c}"]`;
    const el = this.tableEl.querySelector<HTMLElement>(sel);
    if (el) {
      el.focus();
      // Place caret at end
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  private sortColumn(col: number, asc: boolean) {
    const startIdx = this.hasHeader ? 1 : 0;
    const body = this.rows.slice(startIdx);
    body.sort((a, b) => {
      const va = (a[col] ?? "").trim();
      const vb = (b[col] ?? "").trim();
      if (va === "" && vb === "") return 0;
      if (va === "") return 1;
      if (vb === "") return -1;
      const na = Number(va);
      const nb = Number(vb);
      if (Number.isFinite(na) && Number.isFinite(nb)) {
        return asc ? na - nb : nb - na;
      }
      const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
      return asc ? cmp : -cmp;
    });
    this.rows = [...this.rows.slice(0, startIdx), ...body];
    this.sortState = { col, asc };
    this.isDirtyRawText = true;
    this.renderTable();
    this.opts.onChange();
  }

  private openCellContextMenu(e: MouseEvent, r: number, c: number, isHeader: boolean) {
    e.preventDefault();
    e.stopPropagation();
    const cols = this.colCount();
    const minRows = this.hasHeader ? 2 : 1;

    const items: CsvMenuAction[] = [];
    if (!isHeader) {
      items.push(
        {
          label: "Insert row above",
          run: () => {
            this.rows.splice(r, 0, new Array<string>(cols).fill(""));
            this.isDirtyRawText = true;
            this.renderTable();
            this.updateStats();
            this.opts.onChange();
            this.focusCell(r, c);
          },
        },
        {
          label: "Insert row below",
          run: () => {
            this.rows.splice(r + 1, 0, new Array<string>(cols).fill(""));
            this.isDirtyRawText = true;
            this.renderTable();
            this.updateStats();
            this.opts.onChange();
            this.focusCell(r + 1, c);
          },
        },
        {
          label: "Delete row",
          danger: true,
          disabled: this.rows.length <= minRows,
          run: () => {
            if (this.rows.length <= minRows) return;
            this.rows.splice(r, 1);
            this.isDirtyRawText = true;
            this.renderTable();
            this.updateStats();
            this.opts.onChange();
          },
        },
        { separator: true },
      );
    }

    items.push(
      {
        label: "Insert column left",
        run: () => {
          this.rows.forEach((row, idx) => {
            row.splice(c, 0, idx === 0 && this.hasHeader ? `Column ${c + 1}` : "");
          });
          this.sortState = null;
          this.isDirtyRawText = true;
          this.renderTable();
          this.updateStats();
          this.opts.onChange();
        },
      },
      {
        label: "Insert column right",
        run: () => {
          this.rows.forEach((row, idx) => {
            row.splice(c + 1, 0, idx === 0 && this.hasHeader ? `Column ${c + 2}` : "");
          });
          this.sortState = null;
          this.isDirtyRawText = true;
          this.renderTable();
          this.updateStats();
          this.opts.onChange();
        },
      },
      {
        label: "Delete column",
        danger: true,
        disabled: cols <= 1,
        run: () => {
          if (cols <= 1) return;
          for (const row of this.rows) row.splice(c, 1);
          this.sortState = null;
          this.isDirtyRawText = true;
          this.renderTable();
          this.updateStats();
          this.opts.onChange();
        },
      },
      { separator: true },
      { label: "Sort column A → Z", run: () => this.sortColumn(c, true) },
      { label: "Sort column Z → A", run: () => this.sortColumn(c, false) },
    );

    this.opts.openContextMenu(e.clientX, e.clientY, items);
  }
}
