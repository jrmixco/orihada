// Orihada — app controller: wires the viewer, sidebar, edit layer and chrome.
import { $, $$, h, iconEl, hydrateIcons, toast, openMenu, closeMenu, modal, ask, timeAgo } from "./ui.js";
import { Viewer } from "./viewer.js";
import { Overlay, FONTS, drawItems, describeItem } from "./overlay.js";
import { Sidebar } from "./sidebar.js";
import { openPalette } from "./palette.js";
import { openSignatureDialog, listSaved } from "./signature.js";
import { buildPdf } from "./save.js";
import { openPrintWindow, browserPrint } from "./printwin.js";
import { rotatePages, deletePages, reorderPages, moveOrder, insertPdf, extractPages, describeRanges } from "./pages.js";
import { prefs, idb } from "./store.js";
import * as platform from "./platform.js";
import { VERSION, WEBSITE, UPDATE_URL } from "./version.js";

const app = $("#app");

/** Per-document state; each open tab has one. */
function newState() {
  return {
    file: null, // { name, path?, handle? }
    bytes: null, // bytes of the document as currently loaded (changes after page edits)
    versions: [], // page-structure versions; index = overlay.version
    doc: null,
    fp: null, // fingerprint of the file as opened (stable key for drafts and position)
    password: null,
    dirty: false,
    formDirty: false,
    pendingPos: null,
  };
}

// Open documents. `state` and `overlay` always point at the active tab's objects,
// so everything below works on whichever document is showing.
const tabs = []; // [{ id, state, overlay, view }]
let activeTab = null;
let state = newState();
let busy = false; // a long operation (open, page change, print) is running

// ---------- theme ----------
function applyTheme() {
  const t = prefs.get("theme", "system");
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = t;
}
applyTheme();

// ---------- core objects ----------
const viewer = new Viewer({
  container: $("#viewerContainer"),
  viewer: $("#viewer"),
  onPageView: (pv) => overlay.attach(pv),
});

let fieldTipShown = false;
function makeOverlay() {
  return new Overlay({
    viewer,
    onChange: () => { setDirty(true); updateUndo(); scheduleDraft(); scheduleEditsRefresh(); },
    onSelect: () => { renderCtx(); renderEdits(); },
    onToolDone: () => { renderTools(); },
    onLayout: () => requestAnimationFrame(positionCtx),
    onVersion: (v) => loadVersion(v),
    onFormFieldClick: () => {
      if (fieldTipShown) return;
      fieldTipShown = true;
      toast("That's a fillable field — type straight into it.", { timeout: 2600 });
    },
  });
}
let overlay = makeOverlay();

const sidebar = new Sidebar({
  viewer,
  outlineEl: $("#panel-outline"),
  pagesEl: $("#panel-pages"),
  onPageAction: (action, indices, extra) => pageAction(action, indices, extra),
  decorate: (idx, ctx, vp) => drawItems(ctx, overlay.items.filter((i) => i.page === idx), vp, overlay.assets, () => sidebar.redecorate()),
});

// ---------- edits panel ----------
let editsTimer;
function scheduleEditsRefresh() {
  clearTimeout(editsTimer);
  editsTimer = setTimeout(() => { renderEdits(); sidebar.redecorate(); }, 250);
}

function renderEdits() {
  const panel = $("#panel-edits");
  const badge = $("#edits-count");
  const items = overlay.items;
  badge.hidden = !items.length;
  badge.textContent = items.length;
  if (panel.hidden) return; // rendered when the tab is shown
  panel.replaceChildren();
  if (!items.length) {
    panel.append(h("div", { class: "side-empty" },
      h("b", {}, "No edits yet."), h("br"),
      "Text, signatures, check marks, highlights and drawings you add show up here, so you can review them before you send the file."));
    return;
  }
  const byPage = new Map();
  for (const it of items) byPage.set(it.page, [...(byPage.get(it.page) || []), it]);
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    panel.append(h("div", { class: "edits-page" }, `Page ${page + 1}`));
    for (const it of byPage.get(page)) {
      const d = describeItem(it, overlay.assets);
      const del = h("button", { class: "icon-btn", title: "Delete" }, iconEl("trash-2", 15));
      const row = h("div", { class: `edit-row ${it.id === overlay.selId ? "sel" : ""}`, title: "Show on page" }, iconEl(d.icon, 16), h("span", { class: "lbl" }, d.label), del);
      row.addEventListener("click", () => focusItem(it.id));
      del.addEventListener("click", (e) => { e.stopPropagation(); overlay.select(it.id); overlay.deleteSelected(); });
      panel.append(row);
    }
  }
  panel.append(h("div", { class: "edits-foot" }, "Edits become part of the PDF when you save. Until then they're kept safe automatically."));
}

async function focusItem(id) {
  const it = overlay.itemById(id);
  if (!it) return;
  if (overlay.tool !== "select") { overlay.setTool("select"); renderTools(); }
  viewer.pdfViewer.scrollPageIntoView({ pageNumber: it.page + 1, destArray: [null, { name: "XYZ" }, null, it.uy + 120, null] });
  for (let i = 0; i < 60 && !overlay.els.get(id)?.isConnected; i++) await new Promise((r) => requestAnimationFrame(r));
  overlay.select(id);
}

// ---------- view options ----------
function applyViewPrefs() {
  app.classList.toggle("dark-pages", prefs.get("darkPages", false));
}
applyViewPrefs();

function toggleDarkPages() {
  prefs.set("darkPages", !prefs.get("darkPages", false));
  applyViewPrefs();
}

function toggleSpread() {
  const next = viewer.pdfViewer.spreadMode === 1 ? 0 : 1; // 0 = single, 1 = two pages side by side
  viewer.pdfViewer.spreadMode = next;
  prefs.set("spread", next);
  if (viewer.scaleValue === "page-width" || viewer.scaleValue === "auto") viewer.scaleValue = "page-fit";
}

function toggleReading(force) {
  const on = force ?? !app.classList.contains("reading");
  if (on === app.classList.contains("reading")) return;
  app.classList.toggle("reading", on);
  if (on) {
    state.scaleBeforeReading = viewer.scaleValue;
    document.documentElement.requestFullscreen?.().catch(() => {});
    toast("Reading mode — arrow keys turn pages, Esc exits", { timeout: 2500 });
  } else if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
  // Re-fit after the chrome disappears/returns: whole page while reading, previous zoom after.
  setTimeout(() => { viewer.scaleValue = on ? "page-fit" : state.scaleBeforeReading || "auto"; }, 150);
}
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && app.classList.contains("reading")) toggleReading(false); });

// ---------- tools ----------
const TOOLS = [
  { id: "select", label: "Select", icon: "mouse-pointer-2", key: "V" },
  "sep",
  { id: "text", label: "Text", icon: "type", key: "T" },
  { id: "sign", label: "Sign", icon: "signature", key: "S" },
  { id: "check", label: "Check", icon: "check", key: "K" },
  { id: "cross", label: "Cross", icon: "x", key: "X" },
  { id: "date", label: "Date", icon: "calendar" },
  "sep",
  { id: "highlight", label: "Highlight", icon: "highlighter", key: "H" },
  { id: "draw", label: "Draw", icon: "pencil", key: "D" },
  { id: "whiteout", label: "Whiteout", icon: "eraser", key: "W" },
  { id: "image", label: "Image", icon: "image" },
];

function activeToolId() {
  if (overlay.tool === "image") return overlay.pendingKind === "image" ? "image" : "sign";
  return overlay.tool;
}

