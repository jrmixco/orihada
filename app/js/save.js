// Produces the output PDF: form values (via pdf.js) + overlay items flattened
// into page content (via pdf-lib).
import { MARK_PATHS, FONTS } from "./overlay.js";

const {
  PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle, LineJoinStyle,
  pushGraphicsState, popGraphicsState, setLineWidth, setStrokingRgbColor, setLineCap, setLineJoin,
  moveTo, lineTo, stroke,
} = window.PDFLib;

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function dataUrlBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Content-frame → user-space mapper for an item (top-left origin, y down). */
function frame(item) {
  const r = (item.rot * Math.PI) / 180;
  const ex = [Math.cos(r), Math.sin(r)]; // content +x in user space
  const dn = [Math.sin(r), -Math.cos(r)]; // content "down" in user space
  return (cx, cy) => [item.ux + cx * ex[0] + cy * dn[0], item.uy + cx * ex[1] + cy * dn[1]];
}

/** Renders a text item to a PNG (used when the text has characters standard fonts can't encode). */
function textToPng(item) {
  const k = 4;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  const font = `${item.size * k}px ${FONTS[item.font].css}`;
  ctx.font = font;
  const lines = item.text.split("\n");
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
  c.width = Math.ceil(w + 2 * k);
  c.height = Math.ceil(lines.length * item.size * 1.2 * k);
  ctx.font = font;
  ctx.fillStyle = item.color;
  ctx.textBaseline = "alphabetic";
  lines.forEach((l, i) => ctx.fillText(l, 0, (i * 1.2 + item.baseline) * item.size * k));
  return { bytes: dataUrlBytes(c.toDataURL("image/png")), w: c.width / k, h: c.height / k };
}

/**
 * @param {object} o
 * @param {Uint8Array} o.bytes  Base PDF bytes (already including form values).
 * @param {Array} o.items       Overlay items from Overlay.exportItems().
 * @param {Map} o.assets        Overlay assets.
 * @param {boolean} [o.flatten] Flatten form fields so they can't be changed.
 */
export async function buildPdf({ bytes, items, assets, flatten = false }) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const fonts = {};
  const getFont = async (key) => (fonts[key] ||= await doc.embedFont(StandardFonts[FONTS[key].std]));
  const images = new Map();
  const getImage = async (src) => {
    if (!images.has(src)) images.set(src, await doc.embedPng(dataUrlBytes(src)));
    return images.get(src);
  };

  for (const item of items) {
    const page = pages[item.page];
    if (!page) continue;
    const at = frame(item);
    const rotate = degrees(item.rot);

    if (item.type === "text") {
      const font = await getFont(item.font);
      let encodable = true;
      try { font.encodeText(item.text.replace(/\n/g, "")); } catch { encodable = false; }
      if (encodable) {
        item.text.split("\n").forEach((line, i) => {
          if (!line) return;
          const [x, y] = at(0, (i * 1.2 + item.baseline) * item.size);
          page.drawText(line, { x, y, size: item.size, font, color: hexToRgb(item.color), rotate });
        });
      } else {
        const png = textToPng(item);
        const img = await doc.embedPng(png.bytes);
        const [x, y] = at(0, png.h);
        page.drawImage(img, { x, y, width: png.w, height: png.h, rotate });
      }
    } else if (item.type === "image") {
      const img = await getImage(assets.get(item.asset).src);
      const [x, y] = at(0, item.h);
      page.drawImage(img, { x, y, width: item.w, height: item.h, rotate });
    } else if (item.type === "rect") {
      const [x, y] = at(0, item.h);
      page.drawRectangle({
        x, y, width: item.w, height: item.h, rotate, color: hexToRgb(item.color),
        opacity: item.opacity ?? 1, blendMode: item.blend === "multiply" ? BlendMode.Multiply : undefined,
      });
    } else if (item.type === "hl") {
      for (const [rx, ry, rw, rh] of item.rects) {
        const [x, y] = at(rx, ry + rh);
        page.drawRectangle({ x, y, width: rw, height: rh, rotate, color: hexToRgb(item.color), opacity: 0.45, blendMode: BlendMode.Multiply });
      }
    } else if (item.type === "mark" && item.mark === "dot") {
      const [x, y] = at(item.w / 2, item.h / 2);
      page.drawEllipse({ x, y, xScale: item.w / 4, yScale: item.h / 4, color: hexToRgb(item.color) });
    } else if (item.type === "ink" || item.type === "mark") {
      const sx = item.w / item.vw, sy = item.h / item.vh;
      const strokes = item.type === "ink" ? item.paths : MARK_PATHS[item.mark];
      const width = (item.type === "ink" ? item.width : 2.6) * Math.min(sx, sy);
      const c = hexToRgb(item.color);
      const ops = [pushGraphicsState(), setStrokingRgbColor(c.red, c.green, c.blue), setLineWidth(width),
        setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round)];
      for (const pts of strokes) {
        pts.forEach(([px, py], i) => {
          const [x, y] = at(px * sx, py * sy);
          ops.push(i ? lineTo(x, y) : moveTo(x, y));
        });
        if (pts.length === 1) { const [x, y] = at(pts[0][0] * sx + 0.01, pts[0][1] * sy); ops.push(lineTo(x, y)); }
        ops.push(stroke());
      }
      ops.push(popGraphicsState());
      page.pushOperators(...ops);
    }
  }

  if (flatten) {
    try { doc.getForm().flatten(); } catch (e) { console.warn("Flatten failed", e); }
  }
  return doc.save();
}
