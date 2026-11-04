# The formula recogniser and the matching engine

How a formula-only recogniser feeds the engine, what was changed to make its
output usable, and what the repository's own model is measured to do with it.
Measured on 2026-11-03 and 2026-11-04 with the bundle committed at
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
`1/(x+1)`, `\alpha \leq \beta` into `α≤β`, `\lim_{x\to 0}` into `limx→0`,
`x \not= 0` into `x≠0` — the forms the demo adapter reads off a text layer for
the same print. The report's §7.5 is the reason: a change of representation
moves every threshold.

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

## The reader: what the text layer says against what the page prints

A recogniser reads the print. The answer key is read off its text layer, and
so is the oracle; wherever the text layer says something the page does not
show, a correct reading conflicts with the key. Four places where it did, all
fixed in the demo adapter (`demo/pdfjs-document-adapter.mjs`), which the corpus
and the region tools read through:

**≠ and √.** Computer Modern prints ≠ as a zero-width slash (cmsy 0x36,
extracted as the digit `6`) over `=`, so `x ≠ 0` read `x 6 = 0`; and it hangs
a radical from its top, so the sign's baseline sits 0.83 of its size above
the radicand's and the sign fell onto a line of its own. `readMarks` merges a
zero-width overlay into the relation under it (≠, ≢, ↦ …) and moves a radical,
and an n-th root's index, onto the radicand's line. 676 zero-width `6`s and
1,222 radicals in the four books measured.

**Text the page clips.** The 2024 books clip most of what they draw (next
section). `pageTextItems` replays the clip state from pdf.js's operator list —
transforms, clip paths, each form's matrix and `/BBox`, through nested forms —
marks every glyph painted or clipped, and keeps a text item only when the
glyph run at its position that spells its opening is painted. Matching by
place rather than by order matters: pdf.js drops every glyph outside the page
box before it builds items, and two forms can start different text at the
same point. On by default; `openPdfDocument(file, { clipAware: false })`
reads every glyph as before.

