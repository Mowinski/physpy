// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDocumentMock = vi.fn();

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (...args: unknown[]) => getDocumentMock(...args),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "mock-worker.js",
}));

import {
  DEFAULT_PDF_SCALE,
  PDF_POSITIONS_STORAGE_KEY,
  PdfViewerController,
  loadSavedPdfPosition,
  savePdfPosition,
} from "../src/pdfViewer";

function makeMockPdfDoc(numPages: number) {
  return {
    promise: Promise.resolve({
      numPages,
      getPage: vi.fn(async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: () => ({ promise: Promise.resolve() }),
      })),
    }),
    destroy: vi.fn(async () => {}),
  };
}

describe("PdfViewerController & Reading Position Persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    getDocumentMock.mockReset();
    getDocumentMock.mockImplementation(() => makeMockPdfDoc(3));
  });

  it("saves and loads reading position per file path", () => {
    savePdfPosition("/docs/physics.pdf", {
      scrollTop: 420,
      scrollLeft: 15,
      scale: 1.45,
      page: 2,
    });

    const loaded = loadSavedPdfPosition("/docs/physics.pdf");
    expect(loaded).not.toBeNull();
    expect(loaded?.scrollTop).toBe(420);
    expect(loaded?.scrollLeft).toBe(15);
    expect(loaded?.scale).toBe(1.45);
    expect(loaded?.page).toBe(2);
    expect(loadSavedPdfPosition("/docs/other.pdf")).toBeNull();
  });

  it("clamps invalid scale and negative scroll values when loading", () => {
    localStorage.setItem(
      PDF_POSITIONS_STORAGE_KEY,
      JSON.stringify({
        "/docs/broken.pdf": {
          scrollTop: -50,
          scrollLeft: -10,
          scale: 99,
          page: 0,
          updatedAt: 123,
        },
      }),
    );

    const loaded = loadSavedPdfPosition("/docs/broken.pdf");
    expect(loaded).toEqual({
      scrollTop: 0,
      scrollLeft: 0,
      scale: 3.5,
      page: 1,
      updatedAt: 123,
    });
  });

  it("renders PDF pages and restores last scroll position and zoom on reopen", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    const ctrl = new PdfViewerController({
      container,
      readBinaryFile: async () => new Uint8Array([1, 2, 3]),
    });

    await ctrl.load("/workspace/notes.pdf");

    expect(container.querySelector(".pdf-view-title")?.textContent).toBe("📕 notes.pdf");
    expect(container.querySelector(".pdf-view-meta")?.textContent).toBe("3 pages");
    expect(container.querySelectorAll(".pdf-view-page-wrap").length).toBe(3);

    const scrollEl = container.querySelector<HTMLDivElement>(".pdf-view-scroll")!;
    expect(scrollEl.scrollTop).toBe(0);

    // Simulate user zooming in and scrolling down
    await ctrl.setZoom(1.6);
    scrollEl.scrollTop = 780;
    scrollEl.scrollLeft = 24;
    ctrl.saveCurrentPosition();

    // Create a fresh controller (simulating closing & reopening file or app restart)
    const container2 = document.createElement("div");
    document.body.append(container2);
    const ctrl2 = new PdfViewerController({
      container: container2,
      readBinaryFile: async () => new Uint8Array([1, 2, 3]),
    });

    await ctrl2.load("/workspace/notes.pdf");

    const scrollEl2 = container2.querySelector<HTMLDivElement>(".pdf-view-scroll")!;
    expect(scrollEl2.scrollTop).toBe(780);
    expect(scrollEl2.scrollLeft).toBe(24);
    const expectedPct = Math.round((1.6 / DEFAULT_PDF_SCALE) * 100);
    expect(container2.querySelector(".latex-pdf-zoom-btn")?.textContent).toBe(`${expectedPct}%`);

    ctrl.destroy();
    ctrl2.destroy();
    container.remove();
    container2.remove();
  });

  it("remembers independent positions for different PDF files when switching", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    const ctrl = new PdfViewerController({
      container,
      readBinaryFile: async () => new Uint8Array([1, 2, 3]),
    });

    await ctrl.load("/workspace/a.pdf");
    const scrollEl = container.querySelector<HTMLDivElement>(".pdf-view-scroll")!;
    scrollEl.scrollTop = 310;

    // Switching to b.pdf should save a.pdf's position first
    await ctrl.load("/workspace/b.pdf");
    expect(loadSavedPdfPosition("/workspace/a.pdf")?.scrollTop).toBe(310);
    expect(scrollEl.scrollTop).toBe(0);

    scrollEl.scrollTop = 640;

    // Switching back to a.pdf saves b.pdf and restores a.pdf
    await ctrl.load("/workspace/a.pdf");
    expect(loadSavedPdfPosition("/workspace/b.pdf")?.scrollTop).toBe(640);
    expect(scrollEl.scrollTop).toBe(310);

    ctrl.destroy();
    container.remove();
  });
});
