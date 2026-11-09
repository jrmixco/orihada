// Small DOM helpers: element builder, icons, toasts, menus, modals.
import { icon } from "./icons.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function iconEl(name, size) {
  const span = document.createElement("span");
  span.innerHTML = icon(name, size);
  return span.firstChild;
}

export function hydrateIcons(root = document) {
  for (const el of $$("[data-icon]", root)) {
    if (el.dataset.hydrated) continue;
    el.dataset.hydrated = "1";
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon, Number(el.dataset.size) || 18));
  }
}

export function toast(message, { action, onAction, timeout = 3200 } = {}) {
  const el = h("div", { class: "toast", role: "status" }, h("span", {}, message));
  if (action) {
    el.append(h("button", { onclick: () => { onAction?.(); el.remove(); } }, action));
  }
  $("#toasts").append(el);
  setTimeout(() => el.remove(), timeout);
  return el;
}

let openMenuEl = null;
export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}

/** Opens a dropdown menu under `anchor`. items: {label, icon, kbd, onClick, disabled} | "sep" */
export function openMenu(anchor, items, { align = "right" } = {}) {
  closeMenu();
  const menu = h("div", { class: "menu", role: "menu" });
  for (const it of items) {
    if (it === "sep") { menu.append(h("div", { class: "menu-sep" })); continue; }
    if (it.header) { menu.append(h("div", { class: "section-label", style: { margin: "6px 10px 4px" } }, it.header)); continue; }
    if (it.img) {
      const b = h("button", { class: "menu-sig", role: "menuitem", title: it.label }, h("img", { src: it.img, alt: it.label }));
      b.addEventListener("click", () => { closeMenu(); it.onClick?.(); });
      menu.append(b);
      continue;
    }
    const btn = h("button", { class: `menu-item ${it.danger ? "danger" : ""} ${it.checked ? "checked" : ""}`, role: "menuitem", disabled: it.disabled },
      it.icon ? iconEl(it.icon, 16) : h("span", { style: { width: "16px" } }),
      h("span", { class: "grow" }, it.label),
      it.kbd ? h("kbd", {}, it.kbd) : null,
      it.checked ? iconEl("check", 15) : null);
    btn.addEventListener("click", () => { closeMenu(); it.onClick?.(); });
    menu.append(btn);
  }
  $("#menu-layer").append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = align === "right" ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
  openMenuEl = menu;
  menu.querySelector("button:not([disabled])")?.focus({ preventScroll: true });
  menu.addEventListener("keydown", (e) => {
    const btns = [...menu.querySelectorAll("button:not([disabled])")];
    const i = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); anchor.focus?.(); }
  });
  setTimeout(() => {
    const off = (e) => {
      if (!menu.contains(e.target)) { closeMenu(); document.removeEventListener("pointerdown", off, true); }
    };
    document.addEventListener("pointerdown", off, true);
  });
  return menu;
}

/** Shows a modal dialog. Returns { el, close }. */
export function modal({ title, body, actions = [], onClose, width }) {
  const layer = $("#modal-layer");
  const box = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title });
  if (width) box.style.width = `min(${width}px, 100%)`;
  const closeBtn = h("button", { class: "icon-btn", title: "Close (Esc)" }, iconEl("x"));
  box.append(h("div", { class: "modal-head" }, h("h2", {}, title), closeBtn));
  box.append(h("div", { class: "modal-body" }, body));
  const foot = h("div", { class: "modal-foot" });
  for (const a of actions) {
    const b = h("button", { class: `btn ${a.primary ? "primary" : ""} ${a.danger ? "danger" : ""}` }, a.label);
    b.addEventListener("click", () => a.onClick?.(api));
    if (a.id) b.id = a.id;
    foot.append(b);
  }
  if (actions.length) box.append(foot);
  layer.replaceChildren(box);
  const prevFocus = document.activeElement;
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); api.close(); } };
  document.addEventListener("keydown", onKey, true);
  const api = {
    el: box,
    close() {
      document.removeEventListener("keydown", onKey, true);
      box.remove();
      onClose?.();
      prevFocus?.focus?.({ preventScroll: true });
    },
  };
  closeBtn.addEventListener("click", () => api.close());
  layer.addEventListener("pointerdown", function bg(e) {
    if (e.target === layer) { layer.removeEventListener("pointerdown", bg); api.close(); }
  });
  return api;
}

/** Promise-based confirm with custom buttons. Resolves with the chosen value or null. */
export function ask({ title, message, buttons }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: h("p", { style: { margin: "4px 0 6px", color: "var(--muted)", lineHeight: "1.5" } }, message),
      actions: buttons.map((b) => ({ ...b, onClick: (api) => { done = true; api.close(); resolve(b.value); } })),
      onClose: () => { if (!done) resolve(null); },
      width: 440,
    });
    m.el.querySelector(".btn.primary")?.focus();
  });
}

export function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}
