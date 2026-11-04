import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { NEGATED_RELATION } from '../src/formula-latex.js';


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

/**
 * Relations a TeX negation slash turns into their negated form.
 *
 * Computer Modern prints ≠ as two glyphs: a zero-width slash from the symbol
 * font (cmsy position 0x36, which every PDF here maps to the digit "6") laid
 * over the relation. Read as text, x ≠ 0 came out "x 6 = 0": a digit that is
 * not printed, and the relation without its negation. Measured on the 2023
 * exercise book and the three answer keys: 676 zero-width "6"s, 658 of them
 * over "=", most of the rest over ≡, ∼, → and −. A recogniser reads the print
 * as ≠, and the strict formula rule read "6=" against it as a conflict.
 */
const NEGATED = NEGATED_RELATION;   // the table formula-latex.js reads \not with

/**
 * Zero-width glyphs TeX overlays on the glyph after them, and what the pair
 * reads as: the negation slash (as "6", or as U+0338 where a font maps it), and
 * the stem of ↦ (cmsy 0x37, read as "7") before an arrow.
 */
const OVERLAY = { '6': NEGATED, '̸': NEGATED, '7': { '→': '↦' } };

/**
 * How far below a radical sign's baseline its radicand's baseline lies, as a
 * fraction of the sign's size.
 *
 * TeX hangs a radical from its top, where it meets the vinculum: the sign's
 * baseline sits near its top and the glyph hangs below it. Measured on the
 * same four books, the radicand starts exactly where the sign ends for 1,201
 * of 1,222 radicals, its baseline lower by 0.72 to 1.11 of the sign's size for
 * the middle 80% of them (median 0.83). Grouped by baseline, the sign joined
 * whatever row lay near its top, or none, and √(x+1) read x+1.
 */
const RADICAL_DROP = [0.3, 2.5];

/**
 * Glyphs the text layer places apart from the symbol they belong to, put back.
 *
 * - A zero-width overlay merges into the relation it is drawn over (≠, ≢, ↦).
 * - A zero-width vector arrow (U+20D7) is dropped: the letter is printed and
 *   the arrow drawn, which is how formula-latex.js reads \vec{a}.
 * - A radical sign moves onto its radicand's baseline, and the index of an
 *   n-th root, small in the crook of the sign, moves there too, before the
 *   sign — so \sqrt[n]{x} reads n√x, as formula-latex.js writes it.
 *
 * Items are {text, x, y, width, height} as groupTextRows places them; the
 * result is the same list with merged overlays removed.
 */
export function readMarks(placed) {
  const kept = new Set(placed);
  const advance = (item) => item.width > 0.05 * item.height;
  for (const mark of placed) {
    const text = mark.text.trim();
    if (advance(mark)) continue;
    if (text === '⃗') { kept.delete(mark); continue; }
    const table = OVERLAY[text];
    if (!table) continue;
    const under = placed
      .filter(other => other !== mark && kept.has(other) && advance(other)
        && Math.abs(other.y - mark.y) <= 0.3 * mark.height
        && other.x >= mark.x - 0.6 && other.x <= mark.x + 0.9 * mark.height)
      .sort((a, b) => Math.abs(a.x - mark.x) - Math.abs(b.x - mark.x))[0];
    if (!under) continue;
    const lead = under.text.trimStart();
    const key = Object.keys(table).find(k => lead.startsWith(k));
    if (!key) continue;
    under.text = table[key] + lead.slice(key.length);
    kept.delete(mark);
  }
  for (const sign of placed) {
    if (!kept.has(sign) || sign.text.trim() !== '√') continue;
    const end = sign.x + sign.width;
    const radicand = placed
      .filter(other => other !== sign && kept.has(other) && Math.abs(other.x - end) <= 1
        && other.y - sign.y >= RADICAL_DROP[0] * sign.height
        && other.y - sign.y <= RADICAL_DROP[1] * sign.height)
      .sort((a, b) => a.y - b.y)[0];
    if (!radicand) continue;
    for (const index of placed) {
      if (index === sign || index === radicand || !kept.has(index)) continue;
      if (index.height > SCRIPT_SIZE * sign.height) continue;
      // In the crook: overlapping the sign's left part, between its top and
      // the radicand's baseline. A script of the item before the sign ends
      // before the sign begins, and stays where it is.
      if (index.x + index.width <= sign.x + 0.1 || index.x >= sign.x + 0.6 * sign.width) continue;
      if (index.y <= sign.y - 0.2 * sign.height || index.y >= radicand.y) continue;
      index.y = radicand.y;
      index.x = sign.x - 0.01;
    }
    sign.y = radicand.y;
  }
  return placed.filter(item => kept.has(item));
}

export function groupTextItems(items, pageNumber, viewport, includeGeometry) {
  return groupTextRows(items, viewport)
    .map(row => {
      const line = { page: pageNumber, text: row.items.map(item => item.text).join(' ').trim() };
      if (!includeGeometry) return line;
      return { ...line, y: row.y, height: row.height };
    })
    .filter(line => line.text);
}

/**
 * The rows of a page, each with its items in reading order.
 *
 * The same grouping groupTextItems reads lines from, exposed for tools that
 * need the items themselves — their positions and widths — rather than the
 * joined text. An item is {text, x, y, width, height} in page points with the
 * origin at the top-left; y is the baseline.
 */
export function groupTextRows(items, viewport) {
  const placed = readMarks(items
    .filter(item => typeof item.str === 'string' && item.str.trim())
    .map(item => ({
      text: item.str,
      x: item.transform?.[4] ?? 0,
      y: viewport.height - (item.transform?.[5] ?? 0),
      width: Math.max(item.width ?? 0, 0),
      height: Math.max(Math.abs(item.height ?? item.transform?.[3] ?? 0), 1),
    })))
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
    .map((row) => {
      row.items.sort((a, b) => a.x - b.x);
      return row;
    });
}


async function resolveOutline(document) {
  const raw = await document.getOutline();
  if (!raw?.length) return { available: false, items: [] };

  // Page heights, for turning a destination's PDF-space top (origin at the
  // bottom of the page) into the top-origin coordinate the text lines use.
  const heights = new Map();
  const pageHeight = async (pageNumber) => {
    if (!heights.has(pageNumber)) {
      const page = await document.getPage(pageNumber);
      heights.set(pageNumber, page.getViewport({ scale: 1 }).height);
    }
    return heights.get(pageNumber);
  };

  const convert = async (item) => {
    let destination = item.dest;
    if (typeof destination === 'string') destination = await document.getDestination(destination);

    let pageNumber = null;
    let top = null;
    if (Array.isArray(destination) && destination[0]) {
      try { pageNumber = (await document.getPageIndex(destination[0])) + 1; } catch { /* unresolved */ }
      // Where on the page the bookmark points. /XYZ carries [left, top, zoom],
      // /FitH and /FitBH carry [top]; the rest name a page and nothing finer.
      // A bookmark's position is what bounds a question on a page the book
      // prints no parseable heading for — a scan read by a formula recogniser
      // has nothing else.
      const kind = destination[1]?.name;
      const raw = kind === 'XYZ' ? destination[3]
        : (kind === 'FitH' || kind === 'FitBH') ? destination[2] : null;
      if (pageNumber && Number.isFinite(raw)) {
        try { top = (await pageHeight(pageNumber)) - raw; } catch { /* leave null */ }
      }
    }

    return {
      title: String(item.title ?? '').trim(),
      pageNumber,
      ...(Number.isFinite(top) ? { top: Number(top.toFixed(2)) } : {}),
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