function renderTools() {
  const wrap = $("#tools");
  wrap.replaceChildren();
  const active = activeToolId();
  for (const t of TOOLS) {
    if (t === "sep") { wrap.append(h("div", { class: "tool-sep" })); continue; }
    const b = h("button", { class: `tool ${active === t.id ? "active" : ""}`, "data-tool": t.id, title: t.key ? `${t.label} (${t.key})` : t.label, "aria-pressed": active === t.id ? "true" : "false" },
      iconEl(t.icon, 17), h("span", {}, t.label));
    b.addEventListener("click", (e) => chooseTool(t.id, e.currentTarget));
    wrap.append(b);
  }
  renderCtx();
}

async function chooseTool(id, anchor) {
  if (id === "sign") return openSignMenu(anchor || $('[data-tool="sign"]'));
  if (id === "image") return pickImage();
  overlay.setTool(overlay.tool === id && id !== "select" ? "select" : id);
  renderTools();
}

async function openSignMenu(anchor) {
  const [sigs, inits] = await Promise.all([listSaved("signature"), listSaved("initials")]);
  if (!sigs.length && !inits.length) return startSignature("signature");
  const items = [];
  if (sigs.length) {
    items.push({ header: "Click to sign" });
    sigs.slice(0, 3).forEach((s) => items.push({ img: s.src, label: "Use this signature", onClick: () => armSignature(s) }));
  }
  items.push({ label: sigs.length ? "New signature…" : "Add signature…", icon: "signature", onClick: () => startSignature("signature") });
  items.push("sep");
  if (inits.length) {
    items.push({ header: "Initials" });
    inits.slice(0, 2).forEach((s) => items.push({ img: s.src, label: "Use these initials", onClick: () => armSignature(s) }));
  }
  items.push({ label: inits.length ? "New initials…" : "Add initials…", icon: "pen-line", onClick: () => startSignature("initials") });
  openMenu(anchor, items, { align: "left" });
}

function armSignature(sig) {
  overlay.armAsset(overlay.addAsset(sig.src, sig.w, sig.h, sig.kind));
  renderTools();
}

async function startSignature(kind) {
  const sig = await openSignatureDialog(kind);
  if (sig) armSignature(sig);
}

function pickImage() {
  const input = $("#image-input");
  input.value = "";
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const src = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas"); // normalise to PNG for embedding
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    overlay.armAsset(overlay.addAsset(c.toDataURL("image/png"), c.width, c.height, "image"));
    renderTools();
  };
  input.click();
}

// ---------- floating context bar ----------
const TEXT_COLORS = ["#111111", "#1f3a93", "#c62828", "#2e7d32"];
const INK_COLORS = ["#111111", "#1f3a93", "#c62828", "#2e7d32", "#f57c00"];
const HL_COLORS = ["#ffd84d", "#9be37a", "#ff9ec4", "#8ed1ff"];

function swatches(colors, current, onPick) {
  return h("div", { class: "swatches" }, colors.map((c) => {
    const b = h("button", { class: `swatch ${c === current ? "on" : ""}`, style: { background: c }, title: c, "aria-label": `Color ${c}` });
    b.addEventListener("click", () => onPick(c));
    return b;
  }));
}

function stepper(value, { min, max, step = 1, fmt = (v) => v, onChange, label }) {
  const dec = h("button", { title: `Smaller ${label || ""}`.trim() }, iconEl("minus", 14));
  const inc = h("button", { title: `Larger ${label || ""}`.trim() }, iconEl("plus", 14));
  dec.addEventListener("click", () => onChange(Math.max(min, +(value - step).toFixed(1))));
  inc.addEventListener("click", () => onChange(Math.min(max, +(value + step).toFixed(1))));
  return h("div", { class: "stepper" }, dec, h("span", {}, fmt(value)), inc);
}

const HINTS = {
  text: "Click anywhere to type",
  date: "Click where the date goes",
  check: "Click to place a ✓",
  cross: "Click to place an ✗",
  draw: "Draw with your mouse or pen",
  highlight: "Select text to highlight it — or drag a box anywhere",
  whiteout: "Drag over what you want to cover (visual only, not a secure redaction)",
  image: "Click where the image should go",
  signature: "Click where you want to sign",
  initials: "Click where your initials go",
};

function renderCtx() {
  const bar = $("#ctxbar");
  const sel = overlay.selected;
  const tool = overlay.tool;
  bar.replaceChildren();
  if (!state.doc || (!sel && tool === "select")) { bar.hidden = true; return; }
  bar.hidden = false;
  const kind = sel ? (sel.type === "rect" ? sel.kind : sel.type) : tool === "image" ? overlay.pendingKind : tool;
  const upd = (patch, optKey) => {
    if (sel) overlay.updateSelected(patch);
    if (optKey) Object.assign(overlay.opts[optKey], patch);
    renderCtx();
  };
  if (!sel && HINTS[kind]) bar.append(h("span", { class: "hint" }, HINTS[kind]));
  const opts = [];
  if (kind === "text" || kind === "date") {
    const o = sel || overlay.opts.text;
    const fontSel = h("select", { class: "select-sm", title: "Font" },
      Object.entries(FONTS).map(([k, f]) => h("option", { value: k, selected: k === o.font }, f.label)));
    fontSel.addEventListener("change", () => upd({ font: fontSel.value }, "text"));
    opts.push(fontSel,
      stepper(o.size, { min: 4, max: 144, step: o.size >= 20 ? 2 : 1, fmt: (v) => `${v} pt`, label: "text", onChange: (v) => upd({ size: v }, "text") }),
      swatches(TEXT_COLORS, o.color, (c) => upd({ color: c }, "text")));
  } else if (kind === "ink" || kind === "draw") {
    const o = sel || overlay.opts.ink;
    opts.push(swatches(INK_COLORS, o.color, (c) => upd({ color: c }, "ink")));
    if (!sel) opts.push(h("label", {}, "Pen", stepper(o.width, { min: 0.5, max: 12, step: 0.5, label: "pen", onChange: (v) => upd({ width: v }, "ink") })));
  } else if (kind === "highlight" || kind === "hl") {
    const o = sel || overlay.opts.highlight;
    opts.push(swatches(HL_COLORS, o.color, (c) => upd({ color: c }, "highlight")));
  } else if (kind === "mark" || kind === "check" || kind === "cross") {
    const o = sel || overlay.opts.mark;
    opts.push(swatches(TEXT_COLORS, o.color, (c) => upd({ color: c }, "mark")));
  }
  if (opts.length) { if (bar.childElementCount) bar.append(h("div", { class: "vsep" })); bar.append(...opts); }
  if (sel) {
    bar.append(h("div", { class: "vsep" }));
    if (sel.type === "text" && overlay.editingId !== sel.id) bar.append(h("button", { class: "icon-btn", title: "Edit text (Enter)", onclick: () => overlay.editText(sel.id) }, iconEl("pencil", 16)));
    if (sel.type !== "hl") bar.append(h("button", { class: "icon-btn", title: "Duplicate (Ctrl+D)", onclick: () => overlay.duplicateSelected() }, iconEl("copy", 16)));
    bar.append(h("button", { class: "icon-btn", title: "Delete (Del)", style: { color: "var(--danger)" }, onclick: () => overlay.deleteSelected() }, iconEl("trash-2", 16)));
  } else {
    bar.append(h("div", { class: "vsep" }), h("button", { class: "btn", title: "Back to Select (Esc)", onclick: () => { overlay.setTool("select"); renderTools(); } }, "Done"));
  }
  positionCtx();
}

