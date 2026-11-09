// Print window with a live preview. Windows' own print dialog can't preview or
// scale an app's pages, so Orihada lays out each printed sheet itself (paper,
// orientation, scale), shows exactly that, and sends it to the printer.
import { $, h, iconEl, modal, toast } from "./ui.js";
import { loadingTask } from "./viewer.js";
import { parseRanges } from "./pages.js";
import { prefs } from "./store.js";

// Paper sizes in points (1/72 in).
export const PAPERS = {
  Letter: { label: "Letter (8.5 × 11 in)", w: 612, h: 792 },
  Legal: { label: "Legal (8.5 × 14 in)", w: 612, h: 1008 },
  Tabloid: { label: "Tabloid (11 × 17 in)", w: 792, h: 1224 },
  A4: { label: "A4 (210 × 297 mm)", w: 595.28, h: 841.89 },
  A5: { label: "A5 (148 × 210 mm)", w: 419.53, h: 595.28 },
  A3: { label: "A3 (297 × 420 mm)", w: 841.89, h: 1190.55 },
};
const FIT_MARGIN = 18; // 0.25 in keeps "Fit" output clear of printers' unprintable edge
const PRINT_DPI = 200;
const MAX_PRINT_PX = 3400;

const defaultPaper = () => (/^en-(US|CA)|-(MX|PH)$/i.test(navigator.language) ? "Letter" : "A4");

/** True when the sheet should be landscape for this page under the settings. */
function sheetIsLandscape(firstPage, s) {
  if (s.orientation === "landscape") return true;
  if (s.orientation === "portrait") return false;
  return firstPage.w > firstPage.h;
}

/**
 * Where a page lands on a sheet. All values in points.
 * page = displayed page size {w, h}; returns {sheet:{w,h}, rotate, k, x, y, w, h}.
 */
export function layoutSheet(page, s, landscape) {
  const paper = PAPERS[s.paper];
  const sheet = landscape ? { w: paper.h, h: paper.w } : { w: paper.w, h: paper.h };
  let pw = page.w, ph = page.h, rotate = false;
  // In Auto, turn pages whose orientation doesn't match the sheet (like Acrobat's auto-rotate).
  if (s.orientation === "auto" && pw !== ph && (pw > ph) !== (sheet.w > sheet.h)) { rotate = true; [pw, ph] = [ph, pw]; }
  const fit = Math.min((sheet.w - 2 * FIT_MARGIN) / pw, (sheet.h - 2 * FIT_MARGIN) / ph);
  const k = s.scale === "fit" ? fit : s.scale === "shrink" ? Math.min(1, fit) : s.scale === "actual" ? 1 : Math.max(0.1, s.customPct / 100);
  const w = pw * k, hh = ph * k;
  return { sheet, rotate, k, x: (sheet.w - w) / 2, y: (sheet.h - hh) / 2, w, h: hh };
}

function loadSettings() {
  return {
    printer: prefs.get("print.printer", null),
    copies: 1,
    range: "all",
    custom: "",
    scale: prefs.get("print.scale", "fit"),
    customPct: prefs.get("print.customPct", 100),
    paper: prefs.get("print.paper", defaultPaper()),
    orientation: prefs.get("print.orientation", "auto"),
    color: prefs.get("print.color", true),
    duplex: prefs.get("print.duplex", "simplex"),
  };
}

function saveSettings(s) {
  for (const k of ["printer", "scale", "customPct", "paper", "orientation", "color", "duplex"]) prefs.set(`print.${k}`, s[k]);
}

/** Renders one page into a canvas laid out for print/preview. */
async function renderPage(page, lay, scale, color) {
  const rotation = (page.rotate + (lay.rotate ? 90 : 0)) % 360;
  const vp = page.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp, intent: "print" }).promise;
  if (!color) {
    const gray = document.createElement("canvas");
    gray.width = canvas.width; gray.height = canvas.height;
    const g = gray.getContext("2d");
    g.filter = "grayscale(1)";
    g.drawImage(canvas, 0, 0);
    return gray;
  }
  return canvas;
}

/**
 * Opens the print window.
 * @param {object} o
 * @param {Uint8Array} o.bytes    the finished PDF (edits included)
 * @param {number} o.currentPage  1-based
 * @param {object} o.native       { getPrinters(), print(opts) } — desktop bridge or browser stand-in
 */
