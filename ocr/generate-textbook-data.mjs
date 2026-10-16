// Find-Engine v3: textbook-shaped formula grammar and labels, authored here.
//
// This generator exists because the v2 corpus is shaped wrong for deployment.
// Measured on 600 real crops from the five 考研 source books, a real formula is
// wide and shallow: aspect ratio median 7.36 (p90 20.67), ink height median
// 33 px, stroke median 2.24 px. The v2 grammar recurses deeply, so it produces
// tall square towers (aspect ratio around 2.8). Matching the deployment shape
// is a grammar change first and a rendering change second: build horizontal
// relation chains out of shallow factors, and keep tall structures rare.
//
// MathJax and sharp are rendering tools. No recognizer, pretrained vision model
// or teacher model participates; every label is correct by construction because
// the label is the source the renderer was given.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { createStrictFormulaRenderer } from './strict-mathjax.mjs';

const DEFAULTS = {
  output: 'tmp/formula-textbook-v1',
  train: 40000,
  validation: 2000,
  test: 2000,
  seed: 20260927,
  'ex-px': 12,
  'max-tokens': 150,
  cover: 400,
};

const options = { ...DEFAULTS };
for (let i = 2; i < process.argv.length; i += 1) {
  const argument = process.argv[i];
  if (!argument.startsWith('--')) throw new Error(`Unexpected argument ${argument}`);
  const [name, inline] = argument.slice(2).split('=');
  if (!(name in DEFAULTS)) throw new Error(`Unknown option --${name}`);
  const value = inline ?? process.argv[++i];
  if (value === undefined) throw new Error(`Option --${name} needs a value`);
  options[name] = typeof DEFAULTS[name] === 'number' ? Number(value) : value;
}
for (const key of ['train', 'validation', 'test', 'seed', 'ex-px', 'max-tokens', 'cover']) {
  if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`--${key} must be positive`);
}

const output = path.resolve(options.output);
const EX_PX = options['ex-px'];
const MAX_TOKENS = options['max-tokens'];
const COVER = options.cover;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
// Same lexer the training tokenizer uses, so token budgets agree.
const lex = latex => latex.match(/\\(?:begin|end)\{[a-zA-Z*]+\}|\\[A-Za-z]+|\\.|[^\s]/gu) ?? [];
const labelKey = latex => JSON.stringify(lex(latex));

// A TeX control word swallows the letters that follow it, so concatenating
// "\geq" with a term that starts with "q" silently yields "\geqq" -- a
// different symbol -- and "\to" before "x" yields "\tox", which the strict
// renderer rejects outright.
//
// This cannot be decided by a regex over the finished string: the letters that
// need separating are, by construction, indistinguishable from the tail of the
// control word, and a greedy match simply backtracks into the word instead
// ("\det(" becomes "\de t("). Resolve it against the set of commands this
// generator actually emits, taking the longest one that prefixes the run.
const COMMANDS = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'theta', 'lambda', 'mu', 'rho', 'sigma',
  'varphi', 'varepsilon', 'omega', 'psi', 'phi', 'infty',
  'sin', 'cos', 'tan', 'ln', 'log', 'exp',
  'leq', 'geq', 'neq', 'equiv', 'subseteq', 'subset', 'supset', 'in', 'to',
  'Rightarrow', 'Leftrightarrow', 'mid', 'cdot', 'cdots', 'quad',
  'frac', 'sqrt', 'int', 'sum', 'prod', 'lim', 'limsup', 'liminf',
  'bigcup', 'bigcap', 'cup', 'cap', 'setminus', 'oplus', 'langle', 'rangle',
  'partial', 'nabla', 'Delta', 'det', 'mathrm', 'mathbb', 'overline',
  'forall', 'exists', 'begin', 'end',
]);

const normalize = latex => latex.replace(/\\[A-Za-z]+/g, word => {
  const name = word.slice(1);
  for (let length = name.length; length > 0; length -= 1) {
    if (!COMMANDS.has(name.slice(0, length))) continue;
    const rest = name.slice(length);
    return rest ? `\\${name.slice(0, length)} ${rest}` : word;
  }
  return word;
});

function makeRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    pick: list => list[Math.floor(next() * list.length)],
    chance: probability => next() < probability,
    shuffle(list) {
      const copy = [...list];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
}

// ---------------------------------------------------------------- vocabulary

const LATIN = ['a', 'b', 'c', 'd', 'f', 'g', 'h', 'k', 'm', 'n', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'];
const MATRICES = ['A', 'B', 'C', 'D', 'P', 'Q', 'S', 'T', 'M', 'N'];
const GREEK = ['\\alpha', '\\beta', '\\gamma', '\\delta', '\\theta', '\\lambda', '\\mu', '\\rho', '\\sigma', '\\varphi', '\\omega', '\\varepsilon'];
const SETS = ['E', 'F', 'G', 'X', 'Y', 'A', 'B'];
const INDICES = ['i', 'j', 'k', 'n', 'm', 'r', 's'];
const RELATIONS = ['=', '=', '=', '\\leq', '\\geq', '\\neq', '<', '>', '\\equiv', '\\subseteq', '\\Rightarrow', '\\Leftrightarrow'];
const FUNCTIONS = ['\\sin', '\\cos', '\\tan', '\\ln', '\\log', '\\exp'];

const int = rng => String(rng.chance(0.8) ? rng.int(0, 12) : rng.int(13, 99));
const latin = rng => rng.pick(LATIN);
const greek = rng => rng.pick(GREEK);
const matrix = rng => rng.pick(MATRICES);
const idx = rng => rng.chance(0.75)
  ? rng.pick(INDICES)
  : `${rng.pick(INDICES)}${rng.pick(['+', '-'])}${rng.int(1, 5)}`;

const sub = (base, s) => `${base}_{${s}}`;
const sup = (base, s) => `${base}^{${s}}`;
const paren = body => `(${body})`;

// ------------------------------------------------------------------ factors
// A factor is one visually compact unit. Tall constructs live here and are
// drawn rarely, which is what keeps the corpus wide instead of square.

function atom(rng) {
  const roll = rng.next();
  if (roll < 0.34) return latin(rng);
  if (roll < 0.52) return int(rng);
  if (roll < 0.70) return greek(rng);
  return matrix(rng);
}

// Only a symbol takes a subscript. Textbooks write 2^{3} but never 29_{8}, and
// a corpus that contains subscripted integers teaches a pattern the deployment
// images never show.
function scripted(rng) {
  const base = atom(rng);
  const numeric = /^\d+$/.test(base);
  const roll = rng.next();
  if (!numeric && roll < 0.30) return sub(base, rng.chance(0.6) ? idx(rng) : int(rng));
  if (roll < 0.54) return sup(base, rng.chance(0.55) ? String(rng.int(2, 9)) : idx(rng));
  // Stacked sub+superscript is the single tallest thing a plain atom can grow,
  // so it stays rare: the real crops sit near 33 px of ink height.
  if (!numeric && roll < 0.59) return sup(sub(base, idx(rng)), String(rng.int(2, 6)));
  return base;
}

// Ink height is governed here, by budget rather than by probability. Every
// construct that stacks rows -- a fraction, a bounded integral, a big operator,
// a matrix -- costs one unit, and a formula is issued a small allowance. Tuning
// the probabilities alone cannot hold the height down, because two independent
// draws can still nest and multiply: a fraction inside a fraction is five ex
// tall and the source books almost never print one.
function tallBudget(rng) {
  const roll = rng.next();
  return { left: roll < 0.30 ? 0 : roll < 0.90 ? 1 : 2 };
}

const spend = budget => budget.left > 0 && (budget.left -= 1, true);

function flatFactor(rng, depth, budget) {
  const roll = rng.next();
  if (roll < 0.52) return scripted(rng);
  if (roll < 0.62) {
    const name = rng.pick(FUNCTIONS);
    return `${name}${paren(term(rng, depth + 1, budget, 2))}`;
  }
  if (roll < 0.70) return `\\sqrt{${term(rng, depth + 1, budget, 2)}}`;
  if (roll < 0.80) return paren(term(rng, depth + 1, budget, 2));
  if (roll < 0.86 && spend(budget)) {
    return `\\frac{${term(rng, depth + 1, budget, 2)}}{${term(rng, depth + 1, budget, 2)}}`;
  }
  if (roll < 0.92 && spend(budget)) {
    const bounds = rng.chance(0.7)
      ? `_{${rng.chance(0.5) ? '0' : latin(rng)}}^{${rng.chance(0.5) ? String(rng.int(1, 9)) : '\\infty'}}`
      : '';
    return `\\int${bounds}${term(rng, depth + 1, budget, 2)}d${rng.pick(['x', 't', 'y'])}`;
  }
  if (roll < 0.97 && spend(budget)) {
    const operator = rng.pick(['\\sum', '\\prod']);
    return `${operator}_{${rng.pick(INDICES)}=1}^{${idx(rng)}}${term(rng, depth + 1, budget, 2)}`;
  }
  if (roll >= 0.97 && spend(budget)) {
    return `\\lim_{${rng.pick(['n', 'x', 't'])}\\to${rng.pick(['0', '\\infty', '1'])}}${term(rng, depth + 1, budget, 2)}`;
  }
  return scripted(rng);
}

// Tall constructs. Kept behind a low probability and never nested inside
// another tall construct, because each one costs roughly a factor of three in
// height and the deployment distribution has very few of them.
function tallFactor(rng) {
  const roll = rng.next();
  if (roll < 0.45) {
    const environment = rng.pick(['pmatrix', 'bmatrix', 'vmatrix']);
    const rows = rng.int(2, 3);
    const columns = rng.int(2, 3);
    const body = Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => rng.chance(0.65) ? int(rng) : atom(rng)).join('&')).join('\\\\');
    return `\\begin{${environment}}${body}\\end{${environment}}`;
  }
  if (roll < 0.75) {
    const v = rng.pick(['x', 't', 'n']);
    const bound = rng.int(0, 4);
    const spent = { left: 0 };
    return `\\begin{cases}${term(rng, 3, spent, 2)}&${v}<${bound}\\\\${term(rng, 3, spent, 2)}&${v}\\geq${bound}\\end{cases}`;
  }
  return `\\frac{\\partial^{${rng.int(2, 3)}}${latin(rng)}}{\\partial ${rng.pick(['x', 'y', 't'])}^{${rng.int(2, 3)}}}`;
}