function positionCtx() {
  const bar = $("#ctxbar");
  if (bar.hidden) return;
  const sel = overlay.selected;
  if (!sel) { bar.className = "top"; bar.style.left = bar.style.top = ""; return; }
  const el = overlay.els.get(sel.id);
  const stage = $("#stage").getBoundingClientRect();
  const r = el?.isConnected ? el.getBoundingClientRect() : null;
  if (!r || overlay.dragging || r.bottom < stage.top || r.top > stage.bottom) { bar.className = "hide"; return; }
  bar.className = "";
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let top = r.top - stage.top - bh - 12;
  if (top < 8) top = r.bottom - stage.top + 14;
  const left = Math.max(8, Math.min(r.left - stage.left + r.width / 2 - bw / 2, stage.width - bw - 8));
  bar.style.left = `${left}px`;
  bar.style.top = `${Math.min(top, stage.height - bh - 8)}px`;
}
// Keep focus in a text box being edited when clicking bar buttons.
$("#ctxbar").addEventListener("pointerdown", (e) => { if (!e.target.closest("select")) e.preventDefault(); });
$("#viewerContainer").addEventListener("scroll", () => requestAnimationFrame(positionCtx), { passive: true });
addEventListener("resize", () => requestAnimationFrame(positionCtx));

// ---------- dirty / undo ----------
function setDirty(v) {
  state.dirty = v;
  renderTitle();
  if (platform.isDesktop) window.folioNative.setDirty?.(tabs.some((t) => t.state.dirty));
}

function renderTitle() {
  renderTabs();
  document.title = state.file ? `${state.dirty ? "• " : ""}${state.file.name} — Orihada` : "Orihada";
}

// ---------- document tabs ----------
function renderTabs() {
  const bar = $("#doc-tabs");
  bar.replaceChildren();
  for (const tab of tabs) {
    const s = tab.state;
    const close = h("button", { class: "doc-tab-x", title: "Close (Ctrl+W)", "aria-label": `Close ${s.file?.name}` }, iconEl("x", 13));
    const el = h("div", {
      class: `doc-tab ${tab === activeTab ? "active" : ""}`, role: "tab", tabindex: "0",
      "aria-selected": tab === activeTab ? "true" : "false", title: s.file?.path || s.file?.name || "",
    },
    iconEl("file-text", 14), h("span", { class: "doc-tab-name" }, s.file?.name || "Opening…"),
    s.dirty ? h("span", { class: "dirty", title: "Unsaved changes (kept safe automatically)" }) : null, close);
    el.addEventListener("click", () => activateTab(tab));
    el.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab); } });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateTab(tab); } });
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab); });
    bar.append(el);
  }
  const add = h("button", { class: "icon-btn doc-tab-add", title: "Open another PDF (Ctrl+O)", "aria-label": "Open another PDF" }, iconEl("plus", 16));
  add.addEventListener("click", openPicker);
  if (tabs.length) bar.append(add);
  bar.querySelector(".doc-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Makes `tab` the visible document. */
async function activateTab(tab, pos = null) {
  if (!tab || (tab === activeTab && state.doc === tab.state.doc && viewer.pdfDocument === tab.state.doc)) return;
  if (activeTab && activeTab !== tab && state.doc) {
    if (overlay.editingId) overlay.finishEditing(overlay.editingId);
    clearTimeout(draftTimer);
    await writeDraft(); // keep the tab we're leaving safe
    activeTab.view = { page: viewer.currentPage, scale: viewer.scaleValue };
    overlay.setTool("select");
    overlay.select(null);
  }
  activeTab = tab;
  state = tab.state;
  overlay = tab.overlay;
  if (findInput.value) { findInput.value = ""; runFind(); }
  await showDoc(state.doc, pos || tab.view || null);
  updateUndo();
  renderTools();
}

/** Closes a tab (asking to save if needed). Returns false if the user cancelled. */
async function closeTab(tab) {
  if (tab.state.dirty) {
    if (tab !== activeTab) await activateTab(tab);
    if (!(await confirmDiscard())) return false;
  }
  const i = tabs.indexOf(tab);
  if (i < 0) return true;
  tabs.splice(i, 1);
  if (tab === activeTab) {
    activeTab = null;
    const next = tabs[i] || tabs[i - 1];
    if (next) await activateTab(next);
    else showWelcome();
  }
  tab.overlay.dispose();
  tab.state.doc?.loadingTask.destroy();
  renderTabs();
  if (platform.isDesktop) window.folioNative.setDirty?.(tabs.some((t) => t.state.dirty));
  return true;
}

/** Closes every tab, asking about unsaved ones. Returns false if the user cancelled. */
async function closeAllTabs() {
  for (const tab of [...tabs].sort((a, b) => b.state.dirty - a.state.dirty)) {
    if (!(await closeTab(tab))) return false;
  }
  return true;
}

function cycleTab(dir) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(activeTab);
  activateTab(tabs[(i + dir + tabs.length) % tabs.length]);
}

/** Back to the start screen when the last document is closed. */
function showWelcome() {
  state = newState();
  overlay = makeOverlay();
  viewer.detach();
  sidebar.clear();
  app.classList.add("no-doc");
  $("#formbar").hidden = true;
  if (findInput.value) { findInput.value = ""; runFind(); }
  renderTitle();
  renderTools();
  updateUndo();
  renderEdits();
  renderRecent();
}

function updateUndo() {
  $("#btn-undo").disabled = !overlay.canUndo;
  $("#btn-redo").disabled = !overlay.canRedo;
}

async function undo() { if (await overlay.undo()) updateUndo(); }
async function redo() { if (await overlay.redo()) updateUndo(); }

// ---------- autosave & recovery ----------
let draftTimer;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(writeDraft, 1200);
}

function formEntries(doc) {
  try {
    const map = doc.annotationStorage.serializable.map;
    return map ? JSON.parse(JSON.stringify([...map])) : [];
  } catch {
    return [];
  }
}

async function writeDraft() {
  if (!state.doc || !state.fp) return;
  if (!state.dirty) { await idb.del("drafts", state.fp); return; }
  await idb.set("drafts", state.fp, {
    name: state.file.name,
    items: overlay.items,
    assets: [...overlay.assets],
    form: state.formDirty ? formEntries(state.doc) : [],
    bytes: overlay.version > 0 ? state.bytes : null,
    updated: Date.now(),
  });
}

async function clearDraft() {
  clearTimeout(draftTimer);
  if (state.fp) await idb.del("drafts", state.fp);
}

// ---------- open ----------
async function askPassword(reason) {
  return new Promise((resolve) => {
    let done = false;
    const input = h("input", { class: "text-input", type: "password", placeholder: "Password", autocomplete: "off" });
    const submit = (api) => { done = true; api.close(); resolve(input.value); };
    const m = modal({
      title: reason === 2 ? "Incorrect password — try again" : "This PDF is password-protected",
      body: h("div", {}, h("p", { class: "muted", style: { marginTop: 0 } }, "Enter the password to open it."), input),
      actions: [{ label: "Cancel", onClick: (api) => api.close() }, { label: "Open", primary: true, onClick: submit }],
      onClose: () => { if (!done) resolve(null); },
      width: 400,
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(m); });
    setTimeout(() => input.focus());
  });
}

async function confirmDiscard() {
  if (!state.dirty) return true;
  const choice = await ask({
    title: "Save changes?",
    message: `You have unsaved changes in “${state.file?.name}”.`,
    buttons: [
      { label: "Don't save", value: "discard" },
      { label: "Cancel", value: null },
      { label: "Save", value: "save", primary: true },
    ],
  });
  if (choice === "save") return await save();
  if (choice === "discard") { await clearDraft(); return true; }
  return false;
}

function looksLikePdf(bytes) {
  return new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF");
}

