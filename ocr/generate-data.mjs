// Formula grammar authored for Find-Engine; no downloaded dataset/model/labels.
// MathJax and sharp render labels to pixels; they do not perform recognition.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import sharp from 'sharp';

function option(name, fallback) { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; }
const output = path.resolve(option('output', 'tmp/formula-scratch-data'));
const counts = { train: Number(option('train', 18000)), validation: Number(option('validation', 900)), test: Number(option('test', 900)) };
const seed = Number(option('seed', 9142026));
if (!Number.isInteger(seed) || Object.values(counts).some(n => !Number.isInteger(n) || n < 1)) throw Error('Positive integer split sizes and integer seed required');
let state = seed >>> 0;
function random() { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }
const pick = xs => xs[Math.floor(random() * xs.length)];
const integer = (lo = 1, hi = 19) => lo + Math.floor(random() * (hi - lo + 1));
const variable = () => pick(['x', 'y', 'z', 'a', 'b', 'c', 't', 'u', 'v']);
const atom = () => pick([variable(), `${integer()}`, `${variable()}^{${integer(2, 6)}}`, `${variable()}_{${pick(['i', 'j', 'k', 'n', '0', '1', '2'])}}`]);
const sum = () => `${atom()}${pick(['+', '-'])}${atom()}`;
const fraction = () => String.raw`\frac{${sum()}}{${sum()}}`;
const polynomial = () => { const v = variable(); return `${integer()}${v}^{${integer(2, 5)}}${pick(['+', '-'])}${integer()}${v}${pick(['+', '-'])}${integer()}`; };
const functionExpr = v => pick([`${v}^{${integer(2, 6)}}`, String.raw`\sin ${v}`, String.raw`\cos ${v}`, `e^{${integer(1, 4)}${v}}`, String.raw`\ln ${v}`, `${integer()}${v}+${integer()}`]);

const families = [
  ['polynomial', () => `${polynomial()}=${integer(0, 25)}`],
  ['plus-minus', () => `${polynomial()}\\pm${fraction()}`],
  ['fraction', () => `${pick(['y=', 'z=', '', ''])}${fraction()}`],
  ['fraction', () => String.raw`\frac{${polynomial()}}{${sum()}}`],
  ['power-subscript', () => `${variable()}_{${pick(['n', 'i', 'j', 'k'])}+${integer()}}^{${integer(2, 8)}}=${sum()}`],
  ['power-subscript', () => `${variable()}^{${sum()}}+${variable()}_{${integer(1, 50)}}`],
  ['root', () => String.raw`\sqrt{${polynomial()}}`],
  ['root-index', () => String.raw`\sqrt[${integer(3, 5)}]{${sum()}}`],
  ['nested-fraction', () => String.raw`\frac{${integer()}}{${integer()}+${fraction()}}`],
  ['integral', () => { const v = variable(); return String.raw`\int_{${integer(0, 6)}}^{${integer(7, 15)}}${functionExpr(v)}\,d${v}`; }],
  ['integral', () => { const v = variable(); return String.raw`\int ${functionExpr(v)}\,d${v}=${fraction()}+C`; }],
  ['sum', () => String.raw`\sum_{${pick(['k', 'i', 'j'])}=${integer(0, 3)}}^{${pick(['n', `${integer(6, 25)}`])}}${pick([fraction(), polynomial()])}`],
  ['matrix-2', () => String.raw`${pick(['A', 'B', 'M'])}=\begin{pmatrix}${atom()}&${atom()}\\${atom()}&${atom()}\end{pmatrix}`],
  ['matrix-2', () => String.raw`\begin{bmatrix}${integer(-9, 9)}&${integer(-9, 9)}\\${integer(-9, 9)}&${integer(-9, 9)}\end{bmatrix}`],
  ['matrix-3', () => String.raw`\begin{pmatrix}${integer(0, 9)}&${integer(0, 9)}&${integer(0, 9)}\\${integer(0, 9)}&${integer(0, 9)}&${integer(0, 9)}\\${integer(0, 9)}&${integer(0, 9)}&${integer(0, 9)}\end{pmatrix}`],
  ['determinant', () => String.raw`\begin{vmatrix}${atom()}&${atom()}\\${atom()}&${atom()}\end{vmatrix}=${integer(-30, 30)}`],
  ['limit', () => String.raw`\lim_{${variable()}\to${pick(['0', '1', '\\infty'])}}${fraction()}`],
  ['derivative', () => { const v = variable(); return String.raw`\frac{d}{d${v}}(${functionExpr(v)})`; }],
  ['partial', () => String.raw`\frac{\partial^{${integer(2, 8)}}${variable()}_{${integer(1, 99)}}}{\partial ${variable()}\partial ${variable()}}`],
  ['trigonometry', () => `${pick(['\\sin', '\\cos', '\\tan'])}(${sum()})=${atom()}`],
  ['greek', () => `${pick(['\\alpha', '\\beta', '\\gamma', '\\theta', '\\lambda', '\\mu', '\\sigma', '\\pi'])}^{${integer(2, 6)}}${pick(['+', '-'])}${fraction()}`],
  ['inequality', () => `${sum()}${pick(['\\leq', '\\geq', '<', '>'])} ${fraction()}`],
  ['cases', () => String.raw`f(x)=\begin{cases}${polynomial()}&x\geq ${integer(0, 4)}\\${sum()}&x<${integer(0, 4)}\end{cases}`],
  ['system', () => String.raw`\begin{aligned}${integer(1, 8)}x+${integer(1, 8)}y&=${integer(1, 30)}\\${integer(1, 8)}x-${integer(1, 8)}y&=${integer(1, 30)}\end{aligned}`],
  ['product', () => String.raw`\prod_{k=${integer(1, 4)}}^{${pick(['n', `${integer(5, 20)}`])}}(${sum()})`],
];

