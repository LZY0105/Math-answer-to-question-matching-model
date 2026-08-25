# Find-Engine

[English](README.md) | [简体中文](README.zh-CN.md)

Matches exercise-book questions to their answers in a separate answer key, so a
student reading a textbook sees the answer for the question in front of them.

Given two PDFs with no shared identifiers beyond what is printed in them, it
decides which answer entry belongs to which question — or refuses.

Pure JavaScript, no dependencies, no network. Extracted from an Android maths
study tablet app, where it runs entirely on-device.

> **📄 [Research report](RESEARCH-REPORT.md)** — full design rationale,
> evaluation methodology, ablation study, parameter sweeps, and two documented
> negative results. Everything below is a summary; the report is the detail.

## The problem

Question numbers restart every chapter, so "12" is ambiguous across a book.
Content is thin — an answer entry often gives only the result. And the prose is
nearly identical: on a page of derivative exercises every question reads
求函数…的导数, so whole-string similarity cannot separate them.

Underneath all of it: **a wrong match is worse than no match.** A missing answer
is an inconvenience. A wrong one is presented with the same authority as a
correct one, the student cannot detect it, and everything downstream is then
confidently wrong about work that was right.

## How it works

Four stages, cheapest first. A question stops at the first one that resolves it.

| Stage | Signal | Resolves |
|---|---|---|
| **0** | Hierarchical question id from the PDF bookmark tree | An id present exactly once in both books |
| **1** | Monotonic, depth-aware table-of-contents alignment | Narrows to one chapter of the key |
| **2** | Math-weighted similarity with operator context | Duplicate or missing ids |
| **3** | Bounded Needleman–Wunsch alignment | Position, when content is thin |

On the 2023 corpus all 508 questions resolve at **stage 0** — the identifier is
the answer, and no content comparison happens at all.

**Operator context** is the one non-obvious piece. A bigram similarity is a
*bag*: it counts which pairs occur, not where. The discriminating information in
`x^2+3x` versus `x^3+5x` sits around the operators, so each operator is anchored
and a three-character window taken either side:

```
x^2+3x   ->   "··x^2+3"   "x^2+3x·"
x^3+5x   ->   "··x^3+5"   "x^3+5x·"
```

Neither token matches, where a bigram bag shares `x^`, `+` and `x`. Three is
measured, not conventional — the margin peaks there, and at six a pair inverts
outright. [Full sweep in the report](RESEARCH-REPORT.md#61-operator-context-window-radius).

![Discrimination margin against operator-context window radius](figures/radius-sweep.svg)

## Confidence, and the right to refuse

Confidence comes from **how many independent signals agree**, and is computed
separately from the alignment — the dynamic program decides *which* entry, the
per-question rules decide *how much to trust it*. Without that split, the
ordering constraint could manufacture certainty the evidence does not support.

| | Basis |
|---|---|
| `HIGH` | Exact bookmark id, or chapter aligned + number + content |
| `MEDIUM` | Two signals agree |
| `LOW` | One weak signal — shown with a visible caution |
| `NONE` | Refused. Candidate ids, pages and the reason are returned |

A duplicated id with no section alignment is **refused, never settled by
position**. The alignment always produces *some* assignment; accepting it would
turn genuine ambiguity into a confident wrong answer.

## Results

Against the real 2023 pair (368-page exercise book, 372-page key):

| | |
|---|---|
| Questions resolved | **508 / 508** |
| Wrong matches | **0** |
| `HIGH` confidence precision | **100%** |
| Per-page matching | p95 0.01 ms |
| Indexing the 372-page key | 9 ms |

Stripping the bookmark trees and scoring against an oracle built from them,
**precision stays at 100% in all four regimes** — zero wrong answers — while
recall collapses and per-page latency rises to 507 ms.
[Ablation methodology and full table](RESEARCH-REPORT.md#5-evaluation).

![Precision stays at 100% across regimes while the refusal rate climbs](figures/ablation-precision-refusal.svg)

## Usage

```js
import { indexAnswerDocument, indexQuestionDocument, questionsOnPage }
  from './src/answer-index.js';
import { alignOutlines, matchPage } from './src/question-matcher.js';

const questionIndex = await indexQuestionDocument(exerciseDoc, { expectScript: 'han' });
const answerIndex   = await indexAnswerDocument(answerDoc,   { expectScript: 'han' });
const alignment     = alignOutlines(exerciseDoc.outline, answerDoc.outline);

const matches = matchPage(
  questionsOnPage(questionIndex, currentPage),
  answerIndex,
  { alignment, exercisePage: currentPage, answerPageCount: answerDoc.numPages },
);

for (const m of matches) {
  if (!m.matched) continue;            // refused — show m.reason, m.candidates
  console.log(m.question.label, m.entry.answer, m.confidence, m.reason);
}
```

`expectScript: 'han'` tells the quality gate the book should be Chinese, which
catches a broken reader configuration that the noise rate alone would not.

### Document interface

The engine does not read PDFs. Supply any object exposing:

```js
{
  numPages: number,
  outline: { available: boolean, items: [{ title, pageNumber, depth, children }] },
  async extractText({ from, to }): Array<{ page: number, text: string }>,
}
```

In the host application these come from pdf.js, but nothing here depends on it.

### Numbering recognised

`1.` `12)` `15、` `第 9 题` `3．` and the hierarchical forms `1.1` `1.200` `2.231`
`例题 1.31` — anchored to the start of a line. `(7)` `（8）` are **subquestions**
of whichever question is open, never questions in their own right.

## Tests

```bash
npm test            # all six suites, 138 checks
npm run test:unit   # synthetic fixtures only
npm run test:real   # the real books, including the ablation
```

Most tests are about **refusing** rather than matching. The real-PDF suites need
a corpus of extracted text that is **not committed** — it derives from
copyrighted books. `tools/extract-corpus.mjs` rebuilds it; point
`FIND_ENGINE_CORPUS` at the result, or place it at `../find-engine-corpus/`.
Absent, those suites skip rather than fail, so a fresh clone runs green.

## Two things worth knowing before reuse

**A positional fallback is implemented and disabled.** It reaches 100% precision
on document pairs that are genuinely parallel and 0% on one that is not,
returning 120 of 120 wrong answers at `MEDIUM` confidence. A signal that cannot
detect its own inapplicability cannot honour "a wrong match is worse than no
match". [Measurements](RESEARCH-REPORT.md#71-a-positional-prior-that-fails-silently).

**If you hit `OPAQUE`, suspect your reader before the document.** The first
suspected case of broken embedded fonts turned out to be pdf.js missing its CMap
files. [What that cost and what it taught](RESEARCH-REPORT.md#72-a-confident-misdiagnosis).

## Related work

The alignment machinery is standard — dynamic programming, monotonic alignment,
similarity scoring. What is specific here is the domain: hierarchical question
ids, bookmark anchoring, mathematical-structure weighting, and a deliberate
right to refuse. Positioning against Gale–Church, Hunalign, Bleualign, Maligna,
Vecalign and Bitextor is in
[the report](RESEARCH-REPORT.md#2-related-work).

## Limitations

- Scanned books need OCR; the engine provides the seam, not the recogniser.
- Without a bookmark tree, recall degrades sharply — precision does not.
- Bigram similarity is language-agnostic but not semantic.
- Android performance is unmeasured; all figures are desktop.
- Tuned against Chinese mathematics textbooks. The approach is general; the
  constants are not.

[Threats to validity](RESEARCH-REPORT.md#8-threats-to-validity) in the report.

## License

MIT — see [LICENSE](LICENSE).