/** Opens a file in a new tab (or switches to it if it's already open). */
async function openFile(file) {
  if (!file) return;
  if (!looksLikePdf(file.bytes)) { toast(`“${file.name}” doesn't look like a PDF.`); return; }
  const same = file.path && tabs.find((t) => t.state.file?.path?.toLowerCase() === file.path.toLowerCase());
  if (same) { await activateTab(same); toast(`“${file.name}” is already open.`, { timeout: 2000 }); return; }
  busy = true;
  try {
    let doc = await viewer.load(file.bytes, { onPassword: askPassword });
    let password = viewer.lastPassword;
    const fp = doc.fingerprints?.[0] || file.name;
    let bytes = file.bytes;
    toggleReading(false);
    const st = newState();

    // Offer to restore work that was never saved (crash, closed without saving…).
    const draft = await idb.get("drafts", fp);
    let restored = false;
    if (draft?.updated && (draft.items?.length || draft.form?.length || draft.bytes)) {
      const choice = await ask({
        title: "Restore your unsaved changes?",
        message: `Orihada kept your changes to “${file.name}” that were never saved (last edit: ${timeAgo(draft.updated)}).`,
        buttons: [{ label: "Discard them", value: "discard" }, { label: "Restore", value: "restore", primary: true }],
      });
      if (choice === "restore") {
        if (draft.bytes) {
          await doc.loadingTask.destroy();
          bytes = new Uint8Array(draft.bytes);
          doc = await viewer.load(bytes, { password });
        }
        for (const [key, value] of draft.form || []) doc.annotationStorage.setValue(key, value);
        st.formDirty = !!draft.form?.length;
        restored = true;
      } else {
        await idb.del("drafts", fp);
      }
    }

    Object.assign(st, {
      doc, fp, bytes, password, versions: [bytes],
      file: { name: file.name, path: file.path, handle: file.handle },
    });
    const tab = { id: Math.random().toString(36).slice(2), state: st, overlay: makeOverlay(), view: null };
    tabs.splice(activeTab ? tabs.indexOf(activeTab) + 1 : tabs.length, 0, tab);
    await activateTab(tab);
    if (restored) {
      overlay.load(draft.items || [], draft.assets || []);
      scheduleEditsRefresh();
      setDirty(true);
      toast("Your changes were restored.");
    } else {
      setDirty(false);
    }
    updateUndo();
    renderTools();
    selectTab(sidebar.hasOutline ? "outline" : "pages");
    platform.addRecent({ name: file.name, path: file.path, handle: file.handle, pages: doc.numPages });
  } catch (e) {
    if (e?.name === "PasswordException" || /destroy|cancel/i.test(e?.message || "")) return;
    console.error(e);
    toast(`Couldn't open “${file.name}”: ${e.message || e}`, { timeout: 6000 });
  } finally {
    busy = false;
  }
}

/** Shows a loaded pdf.js document in the viewer and refreshes the chrome. */
async function showDoc(doc, pos = null) {
  const st = state;
  st.doc = doc;
  st.pendingPos = pos;
  overlay.detachLayers();
  viewer.show(doc);
  doc.annotationStorage.onSetModified = () => { st.formDirty = true; if (st === state) { setDirty(true); scheduleDraft(); } else st.dirty = true; };
  app.classList.remove("no-doc");
  renderTitle();
  $("#page-count").textContent = `/ ${doc.numPages}`;
  await sidebar.load(doc);
  if (viewer.pagesCount) syncPage(viewer.currentPage);
  renderEdits();
  setupFormBar(doc);
}

/** Reloads the viewer with new bytes (after a page operation), keeping the reader's place. */
async function reloadBytes(bytes, page) {
  const doc = await viewer.load(bytes, { password: state.password });
  const old = state.doc;
  state.bytes = bytes;
  state.formDirty = false;
  await showDoc(doc, { page: Math.max(1, Math.min(page, doc.numPages)), scale: viewer.scaleValue });
  old?.loadingTask.destroy();
  if (!$("#panel-pages").hidden) selectTab("pages");
}

async function loadVersion(v) {
  const bytes = state.versions[v];
  if (bytes) await reloadBytes(bytes, viewer.currentPage);
}

viewer.on("pagesinit", () => {
  const pos = state.pendingPos || prefs.get(`pos:${state.fp}`, null);
  state.pendingPos = null;
  viewer.pdfViewer.spreadMode = prefs.get("spread", 0);
  viewer.scaleValue = pos?.scale || "auto";
  if (pos?.page > 1) viewer.currentPage = pos.page;
  syncPage(viewer.currentPage);
});

function syncPage(n) {
  $("#page-input").value = n;
  $("#btn-prev").disabled = n <= 1;
  $("#btn-next").disabled = n >= viewer.pagesCount;
  sidebar.setCurrentPage(n);
}

viewer.on("pagechanging", ({ pageNumber }) => { syncPage(pageNumber); rememberPosition(); });

viewer.on("scalechanging", ({ scale }) => {
  $("#zoom-btn").textContent = `${Math.round(scale * 100)}%`;
  rememberPosition();
  requestAnimationFrame(positionCtx);
});

let posTimer;
function rememberPosition() {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    if (state.fp) prefs.set(`pos:${state.fp}`, { page: viewer.currentPage, scale: viewer.scaleValue });
  }, 400);
}

// ---------- page tools ----------
async function pageAction(action, indices, extra) {
  if (!state.doc || busy) return;
  const n = state.doc.numPages;
  const what = (k) => (k === 1 ? "page" : `${k} pages`);
  if (action === "extract") return extract(indices);
  if (action === "rotate") return docChange((b) => rotatePages(b, indices, extra), `Rotated ${what(indices.length)}`);
  if (action === "delete") {
    if (indices.length >= n) { toast("A PDF needs at least one page."); return; }
    return docChange((b) => deletePages(b, indices), `Deleted ${what(indices.length)}`);
  }
  if (action === "move") {
    const order = moveOrder(n, indices, extra);
    if (order.every((v, i) => v === i)) return;
    return docChange((b) => reorderPages(b, order), `Moved ${what(indices.length)}`);
  }
  if (action === "insert" || action === "insertFile") {
    const picked = action === "insert" ? await platform.pickPdf()
      : { name: extra.file.name, bytes: new Uint8Array(await extra.file.arrayBuffer()) };
    if (!picked) return;
    if (!looksLikePdf(picked.bytes)) { toast(`“${picked.name}” isn't a PDF.`); return; }
    const at = action === "insert" ? extra : extra.at;
    return docChange((b) => insertPdf(b, picked.bytes, at), `Inserted “${picked.name}”`, at + 1);
  }
}

async function docChange(fn, message, goToPage) {
  busy = true;
  const t = toast("Working…", { timeout: 30000 });
  try {
    const base = state.formDirty ? await state.doc.saveDocument() : state.bytes;
    state.versions[overlay.version] = base; // keep form entries in the version we may undo back to
    const { bytes, map } = await fn(base);
    state.versions = state.versions.slice(0, overlay.version + 1);
    state.versions.push(bytes);
    const cur = viewer.currentPage - 1;
    const page = goToPage || (map[cur] >= 0 ? map[cur] + 1 : Math.min(cur + 1, map.filter((m) => m >= 0).length));
    overlay.remap(map, state.versions.length - 1);
    await reloadBytes(bytes, page);
    t.remove();
    toast(message, { action: "Undo", onAction: undo, timeout: 5000 });
  } catch (e) {
    t.remove();
    console.error(e);
    toast(/encrypt/i.test(e.message) ? "This PDF is protected, so its pages can't be changed." : `Couldn't change pages: ${e.message || e}`, { timeout: 6000 });
  } finally {
    busy = false;
  }
}

async function extract(indices) {
  try {
    const out = await extractPages(await finalBytes(), indices);
    const name = `${state.file.name.replace(/\.pdf$/i, "")} (page${indices.length > 1 ? "s" : ""} ${describeRanges(indices)}).pdf`;
    const res = await platform.saveBytes(out, { name, saveAs: true });
    if (res) toast(`Saved “${res.name}”`);
  } catch (e) {
    console.error(e);
    toast(`Couldn't extract pages: ${e.message || e}`);
  }
}

