import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';


const workerUrl = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url);
const cmapUrl = new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url);
const fontsUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url);

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.href;


/**
 * How far off a row's baseline a smaller item may sit and still be its script,
 * as a fraction of the row's font size.
 *
 * Measured on the 2024 algebra exercise book: body text at 10.5 pt puts its
 * subscripts 1.6 pt below the baseline and its superscripts 4.4 pt above it,
 * both at 7 pt — 0.15 and 0.42 of the font size. The limits of a display ∏
 * sit 12–13 pt away (1.2 and above), and are a separate line by any reading.
 * 0.7 sits between the two with room on both sides.
 *
 * Before this the row tolerance was 2.5 pt absolute, which caught subscripts
 * and missed every superscript: the exponents of a whole line assembled into a
 * row of their own ("n − 1 n − 2 n n n − 1 n") and the line lost them. On the
 * strict formula rule that read x^2 against x^3 — a conflict — and withheld
 * correct matches.
 */
const SCRIPT_REACH = 0.7;

/** An item this much smaller than its row is a script candidate, not text. */
const SCRIPT_SIZE = 0.8;

/**
 * How far a script may start after the end of the item it follows, as a
 * fraction of the row's font size, and how far it may overlap it.
 *
 * A superscript or subscript FOLLOWS its base: the 3 of x^3 starts where the
 * x ends. The subscript of lim, the bounds of a display ∫ and the index of a
 * ∑ sit under or over theirs, overlapping horizontally. Measured on the 2024
 * analysis pair, attaching by baseline distance alone put those under whichever
 * fraction row happened to be closer, which differed between the two books
 * and withheld sixteen correct matches while resolving eight. Adjacency
 * separates the two cases: an exponent is adjacent, a limit is not.
 */
const SCRIPT_GAP = 0.4;
const SCRIPT_OVERLAP = 0.5;

/** Bases whose small neighbours are bounds, not scripts: ∫_a^b, ∑_{k=1}^n, lim_{x→0}. */
const OPERATOR_BASE = /[∫∑∏∬∭∮]|^\s*(lim|max|min|sup|inf)\s*$/;

/** The absolute baseline tolerance for items of the same size. */
const ROW_TOLERANCE = 2.5;

export function groupTextItems(items, pageNumber, viewport, includeGeometry) {
  const placed = items
    .filter(item => typeof item.str === 'string' && item.str.trim())
    .map(item => ({
      text: item.str,
      x: item.transform?.[4] ?? 0,
      y: viewport.height - (item.transform?.[5] ?? 0),
      width: Math.max(item.width ?? 0, 0),
      height: Math.max(Math.abs(item.height ?? item.transform?.[3] ?? 0), 1),
    }))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  // Pass 1: rows of items on the same baseline.
  const rows = [];
  for (const item of placed) {
    const row = rows.find(candidate => Math.abs(candidate.y - item.y) <= ROW_TOLERANCE);
    if (row) {
      row.items.push(item);
      row.y = Math.min(row.y, item.y);
      row.height = Math.max(row.height, item.height);
    } else {
      rows.push({ y: item.y, height: item.height, items: [item] });
    }
  }
  for (const row of rows) {
    row.x0 = Math.min(...row.items.map(i => i.x));
    row.x1 = Math.max(...row.items.map(i => i.x + i.width));
  }

  // Pass 2: a smaller item just above or below a larger row, starting where
  // one of that row's items ends, is a script of that item. Items are taken in
  // x order so a script can follow a script ("n − 1" after x), and each is
  // judged on its own, because a small row can hold the subscripts of one line
  // and the superscripts of the next.
  rows.sort((a, b) => a.y - b.y);
  const merged = new Set();
  // A script FOLLOWS a base item and sits in the whitespace after it, before
  // the next item of the line begins. The second half matters as much as the
  // first: the x under lim also starts just after the word before lim, but it
  // sits under lim itself, and a script never sits under its line's own text.
  const follows = (item, host) => host.items.some((base) => {
    // The bounds of a large operator sit beside it exactly as a script would,
    // and the two books typeset them differently enough that attaching them
    // agreed on neither side. They stay on their own line, as before.
    if (OPERATOR_BASE.test(base.text)) return false;
    const gap = item.x - (base.x + base.width);
    if (gap > SCRIPT_GAP * host.height || gap < -SCRIPT_OVERLAP * item.width) return false;
    const next = host.items
      .filter(other => other !== base && other.x > base.x)
      .sort((a, b) => a.x - b.x)[0];
    return !next || item.x + item.width <= next.x + SCRIPT_OVERLAP * item.width;
  });
  for (const row of rows) {
    const hosts = rows.filter(other => other !== row && !merged.has(other)
      && row.height <= SCRIPT_SIZE * other.height
      && Math.abs(other.y - row.y) <= SCRIPT_REACH * other.height);
    if (hosts.length === 0) continue;
    const kept = [];
    for (const item of [...row.items].sort((a, b) => a.x - b.x)) {
      const host = hosts
        .filter(h => follows(item, h))
        .sort((a, b) => Math.abs(a.y - row.y) - Math.abs(b.y - row.y))[0];
      if (host) host.items.push(item);
      else kept.push(item);
    }
    row.items = kept;
    if (kept.length === 0) merged.add(row);
  }

  return rows
    .filter(row => !merged.has(row))
    .sort((a, b) => a.y - b.y)
    .map(row => {
      row.items.sort((a, b) => a.x - b.x);
      const line = { page: pageNumber, text: row.items.map(item => item.text).join(' ').trim() };
      if (!includeGeometry) return line;
      return { ...line, y: row.y, height: row.height };
    })
    .filter(line => line.text);
}


