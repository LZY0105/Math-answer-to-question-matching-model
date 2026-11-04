# Handover — Find-Engine, 2026-11-04

For whoever picks this up next. It says where the code and the data are, what
is verified and how to re-verify it, what is known to be fragile, and what to
do next, in order. Everything measured here was measured on the branch named
below on 2026-11-03 and 2026-11-04; the numbers are reproducible with the
commands given.

## 摘要

匹配引擎本体（`src/`，零依赖）已完成四轮优化并全部通过验证。第三轮把 PDF 读取层
改成「只读印出来的字」：2024 年两本留白作答版**和两本 2024 答案**都以裁剪方式嵌入整页
原排版，文本层里藏着 42–83% 看不见的邻题文字；读取层现在按 pdf.js 的绘制指令重放裁剪，
只保留真正画出来的字，并按印刷形态读出 ≠、√、分式和极限下标。文本路径严格策略召回因此
从 506/508、183/271、191/217 升到 **506/508、248/271、213/217**，校准策略全部
508/508、271/271、217/217，无一错配；三套语料测试套件全部通过。仓库自研的公式 OCR 模型
（`ocr/models/formula-scratch-kv-int8-texteller-r10/`）在三本真题练习册上隐藏文本层后
跑完全程：零错配，三组配对仅凭模型公式全部通过验证，严格策略召回由 224/85/116 升到
**289/160/128**，约为「理想识别器」的 71–78%。第一组真实扫描教材（绿皮书）的答案书只给
结果、不复述题目，只能靠「习题集 + 印刷题号」定位：第四轮（本轮）补上了这一层索引——练习册的
「习题 n.m」书签按模型读出的行首题号拆成单题（`n.m.k`），只有节书签的答案书按节内
`k.` 编号，两边经大纲对齐的节才互相解析。全书 69 个习题集中 66 个拆开，共 508 题（答案书
527 题）；每题点按一次：未绑定时 0 个自动答案，用户确认配对后严格策略 295 个、校准策略
466 个自动答案，逐一对照页面图像核对，无一错配；错误配对无论是否绑定都是 0。

## 1. Where things are

