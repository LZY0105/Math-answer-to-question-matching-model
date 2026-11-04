// Exercises inside a set, answers inside a section: ids a textbook prints but
// does not bookmark.
//
// A textbook bookmarks its exercise SETS (习题 1.1), not the exercises in them,
// and its answer book bookmarks SECTIONS (1.1 二阶行列式), not the answers. What
// identifies one exercise is its set and the number printed at its start: "3."
// in 习题 1.1 is exercise 1.1.3, and "3." in section 1.1 of the answer book is
// its answer. Measured on the 绿皮书 (book-026 against book-044): in chapters
// 1–2, 95 exercises in 13 sets, the answer book numbering every one of them
// 1..N inside its section, and the formula model reading 92 of the 95 printed
// numbers off the scan in order; over the whole book, 508 of the answer book's
// 527 exercises indexed in 66 of 69 sets. The answers state results ("1. (1)
// −2. (2) 1.") rather than restating the questions, so for this pair nothing
// but these numbers can identify an exercise.
//
// The numbers are read, not bookmarked, so they are trusted only as far as
// their sequence holds:
//
//   - a run counts from 1 (or from 2, where the 1 was not read) and only
//     forward, by one or by two; a number that goes back does not start a new
//     exercise, and a run of fewer than two is no run;
//   - where the 1 restarts inside a region, a new candidate run begins, and the
//     longest wins — a numbered list in the body before the set is not the set;
//   - a number the run cannot confirm is flagged, never dropped silently. A
//     skipped number leaves the item before it holding an unknown share of the
//     unread one (`followedByGap`: a tap on the unread exercise lands in its
//     band), and makes the item after it one whose predecessor nobody saw
//     (`precededByGap`: a misread digit looks exactly like this, "4." read as
//     "5." and the real 5 then out of sequence). A line inside an item that
//     opens like an item and is not one of the run (`strays`) is a repeated or
//     misread number, or a list inside the item; either way the item's extent
//     is in doubt. And where the reader says where a line starts, an opener
//     off the margin its set's other openers share is flagged (`misaligned`):
//     on the 绿皮书, real exercise numbers sit within 0.41 of an opener's
//     height of their page's margin, and the one false opener that reached an
//     automatic answer — a list in a worked example, above the set's heading,
//     with the set's own "1." read without its period — sat 2.08 away.
//
// Matching uses these ids only where the outline alignment pairs the set's own
// section with the answer's section, only where both sides count the same
// number of items in it, and never for a flagged item (see question-matcher.js).
// This module only reads.

import { normalizeId } from './question-id.js';

/**
 * A line that opens a numbered item: "3." "3．" "3、" — never "1.1", never "(3)",
 * never "3)". A comma opens one only when nothing follows it: a recogniser
 * reads a scanned "3." as a bare "3," now and then (twice among the 绿皮书's
 * exercises), but "1, ⋯, 1, λ−1" is a list, and in that book's chapter on
 * λ-matrices lists open lines often. The parenthesis closed one opener in the
 * whole book, and a sub-question "(4)" read without its "(" would open an
 * exercise.
 */
const OPENER = /^\s*(\d{1,3})(?!\d)(?![.．]\d)\s*(?:[.．、]|[,，]\s*$)\s*/u;

/** Bookmark titles that name a SET of exercises rather than one question. */
const SET_MARKER = /(习\s*题|练\s*习|Exercises|Problems)/iu;

/** The number a line opens with, or null. */
export function openerNumber(text) {
  const m = String(text ?? '').match(OPENER);
  return m ? Number(m[1]) : null;
}

/** Whether a bookmark title names an exercise set. */
export function isSetTitle(title) {
  return SET_MARKER.test(String(title ?? ''));
}

/**
 * The numbered run in a sequence of lines.
 *
 * @param {Array<{text:string}>} lines in reading order
 * @returns {Array<{index:number, number:number, followedByGap:boolean,
 *   precededByGap:boolean, strays:number[]}>} `strays` are the indices of the
 *   lines after this item's opener, and before the next item's, that open like
 *   an item but are not in the run; for the last item, every one after it.
 */
