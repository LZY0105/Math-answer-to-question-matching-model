#!/usr/bin/env node
// Exercises by set and printed number, measured on a scanned textbook pair.
//
// The exercise book is read the way a host would read a scan: its pages
// through a recogniser, here the line starts ocr/scan_line_starts.py wrote
// (each line's first ink cluster, read by the formula model, with its
// position). The answer book is read through its text layer. Every exercise
// the engine indexes is tapped once, at its printed number, unbound and bound,
// under both formula policies; the result says which answer each tap gets and
// on which rung.
//
// The label lookup cannot score itself — a set-and-number id finds the answer
// with the same id by construction — so the taps are written out (--json) for
// checking against the page images: ocr/set_crops.py sets each automatic
// answer's tap point beside its id.
//
// Usage:
//   node tools/measure-sets.mjs --books ../find-engine-books/extracted \
//     --exercise book-026 --answer book-044 --starts STARTS.jsonl[,MORE.jsonl] \
//     [--no-left] [--json OUT.json]
//
// --no-left withholds where each line starts, to measure without the margin
// check.

import { readFileSync, writeFileSync } from 'node:fs';

import { createBinding, fingerprintDocument } from '../src/fingerprint.js';
import { FORMULA_POLICY } from '../src/formula-set.js';
import { preparePair } from '../src/matching-engine.js';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const books = arg('books');
const exerciseKey = arg('exercise');
const answerKey = arg('answer');
const starts = arg('starts');
if (!books || !exerciseKey || !answerKey || !starts) {
  console.error('usage: node tools/measure-sets.mjs --books DIR --exercise KEY --answer KEY --starts A.jsonl[,B.jsonl] [--no-left] [--json OUT]');
  process.exit(2);
}

const load = (key) => JSON.parse(readFileSync(`${books}/${key}.json`, 'utf8'));
const asDoc = (d) => ({
  numPages: d.numPages,
  outline: d.outline,
  async extractText({ from, to } = {}) {
    return d.lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
  },
});

const withLeft = !args.includes('--no-left');
const readings = new Map();
for (const file of starts.split(',')) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (!readings.has(r.page)) readings.set(r.page, []);
    readings.get(r.page).push({ latex: r.latex, top: r.top, bottom: r.bottom, ...(withLeft ? { left: r.x0 } : {}) });
  }
}
const recognizer = async (page) => readings.get(page) ?? [];

const q = load(exerciseKey);
const a = load(answerKey);
const binding = createBinding(
  fingerprintDocument({ numPages: q.numPages, outline: q.outline, lines: q.lines }),
  fingerprintDocument({ numPages: a.numPages, outline: a.outline, lines: a.lines }),
);

const runs = {};
for (const [name, bound, formulaPolicy] of [
  ['unbound strict', false, FORMULA_POLICY.STRICT],
  ['bound strict', true, FORMULA_POLICY.STRICT],
  ['bound calibrated', true, FORMULA_POLICY.CALIBRATED],
]) {
  const prepared = await preparePair({
    exerciseDocument: asDoc(q), answerDocument: asDoc(a), recognizer,
    binding: bound ? binding : null, expectScript: 'han', formulaPolicy,
    ocrPageBudget: q.numPages,
  });
  const exercises = prepared.session?.exerciseIndex.entries.filter(e => e.setId) ?? [];
  const run = {
    status: prepared.status,
    reasons: prepared.decision.reasonCodes,
    sets: new Set(exercises.map(e => e.setId)).size,
    exercises: exercises.length,
    answers: prepared.session?.answerIndex.entries.length ?? 0,
    answerSource: prepared.session?.answerIndex.source ?? null,
    rungs: {},
    cappedBy: {},
    mismatched: 0,
    taps: [],
  };
  for (const e of exercises) {
    const band = e.spans?.[0];
    if (!band) continue;
    const matches = await prepared.session.matchQuestion({ page: band.page, region: { top: band.top + 1, bottom: band.top + 5 } });
    const m = matches.find(x => x.question?.label === e.label) ?? matches[0];
    const rung = m?.rung ?? 'NONE';
    run.rungs[rung] = (run.rungs[rung] ?? 0) + 1;
    if (m?.cappedBy) run.cappedBy[m.cappedBy] = (run.cappedBy[m.cappedBy] ?? 0) + 1;
    if (m?.entry && m.entry.label !== e.label) run.mismatched++;
    const next = exercises[exercises.indexOf(e) + 1];
    run.taps.push({
      label: e.label, page: band.page, top: band.top,
      left: readings.get(band.page)?.find(r => r.top === band.top)?.left ?? null,
      spans: e.spans, lastOfSet: !next || next.setId !== e.setId,
      answer: m?.entry?.label ?? null, answerPage: m?.entry?.page ?? null, rung, cappedBy: m?.cappedBy ?? null,
    });
  }
  runs[name] = run;
  console.log(`${name}: ${run.status} [${run.reasons.join(', ')}]`);
  console.log(`  ${run.exercises} exercises in ${run.sets} sets; answer book ${run.answerSource}, ${run.answers} answers`);
  console.log(`  taps ${JSON.stringify(run.rungs)}; capped by ${JSON.stringify(run.cappedBy)}`);
  console.log(`  an answer whose id is not the tapped exercise's: ${run.mismatched}`);
}

const out = arg('json');
if (out) writeFileSync(out, JSON.stringify(runs, null, 1));
