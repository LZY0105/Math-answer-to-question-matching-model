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

/**
 * Fractions rebuilt from their bars.
 *
 * A display fraction prints its numerator and denominator on baselines of
 * their own, 0.68 of the type size above and below the main one (measured on
 * the 2023 exercise book), so the rows read "a n = 1 + + · · · + − ln n" with
 * the 1/2 and the 1/n on lines of their own, and a crop of the main row cuts
 * both in half. A recogniser reads \frac{1}{2} and formula-latex.js writes
 * 1/2. The bar is drawn, not typed, and the operator list has it
 * (paintedRules): a numerator is what sits over the bar and is centred on it,
 * a denominator what sits under it. The fraction becomes one item reading
 * "( a ) / ( b )", bracketed as formula-latex.js brackets, on the main
 * baseline, with a box spanning both, so the crop holds the whole fraction.
 * Inner fractions are rebuilt first; a radical's vinculum, which starts where
 * its sign ends, is not a fraction bar.
 */
export function readFractions(placed, rules = []) {
  if (!rules?.length) return placed;
  let items = [...placed];
  // Where an item's ink ends: pdf.js counts a trailing space in its width.
  const right = (i) => {
    const text = String(i.text);
    const ink = text.trimEnd().length;
    return i.x + (ink && ink < text.length ? i.width * (ink / text.length) : i.width);
  };
  const centre = (list) => (Math.min(...list.map(i => i.x)) + Math.max(...list.map(right))) / 2;
  // A numerator or a denominator is a core on one baseline near the bar, and
  // the scripts of that core: an exponent sits above the core's baseline, out
  // of reach of the bar, and is still part of it.
  const withScripts = (core, pool, side) => {
    if (!core.length) return core;
    const base = core.map(i => i.y).sort((a, b) => a - b)[Math.floor(core.length / 2)];
    const size = Math.max(...core.map(i => i.height));
    const scripts = pool.filter(i => !core.includes(i) && i.height <= SCRIPT_SIZE * size
      && i.y >= base - 0.75 * size && i.y <= base + 0.35 * size && side(i));
    return [...core, ...scripts];
  };
  const extent = (list) => Math.max(...list.map(right)) - Math.min(...list.map(i => i.x));
  const wrap = (t) => (t.replace(/\s+/gu, '').length > 1 ? `( ${t} )` : t);
  const read = (list) => [...list].sort((a, b) => (a.x - b.x) || (a.y - b.y)).map(i => i.text.trim()).join(' ');
  for (const bar of [...rules].sort((a, b) => (a.x1 - a.x0) - (b.x1 - b.x0))) {
    const span = bar.x1 - bar.x0;
    const vinculum = items.some(i => i.text.trim() === '√' && Math.abs(right(i) - bar.x0) <= 1.5
      && bar.y >= i.y - 1.5 * i.height && bar.y <= i.y + i.height);
    if (vinculum) continue;
    const over = items.filter(i => i.x >= bar.x0 - 1.5 && right(i) <= bar.x1 + 1.5);
    const num = withScripts(over.filter(i => bar.y - i.y >= 0.1 * i.height && bar.y - i.y <= 0.9 * i.height),
      over, i => i.y < bar.y);
    const den = withScripts(over.filter(i => i.y - bar.y >= 0.3 * i.height && i.y - bar.y <= 1.4 * i.height),
      over, i => i.y > bar.y);
    if (!num.length || !den.length) continue;
    if (Math.max(extent(num), extent(den)) < 0.6 * span) continue;
    const middle = (bar.x0 + bar.x1) / 2;
    if (Math.abs(centre(num) - middle) > 0.2 * span + 1 || Math.abs(centre(den) - middle) > 0.2 * span + 1) continue;
    const parts = [...num, ...den];
    const height = Math.max(...parts.map(i => i.height));
    const x0 = Math.min(bar.x0, ...parts.map(i => i.x));
    const x1 = Math.max(bar.x1, ...parts.map(right));
    const boxOf = (i) => i.box ?? [i.x, i.y - i.height, right(i), i.y + 0.3 * i.height];
    const fraction = {
      text: `${wrap(read(num))} / ${wrap(read(den))}`,
      x: x0,
      y: bar.y + 0.25 * height,
      width: x1 - x0,
      height,
      box: [x0, Math.min(...num.map(i => boxOf(i)[1])), x1, Math.max(...den.map(i => boxOf(i)[3]))],
    };
    const used = new Set(parts);
    items = items.filter(i => !used.has(i));
    items.push(fraction);
  }
  return items;
}

/** Operators whose display limits sit under them and read after them: lim_{x→0} reads lim x→0. */
const LIMIT_OPERATOR = /^(lim|lim sup|lim inf|limsup|liminf|max|min|sup|inf)$/u;

