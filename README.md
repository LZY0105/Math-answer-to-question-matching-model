# Find-Engine

**A model for matching maths answers to their questions.** Given an exercise
book and a separate answer key — two PDFs with no shared identifiers beyond what
is printed in them — it decides which answer entry belongs to which question, so
a student reading a textbook sees the answer for the question in front of them.

A **domain-specific engine built on structured sequence alignment**. The
underlying techniques — dynamic programming, monotonic alignment, similarity
scoring — are established; what is specific here is the domain: hierarchical
question ids, PDF bookmark anchoring, mathematical-structure weighting, and a
deliberate right to refuse. See [Related projects](#related-projects-and-differences).

Pure JavaScript, no dependencies, no network. Extracted from an Android maths
study tablet app, where it runs entirely on-device.

## The problem

Given two PDFs — an exercise book and its answer key — decide which answer entry
belongs to which question. No single signal is sufficient:

- **Question numbers restart every chapter.** A bare "12" is ambiguous across a
  whole book, and picking the wrong chapter's answer is worse than showing none.
- **Content is thin.** An answer entry often gives only the result, with little
  of the question text to compare against.
- **The prose is nearly identical.** On a page of derivative exercises, every
  question reads 求函数…的导数. Whole-string similarity cannot separate them.
- **The text layer can lie.** All four books first measured at 0–1.9% Han
  characters — Chinese textbooks containing no Chinese. That was the *reader*,
  not the books: pdf.js cannot decode CID-keyed CJK fonts without cmaps. The
  noise scored in the normal range, so nothing downstream looked wrong.

## How it works

Four stages, cheapest first, each covering the previous one's blind spot. A
question stops at the first stage that can resolve it, so most never reach the
expensive ones.

| stage | signal | resolves | cost |
|---|---|---|---|
| **0** | hierarchical question id from the bookmark tree | an id present exactly once in both books | O(1) lookup |
| **1** | table-of-contents alignment | narrows to one chapter of the key | once per book pair |
| **2** | math-weighted similarity + operator context | duplicate or missing ids | O(candidates) per question |
| **3** | monotonic alignment (Needleman–Wunsch) | position, when content is thin | O(n·m), bounded |

On the 2023 corpus every one of the 508 questions resolves at **stage 0**, so
stages 1–3 exist for books whose ids do not correspond. Confidence is decided
separately from all of this — see
[Confidence, and the right to refuse](#confidence-and-the-right-to-refuse).

### 0. Hierarchical id from the bookmark tree (exact)

Questions in these books are numbered `1.1`, `1.200`, `2.231` — chapter and
position, not a bare ordinal. Both books bookmark the same question under the
same id, so where those ids correspond the match needs no comparison at all.

On the 2023 set this stage alone resolves **all 508 questions uniquely**.

```js
const alignment = alignOutlines(exerciseDoc.outline, answerDoc.outline);
alignment.questionIds.get('1.31');   // -> { exercise, answer }
```

The hierarchy is the identity. Parsing `1.200` as `1` collapses two hundred
distinct questions onto one id — and subquestion markers `(1)` `(2)`, which
restart inside *every* question, must never be promoted to top level or they
manufacture hundreds of duplicate `1`s.

### 1. Table-of-contents alignment (coarse)

For books whose ids do not correspond. Chapter titles rarely match exactly — an
answer key's 第三章 导数与微分（答案） against the exercise book's 第三章 导数与微分
— so sections pair by similarity.

Pairing is **monotonic and depth-aware**: sections align only against sections at
their own outline level (otherwise `1.1 极限与连续函数` and `例题 1.1` compete for
the same partner), and Needleman–Wunsch prevents chapter 5 pairing with chapter
2's answers, which would produce a page range containing no correct answer at
all.

### 2. Math-weighted similarity (fine)

Mathematical fragments are extracted and weighted at 0.75 against surrounding
prose, because the mathematics is where the difference actually lives.

Fragments are kept **whole** rather than reduced to a set of symbols: `x^2+3x`
and `x^3+5x` contain exactly the same symbols and differ only in arrangement.
Brackets are canonicalised, never deleted — `1/(x+1)` and `1/x+1` are different
functions, not two spellings of one.

**Operator context** sharpens this further, and is what makes duplicate question
numbers resolvable. Dice over bigrams is a *bag* — it counts which pairs occur,
not where. The discriminating information sits around the operators, so each
operator is anchored and a three-character window taken either side:

```
x^2+3x   ->   "··x^2+3"   "x^2+3x·"
x^3+5x   ->   "··x^3+5"   "x^3+5x·"
```

Neither token matches, where a bigram bag shared `x^`, `+` and `x`.

#### Why three characters, and not two or six

Three is measured, not chosen for tidiness. Swept over five pairs of
near-identical questions — identical prose, mathematics differing only in
grouping, sign, exponent or coefficient — the margin between the correct and the
wrong candidate peaks at a radius of three:

| radius | mean margin | worst case | inversions |
|---|---|---|---|
| 1 | 0.291 | 0.167 | 0 |
| 2 | 0.452 | 0.250 | 0 |
| **3** | **0.652** | **0.500** | **0** |
| 4 | 0.524 | 0.333 | 0 |
| 5 | 0.540 | 0.333 | 0 |
| 6 | 0.338 | 0.000 | **1** |
| *plain similarity* | *0.145* | *0.107* | *0* |
| *fragment bigrams* | *0.184* | *0.160* | *0* |

The shape of that curve is the argument:

- **Too narrow (1–2)** and the window holds one operand character. `x^2+3x` and
  `x^5+3x` differ in a single position, and a one-character window either
  catches it or misses it entirely — there is no redundancy.
- **Three** spans a complete operand in this notation: a coefficient, a variable
  and an exponent (`2+3`, `x^2`, `+3x`). It is the smallest window that captures
  an operand *as a unit* rather than a fragment of one.
- **Too wide (5–6)** and the window reaches past its own operand into the
  neighbouring term, so two expressions that differ in one place start sharing
  context tokens again through the parts that happen to match. At six, one pair
  inverts outright — the wrong candidate scores higher than the correct one.

Sweeping it also matters because the window is the *only* thing separating
questions on a page of derivative exercises, where prose is uninformative. An
inversion there is a confident wrong answer, which is the one failure this engine
is built to avoid.

Measured on a representative pair of derivative questions:

| | correct | wrong | margin |
|---|---|---|---|
| Plain string similarity | 0.813 | 0.706 | 0.107 — *below the decision threshold* |
| Fragment bigrams | 0.786 | 0.626 | 0.160 — decisive |
| **With operator context** | 0.822 | 0.356 | **0.466** |
| *(operator context alone)* | *0.857* | *0.000* | *0.857* |

### 3. Monotonic alignment (structural)

Questions appear in the same order in both books, so an alignment that crosses —
question 3 taking answer 7 while question 4 takes answer 2 — is structurally
impossible. Needleman–Wunsch enforces that and guarantees no two questions claim
the same answer.

Gaps are modelled rather than forced. A question absent from the key stays
unpaired instead of dragging a wrong partner in.

**Positional support** falls out of this: when Q4 and Q6 both match strongly, Q5
follows from position even with no usable content signal. Applied one step only,
so a lone strong neighbour cannot vouch for a run of guesses.

The alignment is bounded three ways — candidate count, a diagonal band, and a
deadline. Exceeding the deadline reports `timedOut` rather than returning the
partial table's answer, which would be an arbitrary alignment wearing a real
one's clothes.

## The text-quality gate

"The PDF returned some text" is not "the PDF returned its text". This gate exists
because of a mistake it caught.

All four books in the corpus first extracted as 0–1.9% Han — Chinese textbooks
with no Chinese — and were diagnosed as having broken embedded fonts. They do
not. **pdf.js cannot decode CID-keyed CJK fonts without cmaps**, and the corpus
had been built without them. Same PDF, same page 4, same line:

```
without cmaps   ২ี 1.1 2023.॓࿐ჽն࿐ ჰ PDFֻ4 ်
with cmaps      例题 1.1 2023. 中国科学院大学 原 PDF 第 4 页
```

Decoded properly, the corpus reads 23–28% Han, 0% odd-script, 0% control
characters — `USABLE` on every book. The corpus is now built by
`tools/extract-corpus.mjs`, which drives the host app's own `pdf-document.js` so
the fixtures are exactly what the app feeds the engine.

The gate is what made a misconfigured reader visible instead of silently
matching noise, so its verdicts are kept:

| | meaning | remedy |
|---|---|---|
| `USABLE` | extraction reads like the language it should | — |
| `DEGRADED` | readable, noisy; supporting signal only | — |
| `OPAQUE` | unreadable, but internally consistent | check the reader first |
| `CORRUPT` | text present, carrying nothing usable | bookmarks, or OCR |
| `BLANK` | text layer present and empty | nothing to say |
| `SCANNED` | no text layer at all | OCR |

**If you hit `OPAQUE`, suspect your configuration before the document.** It was
built for genuinely broken embedded fonts, which do exist — and everything under
it still works — but the first instance of it turned out to be a missing
`cMapUrl`. `sharedAlphabetOverlap` remains the guard deciding whether such text
may be compared across two books at all.

## Confidence, and the right to refuse

A wrong match is worse than no match. Every match carries a confidence derived
from **how many independent signals agree**:

| Confidence | Meaning |
|---|---|
| `HIGH` | Exact bookmark id, or chapter aligned + number + content agreeing |
| `MEDIUM` | Two signals agree |
| `LOW` | One weak signal — display with a visible caution |
| `NONE` | Refused. Candidate ids, pages and the reason are returned |

Alignment and confidence are kept **separate on purpose**: the dynamic program
decides *which* entry, the per-question rules decide *how much to trust it*.
Without that split, the ordering constraint could manufacture certainty the
evidence does not support.

Specifically: **a duplicated id with no section alignment is refused, never
settled by position.** The alignment always produces *some* assignment, and
accepting it would convert genuine ambiguity into a confident wrong answer.

An abstention keeps its evidence — `candidates`, `candidateIds`,
`candidatePages`, `reason` — so the next stage, or the user, does not have to
rediscover it.

## Measured results

Against the real 2023 books (368-page exercise book, 372-page key):

| | |
|---|---|
| Questions resolved | **508 / 508** |
| Accepted matches wrong | **0** |
| `HIGH` confidence precision | **100%** |
| Per-page matching | p50 0.01 ms, p95 0.01 ms, max 0.32 ms |
| Indexing the 372-page key | 9 ms (18,308 lines, 508 questions) |

The 2024 sets index at 271 (数学分析) and 217 (高等代数) questions, all ids
distinct. Android figures still need physical-device measurement; the numbers
above are desktop.

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
catches a broken CJK mapping that the noise rate alone would not.

### Document interface

The engine does not read PDFs itself. Supply any object exposing:

```js
{
  numPages: number,
  outline: { available: boolean, items: [{ title, pageNumber, depth, children }] },
  async extractText({ from, to }): Array<{ page: number, text: string }>,
}
```

In the host application these come from pdf.js, but nothing here depends on it.

### Numbering formats recognised

`1.` `12)` `15、` `第 9 题` `3．` and the hierarchical forms `1.1` `1.200`
`2.231` `例题 1.31` — anchored to the start of a line, because a bare number
mid-line is far more likely to be part of the mathematics than a label.

`(7)` `（8）` are **subquestions** of whichever question is open, never questions
in their own right.

## Tests

```bash
npm test          # unit + real-PDF suites
npm run test:unit # synthetic fixtures only
npm run test:real # the 2023/2024 books
```

Most tests are about **refusing** rather than matching: duplicate numbers that
cannot be told apart, absent labels, unrelated content, missing outlines,
non-crossing alignment, corrupted text layers, and unpaired questions. The
measured similarity margin above is itself a test, so a change to the weighting
cannot silently narrow it.

The real-PDF suite needs a corpus of extracted text that is **not committed** —
it is derived from copyrighted books. Point `FIND_ENGINE_CORPUS` at its
`data.json`, or place it at `../find-engine-corpus/data.json`. Absent, that suite
skips rather than fails, so a fresh clone still runs green.

## Related projects and differences

Find-Engine does not invent a general-purpose text-alignment algorithm. The
alignment machinery is standard; the domain handling is not.

| Project | Shared ground | Differences | What was taken |
|---|---|---|---|
| [Vecalign](https://github.com/thompsonb/vecalign) | Ordered long-document alignment, DP, gaps, many-to-many | Multilingual sentence alignment over embeddings; no PDF ids, outlines or answer books | Candidate reduction, long-sequence alignment, gold-set evaluation |
| [Hunalign](https://github.com/danielvarga/hunalign) | Monotonic matching, gap handling, non-crossing alignments | Bilingual corpora, driven by sentence length and dictionaries | Monotonic constraints, gap penalties, a conventional baseline |
| [Bleualign](https://github.com/rsennrich/Bleualign) | Combines text similarity with sequence order | Translated-sentence alignment; normally needs MT output | Similarity scoring and evaluation design |
| [Gale–Church / GaChalign](https://github.com/alvations/gachalign) | Matches segments in order | Length statistics only; no formulas, ids or section structure | A lightweight length baseline |
| [Maligna](https://github.com/loomchild/maligna) | Whole-sequence optimisation over per-item scoring | Bitext alignment framework | The whole-alignment framing |
| [Bitextor](https://github.com/bitextor/bitextor) | Extraction → candidate discovery → alignment pipeline | Multilingual web corpora; heavier, different domain | Modular pipeline design, stage-level quality gates |

The problem here is **easier** than bitext alignment in one specific way:
question numbers and the bookmark tree provide anchors that plain prose does
not, so no embeddings or DTW approximation are needed. It is **harder** in
another: the anchors arrive through a PDF text layer that is frequently corrupt,
so a large part of the engine is deciding what not to trust.

Unlike most sentence aligners, which always emit an alignment, this engine can
decline.

## What happens without a table of contents

The bookmark tree does two independent jobs: it supplies the exact question ids
(stage 0), and it bounds the search so a repeated number becomes unique inside
its window (stage 1). Losing either costs recall.

These numbers are scored by `test/test_no_bookmarks.js`, which is careful about
one thing that is easy to get wrong: **ground truth comes from the bookmark
trees**, which are structural and independent of the text layer the stripped
runs must fall back on. Scoring a body-parsed match against another body-parsed
label grades the text layer against itself. A match counts only when two
independent facts agree — the parsed label is a real question id, *and* the
bookmark tree places that id on the page the parser found it.

| regime | question index | answer index | correct | wrong | precision | distinct resolved |
|---|---|---|---|---|---|---|
| both books bookmarked | outline (508) | outline (508) | 872 | **0** | **100%** | **508 / 508** |
| answer key not bookmarked | outline (508) | body (1235) | 14 | **0** | **100%** | 8 |
| exercise book not bookmarked | body (730) | outline (508) | 77 | **0** | **100%** | 77 † |
| neither bookmarked | body (730) | body (1235) | 8 | **0** | **100%** | 8 † |

† sampled every 8th and 16th page respectively; these regimes are slow, see below.

**Precision never degrades — zero wrong answers in any regime**, verified against
an oracle the runs cannot see. The engine stops answering rather than starts
guessing.

**Recall is what collapses.** Losing the answer key's bookmarks costs almost
everything: 8 questions of 508, with 858 of 872 matches refused. The engine is
declining, not failing silently.

**The body parser over-extracts**, which is why its own labels cannot be the
oracle: 730 "questions" against 508 real ones, and 1235 "answers" against 508.
Section headings and stray numbering parse as entries. Harmless for precision —
the surplus entries simply never match — but disqualifying as ground truth.

**Losing the exercise book's bookmarks is expensive.** With them a page costs
p95 **0 ms**, because stage 0 answers it outright. Without them every question is
scored against a large pool of long attached texts: p95 **507 ms**, four orders of
magnitude worse and enough to be felt on a tablet. The alignment's own 1500 ms
deadline is the only thing bounding it. If the no-bookmark path ever matters in
production, that is the number to attack.

### Why there is no positional fallback

The obvious third anchor is position — a question 30% through the exercise book
should pair with an answer near 30% through the key. That is the Gale–Church
length-and-order baseline, and it is implemented in
[`src/positional-prior.js`](src/positional-prior.js), **off by default.**

It works when the books really are parallel, and fails silently when they are
not:

| | recall | precision |
|---|---|---|
| books parallel | 0% → **100%** | 100% |
| 10 questions absent from key | 0% → 83% | 100% |
| 8 extra entries in key | 0% → 100% | 100% |
| key's chapter 1 bloated 10× | — | **19%** |
| key's chapters reversed | — | **0%** (120 of 120 wrong) |
| key missing chapters 1–3 | — | **17%** |

Being alone inside the expected window is not evidence of being right: when the
books are scaled differently the window lands over the *wrong* chapter's copy,
and its solitude there makes it look unambiguous. All 120 reversed-chapter
errors came back at `MEDIUM`.

A signal that cannot detect its own inapplicability cannot honour "a wrong match
is worse than no match", so it stays off. **Content is the better fallback.** With
operator context it reaches 100% precision on all three failing rows above AND
higher recall than the prior ever achieved (114/120 on reversed chapters, versus
the prior's 120 matched of which 120 were wrong) — because similarity does not
care what order the books are in.

## OCR

The engine does not do OCR, the same way it does not read PDFs: it asks a text
source for a page range. `src/text-source.js` is the seam, and the `recognise`
function is injected by the host.

What it does provide is the laziness that makes OCR affordable. Indexing used to
extract every page — 9 ms against a text layer, 372 page renders against OCR.
That is not a slower version of the same design, so ids and page ranges are taken
from the bookmark tree (which needs no text at all) and text is fetched only when
a decision depends on it:

| | pages read | OCR calls |
|---|---|---|
| eager indexing | 372 | — |
| `lazy: true` indexing | **12** (a sample, same 508 entries, same verdict) | 0 |
| matching one question | +1 | **0** — opaque text still compares |
| showing the reader an answer | — | **1** |

```js
const index = await indexAnswerDocument(answerDoc, { lazy: true });
const source = createTextSource(answerDoc, { recognise: yourOcr });

const entry = await source.hydrate(match.entry);                       // compare
const shown = await source.hydrate(match.entry, { needReadable: true }); // display
```

OCR is reached for, not reached for first. `OPAQUE` text is the cheaper signal
for *matching*, so a broken font does not trigger OCR at all — only a request for
readable text does, and only for the page being read.

### Repairing the font map is cheaper than reading the pages

When a book is `OPAQUE` rather than scanned, OCR is usually the wrong tool. The
corruption is a substitution, so it is undone by a table: recognise each
**distinct glyph** once and the whole book decodes. The 2023 pair have 375 and
632 distinct garbled characters against 368 and 372 pages — recognising ~600
small images beats recognising 740 full pages, and the table belongs to the font,
so the next book embedding the same subset costs nothing.

The table is **learned by watching OCR read a page**. The mathematics survives
corruption untouched, so digits, Latin letters and operators appear identically
in the text layer and in the OCR output — they pin the two strings together, and
the broken characters between two pins are read off:

```js
const learner = createGlyphLearner();
for (const page of pagesToSample) {
  learner.observe(await layerText(page), await ocrText(page));
}
const repair = createGlyphRepair(learner.table());   // decodes the WHOLE book
repairCoverage(allLines, learner.table());           // when to stop OCRing
```

Measured against the real `ans2023` text with a known mapping applied and
simulated OCR error, **zero wrong entries at every checkpoint**:

| pages OCR'd | glyphs learned | book decoded | wrong |
|---|---|---|---|
| 20 | 14 | 25.8% | 0 |
| 40 | 115 | 76.7% | 0 |
| 80 | 205 | 87.8% | 0 |
| 150 | 292 | 93.2% | 0 |

Learning is deliberately timid, because a missing entry leaves a character
garbled where the reader can see it while a wrong entry silently replaces it
everywhere. A span is read only when both sides agree how many characters it
holds; a substitution is believed only after three consistent sightings; a target
that is not plausibly a real character is discarded. The thresholds are swept
rather than guessed — one vote admits 14–29 wrong entries once OCR starts
*substituting* characters rather than dropping them:

| OCR noise | `minVotes: 1` | shipped defaults |
|---|---|---|
| 4% dropped | 100% precision | 100% |
| 4% dropped, 5% misread | **95.9%** | 100% |
| 2% dropped, 25% misread | **91.2%** | 100% |

One limitation it cannot cover: nothing here can tell that the caller paired
page 1's text layer with page 4's OCR output. A single mispaired page is absorbed
by the vote threshold; a systematic mispairing is believed. Page correspondence
is the caller's to get right.

## Limitations

- **Scanned books need OCR.** The engine provides the seam and the laziness
  (see [OCR](#ocr)); the recogniser itself is the host's.
- **Books with neither an outline nor a usable text layer cannot be indexed.**
  This is reported, not guessed around — see the table above.
- **Bigram similarity is language-agnostic but not semantic.** Two questions
  differing only in wording, not symbols, may not separate.
- **Android performance is unmeasured.** Desktop figures above; the on-device
  target needs physical-device numbers.
- Tuned against Chinese-language mathematics textbooks (考研数学). The approach
  is general; the constants are not.

## License

MIT — see [LICENSE](LICENSE).
