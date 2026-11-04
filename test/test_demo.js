#!/usr/bin/env node

import assert from 'node:assert/strict';

import { createDemoServer } from '../demo/server.mjs';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { groupTextItems, openPdfDocument, paintedGlyphs, paintedItems } from '../demo/pdfjs-document-adapter.mjs';
import { SCENARIOS, runScenario } from '../demo/scenarios.mjs';


let PASS = 0;
let FAIL = 0;
const pass = label => { PASS++; console.log(`  ✅ ${label}`); };
const fail = (label, detail) => { FAIL++; console.log(`  ❌ ${label}: ${detail}`); };

async function check(label, fn) {
  try { await fn(); pass(label); } catch (error) { fail(label, error.message); }
}


console.log('\n─── [public synthetic PDF demo] ───');

await check('superscripts and subscripts join the line they belong to', () => {
  // Positions and widths measured on the 2024 algebra exercise book: body text
  // at 10.5 pt, its superscripts 4.4 pt above the baseline and its subscripts
  // 1.6 pt below, both at 7 pt, each starting where its base ends. The limits
  // of a display ∏ sit 12–13 pt away and OVER the sign, not after it. Before
  // this the 2.5 pt row tolerance kept the subscripts and lost every
  // superscript into a row of its own, and the strict formula rule then read
  // x^n-1 as x.
  const item = (str, x, y, size, width) => ({ str, transform: [size, 0, 0, size, x, 100 - y], height: size, width });
  const viewport = { height: 100 };
  const lines = groupTextItems([
    item('x', 126.2, 12.7, 10.5, 6), item('n', 132.2, 8.3, 7, 4.9), item('−', 137.1, 8.3, 7, 6.2), item('1', 143.3, 8.3, 7, 4.5),
    item('+', 150.1, 12.7, 10.5, 8), item('f', 247.2, 12.7, 10.5, 5.1), item('1', 252.3, 14.3, 7, 4.5), item('(', 256.8, 12.7, 10.5, 4),
    item('∏', 215.1, 32.9, 10.5, 8.4), item('n', 219.3, 29.7, 7, 4.9), item('i', 215.4, 55, 7, 2.8), item('=1', 218.2, 55, 7, 9),
    item('(', 228.5, 42.9, 10.5, 4), item('x', 245.1, 42.9, 10.5, 6), item('1)', 195.7, 42.9, 10.5, 9.4), item('n', 205, 38.5, 7, 4.9),
  ], 1, viewport, false).map(l => l.text);
  assert.equal(lines[0], 'x n − 1 + f 1 (', 'an exponent and a subscript follow their base onto its line');
  assert.ok(lines.includes('1) n ( x'), 'a lone superscript joins the line of the item it follows');
  assert.ok(lines.includes('∏'), 'a limit over a display operator is not a script of it');
  assert.ok(lines.includes('i =1'), 'display limits twelve points away stay separate');
});

await check('a negation slash reads as part of the relation it is drawn over', () => {
  // Positions as pdf.js reports them on page 22 of the 2023 key: Computer
  // Modern's zero-width slash, mapped to "6", over the "=" of "= 0".
  const item = (str, x, y, size, width) => ({ str, transform: [size, 0, 0, size, x, 200 - y], height: size, width });
  const lines = groupTextItems([
    item('x', 346.18, 139.65, 12, 6.67), item('6', 356.2, 139.65, 12, 0), item('= 0', 356.2, 139.65, 12, 18.32),
    item('a', 100, 160, 12, 6), item('7', 108, 160, 12, 0), item('→', 108, 160, 12, 12), item('b', 122, 160, 12, 6),
    item('n', 100, 180, 12, 6), item('=', 108, 180, 12, 9), item('6', 119, 180, 12, 6), item('+', 127, 180, 12, 9),
  ], 1, { height: 200 }, false).map(l => l.text);
  assert.deepEqual(lines, ['x ≠ 0', 'a ↦ b', 'n = 6 +'], 'a printed 6 has an advance and stays a digit');
});

await check('a radical sign joins its radicand, and an n-th root reads n√x', () => {
  // Page 4 of the 2023 exercise book, \sqrt[n]{64}: the sign hangs from its
  // top, 9.9 points above the radicand's baseline; the index sits in its crook.
  const item = (str, x, y, size, width) => ({ str, transform: [size, 0, 0, size, x, 400 - y], height: size, width });
  const lines = groupTextItems([
    item('2 +', 280, 330.11, 12, 15), item('n', 301.99, 324.53, 5.98, 4.6), item('√', 299.92, 320.18, 12, 10),
    item('64', 309.92, 330.11, 12, 11.74),
    item('x', 100, 360, 12, 6.7), item('2', 106.7, 355, 8, 4.2), item('√', 111.5, 352, 12, 10), item('y', 121.5, 362, 12, 6),
  ], 1, { height: 400 }, false).map(l => l.text);
  assert.deepEqual(lines, ['2 + n √ 64', 'x 2 √ y'], 'a script of the item before the sign stays its script');
});