| | |
|---|---|
| Repository | `LZY0105/Math-answer-to-question-matching-model` |
| Default branch | `main`, at `7673a20` (the first optimisation round, merged as PR #1) |
| Working branch | `claude/project-optimization-review-486rqs`: `main` + `codex/scratch-formula-ocr` (with the model bundle) + the formula-recogniser work and the model's measurement. Open as PR #2. |
| Engine | `src/` — pure JavaScript, no runtime dependencies. Entry point `src/matching-engine.js` (`preparePair`). |
| Demo adapter | `demo/pdfjs-document-adapter.mjs` — PDF.js, development only. The only place PDFs are read. |
| Formula OCR | `ocr/` — self-trained recogniser: training, export, ONNX inference (`recognize_scratch.py`), Android runner, dataset tooling. Model card: `ocr/MODEL_CARD.md`. The shipped bundle (round 10, cached INT8, 4.1 MB) is committed at `ocr/models/formula-scratch-kv-int8-texteller-r10/`. |
| Design and results | `README.md`, `RESEARCH-REPORT.md` (the report the headline numbers come from), `CHANGELOG.md` (one entry per round, newest last) |
| Measurement notes written this cycle | `datasets/exam-corpus-20260924/EVALUATION.md`, `datasets/books-20260924/EVALUATION.md`, `ocr/MATCHING.md` |

Two data releases, neither in git:

| Release tag | What | Download |
|---|---|---|
| `exam-corpus-20260924` | 9 PDFs: the 2023–2025 考研 books the report's numbers come from | `node datasets/exam-corpus-20260924/download.mjs --all --out ../exam-corpus` |
| `test-corpus-20260924` | 63 textbook PDFs from other publishers, nine subjects | `node datasets/books-20260924/download.mjs --id book-003 ... --out ../find-engine-books` (the 24 ids used are listed in `datasets/books-20260924/EVALUATION.md`) |

One caveat that cost a day: the exam release holds two 2023 exercise books.
`exam-006` has section bookmarks only; `exam-009` (留白作答版) has the 508
question bookmarks every 2023 assertion depends on. Use `exam-009` as `q2023`.

## 2. How to run everything

```sh
npm ci                      # pdfjs-dist, development only
npm run test:unit           # 310 synthetic checks, no data needed; this is what CI runs
```

Build the exam corpus JSON (text layers, line geometry, bookmark positions):

```sh
E=../exam-corpus
node tools/extract-books.mjs --geometry --books $E --out $E/extracted \
  "q2023=$E/2023年名校数学专业考研真题分类_留白作答版.pdf" \
  "ans2023=$E/2023年名校数学专业考研真题分类_完整答案解析.pdf" \
  "a2024=$E/2024年名校数学专业考研真题分类_数学分析留白作答版.pdf" \
  "a2024_ma=$E/2024年名校数学专业考研真题分类_数学分析完整答案.pdf" \
  "g2024=$E/2024年名校数学专业考研真题分类_高等代数留白作答版.pdf" \
  "a2024_alg=$E/2024年名校数学专业考研真题分类_高等代数完整答案.pdf" \
  "q2025=$E/2025年数学专业考研真题.pdf" \
  "a2025=$E/2025年数学专业考研真题分类_573题完整答案解析.pdf"
node -e 'const fs=require("fs"),d="../exam-corpus/extracted",o={};for(const f of fs.readdirSync(d))o[f.slice(0,-5)]=JSON.parse(fs.readFileSync(d+"/"+f));fs.writeFileSync("../exam-corpus/data.json",JSON.stringify(o))'
FIND_ENGINE_CORPUS=../exam-corpus/data.json FIND_ENGINE_EXPANDED_CORPUS=../exam-corpus/data.json npm run test:real
```

`test:real` runs the three corpus suites and the textbook suite; each skips
and says so when its data is absent. The textbook suite reads
`FIND_ENGINE_BOOKS=../find-engine-books/extracted` after
`node tools/extract-books.mjs --geometry --books ../find-engine-books`.

The OCR path: formula regions off the text layer (the oracle), the model
reading the same boxes, both through the same harness:

```sh
python3.12 -m venv ../ocr-venv && ../ocr-venv/bin/pip install numpy==2.5.3 Pillow==12.1.1 onnxruntime==1.23.2 pdfplumber==0.11.9 pypdf==6.10.0
B=ocr/models/formula-scratch-kv-int8-texteller-r10
Q="$E/2023年名校数学专业考研真题分类_留白作答版.pdf"
node tools/formula-regions.mjs --pdf "$Q" --out $E/q2023-regions.jsonl
../ocr-venv/bin/python -m ocr.ocr_pages --pdf "$Q" --regions $E/q2023-regions.jsonl --bundle $B --output $E/q2023-model.jsonl
node tools/ocr-ablation.mjs --corpus $E/data.json --exercise q2023 --answer ans2023 \
  --regions $E/q2023-model.jsonl --compare $E/q2023-regions.jsonl --policy STRICT --tap
```

The adapter reads only what a page paints (§5): the 2024 books need no
split, for the regions or for the corpus. `ocr/clip_windows.py` remains as an
independent cross-check of that. The model crops the original pages, and a
clipped page renders only what it paints. `pdftoppm` (poppler) must be on the
PATH; it is in this container. Nothing downloads a model or calls a service.

A scanned book: `python -m ocr.scan_line_starts --pdf BOOK.pdf --pages 23-25
--bundle $B --output starts.jsonl` reads the first ink cluster of every text
line — on the 绿皮书 (`book-026`), the printed exercise numbers. The whole
book is `--pages 1-492` (run as four ranges side by side, one output each).
Then, with the textbook release extracted:

```sh
S=starts-1-123.jsonl,starts-124-246.jsonl,starts-247-369.jsonl,starts-370-492.jsonl
node tools/measure-sets.mjs --books ../find-engine-books/extracted \
  --exercise book-026 --answer book-044 --starts $S --json taps.json
../ocr-venv/bin/python -m ocr.set_crops --pdf BOOK-026.pdf --taps taps.json --out sheets
```

The second command draws every automatic answer's tap point, set heading,
last exercise and page-crossing exercise from the page image, which is how
its "wrong" count is checked (§3).

## 3. What is verified, as of this branch

Text-layer path, the three 考研 pairs, both books read through the adapter as
printed, zero wrong under every policy:

| Pair | Strict-policy recall | Before round three | Calibrated | Suite floors |
|---|---|---|---|---|
| 2023 | 506 / 508 | 506 | 508 / 508 | 470 |
| 2024 Analysis | 248 / 271 | 183 | 271 / 271 | 159 |
| 2024 Algebra | 213 / 217 | 191 | 217 / 217 | 175 |

Ablation regimes on 2023 (distinct questions resolved): both bookmark trees
506; answer key without bookmarks 491; exercise book without 2; neither 47.
Suites: `test_real_pdfs` 23/23, `test_no_bookmarks` 9/9,
`test_corpus_regression` 26/26.

Textbook release, 24 volumes, every ordered pairing, on the same reader: 552
pairings, 0 automatic answers (510 OCR_REQUIRED, 42 UNKNOWN_PAIR);
`test_books_20260924` 56/56 (7 volumes' text changed with the reader). Every
matched pair there has a scanned side; it measures the gates that run before
matching, never recall.

Formula-only path, the exercise book's text layer hidden, the model against
the oracle (`ocr/MATCHING.md` has every step):

| Pair | Pair verdict on formulas, oracle / model | Strict, tap: oracle → model | Strict, window | Calibrated | Wrong |
|---|---|---|---|---|---|
| 2023 | VERIFIED 0.958 / 0.792 | 375 → 289 / 508 | 389 → 264 | 508 / 508 | 0 |
| 2024 Analysis | VERIFIED 0.833 / 0.792 | 205 → 160 / 271 | 211 → 158 | 271 / 271 | 0 |
| 2024 Algebra | VERIFIED 0.875 / 0.875 | 180 → 128 / 217 | 180 → 130 | 217 / 217 | 0 |

The first model run read 224, 85 and 116 by tap. The model reads 81%, 74% and
80% of regions exactly as the text layer does.

A real scan, the 绿皮书 (`book-026`, 492 scanned pages, against `book-044`'s
text layer), indexed by set and printed number: 66 of 69 sets split into 508
exercises of the 527 the answer book numbers. One tap per exercise:

| | Pair | Automatic | Review | Located | Wrong |
|---|---|---|---|---|---|
| Not bound | UNKNOWN_PAIR | 0 | 507 | 1 | 0 |
| Bound, strict | VERIFIED_PAIR | 295 | 212 | 1 | 0 |
| Bound, calibrated | VERIFIED_PAIR | 466 | 41 | 1 | 0 |

"Wrong" is checked against the page image, not the lookup (which agrees with
itself by construction): all 466 automatic answers' tap points show the
printed number of their id, every set's heading sits above its first
exercise, and every last and page-crossing exercise's band stays inside it.
Six wrong pairs (the 绿皮书 against three other answer books, the answer book
against three exercise books with text layers): 0 automatic answers, bound or
not.

## 4. What changed, and why, in four rounds

Round one (PR #1, merged): a text-profile cache (2–3× on the degraded
regimes); four gate defects from the textbook release — page-number bookmark
trees read as question levels, 习题 bookmarks without ids, a two-subject
detector that misnamed ODE/PDE/probability books, located regions unbounded
by their section; the entry-text cleaner deleting an entry's page digits from
its mathematics; the demo adapter passing pdf.js a `file://` CMap path (every
CJK font decoded as noise) and losing superscripts to its row tolerance. The
two dataset EVALUATION notes carry every number.

Round two (this branch): the formula recogniser's output made usable, which
turned out to improve the text path as much as the OCR path:

- **Recogniser contract**: `recognizer(page)` may return regions
  `{latex|text, formula, top, bottom}`; LaTeX goes through
  `src/formula-latex.js`; formula-only output is judged on noise, not on Han,
  and indexes as `textOrigin: 'OCR_FORMULA'`.
- **A line is an expression boundary**, unless it wraps mid-expression
  (`extractMathFragments`). Without prose between them, recognised formulas
  had merged into one expression; on text layers, rows of display mathematics
  had been one expression on one side and several on the other. This is the
  change behind 474→506 on 2023.
- **Bookmark positions bound entries**: the adapter reports where a bookmark
  points (`top`), entries carry it, `entryLines` keeps only lines between an
  entry's bookmark and the next, compared at line centres.
- **Recognised text never grounds a hard rejection** (`pair-verifier.js`):
  the content-anchor line was measured on text layers. A recogniser's
  disagreement is now UNKNOWN, which a binding resolves.
- **The identity check reads each question's own text** (`pair-verifier.js`),
  not its page range, whose text is mostly a page's other questions. On the
  2024 analysis pair read as printed, ranking range text scored 0 of 24 and
  rejected the valid pair; on own text the valid pairs score 0.625–1.000 and
  the wrong ones at most 0.083, as read or as printed.
- **The model, measured**: `ocr/ocr_pages.py --regions --bundle` on all three
  exercise books, `ocr/clip_windows.py` to read the 2024 books as printed,
  `tools/ocr-ablation.mjs --compare` for region-level agreement.
- Tools: `tools/formula-regions.mjs` (`--map`), `ocr/ocr_pages.py`,
  `tools/ocr-ablation.mjs`, `tools/extract-books.mjs` (`--split --map`);
  tests `test/test_formula_latex.js`, `test/test_formula_regions.js`,
  `ocr/test_clip_windows.py`, and new groups in
  `test/test_matching_engine.js` and `test/test_structure.js`.

Round three (this branch, continued): the reader reads what the page prints,
which is where most of the model's gap to the oracle was.

- **≠ and √** (`readMarks`): TeX's zero-width negation slash, extracted as
  `6`, merges into the relation under it; a radical, hung from its top, joins
  its radicand's line. `latexToText` reads `\not` through the same table.
- **Only painted text** (`paintedGlyphs`, `paintedItems`, `pageTextItems`):
  the clip state replayed from pdf.js's operator list, through nested forms;
  a text item is kept when the glyph run at its position that spells it is
  painted. On by default. This found that the 2024 answer keys hide text too.
- **Fractions and limits** (`paintedRules`, `readFractions`, `readLimits`): a
  display fraction rebuilt from its drawn bar as `( a ) / ( b )`, a limit's
  subscript moved after `lim`; both keep the box they are printed in, so the
  crops hold the whole formula.
- **The alphabet test restated** on simulated garbling, which is what the
  check exists for; the threshold is unchanged.
- **The scanned 绿皮书**: `ocr/scan_line_starts.py` reads the printed exercise
  numbers; `ocr/extract_formula_dataset.py` and `build_pure_formula_dataset.py`
  no longer fail to import (a `global` declared after use).

Round four (this branch, continued): exercises by set and printed number, the
index level every textbook in the release needs.

- **Sets split into exercises** (`src/exercise-sets.js`, `answer-index.js`):
  in an exercise book, a bookmark titled 习题 / 练习 / Exercises / Problems is
  replaced by one entry per number read at the start of its lines, `1.1.3`,
  with the band each occupies on each page; the set whole is kept beside it
  (`withoutSetIds`). An answer book whose outline stops at sections is indexed
  `section.number` (`INDEX_SOURCE.SECTIONS`), the body parse kept beside it.
- **Only when both sides carry them** (`reconcileSetIds` in
  `matching-engine.js`): otherwise both books fall back to the index they had,
  so no pair without set ids on both sides changes.
- **Resolution through the aligned section** (`setScopedMatch` in
  `question-matcher.js`): the set's section by the outline's nesting must be
  paired with the answer's section. Never automatic when the set's count
  disagrees with the answer section's, a number is skipped before or after
  it, a stray opener sits inside it or its answer, or it is off its set's
  margin. A set exercise resolved any other way is capped at REVIEW, and an
  answer known by section and number is reachable only this way.
- **Bands**: the last exercise ends at the first break wider than three opener
  heights; one over a page break never takes the next page's running head.
- **The pair gate** (`pair-verifier.js`): a binding now settles the UNKNOWN
  role of an answer book indexed by section and number, which states results
  and cannot show its role by its language. On every other index an
  unconfirmable role stays unconfirmed, bound or not.
- Tools: `tools/measure-sets.mjs`, `ocr/set_crops.py`; tests
  `test/test_exercise_sets.js` (22 checks).

## 5. Known fragile points — do not take these as settled

- **The role threshold (0.97 on answer-language and explicit-answer shares)**
  was set on the 考研 keys. A genuine 习题详解 scores 0.84; a 44-page answer
  book crossed it on two entries when row grouping changed. It cannot reject a
  body-parsed index, so safety holds, but it will declare UNKNOWN on books it
  should confirm. Re-sweep it only with a textbook pair that has text on both
  sides.
- **The year gate** reads printed years as identity. On textbooks a printing
  year differs between a book and its answer volume; no such pair has been
  observed yet with a year on both sides. When one appears it will be blocked.
- **`MATH_CHAR` in `question-matcher.js`** does not include →, ∈, ′, most
  Greek letters or `·`, so expressions split there on both sides. Consistent,
  therefore harmless so far; widening it changes every fragment and must be
  measured on the three pairs.
- **Row grouping in the demo adapter** (scripts attach within 0.7 of a row's
  font size, adjacent to a base, in its whitespace, never after ∫ ∑ ∏ lim) is
  calibrated on two 2024 books. The host app reads through its own pdf.js
  layer with its own grouping; the suites' floors were set on that reader.
- **Clip-aware reading lives in the demo adapter, not yet in the app.** The
  2024 exercise books and answer keys embed whole pages of a compact
  typesetting as clipped forms; read whole, their text layers carry every
  neighbouring question (12,699 lines in the analysis exercise book, 2,174
  printed; 19,005 in its key, 10,672 printed). The adapter now keeps only
  painted text, and every number in §3 is on that reading. The host app reads
  through its own pdf.js layer and still reads the hidden text; the functions
  port as they are (pdf.js public API only). The corpus suites' floors were
  set on the old reading and stay below the new figures.
- **The clip replay is a bounding-box model.** A clip path counts by its
  bounding box (exact for these books' rectangles, generous for anything
  rounder); a text item is judged by the glyph run at its own position; Type3
  fonts and vertical text are not modelled. An item it cannot account for is
  kept, never dropped.
- **Fractions are rebuilt only from a drawn bar.** A numerator is what sits
  0.1–0.9 of its size above the bar and centred on it, a denominator 0.3–1.4
  below. Measured on the 考研 books; a typesetting that draws its bars
  differently, or none (a text-style fraction with a slash), reads as before.
- **The set-and-number guards were measured on one book.** The margin
  tolerance (one opener height; real numbers 0.41 away at most, the false one
  2.08), the break that ends a last exercise (three opener heights; 19pt
  inside exercises at most, 37–52pt before a heading) and the head-and-rule
  touch (half an opener height) all come from the 绿皮书. A book set more
  tightly, or one whose recogniser reports no `left`, has fewer of these
  guards; the count and sequence checks hold regardless.
- **Set titles are a word list**: 习题, 练习, Exercises, Problems (and so
  复习题, which contains 习题 but carries no numeric id). A set bookmarked
  under another name stays one entry, as before.
- **Answer books that bookmark their sets are not split**; against an
  exercise book with split sets, both fall back to the sets whole.
- **Ablation is not absence**: stripping bookmarks from a book that has them
  is not a book that never had them (RESEARCH-REPORT §8). The textbook release
  is the real thing and has no text pair.
- **CI has no corpus, and runs no Python.** A green CI run means the 310
  synthetic checks passed and nothing else. The corpus suites run only where
  the data is; `ocr/test_*.py` run by hand
  (`python -m unittest ocr.test_clip_windows ocr.test_scan_line_starts`).

## 6. Open problems, in the order to take them

1. **More textbook pairs by set and number.** The 绿皮书 is the only pair in
   the release with a scanned exercise side and an answer book with a text
   layer; the others need their scanned side read the same way
   (`ocr/scan_line_starts.py`), and answer books that bookmark their sets need
   splitting too. The 19 unindexed 绿皮书 exercises are reading misses, not
   engine ones (`ocr/MATCHING.md`).
2. **The rest of the model's gap**: strict recall is 71–78% of the oracle's.
   It reads long regions worst (40–73% identical over twenty characters);
   whether that is the crop or the model is the next measurement.
3. **Port the reader to the host** (§5): `pageTextItems`, `paintedRules`,
   `readMarks`, `readFractions`, `readLimits` into the app's
   `pdf-document.js`, then re-set the corpus suites' floors on its output.
4. **Content matching for books without question bookmarks** where the key
   does restate the questions. On the 2023 pair the oracle's formulas ranked
   the right answer first for only 40% of questions (measured before this
   round's reader changes; re-measure with `tools/ocr-ablation.mjs --regime
   content`).
5. **Per-question validation on the OCR path before any release** — the
   report's list: bidirectional consistency, global one-to-one assignment, a
   sufficient top-two margin. The formula gate is in place; the other three
   are not.
6. **Thresholds**: the inherited stage-2/3 constants (`SIMILARITY_STRONG`,
   `SIMILARITY_WEAK`, `GAP_PENALTY`, `LABEL_BONUS`, `MATH_WEIGHT`) have still
   never been swept. Sweep them only on a held-out book.
7. **Host integration**: the Android app must pass regions with positions
   (the `top`/`bottom` the Java runner's caller knows) and the tap region;
   `selectByRegion` in `matching-engine.js` is where a tap meets an entry's
   spans.

## 7. File map for this cycle

| File | Role |
|---|---|
| `src/formula-latex.js` | LaTeX → matcher text (`latexToText`), with `fractions` and `scripts` options |
| `src/answer-index.js` | `recognisedLines` (the region contract, `left` included), `OCR_FORMULA` origin, entries carry `top`; `expandExerciseSets`, `buildSectionIndex`, `withoutSetIds` |
| `src/entry-text.js` | newline-joined entry text, `insideBookmarks` / `lineCentre`, page-number lines dropped (not digits) |
| `src/question-matcher.js` | `textProfile`/`profileSimilarity`, `extractMathFragments` splits on lines and rejoins wrapped ones; `setScopedMatch` and the set ceilings |
| `src/outline-classify.js` | `PAGE_MARKER` cohorts, depth-aware spans, `top` carried |
| `src/region-locator.js` | regions bounded by section spans on both sides |
| `src/pair-verifier.js` | ten-subject detector; recognised text cannot reject; identity on each entry's own text; a binding settles a section-numbered answer book's role |
| `src/question-id.js` | outline ids from 例题 / 习题 / 练习题 / 第 n 题 / Example / Exercise / Problem |
| `demo/pdfjs-document-adapter.mjs` | CMap paths, script attachment, bookmark `top`, `groupTextRows`; `readMarks` (≠ √), `pageTextItems`/`paintedGlyphs`/`paintedItems` (only painted text), `paintedRules`/`readFractions`/`readLimits` |
| `tools/extract-books.mjs` | PDFs → corpus JSON, `--geometry`, `--split --map` for printed text only |
| `tools/formula-regions.mjs` | formula regions off a text layer (oracle), `--map` for printed regions only |
| `tools/ocr-ablation.mjs` | the OCR-path measurement: `ids`, `--tap`, `content`, `--compare` |
| `ocr/ocr_pages.py` | page regions → model LaTeX (`--bundle`) or oracle text (`--oracle`) |
| `ocr/clip_windows.py` | clip windows of the 2024 留白 books; the one-form-per-copy split, kept as a cross-check of the adapter |
| `ocr/scan_line_starts.py` | the formula model's reading of each scanned line's first ink cluster (exercise numbers) |
| `src/exercise-sets.js` | numbered runs, their flags (gaps, strays, margin) and bands; sets → exercises, sections → answers |
| `tools/measure-sets.mjs` | the set-and-number measurement: every exercise tapped, unbound and bound |
| `ocr/set_crops.py` | contact sheets from the page image for checking those taps by eye |
| `test/test_exercise_sets.js` | the set-and-number layer, through `preparePair` |
| `ocr/models/formula-scratch-kv-int8-texteller-r10/` | the model bundle the measurements used |
| `test/test_books_20260924.js` | the textbook release suite |
| `test/test_formula_latex.js`, `test/test_formula_regions.js` | unit suites for the two new modules |
| `ocr/test_clip_windows.py` | the clip parsing, per-form parts, the split's form removal |
| `ocr/test_scan_line_starts.py` | the scan line finder: binding side, specks, start width |

## 8. Conventions worth keeping

- A rung is a ceiling. Nothing promotes a result to make a number look
  better; only `AUTO_MATCH` can be wrong the costly way, and every measurement
  reports "wrong" separately from recall.
- Every threshold in `src/` carries the measurement that set it, in the
  comment above it. Change the number, change the comment, and put the new
  measurement in the dataset's EVALUATION note.
- Corpus files are extracted text from copyrighted books: never committed,
  never in a test fixture. Synthetic fixtures run in CI; real books run where
  the data is, and the suites skip loudly without it.
- One `CHANGELOG.md` entry per round, in prose, newest last.
- Commit messages say what was measured, not just what was changed.
