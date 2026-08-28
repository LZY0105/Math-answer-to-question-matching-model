#!/usr/bin/env node
// The command-line tools: do they parse, and do they fail in the right direction?
//
// This suite exists because a released tool did not parse. `tools/ocr-cache.mjs`
// shipped with an unterminated character class and nobody noticed: the other
// suites import from src/, never from tools/, so a file that Node could not even
// read was still "covered" by a green run. Parsing is now asserted directly.
//
// The second half is about exit status. Two of these tools are release gates,
// and a gate that reports success when it did not run is worse than no gate —
// so the audit fails by default when its inputs are missing, and the cache
// builder refuses to write a cache it cannot vouch for. Those are behaviours,
// and behaviours belong in tests.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const group = (n) => console.log(`\n─── [${n}] ───`);
const check = (label, fn) => {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
};

const node = (args, env = {}) => spawnSync(process.execPath, args, {
  cwd: ROOT, encoding: 'utf-8', env: { ...process.env, ...env },
});

group('1. every shipped script parses');

// Node's --check is the cheapest possible test and the one that was missing.
const scripts = [
  ...readdirSync(join(ROOT, 'tools')).filter(f => f.endsWith('.mjs')).map(f => join('tools', f)),
  ...readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.js')).map(f => join('src', f)),
  ...readdirSync(join(ROOT, 'test')).filter(f => f.endsWith('.js')).map(f => join('test', f)),
];
assert.ok(scripts.length > 20, 'expected to find the shipped scripts');
for (const script of scripts) {
  check(`${script} parses`, () => {
    const r = node(['--check', script]);
    assert.equal(r.status, 0, (r.stderr || '').split('\n').slice(0, 3).join(' ').trim());
  });
}

group('2. the audit is a gate, not a formality');

const NOWHERE = 'tmp/does-not-exist-for-tests';
const noInputs = {
  FIND_ENGINE_EXPANDED_CORPUS: `${NOWHERE}/corpus.json`,
  FIND_ENGINE_OCR_CACHE: `${NOWHERE}/ocr.json`,
};

check('audit-ocr-matches fails when its inputs are absent', () => {
  const r = node(['tools/audit-ocr-matches.mjs'], noInputs);
  assert.equal(r.status, 1, 'a skipped audit must not report success');
  assert.match(r.stderr, /did not run/);
  assert.match(r.stderr, /corpus\.json/, 'it must say which input is missing');
});

check('audit-ocr-matches exits 0 when a skip is asked for explicitly', () => {
  const r = node(['tools/audit-ocr-matches.mjs', '--allow-skip'], noInputs);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /did not run/);
});

check('--allow-skip is not mistaken for an output path', () => {
  // The output path is positional; a flag arriving first must not become it.
  const r = node(['tools/audit-ocr-matches.mjs', '--allow-skip'], noInputs);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /--allow-skip/);
});

group('3. the cache builder refuses what it cannot vouch for');

check('ocr-cache exits 0 and explains itself when there is no PDF', () => {
  const r = node(['tools/ocr-cache.mjs'], { FIND_ENGINE_OCR_PDF: `${NOWHERE}/none.pdf` });
  assert.equal(r.status, 0, 'nothing to recognise is not a failure');
  assert.match(r.stdout, /nothing to recognise/);
});

check('ocr-cache refuses a file whose page count it cannot establish', () => {
  // A gate on the page count is the difference between a complete cache and a
  // truncated one that looks complete. Without a readable count there is
  // nothing to check the run against, so the run does not start.
  const dir = mkdtempSync(join(tmpdir(), 'find-engine-'));
  try {
    const junk = join(dir, 'not-really.pdf');
    writeFileSync(junk, 'this is not a PDF');
    const r = node(['tools/ocr-cache.mjs'], {
      FIND_ENGINE_OCR_PDF: junk,
      FIND_ENGINE_OCR_CACHE: join(dir, 'out.json'),
      FIND_ENGINE_OCR_PAGES: '',
    });
    assert.equal(r.status, 1, 'an unknown page count must stop the run');
    assert.match(r.stderr, /REJECTED/);
    assert.match(r.stderr, /page count/);
    assert.equal(readdirSync(dir).includes('out.json'), false, 'no cache may be written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('ocr-cache rejects a page count that is not a positive integer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'find-engine-'));
  try {
    const junk = join(dir, 'not-really.pdf');
    writeFileSync(junk, 'this is not a PDF');
    const r = node(['tools/ocr-cache.mjs'], {
      FIND_ENGINE_OCR_PDF: junk,
      FIND_ENGINE_OCR_CACHE: join(dir, 'out.json'),
      FIND_ENGINE_OCR_PAGES: '0',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REJECTED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(FAIL > 0 ? 1 : 0);