await check('a display fraction reads as one item over its bar, not as three lines', () => {
  // Page 4 of the 2023 exercise book, a_n = 1 + 1/2 + ... : the numerator and
  // denominator 8 points above and below the main baseline, the bar on the
  // axis 3 points above it. A radical's vinculum, which starts where its sign
  // ends, is not a bar.
  const item = (str, x, y, size, width) => ({ str, transform: [size, 0, 0, size, x, 500 - y], height: size, width });
  const items = [
    item('a', 226.62, 393.99, 12, 6.17), item('n', 232.78, 395.79, 7.97, 5.13), item('= 1 + ', 241.75, 393.99, 12, 34.02),
    item('1', 275.77, 385.87, 12, 5.87), item('2 ', 275.77, 402.22, 12, 9.74), item('+', 285.5, 393.99, 12, 9.13),
    item('√', 299.92, 432, 12, 10), item('64', 309.92, 441.9, 12, 11.74),
  ];
  const rules = [{ x0: 275.77, x1: 281.64, y: 390.99, thickness: 0.48 }, { x0: 309.92, x1: 321.66, y: 432.3, thickness: 0.48 }];
  const lines = groupTextItems(items, 1, { height: 500 }, false, rules).map(l => l.text.replace(/\s+/g, ' '));
  assert.deepEqual(lines, ['a n = 1 + 1 / 2 +', '√ 64']);
  const plain = groupTextItems(items, 1, { height: 500 }, false).map(l => l.text);
  assert.ok(plain.length > lines.length, 'without the bar the parts stay on lines of their own');
});

await check("a limit's subscript reads after the operator, scripts and all", () => {
  // Page 9 of the 2023 exercise book: lim with x → 0⁺ set under it, the +
  // a script of the 0.
  const item = (str, x, y, size, width) => ({ str, transform: [size, 0, 0, size, x, 700 - y], height: size, width });
  const lines = groupTextItems([
    item('lim', 227.03, 599.33, 12, 16.32), item('x', 223.42, 607.42, 7.97, 4.77), item('→', 228.18, 607.42, 7.97, 8.46),
    item('0', 236.65, 607.42, 7.97, 4.23), item('+', 240.89, 605.15, 5.98, 5.59), item('f', 250, 599.33, 12, 5),
  ], 1, { height: 700 }, false).map(l => l.text);
  assert.deepEqual(lines, ['lim x → 0 + f']);
});

// The shape of a 2024 留白 page: one embedded page drawn twice, each copy
// clipped to a different question's window (as PyMuPDF writes it, the window
// clip in the page and the form's own /BBox), with two questions on the
// embedded page starting at the same left margin.
function clippedPage() {
  const glyph = (unicode, width = 500) => ({ unicode, width, isSpace: unicode === ' ' });
  const ops = []; const args = [];
  const op = (fn, a = null) => { ops.push(fn); args.push(a); };
  const embedded = () => {
    op(OPS.beginText); op(OPS.setFont, ['f1', 10]);
    op(OPS.setTextMatrix, [1, 0, 0, 1, 36, 700]); op(OPS.showText, [[glyph('A'), glyph('1')]]);
    op(OPS.setTextMatrix, [1, 0, 0, 1, 36, 500]); op(OPS.showText, [[glyph('A'), glyph('2')]]);
    op(OPS.endText);
  };
  // Window 1 shows the question at 700. Window 2 draws the same page 100
  // points lower and shows the question at 500, which lands at 400.
  for (const [dy, bbox] of [[0, [36, 690, 480, 715]], [-100, [36, 490, 480, 515]]]) {
    op(OPS.save); op(OPS.transform, [1, 0, 0, 1, 0, dy]);
    op(OPS.constructPath, [[OPS.rectangle], [36, bbox[1], 444, 25], [36, bbox[1], 480, bbox[3]]]); op(OPS.clip); op(OPS.endPath);
    op(OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 0, 0], bbox]); embedded(); op(OPS.paintFormXObjectEnd);
    op(OPS.restore);
  }
  return { fnArray: ops, argsArray: args };
}

await check('a glyph a clip hides is marked unpainted, through nested forms', () => {
  const glyphs = paintedGlyphs(clippedPage(), OPS);
  const painted = glyphs.filter(g => g.painted).map(g => `${g.text}@${g.y}`);
  assert.deepEqual(painted, ['A@700', '1@700', 'A@400', '2@400']);
  assert.equal(glyphs.length, 8, 'every glyph is reported, painted or not');
  assert.equal(paintedGlyphs({ fnArray: [OPS.beginText, OPS.endText], argsArray: [null, null] }, OPS), null,
    'a page that clips nothing needs no alignment');
});

