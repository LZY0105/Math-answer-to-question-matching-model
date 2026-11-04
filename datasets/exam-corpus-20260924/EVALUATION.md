# The uploaded 考研 corpus against the corpus suites

The eight PDFs of this release are the books the research report's numbers
come from. They were run through the three corpus suites on 2026-09-24, on
`main` and on the optimisation branch, after extraction through the demo's
PDF.js adapter (`tools/extract-books.mjs`). Two things decide how to read the
result.

## Two 2023 exercise books

The release first carried `2023年名校数学专业考研真题分类.pdf` (exam-006): 67
pages, two chapter and eighteen section bookmarks, no question level. The
suites expect `q2023` to carry 508 question bookmarks, one per 例题, and every
2023 assertion is built on that tree as ground truth, so on that file the
2023 checks failed identically on every branch with an empty oracle. The
留白作答版 (exam-009) added later is the book the report measured: 368 pages,
508 例题 bookmarks under 18 sections. The results below are on exam-009 as
`q2023`; the section on exam-006 is kept because it is the "exercise book
without bookmarks" regime arriving as a real file.

## The adapter was decoding CJK fonts as garbage

Every book first extracted with 0% Han. The demo adapter passed pdf.js its
CMap directory as a `file://` URL; under Node, pdf.js reads that directory
with `fs.readFile`, which rejects the URL string, and pdf.js swallows the
rejection. Every CID-keyed CJK font then decoded as noise while extraction
reported success — the exact misdiagnosis the report's §7.2 records from the
first time round. The adapter now passes filesystem paths. Extraction of the
same page went from 0 Han characters in 563 to 177 in 770.

## The suites on the real 2023 book

| Suite | main | branch |
|---|---|---|
| test_real_pdfs | 23 passed | 23 passed |
| test_no_bookmarks | 9 passed | 9 passed |
| test_corpus_regression | 25 passed, 1 failed | 25 passed, 1 failed |

| 2023 pair | main | branch |
|---|---|---|
| Strict-policy recall | 471 / 508 | 471 / 508 |
| Calibrated recall | 508 / 508 | 508 / 508 |
| Wrong, either policy | 0 | 0 |
| Per-page p95, bookmarked path | 1.66 ms | 1.61 ms |
| No answer bookmarks: distinct resolved, per-page p95 | 429, 125 ms | 429, 69 ms |
| No exercise bookmarks: distinct resolved, per-page p50 / p95 | 2, 443 / 644 ms | 2, 172 / 212 ms |
| Neither: distinct resolved | 44 | 44 |

Every verdict is identical between the branches. The degraded regimes, which
are the ones that score text, run two to three times faster on the branch;
that is the text-profile cache, and the worst regime is now well inside the
1,500 ms alignment deadline the report says it had reached.

The report's 470 strict is 471 here; the one-question difference is the
extractor (below). The single failure on both branches is the algebra floor.

## The section-only 2023 book (exam-006), for the record

Judged against the key's own bookmarks — an accepted answer is right when its
label equals the question's and its page falls inside that bookmark's span —
with a body-parsed exercise index of 509 entries:

| Public interface, calibrated policy | main | branch |
|---|---|---|
| Automatic answers over the whole book | 312 | 314 |
| Wrong | 0 | 0 |
| Distinct questions resolved, of 508 | 285 | 288 |

The branch's first run resolved 249 — below main — and the cause was in the
branch: bounding a located region by the aligned section's span (added for
the textbook release) exposed that the range on the answer side stopped at a
chapter's first aligned section, by the same next-node mistake fixed on the
exercise side. Main had been reaching those questions through a stale range
from the previous section that happened to overlap the right chapter. The
answer range now uses the answer node's own span, or the next aligned section
at the same or a shallower depth.

## The 2024 pairs, and what the algebra shortfall was

On the first run the algebra pair resolved 173 under the strict policy against
a floor of 175, identically on both branches, and the analysis pair 161
against 159. The 44 algebra questions withheld were 36 formula conflicts, 6
missing sets and 2 incomplete extractions, and the conflicts read like
`2x-5x2+x-1` against `2x3-x2+4x-1`: the same polynomial with digits missing
on each side. Two causes, found in that order.

