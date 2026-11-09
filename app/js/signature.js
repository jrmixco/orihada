// Signature / initials creator: draw, type or upload; saved signatures are
// stored locally (IndexedDB) and offered first next time.
import { h, modal, iconEl } from "./ui.js";
import { idb } from "./store.js";

const INKS = [["#111111", "Black"], ["#1f3a93", "Blue"]];
const SCRIPT_FONTS = ["Great Vibes", "Dancing Script", "Caveat"];

export async function listSaved(kind) {
  const all = (await idb.all("signatures")).map((r) => r.value);
  return all.filter((s) => !kind || s.kind === kind).sort((a, b) => b.created - a.created);
}

export async function deleteSaved(id) { await idb.del("signatures", id); }

/** Crops transparent margins. Returns {canvas, w, h} or null if empty. */
function trim(canvas, pad = 6) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function drawPad(getColor) {
  const wrap = h("div", { class: "sig-pad" },
    h("div", { class: "baseline" }), h("div", { class: "sig-x" }, "×"),
    h("div", { class: "sig-ph" }, "Sign here with your mouse, pen or finger"));
  const canvas = h("canvas");
  wrap.append(canvas);
  let ctx, dpr, empty = true, last = null, lastW = 2.5;
  const fit = () => {
    dpr = Math.max(2, devicePixelRatio || 1);
    canvas.width = wrap.clientWidth * dpr;
    canvas.height = wrap.clientHeight * dpr;
    ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.lineCap = ctx.lineJoin = "round";
  };
  requestAnimationFrame(fit);
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp }; };
  canvas.addEventListener("pointerdown", (e) => {
    if (!ctx) fit();
    canvas.setPointerCapture(e.pointerId);
    last = pos(e);
    lastW = e.pointerType === "pen" && e.pressure ? 1 + e.pressure * 3 : 2.6;
    ctx.fillStyle = getColor();
    ctx.beginPath(); ctx.arc(last.x, last.y, lastW / 2, 0, Math.PI * 2); ctx.fill();
    if (empty) { empty = false; wrap.querySelector(".sig-ph").hidden = true; wrap.dispatchEvent(new Event("change")); }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!last) return;
    for (const ce of e.getCoalescedEvents?.() || [e]) {
      const p = pos(ce);
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      if (dist < 0.8) continue;
      const v = dist / Math.max(1, p.t - last.t);
      const target = ce.pointerType === "pen" && ce.pressure ? 1 + ce.pressure * 3.2 : Math.max(1.2, Math.min(3.4, 3.6 - v * 1.1));
      const w = lastW + (target - lastW) * 0.35;
      ctx.strokeStyle = getColor();
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      const mx = (last.x + p.x) / 2, my = (last.y + p.y) / 2;
      ctx.quadraticCurveTo(last.x, last.y, mx, my);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p; lastW = w;
    }
  });
  const end = () => { last = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  return {
    el: wrap,
    get empty() { return empty; },
    clear() { ctx?.clearRect(0, 0, canvas.width, canvas.height); empty = true; wrap.querySelector(".sig-ph").hidden = false; },
    recolor(color) {
      if (!ctx || empty) return;
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-in"; ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    },
    export() { return trim(canvas, 8); },
  };
}

function renderTyped(text, font, color) {
  const size = 120;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = `${size}px "${font}"`;
  const w = Math.ceil(ctx.measureText(text).width) + size;
  c.width = w; c.height = size * 2;
  ctx.font = `${size}px "${font}"`;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size);
  return trim(c, 10);
}

async function imageToSignature(file, removeBg) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 1600 / img.width);
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if (removeBg) {
      const d = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) {
        const lum = (d.data[i] * 0.3 + d.data[i + 1] * 0.59 + d.data[i + 2] * 0.11);
        if (lum > 200) d.data[i + 3] = 0;
        else if (lum > 150) d.data[i + 3] = Math.round(d.data[i + 3] * (200 - lum) / 50);
      }
      ctx.putImageData(d, 0, 0);
    }
    return trim(c, 4);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Opens the signature dialog. Resolves with { src, w, h, kind } or null.
 * @param {"signature"|"initials"} kind
 */
