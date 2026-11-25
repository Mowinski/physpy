import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const PDF_POSITIONS_STORAGE_KEY = "physpy_pdf_positions";
const MAX_STORED_PDF_POSITIONS = 200;
export const DEFAULT_PDF_SCALE = 1.15;
const MIN_PDF_SCALE = 0.4;
const MAX_PDF_SCALE = 3.5;

export interface PdfReadingPosition {
  scrollTop: number;
  scrollLeft: number;
  scale: number;
  page: number;
  updatedAt: number;
}

export interface PdfViewerOptions {
  container: HTMLElement;
  readBinaryFile: (path: string) => Promise<Uint8Array | number[]>;
  setStatus?: (msg: string) => void;
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_PDF_SCALE;
  return Math.min(MAX_PDF_SCALE, Math.max(MIN_PDF_SCALE, Math.round(scale * 100) / 100));
}

export function loadSavedPdfPosition(filePath: string): PdfReadingPosition | null {
  if (!filePath) return null;
  try {
    const raw = localStorage.getItem(PDF_POSITIONS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entry = parsed?.[filePath];
    if (!entry || typeof entry !== "object") return null;
    const rec = entry as Record<string, unknown>;
    const scrollTop = typeof rec.scrollTop === "number" && Number.isFinite(rec.scrollTop) ? Math.max(0, rec.scrollTop) : 0;
    const scrollLeft = typeof rec.scrollLeft === "number" && Number.isFinite(rec.scrollLeft) ? Math.max(0, rec.scrollLeft) : 0;
    const scale = typeof rec.scale === "number" && Number.isFinite(rec.scale) ? clampScale(rec.scale) : DEFAULT_PDF_SCALE;
    const page = typeof rec.page === "number" && Number.isFinite(rec.page) ? Math.max(1, Math.floor(rec.page)) : 1;
    const updatedAt = typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0;
    return { scrollTop, scrollLeft, scale, page, updatedAt };
  } catch {
    return null;
  }
}

export function savePdfPosition(
  filePath: string,
  pos: Omit<PdfReadingPosition, "updatedAt">,
): void {
  if (!filePath) return;
  try {
    const raw = localStorage.getItem(PDF_POSITIONS_STORAGE_KEY);
    const map: Record<string, PdfReadingPosition> = raw ? (JSON.parse(raw) as Record<string, PdfReadingPosition>) : {};
    map[filePath] = {
      scrollTop: Math.max(0, pos.scrollTop),
      scrollLeft: Math.max(0, pos.scrollLeft),
      scale: clampScale(pos.scale),
      page: Math.max(1, Math.floor(pos.page)),
      updatedAt: Date.now(),
    };

    const keys = Object.keys(map);
    if (keys.length > MAX_STORED_PDF_POSITIONS) {
      keys.sort((a, b) => (map[a]?.updatedAt ?? 0) - (map[b]?.updatedAt ?? 0));
      const removeCount = keys.length - MAX_STORED_PDF_POSITIONS;
      for (let i = 0; i < removeCount; i++) {
        delete map[keys[i]];
      }
    }

    localStorage.setItem(PDF_POSITIONS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore localStorage quota/access errors
  }
}

export class PdfViewerController {
  private readonly opts: PdfViewerOptions;
  private readonly toolbar: HTMLDivElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly metaEl: HTMLSpanElement;
  private readonly btnPrevPage: HTMLButtonElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pageTotalEl: HTMLSpanElement;
  private readonly btnNextPage: HTMLButtonElement;
  private readonly btnZoomOut: HTMLButtonElement;
  private readonly zoomLabel: HTMLButtonElement;
  private readonly btnZoomIn: HTMLButtonElement;
  private readonly btnReload: HTMLButtonElement;
  private readonly scrollEl: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;

  private currentFilePath: string | null = null;
  private lastPdfBytes: Uint8Array | null = null;
  private scale = DEFAULT_PDF_SCALE;
  private numPages = 0;
  private renderSeq = 0;
  private isRestoring = false;
  private scrollSaveTimer: number | undefined;

  constructor(opts: PdfViewerOptions) {
    this.opts = opts;
    this.opts.container.innerHTML = "";

    this.toolbar = document.createElement("div");
    this.toolbar.className = "pdf-view-toolbar";

    this.titleEl = document.createElement("span");
    this.titleEl.className = "pdf-view-title";
    this.titleEl.textContent = "📕 PDF";

    this.metaEl = document.createElement("span");
    this.metaEl.className = "pdf-view-meta";

    const pageNav = document.createElement("div");
    pageNav.className = "pdf-view-page-nav";

    this.btnPrevPage = document.createElement("button");
    this.btnPrevPage.type = "button";
    this.btnPrevPage.className = "latex-small-btn";
    this.btnPrevPage.textContent = "◀";
    this.btnPrevPage.title = "Previous page";
    this.btnPrevPage.addEventListener("click", () => {
      this.goToPage(this.computeCurrentPage() - 1);
    });

    this.pageInput = document.createElement("input");
    this.pageInput.type = "number";
    this.pageInput.min = "1";
    this.pageInput.value = "1";
    this.pageInput.className = "pdf-view-page-input";
    this.pageInput.title = "Jump to page";
    this.pageInput.addEventListener("change", () => {
      const parsed = parseInt(this.pageInput.value, 10);
      if (Number.isFinite(parsed)) {
        this.goToPage(parsed);
      } else {
        this.pageInput.value = String(this.computeCurrentPage());
      }
    });
    this.pageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const parsed = parseInt(this.pageInput.value, 10);
        if (Number.isFinite(parsed)) {
          this.goToPage(parsed);
        }
        this.scrollEl.focus();
      }
    });

    this.pageTotalEl = document.createElement("span");
    this.pageTotalEl.className = "pdf-view-page-total";
    this.pageTotalEl.textContent = "/ 0";

    this.btnNextPage = document.createElement("button");
    this.btnNextPage.type = "button";
    this.btnNextPage.className = "latex-small-btn";
    this.btnNextPage.textContent = "▶";
    this.btnNextPage.title = "Next page";
    this.btnNextPage.addEventListener("click", () => {
      this.goToPage(this.computeCurrentPage() + 1);
    });

    pageNav.append(this.btnPrevPage, this.pageInput, this.pageTotalEl, this.btnNextPage);

    const spacer = document.createElement("div");
    spacer.className = "csv-toolbar-spacer";

    const zoomGroup = document.createElement("div");
    zoomGroup.className = "latex-pdf-zoom-group";

    this.btnZoomOut = document.createElement("button");
    this.btnZoomOut.type = "button";
    this.btnZoomOut.className = "latex-small-btn";
    this.btnZoomOut.textContent = "−";
    this.btnZoomOut.title = "Zoom out";
    this.btnZoomOut.addEventListener("click", () => {
      void this.setZoom(clampScale(this.scale - 0.15));
    });

    this.zoomLabel = document.createElement("button");
    this.zoomLabel.type = "button";
    this.zoomLabel.className = "latex-pdf-zoom-btn";
    this.zoomLabel.textContent = "100%";
    this.zoomLabel.title = "Reset zoom (100%)";
    this.zoomLabel.addEventListener("click", () => {
      void this.setZoom(DEFAULT_PDF_SCALE);
    });

    this.btnZoomIn = document.createElement("button");
    this.btnZoomIn.type = "button";
    this.btnZoomIn.className = "latex-small-btn";
    this.btnZoomIn.textContent = "+";
    this.btnZoomIn.title = "Zoom in";
    this.btnZoomIn.addEventListener("click", () => {
      void this.setZoom(clampScale(this.scale + 0.15));
    });

    zoomGroup.append(this.btnZoomOut, this.zoomLabel, this.btnZoomIn);

    this.btnReload = document.createElement("button");
    this.btnReload.type = "button";
    this.btnReload.className = "latex-small-btn";
    this.btnReload.textContent = "↻ Reload";
    this.btnReload.title = "Reload PDF from disk";
    this.btnReload.addEventListener("click", () => {
      if (this.currentFilePath) {
        this.saveCurrentPosition();
        void this.load(this.currentFilePath, { forceReload: true });
      }
    });

    this.toolbar.append(
      this.titleEl,
      this.metaEl,
      pageNav,
      spacer,
      zoomGroup,
      this.btnReload,
    );

    this.scrollEl = document.createElement("div");
    this.scrollEl.className = "pdf-view-scroll";
    this.scrollEl.tabIndex = 0;
    this.scrollEl.hidden = true;
    this.scrollEl.addEventListener("scroll", () => {
      if (this.isRestoring || !this.currentFilePath || this.numPages === 0) return;
      this.updatePageIndicator();
      window.clearTimeout(this.scrollSaveTimer);
      this.scrollSaveTimer = window.setTimeout(() => {
        this.saveCurrentPosition();
      }, 150);
    });

    this.statusEl = document.createElement("div");
    this.statusEl.className = "pdf-view-status";
    this.statusEl.textContent = "Open a PDF file to view it here.";

    this.opts.container.append(this.toolbar, this.scrollEl, this.statusEl);
    this.updateZoomLabel();
  }

  public getCurrentFilePath(): string | null {
    return this.currentFilePath;
  }

  public focus(): void {
    this.scrollEl.focus();
  }

  public saveCurrentPosition(): void {
    window.clearTimeout(this.scrollSaveTimer);
    if (!this.currentFilePath || this.isRestoring || this.numPages === 0) return;
    savePdfPosition(this.currentFilePath, {
      scrollTop: this.scrollEl.scrollTop,
      scrollLeft: this.scrollEl.scrollLeft,
      scale: this.scale,
      page: this.computeCurrentPage(),
    });
  }

  public async load(
    filePath: string | null,
    opts?: { forceReload?: boolean },
  ): Promise<void> {
    if (this.currentFilePath && this.currentFilePath !== filePath) {
      this.saveCurrentPosition();
    }

    if (!filePath) {
      this.renderSeq++;
      this.currentFilePath = null;
      this.lastPdfBytes = null;
      this.numPages = 0;
      this.scrollEl.innerHTML = "";
      this.scrollEl.hidden = true;
      this.statusEl.hidden = false;
      this.statusEl.textContent = "No PDF file selected.";
      this.titleEl.textContent = "📕 PDF";
      this.metaEl.textContent = "";
      this.pageTotalEl.textContent = "/ 0";
      return;
    }

    if (
      !opts?.forceReload &&
      this.currentFilePath === filePath &&
      this.lastPdfBytes &&
      this.numPages > 0
    ) {
      return;
    }

    const seq = ++this.renderSeq;
    this.isRestoring = true;
    this.currentFilePath = filePath;
    this.numPages = 0;

    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    this.titleEl.textContent = `📕 ${fileName}`;
    this.metaEl.textContent = "Loading…";
    this.scrollEl.innerHTML = "";
    this.scrollEl.hidden = true;
    this.statusEl.hidden = false;
    this.statusEl.textContent = "Loading PDF…";

    const saved = loadSavedPdfPosition(filePath);
    this.scale = saved ? clampScale(saved.scale) : DEFAULT_PDF_SCALE;
    this.updateZoomLabel();

    try {
      const rawBytes = await this.opts.readBinaryFile(filePath);
      if (seq !== this.renderSeq) return;
      const u8 = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
      this.lastPdfBytes = u8;

      await this.renderBytes(u8, seq, {
        scrollTop: saved?.scrollTop ?? 0,
        scrollLeft: saved?.scrollLeft ?? 0,
        page: saved?.page ?? 1,
      });
    } catch (err) {
      if (seq !== this.renderSeq) return;
      this.isRestoring = false;
      this.scrollEl.hidden = true;
      this.statusEl.hidden = false;
      this.statusEl.textContent = `Cannot load PDF: ${String(err)}`;
      this.metaEl.textContent = "Error";
      this.opts.setStatus?.(`Cannot open PDF ${fileName}: ${String(err)}`);
    }
  }

  public async setZoom(nextScale: number): Promise<void> {
    const clamped = clampScale(nextScale);
    if (clamped === this.scale) return;

    const prevScrollHeight = this.scrollEl.scrollHeight;
    const prevScrollWidth = this.scrollEl.scrollWidth;
    const ratioY = prevScrollHeight > 0 ? this.scrollEl.scrollTop / prevScrollHeight : 0;
    const ratioX = prevScrollWidth > 0 ? this.scrollEl.scrollLeft / prevScrollWidth : 0;

    this.scale = clamped;
    this.updateZoomLabel();

    if (!this.lastPdfBytes || !this.currentFilePath) return;

    const seq = ++this.renderSeq;
    this.isRestoring = true;
    await this.renderBytes(this.lastPdfBytes, seq, {
      ratioY,
      ratioX,
    });
    if (seq === this.renderSeq) {
      this.saveCurrentPosition();
    }
  }

  public goToPage(pageNum: number): void {
    if (this.numPages <= 0) return;
    const targetPage = Math.min(this.numPages, Math.max(1, Math.floor(pageNum)));
    const wraps = this.scrollEl.querySelectorAll<HTMLDivElement>(".pdf-view-page-wrap");
    const targetWrap = wraps[targetPage - 1];
    if (targetWrap) {
      this.scrollEl.scrollTop = Math.max(0, targetWrap.offsetTop - 12);
    }
    this.pageInput.value = String(targetPage);
    this.updateNavButtons(targetPage);
    this.saveCurrentPosition();
  }

  public destroy(): void {
    this.saveCurrentPosition();
    this.renderSeq++;
  }

  private updateZoomLabel(): void {
    const pct = Math.round((this.scale / DEFAULT_PDF_SCALE) * 100);
    this.zoomLabel.textContent = `${pct}%`;
  }

  private computeCurrentPage(): number {
    if (this.numPages <= 1) return 1;
    const wraps = this.scrollEl.querySelectorAll<HTMLDivElement>(".pdf-view-page-wrap");
    if (wraps.length === 0) return 1;
    const scrollMid = this.scrollEl.scrollTop + this.scrollEl.clientHeight * 0.25;
    let current = 1;
    for (let i = 0; i < wraps.length; i++) {
      if (wraps[i].offsetTop <= scrollMid) {
        current = i + 1;
      } else {
        break;
      }
    }
    return current;
  }

  private updatePageIndicator(): void {
    const page = this.computeCurrentPage();
    if (document.activeElement !== this.pageInput) {
      this.pageInput.value = String(page);
    }
    this.updateNavButtons(page);
  }

  private updateNavButtons(page: number): void {
    this.btnPrevPage.disabled = page <= 1;
    this.btnNextPage.disabled = page >= this.numPages;
  }

  private async renderBytes(
    bytes: Uint8Array,
    seq: number,
    restore: {
      scrollTop?: number;
      scrollLeft?: number;
      page?: number;
      ratioY?: number;
      ratioX?: number;
    },
  ): Promise<void> {
    const dataCopy = bytes.slice();
    const loadingTask = pdfjsLib.getDocument({ data: dataCopy });
    const pdfDoc = await loadingTask.promise;
    if (seq !== this.renderSeq) {
      void loadingTask.destroy();
      return;
    }

    const numPages = pdfDoc.numPages;
    this.numPages = numPages;
    this.pageInput.max = String(Math.max(1, numPages));
    this.pageTotalEl.textContent = `/ ${numPages}`;
    this.metaEl.textContent = `${numPages} ${numPages === 1 ? "page" : "pages"}`;

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const existingWraps = Array.from(
      this.scrollEl.querySelectorAll<HTMLDivElement>(".pdf-view-page-wrap"),
    );

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      if (seq !== this.renderSeq) {
        void loadingTask.destroy();
        return;
      }
      const viewport = page.getViewport({ scale: this.scale });
      const cssWidth = Math.floor(viewport.width);
      const cssHeight = Math.floor(viewport.height);

      const offCanvas = document.createElement("canvas");
      offCanvas.className = "pdf-view-canvas";
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

      if (seq !== this.renderSeq) {
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
        wrap.className = "pdf-view-page-wrap";
        wrap.style.width = `${cssWidth}px`;
        wrap.style.height = `${cssHeight}px`;
        wrap.append(offCanvas);
        this.scrollEl.append(wrap);
      }
    }

    while (this.scrollEl.children.length > numPages) {
      this.scrollEl.lastElementChild?.remove();
    }

    this.scrollEl.hidden = false;
    this.statusEl.hidden = true;

    if (typeof restore.ratioY === "number") {
      this.scrollEl.scrollTop = Math.round(restore.ratioY * this.scrollEl.scrollHeight);
      this.scrollEl.scrollLeft = Math.round((restore.ratioX ?? 0) * this.scrollEl.scrollWidth);
    } else if (typeof restore.scrollTop === "number" && restore.scrollTop > 0) {
      this.scrollEl.scrollTop = restore.scrollTop;
      this.scrollEl.scrollLeft = restore.scrollLeft ?? 0;
    } else if (typeof restore.page === "number" && restore.page > 1) {
      const wraps = this.scrollEl.querySelectorAll<HTMLDivElement>(".pdf-view-page-wrap");
      const targetWrap = wraps[Math.min(numPages, restore.page) - 1];
      this.scrollEl.scrollTop = targetWrap ? Math.max(0, targetWrap.offsetTop - 12) : 0;
      this.scrollEl.scrollLeft = restore.scrollLeft ?? 0;
    } else {
      this.scrollEl.scrollTop = 0;
      this.scrollEl.scrollLeft = 0;
    }

    this.isRestoring = false;
    this.updatePageIndicator();
    void loadingTask.destroy();
  }
}
