// Sidebar panels: chapter outline (bookmarks) and page thumbnails with page tools.
import { h, iconEl, openMenu } from "./ui.js";

export class Sidebar {
  /**
   * onPageAction(action, indices, extra) — action: rotate | delete | move | insert | insertFile | extract
   */
  constructor({ viewer, outlineEl, pagesEl, onPageAction, decorate }) {
    this.viewer = viewer;
    this.outlineEl = outlineEl;
    this.pagesEl = pagesEl;
    this.onPageAction = onPageAction;
    this.decorate = decorate; // (pageIndex, ctx, viewport) => draws the user's edits on a thumbnail
    this.flat = [];
    this.thumbs = [];
    this.selection = new Set();
    this.anchor = 0;
    this.observer = null;
  }

  async load(doc) {
    this.doc = doc;
    await Promise.all([this.buildOutline(doc), this.buildThumbs(doc)]);
  }

  clear() {
    this.observer?.disconnect();
    this.outlineEl.replaceChildren();
    this.pagesEl.replaceChildren();
    this.flat = [];
    this.thumbs = [];
    this.selection.clear();
  }

  get hasOutline() { return this.flat.length > 0; }

  // ---------- outline ----------
  async buildOutline(doc) {
    const outline = await doc.getOutline().catch(() => null);
    this.flat = [];
    this.lastBest = null;
    this.autoOpened = new Set();
    if (!outline?.length) {
      this.outlineEl.replaceChildren(h("div", { class: "side-empty" },
        "This PDF doesn't include a chapter list.", h("br"), "Use ", h("b", {}, "Pages"), " to browse instead."));
      return;
    }
    const pending = [];
    const build = (items, depth) => {
      const wrap = h("div", { class: depth ? "ol-children" : "ol-root", role: depth ? "group" : "tree" });
      for (const it of items) {
        const node = h("div", { class: "ol-node" });
        const hasKids = it.items?.length > 0;
        const toggle = h("span", { class: "ol-toggle" }, hasKids ? iconEl("chevron-down", 14) : null);
        const pageEl = h("span", { class: "ol-page" });
        const row = h("div", { class: "ol-item", title: it.title, role: "treeitem", tabindex: "0" },
          toggle, h("span", { class: "ol-title", style: { fontWeight: it.bold ? 600 : "", fontStyle: it.italic ? "italic" : "" } }, it.title), pageEl);
        node.append(row);
        if (hasKids) {
          if (!(it.count > 0)) node.classList.add("collapsed");
          node.append(build(it.items, depth + 1));
          toggle.addEventListener("click", (e) => {
            e.stopPropagation();
            node.classList.toggle("collapsed");
            this.autoOpened?.delete(node); // the reader chose this; leave it alone
          });
        }
        const go = () => {
          if (it.dest) this.viewer.goToDest(it.dest);
          else if (it.url) window.open(it.url, "_blank", "noopener");
        };
        row.addEventListener("click", go);
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter") go();
          if (e.key === "ArrowRight" && hasKids) node.classList.remove("collapsed");
          if (e.key === "ArrowLeft" && hasKids) node.classList.add("collapsed");
        });
        const entry = { node, row, page: null };
        this.flat.push(entry);
        if (it.dest) pending.push(this.viewer.destPageNumber(it.dest).then((p) => { entry.page = p; if (p) pageEl.textContent = p; }));
        wrap.append(node);
      }
      return wrap;
    };
    this.outlineEl.replaceChildren(build(outline, 0));
    await Promise.all(pending);
  }

  setCurrentPage(n) {
    let best = null;
    for (const e of this.flat) if (e.page && e.page <= n && (!best || e.page >= best.page)) best = e;
    for (const e of this.flat) e.row.classList.toggle("current", e === best);
    if (best && best !== this.lastBest) {
      // Open the chapter you're in; fold away chapters we opened automatically before.
      const ancestors = new Set();
      let p = best.node.parentElement;
      while (p && p !== this.outlineEl) { if (p.classList.contains("ol-node")) ancestors.add(p); p = p.parentElement; }
      for (const n of this.autoOpened || []) if (!ancestors.has(n)) n.classList.add("collapsed");
      this.autoOpened = new Set();
      for (const n of ancestors) {
        if (n.classList.contains("collapsed")) { n.classList.remove("collapsed"); this.autoOpened.add(n); }
      }
      this.lastBest = best;
    }
    if (best && !this.outlineEl.hidden) best.row.scrollIntoView({ block: "nearest" });
    this.current = n;
    if (this.selection.size <= 1) { this.selection = new Set([n - 1]); this.anchor = n - 1; }
    this.paintSelection();
    const cur = this.thumbs[n - 1];
    if (cur && !this.pagesEl.hidden) cur.el.scrollIntoView({ block: "nearest" });
  }

  // ---------- thumbnails & page tools ----------
  get selected() { return [...this.selection].sort((a, b) => a - b); }

  paintSelection() {
    this.thumbs.forEach((t, i) => {
      t.el.classList.toggle("current", i === this.current - 1);
      t.el.classList.toggle("picked", this.selection.has(i) && this.selection.size > 1);
    });
    if (this.countEl) {
      const n = this.selection.size;
      this.countEl.textContent = n > 1 ? `${n} pages selected` : `Page ${this.current || 1}`;
    }
  }

  pageMenu(anchorEl, indices) {
    const many = indices.length > 1;
    const label = many ? `${indices.length} pages` : "page";
    openMenu(anchorEl, [
      { label: `Rotate ${label} right`, icon: "rotate-cw", onClick: () => this.onPageAction("rotate", indices, 90) },
      { label: `Rotate ${label} left`, icon: "rotate-ccw", onClick: () => this.onPageAction("rotate", indices, -90) },
      "sep",
      { label: "Insert pages from a PDF…", icon: "file-plus", onClick: () => this.onPageAction("insert", indices, Math.max(...indices) + 1) },
      { label: `Save ${label} as a new PDF…`, icon: "file-output", onClick: () => this.onPageAction("extract", indices) },
      "sep",
      { label: `Delete ${label}`, icon: "trash-2", danger: true, onClick: () => this.onPageAction("delete", indices) },
    ], { align: "left" });
  }

  async buildThumbs(doc) {
    this.observer?.disconnect();
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    const W = 150;
    this.thumbs = [];
    const tools = h("div", { class: "page-tools" });
    this.countEl = h("span", { class: "page-tools-count" });
    const btn = (icon, title, fn) => {
      const b = h("button", { class: "icon-btn", title }, iconEl(icon, 16));
      b.addEventListener("click", fn);
      return b;
    };
    const moreBtn = btn("ellipsis", "More page actions", () => this.pageMenu(moreBtn, this.selected));
    tools.append(this.countEl,
      btn("rotate-ccw", "Rotate left", () => this.onPageAction("rotate", this.selected, -90)),
      btn("rotate-cw", "Rotate right", () => this.onPageAction("rotate", this.selected, 90)),
      btn("trash-2", "Delete", () => this.onPageAction("delete", this.selected)),
      moreBtn);
    const grid = h("div", { class: "thumbs" });
    const marker = h("div", { class: "drop-marker", hidden: true });

    for (let i = 0; i < doc.numPages; i++) {
      const box = h("div", { class: "thumb-img loading", style: { width: `${W}px`, height: `${Math.round(W * first.height / first.width)}px` } });
      const quick = h("div", { class: "thumb-quick" });
      const qRot = h("button", { title: "Rotate right" }, iconEl("rotate-cw", 14));
      const qDel = h("button", { title: "Delete page" }, iconEl("trash-2", 14));
      quick.append(qRot, qDel);
      const el = h("div", { class: "thumb", "data-page": i + 1, title: `Page ${i + 1}`, draggable: "true" },
        h("div", { class: "thumb-frame" }, box, quick), h("div", { class: "thumb-num" }, String(i + 1)));
      qRot.addEventListener("click", (e) => { e.stopPropagation(); this.onPageAction("rotate", this.selection.has(i) ? this.selected : [i], 90); });
      qDel.addEventListener("click", (e) => { e.stopPropagation(); this.onPageAction("delete", this.selection.has(i) ? this.selected : [i]); });
      el.addEventListener("click", (e) => this.onThumbClick(e, i));
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!this.selection.has(i)) { this.selection = new Set([i]); this.anchor = i; this.paintSelection(); }
        const fake = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) };
        this.pageMenu(fake, this.selected);
      });
      el.addEventListener("dragstart", (e) => {
        if (!this.selection.has(i)) { this.selection = new Set([i]); this.anchor = i; this.paintSelection(); }
        e.dataTransfer.setData("application/x-folio-pages", JSON.stringify(this.selected));
        e.dataTransfer.effectAllowed = "move";
      });
      grid.append(el);
      this.thumbs.push({ el, box, rendered: false });
    }
    grid.append(marker);

    // Drag to reorder pages, or drop a PDF file to insert it at that spot.
    const dropIndex = (e) => {
      for (let i = 0; i < this.thumbs.length; i++) {
        const r = this.thumbs[i].el.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) return i;
      }
      return this.thumbs.length;
    };
    const showMarker = (idx) => {
      const ref = this.thumbs[idx]?.el || this.thumbs.at(-1).el;
      const top = idx < this.thumbs.length ? ref.offsetTop - 8 : ref.offsetTop + ref.offsetHeight + 6;
      marker.style.top = `${top}px`;
      marker.hidden = false;
    };
    grid.addEventListener("dragover", (e) => {
      const types = [...e.dataTransfer.types];
      if (!types.includes("application/x-folio-pages") && !types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = types.includes("Files") ? "copy" : "move";
      showMarker(dropIndex(e));
    });
    grid.addEventListener("dragleave", (e) => { if (!grid.contains(e.relatedTarget)) marker.hidden = true; });
    grid.addEventListener("drop", (e) => {
      marker.hidden = true;
      const idx = dropIndex(e);
      const pages = e.dataTransfer.getData("application/x-folio-pages");
      if (pages) {
        e.preventDefault();
        e.stopPropagation();
        this.onPageAction("move", JSON.parse(pages), idx);
      } else if (e.dataTransfer.files.length) {
        e.preventDefault();
        e.stopPropagation();
        this.onPageAction("insertFile", [], { file: e.dataTransfer.files[0], at: idx });
      }
    });
    grid.addEventListener("dragend", () => { marker.hidden = true; });

    this.pagesEl.replaceChildren(tools, grid);
    this.pagesEl.tabIndex = 0;
    this.pagesEl.onkeydown = (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && this.selection.size) { e.preventDefault(); this.onPageAction("delete", this.selected); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); this.selection = new Set(this.thumbs.map((_, k) => k)); this.paintSelection(); }
    };
    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) this.renderThumb(Number(en.target.dataset.page) - 1);
    }, { root: this.pagesEl, rootMargin: "300px 0px" });
    this.thumbs.forEach((t) => this.observer.observe(t.el));
    this.paintSelection();
  }

  onThumbClick(e, i) {
    if (e.shiftKey) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      this.selection = new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selection.has(i) && this.selection.size > 1) this.selection.delete(i); else this.selection.add(i);
      this.anchor = i;
    } else {
      this.selection = new Set([i]);
      this.anchor = i;
      this.viewer.currentPage = i + 1;
    }
    this.paintSelection();
  }

  async renderThumb(idx) {
    const t = this.thumbs[idx];
    if (!t || t.rendered || !this.doc) return;
    t.rendered = true;
    try {
      const page = await this.doc.getPage(idx + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const W = 150;
      const scale = (W / vp1.width) * Math.min(2, devicePixelRatio || 1);
      const vp = page.getViewport({ scale });
      const base = document.createElement("canvas");
      base.width = Math.floor(vp.width);
      base.height = Math.floor(vp.height);
      t.box.style.height = `${Math.round(W * vp1.height / vp1.width)}px`;
      await page.render({ canvasContext: base.getContext("2d"), canvas: base, viewport: vp }).promise;
      if (this.thumbs[idx] !== t) return; // document changed meanwhile
      const canvas = document.createElement("canvas");
      canvas.width = base.width;
      canvas.height = base.height;
      Object.assign(t, { base, canvas, vp });
      this.paintThumb(t, idx);
      t.box.classList.remove("loading");
      t.box.replaceChildren(canvas);
    } catch {
      t.rendered = false;
    }
  }

  paintThumb(t, idx) {
    if (!t.canvas) return;
    const ctx = t.canvas.getContext("2d");
    ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
    ctx.drawImage(t.base, 0, 0);
    this.decorate?.(idx, ctx, t.vp);
  }

  /** Redraws the user's edits on every rendered thumbnail. */
  redecorate() {
    this.thumbs.forEach((t, i) => this.paintThumb(t, i));
  }
}
