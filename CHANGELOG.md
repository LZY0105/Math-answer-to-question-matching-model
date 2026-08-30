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

Against the real 2023 pair, the current default strict policy resolves 470/508
distinct questions and the calibrated policy resolves 508/508; both produce
zero wrong matches. On the 29 August 2026 run, per-page p95 was 3.17 ms and the
372-page answer key indexed in 308 ms. The 2024 volumes index at 271 and 217,
all ids distinct; strict-policy recall is 159/271 and 175/217, while the
calibrated policy restores full recall with zero observed wrong answers.

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
three matched pairs matters more than any single figure: 3–7 ms in regime A,
181–2,165 ms in B, 978–2,003 ms in C, and 144–1,874 ms in D on the 29 August
2026 full-book run. Most degraded pairs now fall to `UNKNOWN_PAIR` and emit no
automatic answer, so these are safe-degradation costs rather than ordinary
matching latencies. Several values exceed the 1,500 ms alignment deadline;
bounded retrieval remains outstanding. The figures come from `figures/latency-by-regime.data.json`,
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