export function openSignatureDialog(kind = "signature") {
  return new Promise(async (resolve) => {
    let resolved = false;
    const finish = (result, m) => { resolved = true; m.close(); resolve(result); };
    const noun = kind === "initials" ? "initials" : "signature";
    let color = INKS[0][0];
    let mode = "draw";
    let typedFont = SCRIPT_FONTS[0];
    let uploaded = null;

    const saved = await listSaved(kind);
    const body = h("div");
    if (saved.length) {
      body.append(h("div", { class: "section-label" }, `Your saved ${noun}s — click to use`));
      const row = h("div", { class: "saved-sigs" });
      for (const s of saved) {
        const del = h("button", { class: "del", title: "Delete" }, iconEl("x", 12));
        const card = h("div", { class: "saved-sig", title: `Use this ${noun}` }, h("img", { src: s.src, alt: `Saved ${noun}` }), del);
        card.addEventListener("click", () => finish({ src: s.src, w: s.w, h: s.h, kind }, m));
        del.addEventListener("click", async (e) => { e.stopPropagation(); await deleteSaved(s.id); card.remove(); });
        row.append(card);
      }
      body.append(row, h("div", { class: "section-label" }, `Or create a new ${noun}`));
    }

    const tabs = h("div", { class: "tabs-inline" });
    const panes = {};
    const pad = drawPad(() => color);
    const typeInput = h("input", { class: "text-input", placeholder: kind === "initials" ? "Your initials" : "Type your full name", autocomplete: "name" });
    const choices = h("div", { class: "font-choices" });
    const renderChoices = () => {
      choices.replaceChildren(...SCRIPT_FONTS.map((f) => {
        const b = h("button", { class: `font-choice ${f === typedFont ? "on" : ""}`, style: { fontFamily: `"${f}"`, color } }, typeInput.value || (kind === "initials" ? "AB" : "Your Name"));
        b.addEventListener("click", () => { typedFont = f; renderChoices(); });
        return b;
      }));
    };
    typeInput.addEventListener("input", renderChoices);
    renderChoices();

    const fileIn = h("input", { type: "file", accept: "image/png,image/jpeg", hidden: true });
    const removeBg = h("input", { type: "checkbox", checked: true });
    const drop = h("div", { class: "upload-drop" }, h("div", {}, iconEl("upload", 22), h("div", { style: { marginTop: "8px" } }, "Click to choose a photo or scan of your signature"), h("div", { style: { fontSize: "12px", marginTop: "4px", color: "var(--faint)" } }, "PNG or JPG")));
    const loadUpload = async () => {
      if (!fileIn.files[0]) return;
      uploaded = await imageToSignature(fileIn.files[0], removeBg.checked);
      drop.replaceChildren(uploaded ? h("img", { src: uploaded.toDataURL("image/png"), alt: "" }) : h("div", {}, "Couldn't read that image"));
    };
    drop.addEventListener("click", () => fileIn.click());
    fileIn.addEventListener("change", loadUpload);
    removeBg.addEventListener("change", loadUpload);

    panes.draw = h("div", {}, pad.el);
    panes.type = h("div", {}, typeInput, choices);
    panes.upload = h("div", {}, drop, fileIn, h("label", { class: "check-row" }, removeBg, "Remove white background"));

    const inkRow = h("div", { class: "sig-tools" });
    const swatches = h("div", { class: "swatches" });
    const paintSwatches = () => swatches.replaceChildren(...INKS.map(([c, name]) => {
      const b = h("button", { class: `swatch ${c === color ? "on" : ""}`, style: { background: c }, title: name, "aria-label": `${name} ink` });
      b.addEventListener("click", () => { color = c; pad.recolor(c); paintSwatches(); renderChoices(); });
      return b;
    }));
    paintSwatches();
    const clearBtn = h("button", { class: "btn ghost" }, "Clear");
    clearBtn.addEventListener("click", () => pad.clear());
    const saveBox = h("input", { type: "checkbox", checked: true });
    inkRow.append(swatches, h("span", { class: "grow" }), h("label", { class: "check-row", style: { margin: 0 } }, saveBox, `Save for next time`), clearBtn);

    for (const [id, label] of [["draw", "Draw"], ["type", "Type"], ["upload", "Upload"]]) {
      const b = h("button", { class: id === mode ? "active" : "" }, label);
      b.addEventListener("click", () => {
        mode = id;
        [...tabs.children].forEach((x) => x.classList.toggle("active", x === b));
        Object.entries(panes).forEach(([k, p]) => (p.hidden = k !== mode));
        clearBtn.hidden = mode !== "draw";
        swatches.style.visibility = mode === "upload" ? "hidden" : "";
        if (mode === "type") typeInput.focus();
      });
      tabs.append(b);
    }
    panes.type.hidden = panes.upload.hidden = true;
    body.append(tabs, panes.draw, panes.type, panes.upload, inkRow);

    const m = modal({
      title: kind === "initials" ? "Add initials" : "Add your signature",
      body,
      width: 580,
      onClose: () => { if (!resolved) resolve(null); },
      actions: [
        { label: "Cancel", onClick: (api) => api.close() },
        {
          label: `Place ${noun}`, primary: true,
          onClick: async () => {
            let canvas = null;
            if (mode === "draw") canvas = pad.empty ? null : pad.export();
            else if (mode === "type") {
              if (!typeInput.value.trim()) { typeInput.focus(); return; }
              await document.fonts.load(`40px "${typedFont}"`);
              canvas = renderTyped(typeInput.value.trim(), typedFont, color);
            } else canvas = uploaded;
            if (!canvas) return;
            const result = { src: canvas.toDataURL("image/png"), w: canvas.width, h: canvas.height, kind };
            if (saveBox.checked) {
              const id = `s${Date.now()}`;
              await idb.set("signatures", id, { id, ...result, created: Date.now() });
            }
            finish(result, m);
          },
        },
      ],
    });
  });
}
