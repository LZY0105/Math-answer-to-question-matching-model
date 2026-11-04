#!/usr/bin/env node
// Formula regions of a PDF page, from its text layer.
//
// A formula recogniser reads one crop at a time. On a scan the host decides
// where the crops are; on a book with a text layer the layer already says
// where the mathematics is, which makes it the ground truth for the detector
// and the oracle for the recogniser: each region carries the text the layer
// holds there, read through the same PDF.js adapter the demo uses, so it
// decodes every glyph the adapter decodes.
//
// A region is a run of text items on one row that reads as mathematics: it
// contains no CJK prose, it has at least two items, and at least one of them
// is a letter, an operator or a maths symbol. Pure numerals — a label "1.1", a
// year "2023", a page number — are not regions, because a recogniser cropped
// on a formula would not be handed them, and a question's label must not leak
// into its content.
//
// Output: JSON lines in PDF points, origin at the top-left of the page, the
// coordinate space the adapter reports lines in. Each row has the box and the
// layer's text; ocr/ocr_pages.py --regions crops the same boxes for the model.
//
//   {"page": 4, "bbox": [x0, top, x1, bottom], "text": "f ( x ) = x 2 + 1", "items": 7}
//
// Usage:
//   node tools/formula-regions.mjs --pdf BOOK.pdf --out regions.jsonl [--pages 4-20] [--all-text]
//   node tools/formula-regions.mjs --pdf SPLIT.pdf --map SPLIT-map.json --out regions.jsonl
//
// Text a page's clips hide is never read as printed: the adapter replays the
// clip state and keeps only painted text (pageTextItems), which is what the
// 2024 留白 books need. --all-text reads every glyph instead. The second form
// reads the split ocr/clip_windows.py writes, which reaches the same text by
// another route and is kept to cross-check the first.

import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { groupTextRows, pageTextLayout } from '../demo/pdfjs-document-adapter.mjs';

const cmapUrl = new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url);
const fontsUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url);

const CJK = /[一-鿿　-〿＀-￯]/u;
const MATHY = /[A-Za-z+\-−*/=^_<>|∫∑∏√±×÷≤≥≠∞→∈∂πθαβγδελμσφω′·]/u;
const NUMERAL_ONLY = /^[\d.．,，()（）\s]+$/u;
/** Running heads and footers live here; measured on the 2023 and 2024 books. */
const MARGIN = 0.06;
/** A gap wider than this, in points, separates two formulas on one row. */
const RUN_GAP = 24;

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pdf') o.pdf = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--pages') o.pages = argv[++i];
    else if (a === '--map') o.map = argv[++i];
    else if (a === '--all-text') o.allText = true;
    else throw new Error(`unrecognised argument: ${a}`);
  }
  if (!o.pdf || !o.out) throw new Error('--pdf and --out are required');
  return o;
}

function pageList(spec, count) {
  if (!spec) return Array.from({ length: count }, (_, i) => i + 1);
  const out = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Math.min(Number(m[2]), count) : a;
    for (let p = a; p <= b; p++) if (p >= 1 && p <= count) out.push(p);
  }
  return out;
}

/** Runs of adjacent items on one row that read as mathematics. */
export function formulaRuns(row, pageHeight) {
  const items = [...row.items].sort((a, b) => a.x - b.x);
  const runs = [];
  let current = [];
  const flush = () => { if (current.length) runs.push(current); current = []; };
  let right = null;
  for (const item of items) {
    const prose = CJK.test(item.text);
    if (prose || (right !== null && item.x - right > RUN_GAP)) flush();
    if (!prose) current.push(item);
    right = Math.max(right ?? -Infinity, item.x + item.width);
  }
  flush();
  const out = [];
  for (const run of runs) {
    if (run.length < 2) continue;
    const text = run.map(i => i.text).join(' ').trim();
    if (!MATHY.test(text) || NUMERAL_ONLY.test(text)) continue;
    // An item the adapter assembled or moved (a fraction, a limit's
    // subscript) carries the box it is printed in; the crop must hold that.
    const boxOf = (i) => i.box ?? [i.x, i.y - i.height, i.x + i.width, i.y + 0.3 * i.height];
    const x0 = Math.min(...run.map(i => boxOf(i)[0]));
    const x1 = Math.max(...run.map(i => boxOf(i)[2]));
    const top = Math.min(...run.map(i => boxOf(i)[1]));
    const bottom = Math.max(...run.map(i => boxOf(i)[3]));
    if (top < pageHeight * MARGIN || bottom > pageHeight * (1 - MARGIN)) continue;
    out.push({ bbox: [x0 - 2, top - 1, x1 + 2, bottom + 1].map(v => Number(v.toFixed(2))), text, items: run.length });
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await readFile(opts.pdf)),
    cMapUrl: fileURLToPath(cmapUrl), cMapPacked: true, standardFontDataUrl: fileURLToPath(fontsUrl),
    useSystemFonts: false, isEvalSupported: false, useWorkerFetch: false, verbosity: 0,
  }).promise;
  // With --map the PDF is a split made by ocr/clip_windows.py: each copy draws
  // one clipped form, an item is printed only if it lies inside that copy's
  // window, and regions are reported on the original page.
  const copies = opts.map ? JSON.parse(await readFile(opts.map, 'utf-8')).copies : null;
  const sink = createWriteStream(opts.out, { flags: 'wx' });
  let regions = 0;
  let hidden = 0;
  const pages = pageList(opts.pages, doc.numPages);
  for (const number of pages) {
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const copy = copies ? copies[number - 1] : null;
    const layout = await pageTextLayout(page, { clipAware: !opts.allText });
    let items = layout.items;
    if (copy?.window) {
      const [x0, top, x1, bottom] = copy.window;
      items = items.filter((it) => {
        const h = Math.abs(it.height ?? it.transform?.[3] ?? 0);
        const cx = (it.transform?.[4] ?? 0) + (it.width ?? 0) / 2;
        const cy = viewport.height - (it.transform?.[5] ?? 0) - h / 2;
        const inside = cx >= x0 - 1 && cx <= x1 + 1 && cy >= top - 1 && cy <= bottom + 1;
        if (!inside && String(it.str ?? '').trim()) hidden++;
        return inside;
      });
    }
    const reported = copy ? copy.page : number;
    for (const row of groupTextRows(items, viewport, layout.rules)) {
      for (const region of formulaRuns(row, viewport.height)) {
        sink.write(JSON.stringify({ page: reported, ...region }) + '\n');
        regions++;
      }
    }
    page.cleanup();
  }
  await new Promise((resolve) => sink.end(resolve));
  await doc.destroy();
  console.log(JSON.stringify({ pages: pages.length, regions, ...(copies ? { hiddenItemsDropped: hidden } : {}) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
