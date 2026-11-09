// The edit layer: user-added text, signatures/images, ink, marks, highlights
// and boxes drawn over each page. Items live in PDF user space so they survive
// zoom and page rotation; on save they are flattened into the page by save.js.
//
// Item geometry: { page, ux, uy, w, h, rot }
//   (ux, uy) = content top-left in PDF user space, w/h in points,
//   rot = page rotation when created (content "up" direction).

import { h } from "./ui.js";

export const MARK_PATHS = {
  check: [[[4, 12.5], [9.5, 18], [20, 6.5]]],
  cross: [[[6, 6], [18, 18]], [[18, 6], [6, 18]]],
};

export const FONTS = {
  sans: { label: "Sans", css: "Arial, Helvetica, 'Liberation Sans', sans-serif", std: "Helvetica" },
  serif: { label: "Serif", css: "'Times New Roman', Times, 'Liberation Serif', serif", std: "TimesRoman" },
  mono: { label: "Mono", css: "'Courier New', Courier, 'Liberation Mono', monospace", std: "Courier" },
};

const uid = () => Math.random().toString(36).slice(2, 10);
const px = (v) => `calc(var(--total-scale-factor, 1) * ${v}px)`;
const FORM_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;

// Baseline offset (fraction of font size) for a 1.2 line-height box, measured from the DOM.
const baselineCache = new Map();
export function baselineRatio(fontKey) {
  if (baselineCache.has(fontKey)) return baselineCache.get(fontKey);
  const probe = h("div", { style: { position: "absolute", visibility: "hidden", font: `100px/1.2 ${FONTS[fontKey].css}`, whiteSpace: "pre" } },
    "Hg", h("span", { style: { display: "inline-block", width: "1px", height: "0px", verticalAlign: "baseline" } }));
  document.body.append(probe);
  const ratio = probe.lastChild.offsetTop / 100;
  probe.remove();
  baselineCache.set(fontKey, ratio || 0.95);
  return baselineCache.get(fontKey);
}

export class Overlay {
  constructor({ viewer, onChange, onSelect, onToolDone, onLayout, onVersion, onFormFieldClick }) {
    this.viewer = viewer;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.onToolDone = onToolDone;
    this.onLayout = onLayout; // selection moved / re-rendered: reposition floating UI
    this.onVersion = onVersion; // undo/redo crossed a page-structure change
    this.onFormFieldClick = onFormFieldClick;
    this.items = [];
    this.assets = new Map(); // id -> { src, w, h, kind }
    this.layers = new Map(); // pageIndex -> layer element
    this.els = new Map(); // itemId -> element
    this.selId = null;
    this.editingId = null;
    this.dragging = false;
    this.tool = "select";
    this.pendingAsset = null;
    this.version = 0; // document structure version (see main.js)
    this.opts = {
      text: { font: "sans", size: 12, color: "#111111" },
      ink: { color: "#1f3a93", width: 2 },
      mark: { color: "#111111", size: 14 },
      highlight: { color: "#ffd84d" },
    };
    this.undoStack = [];
    this.redoStack = [];
    this.lastSnap = this.snapshot();
    this.docPointerUp = (e) => this.onDocPointerUp(e);
    document.addEventListener("pointerup", this.docPointerUp);
  }

  /** Releases global listeners (when the tab owning this layer closes). */
  dispose() {
    document.removeEventListener("pointerup", this.docPointerUp);
    this.layers.clear();
    this.els.clear();
  }

  // ---------- state & history ----------
  snapshot() { return JSON.stringify({ v: this.version, items: this.items }); }

  reset() {
    this.items = [];
    this.assets.clear();
    this.layers.clear();
    this.els.clear();
    this.selId = this.editingId = null;
    this.version = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.lastSnap = this.snapshot();
  }

  /** Replaces items/assets wholesale (draft restore). Not undoable. */
  load(items, assets) {
    this.items = items;
    this.assets = new Map(assets);
    this.lastSnap = this.snapshot();
    this.renderAll();
  }

  /** Called when the document is reloaded (page structure change): forget layers. */
  detachLayers() {
    this.layers.clear();
    this.els.clear();
  }