async function resolveOutline(document) {
  const raw = await document.getOutline();
  if (!raw?.length) return { available: false, items: [] };

  const convert = async (item) => {
    let destination = item.dest;
    if (typeof destination === 'string') destination = await document.getDestination(destination);

    let pageNumber = null;
    if (Array.isArray(destination) && destination[0]) {
      try { pageNumber = (await document.getPageIndex(destination[0])) + 1; } catch { /* unresolved */ }
    }

    return {
      title: String(item.title ?? '').trim(),
      pageNumber,
      children: await Promise.all((item.items ?? []).map(convert)),
    };
  };

  return { available: true, items: await Promise.all(raw.map(convert)) };
}


/**
 * Opens a PDF as the small document interface Find-Engine already consumes.
 * PDF.js is deliberately confined to this demo adapter; src/ stays dependency-free.
 */
export async function openPdfDocument(filePath, { includeGeometry = true } = {}) {
  const bytes = await readFile(filePath);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // Filesystem PATHS, not file:// URLs. Under Node, pdf.js reads CMaps and
    // standard fonts with fs.readFile, which rejects a "file://..." string —
    // and pdf.js swallows that rejection, so every CID-keyed CJK font then
    // decodes to garbage while extraction reports success. Measured: the 2023
    // exercise book extracted with 0.0% Han through the URL form and 23%
    // through the path form, same file, same page.
    cMapUrl: fileURLToPath(cmapUrl),
    cMapPacked: true,
    standardFontDataUrl: fileURLToPath(fontsUrl),
    useSystemFonts: false,
    isEvalSupported: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  const document = await loadingTask.promise;
  const outline = await resolveOutline(document);
  const pages = new Map();

  const pageLines = async (pageNumber) => {
    if (pages.has(pageNumber)) return pages.get(pageNumber);
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = groupTextItems(content.items, pageNumber, viewport, includeGeometry);
    pages.set(pageNumber, lines);
    page.cleanup();
    return lines;
  };

  return {
    name: basename(filePath),
    sourcePath: filePath,
    numPages: document.numPages,
    outline,
    async extractText({ from = 1, to = document.numPages } = {}) {
      const lines = [];
      for (let page = Math.max(1, from); page <= Math.min(document.numPages, to); page++) {
        lines.push(...await pageLines(page));
      }
      return lines;
    },
    async destroy() {
      pages.clear();
      await loadingTask.destroy();
    },
  };
}
