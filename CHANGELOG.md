# Development notes

This repository starts from a single commit. What follows is the arc that
produced it, kept because two of these findings are the kind a reader would
otherwise have to rediscover.

## The engine

Built to match exercise-book questions to a separate answer key, for a Chinese
maths study tablet. First version matched on question number plus whole-string
similarity. Testing it against four real 考研数学 PDFs — rather than the
hand-written fixtures it had been developed against — broke it in three ways:

**Hierarchical ids were being truncated.** Questions are numbered `1.1`, `1.200`,
`2.231`. Parsed as flat integers, 508 distinct questions collapsed onto 2
identifiers. Subquestion markers `(1)` `(2)`, which restart inside every
question, were being promoted to top level and manufacturing hundreds of
duplicate `1`s.

**Answer ranges were per page, not per question.** Several questions share a
page, so the last one on it silently governed the search for the first.

**Nothing refused.** Ambiguity was resolved by whichever candidate scored
highest, which is the one failure the engine exists to prevent.

The result is the four-stage ladder in the README, with confidence derived from
how many independent signals agree and kept deliberately separate from the
alignment, so the ordering constraint cannot manufacture certainty.

## Two findings worth keeping

**A positional prior looked right and was not.** With no table of contents, a
question 30% through the exercise book should pair with an answer near 30%
through the key — the Gale–Church idea. It accepts only when exactly one
candidate falls inside the expected window, so it separates rather than ranks,
which seemed safe. Measured: on parallel books it lifts recall from 0% to 100% at
full precision; on books that are *not* parallel, precision collapses to 0–19%,
returning 120 of 120 wrong answers at `MEDIUM` confidence. Being alone in the
window is not evidence of being right. It ships off by default
(`src/positional-prior.js` carries the numbers). Content resolves the same cases
at 100% precision, because similarity does not care what order the books are in.

**A confident diagnosis was wrong.** All four books extracted as 0–1.9% Han
characters — Chinese textbooks containing no Chinese — and were diagnosed as
having broken embedded CJK fonts. Considerable machinery followed from that:
a text-quality state for "unreadable but internally consistent" text, and a
learner that recovers a font's substitution table by watching OCR read a page.

The fonts were fine. **pdf.js cannot decode CID-keyed CJK fonts without cmaps**,
and neither the corpus extractor nor the host app supplied them. Same PDF, same
line:

```
without cmaps   ২ี 1.1 2023.॓࿐ჽն࿐ ჰ PDFֻ4 ်
with cmaps      例题 1.1 2023. 中国科学院大学 原 PDF 第 4 页
```

`TEXT_QUALITY.OPAQUE` and `src/glyph-map.js` are kept — genuinely broken embedded
fonts do occur, and both are correct and tested — but if you hit `OPAQUE`,
**check your reader's configuration before concluding anything about the
document**. The quality gate itself is the reason the mistake surfaced at all
rather than the engine quietly matching noise at ordinary confidence.

## What is measured, and what is not

Against the real 2023 pair: 508/508 questions resolved, zero wrong matches, 100%
`HIGH`-confidence precision, per-page p95 0.01 ms, 9 ms to index the 372-page
key. The 2024 volumes index at 271 and 217, all ids distinct.

Stages 1–3 are measured too, by stripping the bookmark trees and scoring what
remains against an oracle built *from* those trees — see
`test/test_no_bookmarks.js`. Precision holds at 100% in all four regimes, with
zero wrong matches in each. Recall is another matter:

| Regime | Correct | Wrong | Distinct questions |
|---|---:|---:|---:|
| A. both books bookmarked | 794 | 0 | 470 |
| B. answer key not bookmarked | 717 | 0 | 429 |
| C. exercise book not bookmarked | 2 | 0 | 2 |
| D. neither bookmarked | 44 | 0 | 44 |

Regime B was 8 distinct questions before the printed-contents work; reading the
table of contents as a label-to-location index is what moved it. Regime C is
still all but dead, and saying so is more useful than averaging it away.

Per-page cost rises with the same loss of structure, and the range across the
three matched pairs matters more than any single figure: 1–3 ms in regime A,
61–808 ms in B, 327–1,573 ms in C, 51–925 ms in D. The top of regime C has
reached the 1,500 ms alignment deadline, so results there are produced by expiry
rather than by decision — read them as "refuses within 1.5 s" until bounded
retrieval lands. The figures come from `figures/latency-by-regime.data.json`,
which `tools/measure-regimes.mjs` writes; an earlier revision hardcoded 507 ms
into the drawing script and it went stale silently.

That the engine refuses rather than guesses is the whole point, and it is now
demonstrated rather than asserted.

Not measured: Android on-device performance and memory. The `SIMILARITY_STRONG`
and `SIMILARITY_WEAK` thresholds were inherited rather than swept, and they only
bind once stages 2–3 run, which on a bookmarked corpus they never do.

The test corpus is extracted text from copyrighted textbooks and is not
committed; `tools/extract-corpus.mjs` rebuilds it, and the real-PDF suite skips
cleanly without it.

