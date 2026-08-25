#!/usr/bin/env node
// Builds the real-PDF test corpus.
//
// The corpus has to be what the APP feeds the engine, not a second
// interpretation of the same PDFs. Line grouping in particular is a judgement
// call — fragments are bucketed into rows by baseline within a tolerance — and
// a corpus built with different buckets would test the engine against input it
// never actually receives.
//
// So this does not reimplement extraction. It shims the browser global that
// pdf-document.js expects and then calls that file, unchanged, exactly as the
// app does. The tolerance, the row sorting, the destination resolution and the
// "never invent an outline" rule all come from the app's own code.
//
// Usage:
//   node tools/extract-corpus.mjs --out <corpus.json> <key>=<file.pdf> ...
//   node tools/extract-corpus.mjs --out data.json --app <path> q2025=book.pdf
//
//   --out    where to write (default: ../find-engine-corpus/data.json)
//   --app    LaTeXSnipper_mobile checkout, for pdf.js and pdf-document.js
//            (or set FIND_ENGINE_APP; defaults to a sibling directory)
//   --merge  keep existing keys in the output file and add to them (default)
//   --fresh  discard whatever is already in the output file
//
// The output is not committed anywhere: it is extracted text from copyrighted
// textbooks. See test/test_real_pdfs.js.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const DEFAULTS = {
  out: resolve(REPO, '..', 'find-engine-corpus', 'data.json'),
  // Where the host app is checked out, for its pdf.js and its pdf-document.js.
  // Set FIND_ENGINE_APP, or pass --app. The default assumes the app sits beside
  // this repo; there is deliberately no absolute path here.
  app: process.env.FIND_ENGINE_APP || resolve(REPO, '..', 'LaTeXSnipper_mobile'),
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS, merge: true, docs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '--app') opts.app = resolve(argv[++i]);
    else if (a === '--fresh') opts.merge = false;
    else if (a === '--merge') opts.merge = true;
    else if (a.includes('=')) {
      const at = a.indexOf('=');
      opts.docs.push({ key: a.slice(0, at), file: resolve(a.slice(at + 1)) });
    } else {
      throw new Error(`unrecognised argument: ${a}`);
    }
  }
  return opts;
}

/**
 * Makes the app's browser-only pdf.js layer work under Node.
 *
 * pdf-document.js reads `window.pdfjsLib` and its header is explicit that this
 * must not become an npm import. Rather than fork it, the global it wants is
 * provided here from the copy already installed in the app.
 */
