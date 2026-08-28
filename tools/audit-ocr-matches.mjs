#!/usr/bin/env node
// Audits an OCR-derived match set and writes the canonical result.
//
// The reasoning lives in src/ocr-audit.js and is unit-tested on synthetic
// fixtures, so a clean checkout can verify the logic without the corpus. This
// file only feeds it real data and writes the artifact that the README and the
// reports cite, so those never restate numbers by hand and cannot drift.
//
// Inputs, neither of which is committed — both derive from copyrighted books:
//
//   tmp/expanded-corpus-20260825.json   rebuild with tools/extract-corpus.mjs
//   tmp/ocr/q2025-ocr-lines.json        rebuild with the recognizer, see below
//
// To produce the OCR cache from the scanned PDF:
//
//   cp "<the 2025 exercise PDF>" tmp/ocr/q2025.pdf     # ASCII path required
//   node tools/ocr-cache.mjs                            # ~7 minutes, 465 pages
//
// Absent either input this FAILS, because a release gate that passes when it did
// not run is not a gate. `--allow-skip` is the explicit way to say that a green
// run on a checkout without the corpus is what was wanted — that is the form
// the README documents, and the form a fresh clone should use.
//
// The OCR cache carries its own provenance (see tools/ocr-cache.mjs). A cache
// that reports itself incomplete, or one with no provenance at all, is recorded
// as such in the artifact rather than being quietly averaged into the counts.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildOutlineIndex } from '../src/answer-index.js';
import { RUNG } from '../src/decision.js';
import { createBinding, fingerprintDocument } from '../src/fingerprint.js';
import { preparePair } from '../src/matching-engine.js';
import { auditOcrMatches, headingPagesFrom } from '../src/ocr-audit.js';
import { parseQuestionLine } from '../src/question-id.js';
import { TEXT_QUALITY } from '../src/text-quality.js';

const CORPUS = process.env.FIND_ENGINE_EXPANDED_CORPUS || 'tmp/expanded-corpus-20260825.json';
const OCR = process.env.FIND_ENGINE_OCR_CACHE || 'tmp/ocr/q2025-ocr-lines.json';
const ALLOW_SKIP = process.argv.includes('--allow-skip');
const OUT = process.argv.slice(2).find(a => !a.startsWith('--')) || 'reports/ocr-audit.json';

const missing = [CORPUS, OCR].filter(p => !existsSync(p));
if (missing.length > 0) {
  const say = ALLOW_SKIP ? console.log : console.error;
  say('OCR audit did not run — inputs not present in this checkout:');
  for (const p of missing) say(`  ${p}`);
  say('\nBoth derive from copyrighted books and are never committed.');
  say('See the header of this file for how to rebuild them.');
  say('\nThe audit logic itself is covered by test/test_structure.js and');
  say('runs on a clean checkout without either file.');
  if (!ALLOW_SKIP) {
    console.error('\nFailing rather than reporting success for an audit that did');
    console.error('not happen. Pass --allow-skip if a skip is the intended outcome.');
    process.exit(1);
  }
  process.exit(0);
}

const raw = JSON.parse(readFileSync(CORPUS, 'utf-8'));

// Caches written before tools/ocr-cache.mjs recorded provenance are a bare
// array. They still work; they simply cannot say which book they came from, and
// the artifact says so rather than implying a completeness nobody checked.
const cache = JSON.parse(readFileSync(OCR, 'utf-8'));
const ocrLines = Array.isArray(cache) ? cache : cache.lines ?? [];
const cacheMeta = Array.isArray(cache)
  ? { complete: null, provenance: 'unknown — cache predates provenance recording' }
  : { ...cache.meta, provenance: 'recorded' };