function factor(rng, depth, budget) {
  if (depth <= 1 && rng.chance(0.05) && spend(budget)) return tallFactor(rng);
  return flatFactor(rng, depth, budget);
}

// -------------------------------------------------------------------- terms

function term(rng, depth, budget, maxFactors = 5) {
  if (depth >= 3) return scripted(rng);
  const count = rng.int(1, Math.max(1, maxFactors - depth));
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    const piece = factor(rng, depth, budget);
    if (i === 0) parts.push(rng.chance(0.08) ? `-${piece}` : piece);
    else parts.push(`${rng.pick(['+', '-', '', '', '\\cdot '])}${piece}`);
  }
  return parts.join('');
}

// ------------------------------------------------------------ subject moulds
// Each mould is a small template family written from the structures these five
// books actually use. They exist so the corpus covers the deployment domain,
// not only generic recursion.

// Pick n distinct members, so a template never degenerates into m(X \ X).
function distinct(rng, list, count) {
  return rng.shuffle(list).slice(0, count);
}

function algebraMould(rng) {
  const [A, B] = distinct(rng, MATRICES, 2);
  const v = greek(rng);
  const n = rng.pick(['n', 'm', 's']);
  return rng.pick([
    () => {
      const body = paren(`${sub('E', n)}-${latin(rng)}${v}${sup(v, 'T')}`);
      return `${sup(A, 'T')}${A}=${sup(body, 'T')}${body}`;
    },
    () => `\\mathrm{rank}${paren(`${A}+${B}`)}\\leq\\mathrm{rank}${paren(A)}+\\mathrm{rank}${paren(B)}`,
    () => `\\det${paren(`${A}${B}`)}=\\det${paren(A)}\\cdot\\det${paren(B)}`,
    () => `${sup(A, '-1')}=\\frac{1}{\\det${paren(A)}}${sup(A, '*')}`,
    () => `${sub(v, '1')},${sub(v, '2')},\\cdots,${sub(v, idx(rng))}`,
    () => `${A}${sub(v, idx(rng))}=\\lambda${sub(v, idx(rng))}`,
    () => `\\langle${sub(v, '1')},${sub(v, '2')}\\rangle=${sup(sub(v, '1'), 'T')}${sub(v, '2')}`,
    () => `V=${sub('V', '1')}\\oplus${sub('V', '2')}`,
    () => `${sub('k', '1')}${sub(v, '1')}+${sub('k', '2')}${sub(v, '2')}+\\cdots+${sub('k', n)}${sub(v, n)}=0`,
    () => `${sup(paren(`${A}-${sub('E', n)}`), 'T')}=${sup(A, 'T')}-${sub('E', n)}`,
    () => `\\overline{${A}}=${sup(A, 'T')}`,
    () => `${A}=${sup('Q', 'T')}\\mathrm{diag}${paren(`${sub('\\lambda', '1')},\\cdots,${sub('\\lambda', n)}`)}Q`,
  ])();
}