**The entry-text cleaner deleted digits.** To remove a page number the
extractor had glued onto an expression, `createTextCleaner` deleted every
isolated occurrence of the entry's page numbers from its text. Question 2.3
sits on pages 3 and 4, so every lone 3 and 4 in it vanished: `2x^3 − 5x^2 + 4x
− 1` lost its cube and its 4, and `例题 2.3` lost the 3 of its own label
(extracting as `例题 2. .`). The raw pdf.js items had every digit. The cleaner
now drops only a line that is nothing but the page number. `src/entry-text.js`

**The adapter lost superscripts.** Rows were grouped by a 2.5-point baseline
tolerance. Body text at 10.5 pt puts subscripts 1.6 pt below the baseline,
inside that, and superscripts 4.4 pt above it, outside — so a line's exponents
assembled into a row of their own and the line read `x + x + 1` for
`x^3 + 3x + 1`. The adapter now attaches a smaller item to a larger row when it
sits within 0.7 of the row's font size and starts where one of the row's items
ends, in that item's whitespace. Bounds of ∫, ∑, ∏ and lim are excluded: they
sit beside their operator exactly as a script would, and the two books typeset
them differently enough that attaching them agreed on neither side.
`demo/pdfjs-document-adapter.mjs`

Strict-policy recall under each rule, with the cleaner fix in place. The floors
are the suite's, measured on the host app's reader.

| Row grouping | 2024 Algebra (175) | 2024 Analysis (159) | 2023 (470) |
|---|---|---|---|
| Baseline only, as before | 176 | 162 | 471 |
| Nearest baseline within reach | 175 | 154 | 481 |
| Adjacent to a base item | 176 | 154 | 475 |
| Adjacent, in the line's whitespace | 176 | 157 | 474 |
| …and not after a large operator | 176 | 159 | 474 |

Three engine changes made for the formula-recogniser path (see
`ocr/MATCHING.md`) then moved these again, with the row rule unchanged:

| Engine change, cumulative | 2024 Algebra (175) | 2024 Analysis (159) | 2023 (470) |
|---|---|---|---|
| Bookmark positions bound each entry's text | 186 | 184 | 474 |
| A line is an expression boundary | 191 | 175 | 507 |
| **…unless it wraps mid-expression** | **191** | **183** | **506** |

Zero wrong at every row. The line boundary is the large one: two rows of
display mathematics — a numerator and a denominator, the rows of a matrix —
had been joining into one expression on whichever side happened to break
differently, and reading as a conflict. The no-answer-bookmarks regime of the
2023 ablation rose from 444 to 492 distinct questions on the same change.

Zero wrong under every rule and every policy. The cleaner fix alone clears
every floor. Script attachment is a fidelity gain for inline exponents, worth
three questions on the 2023 pair, and a wash on the analysis pair, whose
questions are display mathematics — fractions, limits, integrals — that no
row rule reads consistently across two typesettings. The final rule is kept
because it reads what is printed; the row it replaced read `x` for `x^3`.

## What the 2024 exercise books hide

exam-004 and exam-005 are built by embedding pages of a compact typesetting of
their questions as form XObjects, each clipped to one question's window; a
question that runs over two embedded pages is drawn as two forms in one
window, each cut by its own `/BBox`. Text extraction ignores clipping, so the
text layer of every page holds the whole embedded page — the question in the
window and every neighbour it hides. The 2024 answer keys (exam-002,
exam-003) embed every question statement the same way, a full original page
cut to the question's box above the natively typeset solution — found on
2026-11-04, when the reader started replaying clips; this section's first
version said the keys clipped nothing. The 2023 and 2025 books read the same
either way.

| | Clipped pages | Windows | Exercise lines as read | Printed |
|---|---|---|---|---|
| exam-004 (2024 Analysis) | 195 of 200 | 271 | 12,790 | 2,130 |
| exam-005 (2024 Algebra) | 186 of 197 | 217 | 8,322 | 1,846 |

Every number above this section, and the suites' floors, were measured on the
text layer as read, hidden text included, which is what the host app's pdf.js
layer reads too. Read as printed (`ocr/clip_windows.py --split`, then
`tools/extract-books.mjs --split --map`), on 2026-11-03:

