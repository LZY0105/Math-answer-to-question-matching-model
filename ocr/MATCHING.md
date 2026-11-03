# The formula recogniser and the matching engine

How a formula-only recogniser feeds the engine, what was changed to make its
output usable, and what the repository's own model is measured to do with it.
Measured on 2026-11-03 with the bundle committed at
`ocr/models/formula-scratch-kv-int8-texteller-r10/` (round 10, cached INT8,
`ocr/MODEL_CARD.md`), against an *oracle* that reads the same regions off the
book's text layer through the demo adapter.

## What the recogniser gives, and what the engine takes

`recognize_scratch.py` turns one formula crop into LaTeX. The engine indexes a
page. The contract between them is the recogniser the host injects into
`preparePair` and the indexers, per page:

```js
recognizer(page) -> [
  { latex: '\\frac{1}{x+1}', top: 208.3, bottom: 224.8 },   // the model's reading
  { text: 'f ( x ) = x 2 + 1', formula: true, top, bottom }, // a formula the host already has as text
  { text: '例题 1.1 ...' },                                   // a line of prose, if any
]
```

Positions are page points from the top-left, the space the demo adapter
reports text lines in. They are what lets a tap select one question on a page
the recogniser read, and what bounds each question's own formulas.

Five things had to change in the engine for that list to mean anything.

**LaTeX is converted to the text form the matcher scores.**
`src/formula-latex.js` turns `x^{2}` into `x2`, `\frac{1}{x+1}` into
`1/(x+1)`, `\alpha \leq \beta` into `α≤β`, `\lim_{x\to 0}` into `limx→0` —
the forms the demo adapter reads off a text layer for the same print. The
report's §7.5 is the reason: a change of representation moves every threshold.

**A line is an expression boundary.** The engine finds expressions by
splitting on non-maths characters, and on a text layer the prose between two
formulas was that split. Recognised regions have no prose, so a question's four
formulas ran together into one expression and the formula gate's coverage
halved. Entry text now keeps its lines, and `extractMathFragments` splits on
them; a line that ends with an operator, or begins with one, is a wrapped
formula and stays one expression. This changed the text-layer path too, and
for the better: strict-policy recall on the 2023 pair went from 474 to 506 of
508, on the 2024 algebra pair from 186 to 191 of 217, on the analysis pair from
184 to 183; zero wrong throughout. Two rows of display mathematics had been
reading as one expression on one side and several on the other.

**Bookmark positions bound a question.** The adapter now reports where a
bookmark points on its page, and an entry's text is the lines between its
bookmark and the next. On a scan read by a formula recogniser there is no
printed heading to parse, and this is the only boundary. On a text layer it
tightened the windows as well: analysis strict recall rose from 159 to 184
before the line change, algebra from 176 to 186.

**The identity check reads each question's own text.** The content-anchor
check ranks a sample of answer entries against each question and asks how
often the question's own answer comes first. It used to rank page-range text,
and on a page holding three questions a question's range is mostly its two
neighbours, and so is its answer's. On the 2024 analysis pair, with the text
its pages hide removed (next section), that scored 0 of 24 and rejected a
valid pair. It now ranks each entry's own text — between its printed heading
and the next, or its bookmark and the next — and falls back to the range only
where an entry has none. Valid pairs score 1.000, 0.625 and 0.792 on the
text layer as read, 1.000, 0.667 and 0.833 on printed text; the wrong pairs of
the corpus at most 0.083 either way.
`src/pair-verifier.js`, `test/test_structure.js` §9.

**Recognised text cannot ground a hard rejection.** The 40% anchor line was
measured on text layers. Text a recogniser produced may confirm a pair but its
disagreement is missing evidence, which a binding resolves. The case that
motivated the rule (the analysis pair at 0.25 on formulas alone) was measured
on regions that included the hidden text; on printed regions and own text the
pair verifies. The rule stays: a recogniser that misreads should cost recall,
never the pair.

## The 2024 留白 books hide most of their text layer

The two 2024 exercise books (`exam-004` analysis, `exam-005` algebra) are
built by embedding a compact typesetting of their questions: each page draws
its own running head and page number, then one or more form XObjects, each a
whole page of that typesetting, clipped to one question's window
(`… cm x y w h re W n … /fzFrm0 Do`). Text extraction ignores clipping —
pdf.js, pdfminer and PyMuPDF alike — so each page's text layer holds the whole
embedded page: the question printed in the window and every neighbour the clip
hides. (It is the neighbouring questions, not their answers: of the hidden
lines, 21 of 1,565 in the analysis book open with 解, 证明 or 分析.)

