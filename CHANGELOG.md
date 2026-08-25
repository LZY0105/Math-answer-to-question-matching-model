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

Not measured: Android on-device performance and memory. Every real question
resolves at stage 0 by bookmark id, so **stages 1–3 have never run against a real
book** — a pair whose ids do not correspond would exercise them for the first
time. The `SIMILARITY_STRONG` and `SIMILARITY_WEAK` thresholds were inherited
rather than swept.

The test corpus is extracted text from copyrighted textbooks and is not
committed; `tools/extract-corpus.mjs` rebuilds it, and the real-PDF suite skips
cleanly without it.
