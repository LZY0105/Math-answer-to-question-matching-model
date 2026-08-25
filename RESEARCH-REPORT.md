# Find-Engine: Deterministic Question–Answer Alignment Across Paired Mathematics PDFs

**A technical report**

*Version 1.0 — 25 August 2026*

---

## Abstract

We describe Find-Engine, a deterministic system that aligns exercises in a
mathematics textbook with their solutions in a physically separate answer key,
given only the two PDFs. The problem is a constrained instance of monotonic
sequence alignment, but differs from bitext alignment in two respects that
change the design: the documents supply structural anchors (hierarchical
question identifiers and bookmark trees) that plain prose does not, and the
cost of a wrong alignment is asymmetric — showing a student the wrong worked
solution is worse than showing none.

The system is organised as a four-stage cascade ordered by cost, in which a
query stops at the first stage that resolves it, and in which the decision of
*which* entry to return is deliberately separated from the decision of *how much
to trust it*. On a corpus of four published 考研数学 volumes (1,504 questions
total), the exact-identifier stage alone resolves all 508 questions of the
2023 pair with zero errors at 100% high-confidence precision, at a 95th-percentile
per-page latency of 0.01 ms.

We evaluate the remaining stages by ablating the bookmark trees and scoring
against an oracle derived from them. Precision remains 100% in all four ablation
regimes; recall degrades sharply, and per-page latency rises by four orders of
magnitude. We report two negative results in detail: a positional prior that
appeared safe by construction but returned 120 of 120 wrong answers at medium
confidence on non-parallel documents, and a confident misdiagnosis of font
corruption that was in fact a missing PDF reader configuration. Both are
retained in the report because the reasoning that produced them is reusable and
the corrections are not obvious in hindsight.

---

## 1. Introduction

### 1.1 Problem statement

Let *E* be an exercise book and *A* an answer key, published as separate PDF
documents. *E* contains a sequence of numbered questions; *A* contains a
sequence of entries, each the worked solution to one of them. The task is to
compute, for each question *q ∈ E*, either the entry *a ∈ A* that solves it, or
an explicit refusal.

The naive formulation — match by printed question number — fails immediately,
because numbering restarts at each chapter. A bare "12" is unambiguous within a
chapter and meaningless across a book. The naive repair — match by text
similarity — fails for a different reason: on a page of derivative exercises,
every question reads 求函数…的导数 and the discriminating content is a short
mathematical expression embedded in near-identical prose.

### 1.2 Asymmetric cost

The application is a study tablet on which a student works through exercises. A
missing answer is an inconvenience: the student turns to the key themselves. A
*wrong* answer is a different category of failure. It is presented with the
same authority as a correct one, the student has no way to detect it, and every
downstream stage — grading, error localisation, feedback — is then confidently
wrong about work that was correct.

This asymmetry is the organising constraint of the system. Throughout, we treat
precision as an invariant to be preserved and recall as a quantity to be
maximised subject to it. Several design decisions reported below sacrifice
substantial recall for precision, and one component is shipped disabled because
it could not honour the constraint.

### 1.3 Contributions

1. A four-stage cascade in which structural document metadata (bookmark trees,
   hierarchical identifiers) is exhausted before any content comparison, and in
   which alignment and confidence are computed by separate mechanisms.
2. An operator-anchored context representation for mathematical similarity that
   widens the decision margin on near-identical questions from 0.107 to 0.466,
   with the window radius selected by measurement rather than convention.
3. A text-layer quality gate that distinguishes six failure modes and, in
   practice, detected a misconfiguration in the host application that had been
   silently corrupting all input.
4. An ablation methodology for evaluating the content-matching stages on
   documents whose structural metadata has been removed, scored against an
   oracle constructed from that same metadata.
5. Two documented negative results with their measurements.

**Figures.** 1 — the stage cascade (§3.1). 2 — precision against refusal rate
under ablation (§5.3). 3 — per-page latency by regime (§5.4). 4 — the operator
window radius sweep (§6.1).

---

## 2. Related work

The alignment machinery is standard; the domain handling is not. We situate the
system against sentence- and document-alignment literature.

