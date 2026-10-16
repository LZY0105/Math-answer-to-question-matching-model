// Find-Engine v2: independently authored recursive formula grammar and labels.
// MathJax/sharp are rendering tools, not recognizers or sources of model weights.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createStrictFormulaRenderer, STRICT_TEX_POLICY } from './strict-mathjax.mjs';

const DEFAULTS = { output: 'tmp/formula-diverse-data-v2', train: 40000, validation: 1500, test: 1500, seed: 9152026, 'image-height': 128, 'image-width': 512 };
const options = { ...DEFAULTS };
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (flag === '--help') {
    console.log('node ocr/generate-diverse-data.mjs --output DIR --train 40000 --validation 1500 --test 1500 --seed 9152026 [--image-height 128 --image-width 512]');
    process.exit(0);
  }
  const name = flag.replace(/^--/, '');
  if (!flag.startsWith('--') || !Object.hasOwn(DEFAULTS, name) || process.argv[i + 1] === undefined) throw Error(`Unknown or incomplete option: ${flag}`);
  options[name] = name === 'output' ? process.argv[i + 1] : Number(process.argv[i + 1]);
}
if (!Number.isSafeInteger(options.seed) || Object.entries(options).some(([key, value]) => ['train', 'validation', 'test'].includes(key) && (!Number.isSafeInteger(value) || value < 1))) throw Error('Integer seed and positive integer split sizes required');
if (['image-height', 'image-width'].some(key => !Number.isSafeInteger(options[key]) || options[key] < 32 || options[key] > 2048 || options[key] % 16)) throw Error('Target dimensions must be multiples of 16 in [32, 2048]');
const output = path.resolve(options.output);
const MAX_TOKENS = 100; // Includes the training tokenizer's BOS and EOS.
const WIDTH = options['image-width'], HEIGHT = options['image-height'], MARGIN = 4, CANONICAL_FONT = 120;
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const lex = latex => latex.match(/\\(?:begin|end)\{[a-zA-Z*]+\}|\\[A-Za-z]+|\\.|[^\s]/gu) ?? [];
const labelKey = latex => JSON.stringify(lex(latex));

function makeRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  return { next, pick: xs => xs[Math.floor(next() * xs.length)], int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), chance: probability => next() < probability };
}
const VARIABLES = ['x', 'y', 'z', 'a', 'b', 'c', 'd', 'f', 'g', 'h', 't', 'u', 'v', 'w', 'p', 'q', 'r', 's', 'n', 'm', 'i', 'j', 'k', 'A', 'B', 'C', 'M'];
const GREEK = ['\\alpha', '\\beta', '\\gamma', '\\delta', '\\theta', '\\lambda', '\\mu', '\\pi', '\\rho', '\\sigma', '\\phi', '\\omega'];
const FUNCTIONS = ['\\sin', '\\cos', '\\tan', '\\ln', '\\log', '\\exp'];
const leaf = value => ({ kind: 'leaf', value: String(value) });
const symbol = rng => leaf(rng.chance(0.18) ? rng.pick(GREEK) : rng.pick(VARIABLES));
const atom = rng => rng.chance(0.45) ? leaf(rng.int(0, rng.chance(0.85) ? 20 : 99)) : symbol(rng);
const variable = rng => rng.pick(['x', 'y', 'z', 't', 'u']);
const index = rng => rng.chance(0.3)
  ? { kind: 'sum', terms: [leaf(rng.pick(['i', 'j', 'k', 'n', 'm'])), leaf(rng.int(1, 5))], signs: ['+'] }
  : leaf(rng.chance(0.6) ? rng.pick(['i', 'j', 'k', 'n', 'm']) : rng.int(0, 12));