export function numberedRun(lines) {
  const openers = [];
  const candidates = [];
  let current = null;
  (lines ?? []).forEach((line, index) => {
    const k = openerNumber(line?.text);
    if (k === null) return;
    openers.push(index);
    if (k === 1 || (!current && k === 2)) {
      current = [{ index, number: k }];
      candidates.push(current);
      return;
    }
    if (!current) return;
    const last = current[current.length - 1].number;
    if (k === last + 1 || k === last + 2) current.push({ index, number: k });
  });
  const best = candidates
    .filter(run => run.length >= 2)
    .reduce((a, b) => (b.length >= (a?.length ?? 0) ? b : a), null);
  if (!best) return [];
  const inRun = new Set(best.map(item => item.index));
  return best.map((item, i) => {
    const prev = best[i - 1];
    const next = best[i + 1];
    const end = next ? next.index : Infinity;
    return {
      ...item,
      followedByGap: !!next && next.number > item.number + 1,
      // The first item counts as preceded by a gap when it is not 1: the run
      // began at 2 because no 1 was read, and nothing confirms the 2.
      precededByGap: prev ? item.number > prev.number + 1 : item.number > 1,
      strays: openers.filter(j => j > item.index && j < end && !inRun.has(j)),
    };
  });
}

const lineTop = (l) => (Number.isFinite(l.top) ? l.top : (Number.isFinite(l.y) && Number.isFinite(l.height) ? l.y - l.height : l.y));
const lineBottom = (l) => (Number.isFinite(l.bottom) ? l.bottom : l.y);

/**
 * The band each numbered item occupies on each page, from its opener down to
 * the next opener.
 *
 * The last item has no next opener, and the page below it may be the next
 * section's heading and body. Its band follows its own lines down to the first
 * vertical break wider than BREAK opener heights, and is never taller than the
 * median of the items before it (three of its lines when there are none): a
 * tap on what follows a set lands on nothing rather than on the set's last
 * exercise. On the 绿皮书 the break before the next section's heading measures
 * 37–52pt, the breaks inside exercises at most 19pt, and an opener 9.6pt; the
 * median alone ran four last exercises into the heading that followed, one of
 * them into the next section's first paragraph. An item that runs over a page
 * break is bounded the same way on each page, which keeps the scanner's edge
 * at the top of the next page (34–43pt above its text) out of it, and never
 * takes that page's first line, its running head.
 */
const BREAK = 3;
/** Lines closer than this many opener heights are one: a head and its rule. */
const TOUCH = 0.5;

function itemBands(lines, run) {
  const bands = run.map(() => []);
  const heights = [];
  const unit = median(run.map(r => lineBottom(lines[r.index]) - lineTop(lines[r.index])).filter(h => h > 0));
  const limit = BREAK * (unit || 1);
  const onPage = (p) => lines.filter(l => l.page === p && Number.isFinite(lineTop(l)))
    .sort((a, b) => lineTop(a) - lineTop(b));
  // The lines contiguous with `from` downward (or upward), stopping at the
  // first break wider than `limit`: an exercise's lines, not the running head
  // or the scanner's edge that share its page.
  const contiguous = (pageLines, from, down) => {
    const block = [from];
    let edge = down ? lineBottom(from) : lineTop(from);
    const at = pageLines.indexOf(from);
    for (let j = at + (down ? 1 : -1); j >= 0 && j < pageLines.length; j += down ? 1 : -1) {
      const line = pageLines[j];
      const gap = down ? lineTop(line) - edge : edge - lineBottom(line);
      if (gap > limit) break;
      block.push(line);
      edge = down ? Math.max(edge, lineBottom(line)) : Math.min(edge, lineTop(line));
    }
    return block;
  };
  // A page's text starts with its running head, wherever the book prints one,
  // and it sits as close above the body as the body's own lines sit to each
  // other (15–20pt on the 绿皮书), so no break separates it. A continuation
  // never claims the first line of a page's text, nor what touches it — the
  // rule under a head reads as a thin line of its own, under a point below it.
  // On a page without a running head that costs a tap on the first line,
  // which finds nothing.
  const belowHead = (block) => {
    const sorted = [...block].sort((a, b) => lineTop(a) - lineTop(b));
    let k = 1;
    let edge = sorted.length ? lineBottom(sorted[0]) : 0;
    while (k < sorted.length && lineTop(sorted[k]) - edge <= TOUCH * (unit || 1)) {
      edge = Math.max(edge, lineBottom(sorted[k]));
      k++;
    }
    return sorted.slice(k);
  };
  for (let i = 0; i < run.length; i++) {
    const start = lines[run[i].index];
    const next = run[i + 1] ? lines[run[i + 1].index] : null;
    const top0 = lineTop(start);
    if (!Number.isFinite(top0)) return null;
    if (next && next.page === start.page) {
      const end = lineTop(next);
      bands[i].push({ page: start.page, top: top0, bottom: end - 0.5 });
      heights.push(end - top0);
      continue;
    }
    if (next) {
      // Runs over a page break: its lines below the opener on this page, any
      // page between, and its lines above the next opener on that one.
      const here = contiguous(onPage(start.page), start, true);
      bands[i].push({ page: start.page, top: top0, bottom: Math.max(...here.map(lineBottom)) });
      for (let p = start.page + 1; p < next.page; p++) {
        const ls = onPage(p);
        if (!ls.length) continue;
        const body = belowHead(contiguous(ls, ls[ls.length - 1], false));
        if (body.length) bands[i].push({ page: p, top: Math.min(...body.map(lineTop)), bottom: Math.max(...body.map(lineBottom)) });
      }
      const there = onPage(next.page);
      const above = belowHead(contiguous(there, next, false).filter(l => l !== next));
      if (above.length) bands[i].push({ page: next.page, top: Math.min(...above.map(lineTop)), bottom: lineTop(next) - 0.5 });
      continue;
    }
    // The last item: its own lines, down to the first break wider than a
    // paragraph's, and never further than the estimate.
    const sorted = [...heights].sort((a, b) => a - b);
    const lineHeight = Math.max(1, lineBottom(start) - top0);
    const estimate = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 3 * lineHeight;
    const own = contiguous(onPage(start.page), start, true);
    const bottom = Math.max(...own.map(lineBottom));
    bands[i].push({ page: start.page, top: top0, bottom: Math.min(bottom, top0 + estimate), estimated: true });
  }
  return bands;
}

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Which items of a run open off the margin the run's other openers on the
 * same page share. Measured in the openers' own height, so it holds at any
 * scale; judged only where a page carries two openers or more and the reader
 * says where each line starts (`left`). With two that disagree, both are
 * flagged: nothing says which one is on the margin.
 */
