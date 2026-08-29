import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';


const workerUrl = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url);
const cmapUrl = new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url);
const fontsUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url);

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.href;


function groupTextItems(items, pageNumber, viewport, includeGeometry) {
  const placed = items
    .filter(item => typeof item.str === 'string' && item.str.trim())
    .map(item => ({
      text: item.str,
      x: item.transform?.[4] ?? 0,
      y: viewport.height - (item.transform?.[5] ?? 0),
      height: Math.max(Math.abs(item.height ?? item.transform?.[3] ?? 0), 1),
    }))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const rows = [];
  for (const item of placed) {
    const row = rows.find(candidate => Math.abs(candidate.y - item.y) <= 2.5);
    if (row) {
      row.items.push(item);
      row.y = Math.min(row.y, item.y);
      row.height = Math.max(row.height, item.height);
    } else {
      rows.push({ y: item.y, height: item.height, items: [item] });
    }
  }

  return rows
    .sort((a, b) => a.y - b.y)
    .map(row => {
      row.items.sort((a, b) => a.x - b.x);
      const line = { page: pageNumber, text: row.items.map(item => item.text).join(' ').trim() };
      if (!includeGeometry) return line;
      return { ...line, y: row.y, height: row.height };
    })
    .filter(line => line.text);
}


async function resolveOutline(document) {
  const raw = await document.getOutline();
  if (!raw?.length) return { available: false, items: [] };

  const convert = async (item) => {
    let destination = item.dest;
    if (typeof destination === 'string') destination = await document.getDestination(destination);

    let pageNumber = null;
    if (Array.isArray(destination) && destination[0]) {
      try { pageNumber = (await document.getPageIndex(destination[0])) + 1; } catch { /* unresolved */ }
    }

    return {
      title: String(item.title ?? '').trim(),
      pageNumber,
      children: await Promise.all((item.items ?? []).map(convert)),
    };
  };

  return { available: true, items: await Promise.all(raw.map(convert)) };
}


/**
 * Opens a PDF as the small document interface Find-Engine already consumes.
 * PDF.js is deliberately confined to this demo adapter; src/ stays dependency-free.
 */
export async function openPdfDocument(filePath, { includeGeometry = true } = {}) {
  const bytes = await readFile(filePath);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: cmapUrl.href,
    cMapPacked: true,
    standardFontDataUrl: fontsUrl.href,
    useSystemFonts: false,
    isEvalSupported: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  const document = await loadingTask.promise;
  const outline = await resolveOutline(document);
  const pages = new Map();

  const pageLines = async (pageNumber) => {
    if (pages.has(pageNumber)) return pages.get(pageNumber);
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = groupTextItems(content.items, pageNumber, viewport, includeGeometry);
    pages.set(pageNumber, lines);
    page.cleanup();
    return lines;
  };

  return {
    name: basename(filePath),
    sourcePath: filePath,
    numPages: document.numPages,
    outline,
    async extractText({ from = 1, to = document.numPages } = {}) {
      const lines = [];
      for (let page = Math.max(1, from); page <= Math.min(document.numPages, to); page++) {
        lines.push(...await pageLines(page));
      }
      return lines;
    },
    async destroy() {
      pages.clear();
      await loadingTask.destroy();
    },
  };
}
