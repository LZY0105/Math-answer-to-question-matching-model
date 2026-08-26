#!/usr/bin/env node
// Full-book regime measurement, using the expanded report's strict definitions.
//
//   strict_precision = independently_confirmed / accepted
//
// An accepted result that cannot be tied to the bookmark oracle counts as a
// failure, not as an exclusion. Every page of every book is run; nothing is
// sampled. Ground truth comes from the two bookmark trees, which are structural
// and independent of the text layer that the ablated regimes are forced onto.
//
// Usage:
//   node tools/measure-regimes.mjs [corpus.json] [--json out.json]

import { readFileSync, writeFileSync } from 'node:fs';

import {
  buildOutlineIndex, indexAnswerDocument, indexQuestionDocument, questionsOnPage,
} from '../src/answer-index.js';
import { preparePair } from '../src/matching-engine.js';
import { TEXT_QUALITY } from '../src/text-quality.js';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const OUT = jsonAt >= 0 ? args[jsonAt + 1] : null;
const CORPUS = args.find(a => a.endsWith('.json') && a !== OUT)
  || 'tmp/expanded-corpus-20260825.json';

const raw = JSON.parse(readFileSync(CORPUS, 'utf-8'));

/** Valid pairs with independent question-level bookmark trees on both sides. */
const PAIRS = [
  { name: '2023', q: 'q2023', a: 'ans2023' },
  { name: '2024 Math Analysis', q: 'a2024', a: 'a2024_ma' },
  { name: '2024 Adv Algebra', q: 'g2024', a: 'a2024_alg' },
  { name: '2025 (scanned Q)', q: 'q2025', a: 'a2025' },
];

const oi = (d) => buildOutlineIndex(d.outline, d.lines, {
  numPages: d.numPages, quality: TEXT_QUALITY.USABLE,
});

function truthFor(qKey, aKey) {
  const q = oi(raw[qKey]);
  const a = oi(raw[aKey]);
  const answers = new Map(a.entries.map(e => [e.label, e]));
  const t = new Map();
  for (const qe of q.entries) {
    const ae = answers.get(qe.label);
    if (ae) t.set(qe.label, { qFrom: qe.page, qTo: qe.endPage, aFrom: ae.page, aTo: ae.endPage });
  }
  return t;
}

const asDoc = (d, keepOutline) => ({
  numPages: d.numPages,
  outline: keepOutline ? d.outline : { available: false, items: [] },
  async extractText({ from, to } = {}) {
    if (from == null && to == null) return d.lines;
    return d.lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
  },
});

async function run(pair, qBm, aBm) {
  const TRUTH = truthFor(pair.q, pair.a);
  const qDoc = asDoc(raw[pair.q], qBm);
  const aDoc = asDoc(raw[pair.a], aBm);

  const t0 = Date.now();
  // Through the product interface, not the internals. The gates are the point:
  // measuring matchPage directly would report numbers no caller can obtain.
  const prepared = await preparePair({
    exerciseDocument: qDoc, answerDocument: aDoc, expectScript: 'han',
  });
  const indexMs = Date.now() - t0;
  const qi = prepared.session?.exerciseIndex ?? { source: 'NONE', entries: [], quality: null };
  const ai = prepared.session?.answerIndex ?? { source: 'NONE', entries: [], quality: null };

  const r = {
    pair: pair.name, qBm, aBm,
    qSrc: qi.source, aSrc: ai.source,
    qEntries: qi.entries.length, aEntries: ai.entries.length,
    quality: { q: qi.quality, a: ai.quality },
    pairStatus: null, pairReasons: null,
    ocrRequired: !!(qi.ocrRequired || ai.ocrRequired),
    indexMs,
    accepted: 0, confirmed: 0, wrongPage: 0, unidentifiable: 0,
    distinct: new Set(), gold: TRUTH.size, ms: [],
  };

  r.pairStatus = prepared.status;
  r.pairReasons = prepared.decision.reasonCodes.join(',');
  if (!prepared.session) { r.strict = null; r.recall = 0; r.distinctCount = 0; delete r.distinct; delete r.ms; return r; }

  for (let page = 1; page <= qDoc.numPages; page++) {
    const qs = questionsOnPage(qi, page);
    if (qs.length === 0) continue;
    const s = Date.now();
    const matches = await prepared.session.matchQuestion({ page });
    r.ms.push(Date.now() - s);
    for (const m of matches) {
      if (!m.matched) continue;
      r.accepted++;
      const t = TRUTH.get(m.question.label);
      if (!t || page < t.qFrom || page > t.qTo) { r.unidentifiable++; continue; }
      const ap = m.entry?.page;
      if (ap >= t.aFrom && ap <= t.aTo) { r.confirmed++; r.distinct.add(m.question.label); }
      else r.wrongPage++;
    }
  }

  r.ms.sort((a, b) => a - b);
  r.p95 = r.ms[Math.floor(r.ms.length * 0.95)] ?? 0;
  r.max = r.ms[r.ms.length - 1] ?? 0;
  r.strict = r.accepted ? r.confirmed / r.accepted : null;
  r.recall = r.gold ? r.distinct.size / r.gold : null;
  r.distinctCount = r.distinct.size;
  delete r.distinct;
  delete r.ms;
  return r;
}

const pct = (x) => x === null ? '   n/a' : `${(x * 100).toFixed(1)}%`.padStart(6);
const REGIMES = [
  ['both     ', true, true],
  ['ansNone  ', true, false],
  ['exNone   ', false, true],
  ['neither  ', false, false],
];

const all = [];
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('  Full-book regimes — strict_precision = confirmed / accepted, no sampling');
console.log('═══════════════════════════════════════════════════════════════════════════════');
for (const pair of PAIRS) {
  if (!raw[pair.q] || !raw[pair.a]) continue;
  console.log(`\n── ${pair.name} ──`);
  console.log('  regime      idx(Q/A)           acc   conf  wrong  unid  strictP  recall      p95     max');
  for (const [label, qBm, aBm] of REGIMES) {
    const r = await run(pair, qBm, aBm);
    all.push(r);
    console.log(`  ${label}  ${(r.qSrc + '/' + r.aSrc).padEnd(17)}`
      + ` ${String(r.accepted).padStart(5)} ${String(r.confirmed).padStart(6)}`
      + ` ${String(r.wrongPage).padStart(6)} ${String(r.unidentifiable).padStart(5)}`
      + `  ${pct(r.strict)}  ${pct(r.recall)}`
      + ` ${String(r.p95).padStart(6)}ms ${String(r.max).padStart(5)}ms`
      + ` ${String(r.pairStatus ?? '').padEnd(14)} ${r.pairReasons ?? ''}`);
  }
}
console.log('');

if (OUT) {
  writeFileSync(OUT, JSON.stringify({
    corpus: CORPUS, when: new Date().toISOString(), results: all,
  }, null, 2));
  console.log(`raw results -> ${OUT}\n`);
}
