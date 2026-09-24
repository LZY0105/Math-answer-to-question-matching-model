# The uploaded 考研 corpus against the corpus suites

The eight PDFs of this release are the books the research report's numbers
come from. They were run through the three corpus suites on 2026-09-24, on
`main` and on the optimisation branch, after extraction through the demo's
PDF.js adapter (`tools/extract-books.mjs`). Two things decide how to read the
result.

## The 2023 exercise book is not the one the suites were written against

The suites expect `q2023` to carry 508 question bookmarks, one per 例题, and
every 2023 assertion is built on that tree as ground truth. The uploaded
`2023年名校数学专业考研真题分类.pdf` carries 20 bookmarks: two chapters and
eighteen sections, no question level. That is the "exercise book without
bookmarks" regime the report measures as an ablation, arriving as a real
file. So on both branches the 2023 checks that read the exercise bookmark
tree fail identically, with an empty oracle, and none of those failures is a
regression. The 2024 pairs carry the trees the suites expect, and their
numbers are identical on both branches.

## The adapter was decoding CJK fonts as garbage

Every book first extracted with 0% Han. The demo adapter passed pdf.js its
CMap directory as a `file://` URL; under Node, pdf.js reads that directory
with `fs.readFile`, which rejects the URL string, and pdf.js swallows the
rejection. Every CID-keyed CJK font then decoded as noise while extraction
reported success — the exact misdiagnosis the report's §7.2 records from the
first time round. The adapter now passes filesystem paths. Extraction of the
same page went from 0 Han characters in 563 to 177 in 770.

## What the 2023 pair measures now

The exercise index is body-parsed (509 entries); the answer index is the
key's 508 bookmarks. Correctness is judged against the key's own bookmarks:
an accepted answer is right when its label equals the question's and its page
falls inside that bookmark's span.

| Public interface, calibrated policy | main | branch |
|---|---|---|
| Automatic answers over the whole book | 312 | 314 |
| Right by label and span | 312 | 314 |
| Wrong | 0 | 0 |
| Distinct questions resolved, of 508 | 285 | 288 |

| Direct `matchPage` loop (test_real_pdfs) | main | branch |
|---|---|---|
| Distinct questions resolved, strict policy | 204 | 207 |
| Distinct questions resolved, calibrated policy | 285 | 288 |

The branch's first run resolved 249 through the public interface and 183
directly — below main — and the cause was in the branch: bounding a located
region by the aligned section's span (added for the textbook release) exposed
that the range on the answer side stopped at the chapter's first section, by
the same next-node mistake fixed on the exercise side. Main had been reaching
those questions through a stale range from the previous section that
happened to overlap the right chapter. The answer range now uses the answer
node's own span, or the next aligned section at the same or a shallower
depth. One question main resolves and the branch does not (2.206) sits in a
section the alignment missed on both sides; the branch gains four.

## The 2024 pairs

| Pair | Strict-policy recall | Floor in the suite | Wrong |
|---|---|---|---|
| 2024 Mathematical Analysis | 161 / 271 | 159 | 0 |
| 2024 Advanced Algebra | 173 / 217 | 175 | 0 |

Identical on both branches. The algebra pair sits two below its floor, and the
floor was measured on text extracted through the host app's own reader with
its own line grouping; this extraction groups lines by a 2.5-point baseline
tolerance in the demo adapter. A two-question difference in strict formula
coverage between two extractors of the same PDF is within what §7.5 of the
report describes.

## Reproducing

```sh
node datasets/exam-corpus-20260924/download.mjs --all --out ../exam-corpus
E=../exam-corpus
node tools/extract-books.mjs --books $E --out $E/extracted \
  "q2023=$E/2023年名校数学专业考研真题分类.pdf" \
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

The suites' 2023 assertions will fail on this upload for the reason above
until a 2023 exercise book with question-level bookmarks is added to the
release.