// Operators can occur recursively, including on either side of a relation.
// The node budget limits growth independently of depth; final lexical and pixel
// checks reject an entire candidate rather than truncating its target.
function expression(rng, depth, budget) {
  if (depth <= 0 || budget <= 1) return atom(rng);
  const kind = rng.pick(['leaf', 'sum', 'sum', 'product', 'product', 'fraction', 'fraction',
    'power', 'subscript', 'scripts', 'root', 'function', 'function', 'integral', 'series', 'limit', 'matrix', 'derivative', 'cases']);
  const child = (parts = 2, childDepth = depth - 1) => expression(rng, childDepth, Math.max(1, Math.floor((budget - 1) / parts)));
  switch (kind) {
    case 'leaf': return atom(rng);
    case 'sum': {
      const count = rng.chance(0.25) && budget > 5 ? 3 : 2;
      return { kind, terms: Array.from({ length: count }, () => child(count)), signs: Array.from({ length: count - 1 }, () => rng.pick(['+', '-'])) };
    }
    case 'product': return { kind, factors: [child(), child()], explicit: rng.chance(0.4) };
    case 'fraction': return { kind, numerator: child(), denominator: child() };
    case 'power': return { kind, base: child(), exponent: rng.chance(0.7) ? leaf(rng.int(2, 8)) : child(3, Math.min(1, depth - 1)) };
    case 'subscript': return { kind, base: symbol(rng), subscript: index(rng) };
    case 'scripts': return { kind, base: symbol(rng), subscript: index(rng), exponent: rng.chance(0.75) ? leaf(rng.int(2, 6)) : index(rng) };
    case 'root': return { kind, body: child(1), index: rng.chance(0.3) ? rng.int(3, 5) : null };
    case 'function': {
      const name = rng.pick(FUNCTIONS);
      return { kind, name, argument: child(1), parenthesized: rng.chance(0.65), exponent: ['\\sin', '\\cos', '\\tan'].includes(name) && rng.chance(0.25) ? rng.int(2, 4) : null };
    }
    case 'integral': return { kind, body: child(1), variable: variable(rng), bounded: rng.chance(0.65), lower: leaf(rng.int(-3, 2)), upper: rng.chance(0.5) ? leaf(rng.int(3, 9)) : symbol(rng) };
    case 'series': return { kind, operator: rng.pick(['\\sum', '\\prod']), variable: rng.pick(['i', 'j', 'k']), lower: rng.int(0, 3), upper: index(rng), body: child(1) };
    case 'limit': return { kind, variable: variable(rng), destination: leaf(rng.pick(['0', '1', '-1', '\\infty'])), body: child(1) };
    case 'matrix': {
      const environment = rng.pick(['pmatrix', 'bmatrix', 'vmatrix']);
      const [rows, columns] = environment === 'vmatrix' ? rng.pick([[2, 2], [3, 3]]) : rng.pick([[1, 2], [2, 1], [2, 2], [2, 2], [2, 3], [3, 2], [3, 3], [3, 1]]);
      return { kind, environment, rows: Array.from({ length: rows }, () => Array.from({ length: columns }, () => child(rows * columns, Math.min(2, depth - 1)))) };
    }
    case 'derivative': return { kind, variable: variable(rng), partial: rng.chance(0.3), body: child(1) };
    case 'cases': return { kind, variable: variable(rng), boundary: rng.int(-3, 5), branches: [child(), child()] };
    default: throw Error(`Unimplemented node: ${kind}`);
  }
}