// ---------- fillable forms ----------
let formWidgets = [];
let bigTextAreas = new Set();
function fixTextAreas() {
  for (const id of bigTextAreas) {
    for (const ta of $$(`#viewer textarea[data-element-id="${CSS.escape(id)}"]`)) ta.style.fontSize = "calc(12px * var(--total-scale-factor))";
  }
}
viewer.on("annotationlayerrendered", () => { if (bigTextAreas.size) fixTextAreas(); });
async function setupFormBar(doc) {
  const bar = $("#formbar");
  bar.hidden = true;
  formWidgets = [];
  bigTextAreas = new Set();
  const WIDGET = 20;
  const widgets = await doc.getAnnotationsByType(new Set([WIDGET]), null).catch(() => null);
  if (!widgets || doc !== state.doc) return;
  // Multi-line fields set to "auto" font size come back sized to the whole box (e.g. 90 pt).
  // Show them at 12 pt, the size other viewers use, so typed text wraps normally.
  bigTextAreas = new Set(widgets.filter((w) => w.multiLine && (w.defaultAppearanceData?.fontSize || 0) > 24).map((w) => w.id));
  fixTextAreas();
  formWidgets = widgets
    .filter((w) => w.id && w.rect && w.pageIndex >= 0 && !w.readOnly && !w.hidden && !w.pushButton && w.fieldType !== "Sig")
    .map((w) => ({ id: w.id, name: w.fieldName, page: w.pageIndex, rect: w.rect }))
    .sort((a, b) => a.page - b.page || (Math.abs(b.rect[3] - a.rect[3]) > 8 ? b.rect[3] - a.rect[3] : a.rect[0] - b.rect[0]));
  if (!formWidgets.length || prefs.get("formbarHidden", false)) return;
  const plain = app.classList.contains("fields-plain");
  const toggle = h("button", { class: "btn" }, plain ? "Show fields" : "Hide field shading");
  toggle.addEventListener("click", () => { app.classList.toggle("fields-plain"); setupFormBar(doc); });
  const close = h("button", { class: "icon-btn", title: "Hide this bar" }, iconEl("x", 16));
  close.addEventListener("click", () => { bar.hidden = true; });
  const names = new Set(formWidgets.map((w) => w.name || w.id)).size;
  bar.replaceChildren(iconEl("text-cursor-input", 18),
    h("span", {}, h("b", {}, "This is a fillable form"), ` — ${names} field${names === 1 ? "" : "s"}. Click a field to type, or press Tab to move between them.`),
    h("span", { class: "grow" }),
    h("button", { class: "btn", onclick: () => nextField() }, "Next field", iconEl("arrow-right", 15)),
    toggle, close);
  bar.hidden = false;
}

let lastFieldId = null;
$("#viewerContainer").addEventListener("focusin", (e) => {
  const id = e.target.closest?.(".annotationLayer [data-element-id]")?.dataset.elementId;
  if (id) lastFieldId = id;
});
// Buttons in the form bar shouldn't steal focus from the field being filled.
$("#formbar").addEventListener("pointerdown", (e) => { if (e.target.closest("button")) e.preventDefault(); });

async function nextField() {
  if (!formWidgets.length) return;
  const curId = document.activeElement?.closest?.("[data-element-id]")?.dataset.elementId || lastFieldId;
  const idx = formWidgets.findIndex((w) => w.id === curId);
  const w = formWidgets[(idx + 1) % formWidgets.length];
  viewer.pdfViewer.scrollPageIntoView({ pageNumber: w.page + 1, destArray: [null, { name: "XYZ" }, w.rect[0] - 40, w.rect[3] + 110, null] });
  for (let i = 0; i < 60; i++) {
    const el = document.querySelector(`.annotationLayer [data-element-id="${w.id}"]`);
    if (el) { el.focus(); return; }
    await new Promise((r) => requestAnimationFrame(r));
  }
}

// ---------- save / print ----------
async function finalBytes({ flatten = false } = {}) {
  let base = state.bytes;
  if (state.formDirty) base = await state.doc.saveDocument();
  if (!overlay.count && !flatten) return base;
  return buildPdf({ bytes: base, items: overlay.exportItems(), assets: overlay.assets, flatten });
}

async function save({ saveAs = false, flatten = false } = {}) {
  if (!state.doc) return false;
  try {
    const bytes = await finalBytes({ flatten });
    const stem = state.file.name.replace(/\.pdf$/i, "");
    const name = flatten ? `${stem} (locked).pdf` : saveAs ? `${stem} (copy).pdf` : state.file.name;
    const res = await platform.saveBytes(bytes, { name, path: state.file.path, handle: state.file.handle, saveAs: saveAs || flatten });
    if (!res) return false;
    if (!saveAs && !flatten) Object.assign(state.file, res);
    setDirty(false);
    await clearDraft();
    toast(`Saved “${res.name}”`);
    platform.addRecent({ name: res.name, path: res.path, handle: res.handle, pages: state.doc.numPages });
    return true;
  } catch (e) {
    console.error(e);
    toast(`Couldn't save: ${e.message || e}`, { timeout: 6000 });
    return false;
  }
}

async function printDialog() {
  if (!state.doc || busy) return;
  busy = true;
  const t = toast("Opening print preview…", { timeout: 60000 });
  try {
    await openPrintWindow({
      bytes: await finalBytes(),
      currentPage: viewer.currentPage,
      native: platform.isDesktop && window.folioNative.print ? window.folioNative : browserPrint,
    });
  } catch (e) {
    console.error(e);
    toast(`Couldn't open print preview: ${e.message || e}`);
  } finally {
    t.remove();
    busy = false;
  }
}

// ---------- sidebar ----------
function selectTab(tab) {
  $$(".side-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#panel-outline").hidden = tab !== "outline";
  $("#panel-pages").hidden = tab !== "pages";
  $("#panel-edits").hidden = tab !== "edits";
  if (tab === "edits") renderEdits();
  if (state.doc) sidebar.setCurrentPage(viewer.currentPage || 1);
}
$$(".side-tab").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));

function toggleSidebar(force) {
  const hidden = force ?? !app.classList.contains("sidebar-hidden");
  app.classList.toggle("sidebar-hidden", hidden);
  prefs.set("sidebarHidden", hidden);
}
toggleSidebar(prefs.get("sidebarHidden", false));

// ---------- search (top bar) ----------
const findInput = $("#find-input");
const searchBox = $("#search-box");
function focusSearch() {
  const s = getSelection().toString().trim();
  if (s && s.length < 80 && !overlay.editingId) { findInput.value = s; runFind(); }
  findInput.focus();
  findInput.select();
}
function runFind() {
  const q = findInput.value;
  searchBox.classList.toggle("has-query", !!q);
  if (q) viewer.find(q);
  else { viewer.clearFind(); $("#find-count").textContent = ""; }
}
function clearFind() {
  findInput.value = "";
  runFind();
  $("#viewerContainer").focus();
}
findInput.addEventListener("input", runFind);
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); if (findInput.value) viewer.find(findInput.value, { again: true, previous: e.shiftKey }); }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); clearFind(); }
});
$("#find-next").addEventListener("click", () => viewer.find(findInput.value, { again: true }));
$("#find-prev").addEventListener("click", () => viewer.find(findInput.value, { again: true, previous: true }));
const showMatches = ({ matchesCount, state: st }) => {
  const el = $("#find-count");
  if (!findInput.value) { el.textContent = ""; return; }
  if (matchesCount?.total) el.textContent = `${matchesCount.current} / ${matchesCount.total}`;
  else if (st !== 3) el.textContent = "No results";
};
viewer.on("updatefindmatchescount", showMatches);
viewer.on("updatefindcontrolstate", showMatches);