  commit() {
    const snap = this.snapshot();
    if (snap === this.lastSnap) return;
    this.undoStack.push(this.lastSnap);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.lastSnap = snap;
    this.onChange?.();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  async undo() {
    if (!this.canUndo) return false;
    this.redoStack.push(this.lastSnap);
    await this.restore(this.undoStack.pop());
    return true;
  }

  async redo() {
    if (!this.canRedo) return false;
    this.undoStack.push(this.lastSnap);
    await this.restore(this.redoStack.pop());
    return true;
  }

  async restore(snap) {
    const { v, items } = JSON.parse(snap);
    const pages = new Set(this.items.map((i) => i.page));
    this.items = items;
    this.lastSnap = snap;
    this.editingId = null;
    if (!this.items.find((i) => i.id === this.selId)) this.select(null);
    if (v !== this.version) {
      this.version = v;
      await this.onVersion?.(v); // reloads the document; layers re-attach and render
    } else {
      this.items.forEach((i) => pages.add(i.page));
      pages.forEach((p) => this.renderPage(p));
    }
    this.onChange?.();
  }

  /** After a page-structure change: move items to their new pages, drop deleted ones. */
  remap(map, newVersion) {
    this.items = this.items
      .map((i) => ({ ...i, page: map[i.page] ?? -1 }))
      .filter((i) => i.page >= 0);
    if (!this.items.find((i) => i.id === this.selId)) this.selId = null;
    this.version = newVersion;
    this.commit();
  }

  get count() { return this.items.length; }
  itemById(id) { return this.items.find((i) => i.id === id); }
  get selected() { return this.itemById(this.selId) || null; }

  addAsset(src, w, h, kind = "image") {
    for (const [id, a] of this.assets) if (a.src === src) return id;
    const id = `a${uid()}`;
    this.assets.set(id, { src, w, h, kind });
    return id;
  }

  // ---------- geometry ----------
  vp(page) { return this.viewer.baseViewportSync(page); }
  toDisplay(page, ux, uy) { return this.vp(page).convertToViewportPoint(ux, uy); }
  toUser(page, x, y) { return this.vp(page).convertToPdfPoint(x, y); }

  layerScale(page) {
    const layer = this.layers.get(page);
    const vp = this.vp(page);
    return layer && vp ? layer.clientWidth / vp.width || 1 : 1;
  }

  eventPoint(e, page) {
    const layer = this.layers.get(page);
    const r = layer.getBoundingClientRect();
    const s = this.layerScale(page);
    return [(e.clientX - r.left) / s, (e.clientY - r.top) / s];
  }

  itemTurn(item) {
    return ((this.vp(item.page).rotation - item.rot) % 360 + 360) % 360;
  }

  // ---------- layers ----------
  attach(pageView) {
    const page = pageView.id - 1;
    let layer = this.layers.get(page);
    if (!layer) {
      layer = h("div", { class: "fo-layer", "data-page": page });
      layer.addEventListener("pointerdown", (e) => this.onLayerDown(e, page));
      layer.addEventListener("pointermove", (e) => this.onLayerHover(e, page));
      layer.addEventListener("pointerleave", () => this.hideGhost());
      this.layers.set(page, layer);
    }
    const div = pageView.div;
    if (!div.dataset.foBound) {
      div.dataset.foBound = "1";
      div.addEventListener("pointerdown", (e) => this.onPageDown(e, Number(div.dataset.pageNumber) - 1), true);
    }
    if (layer.parentNode !== div) div.append(layer);
    if (!this.vp(page) && pageView.pdfPage) this.viewer.baseViewportSync(page);
    this.applyToolClass(layer);
    this.renderPage(page);
  }

  applyToolClass(layer) {
    // Highlight lets the text layer receive the drag so people can select words.
    const placing = this.tool !== "select" && this.tool !== "highlight";
    layer.classList.toggle("placing", placing);
    layer.className = layer.className.replace(/\btool-\S+/g, "").trim();
    if (this.tool !== "select") layer.classList.add(`tool-${this.tool}`);
    layer.parentNode?.classList.toggle("fo-highlighting", this.tool === "highlight");
  }

  renderAll() { for (const p of this.layers.keys()) this.renderPage(p); }

  renderPage(page) {
    const layer = this.layers.get(page);
    if (!layer || !this.vp(page)) return;
    const live = new Set();
    for (const item of this.items) {
      if (item.page !== page) continue;
      live.add(item.id);
      let el = this.els.get(item.id);
      if (!el || el.parentNode !== layer) {
        el?.remove();
        el = this.createEl(item);
        this.els.set(item.id, el);
        layer.append(el);
      }
      this.updateEl(item, el);
    }
    for (const el of [...layer.querySelectorAll(".fo-item")]) {
      if (!live.has(el.dataset.id)) { el.remove(); this.els.delete(el.dataset.id); }
    }
    if (this.selected?.page === page) this.onLayout?.();
  }

  createEl(item) {
    const cls = { text: "text", image: "img", rect: "rect", hl: "hl" }[item.type] || "svg";
    const el = h("div", { class: `fo-item fo-${cls}`, "data-id": item.id });
    if (item.type === "text") {
      el.dataset.ph = "Type here";
      el.spellcheck = false;
      el.addEventListener("input", () => { this.measureText(item.id); this.onLayout?.(); });
      el.addEventListener("blur", () => this.finishEditing(item.id));
      el.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); el.blur(); this.select(null); }
      });
    } else if (item.type === "image") {
      el.append(h("img", { alt: "", draggable: "false" }));
    }
    if (item.type !== "hl") el.append(h("div", { class: "fo-h", title: "Drag to resize" }));
    el.addEventListener("pointerdown", (e) => this.onItemDown(e, item.id));
    el.addEventListener("dblclick", (e) => { e.stopPropagation(); if (this.itemById(item.id)?.type === "text") this.editText(item.id); });
    return el;
  }

  updateEl(item, el) {
    const [x, y] = this.toDisplay(item.page, item.ux, item.uy);
    const turn = this.itemTurn(item);
    const st = el.style;
    st.left = px(x);
    st.top = px(y);
    st.transform = turn ? `rotate(${turn}deg)` : "";
    st.transformOrigin = "0 0";
    el.classList.toggle("sel", item.id === this.selId && item.id !== this.editingId);
    if (item.type === "text") {
      st.font = `${px(item.size)}/1.2 ${FONTS[item.font].css}`;
      st.color = item.color;
      st.width = st.height = "";
      if (item.id !== this.editingId && el.textContent !== item.text) {
        el.textContent = item.text;
        el.append(h("div", { class: "fo-h", title: "Drag to resize" }));
      }
      return;
    }
    st.width = px(item.w);
    st.height = px(item.h);
    if (item.type === "image") {
      const img = el.querySelector("img");
      const src = this.assets.get(item.asset)?.src;
      if (img.getAttribute("src") !== src) img.src = src;
    } else if (item.type === "rect") {
      st.background = item.color;
      st.opacity = item.opacity ?? 1;
      st.mixBlendMode = item.blend === "multiply" ? "multiply" : "";
      st.boxShadow = item.kind === "whiteout" ? "0 0 0 0.5px rgba(0,0,0,.18)" : "";
    } else if (item.type === "hl") {
      el.replaceChildren(...item.rects.map(([rx, ry, rw, rh]) => h("div", {
        class: "fo-hl-rect",
        style: { left: px(rx), top: px(ry), width: px(rw), height: px(rh), background: item.color },
      })));
    } else {
      const svg = this.svgFor(item);
      const old = el.querySelector("svg");
      if (old) old.replaceWith(svg); else el.prepend(svg);
    }
  }

  svgFor(item) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${item.vw} ${item.vh}`);
    svg.setAttribute("preserveAspectRatio", "none");
    if (item.type === "mark" && item.mark === "dot") {
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", 12); c.setAttribute("cy", 12); c.setAttribute("r", 6);
      c.setAttribute("fill", item.color);
      svg.append(c);
      return svg;
    }
    const strokes = item.type === "ink" ? item.paths : MARK_PATHS[item.mark] || [];
    for (const pts of strokes) {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", pts.map((pt, i) => `${i ? "L" : "M"}${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`).join(" ") + (pts.length === 1 ? " l0.01 0" : ""));
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", item.color);
      p.setAttribute("stroke-width", item.type === "ink" ? item.width : 2.6);
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      svg.append(p);
    }
    return svg;
  }

  measureText(id) {
    const item = this.itemById(id);
    const el = this.els.get(id);
    if (!item || !el?.isConnected) return;
    const s = this.layerScale(item.page);
    item.w = el.offsetWidth / s;
    item.h = el.offsetHeight / s;
  }

  // ---------- selection ----------
  select(id) {
    if (this.selId === id) return;
    const prev = this.selected;
    this.selId = id;
    if (prev) this.renderPage(prev.page);
    const cur = this.selected;
    if (cur) this.renderPage(cur.page);
    this.onSelect?.(cur);
  }

  deleteSelected() {
    const item = this.selected;
    if (!item) return false;
    this.items = this.items.filter((i) => i !== item);
    this.selId = null;
    this.renderPage(item.page);
    this.commit();
    this.onSelect?.(null);
    return true;
  }

  duplicateSelected() {
    const item = this.selected;
    if (!item) return;
    const copy = { ...structuredClone(item), id: uid() };
    const [x, y] = this.toDisplay(item.page, item.ux, item.uy);
    [copy.ux, copy.uy] = this.toUser(item.page, x + 12, y + 12);
    this.items.push(copy);
    this.renderPage(copy.page);
    this.select(copy.id);
    this.commit();
  }

  nudge(dx, dy) {
    const item = this.selected;
    if (!item) return;
    const [x, y] = this.toDisplay(item.page, item.ux, item.uy);
    [item.ux, item.uy] = this.toUser(item.page, x + dx, y + dy);
    this.renderPage(item.page);
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => this.commit(), 400);
  }

  updateSelected(patch) {
    const item = this.selected;
    if (!item) return;
    Object.assign(item, patch);
    this.renderPage(item.page);
    if (item.type === "text") this.measureText(item.id);
    this.commit();
    this.onLayout?.();
  }

  // ---------- tools ----------
  setTool(tool) {
    if (this.editingId) this.els.get(this.editingId)?.blur();
    this.tool = tool;
    if (tool !== "image") this.pendingAsset = null;
    this.hideGhost();
    for (const layer of this.layers.values()) this.applyToolClass(layer);
    if (tool !== "select") this.select(null);
  }

  armAsset(assetId) {
    this.setTool("image");
    this.pendingAsset = assetId;
  }

  get pendingKind() { return this.assets.get(this.pendingAsset)?.kind || null; }

  hideGhost() { this.ghost?.remove(); this.ghost = null; }

  defaultImageSize(asset) {
    const targetW = { initials: 56, signature: 150, image: 200 }[asset.kind] || 150;
    let w = targetW, hh = w * (asset.h / asset.w);
    const maxH = asset.kind === "image" ? 260 : 60;
    if (hh > maxH) { hh = maxH; w = hh * (asset.w / asset.h); }
    return [w, hh];
  }

  /** Signatures sit with their bottom at the cursor (like signing on a line); images centre. */
  imageOrigin(asset, x, y, w, hh) {
    return asset.kind === "image" ? [x - w / 2, y - hh / 2] : [x - w * 0.12, y - hh * 0.82];
  }

  onLayerHover(e, page) {
    if (this.tool !== "image" || !this.pendingAsset) return;
    const asset = this.assets.get(this.pendingAsset);
    if (!asset) return;
    const [w, hh] = this.defaultImageSize(asset);
    const [x, y] = this.eventPoint(e, page);
    const [ox, oy] = this.imageOrigin(asset, x, y, w, hh);
    const layer = this.layers.get(page);
    if (!this.ghost || this.ghost.parentNode !== layer) {
      this.hideGhost();
      this.ghost = h("img", { class: "fo-ghost", src: asset.src, alt: "" });
      layer.append(this.ghost);
    }
    Object.assign(this.ghost.style, { left: px(ox), top: px(oy), width: px(w), height: px(hh) });
  }

  newItem(page, type, props) {
    return { id: uid(), page, type, rot: this.vp(page).rotation, ...props };
  }

  /** If a fillable form field is under the pointer, hand the click to it. */
  formFieldAt(e) {
    return document.elementsFromPoint(e.clientX, e.clientY)
      .find((el) => FORM_TAGS.test(el.tagName) && el.closest(".annotationLayer"));
  }

  onLayerDown(e, page) {
    if (e.button !== 0 || this.tool === "select") return;
    if (e.target.closest(".fo-item")) return;
    if (["text", "date", "check", "cross"].includes(this.tool)) {
      const field = this.formFieldAt(e);
      if (field) {
        e.preventDefault();
        if (field.type === "checkbox" || field.type === "radio") field.click();
        else field.focus();
        this.onFormFieldClick?.();
        return;
      }
    }
    e.preventDefault();
    if (this.editingId) this.finishEditing(this.editingId);
    const [x, y] = this.eventPoint(e, page);
    const tool = this.tool;

    if (tool === "text" || tool === "date") {
      const o = this.opts.text;
      const text = tool === "date" ? new Date().toLocaleDateString() : "";
      const [ux, uy] = this.toUser(page, x, y - (o.size * 1.2) / 2);
      const item = this.newItem(page, "text", { ux, uy, text, size: o.size, font: o.font, color: o.color, w: 0, h: 0 });
      this.items.push(item);
      this.renderPage(page);
      this.measureText(item.id);
      if (tool === "text") this.editText(item.id);
      else { this.select(item.id); this.commit(); }
      return;
    }
    if (tool === "check" || tool === "cross") {
      const s = this.opts.mark.size;
      const [ux, uy] = this.toUser(page, x - s / 2, y - s / 2);
      this.items.push(this.newItem(page, "mark", { mark: tool, ux, uy, w: s, h: s, vw: 24, vh: 24, color: this.opts.mark.color }));
      this.renderPage(page);
      this.commit();
      return;
    }
    if (tool === "image" && this.pendingAsset) {
      const asset = this.assets.get(this.pendingAsset);
      const [w, hh] = this.defaultImageSize(asset);
      const [ox, oy] = this.imageOrigin(asset, x, y, w, hh);
      const [ux, uy] = this.toUser(page, ox, oy);
      const item = this.newItem(page, "image", { asset: this.pendingAsset, ux, uy, w, h: hh });
      this.items.push(item);
      this.hideGhost();
      this.renderPage(page);
      this.commit();
      this.setTool("select");
      this.select(item.id);
      this.onToolDone?.(asset.kind);
      return;
    }
    if (tool === "draw") return this.startInk(e, page, x, y);
    if (tool === "whiteout") return this.startBox(e, page, x, y, tool);
  }

  /** Capture-phase handler on the page: highlight mode chooses text selection or a box. */
  onPageDown(e, page) {
    if (this.tool !== "highlight" || e.button !== 0) return;
    if (e.target.closest(".fo-item")) return;
    const overText = e.target.closest(".textLayer") && e.target.tagName === "SPAN";
    if (overText) { this.hlSelecting = true; return; } // let the browser select words
    e.preventDefault();
    e.stopPropagation();
    const [x, y] = this.eventPoint(e, page);
    this.startBox(e, page, x, y, "highlight");
  }

  onDocPointerUp() {
    if (!this.hlSelecting) return;
    this.hlSelecting = false;
    // Let the selection settle after the mouse is released.
    setTimeout(() => this.highlightSelection(), 0);
  }

  /** Turns the current text selection into highlight items (one per page). */
  highlightSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const byPage = new Map();
    for (let r = 0; r < sel.rangeCount; r++) {
      for (const rect of sel.getRangeAt(r).getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        for (const [page, layer] of this.layers) {
          const lr = layer.getBoundingClientRect();
          if (cx >= lr.left && cx <= lr.right && cy >= lr.top && cy <= lr.bottom) {
            const s = this.layerScale(page);
            const list = byPage.get(page) || [];
            list.push([(rect.left - lr.left) / s, (rect.top - lr.top) / s, rect.width / s, rect.height / s]);
            byPage.set(page, list);
            break;
          }
        }
      }
    }
    sel.removeAllRanges();
    if (!byPage.size) return false;
    for (const [page, rects] of byPage) {
      const lines = mergeLines(rects);
      const minX = Math.min(...lines.map((r) => r[0])), minY = Math.min(...lines.map((r) => r[1]));
      const maxX = Math.max(...lines.map((r) => r[0] + r[2])), maxY = Math.max(...lines.map((r) => r[1] + r[3]));
      const [ux, uy] = this.toUser(page, minX, minY);
      this.items.push(this.newItem(page, "hl", {
        ux, uy, w: maxX - minX, h: maxY - minY, color: this.opts.highlight.color,
        rects: lines.map(([x, y, w, hh]) => [+(x - minX).toFixed(2), +(y - minY).toFixed(2), +w.toFixed(2), +hh.toFixed(2)]),
      }));
      this.renderPage(page);
    }
    this.commit();
    return true;
  }

  setDragging(on) {
    this.dragging = on;
    document.body.classList.toggle("fo-dragging", on);
    this.onLayout?.();
  }

  startInk(e, page, x, y) {
    const layer = this.layers.get(page);
    const { color, width } = this.opts.ink;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    const vp = this.vp(page);
    svg.setAttribute("viewBox", `0 0 ${vp.width} ${vp.height}`);
    Object.assign(svg.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" });
    const path = document.createElementNS(ns, "path");
    Object.entries({ fill: "none", stroke: color, "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round" })
      .forEach(([k, v]) => path.setAttribute(k, v));
    svg.append(path);
    layer.append(svg);
    const pts = [[x, y]];
    const draw = () => path.setAttribute("d", pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" ") + (pts.length === 1 ? " l0.01 0" : ""));
    draw();
    layer.setPointerCapture(e.pointerId);
    this.setDragging(true);
    const move = (ev) => {
      for (const ce of ev.getCoalescedEvents?.() || [ev]) {
        const [nx, ny] = this.eventPoint(ce, page);
        const last = pts[pts.length - 1];
        if (Math.hypot(nx - last[0], ny - last[1]) > 0.6) pts.push([nx, ny]);
      }
      draw();
    };
    const up = () => {
      layer.removeEventListener("pointermove", move);
      layer.removeEventListener("pointerup", up);
      layer.removeEventListener("pointercancel", up);
      this.setDragging(false);
      svg.remove();
      const pad = width / 2 + 1;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
      const w = Math.max(...xs) + pad - minX, hh = Math.max(...ys) + pad - minY;
      const [ux, uy] = this.toUser(page, minX, minY);
      const rel = pts.map(([px0, py0]) => [+(px0 - minX).toFixed(2), +(py0 - minY).toFixed(2)]);
      this.items.push(this.newItem(page, "ink", { ux, uy, w, h: hh, vw: w, vh: hh, paths: [rel], color, width }));
      this.renderPage(page);
      this.commit();
    };
    layer.addEventListener("pointermove", move);
    layer.addEventListener("pointerup", up);
    layer.addEventListener("pointercancel", up);
  }

  startBox(e, page, x0, y0, kind) {
    const layer = this.layers.get(page);
    const draft = h("div", { class: "fo-draft" });
    if (kind === "highlight") Object.assign(draft.style, { background: this.opts.highlight.color, opacity: 0.45, mixBlendMode: "multiply", border: "0" });
    else Object.assign(draft.style, { background: "#fff", border: "1px solid rgba(0,0,0,.2)" });
    layer.append(draft);
    let x1 = x0, y1 = y0;
    const place = () => {
      Object.assign(draft.style, { left: px(Math.min(x0, x1)), top: px(Math.min(y0, y1)), width: px(Math.abs(x1 - x0)), height: px(Math.abs(y1 - y0)) });
    };
    place();
    const target = e.target;
    target.setPointerCapture?.(e.pointerId);
    this.setDragging(true);
    const move = (ev) => { [x1, y1] = this.eventPoint(ev, page); place(); };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      this.setDragging(false);
      draft.remove();
      let x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0);
      if (w < 4 && hh < 4) {
        if (kind === "highlight") return; // a stray click is not a highlight
        w = 100; hh = 18; x = x0 - w / 2; y = y0 - hh / 2;
      }
      const [ux, uy] = this.toUser(page, x, y);
      const item = kind === "highlight"
        ? this.newItem(page, "hl", { ux, uy, w, h: hh, color: this.opts.highlight.color, rects: [[0, 0, +w.toFixed(2), +hh.toFixed(2)]] })
        : this.newItem(page, "rect", { ux, uy, w, h: hh, kind, color: "#ffffff", opacity: 1 });
      this.items.push(item);
      this.renderPage(page);
      this.commit();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  // ---------- item interaction ----------
  onItemDown(e, id) {
    if (e.button !== 0) return;
    const item = this.itemById(id);
    if (!item || id === this.editingId) return;
    e.stopPropagation();
    e.preventDefault();
    if (this.tool === "text" && item.type === "text") { this.editText(id); return; }
    if (this.editingId) this.finishEditing(this.editingId);
    this.select(id);
    const el = this.els.get(id);
    const isResize = e.target.classList.contains("fo-h");
    const start = this.eventPoint(e, item.page);
    const [tx, ty] = this.toDisplay(item.page, item.ux, item.uy);
    const orig = { w: item.w, h: item.h, size: item.size };
    const turn = this.itemTurn(item) * Math.PI / 180;
    const ex = [Math.cos(turn), Math.sin(turn)], ey = [-Math.sin(turn), Math.cos(turn)];
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const [x, y] = this.eventPoint(ev, item.page);
      const dx = x - start[0], dy = y - start[1];
      if (!moved && Math.hypot(dx, dy) < 2) return;
      if (!moved) { moved = true; this.setDragging(true); }
      if (isResize) {
        const rx = x - tx, ry = y - ty;
        const w = Math.max(6, rx * ex[0] + ry * ex[1]);
        const hh = Math.max(6, rx * ey[0] + ry * ey[1]);
        if (item.type === "text") {
          item.size = Math.max(4, Math.min(144, +(orig.size * (w / orig.w)).toFixed(1)));
        } else if (item.type === "rect") {
          item.w = w; item.h = hh;
        } else {
          const k = Math.max(w / orig.w, hh / orig.h);
          item.w = orig.w * k; item.h = orig.h * k;
        }
      } else {
        [item.ux, item.uy] = this.toUser(item.page, tx + dx, ty + dy);
      }
      this.updateEl(item, el);
      if (item.type === "text") this.measureText(id);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (moved) { this.setDragging(false); this.commit(); this.onSelect?.(item); }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  editText(id) {
    if (this.editingId && this.editingId !== id) this.finishEditing(this.editingId);
    const item = this.itemById(id);
    const el = this.els.get(id);
    if (!item || !el) return;
    this.select(id);
    this.editingId = id;
    el.classList.remove("sel");
    el.querySelector(".fo-h")?.remove();
    el.setAttribute("contenteditable", "plaintext-only");
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
    this.onSelect?.(item);
  }

  finishEditing(id) {
    if (this.editingId !== id) return;
    const item = this.itemById(id);
    const el = this.els.get(id);
    this.editingId = null;
    if (!item || !el) return;
    el.removeAttribute("contenteditable");
    const text = el.innerText.replace(/\n$/, "");
    if (!text.trim()) {
      this.items = this.items.filter((i) => i !== item);
      if (this.selId === id) { this.selId = null; this.onSelect?.(null); }
      this.renderPage(item.page);
      this.commit();
      return;
    }
    item.text = text;
    el.textContent = text;
    el.append(h("div", { class: "fo-h", title: "Drag to resize" }));
    this.measureText(id);
    this.renderPage(item.page);
    this.commit();
    this.onSelect?.(this.selected);
  }

  exportItems() {
    for (const item of this.items) if (item.type === "text") this.measureText(item.id);
    return this.items.map((i) => ({ ...i, baseline: i.type === "text" ? baselineRatio(i.font) : undefined }));
  }
}

// ---------- canvas preview (thumbnails) ----------
const imageCache = new Map();
function cachedImage(src, onLoad) {
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.onload = onLoad;
    img.src = src;
    imageCache.set(src, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

/**
 * Draws overlay items onto a canvas rendered with `viewport` (a pdf.js PageViewport).
 * `onImageLoad` is called if an image wasn't ready yet, so the caller can redraw.
 */
export function drawItems(ctx, items, viewport, assets, onImageLoad) {
  for (const item of items) {
    const [x, y] = viewport.convertToViewportPoint(item.ux, item.uy);
    const turn = ((viewport.rotation - item.rot) % 360 + 360) % 360;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((turn * Math.PI) / 180);
    ctx.scale(viewport.scale, viewport.scale);
    if (item.type === "text") {
      ctx.fillStyle = item.color;
      ctx.font = `${item.size}px ${FONTS[item.font].css}`;
      const b = baselineRatio(item.font);
      item.text.split("\n").forEach((line, i) => ctx.fillText(line, 0, (i * 1.2 + b) * item.size));
    } else if (item.type === "image") {
      const img = cachedImage(assets.get(item.asset)?.src, onImageLoad);
      if (img) ctx.drawImage(img, 0, 0, item.w, item.h);
    } else if (item.type === "rect" || item.type === "hl") {
      ctx.fillStyle = item.color;
      if (item.type === "hl" || item.blend === "multiply") { ctx.globalAlpha = 0.45; ctx.globalCompositeOperation = "multiply"; }
      const rects = item.type === "hl" ? item.rects : [[0, 0, item.w, item.h]];
      rects.forEach(([rx, ry, rw, rh]) => ctx.fillRect(rx, ry, rw, rh));
    } else if (item.type === "mark" && item.mark === "dot") {
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(item.w / 2, item.h / 2, item.w / 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (item.type === "ink" || item.type === "mark") {
      const sx = item.w / item.vw, sy = item.h / item.vh;
      ctx.strokeStyle = item.color;
      ctx.lineWidth = (item.type === "ink" ? item.width : 2.6) * Math.min(sx, sy);
      ctx.lineCap = ctx.lineJoin = "round";
      for (const pts of item.type === "ink" ? item.paths : MARK_PATHS[item.mark]) {
        ctx.beginPath();
        pts.forEach(([px0, py0], i) => (i ? ctx.lineTo(px0 * sx, py0 * sy) : ctx.moveTo(px0 * sx, py0 * sy)));
        if (pts.length === 1) ctx.lineTo(pts[0][0] * sx + 0.01, pts[0][1] * sy);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** Short human description of an item, for the Edits panel. */
export function describeItem(item, assets) {
  switch (item.type) {
    case "text": return { icon: "type", label: item.text.split("\n")[0].slice(0, 40) || "Text" };
    case "image": {
      const kind = assets.get(item.asset)?.kind;
      return kind === "signature" ? { icon: "signature", label: "Signature" } : kind === "initials" ? { icon: "pen-line", label: "Initials" } : { icon: "image", label: "Image" };
    }
    case "mark": return item.mark === "cross" ? { icon: "x", label: "Cross mark" } : { icon: "check", label: "Check mark" };
    case "ink": return { icon: "pencil", label: "Drawing" };
    case "hl": return { icon: "highlighter", label: "Highlight" };
    case "rect": return item.kind === "whiteout" ? { icon: "eraser", label: "Whiteout" } : { icon: "square", label: "Box" };
    default: return { icon: "square", label: item.type };
  }
}

/** Merges per-glyph-run rects into one rect per text line. */
function mergeLines(rects) {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const lines = [];
  for (const r of sorted) {
    const line = lines.find((l) => {
      const top = Math.max(l[1], r[1]), bottom = Math.min(l[1] + l[3], r[1] + r[3]);
      return bottom - top > Math.min(l[3], r[3]) * 0.5;
    });
    if (line) {
      const x0 = Math.min(line[0], r[0]), y0 = Math.min(line[1], r[1]);
      const x1 = Math.max(line[0] + line[2], r[0] + r[2]), y1 = Math.max(line[1] + line[3], r[1] + r[3]);
      line[0] = x0; line[1] = y0; line[2] = x1 - x0; line[3] = y1 - y0;
    } else {
      lines.push([...r]);
    }
  }
  return lines;
}
