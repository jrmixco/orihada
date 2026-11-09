// File access abstraction. In the desktop build, `window.folioNative` (from the
// Electron preload) provides real file paths; in a browser we use the File
// System Access API when available and fall back to <input type=file> + download.
import { $ } from "./ui.js";
import { idb } from "./store.js";

const native = window.folioNative || null;
export const isDesktop = !!native;

/** @returns {Promise<{name, bytes: Uint8Array, path?, handle?} | null>} */
export async function pickPdf() {
  if (native) {
    const res = await native.openDialog();
    return res ? { name: res.name, bytes: new Uint8Array(res.bytes), path: res.path } : null;
  }
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "PDF documents", accept: { "application/pdf": [".pdf"] } }],
        excludeAcceptAllOption: false,
      });
      const file = await handle.getFile();
      return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle };
    } catch (e) {
      if (e.name === "AbortError") return null;
    }
  }
  return new Promise((resolve) => {
    const input = $("#file-input");
    input.value = "";
    input.onchange = async () => {
      const file = input.files[0];
      resolve(file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    };
    input.click();
  });
}

export async function fromDataTransfer(dt) {
  const item = [...(dt.items || [])].find((i) => i.kind === "file");
  let handle = null;
  if (item?.getAsFileSystemHandle) {
    try { handle = await item.getAsFileSystemHandle(); } catch { /* not supported */ }
  }
  const file = handle?.kind === "file" ? await handle.getFile() : dt.files[0];
  if (!file) return null;
  const path = native?.pathForFile?.(file) || undefined;
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle: handle?.kind === "file" ? handle : null, path };
}

/**
 * Writes bytes. If `target` (path or handle) is given and saveAs is false, overwrites it.
 * @returns {Promise<{name, path?, handle?} | null>} where it was saved, or null if cancelled.
 */
export async function saveBytes(bytes, { name, path, handle, saveAs = false }) {
  if (native) {
    const target = saveAs || !path ? await native.saveDialog(name, path) : path;
    if (!target) return null;
    await native.writeFile(target, bytes);
    return { name: target.split(/[\\/]/).pop(), path: target };
  }
  if (handle && !saveAs) {
    try {
      if ((await handle.queryPermission?.({ mode: "readwrite" })) !== "granted") {
        if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") throw new Error("denied");
      }
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      return { name: handle.name, handle };
    } catch { /* fall through to Save As */ }
  }
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
      });
      const w = await h.createWritable();
      await w.write(bytes);
      await w.close();
      return { name: h.name, handle: h };
    } catch (e) {
      if (e.name === "AbortError") return null;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { name };
}

// ---- recent files ----
export async function addRecent(entry) {
  const key = entry.path || entry.name;
  const prev = (await idb.get("recent", key)) || {};
  await idb.set("recent", key, { ...prev, ...entry, key, opened: Date.now() });
}

export async function listRecent() {
  const all = (await idb.all("recent")).map((r) => r.value);
  return all.sort((a, b) => b.opened - a.opened).slice(0, 5);
}

export async function removeRecent(key) {
  await idb.del("recent", key);
}

/** Re-open a recent entry. Returns the same shape as pickPdf(), or null. */
export async function openRecent(entry) {
  if (native && entry.path) {
    const res = await native.readFile(entry.path);
    return res ? { name: res.name, bytes: new Uint8Array(res.bytes), path: entry.path } : null;
  }
  if (entry.handle) {
    try {
      if ((await entry.handle.queryPermission?.({ mode: "read" })) !== "granted") {
        if ((await entry.handle.requestPermission({ mode: "read" })) !== "granted") return null;
      }
      const file = await entry.handle.getFile();
      return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle: entry.handle };
    } catch {
      return null;
    }
  }
  return null;
}
