#!/usr/bin/env node
// Measures what the LOCATED rung recovers, and what it costs.
//
// Scored against the same bookmark oracle the ablation suite uses: ground truth
// comes from the two bookmark trees, which are structural and independent of the
// text layer every ablated run is forced onto. Nothing here is scored against
// anything the engine produced.
//
// A region "contains the answer" when the true answer's first page falls inside
// it. That is the operational question — turn to these pages, is it there — and
// it is deliberately not softened to "overlaps", which would score a region that
// starts after the answer as a success.
//
// Refusals are split into recoverable and irreducible by asking whether the true
// answer was even present in the index the engine was searching. If no entry in
// that index covers the true answer's pages, no matcher could have found it and
// the refusal is a floor, not a failure. That split is the only honest way to
// state how much headroom exists.

import { existsSync, readFileSync } from 'node:fs';
import { PAIR_STATUS } from '../src/decision.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOutlineIndex,
  indexAnswerDocument,
  indexQuestionDocument,
  questionsOnPage,
} from '../src/answer-index.js';
import { alignOutlines, matchPage } from '../src/question-matcher.js';
import { locateAnswerRegion } from '../src/region-locator.js';
import { classifyOutline } from '../src/outline-classify.js';
import { RUNG } from '../src/decision.js';
import { TEXT_QUALITY } from '../src/text-quality.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CORPUS = process.env.FIND_ENGINE_CORPUS
  || join(ROOT, '..', 'find-engine-corpus', 'data.json');

if (!existsSync(CORPUS)) {
  console.log(`corpus not found at ${CORPUS}`);
  process.exit(0);
}
const raw = JSON.parse(readFileSync(CORPUS, 'utf-8'));

const outlineIndex = (d) => buildOutlineIndex(d.outline, d.lines, {
  numPages: d.numPages, quality: TEXT_QUALITY.USABLE,
});

const TRUTH = (() => {
  const q = outlineIndex(raw.q2023);
  const a = outlineIndex(raw.ans2023);
  const answers = new Map(a.entries.map(e => [e.label, e]));
  const truth = new Map();
  for (const qe of q.entries) {
    const ae = answers.get(qe.label);
    if (ae) truth.set(qe.label, { qFrom: qe.page, qTo: qe.endPage, aFrom: ae.page, aTo: ae.endPage });
  }
  return truth;
})();

const asDocument = (d, { outline = true, text = true } = {}) => ({
  numPages: d.numPages,
  outline: outline ? d.outline : { available: false, items: [] },
  async extractText({ from, to } = {}) {
    if (!text) return [];
    if (from == null && to == null) return d.lines;
    return d.lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
  },
});

/** Outline with the question level removed — the 2025 exercise-book structure. */
const truncateToSections = (outline) => ({
  available: true,
  items: (outline.items || []).map(ch => ({
    ...ch,
    children: (ch.children || []).map(s => ({ ...s, children: [] })),
  })),
});

const contains = (region, page) => !!region && page >= region.from && page <= region.to;

// ── regime measurement, now including the lower rungs ───────────────────────

async function measure(name, { questionBookmarks, answerBookmarks, stride = 1 }) {
  const qDoc = asDocument(raw.q2023, { outline: questionBookmarks });
  const aDoc = asDocument(raw.ans2023, { outline: answerBookmarks });

  const questionIndex = await indexQuestionDocument(qDoc, { expectScript: 'han' });
  const answerIndex = await indexAnswerDocument(aDoc, { expectScript: 'han' });
  const alignment = alignOutlines(qDoc.outline, aDoc.outline, {
    exercisePageCount: qDoc.numPages, answerPageCount: aDoc.numPages,
  });

  const r = {
    name,
    auto: 0, autoCorrect: 0, autoWrong: 0,
    review: 0, reviewHit: 0,
    located: 0, locatedCorrect: 0,
    refused: 0, recoverable: 0, irreducible: 0,
    unidentifiable: 0,
    distinctAuto: new Set(), distinctActionable: new Set(),
  };

  for (let page = 1; page <= qDoc.numPages; page += stride) {
    const questions = questionsOnPage(questionIndex, page);
    if (questions.length === 0) continue;

    const matches = matchPage(questions, answerIndex, {
      pairStatus: PAIR_STATUS.VERIFIED_PAIR,
      alignment,
      exercisePage: page,
      answerPageCount: aDoc.numPages,
      questionCount: questionIndex.entries.length,
    });

    for (const m of matches) {
      const t = TRUTH.get(m.question.label);
      // Same two-fact identification test the ablation suite uses.
      if (!t || page < t.qFrom || page > t.qTo) { r.unidentifiable++; continue; }

      if (m.rung === RUNG.AUTO_MATCH) {
        r.auto++;
        if (m.entry?.page >= t.aFrom && m.entry?.page <= t.aTo) {
          r.autoCorrect++; r.distinctAuto.add(m.question.label);
          r.distinctActionable.add(m.question.label);
        } else r.autoWrong++;
        continue;
      }

      if (m.rung === RUNG.REVIEW) {
        r.review++;
        // A REVIEW arrives two ways and both must be scored: an ambiguous
        // refusal carrying several candidates, and a matched-but-LOW result
        // carrying one entry that is not trusted enough to display as an answer.
        const inRange = (p) => p >= t.aFrom && p <= t.aTo;
        const hit = (m.candidates ?? []).some(c => inRange(c.page))
          || (m.entry ? inRange(m.entry.page) : false);
        if (hit) { r.reviewHit++; r.distinctActionable.add(m.question.label); }
        continue;
      }

      if (m.rung === RUNG.LOCATED) {
        r.located++;
        if (contains(m.region, t.aFrom)) {
          r.locatedCorrect++; r.distinctActionable.add(m.question.label);
        }
        continue;
      }

      r.refused++;
      // Was the answer even in the index the engine searched?
      const reachable = answerIndex.entries.some(e =>
        e.page <= t.aTo && (e.endPage ?? e.page) >= t.aFrom);
      if (reachable) r.recoverable++; else r.irreducible++;
    }
  }
  return r;
}