function analysisMould(rng) {
  const [E, F] = distinct(rng, SETS, 2);
  const f = rng.pick(['f', 'g', 'h']);
  const n = rng.pick(['n', 'k']);
  return rng.pick([
    () => `m${paren(`${E}\\cup ${F}`)}\\leq m${paren(E)}+m${paren(F)}`,
    () => `m${paren(`${E}\\setminus ${F}`)}=m${paren(E)}-m${paren(`${E}\\cap ${F}`)}`,
    () => `\\lim_{${n}\\to\\infty}\\int_{${E}}${sub(f, n)}(x)dx=\\int_{${E}}${f}(x)dx`,
    () => `\\limsup_{${n}\\to\\infty}${sub(f, n)}(x)\\leq ${f}(x)`,
    () => `\\liminf_{${n}\\to\\infty}${sub('E', n)}\\subseteq\\limsup_{${n}\\to\\infty}${sub('E', n)}`,
    () => `\\forall\\varepsilon>0,\\exists\\delta>0,|${f}(x)-${f}(y)|<\\varepsilon`,
    () => `${E}=\\{x\\in\\mathbb{R}\\mid ${f}(x)\\geq ${int(rng)}\\}`,
    () => `\\int_{${E}}|${f}(x)|dx<\\infty`,
    () => `${sub('E', n)}\\subset ${sub('E', `${n}+1`)},${E}=\\bigcup_{${n}=1}^{\\infty}${sub('E', n)}`,
    () => `m${paren(`\\bigcup_{${n}=1}^{\\infty}${sub('E', n)}`)}=\\sum_{${n}=1}^{\\infty}m${paren(sub('E', n))}`,
    () => `${f}(x)\\in ${sup('L', '1')}${paren(`[a,b]`)}`,
  ])();
}

