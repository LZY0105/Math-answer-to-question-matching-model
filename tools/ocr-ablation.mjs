#!/usr/bin/env node
// The OCR path, measured against the bookmark oracle.
//
// A book with a text layer and question bookmarks can play a scanned book: hide
// its text layer, hand the engine a recogniser that returns what was read off
// its pages, and score every automatic answer against the bookmark trees the
// way the corpus suites do. The recogniser's output comes from ocr/ocr_pages.py
// — the model's LaTeX, or with --oracle the text layer's own characters per
// region, which is the upper bound recognition is measured against.
//
// Two regimes, because a scanned book arrives in two shapes:
//
//   ids       question bookmarks on both sides. Identity resolves every
//             question before any text is read; what the recognised text
//             decides is the formula gate. The strict-policy recall is then a
//             direct measure of how well recognised formulas agree with the
//             answer key's text layer.
//
//   content   the exercise book keeps its chapters and sections but loses its
//             question bookmarks, as every textbook in the 2026-09 release has.
//             Each question is what the bookmark positions say the reader
//             tapped: the recognised formulas between one bookmark and the
//             next. Only content can match it, inside the aligned section.
//
// Usage:
//   node tools/ocr-ablation.mjs --corpus ../exam-corpus/data.json --exercise q2023 \
//     --answer ans2023 --regions ../exam-corpus/q2023-oracle.jsonl [--policy STRICT|CALIBRATED]
//     [--tap] [--regime ids|content] [--compare OTHER-REGIONS.jsonl] [--json OUT.json]
//
// --compare reads another reading of the same boxes, usually the oracle, and
// reports how often this one equals it in matcher form. For the 2024 留白
// books, regions and corpus must both come from the split ocr/clip_windows.py
// writes, or the text their clips hide is read as printed (ocr/MATCHING.md).

import { readFileSync } from 'node:fs';

import { buildOutlineIndex, indexAnswerDocument, indexQuestionDocument, questionsOnPage } from '../src/answer-index.js';
import { PAIR_STATUS, RUNG } from '../src/decision.js';
import { FORMULA_POLICY, compareFormulaSets, extractFormulaSet } from '../src/formula-set.js';
import { preparePair } from '../src/matching-engine.js';
import { NODE_KIND, classifyOutline } from '../src/outline-classify.js';
import { alignOutlines, contentSimilarity, matchPage } from '../src/question-matcher.js';
import { TEXT_QUALITY } from '../src/text-quality.js';