await check('text items are kept only where the page paints them', () => {
  const item = (str, x, y) => ({ str, transform: [10, 0, 0, 10, x, y], width: 10, height: 10 });
  const items = [
    item('A1', 36, 700), item('A2', 36, 500),            // copy 1: question 1 shown, 2 hidden
    item('A1', 36, 600), item('A2', 36, 400),            // copy 2: question 1 hidden, 2 shown
    item('A1', 36, 700),                                 // the same text painted twice at one place
    item('B9', 300, 300),                                // nothing accounts for it: kept
  ];
  const kept = paintedItems(items, paintedGlyphs(clippedPage(), OPS)).map(i => `${i.str}@${i.transform[5]}`);
  assert.deepEqual(kept, ['A1@700', 'A2@400', 'B9@300']);
});

await check('two texts that start at one point are told apart by what they spell', () => {
  // Page 71 of the 2024 analysis book: 例题 1.106 painted, 例题 1.111 hidden
  // under it at the same left margin, a fraction of a point away.
  const run = (text, y, painted) => [...text].map((ch, k) => ({ text: ch, x: 63.21 + 5 * k, y, painted }));
  const glyphs = [...run('1.111.', 380.22, false), ...run('1.106.', 380.63, true)];
  const item = (str, y) => ({ str, transform: [10, 0, 0, 10, 63.21, y] });
  const kept = paintedItems([item('1.111.', 380.22), item('1.106.', 380.63)], glyphs).map(i => i.str);
  assert.deepEqual(kept, ['1.106.']);
});

await check('a small-print line with no larger neighbour is left as its own line', () => {
  const item = (str, x, y, size, width = 5) => ({ str, transform: [size, 0, 0, size, x, 100 - y], height: size, width });
  const lines = groupTextItems([
    item('正文', 60, 20, 10.5, 20), item('脚注', 60, 60, 7, 20), item('第 3 页', 300, 90, 7, 20),
  ], 1, { height: 100 }, false).map(l => l.text);
  assert.deepEqual(lines, ['正文', '脚注', '第 3 页']);
});

await check('PDF.js adapter exposes all 24 question bookmarks', async () => {
  const document = await openPdfDocument(SCENARIOS.correct.exercise);
  try {
    assert.equal(document.numPages, 25);
    assert.equal(document.outline.available, true);
    assert.equal(document.outline.items.length, 1);
    assert.equal(document.outline.items[0].children.length, 24);
  } finally {
    await document.destroy();
  }
});

await check('PDF.js adapter extracts readable text and geometry', async () => {
  const document = await openPdfDocument(SCENARIOS.correct.exercise);
  try {
    const lines = await document.extractText({ from: 2, to: 2 });
    assert.ok(lines.some(line => line.text.includes('f(x)=x^2+1x')));
    assert.ok(lines.some(line => Number.isFinite(line.y) && line.height > 0));
  } finally {
    await document.destroy();
  }
});

await check('correct PDF pair resolves exactly 24 unique automatic matches', async () => {
  const result = await runScenario('correct');
  assert.equal(result.pairStatus, 'VERIFIED_PAIR');
  assert.deepEqual(result.summary.rungs, { AUTO_MATCH: 24 });
  assert.equal(new Set(result.matches.map(match => match.question.label)).size, 24);
  assert.ok(result.matches.every(match => match.question.label === match.answer.label));
});

await check('wrong-year answer PDF is blocked before matching', async () => {
  const result = await runScenario('wrong');
  assert.equal(result.pairStatus, 'REJECTED_PAIR');
  assert.equal(result.summary.total, 0);
  assert.ok(result.decision.reasonCodes.includes('PAIR_IDENTITY_MISMATCH'));
});

await check('unsupported click region caps an automatic match at REVIEW', async () => {
  const result = await runScenario('insufficient');
  assert.deepEqual(result.summary.rungs, { REVIEW: 1 });
  assert.equal(result.matches[0].matched, false);
  assert.equal(result.matches[0].regionApplied, false);
  assert.equal(result.matches[0].cappedBy, 'REGION_UNSUPPORTED_BY_ADAPTER');
});

await check('HTTP adapter lists all three public scenarios', async () => {
  const server = createDemoServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/scenarios`);
    assert.equal(response.status, 200);
    const scenarios = await response.json();
    assert.deepEqual(scenarios.map(item => item.id), ['correct', 'wrong', 'insufficient']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

await check('HTTP adapter returns the engine decision rather than a mock', async () => {
  const server = createDemoServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/run?scenario=wrong`);
    const result = await response.json();
    assert.equal(result.pairStatus, 'REJECTED_PAIR');
    assert.ok(result.decision.reasonCodes.includes('PAIR_IDENTITY_MISMATCH'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

await check('web workbench is served with all three safety paths', async () => {
  const server = createDemoServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Evidence before answers/);
    assert.match(html, /data-scenario="correct"/);
    assert.match(html, /data-scenario="wrong"/);
    assert.match(html, /data-scenario="insufficient"/);
    assert.match(html, /id="decision-workbench"/);
    assert.match(html, /id="exercise-pdf"/);
    assert.match(html, /id="answer-pdf"/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

console.log(`\n${PASS} passed, ${FAIL} failed`);
if (FAIL) process.exitCode = 1;