| Book | Clipped pages | Windows (= questions) | Windows drawing more than one form | Exercise lines, text layer → printed |
|---|---|---|---|---|
| 2024 Analysis | 195 of 200 | 271, up to 3 a page | 15 (14 of two, one of three) | 12,790 → 2,130 |
| 2024 Algebra | 186 of 197 | 217 | 9 | 8,322 → 1,846 |

The 2023 exercise book and every answer key are native: no clips. An earlier
version of this note explained the 2024 books' collapse under a
bookmark-to-bookmark window as a "listing page then reprints" layout. That was
wrong; the window was swallowing hidden text.

A window drawing more than one form shows a question that runs over two
pages of the original; each form is cut by its own `/BBox` to its part of the
window, and inside the window each form's text outside its part lies hidden
under the other's. Read through the window alone, those pages doubled every
glyph (`{ { a a n n } }` for `{ a n }`) and put a hidden section heading into
two algebra windows.

Reading only what is printed: `ocr/clip_windows.py` lists each page's windows
and writes a split PDF — one copy per form drawing only that form, plus a
native copy per clipped page carrying its running head — with a map giving,
per copy, the part of the page that form paints (its window cut by its
`/BBox`). `tools/formula-regions.mjs --map` and `tools/extract-books.mjs
--split --map` read the split and keep only what lies inside each copy's part,
reported on the original page. `ocr/test_clip_windows.py` covers the parsing.

What this does to the text path, which today reads the hidden text exactly as
the app's pdf.js layer does:

| Pair | Strict recall, text layer as read | Strict recall, printed text only | Wrong |
|---|---|---|---|
| 2023 | 506 / 508 | 506 / 508 | 0 |
| 2024 Analysis | 183 / 271 | 213 / 271 | 0 |
| 2024 Algebra | 191 / 217 | 208 / 217 | 0 |

The hidden text costs the text path 30 and 17 strict answers on these books.
A host that extracts clip-aware gets them back. It also moves one guard: on
printed text, `test_real_pdfs`'s alphabet check reads the 2023 exercise book
against the 2024 analysis book at 0.9178, over its 0.90 line, and that
assertion fails (22 of 23 pass). The check is consulted only for OPAQUE text
(`textIsComparable`); on decoded text, containment of the smaller alphabet
measures shared vocabulary, and unrelated decoded books already cross 0.90 in
the corpus as read (the 2025 key against the 2023 exercise book, 0.9638). The
pair that now fails stayed under the line only by the hidden text's extra
glyphs. Restate that test against garbled text — a synthetic per-book glyph
substitution would do — rather than move the threshold.

## Measurement: `tools/ocr-ablation.mjs`

The three 考研 exercise books have a text layer and question bookmarks, so
each can play a scan: hide its text layer, hand the engine its formula
regions, score every automatic answer against the bookmark oracle. Regions
come from `tools/formula-regions.mjs` (the text layer; the oracle), and the
model reads the same boxes through `ocr/ocr_pages.py --regions ... --bundle`.

```sh
B=ocr/models/formula-scratch-kv-int8-texteller-r10
# 2023: native pages
node tools/formula-regions.mjs --pdf Q2023.pdf --out tmp/q2023-regions.jsonl
# 2024: read through the split so hidden text never becomes a region
python -m ocr.clip_windows --pdf A2024.pdf --output tmp/a2024-windows.json \
  --split tmp/a2024-split.pdf --map tmp/a2024-split-map.json
node tools/formula-regions.mjs --pdf tmp/a2024-split.pdf --map tmp/a2024-split-map.json \
  --out tmp/a2024-regions.jsonl
# the model, cropping the original pages (a clipped page renders only its window)
python -m ocr.ocr_pages --pdf A2024.pdf --regions tmp/a2024-regions.jsonl --bundle $B \
  --output tmp/a2024-model.jsonl
node tools/ocr-ablation.mjs --corpus CORPUS.json --exercise a2024 --answer a2024_ma \
  --regions tmp/a2024-model.jsonl --compare tmp/a2024-regions.jsonl --policy STRICT --tap
```