function offMargin(lines, run) {
  const openers = run.map(item => lines[item.index]);
  return openers.map((line) => {
    if (!Number.isFinite(line?.left)) return false;
    const same = openers.filter(o => o.page === line.page && Number.isFinite(o.left));
    if (same.length < 2) return false;
    const height = median(same.map(o => lineBottom(o) - lineTop(o)).filter(h => h > 0));
    if (!(height > 0)) return false;
    return Math.abs(line.left - median(same.map(o => o.left))) > height;
  });
}

/**
 * The exercises of one set, from the lines of the region the set's bookmark
 * opens.
 *
 * @param {{label:string, title:string}} set an outline entry; its label is the set id
 * @param {Array} lines the region's lines, in reading order, with geometry
 * @returns {Array} entries: {label, number, setId, ...} — empty when no run
 */
export function exercisesOfSet(set, lines) {
  const setId = normalizeId(set?.label);
  if (!setId) return [];
  const run = numberedRun(lines);
  if (run.length === 0) return [];
  const bands = itemBands(lines, run);
  const size = run[run.length - 1].number;
  const inBand = (line, spans) => (spans ?? []).some(b => b.page === line.page
    && lineTop(line) >= b.top && lineTop(line) <= b.bottom);
  const misaligned = offMargin(lines, run);
  return run.map((item, i) => {
    const next = run[i + 1];
    const own = lines.slice(item.index, next ? next.index : Math.min(lines.length, item.index + 12));
    const line = lines[item.index];
    const spans = bands?.[i] ?? [];
    // The last item's lines run on into whatever follows the set; only the
    // strays inside its own band are its own.
    const strays = next ? item.strays : item.strays.filter(j => inBand(lines[j], spans));
    return {
      label: `${setId}.${item.number}`,
      setId,
      number: item.number,
      setSize: size,
      followedByGap: item.followedByGap,
      precededByGap: item.precededByGap,
      strays: strays.length,
      misaligned: misaligned[i],
      page: line.page,
      endPage: spans.reduce((m, b) => Math.max(m, b.page), line.page),
      top: lineTop(line),
      text: own.map(l => l.text).join('\n'),
      spans,
    };
  });
}

/**
 * The answers of one section, from the lines of the region the section's
 * bookmark opens. Same reading as exercisesOfSet; the band does not matter on
 * this side, the text does.
 */
export function answersOfSection(section, lines) {
  const sectionId = normalizeId(section?.questionId ?? section?.id);
  if (!sectionId) return [];
  const run = numberedRun(lines);
  if (run.length === 0) return [];
  const size = run[run.length - 1].number;
  return run.map((item, i) => {
    const next = run[i + 1];
    const own = lines.slice(item.index, next ? next.index : lines.length);
    return {
      label: `${sectionId}.${item.number}`,
      setId: sectionId,
      number: item.number,
      setSize: size,
      followedByGap: item.followedByGap,
      precededByGap: item.precededByGap,
      strays: item.strays.length,
      section: section.title,
      page: own[0].page,
      endPage: own[own.length - 1].page,
      text: own.map(l => l.text).join('\n'),
    };
  });
}
