# Handover — Find-Engine, 2026-11-03

For whoever picks this up next. It says where the code and the data are, what
is verified and how to re-verify it, what is known to be fragile, and what to
do next, in order. Everything measured here was measured on the branch named
below on 2026-11-03; the numbers are reproducible with the commands given.

## 摘要

匹配引擎本体（`src/`，零依赖）已完成两轮优化并全部通过验证：文本路径在
2023 / 2024 三组真题上严格策略召回 506/508、183/271、191/217，校准策略全部
508/508、271/271、217/217，无一错配；三套语料测试套件全部通过。本仓库自研的
公式 OCR（`ocr/`）已接入引擎的识别器契约（按页返回带位置的公式区域），并用
文本层作为「理想识别器」做了全套消融测量：零错配，三组配对中两组仅凭公式即可
完成配对验证。**模型导出包不在仓库里**（在被忽略的 `tmp/` 下），所以真实模型
的输出尚未经引擎测量——这是下一步的第一件事。没有题级书签的教材（整个
`books-20260924` 发布）仍是未解决的问题。

## 1. Where things are

| | |
|---|---|
| Repository | `LZY0105/Math-answer-to-question-matching-model` |
| Default branch | `main`, at `7673a20` (the first optimisation round, merged as PR #1) |
| Working branch | `claude/project-optimization-review-486rqs`, at `62f37d7`: `main` + the two commits of `codex/scratch-formula-ocr` + the formula-recogniser work. Fast-forward of main; no pull request open for it yet. |
| Engine | `src/` — pure JavaScript, no runtime dependencies. Entry point `src/matching-engine.js` (`preparePair`). |
| Demo adapter | `demo/pdfjs-document-adapter.mjs` — PDF.js, development only. The only place PDFs are read. |
| Formula OCR | `ocr/` — self-trained recogniser: training, export, ONNX inference (`recognize_scratch.py`), Android runner, dataset tooling. Model card: `ocr/MODEL_CARD.md`. |
| Design and results | `README.md`, `RESEARCH-REPORT.md` (the report the headline numbers come from), `CHANGELOG.md` (one entry per round, newest last) |
| Measurement notes written this cycle | `datasets/exam-corpus-20260924/EVALUATION.md`, `datasets/books-20260924/EVALUATION.md`, `ocr/MATCHING.md` |

Three data releases, none in git:

| Release tag | What | Download |
|---|---|---|
| `exam-corpus-20260924` | 9 PDFs: the 2023–2025 考研 books the report's numbers come from | `node datasets/exam-corpus-20260924/download.mjs --all --out ../exam-corpus` |
| `test-corpus-20260924` | 63 textbook PDFs from other publishers, nine subjects | `node datasets/books-20260924/download.mjs --id book-003 ... --out ../find-engine-books` (the 24 ids used are listed in `datasets/books-20260924/EVALUATION.md`) |
| — | **The formula model bundle.** Not uploaded anywhere. `ocr/MODEL_CARD.md` names it: round 10, cached INT8 export, `tmp/formula-scratch-kv-int8-texteller-r10/` on the training machine, about 4 MB (`encoder.onnx`, `decoder.onnx`, `tokenizer.json`, `metadata.json`, `model.properties`). | Needs a release asset or a commit under `ocr/`. |

One caveat that cost a day: the exam release holds two 2023 exercise books.
`exam-006` has section bookmarks only; `exam-009` (留白作答版) has the 508
question bookmarks every 2023 assertion depends on. Use `exam-009` as `q2023`.

## 2. How to run everything

```sh
npm ci                      # pdfjs-dist, development only
npm run test:unit           # 275 synthetic checks, no data needed; this is what CI runs
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

The OCR path, with the text layer as the oracle recogniser:

```sh
python3.12 -m venv ../ocr-venv && ../ocr-venv/bin/pip install numpy==2.5.3 Pillow==12.1.1 onnxruntime==1.23.2 pdfplumber==0.11.9 pypdf==6.10.0
node tools/formula-regions.mjs --pdf "$E/2023年名校数学专业考研真题分类_留白作答版.pdf" --out $E/q2023-regions.jsonl
node tools/ocr-ablation.mjs --corpus $E/data.json --exercise q2023 --answer ans2023 \
  --regions $E/q2023-regions.jsonl --policy STRICT --tap
```

With the model bundle in hand, the same harness on the model's output:

```sh
../ocr-venv/bin/python -m ocr.ocr_pages --pdf BOOK.pdf --regions $E/q2023-regions.jsonl \
  --bundle PATH_TO_BUNDLE --output $E/q2023-ocr.jsonl
node tools/ocr-ablation.mjs ... --regions $E/q2023-ocr.jsonl --policy STRICT --tap
```

`pdftoppm` (poppler) must be on the PATH for the model path; it is in this
container. Nothing downloads a model or calls a service.

## 3. What is verified, as of this branch

Text-layer path, the three 考研 pairs, zero wrong under every policy:

| Pair | Strict-policy recall | Calibrated | Suite floors |
|---|---|---|---|
| 2023 | 506 / 508 | 508 / 508 | 470 |
| 2024 Analysis | 183 / 271 | 271 / 271 | 159 |
| 2024 Algebra | 191 / 217 | 217 / 217 | 175 |

Ablation regimes on 2023 (distinct questions resolved): both bookmark trees
506; answer key without bookmarks 492; exercise book without 2; neither 47.
Suites: `test_real_pdfs` 23/23, `test_no_bookmarks` 9/9,
`test_corpus_regression` 26/26.

Textbook release, 24 volumes, every ordered pairing: 552 pairings, 0
automatic answers (510 OCR_REQUIRED, 42 UNKNOWN_PAIR). `test_books_20260924`
56/56. Every matched pair there has a scanned side; it measures the gates
that run before matching, never recall.

Formula-only path, oracle regions (the text layer's own formulas, region by
region), the exercise book's text layer hidden:

| Pair | Pair verdict on formulas alone | Strict, tap-bounded | Calibrated | Wrong |
|---|---|---|---|---|
| 2023 | VERIFIED (anchor top-1 0.54) | 356 / 508 | 508 / 508 | 0 |
| 2024 Analysis | UNKNOWN (0.25; was REJECTED before this cycle) | 122 / 271 | 271 / 271 | 0 |
| 2024 Algebra | VERIFIED (0.46) | 134 / 217 | 217 / 217 | 0 |

The model has not produced a single region in this environment. Every OCR
figure above is an upper bound on recognition and a floor on the engine.

## 4. What changed, and why, in two rounds

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
  the content-anchor line was measured on text layers; on formulas alone a
  valid pair scored 0.25 and was rejected. Now UNKNOWN, which a binding
  resolves.
- Tools: `tools/formula-regions.mjs`, `ocr/ocr_pages.py`,
  `tools/ocr-ablation.mjs`; tests `test/test_formula_latex.js`,
  `test/test_formula_regions.js`, and new groups in
  `test/test_matching_engine.js`.

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
- **The 2024 留白 books' layout** (a listing page, then one reprint page per
  question, bookmarks pointing at the listing for the first question only) is
  why a bookmark-to-bookmark window fails there and the `--tap` reading is the
  one to compare.
- **Ablation is not absence**: stripping bookmarks from a book that has them
  is not a book that never had them (RESEARCH-REPORT §8). The textbook release
  is the real thing and has no text pair.
- **CI has no corpus.** A green CI run means the 275 synthetic checks passed
  and nothing else. The corpus suites run only where the data is.

## 6. Open problems, in the order to take them

1. **Run the model.** Put the bundle in a release (or under `ocr/`), produce
   regions for the three exercise books with `ocr/ocr_pages.py --regions`,
   run `tools/ocr-ablation.mjs --tap`. The difference from the oracle table
   above is the recogniser's cost in the engine's own terms: questions the
   strict gate stops confirming because a digit or an exponent came back
   different. Also run the model's regions through `--regime ids` without
   `--tap` on 2023, where the bookmark window is sound, to get the engine's
   own pair verdict on real recognition.
2. **The first real scanned pair: 绿皮书** (`book-026`, scanned exercise sets
   with 87 "习题 n.n" bookmarks that now index, against `book-044`, a usable
   text-layer answer book). This needs the model, because the exercise side
   has no text layer, and it is the shape every textbook has.
3. **Content matching for books without question bookmarks.** Every textbook.
   On the 2023 pair the oracle's formulas rank the right answer first for only
   40% of questions by the engine's similarity, with margins under 0.1 for
   nine in ten; a coverage-based ranking did no better (see
   `tools/ocr-ablation.mjs --regime content`). Answer entries are whole
   solutions and a question's formulas are a small part of them. Ideas not
   yet tried: weight expressions by rarity across the section; match against
   the first lines of each entry (where a key restates the question); use
   the answer key's own printed problem numbers inside a section as
   section-scoped ids.
4. **Per-question validation on the OCR path before any release** — the
   report's list: bidirectional consistency, global one-to-one assignment, a
   sufficient top-two margin. The formula gate is now in place; the other
   three are not.
5. **Thresholds**: the inherited stage-2/3 constants (`SIMILARITY_STRONG`,
   `SIMILARITY_WEAK`, `GAP_PENALTY`, `LABEL_BONUS`, `MATH_WEIGHT`) have still
   never been swept. Sweep them only on a held-out book.
6. **Host integration**: the Android app must pass regions with positions
   (the `top`/`bottom` the Java runner's caller knows) and the tap region;
   `selectByRegion` in `matching-engine.js` is where a tap meets an entry's
   spans.

## 7. File map for this cycle

| File | Role |
|---|---|
| `src/formula-latex.js` | LaTeX → matcher text (`latexToText`), with `fractions` and `scripts` options |
| `src/answer-index.js` | `recognisedLines` (the region contract), `OCR_FORMULA` origin, entries carry `top` |
| `src/entry-text.js` | newline-joined entry text, `insideBookmarks` / `lineCentre`, page-number lines dropped (not digits) |
| `src/question-matcher.js` | `textProfile`/`profileSimilarity`, `extractMathFragments` splits on lines and rejoins wrapped ones |
| `src/outline-classify.js` | `PAGE_MARKER` cohorts, depth-aware spans, `top` carried |
| `src/region-locator.js` | regions bounded by section spans on both sides |
| `src/pair-verifier.js` | ten-subject detector; recognised text cannot reject |
| `src/question-id.js` | outline ids from 例题 / 习题 / 练习题 / 第 n 题 / Example / Exercise / Problem |
| `demo/pdfjs-document-adapter.mjs` | CMap paths, script attachment, bookmark `top`, `groupTextRows` |
| `tools/extract-books.mjs` | PDFs → corpus JSON, `--geometry` |
| `tools/formula-regions.mjs` | formula regions off a text layer (oracle) |
| `tools/ocr-ablation.mjs` | the OCR-path measurement: `ids`, `--tap`, `content` |
| `ocr/ocr_pages.py` | page regions → model LaTeX (`--bundle`) or oracle text (`--oracle`) |
| `test/test_books_20260924.js` | the textbook release suite |
| `test/test_formula_latex.js`, `test/test_formula_regions.js` | unit suites for the two new modules |

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