**Display fractions.** Numerator and denominator sit 0.68 of the type size
above and below the main baseline, so they were lines of their own and the
main line read `a n = 1 + + · · · + − ln n`. The bar is drawn, not typed;
the operator list has it. `readFractions` rebuilds each fraction from its bar
(innermost first; a radical's vinculum is not a bar) as one item reading
`( a ) / ( b )` — bracketed as `latexToText` brackets — on the main line,
with a box spanning both parts.

**Limit subscripts.** `x → 0` under `lim` sat on its own line, often sharing
it with the denominator of the fraction that followed. `readLimits` moves it
after the operator (`lim x → 0`), keeping the box it is printed in.

The last two change the crops as much as the text: a region's box is the
union of its items' boxes, so the model now reads `\lim_{x\to0}\frac{…}{…}`
whole instead of a main line cut through both halves of a fraction and a
21 × 12 point subscript on its own.

## The 2024 books hide most of their text layer

The two 2024 exercise books (`exam-004` analysis, `exam-005` algebra) are
built by embedding a compact typesetting of their questions: each page draws
its own running head and page number, then one or more form XObjects, each a
whole page of that typesetting, clipped to one question's window. The two
2024 answer keys (`exam-002`, `exam-003`) embed every question statement the
same way: a form holding the full original page, cut to the question's box,
above the natively typeset solution. Text extraction ignores clipping —
pdf.js, pdfminer and PyMuPDF alike — so each of these pages' text layer holds
every neighbouring question. (Neighbouring questions, not answers: of the
hidden lines in the analysis exercise book, 21 of 1,565 open with 解, 证明 or
分析.) The 2023 and 2025 books read the same either way.

| Book | Lines as read | Lines printed |
|---|---|---|
| 2024 Analysis, exercise book | 12,699 | 2,174 |
| 2024 Analysis, answer key | 19,005 | 10,672 |
| 2024 Algebra, exercise book | 8,290 | 1,858 |
| 2024 Algebra, answer key | 12,785 | 7,354 |

In the analysis key, 例题 1.1 appeared five times as read, once printed. A
window drawing two forms (a question running over two embedded pages) cuts
each by its own `/BBox`; read through the window alone, those pages doubled
every glyph (`{ { a a n n } }` for `{ a n }`). An earlier version of this note
called the exercise books' layout "a listing page then reprints" and the
answer keys native; both were wrong.

`ocr/clip_windows.py` reaches the printed text by another route — a split PDF,
one copy per form, each cut by its window and `/BBox` — and stays as a
cross-check: on the analysis exercise book the two agree on all 271 question
headings; 61 of the 2,174 lines are only in the adapter's reading and 6 only
in the split's, mostly integral signs and large brackets at window edges,
which the split's centre test dropped and which are printed.

## Measurement: `tools/ocr-ablation.mjs`

The three 考研 exercise books have a text layer and question bookmarks, so
each can play a scan: hide its text layer, hand the engine its formula
regions, score every automatic answer against the bookmark oracle. Regions
come from `tools/formula-regions.mjs` (the text layer, through the adapter; the
oracle), and the model reads the same boxes through `ocr/ocr_pages.py`.

```sh
B=ocr/models/formula-scratch-kv-int8-texteller-r10
node tools/formula-regions.mjs --pdf A2024.pdf --out tmp/a2024-regions.jsonl
python -m ocr.ocr_pages --pdf A2024.pdf --regions tmp/a2024-regions.jsonl --bundle $B \
  --output tmp/a2024-model.jsonl
node tools/ocr-ablation.mjs --corpus CORPUS.json --exercise a2024 --answer a2024_ma \
  --regions tmp/a2024-model.jsonl --compare tmp/a2024-regions.jsonl --policy STRICT --tap
```

`CORPUS.json` is the corpus `tools/extract-books.mjs` builds through the same
adapter; `--compare` reports, region by region, how often the reading equals
the text layer's. A clipped page renders only what it paints, so the model's
crops of the original pages need nothing special.

Three readings per pair. *Window*: each question's text is every region
between its bookmark and the next. *Tap*: each question's text is every region
between its printed heading and the next, which is what the reader's tap
supplies on a scan. *Calibrated*: the policy the product ships with ids, where
a bookmark id resolves the question and the formulas are evidence rather than
a veto.

## Results

Every reading below, under either policy, on all three pairs: **zero wrong
answers.**

The text path — both books read through their text layers — strict-policy
recall:

| Change, cumulative | 2023 | 2024 Analysis | 2024 Algebra |
|---|---|---|---|
| Before this round, text as read | 506 / 508 | 183 / 271 | 191 / 217 |
| ≠ and √ read as printed | 506 | 184 | 191 |
| Only painted text, both books | 506 | 240 | 213 |
| Fractions and limits rebuilt | 506 | **248** | **213** |

The formula path — the exercise book's text layer hidden, its formula regions
read by the oracle and by the model — strict answers by tap (by window in
brackets):

| Change, cumulative | 2023 oracle | 2023 model | Analysis oracle | Analysis model | Algebra oracle | Algebra model |
|---|---|---|---|---|---|---|
| First model run | 356 (371) | 224 (237) | 168 (162) | 85 (82) | 178 (174) | 116 (116) |
| ≠ and √ read as printed | 359 (373) | 250 (264) | 170 (163) | 93 (88) | 178 (174) | 124 (124) |
| Answer keys read as printed | 359 (373) | 250 (264) | 175 (180) | 97 (96) | 178 (178) | 127 (130) |
| Fractions and limits rebuilt | **375** (389) | **289** (264) | **205** (211) | **160** (158) | **180** (180) | **128** (130) |

Calibrated recall is 508 / 271 / 217 throughout: a bookmark id resolves the
question whatever the formulas say. The pair verdict on formulas alone (content
anchors, top-1) went from 0.792 / 0.542 / 0.750 on the model's readings to
0.792 / 0.792 / 0.875, and from 0.917 / 0.542 / 0.792 to 0.958 / 0.833 / 0.875
on the oracle's: VERIFIED for all three pairs in every row.

What recognition still costs, measured on the last row:

- **Strict recall is 77% of the oracle's on 2023, 78% on analysis, 71% on
  algebra** (it was 63%, 51%, 65%). The lost questions are capped, not
  misanswered: questions with a formula conflicting with the key number 129,
  50 and 32 against the oracle's 59, 17 and 22.
- **The model reads 81%, 74% and 80% of regions exactly as the text layer
  does** (it was 76%, 66%, 76%), mean similarity 0.924, 0.860, 0.908.
  Regions of four to eight characters read best (88%, 93%, 82% identical);
  regions over twenty characters worst (54%, 40%, 73%), and on analysis the
  shortest too (59% of one to three characters).
- **The text layer's own quirks are nearly gone from the disagreements**: the
  model reads ≠ where the layer has `6=` once (64 before), a radical the layer
  dropped 5 times (80), a fraction the layer split 23 times (225).
- **Stacked-bullet readings of lone subscripts**: 4 regions (40 before). Four
  readings ran out of tokens; none came back blank.

## A real scan: the 绿皮书 (book-026 against book-044)

The first pair in the textbook release with a scanned exercise side and a
text-layer answer book. book-026 is a 492-page scan whose only text is a
watermark; its 87 bookmarks stop at the exercise set (习题 1.1). book-044 has
sections only and numbers its answers inside each section: `1. (1) − 2 .
(2) 1 .`

Two findings from chapters 1 and 2, 13 exercise sets, 95 exercises:

- **The answers do not restate the questions.** 习题 1.1's first exercise asks
  for two determinants; its answer is `−2` and `1`. A formula-content match
  has nothing to find. What identifies an exercise here is its set (the
  bookmark, aligned with the answer book's section) and its printed number.
- **The model reads the printed numbers.** `ocr/scan_line_starts.py` finds each
  text line of a scanned page, crops its first ink cluster and asks the model:
  92 of the 95 exercise numbers come back, in order, at the exercise margin —
  all 38 in chapter 1, 54 of 57 in chapter 2 (2.3 #6, 2.5 #1 and 2.6 #7 are
  missed). Scored against the answer book's own numbering, a number counting
  only when it continues its set's run. The same crops read the determinants themselves
  (`(1)\begin{vmatrix}1&2\\3&4\end{vmatrix}`). `ocr/ocr_pages.py --detector
  ink`, written for clean renders, finds no lines on these pages at all: the
  binding shadow inks 72–89% of pixel rows, and the shadow changes sides with
  the page.

### Exercises by set and printed number

The engine now indexes this pair at the level its numbering lives on
(`src/exercise-sets.js`). In an exercise book, a bookmark that names a set
(习题, 练习, Exercises, Problems) is split into one entry per exercise, `1.1.3`,
from the numbers the recogniser reads at the starts of lines inside it. An
answer book whose outline stops at sections is indexed `section.number` from
the `k.` lines its text layer prints inside each section. `1.1.3` resolves
only through the outline alignment: the set's own section, by the outline's
nesting, must be paired with the answer's section. The ids are used only
when both books carry them; otherwise each book is matched on the index it
had before (the sets whole, the body parse).

A read number is trusted only while its sequence holds, and an exercise is
never answered automatically when:

- its set counts a different number of exercises than its answer section;
- a number is skipped before or after it (the unread exercise's text sits in
  its neighbour's band, and a misread digit looks exactly like this);
- a line inside it opens like an exercise and is not one of the run, or, on
  the answer side, inside its answer;
- its number sits off the margin its set's other numbers share on the page
  (judged when the recogniser says where a line starts: `left` or `x0`).

A comma ends a number only when nothing follows it: a bare `3,` is a scanned
`3.` (twice in the book), `1, ⋯, 1, λ−1` is a list (chapter 7 opens many
lines with them). The last exercise of a set ends at the first break wider
than three line heights below it, and an exercise that runs over a page break
never claims the next page's running head.

Over the whole book (492 pages read by `ocr/scan_line_starts.py`, 12,306 line
starts; indexing from those readings takes 0.3 s): 66 of the 69 numbered sets
split into **508 exercises**. The answer book numbers 527, so 19 are not
indexed. Three sets stay whole because fewer than two of their numbers were
read in order. One tap per exercise, at its printed number:

| | Pair | Automatic | Review | Located | Wrong |
|---|---|---|---|---|---|
| Not bound | UNKNOWN_PAIR | 0 | 507 | 1 | 0 |
| Bound, strict policy | VERIFIED_PAIR | **295** / 527 | 212 | 1 | 0 |
| Bound, calibrated policy | VERIFIED_PAIR | **466** / 527 | 41 | 1 | 0 |

Unbound, the pair stays UNKNOWN: an answer book that states results has no
language by which to show it is one. A binding settles that, but only for an
answer book indexed by section and printed number. Every other unconfirmable
role stays unconfirmed, bound or not. Under the strict policy the formula
gate still applies to these ids, and the answers' results rarely restate an
exercise's formulas (103 formula sets missing, 44 extractions incomplete, 36
conflicts). The 41 left for review under the calibrated policy are 26 in the
three sets whose count disagrees with the answer book's (7.4 reads 9 against
12, 8.4 reads 12 of 13 against 14, 10.1 reads 6 against 5), 14 beside a
skipped number and 1 beside a stray. 10.1.6 finds no answer and is located.

**How "wrong: 0" was checked.** Not by the label lookup, which would agree
with itself by construction. Every automatic answer's tap point was cropped
from the page image and set beside the engine's id: the printed number
matches in all 466. Every set's crop shows its 习题 heading directly above the
first exercise read. Every last exercise's band, and every next-page part of
an exercise that crosses a page, was drawn on the page and checked to stay
inside its exercise. The answer side was spot-checked by content: 1.4.6's
answer quotes the exercise's coefficient rows, and 5.7.9's polynomial has
exactly the roots the exercise asks for.

That check found three faults, each fixed before the figures above:

- `1,\cdots`, a list in a worked example above 习题 7.5, read as exercise 1
  (the set's own `1.` was read without its period). This is why a comma must
  stand alone.
- The last exercise's band, estimated from the median exercise height, ran
  into the next section's heading four times, once into its first paragraph.
- Bands of exercises that cross a page break took in the next page's running
  head and the scanner's edge; 27 of the 39 such bands held nothing else.

Wrong pairs: the 绿皮书 against the PDE, ODE and real-analysis answer books
(049, 061, 043), and the answer book against the probability, abstract-algebra
and algebra exercise books with text layers (023, 028, 063): 0 automatic
answers, bound or not.

## What is left

1. **The 绿皮书's remaining numbers**: 19 exercises unindexed — eight sets'
   first number, five numbers inside sets, three at the end of 习题 7.4 and
   four in the three sets left whole, less one extra reading in 10.1. Each is
   a number the reader did not return as `k.`; the engine already flags the
   exercises beside every one of them, so a better reading recovers them
   without engine changes.
2. **The model's remaining gap** — a quarter of the oracle's strict answers.
   Long regions are where it reads worst; whether that is the crop or the
   model is the next measurement.
3. **The host.** The app reads through its own pdf.js layer
   (`pdf-document.js` in LaTeXSnipper_mobile, not reachable from this
   repository). `paintedGlyphs`, `paintedItems`, `paintedRules`,
   `readMarks`, `readFractions` and `readLimits` use only pdf.js's public API
   (`getTextContent`, `getOperatorList`, `OPS`) and port as they are; until
   they do, the app reads the 2024 books with their hidden text, as the corpus
   suites' first floors were set on. The operator list is what pdf.js paints
   from, so a host that renders the page has it already; in the extraction
   tools it is one extra pass per page.
