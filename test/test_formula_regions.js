#!/usr/bin/env node
// Which runs of a text row are formulas.

import assert from 'node:assert/strict';

import { formulaRuns } from '../tools/formula-regions.mjs';

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Formula regions from a text row');
console.log('═══════════════════════════════════════════════════════════════');

const item = (text, x, width = 6, y = 100, height = 10.5) => ({ text, x, y, width, height });
const row = (items) => ({ y: 100, height: 10.5, items });

check('a run of maths between prose is one region with the layer text', () => {
  const regions = formulaRuns(row([
    item('设', 60, 10), item('f', 72), item('(', 78, 4), item('x', 82), item(') =', 88, 14), item('x', 104), item('3', 110, 4), item('+', 116, 8), item('1', 126, 4), item('，满足', 132, 30),
  ]), 800);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].text, 'f ( x ) = x 3 + 1');
  assert.ok(regions[0].bbox[0] < 72 && regions[0].bbox[2] > 130);
});

check('a label and a year are not formulas', () => {
  const regions = formulaRuns(row([item('例题', 60, 20), item('1.1', 82, 14), item('(2023.', 100, 30), item('中国科学院大学', 132, 70)]), 800);
  assert.equal(regions.length, 0);
});

check('two formulas far apart on one row are two regions', () => {
  const regions = formulaRuns(row([item('f', 60), item('(x)', 66, 14), item('g', 300), item('(y)', 306, 14)]), 800);
  assert.equal(regions.length, 2);
});

check('running heads and footers are outside the page body', () => {
  const head = { y: 20, height: 8, items: [item('x', 60, 6, 20, 8), item('+ 1', 66, 12, 20, 8)] };
  assert.equal(formulaRuns(head, 800).length, 0);
});

console.log(`\n  ${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL > 0 ? 1 : 0);