const group = node => `\\left(${serialize(node)}\\right)`;
const numeric = node => node.kind === 'leaf' && /^-?\d+$/.test(node.value);
const isNegative = node => node.kind === 'leaf' && node.value.startsWith('-');
function operand(node) { return ['sum', 'relation', 'integral', 'series', 'limit', 'derivative', 'cases'].includes(node.kind) || isNegative(node) ? group(node) : serialize(node); }
function joinTeX(parts, separator) {
  return parts.reduce((result, part, i) => {
    const prefix = i ? result + separator : result;
    return prefix + (/\\[A-Za-z]+$/.test(prefix) && /^[A-Za-z]/.test(part) ? ' ' : '') + part;
  }, '');
}
function serialize(node) {
  switch (node.kind) {
    case 'leaf': return node.value;
    case 'sum': return node.terms.map((term, i) => `${i ? node.signs[i - 1] : ''}${term.kind === 'sum' || term.kind === 'relation' || (i && isNegative(term)) ? group(term) : serialize(term)}`).join('');
    case 'product': {
      // Adjacent decimal literals must never collapse into a different number.
      const separator = node.explicit || node.factors.some(numeric) && node.factors.every(numeric) ? '\\cdot ' : '';
      return joinTeX(node.factors.map(operand), separator);
    }
    case 'fraction': return `\\frac{${serialize(node.numerator)}}{${serialize(node.denominator)}}`;
    case 'power': return `${node.base.kind === 'leaf' && !isNegative(node.base) ? serialize(node.base) : group(node.base)}^{${serialize(node.exponent)}}`;
    case 'subscript': return `${serialize(node.base)}_{${serialize(node.subscript)}}`;
    case 'scripts': return `${serialize(node.base)}_{${serialize(node.subscript)}}^{${serialize(node.exponent)}}`;
    case 'root': return `\\sqrt${node.index === null ? '' : `[${node.index}]`}{${serialize(node.body)}}`;
    case 'function': return `${node.name}${node.exponent === null ? '' : `^{${node.exponent}}`}${node.parenthesized || node.argument.kind !== 'leaf' || isNegative(node.argument) ? group(node.argument) : ` ${serialize(node.argument)}`}`;
    case 'integral': return joinTeX([`\\int${node.bounded ? `_{${serialize(node.lower)}}^{${serialize(node.upper)}}` : ''}`, node.body.kind === 'sum' || node.body.kind === 'relation' ? group(node.body) : serialize(node.body), `\\,d${node.variable}`], '');
    case 'series': return `${node.operator}_{${node.variable}=${node.lower}}^{${serialize(node.upper)}}${operand(node.body)}`;
    case 'limit': return `\\lim_{${node.variable}\\to ${serialize(node.destination)}}${operand(node.body)}`;
    case 'matrix': return `\\begin{${node.environment}}${node.rows.map(row => row.map(serialize).join('&')).join('\\\\')}\\end{${node.environment}}`;
    case 'derivative': return `\\frac{${node.partial ? '\\partial' : 'd'}}{${node.partial ? '\\partial ' : 'd'}${node.variable}}${group(node.body)}`;
    case 'cases': return `\\begin{cases}${serialize(node.branches[0])}&${node.variable}<${node.boundary}\\\\${serialize(node.branches[1])}&${node.variable}\\geq ${node.boundary}\\end{cases}`;
    case 'relation': return node.sides.map(serialize).join(node.operator);
    default: throw Error(`Cannot serialize node: ${node.kind}`);
  }
}

function children(node) {
  switch (node.kind) {
    case 'sum': return node.terms;
    case 'product': return node.factors;
    case 'fraction': return [node.numerator, node.denominator];
    case 'power': return [node.base, node.exponent];
    case 'subscript': return [node.base, node.subscript];
    case 'scripts': return [node.base, node.subscript, node.exponent];
    case 'root': case 'integral': case 'limit': case 'derivative': return [node.body];
    case 'series': return [node.body, node.upper];
    case 'function': return [node.argument];
    case 'matrix': return node.rows.flat();
    case 'cases': return node.branches;
    case 'relation': return node.sides;
    default: return [];
  }
}
function features(node, found = new Set()) { if (node.kind !== 'leaf') found.add(node.kind); for (const child of children(node)) features(child, found); return [...found].sort(); }
function smallestGlyphFactor(node) {
  const parts = children(node);
  if (!parts.length) return 1;
  if (node.kind === 'fraction') return 0.72 * Math.min(...parts.map(smallestGlyphFactor));
  if (node.kind === 'power') return Math.min(smallestGlyphFactor(node.base), 0.68 * smallestGlyphFactor(node.exponent));
  if (node.kind === 'subscript') return Math.min(1, 0.68 * smallestGlyphFactor(node.subscript));
  if (node.kind === 'scripts') return 0.68 * Math.min(smallestGlyphFactor(node.subscript), smallestGlyphFactor(node.exponent));
  if (node.kind === 'root') return Math.min(node.index === null ? 1 : 0.55, smallestGlyphFactor(node.body));
  if (node.kind === 'integral' || node.kind === 'limit' || node.kind === 'series') return Math.min(0.68, ...parts.map(smallestGlyphFactor));
  return Math.min(...parts.map(smallestGlyphFactor));
}
const TIERS = {
  short: { depth: 1, budget: 5, minimum: 1, maximum: 24 },
  medium: { depth: 2, budget: 12, minimum: 14, maximum: 58 },
  complex: { depth: 3, budget: 24, minimum: 35, maximum: MAX_TOKENS - 2 },
};
const SCHEDULE = ['short', 'short', 'short', 'medium', 'medium', 'medium', 'medium', 'complex', 'complex', 'complex'];
function sampleTree(rng, tier) {
  const plan = TIERS[tier];
  if (rng.chance(0.4)) {
    const count = rng.chance(0.1) && tier !== 'short' ? 3 : 2;
    return { kind: 'relation', operator: rng.pick(['=', '=', '=', '<', '>', '\\leq ', '\\geq ', '\\neq ']),
      sides: Array.from({ length: count }, () => expression(rng, plan.depth, Math.max(2, Math.floor(plan.budget / count)))) };
  }
  return expression(rng, plan.depth, plan.budget);
}

