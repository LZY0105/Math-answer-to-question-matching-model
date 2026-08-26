#!/usr/bin/env node
// The public interface, and only the public interface.
//
// Every test here goes through preparePair / matchQuestion / matchAll. That is
// the point of the suite rather than an aesthetic preference: the defect these
// gates exist to close was that a caller could supply its own verification
// facts, so proving the gates hold means exercising them where a caller meets
// them. A test that reached into matchQuestion() would prove nothing about
// whether the product path can be bypassed.
//
// Fixtures are synthetic so the suite runs on a fresh clone. The real-corpus
// figures live in tools/measure-regimes.mjs and tools/measure-pair-matrix.mjs.

import assert from 'node:assert/strict';

import { preparePair } from '../src/matching-engine.js';
import { PAIR_STATUS, RUNG } from '../src/decision.js';

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const group = (n) => console.log(`\n─── [${n}] ───`);
async function check(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  MatchingEngine — the product interface');
console.log('═══════════════════════════════════════════════════════════════');

// ── fixtures ────────────────────────────────────────────────────────────────
//
// Roles are judged from whether entries WORK the problem, so an answer fixture
// has to actually contain worked solutions. Twenty-four questions clears the
// minimum the role classifier needs to form an opinion at all.

const N = 24;

function makeDoc({ role, year = '2024', subject = 'MA', pages = 40, sparse = false }) {
  const topic = subject === 'MA' ? '极限与连续函数' : '矩阵与行列式';
  // The task verb has to belong to the subject too, or a document asking for a
  // derivative in an algebra chapter reads as MIXED — which correctly declines
  // to claim a conflict, and would make this fixture prove nothing.
  const task = subject === 'MA' ? '求导数' : '求特征值';
  const chapter = subject === 'MA' ? '1' : '2';
  const lines = [];
  const items = [];
  for (let i = 1; i <= N; i++) {
    const page = i + 2;
    const label = `${chapter}.${i}`;
    items.push({ title: `例题 ${label}`, pageNumber: page, children: [] });
    const expr = `f(x)=x^${i}+${i}`;
    if (role === 'ANSWER') {
      lines.push({ page, text: `例题 ${label} (${year}. 某大学). ${task}，${expr}` });
      lines.push({ page, text: `解答：由 ${expr} 可得，因此 答案：${i}x^${i - 1}，所以证毕` });
      lines.push({ page, text: `综上，${topic} 的结论成立，故 得证` });
    } else {
      lines.push({ page, text: `例题 ${label} (${year}. 某大学). ${task}，${expr}` });
      lines.push({ page, text: `其中 ${topic} 为本节内容，${expr} 为待求函数` });
    }
  }
  if (sparse) {
    return {
      numPages: 400,
      outline: { available: true, items: [{ title: topic, pageNumber: 1, children: items }] },
      async extractText() { return lines.slice(0, 4); },
    };
  }
  return {
    numPages: pages,
    outline: { available: true, items: [{ title: `第${chapter}章 ${year} 年${topic}`, pageNumber: 1, children: items }] },
    async extractText({ from, to } = {}) {
      if (from == null && to == null) return lines;
      return lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
    },
  };
}

const EX = () => makeDoc({ role: 'EXERCISE' });
const ANS = () => makeDoc({ role: 'ANSWER' });

// ═══════════════════════════════════════════════════════════════
group('1. Both roles are checked, not just the right-hand one');

await check('a valid exercise -> answer pair prepares', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  assert.notEqual(p.status, PAIR_STATUS.REJECTED_PAIR, p.decision.reasonCodes.join(','));
  assert.ok(p.session, 'a usable pair must open a session');
});

await check('two answer books are rejected on the LEFT role', async () => {
  // The old check looked only at the right-hand document, so every A/A pair
  // walked straight through it.
  const p = await preparePair({ exerciseDocument: ANS(), answerDocument: ANS() });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR);
  assert.ok(p.decision.reasonCodes.includes('LEFT_ROLE_INVALID'));
  assert.equal(p.session, null, 'a rejected pair must not open a session');
});

await check('two exercise books are rejected on the RIGHT role', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: EX() });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR);
  assert.ok(p.decision.reasonCodes.includes('RIGHT_ROLE_INVALID'));
});