export async function openPrintWindow({ bytes, currentPage, native }) {
  const doc = await loadingTask(bytes).promise;
  const n = doc.numPages;
  const s = loadSettings();
  const printers = (await native.getPrinters().catch(() => [])) || [];
  if (!printers.find((p) => p.name === s.printer)) s.printer = (printers.find((p) => p.isDefault) || printers[0])?.name || null;

  const sizes = new Map(); // pageIndex -> {w, h} as displayed
  const pageSize = async (i) => {
    if (!sizes.has(i)) {
      const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
      sizes.set(i, { w: vp.width, h: vp.height });
    }
    return sizes.get(i);
  };
  const selected = () => {
    if (s.range === "current") return [currentPage - 1];
    if (s.range === "custom") return parseRanges(s.custom, n) || [];
    return Array.from({ length: n }, (_, i) => i);
  };

  // ---------- UI ----------
  const sel = (options, value, onChange, label) => {
    const el = h("select", { class: "select-sm pw-select", "aria-label": label }, options.map(([v, t]) => h("option", { value: v, selected: v === value }, t)));
    el.addEventListener("change", () => onChange(el.value));
    return el;
  };
  const seg = (options, value, onChange, label) => {
    const wrap = h("div", { class: "pw-seg", role: "radiogroup", "aria-label": label });
    for (const [v, t] of options) {
      const b = h("button", { class: v === value ? "on" : "", role: "radio", "aria-checked": v === value ? "true" : "false" }, t);
      b.addEventListener("click", () => { onChange(v); [...wrap.children].forEach((c) => { c.classList.toggle("on", c === b); c.setAttribute("aria-checked", c === b ? "true" : "false"); }); });
      wrap.append(b);
    }
    return wrap;
  };
  const row = (label, ...controls) => h("div", { class: "pw-row" }, h("div", { class: "pw-label" }, label), h("div", { class: "pw-ctl" }, ...controls));

  const sheetEl = h("div", { class: "pw-sheet" });
  const stage = h("div", { class: "pw-stage" }, sheetEl);
  const navText = h("span", { class: "pw-navtext" });
  const prevBtn = h("button", { class: "icon-btn", title: "Previous sheet" }, iconEl("chevron-left", 18));
  const nextBtn = h("button", { class: "icon-btn", title: "Next sheet" }, iconEl("chevron-right", 18));
  const preview = h("div", { class: "pw-preview" }, stage, h("div", { class: "pw-nav" }, prevBtn, navText, nextBtn));

  const rangeIn = h("input", { class: "text-input pw-range", placeholder: "e.g. 1-3, 5", value: s.custom, "aria-label": "Pages to print" });
  const rangeErr = h("div", { class: "field-error" });
  const pctIn = h("input", { class: "text-input pw-pct", type: "number", min: "10", max: "400", step: "5", value: s.customPct, "aria-label": "Scale percent" });
  const pctWrap = h("span", { class: "pw-pctwrap" }, pctIn, "%");
  const copiesIn = h("input", { class: "text-input pw-copies", type: "number", min: "1", max: "99", value: "1", "aria-label": "Copies" });

  const printerCtl = native.isBrowser ? h("span", { class: "muted" }, "Chosen in the next step")
    : !printers.length ? h("span", { class: "muted" }, "No printers found")
    : sel(printers.map((p) => [p.name, `${p.displayName}${p.isDefault ? " (default)" : ""}`]), s.printer, (v) => { s.printer = v; }, "Printer");

  const scaleSel = sel([["fit", "Fit to paper"], ["shrink", "Shrink oversized pages"], ["actual", "Actual size (100%)"], ["custom", "Custom"]], s.scale,
    (v) => { s.scale = v; pctWrap.hidden = v !== "custom"; update(); }, "Scale");
  pctWrap.hidden = s.scale !== "custom";

  const settings = h("div", { class: "pw-settings" },
    row("Printer", printerCtl),
    row("Copies", copiesIn),
    row("Pages", sel([["all", `All pages (${n})`], ["current", `Current page (${currentPage})`], ["custom", "Custom range…"]], s.range, (v) => { s.range = v; rangeIn.hidden = v !== "custom"; sheetIdx = 0; update(); if (v === "custom") rangeIn.focus(); }, "Pages"), rangeIn, rangeErr),
    row("Scale", scaleSel, pctWrap),
    row("Paper", sel(Object.entries(PAPERS).map(([k, p]) => [k, p.label]), s.paper, (v) => { s.paper = v; update(); }, "Paper size")),
    row("Orientation", seg([["auto", "Auto"], ["portrait", "Portrait"], ["landscape", "Landscape"]], s.orientation, (v) => { s.orientation = v; update(); }, "Orientation")),
    row("Color", seg([[true, "Color"], [false, "Black & white"]].map(([v, t]) => [String(v), t]), String(s.color), (v) => { s.color = v === "true"; update(); }, "Color")),
    row("Two-sided", sel([["simplex", "Off"], ["longEdge", "Flip on long edge"], ["shortEdge", "Flip on short edge"]], s.duplex, (v) => { s.duplex = v; }, "Two-sided")),
  );
  rangeIn.hidden = s.range !== "custom";
  const systemLink = h("button", { class: "linklike" }, "More printer settings (Windows dialog)…");
  if (native.isBrowser) systemLink.hidden = true;
  settings.append(systemLink);

  const body = h("div", { class: "pw" }, preview, settings);
  let sheetIdx = 0;
  let closed = false;
  let printing = false;
  const printBtnId = `pw-print-${Date.now()}`;
  const m = modal({
    title: "Print",
    body,
    width: 1000,
    onClose: () => { closed = true; if (!printing) doc.loadingTask.destroy(); },
    actions: [
      { label: "Cancel", onClick: (api) => api.close() },
      { label: "Print", primary: true, id: printBtnId, onClick: () => go(false) },
    ],
  });
  const printBtn = m.el.querySelector(`#${printBtnId}`);

  // ---------- preview ----------
  const previewCache = new Map(); // `${i}|${rotate}|${color}` -> canvas
  let renderToken = 0;
  async function update() {
    const token = ++renderToken;
    const pages = selected();
    const valid = pages.length > 0;
    rangeErr.textContent = s.range === "custom" && !valid && s.custom.trim() ? `Enter pages between 1 and ${n}, like 1-3, 5` : "";
    const copies = Math.max(1, Math.min(99, parseInt(copiesIn.value, 10) || 1));
    printBtn.disabled = !valid;
    printBtn.textContent = valid ? `Print ${pages.length} page${pages.length === 1 ? "" : "s"}${copies > 1 ? ` × ${copies}` : ""}` : "Print";
    if (!valid) { sheetEl.replaceChildren(); navText.textContent = "No pages selected"; prevBtn.disabled = nextBtn.disabled = true; return; }
    sheetIdx = Math.max(0, Math.min(sheetIdx, pages.length - 1));
    navText.textContent = `Page ${sheetIdx + 1} of ${pages.length}`;
    prevBtn.disabled = sheetIdx === 0;
    nextBtn.disabled = sheetIdx >= pages.length - 1;
    const landscape = sheetIsLandscape(await pageSize(pages[0]), s);
    const idx = pages[sheetIdx];
    const lay = layoutSheet(await pageSize(idx), s, landscape);
    if (token !== renderToken) return;
    // Fit the sheet into the preview area.
    const availW = stage.clientWidth - 40, availH = stage.clientHeight - 40;
    const z = Math.min(availW / lay.sheet.w, availH / lay.sheet.h);
    Object.assign(sheetEl.style, { width: `${lay.sheet.w * z}px`, height: `${lay.sheet.h * z}px` });
    const key = `${idx}|${lay.rotate}|${s.color}`;
    let canvas = previewCache.get(key);
    if (!canvas) {
      sheetEl.classList.add("loading");
      const page = await doc.getPage(idx + 1);
      const ps = await pageSize(idx);
      canvas = await renderPage(page, lay, Math.min(3, 1100 / Math.max(ps.w, ps.h)), s.color);
      previewCache.set(key, canvas);
      if (token !== renderToken || closed) return;
    }
    sheetEl.classList.remove("loading");
    Object.assign(canvas.style, { left: `${lay.x * z}px`, top: `${lay.y * z}px`, width: `${lay.w * z}px`, height: `${lay.h * z}px` });
    sheetEl.replaceChildren(canvas);
  }

  prevBtn.addEventListener("click", () => { sheetIdx--; update(); });
  nextBtn.addEventListener("click", () => { sheetIdx++; update(); });
  rangeIn.addEventListener("input", () => { s.custom = rangeIn.value; sheetIdx = 0; update(); });
  pctIn.addEventListener("input", () => { s.customPct = Math.max(10, Math.min(400, +pctIn.value || 100)); update(); });
  copiesIn.addEventListener("input", () => update());
  systemLink.addEventListener("click", () => go(true));
  stage.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) < 20) return;
    e.preventDefault();
    sheetIdx += e.deltaY > 0 ? 1 : -1;
    update();
  }, { passive: false });
  m.el.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowRight" || e.key === "PageDown") { sheetIdx++; update(); }
    if (e.key === "ArrowLeft" || e.key === "PageUp") { sheetIdx--; update(); }
  });
  setTimeout(update, 0); // after the dialog is laid out (rAF would stall in a background window)
  printBtn.focus();

  // ---------- print ----------
  async function go(useSystemDialog) {
    const pages = selected();
    if (!pages.length) return;
    s.copies = Math.max(1, Math.min(99, parseInt(copiesIn.value, 10) || 1));
    saveSettings(s);
    printing = true;
    m.close();
    let cancelled = false;
    const t = toast("Preparing pages for the printer…", { action: "Cancel", onAction: () => { cancelled = true; }, timeout: 600000 });
    let sheets = null;
    try {
      sheets = await buildPrintSheets(doc, pages, s, {
        isCancelled: () => cancelled,
        onProgress: (done) => { t.firstChild.textContent = `Preparing pages for the printer… ${done} of ${pages.length}`; },
      });
      if (cancelled) return;
      const { landscape } = sheets;
      t.firstChild.textContent = "Sending to the printer…";
      const res = await native.print({
        silent: !useSystemDialog,
        deviceName: s.printer && s.printer !== "__browser__" ? s.printer : undefined,
        copies: s.copies,
        color: s.color,
        landscape,
        pageSize: s.paper,
        duplexMode: s.duplex,
      });
      const name = printers.find((p) => p.name === s.printer)?.displayName;
      if (res?.ok) { if (!native.isBrowser) toast(`Sent ${pages.length} page${pages.length === 1 ? "" : "s"} to ${name || "the printer"}`); }
      else if (res && res.reason !== "cancelled") toast(`Printing failed${res.reason ? `: ${res.reason}` : ""}. Try “More printer settings”.`, { timeout: 7000 });
    } catch (e) {
      console.error(e);
      toast(`Couldn't print: ${e.message || e}`);
    } finally {
      t.remove();
      sheets?.cleanup();
      doc.loadingTask.destroy();
    }
  }
}