/**
 * A limit's subscript moved onto the operator's line, after it.
 *
 * Display limits sit under the operator, 0.6 of its size below (0.4 to 0.86
 * on the 2023 exercise book), and on a baseline they often share with the
 * denominator of the fraction that follows — "x → 0 sin 2 x" read as one row
 * under "lim". A recogniser reads \lim_{x\to 0} and formula-latex.js writes
 * limx→0. The subscript keeps its box, so a crop still holds it where it is
 * printed. Run after readFractions, which takes the denominators first.
 */
export function readLimits(placed) {
  for (const op of placed) {
    if (!LIMIT_OPERATOR.test(op.text.trim())) continue;
    const below = placed.filter(i => i !== op && i.height <= SCRIPT_SIZE * op.height
      && i.y - op.y >= 0.3 * op.height && i.y - op.y <= 1.0 * op.height);
    // The subscript's main line is its largest item under the operator; its
    // own scripts (the + of 0⁺) sit off that line and belong to it.
    const under = below
      .filter(i => i.x < op.x + op.width + 1 && i.x + i.width > op.x - 1)
      .sort((a, b) => (b.height - a.height) || (a.y - b.y))[0];
    if (!under) continue;
    const row = below.filter(i => Math.abs(i.y - under.y) <= 0.5 * under.height).sort((a, b) => a.x - b.x);
    // The contiguous run of that row which includes the item under the operator.
    const at = row.indexOf(under);
    let lo = at; let hi = at;
    const gap = (a, b) => b.x - (a.x + a.width) <= 0.5 * Math.max(a.height, b.height);
    while (lo > 0 && gap(row[lo - 1], row[lo])) lo--;
    while (hi < row.length - 1 && gap(row[hi], row[hi + 1])) hi++;
    row.slice(lo, hi + 1).forEach((item, k) => {
      item.box ??= [item.x, item.y - item.height, item.x + item.width, item.y + 0.3 * item.height];
      item.y = op.y;
      item.x = op.x + op.width + 0.001 * (k + 1);
    });
  }
  return placed;
}