function pdeMould(rng) {
  const u = rng.pick(['u', 'v', 'w']);
  const a = latin(rng);
  return rng.pick([
    () => `\\frac{\\partial^{2}${u}}{\\partial ${'t'}^{2}}=${sup(a, '2')}\\frac{\\partial^{2}${u}}{\\partial ${'x'}^{2}}`,
    () => `\\frac{\\partial ${u}}{\\partial t}=${a}\\frac{\\partial^{2}${u}}{\\partial ${'x'}^{2}}`,
    () => `\\Delta ${u}=\\frac{\\partial^{2}${u}}{\\partial ${'x'}^{2}}+\\frac{\\partial^{2}${u}}{\\partial ${'y'}^{2}}`,
    () => `\\nabla ${u}\\cdot\\nabla ${rng.pick(['v', 'w'])}=0`,
    () => `${u}(x,0)=\\varphi(x),${sub(u, 't')}(x,0)=\\psi(x)`,
    () => `${u}(0,t)=${u}(${latin(rng)},t)=0`,
    () => `\\Delta ${u}=0\\Rightarrow ${u}\\equiv\\mathrm{const}`,
  ])();
}

// The moulds are a fixed template inventory, so their unique yield saturates
// after a few thousand draws and the deduplicator rejects the rest. Weight them
// for coverage of the three subjects, not for corpus share.
const MOULDS = [
  { name: 'algebra', weight: 0.20, make: algebraMould },
  { name: 'analysis', weight: 0.11, make: analysisMould },
  { name: 'pde', weight: 0.05, make: pdeMould },
];

// ------------------------------------------------------------------ formulas

// Width comes from relation chains, not from recursion depth. The real corpus
// is also more dispersed than a single chain length can reproduce: it runs from
// aspect ratio 2.4 at p10 (short fragments carrying a tall fraction or matrix)
// out to 20 at p90 (multi-step derivations on one line). Draw the three modes
// explicitly rather than hoping one distribution covers both tails.
function generic(rng) {
  const roll = rng.next();
  if (roll < 0.20) {
    if (rng.chance(0.35)) return tallFactor(rng);
    return term(rng, 1, tallBudget(rng), 3);
  }
  if (roll < 0.62) {
    const budget = tallBudget(rng);
    const parts = [term(rng, 1, budget)];
    for (let i = 0; i < rng.int(1, 2); i += 1) parts.push(rng.pick(RELATIONS), term(rng, 1, budget));
    return parts.join('');
  }
  // Long mode. One tall construct at most across the whole chain, and terms are
  // drawn at depth 2 so a matrix cannot fire: a real multi-step derivation fits
  // on one line precisely because every step of it is flat.
  const budget = { left: rng.chance(0.35) ? 1 : 0 };
  const parts = [term(rng, 2, budget, 5)];
  for (let i = 0; i < rng.int(3, 6); i += 1) parts.push(rng.pick(RELATIONS), term(rng, 2, budget, 5));
  return parts.join('');
}

function sample(rng) {
  const roll = rng.next();
  let threshold = 0;
  for (const mould of MOULDS) {
    threshold += mould.weight;
    if (roll < threshold) return { category: mould.name, latex: normalize(mould.make(rng)) };
  }
  return { category: 'generic', latex: normalize(generic(rng)) };
}

// ------------------------------------------------------------------ coverage
// The moulds are a finite template inventory, so the deduplicator exhausts them
// long before the corpus is full and the subject-specific symbols end up in a
// handful of rows. A token seen twice is a token the model cannot learn, so
// after the bulk pass every symbol is topped up to a floor by carriers that are
// built around it.

// Each carrier embeds a freshly generated sub-expression, so it never runs out
// of distinct labels the way a fixed template does. A carrier built only from
// symbol substitution saturates after a few dozen draws and leaves its token
// as rare as it started.
const setPick = rng => rng.pick(SETS);
const bit = rng => term(rng, 2, { left: 0 }, 3);