/**
 * Fills #print-container with one sheet per page, laid out exactly like the preview,
 * for the next print call. Returns { landscape, cleanup }.
 */
export async function buildPrintSheets(doc, pages, s, { isCancelled, onProgress } = {}) {
  const container = $("#print-container");
  container.replaceChildren();
  const urls = [];
  const cleanup = () => { container.replaceChildren(); urls.forEach((u) => URL.revokeObjectURL(u)); };
  const sizeOf = async (i) => {
    const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
    return { w: vp.width, h: vp.height };
  };
  const landscape = sheetIsLandscape(await sizeOf(pages[0]), s);
  const paper = PAPERS[s.paper];
  const sheet = landscape ? { w: paper.h, h: paper.w } : { w: paper.w, h: paper.h };
  container.append(h("style", {}, `@page { size: ${sheet.w}pt ${sheet.h}pt; margin: 0; }`));
  // A hair shorter than the paper so rounding never spills onto an extra blank page.
  const sheets = pages.map(() => h("div", { class: "print-sheet", style: { width: `${sheet.w}pt`, height: `${sheet.h - 0.5}pt` } }));
  container.append(...sheets);
  let next = 0, done = 0;
  // A few pages in flight at once overlaps parsing (worker) with drawing (main thread).
  const worker = async () => {
    while (next < pages.length && !isCancelled?.()) {
      const k = next++;
      const lay = layoutSheet(await sizeOf(pages[k]), s, landscape);
      const page = await doc.getPage(pages[k] + 1);
      const scale = Math.min(lay.k * (PRINT_DPI / 72), (MAX_PRINT_PX / Math.max(lay.w, lay.h)) * lay.k);
      const canvas = await renderPage(page, lay, scale, s.color);
      const url = URL.createObjectURL(await new Promise((r) => canvas.toBlob(r)));
      urls.push(url);
      sheets[k].append(h("img", { src: url, alt: "", style: { left: `${lay.x}pt`, top: `${lay.y}pt`, width: `${lay.w}pt`, height: `${lay.h}pt` } }));
      page.cleanup();
      onProgress?.(++done);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await Promise.all([...container.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
  return { landscape, cleanup };
}

/** Browser stand-in for the desktop print bridge: the browser's own dialog picks the printer. */
export const browserPrint = {
  isBrowser: true,
  getPrinters: async () => [{ name: "__browser__", displayName: "Browser print dialog", isDefault: true }],
  print: () => new Promise((resolve) => {
    const done = () => { removeEventListener("afterprint", done); resolve({ ok: true }); };
    addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1000 * 60 * 10);
  }),
};
