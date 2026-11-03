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
//   --geometry  keep each line's vertical position (y, height) in page points
//   --split FILE --map FILE  read lines from a split made by ocr/clip_windows.py,
//            keeping only what each page's clip actually prints (one KEY=FILE)
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
  const opts = { books: resolve(REPO, '..', 'find-engine-books'), out: null, force: false, geometry: false, split: null, map: null, picks: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--books') opts.books = resolve(argv[++i]);
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '--force') opts.force = true;
    else if (a === '--geometry') opts.geometry = true;
    else if (a === '--split') opts.split = resolve(argv[++i]);
    else if (a === '--map') opts.map = resolve(argv[++i]);
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

export async function extractBook(file, { geometry = false, split = null, map = null } = {}) {
  const doc = await openPdfDocument(file, { includeGeometry: geometry });
  try {
    const lines = split ? await printedLines(split, map, geometry) : await doc.extractText({});
    return { numPages: doc.numPages, outline: doc.outline, lines, source: basename(file) };
  } finally {
    await doc.destroy();
  }
}

/**
 * The lines actually printed, read from the split ocr/clip_windows.py writes.
 *
 * A copy drawing one clipped form contributes only the lines inside its
 * window; a native copy, and a page that clips nothing, contributes all of
 * its lines. Lines come back on their original pages, top to bottom.
 */
async function printedLines(splitFile, mapFile, geometry) {
  const copies = JSON.parse(readFileSync(mapFile, 'utf-8')).copies;
  const split = await openPdfDocument(splitFile, { includeGeometry: true });
  try {
    const out = [];
    for (let i = 0; i < copies.length; i++) {
      const copy = copies[i];
      for (const line of await split.extractText({ from: i + 1, to: i + 1 })) {
        if (copy.window) {
          const [, top, , bottom] = copy.window;
          const centre = Number.isFinite(line.height) ? line.y - line.height / 2 : line.y;
          if (!(centre >= top - 1 && centre <= bottom + 1)) continue;
        }
        const placed = { ...line, page: copy.page };
        if (!geometry) { delete placed.y; delete placed.height; }
        out.push(placed);
      }
    }
    return out
      .map((line, order) => ({ line, order }))
      .sort((a, b) => (a.line.page - b.line.page)
        || ((Number.isFinite(a.line.y) && Number.isFinite(b.line.y)) ? a.line.y - b.line.y : a.order - b.order))
      .map(({ line }) => line);
  } finally {
    await split.destroy();
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
    const doc = await extractBook(file, { geometry: opts.geometry, split: opts.split, map: opts.map });
    writeFileSync(dest, JSON.stringify(doc));
    console.log(`ok\t${key}\tpages=${doc.numPages}\tlines=${doc.lines.length}\t${(performance.now() - t0).toFixed(0)} ms`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