export function groupTextItems(items, pageNumber, viewport, includeGeometry, rules = []) {
  return groupTextRows(items, viewport, rules)
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
export function groupTextRows(items, viewport, rules = []) {
  const placed = readLimits(readFractions(readMarks(items
    .filter(item => typeof item.str === 'string' && item.str.trim())
    .map(item => ({
      text: item.str,
      x: item.transform?.[4] ?? 0,
      y: viewport.height - (item.transform?.[5] ?? 0),
      width: Math.max(item.width ?? 0, 0),
      height: Math.max(Math.abs(item.height ?? item.transform?.[3] ?? 0), 1),
    }))), rules))
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


// ═══════════════════════════════════════════════════════════════
// Text the page paints, not every glyph its content stream holds.
//
// A text layer read through getTextContent ignores clipping, and some books
// clip most of what they draw. The 2024 留白 exercise books embed whole pages
// of a compact typesetting as form XObjects and clip each to one question's
// window; the 2024 answer keys embed every question statement the same way,
// a form holding the full original page cut to the question's box. Read
// whole, the analysis exercise book's text layer has 12,790 lines, 2,130 of
// them printed, and every question carried its neighbours'.
//
// pdf.js applies clips when it paints, not when it extracts text, so the
// clip state is replayed here from the operator list — transforms, save and
// restore, clip paths, and each form's matrix and /BBox — and every glyph is
// marked painted or clipped. The operator list and the text content walk the
// same content stream in the same order, so the two are aligned character by
// character, and a text item is kept when most of its characters are painted.
// A clip path counts by its bounding box, which is exact for the rectangles
// these books clip with and generous for anything rounder.

const IDENTITY = [1, 0, 0, 1, 0, 0];
const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const boxThrough = (m, [x0, y0, x1, y1]) => {
  const xs = []; const ys = [];
  for (const [x, y] of [[x0, y0], [x0, y1], [x1, y0], [x1, y1]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const intersect = (a, b) => (a ? [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])] : b);
const inside = (clip, x, y) => !clip || (x >= clip[0] - 0.5 && x <= clip[2] + 0.5 && y >= clip[1] - 0.5 && y <= clip[3] + 0.5);

/**
 * Every glyph a page's operator list shows, in order, with its origin in
 * page space and whether that lands inside the clip in force when it is shown:
 * [{text, x, y, painted}].
 * Returns null when nothing on the page is clipped, so a caller can skip the
 * alignment entirely.
 */
export function paintedGlyphs(operatorList, OPS = pdfjs.OPS) {
  const page = replayPage(operatorList, OPS);
  return page.clipped ? page.glyphs : null;
}

/**
 * The thin horizontal rules a page paints — fraction bars, overlines, table
 * rules — as stroked segments or filled rectangles under a point thick, in
 * page space: [{x0, x1, y, thickness}].
 */
export function paintedRules(operatorList, OPS = pdfjs.OPS) {
  return replayPage(operatorList, OPS).rules;
}

/** One pass over the operator list: glyphs with their clip state, and rules. */
function replayPage(operatorList, OPS) {
  const { fnArray, argsArray } = operatorList;
  let clipped = false;
  for (const fn of fnArray) {
    if (fn === OPS.clip || fn === OPS.eoClip || fn === OPS.paintFormXObjectBegin) { clipped = true; break; }
  }

  const glyphs = [];
  const rules = [];
  let gs = { ctm: IDENTITY, clip: null, lineWidth: 1 };
  const stack = [];
  let text = { tm: IDENTITY, tlm: IDENTITY, size: 1, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0 };
  let path = null;
  let shape = null;
  const moveLine = (tx, ty) => { text.tlm = multiply(text.tlm, [1, 0, 0, 1, tx, ty]); text.tm = text.tlm; };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(gs); gs = { ...gs }; break;
      case OPS.restore: gs = stack.pop() ?? gs; break;
      case OPS.transform: gs.ctm = multiply(gs.ctm, args); break;
      case OPS.paintFormXObjectBegin: {
        stack.push(gs);
        gs = { ...gs };
        if (Array.isArray(args[0]) && args[0].length === 6) gs.ctm = multiply(gs.ctm, args[0]);
        if (Array.isArray(args[1]) && args[1].length === 4) gs.clip = intersect(gs.clip, boxThrough(gs.ctm, args[1]));
        break;
      }
      case OPS.paintFormXObjectEnd: gs = stack.pop() ?? gs; break;
      case OPS.constructPath: {
        const minMax = args[2];
        path = Array.isArray(minMax) || ArrayBuffer.isView(minMax) ? boxThrough(gs.ctm, Array.from(minMax)) : null;
        const kinds = args[0] ?? [];
        // A rule is one horizontal segment or one flat rectangle.
        shape = kinds.length === 1 && kinds[0] === OPS.rectangle ? 'rect'
          : kinds.length === 2 && kinds[0] === OPS.moveTo && kinds[1] === OPS.lineTo ? 'segment' : null;
        break;
      }
      case OPS.setLineWidth: gs.lineWidth = args[0]; break;
      case OPS.stroke:
      case OPS.fill:
      case OPS.eoFill: {
        if (!path || !shape) break;
        const [x0, y0, x1, y1] = path;
        const scale = Math.hypot(gs.ctm[2], gs.ctm[3]) || 1;
        const thickness = shape === 'segment' ? gs.lineWidth * scale : y1 - y0;
        const flat = shape === 'segment' ? (y1 - y0) < 0.05 : (y1 - y0) <= 1.2;
        if (flat && x1 - x0 >= 1.5 && thickness > 0 && thickness <= 1.2
          && inside(gs.clip, (x0 + x1) / 2, (y0 + y1) / 2)) {
          rules.push({ x0, x1, y: (y0 + y1) / 2, thickness });
        }
        break;
      }
      case OPS.clip:
      case OPS.eoClip:
        if (path) gs.clip = intersect(gs.clip, path);
        break;
      case OPS.beginText: text.tm = IDENTITY; text.tlm = IDENTITY; break;
      case OPS.setFont: text.size = args[1] ?? text.size; break;
      case OPS.setTextMatrix: text.tm = args; text.tlm = args; break;
      case OPS.moveText: moveLine(args[0], args[1]); break;
      case OPS.setLeadingMoveText: text.leading = -args[1]; moveLine(args[0], args[1]); break;
      case OPS.nextLine: moveLine(0, -text.leading); break;
      case OPS.setLeading: text.leading = args[0]; break;
      case OPS.setCharSpacing: text.charSpacing = args[0]; break;
      case OPS.setWordSpacing: text.wordSpacing = args[0]; break;
      case OPS.setHScale: text.hScale = args[0] / 100; break;
      case OPS.setTextRise: text.rise = args[0]; break;
      case OPS.showText: {
        for (const glyph of args[0] ?? []) {
          // Matrices compose as pdf.js's Util.transform does: multiply(a, b)
          // applies b first. A glyph's origin is text space through Tm, then
          // the CTM; an advance moves along text space before Tm.
          if (typeof glyph === 'number') {
            text.tm = multiply(text.tm, [1, 0, 0, 1, (-glyph / 1000) * text.size * text.hScale, 0]);
            continue;
          }
          const at = multiply(gs.ctm, multiply(text.tm, [1, 0, 0, 1, 0, text.rise]));
          glyphs.push({ text: glyph?.unicode ?? '', x: at[4], y: at[5], painted: inside(gs.clip, at[4], at[5]) });
          const advance = ((glyph?.width ?? 0) / 1000) * text.size + text.charSpacing + (glyph?.isSpace ? text.wordSpacing : 0);
          text.tm = multiply(text.tm, [1, 0, 0, 1, advance * text.hScale, 0]);
        }
        break;
      }
      default: break;
    }
  }
  return { glyphs, rules, clipped };
}

/**
 * The text content items the page paints.
 *
 * Each item is matched to the glyphs drawn where it starts: pdf.js reports an
 * item's position as its first glyph's origin, and paintedGlyphs computes the
 * same origin from the same matrices. Matching by place, not by order, is what
 * survives pdf.js dropping every glyph outside the page box before it builds
 * items — an embedded page drawn at an offset puts thousands there — and two
 * forms drawing one page twice, one copy clipped away. A candidate must also
 * spell the item's opening characters from there on: two forms can start
 * different text at the very same point (例题 1.106 painted, 例题 1.111 under
 * it, hidden), and a first character alone cannot tell them apart.
 *
 * An item is kept when the nearest glyph run spelling its opening, within a
 * point of it, is painted; an item no glyph accounts for is kept too, because
 * this never removes what it cannot explain. Where two forms paint the same
 * text at the same place, the duplicate is dropped.
 */
export function paintedItems(items, glyphs, { tolerance = 1, spell = 12 } = {}) {
  if (!glyphs) return items;
  const cells = new Map();
  const cellKey = (x, y) => `${Math.round(x)}|${Math.round(y)}`;
  glyphs.forEach((g, index) => {
    const key = cellKey(g.x, g.y);
    const list = cells.get(key);
    if (list) list.push(index); else cells.set(key, [index]);
  });
  const chars = (s) => [...String(s ?? '').normalize('NFKC')].filter(ch => !/\s/u.test(ch));
  // The non-space characters the glyph stream spells from `index` on.
  const spells = (index, want) => {
    let k = 0;
    for (let n = index; n < glyphs.length && k < want.length; n++) {
      for (const ch of chars(glyphs[n].text)) {
        if (k >= want.length) break;
        if (ch !== want[k]) return false;
        k++;
      }
    }
    return k === want.length;
  };
  const seen = new Set();
  return items.filter((item) => {
    const x = item.transform?.[4];
    const y = item.transform?.[5];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    const want = chars(item.str).slice(0, spell);
    if (want.length === 0) return true;
    // The nearest run that spells the item decides: a hidden copy can sit
    // a fraction of a point from the painted one.
    let nearest = null;
    let distance = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const index of cells.get(cellKey(x + dx, y + dy)) ?? []) {
          const g = glyphs[index];
          if (Math.abs(g.x - x) > tolerance || Math.abs(g.y - y) > tolerance) continue;
          // An item may begin with a space glyph; its spelling starts after it.
          let from = index;
          while (from < glyphs.length && chars(glyphs[from].text).length === 0) from++;
          if (!spells(from, want)) continue;
          const d = Math.hypot(g.x - x, g.y - y);
          if (d < distance || (d === distance && g.painted)) { distance = d; nearest = g; }
        }
      }
    }
    if (nearest && !nearest.painted) return false;
    const key = `${item.str}|${x.toFixed(1)}|${y.toFixed(1)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A page's text content, keeping only what it paints unless asked otherwise. */
export async function pageTextItems(page, { clipAware = true } = {}) {
  return (await pageTextLayout(page, { clipAware })).items;
}

/**
 * A page's painted text items and the rules it draws, rules in the
 * top-left coordinates groupTextRows places items in.
 */
export async function pageTextLayout(page, { clipAware = true } = {}) {
  const content = await page.getTextContent();
  const replay = replayPage(await page.getOperatorList(), pdfjs.OPS);
  const height = page.getViewport({ scale: 1 }).height;
  const rules = replay.rules.map(r => ({ x0: r.x0, x1: r.x1, y: height - r.y, thickness: r.thickness }));
  if (!clipAware || !replay.clipped) return { items: content.items, rules };
  return { items: paintedItems(content.items, replay.glyphs), rules };
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
 *
 * `clipAware` (default true) keeps only the text a page paints; false reads
 * every glyph of the content stream, clipped or not, as getTextContent does.
 */
export async function openPdfDocument(filePath, { includeGeometry = true, clipAware = true } = {}) {
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
    const { items, rules } = await pageTextLayout(page, { clipAware });
    const lines = groupTextItems(items, pageNumber, viewport, includeGeometry, rules);
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