`CORPUS.json` here is the printed-only corpus (`tools/extract-books.mjs
--split --map` for the two 2024 exercise books); `--compare` reports, region
by region, how often the reading equals the text layer's.

Three readings per pair. *Window*: each question's text is every region
between its bookmark and the next. *Tap*: each question's text is every region
between its printed heading and the next, which is what the reader's tap
supplies on a scan. *Calibrated*: the policy the product ships with ids, where
a bookmark id resolves the question and the formulas are evidence rather than
a veto.

## Results: the model against the oracle

Distinct questions answered automatically, exercise book's text layer hidden,
printed regions only. Every reading, under either policy, on all three pairs:
**zero wrong answers**.

| Pair | Pair verdict (anchor top-1), oracle → model | Strict, window: oracle → model | Strict, tap: oracle → model | Calibrated, both | Regions read exactly as the text layer |
|---|---|---|---|---|---|
| 2023 | VERIFIED 0.917 → VERIFIED 0.792 | 371 → 237 of 508 | 356 → 224 | 508 / 508 | 2,049 / 2,683 (76.4%) |
| 2024 Analysis | VERIFIED 0.542 → VERIFIED 0.542 | 162 → 82 of 271 | 168 → 85 | 271 / 271 | 1,087 / 1,638 (66.4%) |
| 2024 Algebra | VERIFIED 0.792 → VERIFIED 0.750 | 174 → 116 of 217 | 178 → 116 | 217 / 217 | 818 / 1,072 (76.3%) |

What recognition costs, in the engine's terms:

- **All three pairs verify on the model's formulas alone.** The identity check
  never saw the text layer.
- **Strict recall is about two thirds of the oracle's on 2023 and algebra, half
  on analysis**, and nothing wrong gets through. The lost questions are capped,
  not misanswered: questions with a formula conflicting with the key rise from
  75 to 124 (2023), 51 to 82 (analysis), 20 to 33 (algebra); questions whose
  formulas the key covers fully fall from 365 to 223, 165 to 86, 166 to 112.
- **Calibrated recall is unchanged**: a bookmark id resolves the question
  whatever the formulas say. That is the product's path when ids exist; the
  strict figures are the evidence available when they do not.

Where the readings differ from the text layer (`--compare`, mean similarity
0.882, 0.809, 0.880):

- **Short regions are read best**: identical for 81% / 65% / 79% of regions of
  one to three characters, 58% / 31% / 78% of regions over twenty.
- **About a quarter of the disagreements are the text layer's quirks, not the
  model's errors** — 369 of 1,439: the model reads ≠ where the layer has `6=`
  (64), a radical the layer dropped (80), a fraction the layer splits into two
  rows (225). The answer keys carry the same quirks (`x 6 = 0` 189 times in
  the 2023 key), so a correct reading there still conflicts with the key.
- **Lone limit subscripts degenerate.** Regions of about 21 × 12 points holding
  only `x→0` under a `lim` come back as stacked `\tiny` bullets: 40 of 5,393
  regions. Eight readings ran out of tokens without an end marker; none came
  back blank (the two that had were hidden headings, now gone).

## What this tells the model, and the engine

Three things the measurements point to; only the third has been measured
for what it recovers:

1. **Read the text layer's quirks the way the model reads the print.** A
   font-aware rule in the adapter (`6` drawn from a maths symbol font before
   `=` is ≠; a radical glyph is √) makes the key agree with a correct reading.
   It must be font-aware: `2x+6=0` is also `6=` in text.
2. **Crop blocks, not runs.** A `lim` with its subscript, a fraction with both
   rows, as one crop. The detector that replaces `tools/formula-regions.mjs`
   on a scan should be measured against these regions, and the fraction form
   `latexToText` emits should match what the key's text layer shows for the
   same print.
3. **Clip-aware extraction in the host.** Independent of OCR: 30 and 17 strict
   answers on the 2024 books.

The open problem is still a book with no question bookmarks, which is every
textbook in `datasets/books-20260924`. There the answer has to be found by
content inside the aligned section, and on the 2023 pair the oracle's formulas
rank the right answer first for only 40% of questions by the engine's
similarity, with margins below 0.1 for 90% of them. Answer entries there are
whole solutions; the question's few formulas are a small part of a long text.
A coverage-based ranking did no better. This needs a textbook pair with a
text-layer answer book — 绿皮书 (book-026 against book-044) is the first
candidate — and now that the model runs here, its regions on book-026's
scanned exercise sets.
