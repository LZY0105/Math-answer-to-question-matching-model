// A real recognizer, built from what Windows already has.
//
// The engine never reads PDFs and never does OCR — it asks a host for the text
// of a page. This is that host, implemented against two things already on the
// machine, so the project keeps its zero-dependency, no-network promise: nothing
// is installed, nothing is downloaded, and no page leaves the device.
//
//   render      pdftoppm (poppler, shipped with MiKTeX here)
//   recognise   Windows.Media.Ocr via Windows PowerShell 5.1
//
// Measured on the scanned 2025 exercise book: 0.75 s to render a page at 200
// DPI and 0.5 s to recognise it.
//
// ── two things that will bite anyone reusing this ──
//
// PowerShell 7 removed the WinRT projection, so `pwsh` cannot load the OCR types
// at all. It must be `powershell.exe`, the 5.1 build.
//
// The recogniser's output must never travel through a pipe. Windows consoles
// default to a legacy code page and every Han character arrives as a question
// mark; measured, a page that recognises 39 Han characters reads as 0 through
// stdout. The script writes UTF-8 to a file instead.
//
// ── why the text needs repairing before the engine sees it ──
//
// Windows OCR emits one space between every glyph, so "例题 1.78" comes back as
// "例 题 1 78 ．". The engine's label parser is anchored and would not match a
// single line of it. Reassembly is therefore part of recognition, not an
// afterthought, and it is deliberately conservative: it joins characters the
// recogniser split, and does not otherwise guess.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Rejoins what the recogniser split, without inventing anything.
 *
 * Each rule repairs one specific artefact of glyph-by-glyph output:
 *
 *   一 元 函 数        -> 一元函数        adjacent Han were never separate words
 *   例 题 1 78 ．      -> 例题 1.78.      a hierarchical label lost its point
 *   丆 （ 0 ）         -> 丆(0)           full-width brackets around an operand
 *
 * The digit rule is scoped to a label position on purpose. Joining any two
 * spaced digits would rewrite the mathematics — "lim 2 3" is not "lim 2.3" —
 * so it fires only directly after a question marker, where the parser expects
 * an identifier and the书 prints one.
 */
export function repairOcrText(raw) {
  let s = String(raw ?? '');

  // Full-width punctuation the recogniser prefers, normalised to what the
  // engine's parsers already understand.
  s = s.replace(/[．。]/g, '.').replace(/[，]/g, ',');

  // Adjacent CJK characters, repeatedly: "一 元 函 数" needs several passes
  // because each join creates a new adjacency.
  let previous;
  do {
    previous = s;
    s = s.replace(/([㐀-鿿])[ \t]+(?=[㐀-鿿])/g, '$1');
  } while (s !== previous);

  // A hierarchical identifier immediately after a question marker.
  s = s.replace(/(例题|习题|第)\s*(\d{1,4})\s+(\d{1,4})(?!\d)/g, '$1 $2.$3');

  // Brackets and operators pulled back onto their operands.
  s = s.replace(/\s*([（(])\s*/g, '$1').replace(/\s*([）)])\s*/g, '$1');
  s = s.replace(/\s*([=＝])\s*/g, '$1');

  return s.replace(/[ \t]{2,}/g, ' ').trimEnd();
}

/**
 * Renders one page of a PDF to PNG.
 *
 * The PDF is expected at an ASCII path. The poppler build shipped with MiKTeX
 * cannot open a path containing Han characters — it reports "No such file" —
 * so a caller holding a Chinese filename must stage a copy first.
 */
function renderPage(pdfPath, page, { dpi, workDir }) {
  const prefix = join(workDir, `p${page}`);

  // RELATIVE paths, always.
  //
  // This poppler build cannot open an absolute path containing non-ASCII
  // characters — it mangles them to question marks and reports "No such file".
  // Both this repository and this user's home directory contain Han characters,
  // so an absolute path fails on every machine it would actually run on. Passing
  // paths relative to the working directory sidesteps the encoding entirely,
  // because poppler never has to decode the prefix.
  const rel = (p) => {
    const r = relative(process.cwd(), p);
    return r && !r.startsWith('..') ? r : p;
  };

  execFileSync('pdftoppm', [
    '-f', String(page), '-l', String(page),
    '-r', String(dpi), '-png',
    rel(pdfPath), rel(prefix),
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  // pdftoppm zero-pads the page number to the width of the document's page
  // count, which it does not tell us, so the suffix is discovered rather than
  // predicted.
  for (const width of [1, 2, 3, 4, 5, 6]) {
    const candidate = `${prefix}-${String(page).padStart(width, '0')}.png`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * A recognizer for MatchingEngine.preparePair({ recognizer }).
 *
 * @param {object} options
 * @param {string} options.pdfPath      ASCII path to the PDF
 * @param {number} [options.dpi]        render resolution; 200 measured adequate
 * @param {string} [options.language]   OCR language tag
 * @param {string} [options.workDir]    scratch directory for rendered pages
 * @param {boolean} [options.keepImages] leave rendered pages on disk
 * @returns {(page: number) => Promise<string>} and a `.stats` accessor
 */
export function createWindowsOcrRecognizer({
  pdfPath,
  dpi = 200,
  language = 'zh-Hans-CN',
  workDir = join(HERE, '..', 'tmp', 'ocr-work'),
  keepImages = false,
} = {}) {
  const dir = resolve(workDir);
  mkdirSync(dir, { recursive: true });
  const script = join(HERE, 'win-ocr.ps1');
  const pdf = resolve(pdfPath);

  const stats = { pages: 0, failures: 0, renderMs: 0, ocrMs: 0, chars: 0 };
  const cache = new Map();

  const recognise = async (page) => {
    if (cache.has(page)) return cache.get(page);

    let text = '';
    try {
      const t0 = Date.now();
      const image = renderPage(pdf, page, { dpi, workDir: dir });
      stats.renderMs += Date.now() - t0;
      if (!image) throw new Error(`page ${page} did not render`);

      const out = join(dir, `p${page}.txt`);
      const t1 = Date.now();
      execFileSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', script,
        '-Image', image,
        '-Language', language,
        '-Out', out,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      stats.ocrMs += Date.now() - t1;

      text = repairOcrText(readFileSync(out, 'utf-8'));
      stats.pages++;
      stats.chars += text.length;

      if (!keepImages) {
        rmSync(image, { force: true });
        rmSync(out, { force: true });
      }
    } catch {
      // One unreadable page must not abort a book. The engine already treats an
      // empty result as a failed page and keeps OCR_REQUIRED set if too many
      // come back this way.
      stats.failures++;
      text = '';
    }

    cache.set(page, text);
    return text;
  };

  recognise.stats = stats;
  return recognise;
}