function parseArgs(argv) {
  const o = { policy: 'CALIBRATED', regimes: ['ids', 'content'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') o.corpus = argv[++i];
    else if (a === '--exercise') o.exercise = argv[++i];
    else if (a === '--answer') o.answer = argv[++i];
    else if (a === '--regions') o.regions = argv[++i];
    else if (a === '--policy') o.policy = argv[++i];
    else if (a === '--regime') o.regimes = argv[++i].split(',');
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--answer-lines-separated') o.answerLines = true;
    else if (a === '--tap') o.tap = true;
    else if (a === '--compare') o.compare = argv[++i];
    else throw new Error(`unrecognised argument: ${a}`);
  }
  for (const k of ['corpus', 'exercise', 'answer', 'regions']) if (!o[k]) throw new Error(`--${k} is required`);
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const raw = JSON.parse(readFileSync(opts.corpus, 'utf-8'));
const exerciseRaw = raw[opts.exercise];
let answerRaw = raw[opts.answer];
if (!exerciseRaw || !answerRaw) throw new Error('unknown corpus key');
// Experiment: treat every text-layer line of the answer key as its own
// expression context, the way a recognised region is one. Joined rows of
// display mathematics otherwise read as one expression on the answer side and
// as several on the recognised side.
if (opts.answerLines) {
  // Kept for comparison: lines are now expression boundaries on every path.
  answerRaw = { ...answerRaw, lines: answerRaw.lines.map(l => ({ ...l, text: `¶ ${l.text}` })) };
}

/** Regions by page, as the recogniser contract wants them. */
const byPage = new Map();
for (const line of readFileSync(opts.regions, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  const item = { top: r.bbox[1], bottom: r.bbox[3], centre: (r.bbox[1] + r.bbox[3]) / 2 };
  if (typeof r.latex === 'string') item.latex = r.latex;
  else { item.text = r.text; item.formula = true; }
  if (!byPage.has(r.page)) byPage.set(r.page, []);
  byPage.get(r.page).push(item);
}
for (const items of byPage.values()) items.sort((a, b) => a.top - b.top);
const recognizer = async (page) => byPage.get(page) ?? [];
const recognisedPages = byPage.size;

const asDoc = (d, { outline = d.outline, hideText = false } = {}) => ({
  numPages: d.numPages,
  outline,
  async extractText({ from, to } = {}) {
    if (hideText) return [];
    if (from == null && to == null) return d.lines;
    return d.lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
  },
});

/** The oracle: every exercise question bookmark with its answer bookmark span. */
function oracle() {
  const q = buildOutlineIndex(exerciseRaw.outline, [], { numPages: exerciseRaw.numPages, quality: TEXT_QUALITY.USABLE });
  const a = buildOutlineIndex(answerRaw.outline, [], { numPages: answerRaw.numPages, quality: TEXT_QUALITY.USABLE });
  const answers = new Map(a.entries.map(e => [e.label, e]));
  const truth = new Map();
  for (const qe of q.entries) {
    const ae = answers.get(qe.label);
    if (ae) truth.set(qe.label, { q: qe, qFrom: qe.page, qTo: qe.endPage, aFrom: ae.page, aTo: ae.endPage });
  }
  return { truth, questions: q.entries };
}

const { truth, questions: goldQuestions } = oracle();
const policy = FORMULA_POLICY[opts.policy] ?? FORMULA_POLICY.CALIBRATED;
const report = { exercise: opts.exercise, answer: opts.answer, policy: opts.policy, recognisedPages, gold: truth.size };

function scoreAccepts(matches, page, { checkPage = true } = {}) {
  const out = { auto: 0, right: 0, wrong: 0, unidentifiable: 0, labels: new Set(), capped: {} };
  for (const m of matches) {
    if (m.cappedBy) out.capped[m.cappedBy] = (out.capped[m.cappedBy] || 0) + 1;
    if (m.rung !== RUNG.AUTO_MATCH) continue;
    out.auto++;
    const label = m.question?.label;
    const t = truth.get(label);
    // A tapped unit is identified by its printed heading, which in the 2024
    // 留白 books sits on a listing page the bookmark does not point to; the
    // answer span still decides whether the match is right.
    if (!t || (checkPage && (page < t.qFrom || page > t.qTo))) { out.unidentifiable++; continue; }
    const ok = m.entry?.label === label && m.entry?.page >= t.aFrom && m.entry?.page <= t.aTo;
    if (ok) { out.right++; out.labels.add(label); } else out.wrong++;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
if (opts.regimes.includes('ids')) {
  const exerciseDoc = asDoc(exerciseRaw, { hideText: true });
  const answerDoc = asDoc(answerRaw);
  const prepared = await preparePair({ exerciseDocument: exerciseDoc, answerDocument: answerDoc, recognizer, expectScript: 'han', formulaPolicy: policy });
  const ex = prepared.session?.exerciseIndex;
  const ids = {
    pairStatus: prepared.status,
    reasons: prepared.decision.reasonCodes,
    exerciseIndex: ex ? { source: ex.source, entries: ex.entries.length, quality: ex.quality, textOrigin: ex.textOrigin, ocrRequired: ex.ocrRequired } : null,
    anchors: prepared.decision.evidence?.anchors ?? null,
    roles: { exercise: prepared.decision.exerciseRole, answer: prepared.decision.answerRole },
  };
  // The engine's own verdict first; then matching under a binding, which is
  // the product's path for a pair the engine cannot verify on its own.
  const totals = { auto: 0, right: 0, wrong: 0, unidentifiable: 0, labels: new Set(), capped: {} };
  if (prepared.session) {
    const session = prepared.session;
    const answerIndex = session.answerIndex;
    for (let page = 1; page <= exerciseRaw.numPages; page++) {
      const qs = questionsOnPage(ex, page);
      if (qs.length === 0) continue;
      const matches = matchPage(qs, answerIndex, {
        alignment: session.alignment, exercisePage: page, answerPageCount: answerRaw.numPages,
        questionCount: ex.entries.length, pairStatus: PAIR_STATUS.VERIFIED_PAIR, formulaPolicy: policy,
      });
      const s = scoreAccepts(matches, page);
      totals.auto += s.auto; totals.right += s.right; totals.wrong += s.wrong; totals.unidentifiable += s.unidentifiable;
      for (const l of s.labels) totals.labels.add(l);
      for (const [k, v] of Object.entries(s.capped)) totals.capped[k] = (totals.capped[k] || 0) + v;
    }
    // Representation gap: the recognised text of each question against the
    // answer's text, and against the question's own text layer.
    const textIndex = await indexQuestionDocument(asDoc(exerciseRaw), { expectScript: 'han' });
    const layerByLabel = new Map(textIndex.entries.map(e => [e.label, e]));
    const answerByLabel = new Map(answerIndex.entries.map(e => [e.label, e]));
    let n = 0; let coverageSum = 0; let full = 0; let conflicts = 0; let simLayerSum = 0; let simAnswerSum = 0; let empty = 0;
    for (const e of ex.entries) {
      const own = e.scopedText || e.text;
      if (!own) { empty++; continue; }
      const a = answerByLabel.get(e.label);
      const layer = layerByLabel.get(e.label);
      if (!a || !layer) continue;
      n++;
      const cmp = compareFormulaSets(extractFormulaSet(own), extractFormulaSet(a.scopedText || a.text));
      if (cmp.sufficient) { coverageSum += cmp.coverage; if (cmp.coverage >= 1) full++; if (cmp.conflicts.length) conflicts++; }
      simAnswerSum += contentSimilarity(own, a.scopedText || a.text);
      simLayerSum += contentSimilarity(own, layer.scopedText || layer.text);
    }
    ids.gap = {
      questionsWithText: n, questionsWithoutText: empty,
      meanCoverageAgainstAnswer: n ? +(coverageSum / n).toFixed(3) : null,
      fullCoverage: full, withConflict: conflicts,
      meanSimilarityToAnswer: n ? +(simAnswerSum / n).toFixed(3) : null,
      meanSimilarityToOwnTextLayer: n ? +(simLayerSum / n).toFixed(3) : null,
    };
  }
  ids.matching = { auto: totals.auto, right: totals.right, wrong: totals.wrong, unidentifiable: totals.unidentifiable, distinct: totals.labels.size, capped: totals.capped };
  report.ids = ids;
}

// ═══════════════════════════════════════════════════════════════
// The reader's tap, simulated. A question's printed extent runs from its
// heading line to the next heading line; the text layer knows where those
// are, a scan does not, and the reader pointing at a question supplies it.
// Each question keeps its id and is handed only the recognised regions inside
// that extent, which is what the product's tap region does on a scan.
if (opts.regimes.includes('ids') && opts.tap && exerciseRaw.lines.some(l => Number.isFinite(l.y))) {
  const { parseQuestionLine } = await import('../src/question-id.js');
  const headings = [];
  for (const l of exerciseRaw.lines) {
    const parsed = parseQuestionLine(l.text);
    if (parsed && Number.isFinite(l.y)) headings.push({ label: parsed.id, page: l.page, y: l.y });
  }
  headings.sort((a, b) => (a.page - b.page) || (a.y - b.y));
  const seen = new Set();
  const firstHeading = headings.filter(h => (seen.has(h.label) ? false : (seen.add(h.label), true)));
  const answerIndex = await indexAnswerDocument(asDoc(answerRaw), { expectScript: 'han' });
  const alignment = alignOutlines(exerciseRaw.outline, answerRaw.outline, { exercisePageCount: exerciseRaw.numPages, answerPageCount: answerRaw.numPages });
  const { latexToText } = await import('../src/formula-latex.js');
  const totals = { auto: 0, right: 0, wrong: 0, unidentifiable: 0, labels: new Set(), capped: {}, units: 0, unitsWithText: 0 };
  for (let i = 0; i < firstHeading.length; i++) {
    const h = firstHeading[i];
    if (!truth.has(h.label)) continue;
    const next = firstHeading[i + 1];
    const parts = [];
    const lastPage = next ? next.page : h.page;
    for (let page = h.page; page <= lastPage; page++) {
      // A heading's y is its baseline; a region on that row has its middle a
      // third of a line above it. Six points keeps the heading's own row and
      // drops the row above.
      for (const r of byPage.get(page) ?? []) {
        if (page === h.page && r.centre < h.y - 6) continue;
        if (next && page === next.page && r.centre >= next.y - 6) continue;
        parts.push(r.latex !== undefined ? latexToText(r.latex) : r.text);
      }
    }
    totals.units++;
    if (!parts.length) continue;
    totals.unitsWithText++;
    const text = parts.join('\n');
    const question = { label: h.label, text, scopedText: text, page: h.page, ordinal: i };
    const matches = matchPage([question], answerIndex, {
      alignment, exercisePage: h.page, answerPageCount: answerRaw.numPages, questionCount: firstHeading.length,
      pairStatus: PAIR_STATUS.VERIFIED_PAIR, formulaPolicy: policy,
    });
    const sc = scoreAccepts(matches, h.page, { checkPage: false });
    totals.auto += sc.auto; totals.right += sc.right; totals.wrong += sc.wrong; totals.unidentifiable += sc.unidentifiable;
    for (const l of sc.labels) totals.labels.add(l);
    for (const [k, v] of Object.entries(sc.capped)) totals.capped[k] = (totals.capped[k] || 0) + v;
  }
  report.tap = { units: totals.units, unitsWithText: totals.unitsWithText, auto: totals.auto, right: totals.right, wrong: totals.wrong, unidentifiable: totals.unidentifiable, distinct: totals.labels.size, capped: totals.capped };
}

// ═══════════════════════════════════════════════════════════════
if (opts.regimes.includes('content')) {
  // Sections only: drop every question-kind node from the exercise outline.
  const classified = classifyOutline(exerciseRaw.outline, { numPages: exerciseRaw.numPages });
  const questionTitles = new Set(classified.nodes.filter(n => n.kind === NODE_KIND.QUESTION).map(n => n.title));
  const strip = (items) => (items ?? []).filter(it => !questionTitles.has(it.title)).map(it => ({ ...it, children: strip(it.children) }));
  const sectionsOnly = { available: true, items: strip(exerciseRaw.outline.items) };

  const answerIndex = await indexAnswerDocument(asDoc(answerRaw), { expectScript: 'han' });
  const alignment = alignOutlines(sectionsOnly, answerRaw.outline, { exercisePageCount: exerciseRaw.numPages, answerPageCount: answerRaw.numPages });

  // Each gold question becomes what the reader tapped: the recognised regions
  // between its bookmark and the next, on its pages. No label.
  const sorted = [...goldQuestions].sort((a, b) => (a.page - b.page) || ((a.top ?? 0) - (b.top ?? 0)));
  const units = sorted.map((q, i) => {
    const next = sorted[i + 1];
    const parts = [];
    for (let page = q.page; page <= (next ? Math.max(q.endPage ?? q.page, next.page) : (q.endPage ?? q.page)); page++) {
      for (const r of byPage.get(page) ?? []) {
        if (page === q.page && Number.isFinite(q.top) && r.centre < q.top - 3) continue;
        if (next && page === next.page && Number.isFinite(next.top) && r.centre >= next.top - 3) continue;
        parts.push(r.latex !== undefined ? r.latex : r.text);
      }
    }
    return { gold: q.label, page: q.page, ordinal: i, parts };
  });
  const { latexToText } = await import('../src/formula-latex.js');
  const withText = units.map(u => ({
    ...u,
    text: u.parts.map(p => (byPage.get(u.page)?.some(r => r.latex !== undefined) ? latexToText(p) : p)).join('\n'),
  }));

  const content = { units: units.length, unitsWithText: withText.filter(u => u.text.trim()).length, alignedSections: alignment.pairs.length };
  let auto = 0, right = 0, wrong = 0; const capped = {}; let top1 = 0, ranked = 0, noRange = 0;
  const bands = {};
  let covRanked = 0, covTop1 = 0, covConfident = 0, covConfidentWrong = 0; const covBands = {};
  for (const u of withText) {
    if (!u.text.trim()) continue;
    const question = { label: '', text: u.text, scopedText: u.text, page: u.page, ordinal: u.ordinal };
    const matches = matchPage([question], answerIndex, {
      alignment, exercisePage: u.page, answerPageCount: answerRaw.numPages, questionCount: units.length,
      pairStatus: PAIR_STATUS.VERIFIED_PAIR, formulaPolicy: policy,
    });
    const m = matches[0];
    if (m.cappedBy) capped[m.cappedBy] = (capped[m.cappedBy] || 0) + 1;
    if (m.rung === RUNG.AUTO_MATCH) { auto++; if (m.entry?.label === u.gold) right++; else wrong++; }
    // Discriminability, independent of thresholds: within the aligned range,
    // does the gold entry score highest?
    const range = m.range;
    if (!range) { noRange++; continue; }
    const pool = answerIndex.entries.filter(e => e.page >= range.from && e.page <= range.to);
    const gold = pool.find(e => e.label === u.gold);
    if (!gold) { noRange++; continue; }
    ranked++;
    const scored = pool.map(e => ({ e, s: contentSimilarity(u.text, e.scopedText || e.text) })).sort((a, b) => b.s - a.s);
    const goldScore = scored.find(x => x.e === gold).s;
    const bestOther = scored.find(x => x.e !== gold)?.s ?? 0;
    if (goldScore > bestOther) top1++;
    const band = `${Math.floor(Math.max(0, goldScore - bestOther) * 10) / 10}`;
    bands[band] = (bands[band] || 0) + 1;
    // Second ranking: how much of the question's mathematics each candidate
    // carries, which is asymmetric and does not care how long the answer is.
    const qSet = extractFormulaSet(u.text);
    if (qSet.count > 0) {
      const cov = pool.map((e) => {
        const cmp = compareFormulaSets(qSet, extractFormulaSet(e.scopedText || e.text));
        return { e, c: cmp.coverage - 0.5 * (cmp.conflicts.length / Math.max(1, cmp.total)) };
      }).sort((a, b) => b.c - a.c);
      covRanked++;
      const g = cov.find(x => x.e === gold).c;
      const o = cov.find(x => x.e !== gold)?.c ?? -1;
      if (g > o) covTop1++;
      if (g > o && g >= 0.5 && g - o >= 0.25) covConfident++;
      if (g <= o && cov[0].c >= 0.5 && cov[0].c - (cov[1]?.c ?? -1) >= 0.25) covConfidentWrong++;
      const cb = `${Math.floor(Math.max(0, g - o) * 10) / 10}`;
      covBands[cb] = (covBands[cb] || 0) + 1;
    }
  }
  content.matching = { auto, right, wrong, capped };
  content.discriminability = { ranked, goldRanksFirst: top1, noAlignedRange: noRange, marginHistogram: bands };
  content.coverageRanking = {
    ranked: covRanked, goldRanksFirst: covTop1,
    confidentRight: covConfident, confidentWrong: covConfidentWrong,
    rule: 'coverage minus half the conflict share; confident = top >= 0.5 and margin >= 0.25',
    marginHistogram: covBands,
  };
  report.content = content;
}

// ═══════════════════════════════════════════════════════════════
// Region-level agreement with another reading of the same boxes, usually the
// oracle: how often the recogniser's text, in matcher form, equals the text
// layer's, and how close it is when it does not.
if (opts.compare) {
  const { latexToText } = await import('../src/formula-latex.js');
  const { normalizeForMatch } = await import('../src/question-matcher.js');
  const other = new Map();
  for (const line of readFileSync(opts.compare, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    other.set(`${r.page}|${r.bbox.join(',')}`, r);
  }
  let n = 0; let same = 0; let simSum = 0; let unmatched = 0; const worst = [];
  for (const line of readFileSync(opts.regions, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const o = other.get(`${r.page}|${r.bbox.join(',')}`);
    if (!o) { unmatched++; continue; }
    const mine = normalizeForMatch(typeof r.latex === 'string' ? latexToText(r.latex) : r.text);
    const theirs = normalizeForMatch(typeof o.latex === 'string' ? latexToText(o.latex) : o.text);
    n++;
    if (mine === theirs) same++;
    const sim = contentSimilarity(mine, theirs);
    simSum += sim;
    if (mine !== theirs && worst.length < 12) worst.push({ page: r.page, read: mine, layer: theirs, sim: Number(sim.toFixed(2)) });
  }
  report.regionAgreement = {
    regions: n, identical: same, identicalShare: n ? Number((same / n).toFixed(4)) : null,
    meanSimilarity: n ? Number((simSum / n).toFixed(4)) : null, withoutCounterpart: unmatched, examples: worst,
  };
}

console.log(JSON.stringify(report, (k, v) => (v instanceof Set ? [...v] : v), 2));
if (opts.json) (await import('node:fs')).writeFileSync(opts.json, JSON.stringify(report, null, 2));