// ---------- top bar wiring ----------
$("#btn-sidebar").addEventListener("click", () => toggleSidebar());
$("#btn-prev").addEventListener("click", () => { viewer.currentPage = viewer.currentPage - 1; });
$("#btn-next").addEventListener("click", () => { viewer.currentPage = viewer.currentPage + 1; });
$("#btn-zoom-in").addEventListener("click", () => viewer.zoom(1));
$("#btn-zoom-out").addEventListener("click", () => viewer.zoom(-1));
$("#zoom-btn").addEventListener("click", (e) => {
  const cur = viewer.scaleValue;
  const pct = (v) => ({ label: `${Math.round(v * 100)}%`, checked: cur === String(v), onClick: () => { viewer.scaleValue = String(v); } });
  openMenu(e.currentTarget, [
    { label: "Fit width", icon: "move-horizontal", kbd: "Ctrl+0", checked: cur === "page-width" || cur === "auto", onClick: () => { viewer.scaleValue = "page-width"; } },
    { label: "Fit whole page", icon: "maximize", checked: cur === "page-fit", onClick: () => { viewer.scaleValue = "page-fit"; } },
    "sep",
    ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(pct),
    "sep",
    { label: "Two pages side by side", icon: "book-open", checked: viewer.pdfViewer.spreadMode === 1, onClick: toggleSpread },
    { label: "Dark pages (night reading)", icon: "moon", checked: prefs.get("darkPages", false), onClick: toggleDarkPages },
    { label: "Reading mode (full screen)", icon: "eye", kbd: "F", onClick: () => toggleReading(true) },
  ], { align: "left" });
});

// ---------- command palette ----------
function paletteItems() {
  const hasDoc = !!state.doc;
  const cur = [Math.max(0, viewer.currentPage - 1)];
  const cmd = (label, icon, run, extra = {}) => ({ label, icon, run, group: "Commands", ...extra });
  const items = [
    cmd("Open a PDF…", "folder-open", openPicker, { kbd: "Ctrl+O", keywords: "file load", suggested: !hasDoc }),
  ];
  if (!hasDoc) return items;
  items.push(
    cmd("Add text", "type", () => chooseTool("text"), { kbd: "T", keywords: "type write fill form typewriter", suggested: true }),
    cmd("Sign", "signature", () => chooseTool("sign"), { kbd: "S", keywords: "signature autograph", suggested: true }),
    cmd("Add initials", "pen-line", () => startSignature("initials"), { keywords: "initial sign" }),
    cmd("Check mark", "check", () => chooseTool("check"), { kbd: "K", keywords: "tick checkbox" }),
    cmd("Cross mark", "x", () => chooseTool("cross"), { kbd: "X", keywords: "x mark" }),
    cmd("Today's date", "calendar", () => chooseTool("date"), { keywords: "date stamp" }),
    cmd("Highlight", "highlighter", () => chooseTool("highlight"), { kbd: "H", keywords: "marker annotate" }),
    cmd("Draw", "pencil", () => chooseTool("draw"), { kbd: "D", keywords: "pen ink freehand" }),
    cmd("Whiteout", "eraser", () => chooseTool("whiteout"), { kbd: "W", keywords: "cover hide erase correct" }),
    cmd("Add an image", "image", () => chooseTool("image"), { keywords: "picture photo logo stamp" }),
    cmd("Save", "save", () => save(), { kbd: "Ctrl+S", suggested: true }),
    cmd("Save a copy…", "file-down", () => save({ saveAs: true }), { kbd: "Ctrl+Shift+S", keywords: "save as export duplicate" }),
    cmd("Save locked copy (can't be edited)", "lock", () => save({ flatten: true }), { keywords: "flatten lock final form" }),
    cmd("Print…", "printer", printDialog, { kbd: "Ctrl+P", suggested: true }),
    cmd("Rotate this page right", "rotate-cw", () => pageAction("rotate", cur, 90), { keywords: "turn orientation clockwise" }),
    cmd("Rotate this page left", "rotate-ccw", () => pageAction("rotate", cur, -90), { keywords: "turn orientation counterclockwise" }),
    cmd("Delete this page", "trash-2", () => pageAction("delete", cur), { keywords: "remove page" }),
    cmd("Insert pages from a PDF…", "file-plus", () => pageAction("insert", cur, cur[0] + 1), { keywords: "merge combine add append join" }),
    cmd("Save this page as a new PDF…", "file-output", () => pageAction("extract", cur), { keywords: "extract split separate" }),
    cmd("Manage pages", "layout-grid", () => { toggleSidebar(false); selectTab("pages"); }, { keywords: "thumbnails reorder organize split merge" }),
    cmd("Review my edits", "list-tree", () => { toggleSidebar(false); selectTab("edits"); }, { keywords: "changes annotations list" }),
    cmd("Show chapters", "bookmark", () => { toggleSidebar(false); selectTab("outline"); }, { keywords: "outline bookmarks contents toc sections" }),
    cmd("Search in document", "search", focusSearch, { kbd: "Ctrl+F", keywords: "find text" }),
    cmd("Undo", "undo-2", undo, { kbd: "Ctrl+Z" }),
    cmd("Redo", "redo-2", redo, { kbd: "Ctrl+Y" }),
    cmd("Fit width", "move-horizontal", () => { viewer.scaleValue = "page-width"; }, { kbd: "Ctrl+0", keywords: "zoom" }),
    cmd("Fit whole page", "maximize", () => { viewer.scaleValue = "page-fit"; }, { keywords: "zoom" }),
    cmd("Zoom in", "zoom-in", () => viewer.zoom(1), { kbd: "Ctrl+=" }),
    cmd("Zoom out", "zoom-out", () => viewer.zoom(-1), { kbd: "Ctrl+−" }),
    cmd("Two pages side by side", "book-open", toggleSpread, { keywords: "spread book view dual" }),
    cmd("Dark pages (night reading)", "moon", toggleDarkPages, { keywords: "invert night eye" }),
    cmd("Reading mode (full screen)", "eye", () => toggleReading(true), { kbd: "F", keywords: "fullscreen focus present" }),
    cmd("Show / hide sidebar", "panel-left", () => toggleSidebar(), { kbd: "Ctrl+B" }),
    cmd("Toggle dark theme", "sun", () => { const d = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches); prefs.set("theme", d ? "light" : "dark"); applyTheme(); }, { keywords: "light dark appearance" }),
    cmd("Keyboard shortcuts", "keyboard", showShortcuts, { kbd: "?" }),
    cmd("About Orihada", "info", showAbout, { keywords: "version update license help" }),
  );
  if (formWidgets.length) items.push(cmd("Go to next form field", "text-cursor-input", nextField, { keywords: "fill form tab", suggested: true }));
  items.push(cmd("Close this document", "x", () => closeTab(activeTab), { kbd: "Ctrl+W", keywords: "close tab" }));
  for (const tab of tabs) {
    if (tab === activeTab) continue;
    items.push({ label: tab.state.file.name, icon: "file-text", meta: "open", group: "Switch to", keywords: "tab document switch", suggested: true, run: () => activateTab(tab) });
  }
  for (const e of sidebar.flat) {
    const title = e.row.querySelector(".ol-title")?.textContent;
    if (title && e.page) items.push({ label: title, icon: "bookmark", meta: `p. ${e.page}`, group: "Chapters", run: () => { viewer.currentPage = e.page; } });
  }
  return items;
}

function paletteDynamic(q) {
  const out = [];
  if (!state.doc) return out;
  const n = q.match(/^(?:p(?:age)?\s*)?(\d+)$/i);
  if (n) {
    const p = Math.max(1, Math.min(+n[1], viewer.pagesCount));
    out.push({ label: `Go to page ${p}`, icon: "arrow-right", top: true, group: "Go to", run: () => { viewer.currentPage = p; } });
  }
  if (q.length > 1 && !n) out.push({ label: `Search the document for “${q}”`, icon: "search", group: "Search", run: () => { findInput.value = q; runFind(); } });
  return out;
}

