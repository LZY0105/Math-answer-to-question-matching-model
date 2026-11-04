#!/usr/bin/env node
// LaTeX from a formula recogniser, in the form the matcher reads.
//
// The target is what the demo adapter yields from a text layer for the same
// printed formula; every expectation here is one the 2024 books were measured
// to produce. See src/formula-latex.js.

import assert from 'node:assert/strict';

import { latexToText, looksLikeLatex } from '../src/formula-latex.js';
import { extractFormulaSet, compareFormulaSets } from '../src/formula-set.js';
import { contentSimilarity, normalizeForMatch } from '../src/question-matcher.js';

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const group = (n) => console.log(`\n─── [${n}] ───`);
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  LaTeX to matcher text');
console.log('═══════════════════════════════════════════════════════════════');

group('1. Scripts read inline, as the text layer prints them');

check('an exponent follows its base with no caret', () => {
  assert.equal(latexToText('x^{3}+3x+1'), 'x3+3x+1');
  assert.equal(latexToText('x^3+3x+1'), 'x3+3x+1');
});

check('a subscript follows its base', () => {
  assert.equal(latexToText('a_{n+1}'), 'an+1');
  assert.equal(latexToText('\\sum_{k=1}^{n} a_{k}'), '∑k=1nak');
});

check('the caret form is available for comparing two recognitions', () => {
  assert.equal(latexToText('x^{2}+3x', { scripts: 'caret' }), 'x^2+3x');
});

group('2. Structure that the text layer also has');

check('fractions become a slash, bracketed where the bar bound more than one token', () => {
  assert.equal(latexToText('\\frac{1}{x+1}'), '1/(x+1)');
  assert.equal(latexToText('\\frac{x+1}{2}'), '(x+1)/2');
  assert.equal(latexToText('\\frac12'), '1/2');
  assert.equal(latexToText('\\frac{x+1}{2}', { fractions: 'stack' }), 'x+1 2');
});

check('1/(x+1) and 1/x+1 stay different', () => {
  assert.notEqual(latexToText('\\frac{1}{x+1}'), latexToText('\\frac{1}{x}+1'));
});

check('roots, limits, integrals and matrices keep their visible symbols in order', () => {
  assert.equal(latexToText('\\sqrt{x^{2}+1}'), '√x2+1');
  assert.equal(latexToText('\\sqrt[3]{x}'), '3√x');
  assert.equal(latexToText('\\lim_{x \\to 0} \\frac{\\sin x}{x}'), 'limx→0(sinx)/x');
  assert.equal(latexToText('\\int_{0}^{1} e^{t^{2}} \\, dt'), '∫01et2dt');
  assert.equal(latexToText('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}'), '(1 2 3 4)');
});

check('brackets keep their kind; sized and invisible delimiters do not', () => {
  assert.equal(latexToText('\\left( a+b \\right)'), '(a+b)');
  assert.equal(latexToText('\\left[ a+b \\right]'), '[a+b]');
  assert.equal(latexToText('\\left| x \\right.'), '|x');
  assert.equal(latexToText('\\bigl( x \\bigr)'), '(x)');
});

group('3. What draws nothing is dropped; what is printed is kept');

check('font wrappers, spacing and plain grouping braces are not content', () => {
  assert.equal(latexToText('\\mathrm{Aut}(G)'), 'Aut(G)');
  assert.equal(latexToText('{Z}'), 'Z');
  assert.equal(latexToText('f(x)\\,dx'), 'f(x)dx');
  assert.equal(latexToText('\\alpha \\! > \\! -1'), 'α>-1');
});

check('commands become the symbol or the word the page shows', () => {
  assert.equal(latexToText('\\alpha \\leq \\beta'), 'α≤β');
  assert.equal(latexToText('\\cdots'), '···');
  assert.equal(latexToText('\\operatorname{det} A'), 'detA');
  assert.equal(latexToText("f'(x)"), 'f′(x)');
  assert.equal(latexToText('f^{\\prime}(x)'), 'f′(x)');
});

check('an accent prints its letter', () => {
  assert.equal(latexToText('\\hat{x}+\\bar{y}'), 'x+y');
  assert.equal(latexToText('\\overline{z}'), 'z');
});

check('a negated relation reads as one symbol, however it was written', () => {
  // The adapter reads TeX's slash-over-relation off a text layer as the same
  // code point, so a recogniser's \not= and a key's printed ≠ agree.
  assert.equal(latexToText('x \\not= 0'), 'x≠0');
  assert.equal(latexToText('x \\neq 0'), 'x≠0');
  assert.equal(latexToText('a \\not\\equiv b'), 'a≢b');
  assert.equal(latexToText('x \\not\\in A'), 'x∉A');
  assert.equal(latexToText('x \\notin A'), 'x∉A');
  assert.equal(latexToText('a \\nleq b'), 'a≰b');
  assert.equal(latexToText('a \\not\\perp b'), 'a⊥̸b', 'with no single code point, the slash overlays');
});

check('unbalanced input is closed, not rejected', () => {
  assert.equal(latexToText('\\frac{1}{x'), '1/x');
  assert.equal(latexToText('x^{'), 'x');
  assert.equal(latexToText(''), '');
});

group('4. The result scores like the text layer it imitates');

check('a recognised formula agrees with its own text-layer reading under the formula gate', () => {
  // The text layer of the 2024 algebra book, question 2.3 (2), as the adapter
  // now reads it, against the LaTeX a recogniser would produce for it.
  const layer = 'f ( x ) = 2 x 3 − 5 x 2 + 4 x − 1';
  const ocr = latexToText('f(x)=2x^{3}-5x^{2}+4x-1');
  const cmp = compareFormulaSets(extractFormulaSet(ocr), extractFormulaSet(layer));
  assert.equal(cmp.conflicts.length, 0, JSON.stringify(cmp));
  assert.equal(cmp.coverage, 1);
});

check('a different polynomial with the same shape reads as a conflict, not as agreement', () => {
  // The gate matches expressions fuzzily (0.8), so a single changed digit is
  // still the same expression; a different polynomial of the same shape is not.
  const layer = 'f ( x ) = 2 x 3 − 5 x 2 + 4 x − 1';
  const other = latexToText('g(y)=7y^{3}-9y^{2}+8y-6');
  const cmp = compareFormulaSets(extractFormulaSet(other), extractFormulaSet(layer));
  assert.ok(cmp.conflicts.length > 0, JSON.stringify(cmp));
});

check('the right text-layer reading outscores a near miss', () => {
  const ocr = latexToText('\\lim_{x \\to 0} \\frac{\\ln(1+x)-x}{x^{2}}');
  const own = 'lim ln (1 + x ) − x x → 0 x 2';
  const wrong = 'lim sin x − arctan x x → 0 tan x − x';
  assert.ok(contentSimilarity(ocr, own) > contentSimilarity(ocr, wrong));
});

check('looksLikeLatex tells markup from printed text', () => {
  assert.ok(looksLikeLatex('\\frac{1}{2}'));
  assert.ok(looksLikeLatex('x^{2}'));
  assert.equal(looksLikeLatex('x 2 + 1'), false);
  assert.equal(normalizeForMatch(latexToText('x^{2}')), 'x2');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(FAIL > 0 ? 1 : 0);