const CARRIERS = [
  ['\\det', rng => `\\det${paren(`${matrix(rng)}${matrix(rng)}`)}=${bit(rng)}\\det${paren(matrix(rng))}`],
  ['\\mathrm', rng => `\\mathrm{rank}${paren(bit(rng))}\\leq${bit(rng)}`],
  ['\\oplus', rng => `${sub('V', idx(rng))}=${bit(rng)}\\oplus${bit(rng)}`],
  ['\\langle', rng => `\\langle${bit(rng)},${bit(rng)}\\rangle=${bit(rng)}`],
  ['\\rangle', rng => `\\langle${bit(rng)},${latin(rng)}\\rangle\\geq${bit(rng)}`],
  ['\\setminus', rng => `m${paren(`${setPick(rng)}\\setminus ${setPick(rng)}`)}=${bit(rng)}`],
  ['\\limsup', rng => `\\limsup_{${rng.pick(INDICES)}\\to\\infty}${bit(rng)}=${bit(rng)}`],
  ['\\liminf', rng => `\\liminf_{${rng.pick(INDICES)}\\to\\infty}${bit(rng)}\\leq\\limsup_{${rng.pick(INDICES)}\\to\\infty}${bit(rng)}`],
  ['\\bigcup', rng => `${setPick(rng)}=\\bigcup_{${rng.pick(INDICES)}=1}^{\\infty}${sub('E', rng.pick(INDICES))}${bit(rng)}`],
  ['\\bigcap', rng => `${setPick(rng)}=\\bigcap_{${rng.pick(INDICES)}=1}^{\\infty}${sub('F', rng.pick(INDICES))}${bit(rng)}`],
  ['\\cap', rng => `${setPick(rng)}\\cap ${setPick(rng)}\\subseteq ${bit(rng)}`],
  ['\\cup', rng => `m${paren(`${setPick(rng)}\\cup ${setPick(rng)}`)}\\leq ${bit(rng)}+${bit(rng)}`],
  ['\\subset', rng => `${sub('E', rng.pick(INDICES))}\\subset ${bit(rng)}`],
  ['\\forall', rng => `\\forall\\varepsilon>0,\\exists\\delta>0,|${bit(rng)}|<\\varepsilon`],
  ['\\exists', rng => `\\exists ${latin(rng)}\\in\\mathbb{R},${bit(rng)}=${bit(rng)}`],
  ['\\nabla', rng => `\\nabla ${latin(rng)}\\cdot\\nabla ${latin(rng)}=${bit(rng)}`],
  ['\\Delta', rng => `\\Delta ${latin(rng)}=\\frac{\\partial^{2}${latin(rng)}}{\\partial x^{2}}+${bit(rng)}`],
  ['\\psi', rng => `${latin(rng)}(x,0)=\\varphi${paren(bit(rng))},${sub(latin(rng), 't')}(x,0)=\\psi(x)`],
  ['\\overline', rng => `\\overline{${bit(rng)}}=${sup(matrix(rng), 'T')}${bit(rng)}`],
  ['\\mathbb', rng => `${setPick(rng)}=\\{x\\in\\mathbb{R}\\mid ${bit(rng)}>${int(rng)}\\}`],
  ['\\mid', rng => `\\{${latin(rng)}\\mid ${bit(rng)}\\geq${int(rng)}\\}`],
  ['[', rng => `${bit(rng)}\\in ${sup('L', '1')}${paren('[a,b]')}`],
  ['|', rng => `\\int_{${setPick(rng)}}|${bit(rng)}|dx<\\infty`],
  ['*', rng => `${sup(matrix(rng), '*')}=\\det${paren(matrix(rng))}${bit(rng)}`],
  ['\\partial', rng => `\\frac{\\partial ${latin(rng)}}{\\partial t}=${bit(rng)}\\frac{\\partial^{2}${latin(rng)}}{\\partial x^{2}}`],
  ['\\begin{bmatrix}', rng => `${bit(rng)}=\\begin{bmatrix}${bit(rng)}&${bit(rng)}\\\\${bit(rng)}&${bit(rng)}\\end{bmatrix}`],
  ['\\begin{vmatrix}', rng => `\\begin{vmatrix}${bit(rng)}&${bit(rng)}\\\\${bit(rng)}&${bit(rng)}\\end{vmatrix}=${bit(rng)}`],
  ['\\begin{pmatrix}', rng => `\\begin{pmatrix}${bit(rng)}&${bit(rng)}\\\\${bit(rng)}&${bit(rng)}\\end{pmatrix}${bit(rng)}`],
  ['\\begin{cases}', rng => `${latin(rng)}=\\begin{cases}${bit(rng)}&x<${int(rng)}\\\\${bit(rng)}&x\\geq${int(rng)}\\end{cases}`],
  // \mathrm{const} is the only place the bare letters c,o,n,s,t appear as
  // individual tokens; without a carrier the PDE mould yields three rows of it
  // and "o" stays a token the model has effectively never seen.
  ['o', rng => `\\Delta ${latin(rng)}=${bit(rng)}\\Rightarrow ${latin(rng)}\\equiv\\mathrm{const}`],
];