// Fully held out examples; no reuse during training/model selection.
const challenge = [
  ['fraction', String.raw`y=\frac{x+1}{x-1}`],
  ['quadratic', String.raw`x=\frac{-b\pm\sqrt{b^{2}-4ac}}{2a}`],
  ['nested-fraction', String.raw`\frac{1}{1+\frac{1}{x}}`],
  ['integral', String.raw`\int_{0}^{1}x^{2}\,dx=\frac{1}{3}`],
  ['sum', String.raw`\sum_{k=1}^{n}k=\frac{n(n+1)}{2}`],
  ['limit', String.raw`\lim_{x\to0}\frac{\sin x}{x}=1`],
  ['matrix-2', String.raw`A=\begin{pmatrix}1&2\\3&4\end{pmatrix}`],
  ['matrix-3', String.raw`\begin{pmatrix}1&0&0\\0&1&0\\0&0&1\end{pmatrix}`],
  ['determinant', String.raw`\begin{vmatrix}a&b\\c&d\end{vmatrix}=ad-bc`],
  ['root', String.raw`\sqrt{x^{2}+y^{2}}`],
  ['power-subscript', String.raw`a_{n+1}=a_{n}+2`],
  ['trigonometry', String.raw`\sin^{2}\theta+\cos^{2}\theta=1`],
];
const adaptor = liteAdaptor(); RegisterHTMLHandler(adaptor);
const document = mathjax.document('', { InputJax: new TeX({ packages: AllPackages }), OutputJax: new SVG({ fontCache: 'none' }) });
const used = new Set(challenge.map(([, s]) => s.replace(/\s+/g, '')));
await fs.mkdir(output, { recursive: true });
if (await fs.stat(path.join(output, 'data-manifest.json')).catch(() => null)) throw Error('Output already contains a completed dataset; choose a new directory');

async function render(latex, destination, size) {
  const node = document.convert(latex, { display: true });
  let svg = adaptor.outerHTML(adaptor.firstChild(node));
  if (!svg.startsWith('<svg') || svg.includes('data-mjx-error')) throw Error(`TeX render failed: ${latex}`);
  const box = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const scale = size / 1000;
  const width = Math.max(1, Math.ceil(box[2] * scale));
  const height = Math.max(1, Math.ceil(box[3] * scale));
  if (width > 1800 || height > 800) throw Error('Formula outside supported crop size');
  svg = svg.replace(/width="[^"]+"/, `width="${width}"`).replace(/height="[^"]+"/, `height="${height}"`);
  await sharp(Buffer.from(svg)).flatten({ background: 'white' }).extend({ top: 6, bottom: 6, left: 6, right: 6, background: 'white' }).greyscale().png().toFile(destination);
}
const summary = {};
for (const [split, count] of Object.entries(counts)) {
  await fs.mkdir(path.join(output, split), { recursive: true });
  const rows = [];
  let attempts = 0;
  while (rows.length < count) {
    if (++attempts > count * 20) throw Error('Cannot generate requested unique dataset');
    const [category, generate] = families[rows.length % families.length];
    const latex = generate();
    const key = latex.replace(/\s+/g, '');
    if (used.has(key)) continue;
    const id = `${split}-${String(rows.length).padStart(6, '0')}`;
    const image = `${split}/${id}.png`;
    await render(latex, path.join(output, image), integer(25, 43));
    used.add(key);
    rows.push({ id, image, latex, category, split });
    if (rows.length % 1000 === 0) console.log(`${split}: ${rows.length}/${count}`);
  }
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await fs.writeFile(path.join(output, `${split}.jsonl`), text);
  summary[split] = { count, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}
await fs.mkdir(path.join(output, 'challenge'), { recursive: true });
const challengeRows = [];
for (const [index, [category, latex]] of challenge.entries()) {
  const image = `challenge/${index}.png`;
  await render(latex, path.join(output, image), 35);
  challengeRows.push({ id: `challenge-${index}`, image, latex, category, split: 'challenge' });
}
await fs.writeFile(path.join(output, 'challenge.jsonl'), challengeRows.map(row => JSON.stringify(row)).join('\n') + '\n');
await fs.writeFile(path.join(output, 'data-manifest.json'), JSON.stringify({
  version: 1, seed, source: 'Find-Engine generated grammar, no pretrained models or downloaded OCR datasets',
  renderer: 'MathJax 3.2.2 + sharp 0.34.5', splits: summary, challenge: challengeRows.length,
  splitPolicy: 'Canonical labels unique across all splits. Test/challenge excluded from training and checkpoint selection.',
  limitations: 'Synthetic cropped formulas only. Same renderer across splits. Does not establish real-book, photographed-page, handwriting, or Android accuracy.'
}, null, 2));
console.log(`Dataset complete: ${output}`);