| System | Shared ground | Differences | Relationship |
|---|---|---|---|
| Gale–Church | Monotonic alignment of ordered segments | Length statistics only; no structural anchors | Positional prior baseline (§7.1) |
| Hunalign | Monotonic matching, gap handling, non-crossing constraint | Bilingual corpora; sentence length and dictionaries | Gap-penalty formulation |
| Bleualign | Similarity combined with sequence order | Requires machine-translation output | Evaluation design |
| Maligna | Whole-sequence optimisation over per-item scoring | General bitext framework | The whole-alignment framing |
| Vecalign | Long-document alignment, DP, gaps, many-to-many | Embedding-based; no document structure | Candidate reduction |
| Bitextor | Extraction → discovery → alignment pipeline | Multilingual web corpora; heavier | Stage-level quality gates |

Two asymmetries distinguish this problem from bitext alignment.

**It is easier.** Bitext aligners must infer correspondence from content alone.
Here, hierarchical question identifiers and PDF bookmark trees provide exact
anchors. Where those anchors are present and unambiguous, the alignment problem
is a dictionary lookup, and no embedding model or DTW approximation is required.

**It is harder in one specific way.** Those anchors arrive through a PDF text
extraction layer that is frequently unreliable, and unreliable in ways that
produce plausible-looking output rather than obvious errors. A substantial part
of the system is therefore concerned with deciding what not to trust — a
concern largely absent from the bitext literature, which typically assumes clean
input.

---

## 3. System design

### 3.1 The cascade

Four stages, ordered by cost. A question stops at the first stage that resolves
it, so the expensive stages run only on the residue.

![The four-stage cascade](figures/cascade.svg)

**Figure 1.** The cascade. Cost rises left to right; a question exits at the
first stage that can justify an answer. The refusal exit is reachable from every
stage, and is the only outcome when evidence is absent — never a default.

| Stage | Signal | Resolves | Cost |
|---|---|---|---|
| 0 | Hierarchical identifier from bookmark tree | Identifier present exactly once in both documents | O(1) |
| 1 | Table-of-contents alignment | Narrows candidates to one chapter | Once per document pair |
| 2 | Math-weighted similarity with operator context | Duplicate or absent identifiers | O(candidates) per question |
| 3 | Monotonic alignment (Needleman–Wunsch) | Position, when content is uninformative | O(nm), bounded |

### 3.2 Stage 0: hierarchical identifiers

Questions in this corpus are numbered hierarchically — `1.1`, `1.200`, `2.231` —
encoding chapter and position. The hierarchy is the identity. Parsing such
identifiers as flat integers, as an earlier version did, collapses 508 distinct
questions onto 2 identifiers.

Identifiers are canonicalised per segment, so that leading zeros normalise
(`01.020` → `1.20`) while `1.1` and `1.10` remain distinct. Whole-string numeric
normalisation would conflate the latter pair, which is the same class of error
as truncation.

Subquestion markers — `(1)`, `(2)` — restart within *every* question. Promoting
them to top-level entries manufactures hundreds of duplicate `1`s and converts a
clean unique-identifier lookup into mass forced ambiguity. They are therefore
attached to their parent question and never compete as identifiers.

Identifiers are taken from the PDF bookmark tree in preference to body text.
Bookmarks are structural: they survive font problems, layout irregularity and
extraction noise that defeat text parsing. Question bookmarks are distinguished
from section headings structurally rather than lexically — either by a 例题
marker or by occupying the deepest level of the outline — so the test itself
does not depend on the text layer.

### 3.3 Stage 1: table-of-contents alignment

For document pairs whose identifiers do not correspond, chapter titles are
aligned to bound the search. Titles rarely match exactly (第三章 导数与微分（答案）
against 第三章 导数与微分), so pairing is by similarity.

Two properties are enforced. Pairing is **monotonic**, computed by
Needleman–Wunsch rather than greedily: a greedy pairing can match chapter 5 with
chapter 2's solutions whenever titles happen to score higher, producing a page
range that contains no correct answer and giving no visible symptom. Pairing is
also **depth-aware**: sections align only against sections at their own outline
level, because `1.1 极限与连续函数` and `例题 1.1` are similar enough to pair with
each other when depth is ignored, and the shorter title often wins.

### 3.4 Stage 2: operator-anchored similarity

Content similarity is computed over character bigrams (Dice coefficient),
weighted 0.75 toward extracted mathematical fragments. Fragments are kept whole
rather than reduced to symbol sets, because `x^2+3x` and `x^3+5x` contain
identical symbols and differ only in arrangement. Brackets are canonicalised
rather than deleted: deleting them makes `1/(x+1)` and `1/x+1` the same string,
which is not a formatting difference but a different function.