## A third finding: the tests did not cover the tools

`tools/ocr-cache.mjs` shipped with an unterminated character class — a regular
expression doing a job `path.dirname` does — and a full green test run said
nothing. Every suite imported from `src/`; none imported from or executed
anything in `tools/`. A file Node could not even parse was therefore "covered".

Two things came out of it. `test/test_tools.js` now runs `node --check` over
every shipped script, which is the cheapest test that could have caught this,
and it asserts the exit status of the two scripts that act as release gates.
Reintroducing the original defect turns the suite red, which is how the guard
was verified rather than assumed.

The second is a rule about gates. `tools/audit-ocr-matches.mjs` used to exit 0
when its inputs were absent, on the reasoning that a clean checkout should run
green. But an audit that returns success for a run that did not happen is not a
gate, and CI would have passed for the wrong reason indefinitely. It now fails
by default, and `--allow-skip` is how the clean checkout asks for the green in
the open. `tools/ocr-cache.mjs` fails closed the same way: it takes the page
count from the PDF instead of a constant, refuses to write a cache if any page
failed or came back empty, and stamps what it writes with the source hash,
recognizer statistics and generating commit.

A smaller correction alongside them: what the audit called `orderInversions` was
counting adjacent backward steps, not inversions. One label read far too early
is a single backward step but as many inversions as there are matches it jumped
over, so the name overstated the evidence. Both are now reported, separately.

## Scoring the same text once

`contentSimilarity` reads three signals off one normalised string — prose
bigrams, fragment bigrams and operator contexts — and used to re-normalise and
re-count both sides for each of them, on every call. Two loops score one text
against hundreds: the page alignment scores every question on a page against
every entry in its band, and pair verification scores two dozen sampled
questions against the whole answer index. Neither reused anything.

`textProfile` now computes all three once per text, and `profileSimilarity`
scores two profiles. The public `similarity`, `mathSimilarity` and
`contentSimilarity` are unchanged in signature and return bit-identical values
(checked over 9,000 random pairs against the previous implementation). The two
hot loops build their profiles once per side. On a synthetic 500-entry index of
3,000-character page-range texts, pair verification's content-anchor check fell
from 13.6 s to 1.7 s and a six-question page alignment over a 340-entry band
from 2.1 s to 0.5 s, with the same verdicts. The section lookup also stops
re-sorting the alignment on every question.

The README's "nothing is sampled" line was wrong for the safety matrix and the
ablation regimes, which run on a page stride in both the tests and the tools;
it now says so.

## The first books from outside the series

`datasets/books-20260924` is 63 volumes from other publishers and nine
subjects, kept as release assets. Twenty-two were read through the demo's
PDF.js adapter (`tools/extract-books.mjs`) and run through the public
interface; `datasets/books-20260924/EVALUATION.md` has the full account and
`test/test_books_20260924.js` asserts it. Every matched pair has a scanned
side, so the text path never runs end to end and nothing measured is a recall.
What the books did exercise found three defects in the gates that run before
matching:

- A bookmark per page, titled with the page number, read as a question level:
  326 and 213 phantom questions on two volumes. The classifier now recognises
  a flat integer cohort tracking the page counter as `PAGE_MARKER`.
- 习题 bookmarks were trusted as question markers by the classifier and given
  no id by the parser, so an 87-bookmark exercise book indexed as nothing.
  `idFromOutlineTitle` reads the classifier's marker vocabulary.
- Subject detection knew two subjects and named MATH_ANALYSIS on ODE, PDE and
  probability books. It knows ten now, names before topics, two-to-one margin,
  MIXED otherwise; the two original topic lists are unchanged.

Over 462 ordered pairings of the 22 volumes, zero automatic answers.

The 陈纪修 pair, two scanned volumes with bookmark trees for the same book,
aligned 40 of 41 sections to identical titles and located 355 of 381 pages —
and exposed a fourth defect: a region came from the last aligned section
starting at or before the page with no upper bound, so two shared titles
located 91 of 96 sampled pages of a wrong book. Regions are now bounded by the
aligned section's own span (which was itself ending at the node's first child
rather than the next section); the wrong book drops to 7 of 96.

## The 考研 corpus, re-uploaded

`datasets/exam-corpus-20260924` is the eight books the report's numbers come
from, as release assets. Running them found the demo adapter passing pdf.js
a `file://` URL for its CMap directory, which Node's `fs.readFile` rejects
and pdf.js ignores — every CJK font decoded as noise while extraction
reported success, the same misdiagnosis §7.2 of the report records. The
adapter passes paths now. The uploaded 2023 exercise book has section
bookmarks only, so the suites' 2023 assertions fail identically on every
branch; judged against the key's own bookmarks instead, the 2023 pair
resolves 288 of 508 through the public interface with zero wrong (main:
285). Getting there fixed the answer-side range as well: it stopped at a
chapter's first aligned section, and now uses the answer node's own span.
`datasets/exam-corpus-20260924/EVALUATION.md` has the account.