if (cacheMeta.complete === false) {
  console.warn('WARNING: the OCR cache reports itself incomplete. Counts below understate');
  console.warn('coverage and are not comparable with a complete run.');
  for (const problem of cacheMeta.problems ?? []) console.warn(`  ${problem}`);
} else if (cacheMeta.complete === null) {
  console.warn('WARNING: the OCR cache carries no provenance; rebuild it with');
  console.warn('tools/ocr-cache.mjs to record the source PDF and coverage.');
}

const asDoc = (numPages, outline, lines) => ({
  numPages,
  outline,
  async extractText({ from, to } = {}) {
    if (from == null && to == null) return lines;
    return lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
  },
});

const exerciseDoc = asDoc(raw.q2025.numPages, raw.q2025.outline, ocrLines);
const answerDoc = asDoc(raw.a2025.numPages, raw.a2025.outline, raw.a2025.lines);

const gold = buildOutlineIndex(raw.a2025.outline, raw.a2025.lines, {
  numPages: raw.a2025.numPages, quality: TEXT_QUALITY.USABLE,
});

const binding = createBinding(
  fingerprintDocument({ numPages: exerciseDoc.numPages, outline: exerciseDoc.outline, lines: ocrLines }),
  fingerprintDocument({ numPages: answerDoc.numPages, outline: answerDoc.outline, lines: raw.a2025.lines }),
);

const prepared = await preparePair({
  exerciseDocument: exerciseDoc, answerDocument: answerDoc, binding, expectScript: 'han',
});

const events = [];
if (prepared.session) {
  for (let page = 1; page <= raw.q2025.numPages; page++) {
    for (const m of await prepared.session.matchQuestion({ page })) {
      if (m.rung === RUNG.AUTO_MATCH) {
        events.push({ page, label: m.question?.label, answerPage: m.entry?.page });
      }
    }
  }
}

const result = auditOcrMatches({
  events,
  headingPages: headingPagesFrom(ocrLines, parseQuestionLine),
  goldLabels: gold.entries.map(e => e.label),
});

// Which working tree produced these counts. A number without a commit is a
// number nobody can go back to.
const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
})();

const artifact = {
  generatedAt: new Date().toISOString(),
  commit,
  pair: '2025 scanned exercise book against its answer key',
  pairStatus: prepared.status,
  reasonCodes: prepared.decision.reasonCodes,
  ocrCache: {
    path: OCR,
    complete: cacheMeta.complete ?? null,
    provenance: cacheMeta.provenance,
    builtAtCommit: cacheMeta.commit ?? null,
    source: cacheMeta.source ?? null,
    recognizer: cacheMeta.recognizer ?? null,
    coverage: cacheMeta.coverage ?? null,
  },
  note: 'Counts only. None of these is a matching-accuracy figure: the exercise '
    + 'book has no question-level bookmarks, so nothing independent says where a '
    + 'question sits in it. See src/ocr-audit.js.',
  ...result,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(2)}%`);
console.log(`pair status: ${artifact.pairStatus}  ${artifact.reasonCodes.join(',') || '-'}`);
console.log(`automatic match events            ${result.events}`);
console.log(`  on a page printing the label    ${result.onStartPage}`);
console.log(`  on a continuation page          ${result.onContinuationPage}`);
console.log(`  labels ONLY on continuation     ${result.continuationOnlyLabels.length}`
  + `  ${result.continuationOnlyLabels.join(', ')}`);
console.log(`distinct labels, raw              ${result.distinctRaw} / ${result.goldLabels}`
  + `  (${pct(result.rawShare)})`);
console.log(`distinct labels, start-aligned    ${result.distinctStartAligned} / ${result.goldLabels}`
  + `  (${pct(result.startAlignedShare)})`);
console.log(`order breaks (backward steps)     ${result.orderBreaks} of ${result.comparableForOrder}`);
console.log(`order inversions (pairs)          ${result.orderInversions} of ${result.maxOrderInversions}`
  + `  (${pct(result.orderInversionRate)})`);
console.log(`\nartifact -> ${OUT}`);