function showPalette() {
  openPalette({ getItems: paletteItems, getDynamic: paletteDynamic });
}
const pageInput = $("#page-input");
pageInput.addEventListener("focus", () => pageInput.select());
pageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const n = parseInt(pageInput.value, 10);
    if (n) viewer.currentPage = n;
    pageInput.value = viewer.currentPage;
    $("#viewerContainer").focus();
  }
  if (e.key === "Escape") { pageInput.value = viewer.currentPage; $("#viewerContainer").focus(); }
});
pageInput.addEventListener("blur", () => { pageInput.value = viewer.currentPage || ""; });

const openPicker = async () => openFile(await platform.pickPdf());
$("#btn-open").addEventListener("click", openPicker);
$("#btn-open-big").addEventListener("click", openPicker);
$("#btn-save").addEventListener("click", () => save());
$("#btn-print").addEventListener("click", printDialog);
$("#btn-undo").addEventListener("click", undo);
$("#btn-redo").addEventListener("click", redo);

$("#btn-more").addEventListener("click", (e) => {
  const theme = prefs.get("theme", "system");
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const hasDoc = !!state.doc;
  const cur = [Math.max(0, viewer.currentPage - 1)];
  openMenu(e.currentTarget, [
    { label: "Find a command…", icon: "command", kbd: "Ctrl+K", onClick: showPalette },
    "sep",
    { label: "Open…", icon: "folder-open", kbd: "Ctrl+O", onClick: openPicker },
    { label: "Save a copy…", icon: "file-down", kbd: "Ctrl+Shift+S", disabled: !hasDoc, onClick: () => save({ saveAs: true }) },
    { label: "Save locked copy (can't be edited)…", icon: "lock", disabled: !hasDoc, onClick: () => save({ flatten: true }) },
    { label: "Print…", icon: "printer", kbd: "Ctrl+P", disabled: !hasDoc, onClick: printDialog },
    "sep",
    { label: "Rotate this page", icon: "rotate-cw", disabled: !hasDoc, onClick: () => pageAction("rotate", cur, 90) },
    { label: "Insert pages from a PDF…", icon: "file-plus", disabled: !hasDoc, onClick: () => pageAction("insert", cur, cur[0] + 1) },
    { label: "Save pages as a new PDF…", icon: "file-output", disabled: !hasDoc, onClick: () => { selectTab("pages"); toast("Pick pages in the Pages panel (Ctrl/Shift-click), then use ⋯ → Save as a new PDF."); } },
    "sep",
    { label: dark ? "Light theme" : "Dark theme", icon: dark ? "sun" : "moon", onClick: () => { prefs.set("theme", dark ? "light" : "dark"); applyTheme(); } },
    { label: "Keyboard shortcuts", icon: "keyboard", kbd: "?", onClick: showShortcuts },
    { label: "About Orihada", icon: "info", onClick: showAbout },
  ]);
});

function showShortcuts() {
  const rows = [
    ["Find any command", "Ctrl+K"],
    ["Open · Save · Print", "Ctrl+O · Ctrl+S · Ctrl+P"],
    ["Next / previous document", "Ctrl+Tab · Ctrl+Shift+Tab"],
    ["Go to document 1–9 · Close document", "Ctrl+1…9 · Ctrl+W"],
    ["Search", "Ctrl+F"],
    ["Go to page", "Ctrl+G"],
    ["Next / previous page", "→ ←  ·  PgDn PgUp"],
    ["First / last page", "Home · End"],
    ["Zoom in / out · Fit width", "Ctrl + = · Ctrl + − · Ctrl+0"],
    ["Show / hide sidebar", "Ctrl+B"],
    ["Undo / Redo", "Ctrl+Z · Ctrl+Y"],
    ["Select · Text · Sign · Draw", "V · T · S · D"],
    ["Highlight · Whiteout · Check · Cross", "H · W · K · X"],
    ["Delete / duplicate selection", "Del · Ctrl+D"],
    ["Nudge selection", "Arrow keys (Shift = 10×)"],
    ["Reading mode (full screen)", "F"],
    ["Finish / back to Select", "Esc"],
  ];
  modal({
    title: "Keyboard shortcuts",
    body: h("div", { style: { display: "grid", gridTemplateColumns: "1fr auto", gap: "10px 24px", padding: "4px 0 12px" } },
      rows.flatMap(([a, b]) => [h("div", {}, a), h("div", { class: "muted", style: { textAlign: "right" } }, b)])),
    width: 520,
  });
}

// ---------- keyboard ----------
function inEditable(e) {
  const t = e.target;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

document.addEventListener("keydown", (e) => {
  if ($("#modal-layer").childElementCount) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === "o") { e.preventDefault(); openPicker(); return; }
  if (mod && k === "k") { e.preventDefault(); showPalette(); return; }
  if (!state.doc) return;
  // Tabs: Ctrl+Tab / Ctrl+PgDn next, Ctrl+Shift+Tab / Ctrl+PgUp previous, Ctrl+1…9, Ctrl+W close.
  if (mod && (e.key === "Tab" || e.key === "PageDown" || e.key === "PageUp")) {
    e.preventDefault();
    cycleTab(e.key === "PageUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1);
    return;
  }
  if (mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    activateTab(e.key === "9" ? tabs.at(-1) : tabs[+e.key - 1]);
    return;
  }
  if (mod && k === "w") { e.preventDefault(); closeTab(activeTab); return; }
  if (mod && k === "s") { e.preventDefault(); save({ saveAs: e.shiftKey }); return; }
  if (mod && k === "p") { e.preventDefault(); printDialog(); return; }
  if (mod && k === "f") { e.preventDefault(); focusSearch(); return; }
  if (mod && k === "g") { e.preventDefault(); pageInput.focus(); return; }
  if (mod && k === "b") { e.preventDefault(); toggleSidebar(); return; }
  if (mod && (k === "=" || k === "+")) { e.preventDefault(); viewer.zoom(1); return; }
  if (mod && k === "-") { e.preventDefault(); viewer.zoom(-1); return; }
  if (mod && k === "0") { e.preventDefault(); viewer.scaleValue = "page-width"; return; }
  if (inEditable(e)) return;
  if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === "y") { e.preventDefault(); redo(); return; }
  if (mod && k === "d") { e.preventDefault(); overlay.duplicateSelected(); return; }
  if (mod || e.altKey) return;
  if (e.target.closest?.("#panel-pages")) return; // page panel handles its own keys

  if (e.key === "Escape") {
    closeMenu();
    if (app.classList.contains("reading")) toggleReading(false);
    else if (overlay.selected) overlay.select(null);
    else if (overlay.tool !== "select") { overlay.setTool("select"); renderTools(); }
    else if (findInput.value) clearFind();
    return;
  }
  if (overlay.selected) {
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); overlay.deleteSelected(); return; }
    const step = e.shiftKey ? 10 : 1;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (arrows[e.key]) { e.preventDefault(); overlay.nudge(...arrows[e.key]); return; }
    if (e.key === "Enter" && overlay.selected.type === "text") { e.preventDefault(); overlay.editText(overlay.selId); return; }
  }
  const container = $("#viewerContainer");
  const noHScroll = container.scrollWidth <= container.clientWidth;
  if (e.key === "ArrowRight" && noHScroll) { e.preventDefault(); viewer.currentPage = viewer.currentPage + 1; return; }
  if (e.key === "ArrowLeft" && noHScroll) { e.preventDefault(); viewer.currentPage = viewer.currentPage - 1; return; }
  if (e.key === "Home") { e.preventDefault(); viewer.currentPage = 1; return; }
  if (e.key === "End") { e.preventDefault(); viewer.currentPage = viewer.pagesCount; return; }
  if (e.key === "?") { showShortcuts(); return; }
  if (k === "f") { e.preventDefault(); toggleReading(); return; }
  const tool = TOOLS.find((t) => t !== "sep" && t.key?.toLowerCase() === k);
  if (tool) { e.preventDefault(); chooseTool(tool.id); }
});

