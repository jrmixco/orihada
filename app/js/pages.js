// Page operations (free here, paywalled elsewhere): rotate, delete, reorder,
// insert pages from another PDF, extract. Each structural op returns new bytes
// plus `map[oldIndex] = newIndex | -1` so edits can follow their pages.
const { PDFDocument, degrees } = window.PDFLib;

const load = (bytes) => PDFDocument.load(bytes, { updateMetadata: false });
const identity = (n) => Array.from({ length: n }, (_, i) => i);

export async function rotatePages(bytes, indices, delta) {
  const doc = await load(bytes);
  for (const i of indices) {
    const p = doc.getPage(i);
    p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
  }
  return { bytes: await doc.save(), map: identity(doc.getPageCount()) };
}

export async function deletePages(bytes, indices) {
  const doc = await load(bytes);
  const n = doc.getPageCount();
  const del = new Set(indices);
  if (del.size >= n) throw new Error("A PDF needs at least one page.");
  [...del].sort((a, b) => b - a).forEach((i) => doc.removePage(i));
  let k = 0;
  const map = identity(n).map((i) => (del.has(i) ? -1 : k++));
  return { bytes: await doc.save(), map };
}

/** Reorders pages: `order` lists old indices in their new order. */
export async function reorderPages(bytes, order) {
  const doc = await load(bytes);
  const pages = doc.getPages();
  for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
  order.forEach((old, k) => doc.insertPage(k, pages[old]));
  const map = [];
  order.forEach((old, k) => { map[old] = k; });
  return { bytes: await doc.save(), map };
}

/** Moves `indices` so they start at position `target` (index in the original order, before removal). */
export function moveOrder(count, indices, target) {
  const moving = [...indices].sort((a, b) => a - b);
  const set = new Set(moving);
  const rest = identity(count).filter((i) => !set.has(i));
  const insertAt = rest.filter((i) => i < target).length;
  rest.splice(insertAt, 0, ...moving);
  return rest;
}

export async function insertPdf(bytes, otherBytes, at) {
  const doc = await load(bytes);
  const src = await PDFDocument.load(otherBytes, { ignoreEncryption: true });
  const copied = await doc.copyPages(src, src.getPageIndices());
  copied.forEach((p, k) => doc.insertPage(at + k, p));
  const n = doc.getPageCount() - copied.length;
  const map = identity(n).map((i) => (i < at ? i : i + copied.length));
  return { bytes: await doc.save(), map, added: copied.length };
}

export async function extractPages(bytes, indices) {
  const doc = await load(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, [...indices].sort((a, b) => a - b));
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

/** Parses "1-3, 5, 8-" style ranges (1-based) into sorted 0-based indices. */
export function parseRanges(text, count) {
  const out = new Set();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : count;
      for (let i = Math.max(1, a); i <= Math.min(count, b); i++) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = +part;
      if (n >= 1 && n <= count) out.add(n - 1);
    } else {
      return null;
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function describeRanges(indices) {
  const parts = [];
  for (let i = 0; i < indices.length; i++) {
    let j = i;
    while (j + 1 < indices.length && indices[j + 1] === indices[j] + 1) j++;
    parts.push(i === j ? `${indices[i] + 1}` : `${indices[i] + 1}-${indices[j] + 1}`);
    i = j;
  }
  return parts.join(", ");
}
