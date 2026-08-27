// Auditing an OCR-derived match set, without trusting the match set.
//
// A scanned exercise book has no question-level bookmarks — that is why OCR is
// involved — so there is no oracle for WHERE a question sits in it. Checking
// that a matched answer falls inside that label's answer span is very nearly
// circular: the label drives the lookup, so it lands there by construction. An
// earlier measurement did exactly that and reported zero wrong, because it could
// not have seen a wrong answer if one existed.
//
// Two checks remain available, and neither depends on the engine's own opinion:
//
//   HEADING   was the label's heading actually printed on the page the match
//             came from, or was it associated across a page boundary?
//   ORDER     do the labels run in the same order as the answer book prints
//             them? A crossing is evidence of a misread label.
//
// Neither establishes correctness. They bound the claim: a match from a page
// that never printed its label is suspect, and a set with no order inversions
// has at least not scrambled the book. Deciding a match is CORRECT still needs
// a human looking at the page.
//
// This module is pure so the reasoning can be tested on a clean checkout. The
// corpus it normally runs against is extracted text from copyrighted books and
// is never committed; tools/audit-ocr-matches.mjs is the thin CLI over it.

/**
 * @param {object} input
 * @param {Array<{page:number,label:string,answerPage?:number}>} input.events
 *   one entry per automatic match the engine emitted
 * @param {Map<string, Set<number>>} input.headingPages
 *   label -> the pages whose recognised text PRINTS that label as a heading
 * @param {string[]} input.goldLabels
 *   the answer book's question labels, in book order
 * @returns {object} counts and the labels that warrant a look
 */
export function auditOcrMatches({ events = [], headingPages = new Map(), goldLabels = [] } = {}) {
  const goldRank = new Map(goldLabels.map((l, i) => [l, i]));

  let onStartPage = 0;
  let onContinuationPage = 0;
  const startLabels = new Set();
  const continuationPages = new Map();

  for (const event of events) {
    const printed = headingPages.get(event.label)?.has(event.page) ?? false;
    if (printed) {
      onStartPage++;
      startLabels.add(event.label);
    } else {
      onContinuationPage++;
      if (!continuationPages.has(event.label)) continuationPages.set(event.label, []);
      continuationPages.get(event.label).push(event.page);
    }
  }

  // A label printed on one page and continued onto another is ordinary. A label
  // seen ONLY on pages that never printed it is the page-boundary risk.
  const continuationOnly = new Map(
    [...continuationPages].filter(([label]) => !startLabels.has(label)),
  );

  const real = (label) => goldRank.has(label);
  const distinctAny = new Set(events.map(e => e.label).filter(real));
  const distinctStartAligned = new Set([...startLabels].filter(real));

  const ordered = events
    .filter(e => real(e.label))
    .slice()
    .sort((a, b) => a.page - b.page)
    .map(e => ({ page: e.page, label: e.label, rank: goldRank.get(e.label) }));

  const inversions = [];
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].rank < ordered[i - 1].rank) {
      inversions.push({ from: ordered[i - 1], to: ordered[i] });
    }
  }

  const gold = goldLabels.length;
  return {
    events: events.length,
    onStartPage,
    onContinuationPage,
    continuationOnlyLabels: [...continuationOnly.keys()].sort(),
    continuationOnlyPages: Object.fromEntries(continuationOnly),
    goldLabels: gold,
    distinctRaw: distinctAny.size,
    distinctStartAligned: distinctStartAligned.size,
    rawShare: gold ? Number((distinctAny.size / gold).toFixed(4)) : null,
    startAlignedShare: gold ? Number((distinctStartAligned.size / gold).toFixed(4)) : null,
    comparableForOrder: ordered.length,
    orderInversions: inversions.length,
    orderInversionExamples: inversions.slice(0, 5),
  };
}

/** Label -> pages whose text prints it, built from recognised lines. */
export function headingPagesFrom(lines, parseQuestionLine) {
  const out = new Map();
  for (const line of lines ?? []) {
    const parsed = parseQuestionLine(line?.text);
    if (!parsed) continue;
    if (!out.has(parsed.id)) out.set(parsed.id, new Set());
    out.get(parsed.id).add(line.page);
  }
  return out;
}
