// Wraps pdf.js's PDFViewer component: loading, navigation, zoom and search.
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

const { PDFViewer, EventBus, PDFLinkService, PDFFindController, PDFPageView, LinkTarget } =
  await import("../vendor/pdfjs/pdf_viewer.mjs");

const vendorUrl = (p) => new URL(`../vendor/pdfjs/${p}`, import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = vendorUrl("pdf.worker.min.mjs");

export { pdfjsLib };

export function loadingTask(bytes, extra = {}) {
  return pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: vendorUrl("cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: vendorUrl("standard_fonts/"),
    wasmUrl: vendorUrl("wasm/"),
    iccUrl: vendorUrl("iccs/"),
    isEvalSupported: false,
    enableXfa: true,
    ...extra,
  });
}

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export class Viewer {
  constructor({ container, viewer, onPageView }) {
    this.container = container;
    this.eventBus = new EventBus();
    this.linkService = new PDFLinkService({ eventBus: this.eventBus, externalLinkTarget: LinkTarget.BLANK });
    this.findController = new PDFFindController({ eventBus: this.eventBus, linkService: this.linkService });
    this.pdfViewer = new PDFViewer({
      container,
      viewer,
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      maxCanvasPixels: 2 ** 25,
      imageResourcesPath: vendorUrl("images/"),
    });
    this.linkService.setViewer(this.pdfViewer);
    this.pdfDocument = null;
    this.baseViewports = [];

    // pdf.js clears unknown children from a page on re-render; re-attach our layer.
    const hook = onPageView;
    const origReset = PDFPageView.prototype.reset;
    PDFPageView.prototype.reset = function (...args) {
      origReset.apply(this, args);
      hook?.(this);
    };
    this.eventBus.on("pagerendered", ({ source }) => hook?.(source));
  }

  on(name, fn) { this.eventBus.on(name, fn); }

  /**
   * Parses a document without showing it.
   * onPassword(reason) should resolve to a password string, or null to cancel;
   * the password used ends up in `lastPassword`.
   */
  async load(bytes, { onPassword, password } = {}) {
    this.lastPassword = password || null;
    const task = loadingTask(bytes, password ? { password } : {});
    if (onPassword) {
      task.onPassword = async (update, reason) => {
        const pw = await onPassword(reason);
        if (pw == null) task.destroy(); else { this.lastPassword = pw; update(pw); }
      };
    }
    return task.promise;
  }

  /**
   * Shows a loaded document in place of the current one. The previous document
   * stays alive (it may belong to another tab); its owner destroys it.
   */
  show(doc) {
    this.detach();
    this.pdfDocument = doc;
    this.baseViewports = new Array(doc.numPages);
    this.pdfViewer.setDocument(doc);
    this.linkService.setDocument(doc, null);
    this.findController.setDocument?.(doc);
    return doc;
  }

  /** Stops showing the current document without destroying it. */
  detach() {
    if (!this.pdfDocument) return;
    this.pdfDocument = null;
    this.pdfViewer.setDocument(null);
    this.linkService.setDocument(null, null);
  }

  get pagesCount() { return this.pdfViewer.pagesCount; }
  get currentPage() { return this.pdfViewer.currentPageNumber; }
  set currentPage(n) {
    const c = Math.max(1, Math.min(this.pagesCount, n | 0));
    this.pdfViewer.currentPageNumber = c;
  }
  get scale() { return this.pdfViewer.currentScale; }
  get scaleValue() { return this.pdfViewer.currentScaleValue; }
  set scaleValue(v) { this.pdfViewer.currentScaleValue = v; }

  zoom(dir) {
    const cur = this.pdfViewer.currentScale;
    let next;
    if (dir > 0) next = ZOOM_STEPS.find((s) => s > cur + 0.001) ?? ZOOM_STEPS.at(-1);
    else next = [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.001) ?? ZOOM_STEPS[0];
    this.pdfViewer.currentScaleValue = String(next);
  }

  /** Zoom by a continuous factor, keeping the point under the cursor fixed. */
  zoomAt(factor, clientX, clientY) {
    const v = this.pdfViewer;
    const old = v.currentScale;
    const next = Math.max(0.25, Math.min(5, old * factor));
    if (Math.abs(next - old) < 0.001) return;
    const rect = this.container.getBoundingClientRect();
    const ox = clientX - rect.left + this.container.scrollLeft;
    const oy = clientY - rect.top + this.container.scrollTop;
    v.currentScale = next;
    const k = next / old;
    this.container.scrollLeft = ox * k - (clientX - rect.left);
    this.container.scrollTop = oy * k - (clientY - rect.top);
  }

  getPageView(index) { return this.pdfViewer.getPageView(index); }

  /** Viewport at scale 1 with the page's own rotation, cached. */
  async baseViewport(index) {
    if (!this.baseViewports[index]) {
      const page = await this.pdfDocument.getPage(index + 1);
      this.baseViewports[index] = page.getViewport({ scale: 1 });
    }
    return this.baseViewports[index];
  }

  /** Synchronous variant when the page view already has its pdfPage. */
  baseViewportSync(index) {
    if (this.baseViewports[index]) return this.baseViewports[index];
    const pv = this.getPageView(index);
    if (pv?.pdfPage) this.baseViewports[index] = pv.pdfPage.getViewport({ scale: 1 });
    return this.baseViewports[index] || null;
  }

  find(query, { again = false, previous = false } = {}) {
    this.eventBus.dispatch("find", {
      source: this, type: again ? "again" : "", query, caseSensitive: false, entireWord: false,
      highlightAll: true, findPrevious: previous, matchDiacritics: false,
    });
  }

  clearFind() {
    this.eventBus.dispatch("findbarclose", { source: this });
  }

  async goToDest(dest) {
    await this.linkService.goToDestination(dest);
  }

  async destPageNumber(dest) {
    try {
      const explicit = typeof dest === "string" ? await this.pdfDocument.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return null;
      const ref = explicit[0];
      if (typeof ref === "object" && ref) return (await this.pdfDocument.getPageIndex(ref)) + 1;
      if (Number.isInteger(ref)) return ref + 1;
    } catch { /* bad destination */ }
    return null;
  }
}