The principal refinement is **operator context**. A bigram coefficient is a
*bag*: it counts which pairs occur, not where. Two derivative exercises share
almost all bigrams of their prose and most of their expression, leaving a thin
margin. The discriminating information is local to the operators, so each
operator occurrence is anchored and a fixed window taken either side:

```
x^2+3x   →   "··x^2+3"   "x^2+3x·"
x^3+5x   →   "··x^3+5"   "x^3+5x·"
```

Neither token matches, where a bigram bag shares `x^`, `+` and `x`. Similarity
is the Dice coefficient over these context multisets. The signal is suppressed
when either side has fewer than two operator anchors, since a single anchor is
one coincidence wide, and prose questions have none.

Window radius selection is reported in §6.1.

### 3.5 Stage 3: bounded monotonic alignment

Questions appear in the same order in both documents, so a crossing alignment is
structurally impossible. Needleman–Wunsch over the two sequences enforces this
and guarantees that no two questions claim the same entry. Gaps are modelled
rather than forced: a question absent from the key remains unpaired instead of
dragging a wrong partner into the alignment.

Positional support falls out of the formulation — when *q₄* and *q₆* both match
strongly, *q₅* follows from position even with a weak content signal — and is
applied one step only, so that a single strong neighbour cannot vouch for a run
of guesses.

The alignment is bounded three ways: candidate count, a diagonal band, and a
wall-clock deadline. Exceeding the deadline reports a timeout rather than
returning the partial table's answer, which would be an arbitrary alignment
presented as a real one.

### 3.6 Text-layer quality gate

"The PDF returned text" is not "the PDF returned its text". The gate classifies
an extraction into six states by measuring control-character rate, the rate of
characters from scripts that cannot legitimately appear in the document's
language, and the presence of the expected script.

| State | Meaning | Remedy |
|---|---|---|
| `USABLE` | Reads as the language it should | — |
| `DEGRADED` | Readable, noisy; supporting signal only | — |
| `OPAQUE` | Unreadable but internally consistent | Check the reader's configuration |
| `CORRUPT` | Text present, carrying nothing usable | Bookmarks, or OCR |
| `BLANK` | Text layer present and empty | None needed |
| `SCANNED` | No text layer | OCR |

The distinctions matter because the remedies differ, and because a system that
reports "no answers found" for a scanned book has told the user nothing
actionable. The gate's practical value is documented in §7.2, where it detected
a defect in the host application rather than in any document.

### 3.7 Confidence and abstention

Confidence is derived from **how many independent signals agree**, and is
computed by a mechanism separate from the alignment.

| Confidence | Basis |
|---|---|
| `HIGH` | Exact bookmark identifier, or chapter alignment + number + content |
| `MEDIUM` | Two signals agree |
| `LOW` | One weak signal; displayed with visible caution |
| `NONE` | Refused; candidates and reason returned |

The separation is deliberate. The dynamic program decides *which* entry; the
per-question rules decide *how much to trust it*. Without the split, the
ordering constraint could manufacture certainty the evidence does not support: a
tidy alignment of uniformly weak matches is still weak.

A specific consequence: **a duplicated identifier with no section alignment is
refused, never settled by position.** The alignment always produces *some*
assignment, and accepting it would convert genuine ambiguity into a confident
wrong answer. An abstention retains its evidence — candidate identifiers, pages
and reason — so that neither the next stage nor the user must rediscover it.

---

## 4. Corpus

Four published volumes of Chinese postgraduate-entrance mathematics
(考研数学), comprising 1,504 catalogued questions.

| Document | Pages | Lines | Questions | Identifier range |
|---|---|---|---|---|
| 2023 exercise book | 368 | 5,260 | 508 | 1.1 – 2.231 |
| 2023 answer key | 372 | 18,996 | 508 | 1.1 – 2.231 |
| 2024 数学分析 | 200 | 14,164 | 271 | 1.1 – 1.271 |
| 2024 高等代数 | 197 | 9,316 | 217 | 2.1 – 2.217 |

All identifiers are distinct within each volume. The 2023 pair is the only
complete exercise/answer pairing available, and is therefore the only document
pair on which end-to-end alignment can be measured.

The corpus is extracted text and bookmark trees, not the PDFs. It is rebuilt by
a tool that drives the host application's own PDF layer rather than
reimplementing extraction, because line grouping is a judgement call — fragments
are bucketed into rows by baseline within a tolerance — and a corpus built with
different buckets would evaluate the system against input it never receives.

---

## 5. Evaluation

### 5.1 End-to-end, with document structure intact

