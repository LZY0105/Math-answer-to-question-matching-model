#!/usr/bin/env node
// Builds the OCR cache the audit needs, from the scanned PDF.
//
// Separated from the audit so the expensive step runs once and is reused. The
// PDF must sit at an ASCII path: the poppler build used here cannot open one
// containing Han characters.
//
//   cp "<2025 exercise PDF>" tmp/ocr/q2025.pdf
//   node tools/ocr-cache.mjs

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createWindowsOcrRecognizer } from './windows-ocr.mjs';

const PDF = process.env.FIND_ENGINE_OCR_PDF || 'tmp/ocr/q2025.pdf';
const OUT = process.env.FIND_ENGINE_OCR_CACHE || 'tmp/ocr/q2025-ocr-lines.json';
const PAGES = Number(process.env.FIND_ENGINE_OCR_PAGES || 465);

if (!existsSync(PDF)) {
  console.log(`no PDF at ${PDF} — nothing to recognise.`);
  console.log('Copy the scanned exercise book there first; the path must be ASCII.');
  process.exit(0);
}

const recognise = createWindowsOcrRecognizer({ pdfPath: PDF, dpi: 200 });
const lines = [];
for (let page = 1; page <= PAGES; page++) {
  const text = await recognise(page);
  for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    lines.push({ page, text: line });
  }
  if (page % 50 === 0) process.stdout.write(`  ${page}…`);
}

mkdirSync(OUT.replace(/[^/\]+$/, ''), { recursive: true });
writeFileSync(OUT, JSON.stringify(lines));
console.log(`\n${lines.length} lines from ${PAGES} pages -> ${OUT}`);
console.log(`recognizer stats: ${JSON.stringify(recognise.stats)}`);
