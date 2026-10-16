// Validate TeX labels against the same fail-closed renderer the training data
// generators use. Reads a jsonl manifest, writes one verdict per line.
//
//   node ocr/validate-labels.mjs <manifest.jsonl> <verdicts.jsonl> [--limit N]
//
// A label that the strict renderer rejects is not a formula the training set
// should teach: it either names a command that does not exist (a recogniser
// that dropped the space in "\exists x" emits "\existsx") or it is unbalanced.

import fs from 'node:fs';
import readline from 'node:readline';

import { createStrictFormulaRenderer } from './strict-mathjax.mjs';

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: validate-labels.mjs <manifest.jsonl> <verdicts.jsonl> [--limit N]');
const limitAt = rest.indexOf('--limit');
const limit = limitAt >= 0 ? Number(rest[limitAt + 1]) : Infinity;

const renderer = createStrictFormulaRenderer();
const sink = fs.createWriteStream(output, { encoding: 'utf8' });
const lines = readline.createInterface({ input: fs.createReadStream(input, { encoding: 'utf8' }), crlfDelay: Infinity });

let total = 0;
let failed = 0;
const reasons = new Map();
for await (const line of lines) {
  if (!line.trim()) continue;
  if (total >= limit) break;
  const record = JSON.parse(line);
  total += 1;
  let ok = true;
  let reason = '';
  try {
    renderer.render(record.latex);
  } catch (error) {
    ok = false;
    failed += 1;
    // Keep the MathJax message only, without the echoed formula.
    reason = String(error?.cause?.message ?? error.message).split('\n')[0].slice(0, 120);
    const bucket = reason.replace(/\\[A-Za-z]+/g, '\\CMD').replace(/'[^']*'/g, "'…'");
    reasons.set(bucket, (reasons.get(bucket) ?? 0) + 1);
  }
  sink.write(`${JSON.stringify({ id: record.id, ok, reason })}\n`);
  if (total % 50000 === 0) process.stderr.write(`${JSON.stringify({ checked: total, failed })}\n`);
}
sink.end();
await new Promise(resolve => sink.on('finish', resolve));

const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
process.stdout.write(`${JSON.stringify({ checked: total, failed, rate: failed / Math.max(1, total), top_reasons: Object.fromEntries(top) })}\n`);
