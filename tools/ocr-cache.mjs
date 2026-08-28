#!/usr/bin/env node
// Builds the OCR cache the audit needs, from the scanned PDF — and refuses to
// write one it cannot vouch for.
//
// Separated from the audit so the expensive step runs once and is reused. The
// PDF must sit at an ASCII path: the poppler build used here cannot open one
// containing Han characters.
//
//   cp "<2025 exercise PDF>" tmp/ocr/q2025.pdf
//   node tools/ocr-cache.mjs
//
// A cache is the input to every number the audit reports, so a silently partial
// one would understate coverage and nothing downstream could tell. The run
// therefore fails closed: unless every expected page came back with text and
// the recognizer reported no failures, no file is written and the exit status
// is non-zero. `--allow-incomplete` keeps the file but stamps `complete: false`
// on it, and the audit refuses to treat such a cache as authoritative.
//
// The written artifact carries its own provenance — the PDF's hash, the page
// count as the PDF itself reports it, recognizer settings and statistics, and
// the commit that produced it — because a cache of extracted text is otherwise
// indistinguishable from a cache of some other book.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createWindowsOcrRecognizer } from './windows-ocr.mjs';

const PDF = process.env.FIND_ENGINE_OCR_PDF || 'tmp/ocr/q2025.pdf';
const OUT = process.env.FIND_ENGINE_OCR_CACHE || 'tmp/ocr/q2025-ocr-lines.json';
const DPI = Number(process.env.FIND_ENGINE_OCR_DPI || 200);
const LANGUAGE = process.env.FIND_ENGINE_OCR_LANGUAGE || 'zh-Hans-CN';
const ALLOW_INCOMPLETE = process.argv.includes('--allow-incomplete');

// Calibrated against the 2025 scanned volume: 465 of 465 pages returned text,
// zero recognizer failures, 6 to 694 characters per page with a median of 141.
// The floor sits far below the observed median so that it catches a run that
// recognised essentially nothing, not one that met a sparse book.
const MIN_MEDIAN_CHARS_PER_PAGE = 40;
const THIN_PAGE_CHARS = 20;

const fail = (...why) => {
  console.error('\nOCR cache REJECTED — not written.');
  for (const line of why) console.error(`  ${line}`);
  console.error('\nRe-run after fixing, or pass --allow-incomplete to keep a cache');
  console.error('marked incomplete (the audit will refuse to treat it as authoritative).');
  process.exit(1);
};

if (!existsSync(PDF)) {
  console.log(`no PDF at ${PDF} — nothing to recognise.`);
  console.log('Copy the scanned exercise book there first; the path must be ASCII.');
  process.exit(0);
}

// The PDF is the authority on how many pages it has. Trusting an environment
// variable here is how a truncated run passes for a complete one.
const pageCount = () => {
  const override = process.env.FIND_ENGINE_OCR_PAGES;
  try {
    const info = execFileSync('pdfinfo', [PDF], { encoding: 'utf-8' });
    const m = /^Pages:\s+(\d+)$/m.exec(info);
    if (m) return { pages: Number(m[1]), source: 'pdfinfo' };
  } catch {
    // pdfinfo missing or unhappy; fall through to the override.
  }
  if (override) return { pages: Number(override), source: 'FIND_ENGINE_OCR_PAGES' };
  return { pages: NaN, source: 'unknown' };
};

const { pages: PAGES, source: pagesFrom } = pageCount();
if (!Number.isInteger(PAGES) || PAGES <= 0) {
  fail(
    `could not establish a page count for ${PDF} (got ${PAGES} from ${pagesFrom}).`,
    'Install poppler so pdfinfo is on PATH, or set FIND_ENGINE_OCR_PAGES.',
  );
}

const stat = statSync(PDF);
const sha256 = createHash('sha256').update(readFileSync(PDF)).digest('hex');
const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
})();

console.log(`${PDF}`);
console.log(`  ${PAGES} pages (per ${pagesFrom}), ${stat.size} bytes, sha256 ${sha256.slice(0, 16)}…`);
console.log(`  recognising at ${DPI} dpi, ${LANGUAGE}`);

const recognise = createWindowsOcrRecognizer({ pdfPath: PDF, dpi: DPI, language: LANGUAGE });
const lines = [];
const charsByPage = new Map();
for (let page = 1; page <= PAGES; page++) {
  const text = await recognise(page);
  let chars = 0;
  for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    lines.push({ page, text: line });
    chars += line.length;
  }
  charsByPage.set(page, chars);
  if (page % 50 === 0) process.stdout.write(`  ${page}…`);
}
process.stdout.write('\n');

const emptyPages = [];
const thinPages = [];
for (let page = 1; page <= PAGES; page++) {
  const chars = charsByPage.get(page) ?? 0;
  if (chars === 0) emptyPages.push(page);
  else if (chars < THIN_PAGE_CHARS) thinPages.push(page);
}
const sorted = [...charsByPage.values()].sort((a, b) => a - b);
const medianChars = sorted.length ? sorted[sorted.length >> 1] : 0;
const pageCoverage = PAGES ? Number(((PAGES - emptyPages.length) / PAGES).toFixed(4)) : 0;

const show = (list) => (list.length > 12 ? `${list.slice(0, 12).join(', ')}, …` : list.join(', '));
console.log(`${lines.length} lines, ${PAGES - emptyPages.length}/${PAGES} pages with text `
  + `(${(pageCoverage * 100).toFixed(1)}%), median ${medianChars} chars/page`);
if (thinPages.length > 0) {
  console.log(`  ${thinPages.length} page(s) under ${THIN_PAGE_CHARS} chars: ${show(thinPages)}`);
}
console.log(`  recognizer: ${JSON.stringify(recognise.stats)}`);

const problems = [];
if (recognise.stats.failures > 0) {
  problems.push(`${recognise.stats.failures} page(s) failed to render or recognise.`);
}
if (emptyPages.length > 0) {
  problems.push(`${emptyPages.length} page(s) produced no text: ${show(emptyPages)}`);
}
if (lines.length === 0) problems.push('the recognizer returned nothing at all.');
if (medianChars < MIN_MEDIAN_CHARS_PER_PAGE) {
  problems.push(`median ${medianChars} chars/page is below the ${MIN_MEDIAN_CHARS_PER_PAGE} floor `
    + '— this reads as a failed run rather than a sparse book.');
}
if (problems.length > 0 && !ALLOW_INCOMPLETE) fail(...problems);
if (problems.length > 0) {
  console.log('\nproceeding under --allow-incomplete; the cache is marked incomplete:');
  for (const p of problems) console.log(`  ${p}`);
}

const artifact = {
  meta: {
    generatedAt: new Date().toISOString(),
    generator: 'tools/ocr-cache.mjs',
    commit,
    complete: problems.length === 0,
    problems,
    source: {
      path: PDF,
      bytes: stat.size,
      sha256,
      pages: PAGES,
      pagesFrom,
    },
    recognizer: {
      engine: 'Windows.Media.Ocr',
      language: LANGUAGE,
      dpi: DPI,
      ...recognise.stats,
    },
    coverage: {
      pagesWithText: PAGES - emptyPages.length,
      pageCoverage,
      medianCharsPerPage: medianChars,
      emptyPages,
      thinPages,
      lines: lines.length,
    },
  },
  lines,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(artifact));
console.log(`\ncache -> ${OUT}  (complete: ${artifact.meta.complete})`);
