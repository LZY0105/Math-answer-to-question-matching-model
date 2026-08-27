// An honest audit of the OCR result.
//
// The earlier probe asked only whether the ANSWER page fell inside the gold
// answer span. Since the label determines the lookup, that is very nearly
// circular — it could scarcely have failed, and it reported zero wrong.
//
// The question side has no bookmark oracle: the 2025 exercise book has no
// question-level bookmarks, which is the whole reason OCR is involved. So the
// checks below are the independent ones actually available:
//
//   HEADING   is the label's printed heading really on the page the engine
//             matched it from, or was it associated from a continuation page?
//   ORDER     do the labels read from the exercise book run in the same order
//             as the answer book prints them? A crossing is evidence of a
//             misread label, independent of any span.

import { readFileSync } from 'node:fs';
import { buildOutlineIndex } from '../src/answer-index.js';
import { RUNG } from '../src/decision.js';
import { createBinding, fingerprintDocument } from '../src/fingerprint.js';
import { preparePair } from '../src/matching-engine.js';
import { parseQuestionLine } from '../src/question-id.js';
import { TEXT_QUALITY } from '../src/text-quality.js';

const raw = JSON.parse(readFileSync('tmp/expanded-corpus-20260825.json', 'utf-8'));
const ocrLines = JSON.parse(readFileSync('tmp/ocr/q2025-ocr-lines.json', 'utf-8'));

const ocrDoc = {
  numPages: raw.q2025.numPages,
  outline: raw.q2025.outline,
  async extractText({ from, to } = {}) {
    if (from == null && to == null) return ocrLines;
    return ocrLines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
  },
};
const answerDoc = {
  numPages: raw.a2025.numPages,
  outline: raw.a2025.outline,
  async extractText({ from, to } = {}) {
    if (from == null && to == null) return raw.a2025.lines;
    return raw.a2025.lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
  },
};

const gold = buildOutlineIndex(raw.a2025.outline, raw.a2025.lines, {
  numPages: raw.a2025.numPages, quality: TEXT_QUALITY.USABLE,
});
const goldLabels = gold.entries.map(e => e.label);
const goldRank = new Map(goldLabels.map((l, i) => [l, i]));

/** Pages whose OCR text actually PRINTS this label as a heading. */
const headingPages = new Map();
for (const line of ocrLines) {
  const parsed = parseQuestionLine(line.text);
  if (!parsed) continue;
  if (!headingPages.has(parsed.id)) headingPages.set(parsed.id, new Set());
  headingPages.get(parsed.id).add(line.page);
}

const exFp = fingerprintDocument({ numPages: ocrDoc.numPages, outline: ocrDoc.outline, lines: ocrLines });
const anFp = fingerprintDocument({ numPages: answerDoc.numPages, outline: answerDoc.outline, lines: raw.a2025.lines });

const prepared = await preparePair({
  exerciseDocument: ocrDoc,
  answerDocument: answerDoc,
  binding: createBinding(exFp, anFp),
  expectScript: 'han',
});

const events = [];
for (let page = 1; page <= raw.q2025.numPages; page++) {
  for (const m of await prepared.session.matchQuestion({ page })) {
    if (m.rung !== RUNG.AUTO_MATCH) continue;
    events.push({ page, label: m.question?.label, answerPage: m.entry?.page });
  }
}

console.log(`pair status: ${prepared.status}`);
console.log(`automatic match events: ${events.length}`);

// ── heading check ──────────────────────────────────────────────────────────
let onStart = 0;
let onContinuation = 0;
const startLabels = new Set();
const continuationOnly = new Map();

for (const e of events) {
  const pages = headingPages.get(e.label);
  const printedHere = pages?.has(e.page) ?? false;
  if (printedHere) { onStart++; startLabels.add(e.label); }
  else {
    onContinuation++;
    if (!continuationOnly.has(e.label)) continuationOnly.set(e.label, []);
    continuationOnly.get(e.label).push(e.page);
  }
}
for (const label of startLabels) continuationOnly.delete(label);

console.log('\n── heading check: was the label printed on the page it matched from? ──');
console.log(`  on a page printing the heading : ${onStart}`);
console.log(`  on a continuation page         : ${onContinuation}`);
console.log(`  labels seen ONLY on continuation pages: ${continuationOnly.size}`);
for (const [label, pages] of [...continuationOnly].slice(0, 10)) {
  console.log(`     ${label} at pages ${pages.join(', ')}`);
}

const distinctAll = new Set(events.map(e => e.label).filter(l => goldRank.has(l)));
const distinctStart = new Set([...startLabels].filter(l => goldRank.has(l)));
console.log('\n── distinct real labels ──');
console.log(`  any automatic event      : ${distinctAll.size} / ${goldLabels.length}`
  + ` (${((distinctAll.size / goldLabels.length) * 100).toFixed(2)}%)`);
console.log(`  start-page aligned only   : ${distinctStart.size} / ${goldLabels.length}`
  + ` (${((distinctStart.size / goldLabels.length) * 100).toFixed(2)}%)`);

// ── order check ────────────────────────────────────────────────────────────
const ordered = events
  .filter(e => goldRank.has(e.label))
  .sort((a, b) => a.page - b.page)
  .map(e => ({ page: e.page, label: e.label, rank: goldRank.get(e.label) }));

let inversions = 0;
for (let i = 1; i < ordered.length; i++) {
  if (ordered[i].rank < ordered[i - 1].rank) inversions++;
}
console.log('\n── order check: exercise order against answer-book order ──');
console.log(`  comparable events : ${ordered.length}`);
console.log(`  order inversions  : ${inversions}`
  + ` (${ordered.length > 1 ? ((inversions / (ordered.length - 1)) * 100).toFixed(1) : 0}% of adjacent pairs)`);
for (let i = 1; i < ordered.length && inversions > 0; i++) {
  if (ordered[i].rank < ordered[i - 1].rank) {
    console.log(`     p${ordered[i - 1].page} ${ordered[i - 1].label}`
      + ` -> p${ordered[i].page} ${ordered[i].label}  (goes backwards)`);
    if (--inversions <= 0) break;
  }
}