// ----------------------------------------------------------------- rendering

const renderer = createStrictFormulaRenderer();
const SIZE = /^<svg[^>]*?\bwidth="([\d.]+)ex"[^>]*?\bheight="([\d.]+)ex"/;

async function rasterize(latex) {
  const svg = renderer.render(latex);
  const found = SIZE.exec(svg);
  if (!found) throw new Error('MathJax SVG is missing ex dimensions');
  const width = Math.max(1, Math.round(Number(found[1]) * EX_PX));
  const height = Math.max(1, Math.round(Number(found[2]) * EX_PX));
  // Give sharp explicit pixel dimensions so the raster scale is ours, not a
  // default density. Flatten onto white: the model preprocesses white-ground crops.
  const sized = svg.replace(SIZE, (whole) => whole
    .replace(/\bwidth="[\d.]+ex"/, `width="${width}px"`)
    .replace(/\bheight="[\d.]+ex"/, `height="${height}px"`));
  return sharp(Buffer.from(sized))
    .flatten({ background: '#ffffff' })
    .greyscale()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// -------------------------------------------------------------------- corpus

async function main() {
  const existing = await fs.readdir(output).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (existing.length) throw new Error(`Refusing to overwrite an existing corpus at ${output}`);
  await fs.mkdir(path.join(output, 'images'), { recursive: true });

  const wanted = { train: options.train, validation: options.validation, test: options.test };
  const total = wanted.train + wanted.validation + wanted.test;
  const rng = makeRandom(options.seed);
  const seenLabel = new Set();
  const seenPng = new Set();
  const records = [];
  const shapes = [];

  let attempts = 0;
  const limit = total * 60;

  // Phase 1 tops every carrier symbol up to a floor, phase 2 fills the rest.
  // Coverage runs first because the deduplicator makes the tail of a long run
  // the least productive place to ask for a specific rare symbol.
  const plan = [];
  for (const [token, make] of CARRIERS) {
    plan.push({ category: 'coverage', token, make, want: COVER });
  }
  let carrier = 0;
  let carrierMade = 0;

  const draw = () => {
    while (carrier < plan.length) {
      const entry = plan[carrier];
      if (carrierMade >= entry.want) {
        carrier += 1;
        carrierMade = 0;
        continue;
      }
      return { category: 'coverage', latex: normalize(entry.make(rng)), carrierToken: entry.token };
    }
    return sample(rng);
  };

  while (records.length < total && attempts < limit) {
    attempts += 1;
    const drawn = draw();
    const { category, latex } = drawn;
    const tokens = lex(latex);
    if (tokens.length + 2 > MAX_TOKENS || tokens.length < 2) continue;
    const key = labelKey(latex);
    if (seenLabel.has(key)) {
      // A carrier that can no longer produce a fresh label is exhausted; move on
      // rather than spinning on it for the rest of the budget.
      if (drawn.carrierToken) {
        carrierMade += 1;
        if (attempts % 400 === 0) { carrier += 1; carrierMade = 0; }
      }
      continue;
    }

    let png;
    try {
      png = await rasterize(latex);
    } catch (error) {
      if (process.env.SHOW_REJECTS && attempts < 40) process.stderr.write(`REJECT ${JSON.stringify(latex)}\n  ${error.message}\n`);
      continue; // fail closed: a label the renderer rejects never enters the corpus
    }
    const digest = sha256(png);
    if (seenPng.has(digest)) continue;

    const meta = await sharp(png).metadata();
    seenLabel.add(key);
    seenPng.add(digest);
    const id = `textbook-${String(records.length).padStart(6, '0')}`;
    const file = path.join('images', `${id}.png`);
    await fs.writeFile(path.join(output, file), png);
    records.push({
      id,
      image: file,
      latex,
      category,
      tokens: tokens.length,
      width: meta.width,
      height: meta.height,
      image_sha256: digest,
    });
    if (drawn.carrierToken) carrierMade += 1;
    shapes.push(meta.width / Math.max(1, meta.height));
    if (records.length % 2000 === 0) {
      process.stdout.write(`${JSON.stringify({ generated: records.length, of: total, attempts })}\n`);
    }
  }
  if (records.length < total) throw new Error(`Only produced ${records.length} of ${total} unique samples`);

  // Split. Labels and PNG bytes are already globally unique, so assigning whole
  // records is enough for label/image isolation; the split is a plain partition
  // of a shuffled list and each split keeps the same mould mix.
  const shuffled = rng.shuffle(records);
  const splits = {
    train: shuffled.slice(0, wanted.train),
    validation: shuffled.slice(wanted.train, wanted.train + wanted.validation),
    test: shuffled.slice(wanted.train + wanted.validation),
  };
  const trainTokens = new Set(splits.train.flatMap(row => lex(row.latex)));
  const unseen = {};
  for (const [name, rows] of Object.entries(splits)) {
    if (name === 'train') continue;
    const missing = new Set();
    for (const row of rows) for (const token of lex(row.latex)) if (!trainTokens.has(token)) missing.add(token);
    unseen[name] = [...missing].sort();
  }

  for (const [name, rows] of Object.entries(splits)) {
    const body = rows.map(row => JSON.stringify({ ...row, split: name })).join('\n');
    await fs.writeFile(path.join(output, `${name}.jsonl`), `${body}\n`, 'utf8');
  }

  const sorted = [...shapes].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const categories = {};
  for (const row of records) categories[row.category] = (categories[row.category] ?? 0) + 1;
  const report = {
    created_at: new Date().toISOString(),
    generator: 'generate-textbook-data.mjs',
    provenance: {
      labels: 'authored by this grammar; the label is the renderer input, so it is correct by construction',
      recognizer_used: false,
      teacher_model: null,
      pretrained_weights: false,
      renderer: 'MathJax 3.2.2 strict (parser errors throw, error nodes rejected)',
    },
    seed: options.seed,
    ex_px: EX_PX,
    max_tokens: MAX_TOKENS,
    attempts,
    counts: { train: splits.train.length, validation: splits.validation.length, test: splits.test.length, total: records.length },
    categories,
    aspect_ratio: { p10: at(0.1), median: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] },
    real_targets: { aspect_ratio_median: 7.36, aspect_ratio_p90: 20.67, ink_height_median: 33, stroke_median: 2.24 },
    vocabulary_size: new Set(records.flatMap(row => lex(row.latex))).size,
    evaluation_tokens_missing_from_training: unseen,
    token_coverage: (() => {
      const rows = new Map();
      for (const row of splits.train) {
        for (const token of new Set(lex(row.latex))) rows.set(token, (rows.get(token) ?? 0) + 1);
      }
      const ordered = [...rows.entries()].sort((a, b) => a[1] - b[1]);
      return {
        floor_requested: COVER,
        rarest_in_training: Object.fromEntries(ordered.slice(0, 12)),
        tokens_under_100_rows: ordered.filter(([, n]) => n < 100).length,
        tokens_under_300_rows: ordered.filter(([, n]) => n < 300).length,
      };
    })(),
  };
  await fs.writeFile(path.join(output, 'corpus-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

await main();
