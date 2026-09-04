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
  const size = imageSize(buf);
  return { lines: linesOf(data), width: size.width, height: size.height };
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
      pg.lines.forEach((ln, li) => {
        const key = `${pi}:${li}`;
        if (usedLines.has(key)) return;
        const s = score(name, ln.text);
        if (!best || s > best.s) best = { s, pi, li, ln };
      });
      if (best && best.s >= 0.85) break;
    }
    if (!best || best.s < 0.6) { if (log) log(`  locate "${name}": no OCR match (best ${best ? best.s.toFixed(2) : '-'})`); continue; }
    const pg = ocr[best.pi];
    usedLines.add(`${best.pi}:${best.li}`);
    // Extend downward over the description: following lines that start within ~1.6 line-heights
    // and aren't themselves a strong match for some other dish.
    const lh = Math.max(8, best.ln.y1 - best.ln.y0);
    let x0 = best.ln.x0, y0 = best.ln.y0, x1 = best.ln.x1, y1 = best.ln.y1;
    const below = pg.lines.filter((l) => l !== best.ln && l.y0 >= best.ln.y1 - lh * 0.3).sort((a, b) => a.y0 - b.y0);
    for (const l of below) {
      if (l.y0 - y1 > lh * 1.6) break;
      if (items.some((o) => o !== it && score(o.name, l.text) >= 0.6)) break;
      x0 = Math.min(x0, l.x0); x1 = Math.max(x1, l.x1); y1 = Math.max(y1, l.y1);
      if (y1 - y0 > lh * 4.5) break;                      // a description is a few lines, never a column
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
