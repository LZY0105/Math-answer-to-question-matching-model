#!/usr/bin/env node
// Extracts downloaded books into the JSON documents the held-out suite reads.
//
// tools/extract-corpus.mjs builds the 考研 corpus through the host app's own
// pdf.js layer, which is the right thing for the numbers the app is judged on
// and unavailable on a machine without that checkout. This tool exists for the
// 2026-09 textbook release: it reads through the demo's PDF.js adapter, which is
// already a development dependency, and writes one JSON per book —
// { numPages, outline, lines } — the shape every corpus suite consumes.
//
// The output is extracted text from copyrighted books and is never committed;
// it goes beside the repository by default.
//
// Usage:
//   node tools/extract-books.mjs --books ../find-engine-books [--out DIR] [--force] [KEY=FILE ...]
//
//   --books  where datasets/books-20260924/download.mjs put the PDFs
//   --out    where to write the JSON (default: <books>/extracted)
//   --force  re-extract books whose JSON already exists
//   KEY=FILE extract one file under a chosen key; with none given, every PDF in
//            --books is extracted under its manifest id (book-NNN)
//
// Extraction is the slow half of an evaluation — a 490-page text-layer book is
// ~14 s here — so the JSON is written once and the suite reruns in seconds.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openPdfDocument } from '../demo/pdfjs-document-adapter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MANIFEST = join(REPO, 'datasets', 'books-20260924', 'manifest.json');

function parseArgs(argv) {
  const opts = { books: resolve(REPO, '..', 'find-engine-books'), out: null, force: false, picks: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--books') opts.books = resolve(argv[++i]);
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '--force') opts.force = true;
    else if (a.includes('=')) {
      const at = a.indexOf('=');
      opts.picks.push({ key: a.slice(0, at), file: resolve(a.slice(at + 1)) });
    } else throw new Error(`unrecognised argument: ${a}`);
  }
  if (!opts.out) opts.out = join(opts.books, 'extracted');
  return opts;
}

/** Every PDF in the books directory, keyed by manifest id where the name is known. */
function discover(booksDir) {
  const byName = new Map();
  if (existsSync(MANIFEST)) {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
    for (const f of manifest.files ?? []) if (f.kind === 'pdf') byName.set(f.originalName, f.id);
  }
  const out = [];
  for (const name of readdirSync(booksDir)) {
    if (!name.toLowerCase().endsWith('.pdf')) continue;
    out.push({ key: byName.get(name) ?? basename(name, '.pdf'), file: join(booksDir, name) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export async function extractBook(file) {
  const doc = await openPdfDocument(file, { includeGeometry: false });
  try {
    const lines = await doc.extractText({});
    return { numPages: doc.numPages, outline: doc.outline, lines, source: basename(file) };
  } finally {
    await doc.destroy();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = opts.picks.length ? opts.picks : discover(opts.books);
  if (targets.length === 0) {
    console.error(`no PDFs under ${opts.books}; run datasets/books-20260924/download.mjs first`);
    process.exit(1);
  }
  mkdirSync(opts.out, { recursive: true });
  for (const { key, file } of targets) {
    const dest = join(opts.out, `${key}.json`);
    if (existsSync(dest) && !opts.force) { console.log(`skip\t${key}\t(exists)`); continue; }
    const t0 = performance.now();
    const doc = await extractBook(file);
    writeFileSync(dest, JSON.stringify(doc));
    console.log(`ok\t${key}\tpages=${doc.numPages}\tlines=${doc.lines.length}\t${(performance.now() - t0).toFixed(0)} ms`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