| Suite | As read | As printed |
|---|---|---|
| test_real_pdfs | 23 passed | 22 passed, 1 failed |
| test_no_bookmarks | 9 passed | 9 passed |
| test_corpus_regression | 26 passed | 26 passed |
| Strict recall, 2023 / Analysis / Algebra | 506 / 183 / 191 | 506 / 213 / 208 |

Zero wrong in both. The failure is the alphabet assertion: q2023 against
a2024 reads 0.9178 on printed text, over the 0.90 line (0.8375 as read). The
check is consulted only for OPAQUE text, and decoded books do not separate on
it — as read, the 2025 key against the 2023 exercise book is 0.9638. The test
should be restated on garbled text, not the threshold moved.

**The identity check now reads each entry's own text.** Its content-anchor
agreement ranked page-range text; on printed text the analysis pair's ranges
are mostly each page's other questions, and the valid pair scored 0 of 24 and
was rejected. On each entry's own text (`scopedText`, the lines between its
heading or bookmark and the next), top-1 agreement over 24 sampled labels:

| Pair | Range text, as read | Range text, printed | Own text, as read | Own text, printed |
|---|---|---|---|---|
| 2023 (valid) | 0.750 | 0.750 | 1.000 | 1.000 |
| 2024 Analysis (valid) | 0.625 | **0.000** | 0.625 | 0.667 |
| 2024 Algebra (valid) | 0.750 | 0.500 | 0.792 | 0.833 |
| Wrong pairings, worst of the five that share labels | 0.000 | 0.083 | 0.083 | 0.083 |

The line is 0.40. All three suites pass as read with the change, at the same
recall, and the textbook release suite still gives no automatic answer in 552
pairings. `src/pair-verifier.js`

The alphabet test has since been restated on simulated garbling (each Han
character through a substitution fixed by its font): one font across the 2023
pair reads 0.998 and is comparable, different fonts 0.25–0.29 and are not, as
read and as printed. test_real_pdfs passes 23/23 on both.

## Read as printed by the adapter, 2026-11-04

The demo adapter now keeps only the text a page paints (it replays the clip
state from pdf.js's operator list; `demo/pdfjs-document-adapter.mjs`), reads
≠ and √ as printed, and rebuilds display fractions and limit subscripts. Every
book is read that way by default, so the corpus built with the commands below
is the printed corpus. Lines as read and printed, same row assembly:

| Book | As read | Printed |
|---|---|---|
| exam-004, 2024 Analysis exercise book | 12,699 | 2,174 |
| exam-002, 2024 Analysis key | 19,005 | 10,672 |
| exam-005, 2024 Algebra exercise book | 8,290 | 1,858 |
| exam-003, 2024 Algebra key | 12,785 | 7,354 |

Strict recall, each change cumulative, zero wrong throughout:

| Change | 2023 | 2024 Analysis | 2024 Algebra |
|---|---|---|---|
| As read, before | 506 / 508 | 183 / 271 | 191 / 217 |
| ≠ and √ | 506 | 184 | 191 |
| Only painted text | 506 | 240 | 213 |
| Fractions and limits | 506 | 248 | 213 |

Suites on the last row: test_real_pdfs 23/23, test_no_bookmarks 9/9 (regimes
506 / 491 / 2 / 47), test_corpus_regression 26/26. The suites' floors were set
on the host app's reader and are below every figure here.

## Reproducing

```sh
node datasets/exam-corpus-20260924/download.mjs --all --out ../exam-corpus
E=../exam-corpus
node tools/extract-books.mjs --books $E --out $E/extracted \
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

Use exam-009 as `q2023`; exam-006 is the section-only variant.

As printed, replace `a2024` (and `g2024`, the same way) with its split
reading before building `data.json`:

```sh
A="$E/2024年名校数学专业考研真题分类_数学分析留白作答版.pdf"
python -m ocr.clip_windows --pdf "$A" --output $E/a2024-windows.json \
  --split $E/a2024-split.pdf --map $E/a2024-split-map.json
node tools/extract-books.mjs --force --geometry --books $E --out $E/extracted \
  --split $E/a2024-split.pdf --map $E/a2024-split-map.json "a2024=$A"
```
