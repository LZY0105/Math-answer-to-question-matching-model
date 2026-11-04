// Training-only symbol coverage, authored independently of evaluation labels.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createStrictFormulaRenderer, STRICT_TEX_POLICY } from './strict-mathjax.mjs';

if (process.argv.length !== 4 || process.argv[2] !== '--output') throw Error('Usage: node ocr/generate-symbol-data.mjs --output DIRECTORY');
const output = path.resolve(process.argv[3]);
if (await fs.stat(output).catch(() => null)) throw Error('Output exists; choose a new directory');
await fs.mkdir(path.join(output, 'images'), { recursive: true });
const renderer = createStrictFormulaRenderer();
const latin = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const greek = ('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa varkappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega').split(' ').map(x => `\\${x}`);
const styled = ['R', 'N', 'Z', 'Q', 'C', 'F'].map(x => `\\mathbb{${x}}`).concat(['A', 'B', 'D', 'F'].map(x => `\\mathcal{${x}}`));
const labels = new Set();
for (const symbol of [...latin, ...greek, ...styled]) {
  labels.add(`${symbol}+x`);
  labels.add(`${symbol}^{2}`);
  labels.add(`\\frac{${symbol}}{x+1}`);
  labels.add(`${symbol}_{n+1}=${symbol}_{n}+1`);
}
for (const operator of ['+', '-', '=', '<', '>', '\\pm', '\\mp', '\\cdot', '\\times', '\\div', '\\leq', '\\geq', '\\neq', '\\approx', '\\sim', '\\equiv', '\\to', '\\mapsto', '\\in', '\\notin', '\\subset', '\\subseteq', '\\cup', '\\cap']) {
  // A control word consumes following letters: \\leqy is not \\leq followed by y.
  labels.add(`x${operator}${operator.startsWith('\\') ? ' ' : ''}y`);
}
for (const command of ['\\sin', '\\cos', '\\tan', '\\arcsin', '\\arccos', '\\arctan', '\\ln', '\\log', '\\exp', '\\sinh', '\\cosh']) {
  labels.add(`${command} x`); labels.add(`${command}\\left(x+1\\right)`);
}
for (const command of ['\\int', '\\iint', '\\iiint', '\\oint']) {
  labels.add(`${command}_{D}x\\,dx`); labels.add(`${command}_{0}^{1}x^{2}\\,dx`);
}
for (const value of ['x,y', 'x;y', 'x:y', 'x.', '|x+y|', '\\left[x+y\\right]', '\\left\\{x,y\\right\\}', '\\forall x', '\\exists x', '\\emptyset', '\\infty', '\\nabla f', '\\frac{\\partial f}{\\partial x}', 'f^{\\prime}\\left(x\\right)', 'f^{\\prime\\prime}\\left(x\\right)', 'f_{+}^{\\prime}\\left(x\\right)', 'A^{\\mathrm{T}}A']) labels.add(value);
const rows = [];
for (const latex of labels) for (const em of [64, 112, 144]) {
  let svg = renderer.render(latex);
  const box = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  svg = svg.replace(/width="[^"]+"/, `width="${Math.ceil(box[2] * em / 1000)}"`).replace(/height="[^"]+"/, `height="${Math.ceil(box[3] * em / 1000)}"`);
  const id = `symbols-${String(rows.length).padStart(5, '0')}`, image = `images/${id}.png`;
  await sharp(Buffer.from(svg)).flatten({ background: 'white' }).extend({ top: 6, bottom: 6, left: 6, right: 6, background: 'white' }).greyscale().png().toFile(path.join(output, image));
  rows.push({ id, image, latex, split: 'train', category: 'symbol-coverage', source_kind: 'authored-symbol-coverage', render_em: em });
}
const content = rows.map(x => JSON.stringify(x)).join('\n') + '\n';
await fs.writeFile(path.join(output, 'train.jsonl'), content);
await fs.writeFile(path.join(output, 'data-manifest.json'), JSON.stringify({ samples: rows.length, unique_labels: labels.size, source: 'Authored Latin/Greek/operator/notation coverage; training only; no evaluation labels or external OCR model', strict_rendering: STRICT_TEX_POLICY, manifest_sha256: crypto.createHash('sha256').update(content).digest('hex') }, null, 2));
console.log(JSON.stringify({ samples: rows.length, unique_labels: labels.size, output }));