| Metric | Result |
|---|---|
| Questions resolved | **508 / 508** |
| Wrong accepted matches | **0** |
| `HIGH`-confidence precision | **100%** |
| Per-page matching latency | p50 0.01 ms, p95 0.01 ms, max 0.38 ms |
| Indexing the 372-page key | 9 ms |

All 508 resolve at stage 0. Questions sharing a page each receive their own
candidate range, and no two claim the same entry. No match originates from a
non-question page. Shared-page recall is within 2 percentage points of
single-question-page recall.

This result is unrepresentative by construction: it measures one stage. The
remaining stages are evaluated by ablation.

### 5.2 Ablation methodology

To exercise stages 1–3 we remove the bookmark trees and force the system onto
body-text parsing. Scoring such runs is subtle, and an earlier informal attempt
was invalid: it compared body-parsed matches against body-parsed labels, which
grades the text layer against itself.

The oracle is instead constructed **from the bookmark trees**, which are
structural and wholly independent of the text layer the ablated runs must rely
on. For each identifier the oracle records its page range in both documents.

Identifying which oracle entry a body-parsed match refers to requires care.
Only 16 of 365 covered exercise pages carry exactly one question, so page
containment alone is insufficient. A match is therefore counted only when **two
independent facts agree**: the parsed label is a real identifier, *and* the
bookmark tree independently places that identifier on the page where the parser
found it. Matches failing this test are reported as *unidentifiable* rather than
discarded, since discarding them would allow the parser to conceal its own
errors.

### 5.3 Ablation results

| Regime | Question index | Answer index | Correct | Wrong | Precision | Distinct resolved |
|---|---|---|---|---|---|---|
| Both bookmarked | outline (508) | outline (508) | 872 | **0** | **100%** | **508 / 508** |
| Key not bookmarked | outline (508) | body (1,235) | 14 | **0** | **100%** | 8 |
| Exercise not bookmarked | body (730) | outline (508) | 77 | **0** | **100%** | 77 † |
| Neither bookmarked | body (730) | body (1,235) | 8 | **0** | **100%** | 8 † |

† Sampled every 8th and 16th page respectively.

![Precision stays at 100% across regimes while the refusal rate climbs](figures/ablation-precision-refusal.svg)

**Figure 2.** Precision of accepted matches against the share of attempts
refused. Precision is invariant; the cost of preserving it is visible as the
refusal rate. Zero wrong answers in every regime.

**Precision is invariant at 100% across all regimes**, verified against an oracle
the ablated runs cannot observe. This is the system's central claim and it holds
under ablation.

**Recall degrades sharply.** Removing the answer key's bookmarks costs 500 of 508
questions, with 858 of 872 matches refused. The system declines rather than
failing silently, which is the intended behaviour, but the recall figure is
severe.

**The body parser over-extracts**: 730 "questions" against 508 real ones, and
1,235 "answers" against 508. Section headings and stray numbering parse as
entries. This is harmless for precision — surplus entries simply never match —
but it is precisely why body-parsed labels cannot serve as ground truth.

### 5.4 Latency under ablation

| Regime | Per-page p50 | Per-page p95 |
|---|---|---|
| Both bookmarked | 0 ms | 0 ms |
| Key not bookmarked | 159 ms | 342 ms |
| Exercise not bookmarked | 298 ms | **507 ms** |
| Neither bookmarked | 34 ms | 45 ms |

![95th-percentile per-page latency by regime](figures/latency-by-regime.svg)

**Figure 3.** 95th-percentile per-page matching latency. The host application's
responsiveness target is marked. Bookmarked pages never reach content scoring,
which is why the first bar is flat against the axis.

Removing the exercise book's bookmarks raises p95 latency by roughly four orders
of magnitude, because every question is then scored against a large pool of long
attached texts. Only the alignment's 1,500 ms deadline bounds it. On a tablet
this is a perceptible stall, and exceeds the 500 ms responsiveness target set for
the host application. Note that the "neither bookmarked" regime is *faster* than
"exercise not bookmarked": when the answer index is also body-parsed, its
per-entry texts are short, whereas an outline-derived index attaches a
question's entire page range.

---

## 6. Ablations and parameter selection

### 6.1 Operator context window radius

Swept over five pairs of near-identical questions — identical prose, mathematics
differing only in grouping, sign, exponent or coefficient — measuring the margin
between the correct and the best wrong candidate.

