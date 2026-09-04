// Menu dish localisation — snaps each dish the model read to the exact printed line on the photo.
//
// The vision model is asked for a bounding box per dish, but its boxes are estimates: in practice
// they land a row or two off and sometimes span the whole page width. OCR (tesseract.js — pure
// WASM, no native build, so it deploys in the same container) gives the true position of every
// line of text; we fuzzy-match the dish name against those lines and, when we find it, replace the
// model's guess with the real line box (plus the description lines that hang under it). When OCR
// can't find the name, the model's estimate stays and the app treats it as approximate.
//
// Boxes are returned on the same 0–1000 grid the model uses, so nothing downstream changes.
const Tesseract = require('tesseract.js');

let workerPromise = null;
function worker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', 1, { logger: () => {} })
      .catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

/** Flatten tesseract's block→paragraph→line tree into [{text, x0,y0,x1,y1}] in pixels. */
function linesOf(data) {
  const out = [];
  const push = (l) => { if (l && l.text && l.bbox) out.push({ text: String(l.text).trim(), ...l.bbox }); };
  if (Array.isArray(data.lines) && data.lines.length) data.lines.forEach(push);
  else for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) push(l);
  return out.filter((l) => l.text);
}

/** Every text line on a page, with the page's pixel size. Cached per call site by the caller. */
async function ocrPage(base64) {
  const w = await worker();
  const buf = Buffer.from(base64, 'base64');
  const { data } = await w.recognize(buf, {}, { blocks: true, text: false });
  // Image size comes from the union of line boxes only as a last resort — tesseract reports it
  // on the result in newer builds; fall back to probing the JPEG/PNG header.
  // tesseract.js decodes with EXIF orientation applied (verified: a portrait photo stored as
  // rotated pixels + orientation 6 yields the same upright boxes as the upright file), so the line
  // boxes are already in the frame every viewer shows. Only the header-reported pixel size is raw,
  // so swap it for the sideways orientations.
  const size = imageSize(buf);
  const o = exifOrientation(buf);
  const sideways = o >= 5 && o <= 8;
  const width = sideways ? size.height : size.width, height = sideways ? size.width : size.height;
  return { lines: linesOf(data), width, height, orientation: o };
}

/** EXIF orientation (1–8) from a JPEG's APP1 segment; 1 when absent or unreadable. Tesseract reads
 *  raw pixels and ignores this, while every viewer (and the vision model) shows the image upright —
 *  so a phone photo taken in portrait would otherwise get its boxes in a rotated frame. */
function exifOrientation(buf) {
  try {
    if (!(buf[0] === 0xff && buf[1] === 0xd8)) return 1;
    let i = 2;
    while (i + 4 < buf.length && buf[i] === 0xff) {
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m === 0xe1 && buf.toString('ascii', i + 4, i + 10) === 'Exif\0\0') {
        const t = i + 10;                                   // TIFF header
        const le = buf.toString('ascii', t, t + 2) === 'II';
        const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        const ifd = t + r32(t + 4);
        const n = r16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
        }
        return 1;
      }
      if (m === 0xda) break;                                // start of scan — no EXIF ahead
      i += 2 + len;
    }
  } catch { /* fall through */ }
  return 1;
}

function imageSize(buf) {
  // JPEG: walk markers for SOF0/2. PNG: IHDR.
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* fall through */ }
  return { width: 0, height: 0 };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter((t) => t.length > 1);

/** 0–1 similarity between a dish name and an OCR line: share of the name's tokens present in the
 *  line (allowing one-character OCR slips), penalised when the line is mostly other text. */
function score(name, line) {
  const a = tokens(name), b = tokens(line);
  if (!a.length || !b.length) return 0;
  const near = (x, y) => x === y || (x.length > 3 && y.length > 3 && (x.startsWith(y.slice(0, -1)) || y.startsWith(x.slice(0, -1))));
  const hit = a.filter((t) => b.some((u) => near(t, u))).length;
  const recall = hit / a.length;
  const precision = hit / b.length;
  return recall * 0.75 + precision * 0.25;
}

/**
 * items: model output [{ name, page, box }], pages: [{ base64 }]. Mutates each item: on a confident
 * OCR match sets box (0–1000) + box_source 'ocr'; otherwise leaves the model box, box_source 'model'.
 */