// ── the scanned exercise book: no questions at all, only a page ─────────────
//
// The product case from §4.5. The reader taps a page of a book the engine cannot
// read; the answer key is intact. No question index exists, so this asks the
// only question that can be asked: given this page, which answer pages?

function measurePageOnly(name, { truncate }) {
  const qOutline = truncate ? truncateToSections(raw.q2023.outline) : raw.q2023.outline;
  const alignment = alignOutlines(qOutline, raw.ans2023.outline, {
    exercisePageCount: raw.q2023.numPages, answerPageCount: raw.ans2023.numPages,
  });

  const qIdx = outlineIndex(raw.q2023);   // oracle only — the engine does not see this
  const byPage = new Map();
  for (const e of qIdx.entries) {
    for (let p = e.page; p <= e.endPage; p++) {
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push(e.label);
    }
  }

  const r = { name, pages: 0, withRegion: 0, questionsCovered: 0, questionsCorrect: 0, distinct: new Set() };
  for (let page = 1; page <= raw.q2023.numPages; page++) {
    const labels = byPage.get(page) ?? [];
    if (labels.length === 0) continue;
    r.pages++;
    const region = locateAnswerRegion(alignment, {
      exercisePage: page, answerPageCount: raw.ans2023.numPages,
    });
    if (!region) continue;
    r.withRegion++;
    for (const label of labels) {
      const t = TRUTH.get(label);
      if (!t) continue;
      r.questionsCovered++;
      if (contains(region, t.aFrom)) { r.questionsCorrect++; r.distinct.add(label); }
    }
  }
  return r;
}

// ── the defect this replaced ───────────────────────────────────────────────

function reportClassification() {
  console.log('\n─── Outline classification ───');
  for (const [k, d] of [['q2023', raw.q2023], ['ans2023', raw.ans2023],
    ['a2024', raw.a2024], ['g2024', raw.g2024]]) {
    const c = classifyOutline(d.outline, { numPages: d.numPages });
    console.log(`  ${k.padEnd(9)} questions ${String(c.questions.length).padStart(4)}`
      + `  sections ${String(c.sections.length).padStart(3)}`);
  }
  const trunc = classifyOutline(truncateToSections(raw.q2023.outline), { numPages: 368 });
  console.log(`  ${'q2023*'.padEnd(9)} questions ${String(trunc.questions.length).padStart(4)}`
    + `  sections ${String(trunc.sections.length).padStart(3)}`
    + '   * question level removed (2025 exercise-book structure)');
  for (const c of trunc.cohorts) console.log(`             depth ${c.depth}: ${c.kind} (n=${c.count}) — ${c.reason}`);
}

const pct = (n, d) => d === 0 ? '   n/a' : `${((n / d) * 100).toFixed(1)}%`.padStart(6);

console.log('═══════════════════════════════════════════════════════════════');
console.log('  LOCATED coverage, scored against the bookmark oracle');
console.log('═══════════════════════════════════════════════════════════════');

reportClassification();

console.log('\n─── Per regime (full books, no page sampling except where noted) ───');
const regimes = [
  ['A. both bookmarked      ', { questionBookmarks: true, answerBookmarks: true }],
  ['B. answer key none      ', { questionBookmarks: true, answerBookmarks: false }],
  ['C. exercise none (1/8)  ', { questionBookmarks: false, answerBookmarks: true, stride: 8 }],
  ['D. neither (1/16)       ', { questionBookmarks: false, answerBookmarks: false, stride: 16 }],
];

const rows = [];
for (const [label, opts] of regimes) rows.push(await measure(label, opts));

console.log('\n  regime                    AUTO  wrong  strictP | REVIEW  hit | LOCATED  in-region | REFUSED  recov  irred');
for (const r of rows) {
  console.log(`  ${r.name}  ${String(r.auto).padStart(4)}  ${String(r.autoWrong).padStart(5)}`
    + `  ${pct(r.autoCorrect, r.auto)} | ${String(r.review).padStart(6)} ${String(r.reviewHit).padStart(4)}`
    + ` | ${String(r.located).padStart(7)}  ${pct(r.locatedCorrect, r.located)}`
    + ` | ${String(r.refused).padStart(7)} ${String(r.recoverable).padStart(6)} ${String(r.irreducible).padStart(6)}`);
}

console.log('\n  regime                    distinct AUTO   distinct actionable (AUTO+REVIEW-hit+LOCATED-in-region)');
for (const r of rows) {
  console.log(`  ${r.name}  ${String(r.distinctAuto.size).padStart(13)}   ${String(r.distinctActionable.size).padStart(19)}`);
}

console.log('\n─── Scanned exercise book: page in, region out (§4.5) ───');
for (const [label, opts] of [
  ['full outline           ', { truncate: false }],
  ['question level removed ', { truncate: true }],
]) {
  const r = measurePageOnly(label, opts);
  console.log(`  ${r.name}  pages ${String(r.pages).padStart(3)}`
    + `, region returned ${pct(r.withRegion, r.pages)}`
    + `, questions on those pages ${String(r.questionsCovered).padStart(4)}`
    + `, answer inside region ${pct(r.questionsCorrect, r.questionsCovered)}`
    + `, distinct ${r.distinct.size}`);
}
console.log('');
