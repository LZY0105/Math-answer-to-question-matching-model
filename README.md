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

Two documents go in. Before any question is matched, the engine decides
whether it is willing to work on them at all.

### Gates, in order

| Gate | Question | On failure |
|---|---|---|
| **Role** | Is the left an exercise book and the right an answer key? | `BLOCKED` |
| **Identity** | Are these the same book — year, subject, sampled content anchors? | `BLOCKED`, or `UNKNOWN_PAIR` when evidence is merely absent |
| **Text quality** | Does the text layer actually cover the document? | `OCR_REQUIRED` |
| **Structure** | Which bookmarks are questions rather than sections? | no question index; region only |

These are derived by the engine, never supplied by the caller. That is the
whole point: an earlier version accepted `exactId`, `sectionAligned` and
`pairStatus` as arguments, and measured across all 60 wrong-book and
wrong-role combinations, 52 produced confident answers. It is now **0 of 60**.

### Then the cascade, cheapest first

A question stops at the first stage that resolves it.

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

## Five answers, not two

Refusing to *answer* must not mean refusing to *help*. The engine returns one
of five claims, and only the first can be wrong in the way that matters.

| Rung | Means | Can be wrong the costly way? |
|---|---|---|
| `AUTO_MATCH` | This entry is the answer | **Yes** — everything else protects this |
| `REVIEW` | One of these few is | No — it asserts no choice |
| `LOCATED` | The answer is in these pages | No — a range, not an identity |
| `REFUSED` | Not enough to say anything | No |
| `BLOCKED` | These two books do not belong together | No |

A rung is a **ceiling, not a target**: nothing may promote a result to improve a
coverage number. `matched` follows the rung, so a low-confidence guess can no
longer reach a reader as a final answer.

Pair status decides which rungs are available. An unverified pair may still
locate and offer review — it simply may not answer:

| Pair status | `AUTO_MATCH` | `REVIEW` | `LOCATED` |
|---|---|---|---|
| `VERIFIED_PAIR` | ✅ | ✅ | ✅ |
| `UNKNOWN_PAIR` | ❌ | ✅ | ✅ |
| `REJECTED_PAIR` | ❌ | ❌ | ❌ |

A duplicated id with no section alignment is **refused, never settled by
position**. The alignment always produces *some* assignment; accepting it would
turn genuine ambiguity into a confident wrong answer.

## Results

Eight documents: three matched exercise/answer pairs with bookmarks on both
sides, and one scanned pair. Every figure is full-book; nothing is sampled.

### Safety

| | |
|---|---|
| Wrong-book / wrong-role combinations tested | **60** |
| Producing any automatic answer | **0** |
| Blocked at document level | 53 / 60 |
| Remainder | held at `UNKNOWN_PAIR`, which cannot auto-answer |

This covers wrong year, wrong subject, answer↔answer, exercise↔exercise and
reversed orientation. Measured through the public interface only — testing an
internal helper would prove nothing about whether a caller can bypass a gate.

### Capability

| Pair | Resolved | Wrong | Per-page p95 |
|---|---|---|---|
| 2023 | **508 / 508** | **0** | 1 ms |
| 2024 Mathematical Analysis | **271 / 271** | **0** | 2 ms |
| 2024 Advanced Algebra | **217 / 217** | **0** | 1 ms |

Those are under the calibrated formula policy. Under the strict policy — every
complete expression in a question must have a counterpart in its answer — the
same pairs resolve 470, 159 and 175, still with **zero wrong**. The rule costs
recall and buys no measurable precision on this corpus, so it ships enforced
and switchable, with both halves exercised in the suite. See
`FORMULA_POLICY`.

### Degraded structure

