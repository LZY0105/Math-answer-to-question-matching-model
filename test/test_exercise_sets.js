#!/usr/bin/env node
// Exercises identified by set and printed number, answers by section and
// printed number. See src/exercise-sets.js.
//
// The shape is the 绿皮书 pair's (book-026 against book-044): the exercise book
// bookmarks 习题 sets inside its sections and is read by a recogniser, the
// answer book bookmarks sections only and numbers its answers inside each.

import assert from 'node:assert/strict';

import { buildOutlineIndex, buildSectionIndex, indexAnswerDocument, indexQuestionDocument } from '../src/answer-index.js';
import { createBinding, fingerprintDocument } from '../src/fingerprint.js';
import { exercisesOfSet, numberedRun, openerNumber } from '../src/exercise-sets.js';
import { preparePair } from '../src/matching-engine.js';
import { FORMULA_POLICY } from '../src/formula-set.js';
import { PAIR_STATUS, RUNG } from '../src/decision.js';

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const group = (n) => console.log(`\n─── [${n}] ───`);
async function check(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Exercise sets and answer sections: ids a book prints');
console.log('═══════════════════════════════════════════════════════════════');

const lines = (texts) => texts.map((text, i) => ({ page: 1, text, top: 100 + 20 * i, bottom: 112 + 20 * i }));

group('1. A numbered run is read from its sequence');

await check('openers are a number and a terminator at the start of a line', () => {
  assert.equal(openerNumber('3. 计算下列行列式'), 3);
  assert.equal(openerNumber('3,'), 3, 'a scanned period read as a comma');
  assert.equal(openerNumber('1, ⋯, 1, λ − 1'), null, 'a list is not an opener');
  assert.equal(openerNumber('1,2,'), null);
  assert.equal(openerNumber('12、证明'), 12);
  assert.equal(openerNumber('1.1 二阶行列式'), null, 'a section number is not an opener');
  assert.equal(openerNumber('(3) 求'), null, 'a subquestion is not an opener');
  assert.equal(openerNumber('2023 年'), null);
});

await check('a run counts forward from 1, and a skipped number flags the items on both sides of it', () => {
  const run = numberedRun(lines(['1.', 'x', '2.', '4.', '5.']));
  assert.deepEqual(run.map(r => r.number), [1, 2, 4, 5]);
  assert.deepEqual(run.map(r => r.followedByGap), [false, true, false, false]);
  // "4." read where "3." is printed looks exactly like this: the 4 has no
  // predecessor anyone saw.
  assert.deepEqual(run.map(r => r.precededByGap), [false, false, true, false]);
});

await check('a number that goes back starts nothing, and stays inside the item as a stray', () => {
  // A numbered list in the body before the set, then the set itself, with a
  // repeated "2." inside exercise 3.
  const run = numberedRun(lines(['1. 定理', '2. 推论', '1.', '2.', '3.', '2.', '4.']));
  assert.deepEqual(run.map(r => r.index), [2, 3, 4, 6]);
  assert.deepEqual(run.map(r => r.strays), [[], [], [5], []]);
});

await check('a run may start at 2 when the 1 was not read, unconfirmed; a lone number is no run', () => {
  const run = numberedRun(lines(['2.', '3.', '4.']));
  assert.deepEqual(run.map(r => r.number), [2, 3, 4]);
  assert.equal(run[0].precededByGap, true);
  assert.deepEqual(numberedRun(lines(['1.', 'x'])), []);
});

await check('an opener off the margin its set shares on the page is flagged', () => {
  const at = (rows) => rows.map(([text, left, page = 1], i) => ({ page, text, left, top: 100 + 20 * i, bottom: 110 + 20 * i }));
  const flags = (rows) => exercisesOfSet({ label: '7.5' }, at(rows)).map(e => e.misaligned);
  assert.deepEqual(flags([['1.', 110], ['2.', 111], ['3.', 150], ['4.', 109]]), [false, false, true, false]);
  // Two that disagree: nothing says which is on the margin.
  assert.deepEqual(flags([['1,', 168], ['x', 126], ['2.', 126]]), [true, true]);
  // Margins differ between facing pages; each page is judged on its own.
  assert.deepEqual(flags([['1.', 110], ['2.', 110], ['3.', 150, 2], ['4.', 150, 2]]), [false, false, false, false]);
  // No position from the reader, no judgement.
  assert.deepEqual(flags([['1.'], ['2.'], ['3.']]), [false, false, false]);
});

await check('the last exercise ends at the break before what follows the set', () => {
  // Exercise 2 runs two lines; a heading follows after a paragraph break.
  const rows = [['1.', 100], ['x', 115], ['y', 130], ['2.', 160], ['z', 175], ['§ 1.2', 230], ['body', 245], ['more', 260]]
    .map(([text, top]) => ({ page: 1, text, top, bottom: top + 10 }));
  const [, last] = exercisesOfSet({ label: '1.1' }, rows);
  assert.deepEqual(last.spans, [{ page: 1, top: 160, bottom: 185, estimated: true }]);
});

await check('an exercise over a page break leaves out the running head of the next page', () => {
  // The scanner's edge, a running head as close above the text as its lines
  // are to each other, the rest of exercise 1, then exercise 2.
  const rows = [
    [1, '1.', 600, 610], [1, 'x', 615, 625], [1, 'y', 630, 640],
    [2, 'edge', 1, 70], [2, '12 高等代数学', 110, 119], [2, '~', 119.5, 123], [2, 'z', 138, 148], [2, 'w', 153, 163], [2, '2.', 168, 178], [2, 'v', 183, 193],
  ].map(([page, text, top, bottom]) => ({ page, text, top, bottom }));
  const [first] = exercisesOfSet({ label: '1.1' }, rows);
  assert.deepEqual(first.spans, [{ page: 1, top: 600, bottom: 640 }, { page: 2, top: 138, bottom: 167.5 }]);
  // Ending on its own page, it claims nothing of the next but that page's
  // running head, so nothing at all.
  const ended = rows.filter(r => !['z', 'w'].includes(r.text));
  assert.deepEqual(exercisesOfSet({ label: '1.1' }, ended)[0].spans, [{ page: 1, top: 600, bottom: 640 }]);
});

group('2. A 习题 set becomes its exercises; a question does not');

const exerciseOutline = (sets = true) => ({
  available: true,
  items: [{
    title: '第一章 行列式', pageNumber: 2, children: [
      { title: '1.1 二阶行列式', pageNumber: 2, children: sets ? [{ title: '习题 1.1', pageNumber: 3, children: [] }] : [] },
      { title: '1.2 三阶行列式', pageNumber: 3, children: sets ? [{ title: '习题 1.2', pageNumber: 5, children: [] }] : [] },
      { title: '1.3 n 阶行列式', pageNumber: 6, children: sets ? [{ title: '习题 1.3', pageNumber: 7, children: [] }] : [] },
    ],
  }],
});

// What a recogniser reads at the start of each line of the scanned pages: the
// printed numbers, and whatever a formula model makes of the rest. Every page
// carries some of the second, as a real page does, so the reading is judged
// usable (src/text-quality.js wants twenty characters a page).
const BODY = [['f ( x ) = x ^ { 2 } + 1', 60], ['A = ( a _ { i j } ) _ { n \\times n }', 80], ['\\det A \\neq 0', 100]];
const SCAN = {
  3: [['x = a ^ { 2 }', 120], ['1.', 180], ['( 1 ) \\left| 1 2 3 4 \\right|', 195], ['2.', 228], ['3.', 276], ['s 1 . 2', 560], ['A = a _ { i j }', 600]],
  5: [['1.', 150], ['2.', 200], ['3.', 260], ['4.', 330]],
  7: [['1.', 150], ['2.', 190], ['4.', 300], ['5.', 340]],
};
const recognizer = async (page) => [...BODY, ...(SCAN[page] ?? [])]
  .map(([latex, top]) => ({ latex, top, bottom: top + 10 }));

const scannedExercise = () => ({
  numPages: 8,
  outline: exerciseOutline(),
  async extractText() { return [{ page: 1, text: '微信公众号' }]; },
});

await check('each set is replaced by its exercises, numbered set.number, with bands', async () => {
  const index = await indexQuestionDocument(scannedExercise(), { expectScript: 'han', recognizer });
  assert.equal(index.textOrigin, 'OCR_FORMULA');
  const labels = index.entries.map(e => e.label);
  assert.deepEqual(labels, ['1.1.1', '1.1.2', '1.1.3', '1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.3.1', '1.3.2', '1.3.4', '1.3.5']);
  const e112 = index.entries.find(e => e.label === '1.1.2');
  assert.equal(e112.parentSection, '1.1 二阶行列式');
  assert.deepEqual(e112.spans, [{ page: 3, top: 228, bottom: 275.5 }]);
  const last = index.entries.find(e => e.label === '1.1.3');
  assert.ok(last.spans[0].estimated && last.spans[0].bottom < 560, 'the last band stops short of the next section');
  assert.equal(index.entries.find(e => e.label === '1.3.2').followedByGap, true);
  assert.equal(index.entries.find(e => e.label === '1.3.4').precededByGap, true);
  assert.deepEqual(index.withoutSetIds.entries.map(e => e.label), ['1.1', '1.2', '1.3'], 'the sets whole are kept beside');
});

await check('an answer book\'s 习题 bookmarks are not split', async () => {
  const doc = scannedExercise();
  const index = await indexAnswerDocument(doc, { expectScript: 'han', recognizer });
  assert.deepEqual(index.entries.map(e => e.label), ['1.1', '1.2', '1.3']);
});

await check('a question bookmark (例题) is never split by numbers inside it', () => {
  const outline = { available: true, items: [{ title: '第一章', pageNumber: 1, children: [
    { title: '例题 1.1', pageNumber: 1, children: [] }, { title: '例题 1.2', pageNumber: 2, children: [] },
  ] }] };
  const built = buildOutlineIndex(outline, [
    { page: 1, text: '1. 先证明', top: 100 }, { page: 1, text: '2. 再证明', top: 140 }, { page: 2, text: 'x', top: 100 },
  ], { numPages: 3, quality: 'USABLE', expandSets: true });
  assert.deepEqual(built.entries.map(e => e.label), ['1.1', '1.2']);
});

group('3. A section-only answer book indexes its numbered answers');

const answerLines = [
  ['第一章 行列式', 1],
  ['1.1 二阶行列式', 1], ['1. (1) − 2 . (2) 1 .', 1], ['2. 解：由定义 |1 2 3 4| 因此 答案：12', 1], ['3. 1; − 3 , 4 .', 1],
  ['1.2 三阶行列式', 1], ['1. 解：|a b c d| 因此 答案：0', 1], ['2. 证明：由展开得证', 1], ['3. 答案：5', 2], ['4. 答案：7', 2],
  ['1.3 n 阶行列式', 2], ['1. 答案：1', 2], ['2. 答案：2', 2], ['3. 答案：3', 2], ['4. 答案：4', 2], ['5. 答案：5', 2],
].map(([text, page], i) => ({ page, text, top: 50 + 15 * i }));
const answerOutline = {
  available: true,
  items: [{ title: '第一章 行列式', pageNumber: 1, children: [
    { title: '1.1 二阶行列式', pageNumber: 1, children: [] },
    { title: '1.2 三阶行列式', pageNumber: 1, children: [] },
    { title: '1.3 n 阶行列式', pageNumber: 2, children: [] },
  ] }],
};

await check('answers are indexed section.number, each with its own text', () => {
  const built = buildSectionIndex(answerOutline, answerLines, { numPages: 2 });
  assert.equal(built.source, 'SECTIONS');
  assert.deepEqual(built.entries.map(e => e.label),
    ['1.1.1', '1.1.2', '1.1.3', '1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.3.1', '1.3.2', '1.3.3', '1.3.4', '1.3.5']);
  const a = built.entries.find(e => e.label === '1.2.2');
  assert.equal(a.section, '1.2 三阶行列式');
  assert.match(a.text, /^2\. 证明/);
  assert.equal(built.duplicates.length, 0);
});

await check('fewer than three sections with a run is not an index', () => {
  const two = answerLines.filter(l => l.page === 1);
  const built = buildSectionIndex({ ...answerOutline, items: [{ ...answerOutline.items[0], children: answerOutline.items[0].children.slice(0, 2) }] }, two, { numPages: 1 });
  assert.equal(built.entries.length, 0);
});

group('4. Through the engine: set.number resolves where the sections align');

// An answer book that works its answers, enough of them for the role to be
// judged, and restates each exercise's formula.
const SECTIONS = [['1.1 二阶行列式', 1, 3], ['1.2 三阶行列式', 2, 4], ['1.3 n 阶行列式', 3, 5]];
const answerBook = ({ sections = SECTIONS, setBookmarks = false } = {}) => {
  const ls = [{ page: 1, text: '第一章 行列式' }];
  for (const [title, page, n] of sections) {
    ls.push({ page, text: title });
    if (setBookmarks) ls.push({ page, text: `习题 ${title.split(' ')[0]}` });
    for (let k = 1; k <= n; k++) ls.push({ page, text: `${k}. 解：由 f ( x ) = x 2 及 x = a 2 计算，因此 答案：${k}` });
  }
  for (let page = 4; page <= 10; page++) {
    ls.push({ page, text: `${page - 2}.${page} 附录` });
    for (let k = 1; k <= 3; k++) ls.push({ page, text: `${k}. 解：由 f ( x ) = x 2 可得，所以 答案：${k}` });
  }
  const lines = ls.map((l, i) => ({ ...l, top: 40 + 12 * (i % 40) }));
  return {
    numPages: 10,
    outline: { available: true, items: [{ title: '第一章 行列式', pageNumber: 1, children: [
      ...sections.map(([title, page]) => ({
        title, pageNumber: page,
        children: setBookmarks ? [{ title: `习题 ${title.split(' ')[0]}`, pageNumber: page, children: [] }] : [],
      })),
      ...[4, 5, 6, 7, 8, 9, 10].map(p => ({ title: `${p - 2}.${p} 附录`, pageNumber: p, children: [] })),
    ] }] },
    async extractText({ from, to } = {}) {
      return lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
    },
  };
};

const tap = async (session, page, top) => (await session.matchQuestion({ page, region: { top: top + 2, bottom: top + 6 } }))[0];
const bindingFor = async (ex, an) => createBinding(
  fingerprintDocument({ numPages: ex.numPages, outline: ex.outline, lines: await ex.extractText({}) }),
  fingerprintDocument({ numPages: an.numPages, outline: an.outline, lines: await an.extractText({}) }),
);
const prepare = async ({ answer = answerBook(), bound = false, formulaPolicy = FORMULA_POLICY.CALIBRATED } = {}) => {
  const exerciseDocument = scannedExercise();
  return preparePair({
    exerciseDocument, answerDocument: answer, recognizer, formulaPolicy,
    binding: bound ? await bindingFor(exerciseDocument, answer) : null,
  });
};

await check('an unconfirmed pair offers the exercise\'s own answer, and does not assert it', async () => {
  const prepared = await prepare();
  assert.equal(prepared.status, PAIR_STATUS.UNKNOWN_PAIR, 'a scan read for formulas cannot confirm the pair');
  const m = await tap(prepared.session, 3, 228);
  assert.equal(m.question.label, '1.1.2');
  assert.equal(m.entry?.label, '1.1.2');
  assert.equal(m.rung, RUNG.REVIEW);
});

await check('a confirmed pair answers a cleanly numbered exercise automatically', async () => {
  const prepared = await prepare({ bound: true });
  assert.equal(prepared.status, PAIR_STATUS.VERIFIED_PAIR);
  for (const [page, top, label] of [[3, 228, '1.1.2'], [5, 260, '1.2.3'], [7, 340, '1.3.5']]) {
    const m = await tap(prepared.session, page, top);
    assert.equal(m.question.label, label);
    assert.equal(m.entry?.label, label);
    assert.equal(m.rung, RUNG.AUTO_MATCH, `${label}: ${m.cappedBy ?? m.reason}`);
  }
});

await check('the strict policy never answers by a number the answer cannot corroborate', async () => {
  const prepared = await prepare({ bound: true, formulaPolicy: FORMULA_POLICY.STRICT });
  const m = await tap(prepared.session, 3, 228);
  assert.equal(m.entry?.label, '1.1.2');
  assert.ok([RUNG.AUTO_MATCH, RUNG.REVIEW].includes(m.rung));
});

await check('a binding settles an answer book that states results, never a conflicting one', async () => {
  // The 绿皮书's answer book states results ("1. (1) −2. (2) 1."), so nothing
  // in its language says it is an answer book: its role cannot be confirmed.
  const results = (year) => {
    const book = answerBook();
    return {
      ...book,
      async extractText(range) {
        return (await book.extractText(range)).map(l => ({
          ...l, text: l.text.replace(/解：.*$/u, '( 1 ) − 2 . ( 2 ) 1 .') + (year && l.page === 1 ? ` ${year}` : ''),
        }));
      },
    };
  };
  const unbound = await prepare({ answer: results() });
  assert.equal(unbound.decision.answerRole, 'UNKNOWN');
  assert.equal(unbound.status, PAIR_STATUS.UNKNOWN_PAIR);
  const bound = await prepare({ answer: results(), bound: true });
  assert.equal(bound.status, PAIR_STATUS.VERIFIED_PAIR);
  assert.ok(bound.decision.reasonCodes.includes('PAIR_BOUND_MANUALLY'));
  assert.equal((await tap(bound.session, 3, 228)).rung, RUNG.AUTO_MATCH);
  // A year printed on one side and not the other is no conflict; two
  // different years are, and no binding settles them.
  const exercise = scannedExercise();
  const dated = { ...exercise, async extractText() { return [{ page: 1, text: '微信公众号 2023' }]; } };
  const other = results('2025');
  const conflicted = await preparePair({
    exerciseDocument: dated, answerDocument: other, recognizer, formulaPolicy: FORMULA_POLICY.CALIBRATED,
    binding: await bindingFor(dated, other),
  });
  assert.notEqual(conflicted.status, PAIR_STATUS.VERIFIED_PAIR);
  // Without set-scoped exercises the same answer book is a body parse, which
  // cannot show its role either; a binding does not settle that.
  const plain = { ...scannedExercise(), outline: exerciseOutline(false) };
  const body = results();
  const unsettled = await preparePair({
    exerciseDocument: plain, answerDocument: body, recognizer, formulaPolicy: FORMULA_POLICY.CALIBRATED,
    binding: await bindingFor(plain, body),
  });
  assert.equal(unsettled.session.answerIndex.setIdsWithdrawn, true);
  assert.equal(unsettled.status, PAIR_STATUS.UNKNOWN_PAIR);
});

await check('a skipped number caps the items on both sides of it', async () => {
  const prepared = await prepare({ bound: true });
  for (const [top, label] of [[190, '1.3.2'], [300, '1.3.4']]) {
    const m = await tap(prepared.session, 7, top);
    assert.equal(m.question.label, label);
    assert.equal(m.rung, RUNG.REVIEW);
    assert.equal(m.cappedBy, 'SET_NUMBER_SKIPPED');
  }
});

await check('an exercise number off its set\'s margin is never answered automatically', async () => {
  const shifted = async (page) => (await recognizer(page))
    .map(item => ({ ...item, left: page === 5 && item.top === 260 ? 160 : 110 }));
  const exerciseDocument = scannedExercise();
  const answer = answerBook();
  const prepared = await preparePair({
    exerciseDocument, answerDocument: answer, recognizer: shifted, formulaPolicy: FORMULA_POLICY.CALIBRATED,
    binding: await bindingFor(exerciseDocument, answer),
  });
  const m = await tap(prepared.session, 5, 260);
  assert.equal(m.question.label, '1.2.3');
  assert.equal(m.rung, RUNG.REVIEW);
  assert.equal(m.cappedBy, 'SET_NUMBER_MISALIGNED');
  assert.equal((await tap(prepared.session, 5, 200)).rung, RUNG.AUTO_MATCH, 'its neighbours stay on the margin');
});

await check('a set that counts differently from its answer section is never answered automatically', async () => {
  const sections = SECTIONS.map(([t, p, n]) => [t, p, t.startsWith('1.2') ? 5 : n]);
  const prepared = await prepare({ answer: answerBook({ sections }), bound: true });
  const m = await tap(prepared.session, 5, 260);
  assert.equal(m.entry?.label, '1.2.3');
  assert.equal(m.rung, RUNG.REVIEW);
  assert.equal(m.cappedBy, 'SET_SIZE_DISAGREES');
  assert.equal((await tap(prepared.session, 3, 228)).rung, RUNG.AUTO_MATCH, 'the other sets are unaffected');
});

await check('a set whose section the alignment does not pair resolves nothing automatically', async () => {
  // 1.1 is about something else in this answer book; the numbering still
  // agrees, and that is not enough.
  const sections = SECTIONS.map(([t, p, n]) => [t.startsWith('1.1') ? '1.1 排列与逆序数' : t, p, n]);
  const prepared = await prepare({ answer: answerBook({ sections }), bound: true });
  const m = await tap(prepared.session, 3, 228);
  assert.equal(m.question.label, '1.1.2');
  assert.notEqual(m.rung, RUNG.AUTO_MATCH);
  assert.equal((await tap(prepared.session, 5, 260)).rung, RUNG.AUTO_MATCH, 'the aligned sets are unaffected');
});

await check('against an answer book that bookmarks its sets, the sets are matched whole, as before', async () => {
  const prepared = await prepare({ answer: answerBook({ setBookmarks: true }), bound: true });
  assert.equal(prepared.session.exerciseIndex.setIdsWithdrawn, true);
  const m = await tap(prepared.session, 3, 228);
  assert.equal(m.question.label, '1.1');
  assert.equal(m.entry?.label, '1.1');
});

await check('against an exercise book without sets, a section-numbered answer book is parsed as before', async () => {
  const exerciseDocument = { ...scannedExercise(), outline: exerciseOutline(false) };
  const answer = answerBook();
  const prepared = await preparePair({ exerciseDocument, answerDocument: answer, recognizer });
  const index = prepared.session?.answerIndex;
  assert.ok(index, 'a session');
  assert.ok(!index.entries.some(e => e.setId), 'no set-scoped answers without set-scoped exercises');
  assert.equal(index.setIdsWithdrawn, true);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(FAIL ? 1 : 0);