// These were already inspected while developing v1: exclude them from v2
// training, but do not relabel them as fresh or blind evaluation evidence.
const V1_DEVELOPMENT_LABELS = [
  String.raw`y=\frac{x+1}{x-1}`, String.raw`x=\frac{-b\pm\sqrt{b^{2}-4ac}}{2a}`,
  String.raw`\frac{1}{1+\frac{1}{x}}`, String.raw`\int_{0}^{1}x^{2}\,dx=\frac{1}{3}`,
  String.raw`\sum_{k=1}^{n}k=\frac{n(n+1)}{2}`, String.raw`\lim_{x\to0}\frac{\sin x}{x}=1`,
  String.raw`A=\begin{pmatrix}1&2\\3&4\end{pmatrix}`, String.raw`\begin{pmatrix}1&0&0\\0&1&0\\0&0&1\end{pmatrix}`,
  String.raw`\begin{vmatrix}a&b\\c&d\end{vmatrix}=ad-bc`, String.raw`\sqrt{x^{2}+y^{2}}`,
  String.raw`a_{n+1}=a_{n}+2`, String.raw`\sin^{2}\theta+\cos^{2}\theta=1`,
];
const CHALLENGE = [
  ['fraction-root-relation', String.raw`\frac{x^{2}+1}{y_{n}-2}=\sqrt{z+3}`],
  ['scripts-fraction-row', String.raw`u_{i}^{2}+\frac{v_{j}}{w_{k}+1}`],
  ['integral-fraction', String.raw`\int_{-1}^{2}\left(x+\frac{1}{x^{2}+1}\right)\,dx`],
  ['integral-relation', String.raw`\int\frac{\cos\left(t\right)}{1+t^{2}}\,dt=C-\frac{1}{t+1}`],
  ['fraction-of-integral', String.raw`\frac{\int_{0}^{a}t^{2}\,dt}{a^{3}+1}`],
  ['trigonometric-relation', String.raw`\sin\left(x+y\right)=\cos^{2}\left(z\right)-\frac{1}{2}`],
  ['trigonometric-power', String.raw`\tan x+\sin^{3}y=\frac{a}{b+c}`],
  ['indexed-root-fraction', String.raw`\sqrt[3]{\frac{x_{1}+y_{2}}{z^{2}}}`],
  ['nested-fraction', String.raw`\frac{1+\frac{x}{y}}{1-\frac{y}{x}}`],
  ['matrix-expression-cells', String.raw`A=\begin{bmatrix}x+1&\frac{1}{y}\\z^{2}&\sqrt{t}\end{bmatrix}`],
  ['matrix-relation', String.raw`\begin{pmatrix}a_{1}&b_{2}\\c_{3}&d_{4}\end{pmatrix}=\begin{pmatrix}1&0\\0&1\end{pmatrix}`],
  ['determinant-functions', String.raw`\begin{vmatrix}\sin x&\cos x\\-2&x^{2}\end{vmatrix}`],
  ['sum-fraction-relation', String.raw`\sum_{j=2}^{n+1}\frac{j}{j^{2}+1}=\frac{u_{n}}{v_{n}}`],
  ['limit-difference', String.raw`\lim_{h\to0}\frac{\sin\left(x+h\right)-\sin x}{h}`],
  ['greek-script-relation', String.raw`\alpha_{i}^{2}+\beta_{j}^{3}=\gamma\sqrt{x+1}`],
  ['fraction-power', String.raw`y=\left(\frac{x+2}{x-2}\right)^{3}`],
  ['derivative-relation', String.raw`\frac{d}{dt}\left(t^{3}+\cos t\right)=3t^{2}-\sin t`],
  ['product-fraction', String.raw`\prod_{k=1}^{m}\left(1+\frac{1}{k}\right)=m+1`],
  ['integral-row', String.raw`\int_{0}^{1}x\,dx+\int_{1}^{2}x^{2}\,dx`],
  ['root-fraction-root', String.raw`\sqrt{x^{2}+\frac{1}{\sqrt{y+1}}}`],
  ['script-index-fraction', String.raw`\frac{a_{n+1}}{a_{n}}=\frac{n+2}{n+1}`],
  ['logarithmic-relation', String.raw`\log\left(x^{2}+1\right)+\ln y=\theta`],
  ['matrix-vector-product', String.raw`\begin{pmatrix}x&1&0\\0&y&1\\1&0&z\end{pmatrix}\begin{pmatrix}a\\b\\c\end{pmatrix}`],
  ['function-of-fraction', String.raw`\cos\left(\frac{x+y}{2}\right)+\sin\left(\sqrt{z}\right)`],
  ['cases-with-fraction', String.raw`f\left(x\right)=\begin{cases}\frac{x}{1-x}&x<0\\\sqrt{x+1}&x\geq0\end{cases}`],
  ['partial-derivative-root', String.raw`\frac{\partial}{\partial y}\left(\sqrt{x^{2}+y^{2}}\right)`],
  ['matrix-plus-matrix', String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}+\begin{bmatrix}1&2\\3&5\end{bmatrix}`],
  ['three-part-relation', String.raw`\frac{x}{y}=\sqrt{z+1}=\sin\theta`],
];

const renderer = createStrictFormulaRenderer();
function formulaSvg(latex, fontSize) {
  let svg = renderer.render(latex);
  const viewBox = svg.match(/viewBox="([^"]+)"/);
  if (!viewBox) throw Error('MathJax produced no viewBox');
  const box = viewBox[1].split(/\s+/).map(Number);
  const width = Math.max(1, Math.ceil(box[2] * fontSize / 1000));
  const height = Math.max(1, Math.ceil(box[3] * fontSize / 1000));
  if (width > 8000 || height > 4000) return null;
  svg = svg.replace(/width="[^"]+"/, `width="${width}"`).replace(/height="[^"]+"/, `height="${height}"`);
  return { svg: Buffer.from(svg), width, height };
}
async function prepareRender(latex, glyphFactor = 1) {
  // The dedup fingerprint always uses the same render size and target canvas;
  // random PNG size cannot disguise a cross-split duplicate.
  const source = formulaSvg(latex, CANONICAL_FONT);
  if (!source) return null;
  const raw = await sharp(source.svg).flatten({ background: 'white' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let left = raw.info.width, top = raw.info.height, right = -1, bottom = -1;
  for (let y = 0; y < raw.info.height; y++) for (let x = 0; x < raw.info.width; x++) {
    if (raw.data[y * raw.info.width + x] < 245) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  if (right < left || bottom < top) throw Error(`Blank formula render: ${latex}`);
  const box = { left, top, width: right - left + 1, height: bottom - top + 1 };
  const scale = Math.min((WIDTH - MARGIN * 2) / box.width, (HEIGHT - MARGIN * 2) / box.height);
  const effectiveEm = CANONICAL_FONT * scale;
  if (effectiveEm < 14 || effectiveEm * glyphFactor < 7.5) return null;
  const resizedWidth = Math.max(1, Math.round(box.width * scale));
  const resizedHeight = Math.max(1, Math.round(box.height * scale));
  const resizedResult = await sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: 1 } })
    .extract(box).resize(resizedWidth, resizedHeight, { kernel: 'lanczos3' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (raw.info.channels !== 1 || resizedResult.info.channels !== 1 || resizedResult.data.length !== resizedWidth * resizedHeight) throw Error('Expected single-channel canonical pixels');
  const resized = resizedResult.data;
  const canonical = Buffer.alloc(WIDTH * HEIGHT, 255);
  const offsetX = Math.floor((WIDTH - resizedWidth) / 2), offsetY = Math.floor((HEIGHT - resizedHeight) / 2);
  for (let y = 0; y < resizedHeight; y++) resized.copy(canonical, (y + offsetY) * WIDTH + offsetX, y * resizedWidth, (y + 1) * resizedWidth);
  return { latex, canonical_sha256: sha256(canonical), effective_em_pixels: Number(effectiveEm.toFixed(3)), estimated_smallest_em_pixels: Number((effectiveEm * glyphFactor).toFixed(3)) };
}
async function writeImage(prepared, destination, fontSize) {
  const source = formulaSvg(prepared.latex, fontSize);
  if (!source) throw Error('Accepted formula unexpectedly exceeds output render bounds');
  const png = await sharp(source.svg).flatten({ background: 'white' })
    .extend({ top: 6, bottom: 6, left: 6, right: 6, background: 'white' }).greyscale().png().toBuffer();
  await fs.writeFile(destination, png);
  return { image_sha256: sha256(png), render_font_pixels: fontSize, source_width: source.width + 12, source_height: source.height + 12 };
}

const existing = await fs.readdir(output).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
if (existing.length) throw Error('Output directory is not empty; use a new directory to avoid mixing runs');
await fs.mkdir(output, { recursive: true });
const usedLabels = new Set(), usedCanonicalImages = new Set(), usedPngHashes = new Set();
const heldOut = [];
for (const [category, latex] of CHALLENGE) {
  if (lex(latex).length + 2 > MAX_TOKENS) throw Error(`Challenge exceeds token limit: ${category}`);
  const prepared = await prepareRender(latex);
  if (!prepared) throw Error(`Challenge is too small at model resolution: ${category}`);
  if (usedLabels.has(labelKey(latex)) || usedCanonicalImages.has(prepared.canonical_sha256)) throw Error(`Duplicate challenge: ${category}`);
  usedLabels.add(labelKey(latex)); usedCanonicalImages.add(prepared.canonical_sha256);
  heldOut.push({ category, ...prepared });
}
for (const latex of V1_DEVELOPMENT_LABELS) {
  usedLabels.add(labelKey(latex));
  const prepared = await prepareRender(latex);
  if (prepared) usedCanonicalImages.add(prepared.canonical_sha256);
}

const basics = [...VARIABLES, ...GREEK, ...Array.from({ length: 31 }, (_, n) => String(n)), '\\infty',
  String.raw`\frac{x}{y}`, String.raw`x_{i}`, String.raw`x^{2}`, String.raw`x_{i}^{2}`,
  String.raw`\sqrt{x}`, String.raw`\sqrt[3]{x}`, ...FUNCTIONS.map(name => `${name} x`),
  String.raw`\int x\,dx`, String.raw`\int_{0}^{1}t\,dt`, String.raw`\sum_{k=1}^{n}k`,
  String.raw`\prod_{k=1}^{n}k`, String.raw`\lim_{x\to0}x`, String.raw`\frac{d}{dx}\left(x\right)`,
  String.raw`\frac{\partial}{\partial y}\left(y\right)`, String.raw`x\cdot y`,
  String.raw`x\leq y`, String.raw`x\geq y`, String.raw`x\neq y`, String.raw`x<y`, String.raw`x>y`, String.raw`x=y`,
  String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, String.raw`\begin{bmatrix}1&2\\3&5\end{bmatrix}`,
  String.raw`\begin{vmatrix}1&0\\0&2\end{vmatrix}`, String.raw`\begin{cases}x&x<0\\y&x\geq0\end{cases}`];
const splitDetails = {};
const trainTokens = new Set();
const requiredEvaluationTokens = new Set(heldOut.flatMap(row => lex(row.latex)));
const splitOffsets = { train: 0x7e57a11, validation: 0x4a11da7e, test: 0x7e57001 };
for (const split of ['train', 'validation', 'test']) {
  const rng = makeRandom((options.seed ^ splitOffsets[split]) >>> 0);
  const count = options[split], rows = [];
  const rejects = { duplicate_label: 0, duplicate_canonical_image: 0, token_length: 0, too_small: 0 };
  let attempts = 0, basicIndex = 0;
  await fs.mkdir(path.join(output, split), { recursive: true });
  while (rows.length < count) {
    if (++attempts > count * 150 + basics.length) throw Error(`Cannot fill ${split}; accepted ${rows.length}/${count}, rejected ${JSON.stringify(rejects)}`);
    const basic = split === 'train' && basicIndex < basics.length ? basics[basicIndex++] : null;
    const tier = basic ? 'atomic-coverage' : SCHEDULE[rows.length % SCHEDULE.length];
    const tree = basic ? null : sampleTree(rng, tier);
    const latex = basic ?? serialize(tree);
    const tokenCount = lex(latex).length + 2;
    if (tokenCount > MAX_TOKENS || (!basic && (tokenCount - 2 < TIERS[tier].minimum || tokenCount - 2 > TIERS[tier].maximum))) { rejects.token_length++; continue; }
    const key = labelKey(latex);
    if (usedLabels.has(key)) { rejects.duplicate_label++; continue; }
    const prepared = await prepareRender(latex, tree ? smallestGlyphFactor(tree) : 1);
    if (!prepared) { rejects.too_small++; continue; }
    if (usedCanonicalImages.has(prepared.canonical_sha256)) { rejects.duplicate_canonical_image++; continue; }
    const id = `${split}-${String(rows.length).padStart(6, '0')}`, image = `${split}/${id}.png`;
    // Rasterize well above the target resolution so fine scripts are not lost
    // before Pillow performs the training resize. This does not change labels.
    const imageInfo = await writeImage(prepared, path.join(output, image), rng.int(112, 144));
    if (usedPngHashes.has(imageInfo.image_sha256)) throw Error('Exact PNG duplicate escaped canonical-image deduplication');
    usedLabels.add(key); usedCanonicalImages.add(prepared.canonical_sha256); usedPngHashes.add(imageInfo.image_sha256);
    for (const token of lex(latex)) (split === 'train' ? trainTokens : requiredEvaluationTokens).add(token);
    const structuralFeatures = tree ? features(tree) : ['atomic-coverage'];
    const category = ['matrix', 'integral', 'fraction', 'scripts', 'power', 'root', 'series', 'limit', 'function', 'cases', 'derivative'].find(kind => structuralFeatures.includes(kind)) ?? tier;
    rows.push({ id, image, latex, category, split, difficulty: tier, features: structuralFeatures, token_count_with_specials: tokenCount,
      canonical_image_sha256: prepared.canonical_sha256, effective_em_pixels: prepared.effective_em_pixels,
      estimated_smallest_em_pixels: prepared.estimated_smallest_em_pixels, ...imageInfo });
    if (rows.length % 1000 === 0) console.log(`${split}: ${rows.length}/${count}`);
  }
  const contents = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await fs.writeFile(path.join(output, `${split}.jsonl`), contents);
  const countBy = field => rows.reduce((result, row) => { result[row[field]] = (result[row[field]] ?? 0) + 1; return result; }, {});
  splitDetails[split] = { count, sha256: sha256(contents), attempts, rejects, difficulty: countBy('difficulty'), categories: countBy('category'),
    minimum_tokens_with_specials: Math.min(...rows.map(row => row.token_count_with_specials)), maximum_tokens_with_specials: Math.max(...rows.map(row => row.token_count_with_specials)) };
}
const missingTokens = [...requiredEvaluationTokens].filter(token => !trainTokens.has(token)).sort();
if (missingTokens.length) throw Error(`Training labels do not cover evaluation tokens ${JSON.stringify(missingTokens)}. Increase the training sample count; never build the tokenizer from evaluation labels.`);
await fs.mkdir(path.join(output, 'challenge'), { recursive: true });
const challengeRows = [];
for (const [i, prepared] of heldOut.entries()) {
  const image = `challenge/${String(i).padStart(3, '0')}.png`;
  const imageInfo = await writeImage(prepared, path.join(output, image), CANONICAL_FONT);
  if (usedPngHashes.has(imageInfo.image_sha256)) throw Error('Challenge PNG overlaps generated data');
  usedPngHashes.add(imageInfo.image_sha256);
  challengeRows.push({ id: `challenge-${i}`, image, latex: prepared.latex, category: prepared.category, split: 'challenge',
    difficulty: 'structural-holdout', token_count_with_specials: lex(prepared.latex).length + 2,
    canonical_image_sha256: prepared.canonical_sha256, effective_em_pixels: prepared.effective_em_pixels, ...imageInfo });
}
const challengeContents = challengeRows.map(row => JSON.stringify(row)).join('\n') + '\n';
await fs.writeFile(path.join(output, 'challenge.jsonl'), challengeContents);
await fs.writeFile(path.join(output, 'data-manifest.json'), JSON.stringify({
  version: 2, seed: options.seed, generator_sha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
  source: 'Find-Engine authored recursive AST grammar and labels; no pretrained model, teacher or downloaded OCR dataset',
  renderer: 'MathJax 3.2.2 + sharp 0.34.5', strict_rendering: STRICT_TEX_POLICY, splits: splitDetails,
  challenge: { count: challengeRows.length, sha256: sha256(challengeContents), status: 'New authored structural holdout, reserved before random generation; not an external blind benchmark' },
  prior_v1_challenge: { count: V1_DEVELOPMENT_LABELS.length, status: 'Previously inspected development evidence; excluded from v2 by label and canonical-image hash' },
  max_tokens_including_bos_eos: MAX_TOKENS, target_image: { width: WIDTH, height: HEIGHT, margin: MARGIN },
  training_vocabulary_coverage: { lexical_tokens: trainTokens.size, evaluation_tokens_missing_from_training: [], tokenizer_source: 'training labels only; validation/test/challenge used only for a reject-on-missing audit' },
  split_policy: 'Split-specific seeded RNG; same recursive grammar and difficulty schedule. Global canonical labels, fixed-size canonical-render pixel hashes, and actual PNG hashes are disjoint. No augmented variant crosses splits.',
  canonical_image_hash: `Tight gray<245 bounding box, fixed ${CANONICAL_FONT}px/em render, sharp lanczos3 inside ${WIDTH - 8}x${HEIGHT - 8}, centered on ${WIDTH}x${HEIGHT} white. A dedup fingerprint only; production preprocessing remains Pillow LANCZOS.`,
  source_rasterization: 'Training/validation/test PNGs use 112-144 pixels per em before model preprocessing; heldout images use 120. Both use the same renderer.',
  readability_gate: 'Effective base em >=14 pixels; estimated smallest em >=7.5 using conservative AST shrink factors. This is a heuristic, not a substitute for rendered visual QA.',
  limitations: 'Synthetic crops from one renderer. Recursive grammar increases structural variation but does not establish real-book, photographed-page, handwriting, full-page Chinese or Android accuracy. Rendered equations are OCR labels, not asserted algebraic identities.'
}, null, 2) + '\n');
console.log(`Dataset complete: ${output}`);