| Radius | Mean margin | Worst case | Inversions |
|---|---|---|---|
| 1 | 0.291 | 0.167 | 0 |
| 2 | 0.452 | 0.250 | 0 |
| **3** | **0.652** | **0.500** | **0** |
| 4 | 0.524 | 0.333 | 0 |
| 5 | 0.540 | 0.333 | 0 |
| 6 | 0.338 | 0.000 | **1** |
| *plain similarity* | *0.145* | *0.107* | *0* |
| *fragment bigrams* | *0.184* | *0.160* | *0* |

![Discrimination margin against operator-context window radius](figures/radius-sweep.svg)

**Figure 4.** The margin between the correct and the best wrong candidate, by
window radius. Both baselines are shown dashed. The peak at radius 3 is the
selection criterion; the marked point at radius 6 is a pair whose ordering
inverts — the wrong candidate outscores the correct one.

The curve is interpretable. At radius 1–2 the window holds a fragment of an
operand with no redundancy: two expressions differing in one position either
collide with that position or miss it entirely. At radius 3 the window spans a
complete operand in this notation — coefficient, variable, exponent — and is the
smallest window capturing an operand *as a unit*. At radius 5–6 the window
reaches past its own operand into the neighbouring term, so expressions
differing in one place share context tokens again through the parts that match;
at 6, one pair inverts outright.

On the representative derivative pair, the decision margin improves from 0.107
(plain similarity) to 0.160 (fragment bigrams) to **0.466** with operator
context. Operator context alone scores 0.857 against 0.000.

### 6.2 Effect on duplicate resolution

With no table of contents and per-chapter numbering, resolution of duplicated
identifiers improves from 54/120 to **114/120** at unchanged 100% precision, and
holds 100% precision on three adversarial non-parallel document pairs where a
positional approach fails (§7.1).

---

## 7. Negative results

### 7.1 A positional prior that fails silently

**Hypothesis.** Where identifiers are duplicated and no table of contents is
available, position should disambiguate: a question 30% through the exercise
book should pair with an answer near 30% through the key. This is the positional
half of Gale–Church applied to ordinal position.

**Safeguard.** The prior accepts only when *exactly one* candidate falls inside
the expected window — separating the alternatives rather than ranking them. A
ranking would let the nearest of two plausible candidates win; separation
appeared to avoid that.

**Result.**

| Condition | Recall | Precision |
|---|---|---|
| Documents genuinely parallel | 0% → 100% | 100% |
| 10 questions absent from key | 0% → 83% | 100% |
| 8 extra entries in key | 0% → 100% | 100% |
| Key's chapter 1 inflated 10× | — | **19%** |
| Key's chapters reversed | — | **0%** (120 of 120 wrong) |
| Key missing chapters 1–3 | — | **17%** |

**Analysis.** Solitude inside the window is not evidence of correctness. When the
documents are scaled differently, the window lands over the *wrong* chapter's
copy of the identifier, and its being alone there makes it appear unambiguous.
Every one of the 120 reversed-chapter errors was returned at `MEDIUM` confidence.

**Disposition.** The component is implemented and retained, disabled by default,
with its measurements in the source. A signal that cannot detect its own
inapplicability cannot honour an asymmetric-cost constraint. Content resolves the
same cases at 100% precision, because similarity is indifferent to document
order.

### 7.2 A confident misdiagnosis

**Observation.** All four volumes extracted with 0–1.9% Han characters — Chinese
textbooks apparently containing no Chinese. Extraction reported no error, and
similarity scores fell in their normal range.

**Initial diagnosis.** Broken embedded CJK fonts with defective ToUnicode maps.
Substantial machinery followed: a quality state for text that is unreadable but
internally consistent, an alphabet-overlap test to decide whether two documents
were corrupted identically and could therefore be compared, and a learner that
recovers a font's substitution table by aligning OCR output against the text
layer. All of it measured well — the corruption *was* a consistent substitution,
sharing 334 of 335 characters between the paired documents, and ranking the
correct answer first 95.8% of the time.

**Actual cause.** pdf.js cannot decode CID-keyed CJK fonts without CMap files.
Neither the corpus extractor nor the host application supplied them. The fonts
were never defective.

```
without cmaps   ২ี 1.1 2023.॓࿐ჽն࿐ ჰ PDFֻ4 ်
with cmaps      例题 1.1 2023. 中国科学院大学 原 PDF 第 4 页
```

Correctly configured, the corpus reads 23–28% Han with 0% odd-script and 0%
control characters, and the gate classifies every volume `USABLE`.

