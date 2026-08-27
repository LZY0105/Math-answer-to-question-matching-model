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
// Absent either input this exits 0 and says what is missing, so it is safe in CI.

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
const OUT = process.argv[2] || 'reports/ocr-audit-latest.json';

const missing = [CORPUS, OCR].filter(p => !existsSync(p));
if (missing.length > 0) {
  console.log('OCR audit skipped — inputs not present in this checkout:');
  for (const p of missing) console.log(`  ${p}`);
  console.log('\nBoth derive from copyrighted books and are never committed.');
  console.log('See the header of this file for how to rebuild them.');
  console.log('\nThe audit logic itself is covered by test/test_structure.js and');
  console.log('runs on a clean checkout without either file.');
  process.exit(0);
}

const raw = JSON.parse(readFileSync(CORPUS, 'utf-8'));
const ocrLines = JSON.parse(readFileSync(OCR, 'utf-8'));

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

const artifact = {
  generatedAt: new Date().toISOString(),
  pair: '2025 scanned exercise book against its answer key',
  pairStatus: prepared.status,
  reasonCodes: prepared.decision.reasonCodes,
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
console.log(`order inversions                  ${result.orderInversions} of ${result.comparableForOrder}`);
console.log(`\nartifact -> ${OUT}`);
