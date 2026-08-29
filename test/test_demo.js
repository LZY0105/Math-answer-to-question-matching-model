#!/usr/bin/env node

import assert from 'node:assert/strict';

import { createDemoServer } from '../demo/server.mjs';
import { openPdfDocument } from '../demo/pdfjs-document-adapter.mjs';
import { SCENARIOS, runScenario } from '../demo/scenarios.mjs';


let PASS = 0;
let FAIL = 0;
const pass = label => { PASS++; console.log(`  ✅ ${label}`); };
const fail = (label, detail) => { FAIL++; console.log(`  ❌ ${label}: ${detail}`); };

async function check(label, fn) {
  try { await fn(); pass(label); } catch (error) { fail(label, error.message); }
}


console.log('\n─── [public synthetic PDF demo] ───');

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