**What survived.** The bookmark-first design was correct, but for a different
reason than originally given: the outline is the better signal because it is
*structural*, not because the text was unusable. The 508/508 result is unchanged.
With correctly decoded text, the ablated regimes improve substantially.

**What was built for a non-existent problem.** The `OPAQUE` state and the glyph
learner. Both are retained — genuinely defective embedded fonts do occur, and
both components are correct and tested — but the documentation now states that
a caller encountering `OPAQUE` should suspect their reader's configuration before
concluding anything about the document.

**Why the gate is vindicated rather than undermined.** The misdiagnosis was
detected *because* the quality gate refused to treat the extraction as normal.
Without it, the system would have matched noise against noise while reporting
ordinary confidence, and the defect would have reached production invisibly. A
regression test now feeds the gate the undecoded form to keep that alarm
functioning.

---

## 8. Threats to validity

**Corpus homogeneity.** All four volumes come from one publisher and share
structural conventions: 例题 bookmark markers, hierarchical numbering, a
consistent outline depth. Outline heuristics are fitted to those conventions.

**Single complete pair.** Only the 2023 volumes form a matched exercise/answer
pair, so end-to-end alignment is measured on one document pair.

**No clean-text baseline for the quality gate.** Every volume in the corpus was
initially mis-extracted; the `USABLE`/`DEGRADED` boundary has not been exercised
against a document that was correctly extracted from the outset.

**Thresholds of uneven provenance.** The operator radius and the glyph-learner
vote thresholds were swept. `SIMILARITY_STRONG` (0.55) and `SIMILARITY_WEAK`
(0.30) were inherited and never swept; they bind only once stages 2–3 run, which
on a bookmarked corpus they never do.

**Ablation is not the same as absence.** Removing bookmarks from a document that
has them is not identical to a document that never had them — page ranges,
layout and numbering conventions still reflect a structured source.

**No on-device measurement.** All latency figures are desktop. Android
performance and memory are unmeasured.

---

## 9. Conclusion

The system meets its central objective: on the corpus for which it was built, it
resolves every question correctly, and under ablation it does not produce a
single wrong answer in any regime. That property is preserved by refusing, and
the recall cost of refusing is substantial and honestly reported.

Two broader observations follow from the negative results. First, a signal that
cannot detect its own inapplicability is unsafe under an asymmetric-cost
constraint regardless of how well it performs where it applies — the positional
prior was at 100% precision on every condition it was designed for and 0% on one
it was not. Second, an input-validation stage that appears to be defensive
scaffolding can be the component that finds the real defect; the quality gate's
most valuable output was a diagnosis about the reader rather than about any
document.

The most informative next experiment is not more volumes from the same
publisher, which would exercise the same stage-0 path, but a document pair whose
identifiers do *not* correspond — which would exercise stages 1–3 against real
data for the first time outside ablation.

---

## Appendix A: Reproduction

The evaluation is executable:

```bash
npm test            # all suites
npm run test:real   # real-PDF suites, including the ablation
```

The corpus is extracted text from copyrighted textbooks and is not distributed.
`tools/extract-corpus.mjs` rebuilds it from local PDFs; the real-PDF suites skip
cleanly in its absence, so a fresh checkout runs green.

| Suite | Checks | Covers |
|---|---|---|
| `test_question_matcher.js` | 53 | Similarity, alignment, refusal, operator context |
| `test_answer_index.js` | 29 | Identifier parsing, indexing, quality states |
| `test_text_source.js` | 12 | Lazy text, OCR seam |
| `test_glyph_map.js` | 13 | Glyph-table recovery |
| `test_real_pdfs.js` | 22 | Gold sets, end-to-end, latency |
| `test_no_bookmarks.js` | 9 | Ablation against the bookmark oracle |

## Appendix B: Measured constants

| Constant | Value | Provenance |
|---|---|---|
| Math weight | 0.75 | Inherited; margin measured |
| Operator share of math signal | 0.60 | Chosen; not swept |
| Operator window radius | 3 | **Swept** (§6.1) |
| Similarity strong / weak | 0.55 / 0.30 | Inherited; **not swept** |
| Gap penalty | −0.18 | Inherited |
| Label bonus | 0.45 | Inherited |
| Alignment deadline | 1,500 ms | Chosen |
| Glyph learner votes / agreement | 3 / 0.80 | **Swept** |
| Alphabet-overlap sufficiency | 250 distinct chars | **Swept** |