Stripping bookmark trees and scoring against an oracle built from them:
precision never falls, and no valid pair is ever rejected merely for missing a
bookmark tree. Recall moves to the lower rungs instead of disappearing.
[Ablation methodology and full table](RESEARCH-REPORT.md#5-evaluation).

![Precision stays at 100% across regimes while the refusal rate climbs](figures/ablation-precision-refusal.svg)

Three structural readings account for most of the no-bookmark recall, and none
is a similarity threshold. The answer key prints its own table of contents, so
body parsing found every identifier twice and refused questions it had already
located; running heads made unrelated entries look similar; and — once those
are out of the way — **the printed contents is itself a label-to-location
index**, the very thing a missing bookmark tree would have provided.

Reading it needs the offset between printed page numbers and PDF page indices,
recovered from the document rather than guessed: every label appearing in both
the contents and the body parse votes, and on the 2023 key 492 of 508 agree on
+18. Applying that offset blindly would place 492 correctly and 16 wrongly, so
a location is emitted only where the two independent readings agree — which
excludes exactly those 16.

See `src/toc-filter.js`, `src/boilerplate.js`, `src/contents-index.js`.

## Scanned books

A scanned exercise book has no text layer worth the name — the 2025 volume
here yields 609 characters across 465 pages, on 0.7% of them. The engine
refuses it by default, and `tools/windows-ocr.mjs` is a working recognizer that
makes it readable: `pdftoppm` renders a page, `Windows.Media.Ocr` reads it. No
install, no network, nothing leaves the device. 465 pages in 6.7 minutes with
zero page failures — a preparation job, not something done while a reader waits.

Recognition moves the document from `SPARSE_LAYER` to `USABLE` with
`textOrigin: OCR`, and indexes 607 questions where there were none.

**It does not make the book matchable, and this path is not released.**

Recognition alone unlocks no automatic answers, and should not: the engine
cannot verify from OCR-derived anchors that two books belong together, so it
offers review and page locations and withholds the answer. A binding — the user
saying "yes, these two" — supplies the identity it cannot establish, and is
checked against both documents’ fingerprints so replacing either file
invalidates it.

**A binding establishes document-pair identity and nothing more.** It must not
raise an individual question to high confidence. Per-question validation —
question-boundary detection, complete formula coverage, bidirectional
consistency, global one-to-one assignment, a sufficient top-two margin — is
still required and is not implemented.

### What the numbers are, and are not

After a binding the engine emits automatic matches, and it is tempting to call
the count an accuracy. It is not one. The 2025 exercise book has no
question-level bookmarks — the reason OCR is involved at all — so nothing
independent says *where* a question sits in it. Checking that a matched answer
falls inside that label’s answer span is very nearly circular: the label drives
the lookup, so it lands there by construction. An earlier revision of this
README reported "178 correct, 0 wrong" on exactly that basis. **That claim is
withdrawn.**

What can be checked is whether the label was printed on the page it matched
from, and whether the labels run in the book’s order. Those counts are
generated, not transcribed:

```bash
node tools/ocr-cache.mjs            # once, ~7 min; needs the PDF at an ASCII path
node tools/audit-ocr-matches.mjs    # writes reports/ocr-audit-latest.json
```

**[reports/ocr-audit-20260827.json](reports/ocr-audit-20260827.json) is the
canonical result.** At the time of writing it records 178 automatic events, 100
from pages that printed the label and 78 from continuation pages, 8 labels seen
*only* on continuation pages, and 108/573 raw against 100/573 start-page
aligned. A visual audit of eight sampled pairs found seven correct and one
wrong, so the error rate is neither zero nor presently known.

Both scripts exit cleanly on a checkout without the corpus, which is never
committed. The audit reasoning itself lives in `src/ocr-audit.js` and is unit
tested, so it can be verified without the private data.

For scale, the same book before this work produced **479 confident wrong
answers**, by reading its 18 chapter bookmarks as questions. Refusing is already
better than that; it is not yet a feature.

## Usage

One entry point. `preparePair` owns the gates; nothing else can produce a match.

```js
import { preparePair } from './src/matching-engine.js';

const prepared = await preparePair({
  exerciseDocument,           // DocumentAdapter
  answerDocument,             // DocumentAdapter
  recognizer,                 // optional; required for scanned books
  binding,                    // optional; a pairing the user already confirmed
  expectScript: 'han',
});

if (prepared.status === 'REJECTED_PAIR') {
  // Wrong book, wrong role, wrong year. Say so; do not match.
  return prepared.decision.reasonCodes;
}

const matches = await prepared.session.matchQuestion({ page, region });

for (const m of matches) {
  switch (m.rung) {
    case 'AUTO_MATCH': show(m.entry.answer); break;
    case 'REVIEW':     offer(m.candidates); break;
    case 'LOCATED':    say(`answers on pages ${m.region.from}–${m.region.to}`); break;
    default:           explain(m.cappedBy, m.reasonCodes);
  }
}
```

The whole book at once: `await prepared.session.matchAll()`.

**What may not cross this interface**: `exactId`, `sectionAligned`,
`crossBookComparable`, `pairStatus`, or any boolean asserting that something
was verified. Those are conclusions, and reaching them is the module’s job.

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

Lines may additionally carry `y` and `height`. When they do, `region` selects
the tapped question rather than the whole page; when they do not, the result
says `regionApplied: false` instead of silently returning everything.

### Recognizer interface

For scanned books, supply `recognizer(page) => Promise<string>`. The engine
calls it, and **only successful recognition clears `OCR_REQUIRED`** — a
recognizer that returns nothing, throws, or yields a layer still too sparse
leaves the document fail-closed.

`tools/windows-ocr.mjs` is a working reference implementation built from what
Windows already has — `pdftoppm` to render, `Windows.Media.Ocr` to recognise —
so it needs no install and no network, and no page leaves the device.

### Numbering recognised

`1.` `12)` `15、` `第 9 题` `3．` and the hierarchical forms `1.1` `1.200` `2.231`
`例题 1.31` — anchored to the start of a line. `(7)` `（8）` are **subquestions**
of whichever question is open, never questions in their own right.

## Tests

```bash
npm test              # all nine suites, 230 checks
npm run test:unit     # synthetic fixtures only, no corpus needed
npm run test:scenarios  # bookmarks, no bookmarks, and the 60 invalid pairs
```

Most tests are about **refusing** rather than matching, and the primary test
surface is the public interface: a suite that reached into internals could not
show whether a caller can bypass a gate.

Correctness is checked by two oracles that share no failure mode — the two
bookmark trees, and the answer’s own printed label in its body text. A
*contradiction* between them fails absolutely; *silence* is tolerated only at
its measured rate.

The real-PDF suites need a corpus of extracted text that is **not committed** —
it derives from copyrighted books. `tools/extract-corpus.mjs` rebuilds it; point
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

- Reordered answer books lose recall. Alignment is monotonic; there is no
  global non-monotonic assignment yet, so crossings are refused, not resolved.
- Bidirectional consistency and bounded Top-K retrieval are not implemented.
  Degraded 2024 regimes run at roughly 0.7–1.6 s per page as a result.
- Confidence is an ordinal band, not a calibrated probability. It stays that
  way until enough independent book pairs exist to calibrate honestly.
- Bigram similarity is language-agnostic but not semantic.
- Android performance is unmeasured; all figures are desktop.
- Tuned against Chinese mathematics textbooks. The approach is general; the
  constants are not.

[Threats to validity](RESEARCH-REPORT.md#8-threats-to-validity) in the report.

## License

MIT — see [LICENSE](LICENSE).
