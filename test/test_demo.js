#!/usr/bin/env node

import assert from 'node:assert/strict';

import { createDemoServer } from '../demo/server.mjs';
import { groupTextItems, openPdfDocument } from '../demo/pdfjs-document-adapter.mjs';
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
