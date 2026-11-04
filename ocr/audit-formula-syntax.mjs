// Read-only source-data audit. The only written file is the requested report.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStrictFormulaRenderer, STRICT_TEX_POLICY } from './strict-mathjax.mjs';

const options = { dataset: null, output: null, splits: 'train,validation,test,challenge' };
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!flag.startsWith('--') || !Object.hasOwn(options, flag.slice(2)) || process.argv[i + 1] === undefined) {
    throw Error('Usage: node ocr/audit-formula-syntax.mjs --dataset DIR --output REPORT.json [--splits train,validation,test,challenge]');
  }
  options[flag.slice(2)] = process.argv[i + 1];
}
if (!options.dataset || !options.output) throw Error('--dataset and --output are required');
const dataset = path.resolve(options.dataset), output = path.resolve(options.output);
const splits = options.splits.split(',');
if (!splits.length || new Set(splits).size !== splits.length || splits.some(name => !/^[a-z][a-z-]*$/.test(name))) throw Error('Invalid split names');
if (await fs.stat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw Error('Report exists; choose a new file');
if (splits.some(name => path.resolve(dataset, `${name}.jsonl`) === output)) throw Error('The report cannot replace a source manifest');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sources = [];
for (const split of splits) {
  const file = path.join(dataset, `${split}.jsonl`);
  const bytes = await fs.readFile(file);
  sources.push({ split, file, bytes, sha256: sha(bytes) });
}
const renderer = createStrictFormulaRenderer();
const started = Date.now(), splitResults = {}, examples = [];
let checked = 0, rejected = 0;
for (const source of sources) {
  const result = { manifest_sha256: source.sha256, checked: 0, valid: 0, rejected: 0 };
  const lines = source.bytes.toString('utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    let row;
    try {
      row = JSON.parse(lines[index]);
      renderer.render(row.latex);
      result.valid++;
    } catch (error) {
      result.rejected++; rejected++;
      if (examples.length < 100) examples.push({ split: source.split, line: index + 1, id: row?.id ?? null, latex: row?.latex ?? null, error: error.message });
    }
    result.checked++; checked++;
    if (checked % 5000 === 0) console.log(JSON.stringify({ checked, rejected, elapsed_seconds: (Date.now() - started) / 1000 }));
  }
  splitResults[source.split] = result;
}
for (const source of sources) {
  if (sha(await fs.readFile(source.file)) !== source.sha256) throw Error(`Source changed during audit: ${source.file}`);
}
const report = {
  status: rejected ? 'FAIL' : 'PASS', created_at: new Date().toISOString(), dataset,
  checked, valid: checked - rejected, rejected, splits: splitResults,
  strict_rendering: STRICT_TEX_POLICY,
  audit_source_sha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
  renderer_source_sha256: sha(await fs.readFile(new URL('./strict-mathjax.mjs', import.meta.url))),
  examples, examples_truncated: rejected > examples.length,
  elapsed_seconds: (Date.now() - started) / 1000,
  source_manifests_unchanged: true,
  scope: 'Every label parsed and rendered as SVG with noerrors/noundefined disabled. No PNG generation, model inference, weights, or source-data modification. This proves syntax acceptance, not OCR accuracy or semantic truth.',
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, checked, rejected, report: output, report_sha256: sha(await fs.readFile(output)) }));
if (rejected) process.exitCode = 2;
