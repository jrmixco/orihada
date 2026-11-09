// Command palette (Ctrl+K): type what you want — a command, a page number,
// a chapter name — instead of hunting through menus.
import { h, iconEl } from "./ui.js";

let open = null;

function score(text, words) {
  const t = text.toLowerCase();
  let s = 0;
  for (const w of words) {
    const i = t.indexOf(w);
    if (i < 0) return -1;
    s += i === 0 ? 3 : /\s|\W/.test(t[i - 1]) ? 2 : 1;
  }
  return s;
}

/**
 * @param {() => Array<{label, icon, kbd?, keywords?, group?, run}>} getItems
 * @param {(query: string) => Array} getDynamic  items computed from the query (page numbers, search)
 */
export function openPalette({ getItems, getDynamic, placeholder = "Type a command, page number or chapter…" }) {
  if (open) { open.input.focus(); return; }
  const input = h("input", { class: "pal-input", placeholder, autocomplete: "off", spellcheck: "false", "aria-label": "Command" });
  const list = h("div", { class: "pal-list", role: "listbox" });
  const box = h("div", { class: "pal", role: "dialog", "aria-label": "Command palette" },
    h("div", { class: "pal-head" }, iconEl("command", 18), input, h("kbd", {}, "Esc")), list);
  const layer = h("div", { class: "pal-layer" }, box);
  document.body.append(layer);
  let results = [];
  let active = 0;
  const all = getItems();

  const render = () => {
    const q = input.value.trim();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const dyn = getDynamic(q);
    let matched;
    if (!words.length) matched = all.filter((i) => i.suggested);
    else {
      matched = all
        .map((i) => ({ i, s: score(`${i.label} ${i.keywords || ""}`, words) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40)
        .map((x) => x.i);
    }
    results = [...dyn.filter((d) => d.top), ...matched, ...dyn.filter((d) => !d.top)];
    active = Math.min(active, Math.max(0, results.length - 1));
    list.replaceChildren();
    let lastGroup = null;
    results.forEach((r, idx) => {
      const group = r.group || "";
      if (group && group !== lastGroup) list.append(h("div", { class: "pal-group" }, group));
      lastGroup = group;
      const row = h("div", { class: `pal-item ${idx === active ? "active" : ""}`, role: "option", "aria-selected": idx === active ? "true" : "false" },
        iconEl(r.icon || "chevron-right", 16), h("span", { class: "pal-label" }, r.label),
        r.meta ? h("span", { class: "pal-meta" }, r.meta) : null,
        r.kbd ? h("kbd", {}, r.kbd) : null);
      row.addEventListener("mousemove", () => { if (active !== idx) { active = idx; paint(); } });
      row.addEventListener("click", () => run(idx));
      list.append(row);
    });
    if (!results.length) list.append(h("div", { class: "pal-empty" }, "No matching commands"));
  };
  const paint = () => {
    [...list.querySelectorAll(".pal-item")].forEach((el, i) => {
      el.classList.toggle("active", i === active);
      el.setAttribute("aria-selected", i === active ? "true" : "false");
    });
    list.querySelector(".pal-item.active")?.scrollIntoView({ block: "nearest" });
  };
  const close = () => { layer.remove(); open = null; document.removeEventListener("keydown", onKey, true); };
  const run = (idx) => {
    const r = results[idx];
    if (!r) return;
    close();
    setTimeout(() => r.run(), 0);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % Math.max(1, results.length); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + results.length) % Math.max(1, results.length); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); run(active); }
  };
  document.addEventListener("keydown", onKey, true);
  input.addEventListener("input", () => { active = 0; render(); });
  layer.addEventListener("pointerdown", (e) => { if (e.target === layer) close(); });
  render();
  input.focus();
  open = { input, close };
}