// Ctrl + wheel / pinch zoom around the cursor
$("#viewerContainer").addEventListener("wheel", (e) => {
  if (!e.ctrlKey || !state.doc) return;
  e.preventDefault();
  viewer.zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
}, { passive: false });

// Clicking empty page area deselects
$("#viewerContainer").addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".fo-item") && overlay.selected && !overlay.editingId) overlay.select(null);
});

// ---------- drag & drop to open ----------
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; $("#drop-hint").hidden = !!e.target.closest?.("#panel-pages"); } });
addEventListener("dragover", (e) => {
  e.preventDefault();
  if (hasFiles(e)) $("#drop-hint").hidden = !!e.target.closest?.("#panel-pages");
});
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop-hint").hidden = true; } });
addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#drop-hint").hidden = true;
  const file = await platform.fromDataTransfer(e.dataTransfer);
  if (file) openFile(file);
});

addEventListener("beforeunload", (e) => {
  if (tabs.some((t) => t.state.dirty) && !platform.isDesktop) { writeDraft(); e.preventDefault(); e.returnValue = ""; }
});

// ---------- welcome / recent ----------
async function renderRecent() {
  const list = await platform.listRecent();
  const wrap = $("#recent");
  wrap.replaceChildren();
  const usable = list.filter((r) => r.path || r.handle);
  if (!usable.length) return;
  wrap.append(h("h2", {}, "Recent"));
  for (const r of usable) {
    const b = h("button", { class: "recent-item", title: r.path || r.name },
      iconEl("file-text", 18), h("span", { class: "recent-name" }, r.name),
      h("span", { class: "recent-meta" }, `${r.pages ? `${r.pages} page${r.pages === 1 ? "" : "s"} · ` : ""}${timeAgo(r.opened)}`));
    b.addEventListener("click", async () => {
      const f = await platform.openRecent(r);
      if (f) openFile(f);
      else { toast("That file couldn't be opened — it may have moved."); platform.removeRecent(r.key); renderRecent(); }
    });
    wrap.append(b);
  }
}

// ---------- desktop integration ----------
if (platform.isDesktop) {
  window.folioNative.onOpenFile?.((f) => openFile({ name: f.name, bytes: new Uint8Array(f.bytes), path: f.path }));
  window.folioNative.onCloseRequest?.(async () => {
    // Ask about each document with unsaved changes; any Cancel keeps the window open.
    for (const tab of tabs.filter((t) => t.state.dirty)) {
      await activateTab(tab);
      if (!(await confirmDiscard())) return;
    }
    window.folioNative.confirmClose();
  });
  window.folioNative.ready?.();
}

// ---------- about & updates ----------
const newer = (a, b) => {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
const canUpdate = platform.isDesktop && !!window.folioNative.checkUpdate && !!UPDATE_URL;
const openSite = (url = WEBSITE) => { if (url) window.open(url, "_blank"); };

/** Returns {version, page, notes} when a newer version exists, false when up to date, null on failure. */
async function checkForUpdate() {
  const info = await window.folioNative.checkUpdate().catch(() => null);
  prefs.set("updates.last", Date.now());
  if (!info) return null;
  return newer(info.version, VERSION) ? info : false;
}

function showAbout() {
  const status = h("span", { class: "muted" });
  const auto = h("input", { type: "checkbox" });
  auto.checked = prefs.get("updates.auto", true);
  auto.addEventListener("change", () => prefs.set("updates.auto", auto.checked));
  const checkBtn = h("button", { class: "btn" }, "Check for updates");
  checkBtn.addEventListener("click", async () => {
    checkBtn.disabled = true;
    status.textContent = "Checking…";
    const r = await checkForUpdate();
    checkBtn.disabled = false;
    status.replaceChildren();
    if (r === null) status.textContent = "Couldn't reach the website. Try again later.";
    else if (r === false) status.textContent = "You have the latest version.";
    else status.append(`Orihada ${r.version} is available. `, h("a", { href: "#", onclick: (e) => { e.preventDefault(); openSite(r.page || WEBSITE); } }, "Download"));
  });
  const notices = h("a", { href: "#" }, "Open-source licenses");
  notices.addEventListener("click", async (e) => {
    e.preventDefault();
    const text = await fetch("THIRD_PARTY_NOTICES.txt").then((r) => r.text()).catch(() => "Notices not found.");
    modal({ title: "Open-source licenses", width: 680,
      body: h("pre", { class: "notices" }, text) });
  });
  modal({
    title: "About Orihada",
    width: 460,
    body: h("div", { class: "about" },
      h("div", { class: "about-head" }, h("div", { class: "welcome-mark" }),
        h("div", {}, h("div", { class: "about-name" }, "Orihada"), h("div", { class: "muted" }, `Version ${VERSION}${platform.isDesktop ? "" : " · web"}`))),
      h("p", {}, "A fast, free PDF viewer for reading, filling, signing and organizing PDFs. No accounts, no ads, and your files never leave this computer."),
      canUpdate ? h("div", { class: "about-row" }, checkBtn, status) : null,
      canUpdate ? h("label", { class: "about-check" }, auto, "Tell me when a new version is out (checks the website once a day; sends nothing about you or your files)") : null,
      h("div", { class: "about-links" },
        WEBSITE ? h("a", { href: "#", onclick: (e) => { e.preventDefault(); openSite(); } }, "Website") : null,
        notices)),
  });
}

// One quiet notice per new version, at most one check a day. Never interrupts work.
if (canUpdate && prefs.get("updates.auto", true) && Date.now() - prefs.get("updates.last", 0) > 20 * 3600e3) {
  setTimeout(async () => {
    const r = await checkForUpdate();
    if (!r || prefs.get("updates.dismissed") === r.version) return;
    prefs.set("updates.dismissed", r.version);
    toast(`Orihada ${r.version} is available.`, { action: "Download", onAction: () => openSite(r.page || WEBSITE), timeout: 12000 });
  }, 6000);
}

// Unexpected errors: say so once instead of failing silently. Drafts keep edits safe.
let lastErrorToast = 0;
addEventListener("unhandledrejection", (e) => {
  const err = e.reason;
  if (!err || ["AbortError", "RenderingCancelledException", "AbortException"].includes(err.name)) return;
  console.error(err);
  if (Date.now() - lastErrorToast < 15000) return;
  lastErrorToast = Date.now();
  toast("Something went wrong with that action. Your edits are safe.", { timeout: 5000 });
});

hydrateIcons();
renderTools();
updateUndo();
renderRecent();

// ?file=<same-origin path> opens a file on load (used by the website's "try a sample" link).
const devFile = new URLSearchParams(location.search).get("file");
if (devFile && !platform.isDesktop) {
  const url = new URL(devFile, location.href);
  if (url.origin === location.origin && /\.pdf$/i.test(url.pathname)) {
    fetch(url).then((r) => r.ok ? r.arrayBuffer() : Promise.reject()).then((b) => openFile({ name: decodeURIComponent(url.pathname.split("/").pop()), bytes: new Uint8Array(b) })).catch(() => toast("Couldn't load that sample."));
  }
}

// Handle for debugging from DevTools.
window.folio = {
  get state() { return state; },
  get overlay() { return overlay; },
  get tabs() { return tabs; },
  get activeTab() { return activeTab; },
  viewer, sidebar, save, finalBytes, pageAction, openFile, activateTab, closeTab, printDialog,
};
