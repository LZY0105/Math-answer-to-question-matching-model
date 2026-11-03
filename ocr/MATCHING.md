# The formula recogniser and the matching engine

How a formula-only recogniser feeds the engine, what was changed to make its
output usable, and what the output is measured to do. Measured on 2026-11-03
with the engine's own recogniser contract fed by an *oracle*: the formulas a
text layer holds, read region by region through the demo adapter, standing in
for the model until its bundle is available in this environment. The model
itself was not run here; every figure below is an upper bound on what
recognition can deliver and a floor on what the engine does with it.

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

Four things had to change in the engine for that list to mean anything.

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

**Recognised text cannot ground a hard rejection.** The identity gate's 40%
content-anchor line was measured on text layers. Read as formulas alone, the
2024 analysis book ranked its own answer key first for 25% of sampled
questions — a valid pair, and it was rejected. Recognised text may now
confirm a pair (the 2023 and algebra pairs verify on formulas alone, at 0.54
and 0.46) but its disagreement is missing evidence, which a binding resolves.

## Measurement: `tools/ocr-ablation.mjs`

The three 考研 exercise books have a text layer and question bookmarks, so
each can play a scan: hide its text layer, hand the engine its formula regions,
score every automatic answer against the bookmark oracle. Regions come from
`tools/formula-regions.mjs` (text layer; the oracle) or from
`ocr/ocr_pages.py --regions ... --bundle ...` (the model, same boxes).

```sh
node tools/formula-regions.mjs --pdf BOOK.pdf --out tmp/q2023-regions.jsonl
node tools/ocr-ablation.mjs --corpus ../exam-corpus/data.json --exercise q2023 --answer ans2023 \
  --regions tmp/q2023-regions.jsonl --policy STRICT --tap
```

Three readings per pair. *Window*: each question's text is every region
between its bookmark and the next. *Tap*: each question's text is every region
between its printed heading and the next, which is what the reader's tap
supplies on a scan. *Calibrated*: the policy the product ships, where a
bookmark id resolves the question and the formulas are evidence rather than a
veto.

| Pair | Pair verdict on formulas alone | Strict, window | Strict, tap | Calibrated | Wrong | Text-layer strict, for scale |
|---|---|---|---|---|---|---|
| 2023 | VERIFIED (anchor top-1 0.54) | 371 / 508 | 356 / 508 | 508 / 508 | 0 | 506 |
| 2024 Analysis | UNKNOWN (0.25; was REJECTED) | 21 / 271 | 122 / 271 | 271 / 271 | 0 | 183 |
| 2024 Algebra | VERIFIED (0.46) | 21 / 217 | 134 / 217 | 217 / 217 | 0 | 191 |

The window reading collapses on the 2024 books for a reason that is the
books', not the engine's: the 留白 editions print every question of a section
on a listing page and then reprint each on its own page, and the bookmarks
point to the listing for the first question and the reprints for the rest.
A window from one bookmark to the next swallows the listing. The tap reading
is the one that corresponds to the product, and it is what to compare.

Zero wrong answers in every reading, under either policy, on all three pairs.

## What this does not measure, and what it tells the model

Nothing here has seen the model's output. The oracle reads the text layer's
own glyphs; the model will drop, substitute and reorder tokens, and the
`ocr/evaluate_matching.py` retrieval figures (top-1 around 96% against
TexTeller references) are about formula-to-formula retrieval, not about this
engine's gates. The next measurement is the same harness on the model's
regions, which needs the exported bundle in this environment:

```sh
python -m ocr.ocr_pages --pdf BOOK.pdf --regions tmp/q2023-regions.jsonl --bundle BUNDLE --output tmp/q2023-ocr.jsonl
node tools/ocr-ablation.mjs ... --regions tmp/q2023-ocr.jsonl --policy STRICT --tap
```

The gap between that run and the oracle is the recogniser's cost in the
engine's own terms: questions the strict gate stops confirming because a
digit or an exponent came back different.

Two things the oracle already shows the recogniser will need:

- **Regions, not pages.** The engine's expressions are the recogniser's regions.
  A crop that spans two formulas, or half of one, is the error that costs most,
  because it reads as a conflict against the answer key.
- **A tap, not a window.** Without printed headings the bookmark tree bounds a
  question only where the book's layout cooperates. The product has the tap;
  the harness's `--tap` reading is the one to track.

The open problem is a book with no question bookmarks at all, which is every
textbook in `datasets/books-20260924`. There the question's answer has to be
found by content inside the aligned section, and on the 2023 pair the oracle's
formulas rank the right answer first for only 40% of questions by the engine's
similarity, with margins below 0.1 for 90% of them. Answer entries there are
whole solutions; the question's few formulas are a small part of a long text.
A coverage-based ranking did no better. This needs a textbook pair with a
text-layer answer book — 绿皮书 (book-026 against book-044) is the first
candidate — and the model's regions on its scanned exercise sets.