async function locateDishes(items, pages, log) {
  const ocr = [];
  for (let i = 0; i < pages.length; i++) {
    try { ocr[i] = await ocrPage(pages[i].base64); }
    catch (e) { ocr[i] = null; if (log) log('ocr failed on page', i + 1, String(e && e.message || e)); }
  }
  const usedLines = new Set();
  for (const it of items) {
    it.box_source = it.box ? 'model' : undefined;
    const name = it.name;
    let best = null;
    // Prefer the page the model said; fall back to every page.
    const order = [];
    const p = Number(it.page) - 1;
    if (ocr[p]) order.push(p);
    ocr.forEach((o, i) => { if (o && i !== p) order.push(i); });
    for (const pi of order) {
      const pg = ocr[pi];
      if (!pg || !pg.width || !pg.height) continue;
      // The model's own estimate breaks ties: on a menu with three "Chicken ..." lines the one
      // nearest where the reader saw it wins. Small weight — never enough to beat a better text match.
      const mb = Array.isArray(it.box) && it.box.length >= 4 && Number(it.page) - 1 === pi
        ? { cx: (Number(it.box[0]) + Number(it.box[2])) / 2000, cy: (Number(it.box[1]) + Number(it.box[3])) / 2000 } : null;
      pg.lines.forEach((ln, li) => {
        const key = `${pi}:${li}`;
        if (usedLines.has(key)) return;
        let s = score(name, ln.text);
        if (s > 0 && mb) {
          const cy = (ln.y0 + ln.y1) / 2 / pg.height, cx = (ln.x0 + ln.x1) / 2 / pg.width;
          s += 0.08 * Math.max(0, 1 - Math.hypot(cx - mb.cx, cy - mb.cy) / 0.35);
        }
        if (!best || s > best.s) best = { s, pi, li, ln };
      });
      if (best && best.s >= 0.85) break;
    }
    // A two-word name with both words found is a match even if OCR garbled the rest of the line;
    // a long name needs most of its words. Below that we'd rather show the model's rough zone than
    // outline the wrong dish with confidence.
    const need = tokens(name).length <= 2 ? 0.7 : 0.6;
    if (!best || best.s < need) { if (log) log(`  locate "${name}": no OCR match (best ${best ? best.s.toFixed(2) : '-'})`); continue; }
    const pg = ocr[best.pi];
    usedLines.add(`${best.pi}:${best.li}`);
    // A name that wraps onto a second line ("Grilled Chicken" / "Salad 18"): if the very next line
    // completes the match, it is part of the title, not the description.
    {
      const lh0 = Math.max(8, best.ln.y1 - best.ln.y0);
      const nxt = pg.lines.filter((l) => l !== best.ln && l.y0 >= best.ln.y1 - lh0 * 0.3 && l.y0 - best.ln.y1 < lh0 * 1.2
        && Math.min(l.x1, best.ln.x1) - Math.max(l.x0, best.ln.x0) > 0).sort((a, b) => a.y0 - b.y0)[0];
      if (nxt && score(name, `${best.ln.text} ${nxt.text}`) > score(name, best.ln.text) + 0.15) {
        usedLines.add(`${best.pi}:${pg.lines.indexOf(nxt)}`);
        best = { ...best, ln: { text: `${best.ln.text} ${nxt.text}`, x0: Math.min(best.ln.x0, nxt.x0), y0: best.ln.y0, x1: Math.max(best.ln.x1, nxt.x1), y1: nxt.y1 } };
      }
    }
    // Extend downward over the description — and ONLY the description. Stop at anything that reads
    // as the next entry: a line as tall as the title (another dish name), a line ending in a price,
    // a line matching some other dish, a line that doesn't sit under this one (another column), or
    // a gap bigger than a line and a half.
    const lh = Math.max(8, best.ln.y1 - best.ln.y0);
    const tw = Math.max(1, best.ln.x1 - best.ln.x0);
    let x0 = best.ln.x0, y0 = best.ln.y0, x1 = best.ln.x1, y1 = best.ln.y1;
    const overlapsX = (l) => Math.min(l.x1, best.ln.x1) - Math.max(l.x0, best.ln.x0) > Math.min(tw, l.x1 - l.x0) * 0.4;
    const priceLike = (t) => /(?:[$£€]\s?\d+(?:[.,]\d{1,2})?|\b\d{1,3}(?:[.,]\d{2})?)\s*$/.test(String(t).trim());
    const below = pg.lines.filter((l) => l !== best.ln && l.y0 >= best.ln.y1 - lh * 0.3 && overlapsX(l)).sort((a, b) => a.y0 - b.y0);
    let descLines = 0;
    for (const l of below) {
      if (l.y0 - y1 > lh * 1.5) break;
      if (priceLike(l.text)) break;                       // a price ends an entry, it never starts a description
      if (items.some((o) => o !== it && score(o.name, l.text) >= 0.5)) break;
      x0 = Math.min(x0, l.x0); x1 = Math.max(x1, l.x1); y1 = Math.max(y1, l.y1);
      if (++descLines >= 3) break;                        // descriptions are a line or three, never a column
    }
    const g = (v, d) => Math.max(0, Math.min(1000, Math.round((v / d) * 1000)));
    it.page = best.pi + 1;
    it.box = [g(x0, pg.width), g(y0, pg.height), g(x1, pg.width), g(y1, pg.height)];
    it.box_source = 'ocr';
    if (log) log(`  locate "${name}" → p${it.page} [${it.box.join(',')}] via "${best.ln.text}" (${best.s.toFixed(2)})`);
  }
  return items;
}

module.exports = { locateDishes, ocrPage, score };