await check('answer -> exercise, the reversed orientation, is rejected', async () => {
  const p = await preparePair({ exerciseDocument: ANS(), answerDocument: EX() });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR);
});

// ═══════════════════════════════════════════════════════════════
group('2. Identity conflicts reject; missing identity does not');

await check('a year conflict is a hard rejection', async () => {
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', year: '2023' }),
    answerDocument: makeDoc({ role: 'ANSWER', year: '2025' }),
  });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR);
  assert.ok(p.decision.reasonCodes.includes('PAIR_IDENTITY_MISMATCH'));
});

await check('a subject conflict is a hard rejection', async () => {
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', subject: 'MA' }),
    answerDocument: makeDoc({ role: 'ANSWER', subject: 'ALG' }),
  });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR);
  assert.ok(p.decision.reasonCodes.includes('PAIR_IDENTITY_MISMATCH'));
});

await check('a rejected pair refuses to match anything at all', async () => {
  const p = await preparePair({ exerciseDocument: ANS(), answerDocument: ANS() });
  assert.equal(p.session, null);
  assert.equal(p.decision.status, RUNG.BLOCKED);
});

// ═══════════════════════════════════════════════════════════════
group('3. A caller cannot forge evidence');

await check('supplying pairStatus does not raise the verdict', async () => {
  // The single most dangerous thing the old interface allowed. matchPage()
  // defaulted pairStatus to VERIFIED_PAIR and accepted whatever a caller passed.
  const p = await preparePair({
    exerciseDocument: ANS(),
    answerDocument: ANS(),
    pairStatus: PAIR_STATUS.VERIFIED_PAIR,
    exactId: true,
    crossBookComparable: true,
  });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR,
    'verification facts are conclusions, never inputs');
});

await check('the session reports the status the engine derived', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  assert.equal(p.session.pairStatus, p.status);
});

// ═══════════════════════════════════════════════════════════════
group('4. Sparse and scanned input fails closed');

await check('a 400-page document with four lines is OCR_REQUIRED', async () => {
  // Ratio-based quality assessment called this USABLE, because the handful of
  // characters present decode perfectly well. Coverage is the missing question.
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', sparse: true }),
    answerDocument: ANS(),
  });
  assert.ok(p.decision.reasonCodes.includes('OCR_REQUIRED'),
    `expected OCR_REQUIRED, got ${p.decision.reasonCodes.join(',')}`);
});

await check('OCR_REQUIRED yields no automatic answer anywhere in the book', async () => {
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', sparse: true }),
    answerDocument: ANS(),
  });
  if (!p.session) return;                       // blocked outright is also acceptable
  const all = await p.session.matchAll();
  const auto = all.matches.filter(m => m.rung === RUNG.AUTO_MATCH);
  assert.equal(auto.length, 0, `${auto.length} automatic answers escaped the OCR gate`);
});

// ═══════════════════════════════════════════════════════════════
group('5. The rung ladder is honoured end to end');

await check('a verified pair produces automatic answers', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  const all = await p.session.matchAll();
  const auto = all.matches.filter(m => m.rung === RUNG.AUTO_MATCH);
  assert.ok(auto.length > 0, 'the capability must survive the gates');
});

await check('every automatic answer carries an entry, and no other rung does', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  const all = await p.session.matchAll();
  for (const m of all.matches) {
    if (m.rung === RUNG.AUTO_MATCH) {
      assert.ok(m.entry, 'an automatic answer must name its entry');
      assert.equal(m.matched, true);
    } else {
      assert.equal(m.matched, false,
        `${m.rung} must not report matched=true; that is how a guess reaches a reader`);
    }
  }
});

await check('a result below AUTO_MATCH always says why', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  const all = await p.session.matchAll();
  for (const m of all.matches) {
    if (m.rung === RUNG.AUTO_MATCH) continue;
    assert.ok(m.cappedBy || m.reasonCodes?.length || m.reason,
      'a capped result that cannot say why has not recorded its reasoning');
  }
});

await check('matchQuestion and matchAll agree on the same page', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  const all = await p.session.matchAll();
  const first = all.matches.find(m => m.question);
  const one = await p.session.matchQuestion({ page: first.question.page });
  assert.equal(one[0].rung, all.matches.find(
    m => m.question?.label === one[0].question?.label).rung,
    'single-question and whole-book flows must apply the same rules');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(FAIL > 0 ? 1 : 0);