async function installPdfRuntime(appPath) {
  const build = join(appPath, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs');
  if (!existsSync(build)) {
    throw new Error(
      `pdfjs-dist not found under ${appPath}.\n`
      + '  Pass --app <path to LaTeXSnipper_mobile>, and run npm install there first.',
    );
  }
  const pdfjs = await import(pathToFileURL(build).href);

  // pdf.js insists on a worker entry point even when it will run the fake
  // worker in-process, so point it at the legacy worker beside the build.
  // The DOMMatrix/Path2D warnings it prints are about RENDERING, which this
  // never does — text and outline extraction do not touch a canvas.
  const worker = join(appPath, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(worker).href;

  const fonts = join(appPath, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';
  const cmaps = join(appPath, 'node_modules', 'pdfjs-dist', 'cmaps') + '/';

  const getDocument = (args) => pdfjs.getDocument({
    ...args,
    // Without these, pdf.js cannot decode CID-keyed CJK fonts and the text comes
    // out as codepoints from unrelated scripts — which is exactly how the corpus
    // was first built, and how a whole false diagnosis followed. The app sets the
    // same three in pdf-document.js; keep them in step.
    cMapUrl: cmaps,
    cMapPacked: true,
    standardFontDataUrl: fonts,
    useSystemFonts: false,
    isEvalSupported: false,
    useWorkerFetch: false,
    verbosity: 0,
  });

  globalThis.window = { pdfjsLib: { ...pdfjs, getDocument } };
  return pdfjs;
}

/** Everything the engine's document interface needs, as plain JSON. */
async function extractOne(openPdfDocument, file, onPage) {
  const bytes = new Uint8Array(readFileSync(file));
  const doc = await openPdfDocument(bytes);

  const lines = [];
  for (let page = 1; page <= doc.numPages; page++) {
    const { lines: pageLines } = await doc.pageText(page);
    for (const text of pageLines) lines.push({ page, text });
    onPage?.(page, doc.numPages);
  }

  const record = {
    // File NAME only, so an entry can still be traced back to its book. The
    // corpus moves between machines and has no business carrying someone's
    // home directory.
    path: basename(file),
    numPages: doc.numPages,
    lines,
    outline: doc.outline,
  };
  try { doc.destroy(); } catch { /* already gone */ }
  return record;
}

/** A quick read on what was extracted, so a bad run is obvious immediately. */
function summarise(key, record) {
  const flat = [];
  const walk = (items) => { for (const i of items || []) { flat.push(i); walk(i.children); } };
  walk(record.outline?.items);

  let chars = 0;
  let han = 0;
  for (const l of record.lines) {
    for (const ch of l.text) {
      chars++;
      if (/[\u3400-\u4DBF\u4E00-\u9FFF]/.test(ch)) han++;
    }
  }
  const examples = flat.filter(i => /例\s*题/.test(i.title || '')).length;
  const unresolved = flat.filter(i => i.pageNumber == null).length;

  return {
    key,
    pages: record.numPages,
    lines: record.lines.length,
    chars,
    hanPct: chars ? Number((100 * han / chars).toFixed(2)) : 0,
    outline: record.outline?.available ? flat.length : 0,
    examples,
    unresolved,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.docs.length === 0) {
    console.error('nothing to extract. usage:\n'
      + '  node tools/extract-corpus.mjs [--out FILE] [--app DIR] key=file.pdf ...');
    process.exit(2);
  }

  await installPdfRuntime(opts.app);
  // Imported AFTER the shim, because it reads window.pdfjsLib at call time but
  // the module itself should not be evaluated against a missing global.
  const docModule = join(opts.app, 'src', 'pdf', 'pdf-document.js');
  const { openPdfDocument } = await import(pathToFileURL(docModule).href);

  let corpus = {};
  if (opts.merge && existsSync(opts.out)) {
    corpus = JSON.parse(readFileSync(opts.out, 'utf-8'));
    console.log(`merging into ${opts.out} (${Object.keys(corpus).length} existing)`);
  }

  const rows = [];
  for (const { key, file } of opts.docs) {
    if (!existsSync(file)) {
      console.error(`  SKIP ${key}: not found — ${file}`);
      continue;
    }
    process.stdout.write(`  ${key}: ${basename(file)} `);
    const started = Date.now();
    let last = 0;
    const record = await extractOne(openPdfDocument, file, (page, total) => {
      const pct = Math.floor((100 * page) / total);
      if (pct >= last + 20) { process.stdout.write('.'); last = pct; }
    });
    corpus[key] = record;
    const row = summarise(key, record);
    rows.push(row);
    console.log(` ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(corpus));

  console.log('\nkey          pages   lines    chars   Han%  outline  例题  unresolved');
  for (const r of rows) {
    console.log(
      r.key.padEnd(12)
      + String(r.pages).padStart(5)
      + String(r.lines).padStart(8)
      + String(r.chars).padStart(9)
      + String(r.hanPct).padStart(7)
      + String(r.outline).padStart(9)
      + String(r.examples).padStart(6)
      + String(r.unresolved).padStart(12),
    );
  }
  const size = (readFileSync(opts.out).length / 1e6).toFixed(1);
  console.log(`\nwrote ${opts.out} (${size} MB, ${Object.keys(corpus).length} documents)`);

  // A book that yields no outline AND no text is almost always a bad run rather
  // than a genuinely empty book, so say so rather than letting it into a corpus
  // the tests will then trust.
  const empty = rows.filter(r => r.outline === 0 && r.lines === 0);
  if (empty.length) {
    console.error(`\nWARNING: ${empty.map(r => r.key).join(', ')} produced nothing at all.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\nextraction failed:', error?.message || error);
  if (error?.cause) console.error('  cause:', error.cause?.message || error.cause);
  process.exit(1);
});
