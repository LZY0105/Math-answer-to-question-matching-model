# Find-Engine Test Checklist

- Date: 2026-08-26
- Applies to: the working tree after the orchestration-layer remediation (**uncommitted**)
- Corpus: `tmp/expanded-corpus-20260825.json`, 8 documents
- Suites: 9 files, **230 automated checks**, all green
- Companion documents:
  - `reports/Find-Engine_2023_2025_Expanded_Comprehensive_Test_Report_20260826.md` — the evidence baseline this work answers
  - `reports/Find-Engine_Orchestration_Layer_Complete_Remediation_Checklist_20260826.md` — the plan
  - `reports/Find-Engine_v2_Product_Requirements_and_Architecture_20260825.md` — the target design

Every figure below was produced by a command in §0 on this working tree. Where a
number could not be obtained it is marked **not measured**, never estimated.

---

## 0. How to run everything

```bash
cd ~/Documents/ChatGPT/题目答案匹配引擎

npm test                    # all 10 suites, 278 checks
npm run test:unit           # 6 synthetic suites, no corpus needed
npm run test:scenarios      # the three scenarios below, on the real corpus (~2.5 min)

# Release-gate evidence. The unit suites do not prove orchestration safety.
node tools/measure-regimes.mjs     tmp/expanded-corpus-20260825.json --json tmp/regimes.json
node tools/measure-pair-matrix.mjs tmp/expanded-corpus-20260825.json
```

Metric definitions — the expanded report's, not the older suite's:

- `strict_precision = independently_confirmed / accepted`. An accepted result
  that cannot be tied to the bookmark oracle counts as **wrong**, not excluded.
- `unique_recall = distinct correct questions / gold questions`.
- `located_coverage`, `located_precision`, `review_hit_rate` are reported
  **separately** and never folded into precision.
- Every page of every book is run. No sampling in the regime runner.

**Two independent oracles.** Correctness is checked twice, by evidence sharing no
failure mode:

- **Structural** — the two bookmark trees. Label agrees, exercise page inside the
  gold question span, answer page inside the gold answer span. Owes nothing to
  the text layer.
- **Content** — the answer's own printed body carries the question's label
  ("例题 1.6 …" appears in the entry claimed for 1.6). Owes nothing to the
  bookmark trees.

Measured over the three valid pairs: the true label is present in 100.0% / 99.6%
/ 99.5% of correct answers, and a *different* question's label in **0.0%**. The
suite treats the two disagreement modes differently, because they mean opposite
things — a **contradiction** (content names a different question) fails
absolutely; **silence** (the label is simply absent) is tolerated only at its
measured rate, and is explained: an entry's text is a page *range*, so an entry
whose own heading fell outside that range cannot carry it.

---

## 1. Automated suites

| Suite | Checks | Covers | Status |
|---|---:|---|---|
| `test_tools.js` | 46 | every shipped script parses; both release gates fail closed | ✅ |
| `test_question_matcher.js` | 53 | similarity, alignment, refusal, operator context | ✅ |
| `test_answer_index.js` | 29 | identifier parsing, indexing, quality states | ✅ |
| `test_text_source.js` | 12 | lazy text, OCR seam | ✅ |
| `test_glyph_map.js` | 13 | glyph-table recovery | ✅ |
| `test_structure.js` | 42 | outline/body classification, contents, boilerplate, rungs, regions, audit logic | ✅ |
| `test_matching_engine.js` | 25 | **the public interface only** | ✅ |
| `test_real_pdfs.js` | 23 | gold sets, end-to-end, latency, formula policy | ✅ |
| `test_no_bookmarks.js` | 9 | ablation against the bookmark oracle | ✅ |
| `test_corpus_regression.js` | 26 | **the three scenarios, real corpus, both oracles** | ✅ |
| **Total** | **278** | | **0 failed** |

The rows are listed in the order `npm test` runs them and they sum to the total.
An earlier revision of this table carried 23 and 22 for the last two suites
against a measured 26 and 23, so the rows summed to 226 while the total said
230 — four checks that existed but were not credited anywhere. Every figure here
is now read from the run rather than carried forward.

---

## 2. Mandatory safety gates

- [x] **All 60 wrong-book / wrong-role combinations produce `AUTO_MATCH = 0`**,
      now as an **automated assertion** (`test_corpus_regression.js` §3), not
      only a measurement script. Broken out by the three failure shapes:
      12 answer/exercise mismatch, 16 answer↔answer, 16 exercise↔exercise, plus
      16 reversed orientation. Measured through `preparePair()` only. 53/60 blocked at document level
      (24 `RIGHT_ROLE_INVALID`, 20 `LEFT_ROLE_INVALID`, 9
      `PAIR_IDENTITY_MISMATCH`); the remaining 7 held at `UNKNOWN_PAIR` +
      `OCR_REQUIRED`, which forbids auto-answering. Baseline: 52/60 leaking,
      11,629 wrong `HIGH` probes.
- [x] **No caller can force an automatic result with a Boolean flag.**
      `preparePair` ignores `pairStatus`, `exactId`, `crossBookComparable`;
      `matchPage`'s legacy default changed from `VERIFIED_PAIR` to
      `UNKNOWN_PAIR`. Covered by `test_matching_engine.js` §3.
- [x] **Scanned / sparse input returns `OCR_REQUIRED` with accepted = 0.**
      `q2025` (465 pages, 65 lines, 609 chars, 0.7% page coverage) now
      classifies `SPARSE_LAYER`, indexes to 0 entries, `ocrRequired = true`.
- [x] **`LOW` never reaches a reader as an answer.** `matched` is derived from
      the rung; only `AUTO_MATCH` sets it true.
- [ ] **Formula probes** — 1 of 3 satisfied. See §5; this is a specification
      conflict needing a decision, not a code change.

## 3. Capability preservation — measured, full book

| Pair | Accepted | Wrong | Strict precision | Unique recall | p95 | Pair status |
|---|---:|---:|---:|---:|---:|---|
| 2023 | 872 | **0** | **100.0%** | **100.0%** (508/508) | 1 ms | `VERIFIED_PAIR` |
| 2024 Math Analysis | 470 | **0** | **100.0%** | **100.0%** (271/271) | 2 ms | `VERIFIED_PAIR` |
| 2024 Adv Algebra | 413 | **0** | **100.0%** | **100.0%** (217/217) | 1 ms | `VERIFIED_PAIR` |

- [x] All three dual-bookmark pairs hold 100% / 100%.
- [x] The verified-bookmark fast path is intact (p95 1–2 ms).
- [x] Pre-existing checks still green (138 → 208).

## 4. Degraded modes — measured, full book

| Pair | Regime | Index (Q/A) | Accepted | Strict | Recall | Pair status |
|---|---|---|---:|---:|---:|---|
| 2023 | exercise not bookmarked | BODY/OUTLINE | 30 | **100.0%** | 3.7% | `VERIFIED_PAIR` |
| 2023 | answer not bookmarked | OUTLINE/CONTENTS | 0 | n/a | 0% | `UNKNOWN_PAIR` |
| 2023 | neither | BODY/CONTENTS | 0 | n/a | 0% | `UNKNOWN_PAIR` |
| 2024 MA | all three degraded | — | 0 | n/a | 0% | `UNKNOWN_PAIR` |
| 2024 ALG | all three degraded | — | 0 | n/a | 0% | `UNKNOWN_PAIR` |

Two deliberate policy consequences, both mandated by the remediation checklist:

- **`UNKNOWN_PAIR` may never auto-answer (C03).** When one bookmark tree is
  missing, the index becomes body-parsed and the engine can no longer confirm
  the answer book's role, so it withholds `AUTO_MATCH`.
- **A `LOW` band is a review candidate, not an answer (I02).** This is what took
  2023 `exNone` from 78.7% recall to 3.7%: 266 of its former accepts were
  single-signal `LOW` matches. They were *correct* — strict precision was 100%
  before and after — but they were being presented as answers.

⚠️ **No valid pair is falsely rejected.** All 12 valid-pair regimes are
`VERIFIED` or `UNKNOWN`, never `REJECTED`.

⚠️ **The cost of these two policies is currently unmeasured.** The coverage they
removed now lives at `REVIEW`/`LOCATED`, and `located_coverage`,
`located_precision` and `review_hit_rate` have **not been measured** for these
regimes. Until they are, the safety change's price is unknown, not zero. This is
the single most important gap in this checklist.

---

## 5. Open decisions — these need a person, not a commit

### 5.1 The complete-FormulaSet rule conflicts with capability preservation

Applying the specified rule (100% coverage, zero structural conflicts) to
**known-correct** pairs:

| Pair | True pairs | Would pass | Would be REFUSED | Median coverage |
|---|---:|---:|---:|---:|
| 2023 | 400 | 158 (39.5%) | 218 | 0.88 |
| 2024 Math Analysis | 271 | **0** | 270 | 0.41 |
| 2024 Adv Algebra | 217 | **0** | 217 | 0.63 |

An answer entry routinely states only its result, so demanding the question's
expressions back demands something the corpus does not contain. The specified
rule and the gate "all three dual-bookmark pairs at 100% recall" cannot both
hold.

**Implemented instead**, threshold chosen by measurement over 788 true pairs and
788 decoys (each question paired with someone else's answer):

| Rule | Refuses decoys | Refuses TRUE pairs |
|---|---:|---:|
| coverage < 0.10 | **99.0%** | **0.25%** |
| coverage = 0 | 91.8% | 0.13% |
| coverage < 1.0 (as specified) | 100% | 60–100% |

- [ ] **Decision:** accept coverage < 0.10, or accept the specified rule's recall cost.

### 5.2 Probe outcomes under the implemented gate

| Probe | Expected | Actual |
|---|---|---|
| Unique label, only first expression present | REVIEW/REFUSED | **passes** (coverage 0.5) |
| Aligned section, only first expression | REVIEW/REFUSED | **passes** (coverage 0.5) |
| Unique label, both expressions conflicting | REFUSED | **REVIEW** ✅ |

- [ ] **Decision:** probes 1–2 cannot be satisfied at the measured coverage
      distribution without taking both 2024 pairs to zero recall.

### 5.3 Formula evidence does not override structure

The veto wrongly capped exactly 2 of 508 correct 2023 matches, because outline
entry text spans a **page range** and absorbs neighbours:

- `1.255` — its extracted expressions belonged to `1.254`.
- `2.206` — a prose question whose only "expression" was `3×3a=`, scavenged from
  an adjoining question.

So the veto applies to content-derived matches and not to a bookmark or
contents-corroborated identifier. Evidence is still computed and reported
(`formula.notApplied = 'STRUCTURAL_ID'`).

- [ ] **Decision:** confirm this precedence, or require entry-scoped text
      extraction so formula evidence becomes trustworthy on outline indexes.

### 5.4 Signals measured on outline indexes must not judge body indexes

Three separate false rejections of **valid** pairs were found and fixed, all the
same mistake — a threshold calibrated on clean outline indexes applied to an
over-extracted body index:

| Signal | Symptom | Fix |
|---|---|---|
| Role classifier | `ans2023` without bookmarks scores 0.969 vs a 0.970 threshold → "confirmed exercise book" | Only an `OUTLINE` index may confirm *absence* of an answer key |
| Role source list | `CONTENTS` treated as structural | `OUTLINE` only |
| Content anchors | Valid 2024 MA pair rejected when exercise bookmarks removed | Anchor shortfall rejects only when **both** indexes are `OUTLINE` |

- [ ] **Watch for recurrence** whenever a new threshold is added: a conflict may
      reject, missing evidence may not.

---

## 6. Regression matrix — coverage status

### 6.1 Valid pairs — **automated**
- [x] 2023 Q/A — four bookmark regimes; 508/508 recall, 0 wrong, both oracles agree
- [x] 2024 Mathematical Analysis Q/A — four regimes; 271/271, 0 wrong
- [x] 2024 Advanced Algebra Q/A — four regimes; 217/217, 0 wrong
- [x] every degraded regime: valid pair **never rejected**, never a wrong answer
- [x] 2025 Q/A without OCR → `OCR_REQUIRED`, accepted = 0, in all four regimes
- [ ] 2025 Q/A **with** validated OCR — blocked: no recognizer connected

### 6.2 Pair and role rejection — **automated**
- [x] answer ↔ exercise mismatch, 12 combinations → 0 automatic answers
- [x] answer ↔ answer, 16 combinations → 0 automatic answers
- [x] exercise ↔ exercise, 16 combinations → 0 automatic answers
- [x] reversed orientation (answer on the left), 16 combinations → 0 automatic answers
- [x] every invalid combination names a reason code
- [x] wrong-year and wrong-subject pairs are `REJECTED_PAIR`, not merely unverified
- [x] one exercise book against two different answer books
- [ ] generic titles with insufficient identity evidence — no such document in corpus
- [ ] verified manual binding + invalidation after file change — `binding` is
      implemented and accepted; **not tested**

### 6.3 Structure and ordering
- [x] section title resembling a hierarchical question number (`1.2 …`, `2.7 …`)
- [x] multiple questions on one page · repeated labels across sections
- [x] question-level structure missing, section-level region available
- [ ] reordered answers, large reordered blocks, local swaps — **not implemented**
- [ ] missing / extra / duplicated answer — only synthetic coverage

### 6.4 Formula safety
- [x] all complete formulas match (control) · one conflicting formula → capped
- [x] question with no mathematical expression → not gated
- [x] unrelated candidate (decoy) → capped
- [ ] only a subset matches → **passes**, see §5.2
- [ ] OCR-truncated formula — bracket-balance check exists, untested on real OCR
- [ ] formatting-equivalent formula; reordered formulas with multiplicity — untested

### 6.5 Text quality and OCR
- [x] clean layer · sparse layer · scanned document · corrupt · blank
- [x] opaque but mutually comparable font mapping (pre-existing coverage)
- [ ] mixed layer/OCR pages; recognizer unavailable / timeout / empty output

### 6.6 Interface and operational behaviour
- [x] page match via `matchQuestion({ page })` · full book via `matchAll()`
- [x] `matchQuestion` and `matchAll` agree on the same page
- [x] every result below `AUTO_MATCH` records why (`cappedBy` / reason codes)
- [ ] click-region single-question match — `region` input not implemented
- [ ] cancellation at every expensive stage — `signal` plumbed, untested
- [ ] repeated calls reuse indexes and OCR cache — **no pair-level cache**

---

## 7. Not done — carried forward, in blocking order

1. **Recognizer adapter.** Nothing OCRs. 2025 is correctly refused and cannot be
   served. Blocks §6.1 and §6.5.
2. **Lower-rung measurement.** `located_coverage`, `located_precision`,
   `review_hit_rate` for every `UNKNOWN_PAIR` regime. Without these the cost of
   §4's two policies is unknown. **Highest-value next measurement.**
3. **Bidirectional consistency (H02).** Not implemented.
4. **Global one-to-one assignment for reordered books (H03).** Not implemented;
   `alignSequences` remains monotonic.
5. **Bounded Top-K retrieval (G01–G04).** Not implemented. 2024 `exNone` p95 is
   1,570 ms with a 1,787 ms max — above the 150 ms target and at the ~1,500 ms
   deadline, so some results there are produced by expiry rather than decision.
6. **2024 body over-extraction.** Improved 6.5–7.2× → 2.2–3.9× of gold; still the
   root cause of 2024's degraded-regime quality.
7. **Confidence calibration and reliability curves (I04).** Ordinal bands remain
   the decision mechanism, as the architecture requires until ≥6 book pairs exist.
8. **Caller migration and legacy deprecation (K01–K08).** `matchPage` /
   `matchQuestion` remain exported and are used by tests and tools.

**Newly closed since the first draft of this checklist:**

- **J01 (partial) — pair-preparation cache.** Indexes are memoised per document
  on a `WeakMap` keyed by the adapter object, so pairing one book against eight
  indexes it once rather than eight times. The 64-combination matrix went from
  ~10 minutes to **21 seconds**, which is what made scenario 3 affordable as a
  test rather than a script. A fingerprint-keyed cache surviving process restarts
  is still the larger feature.
- **Scenario coverage.** The three scenarios are automated assertions with a
  second, independent content oracle.

---

## 8. Stop / Go

| Rule | Status |
|---|---|
| Stop if any invalid pair emits `AUTO_MATCH` | ✅ 0 of 60 |
| Stop if a scanned/sparse document proceeds without OCR | ✅ `OCR_REQUIRED`, 0 accepted |
| Stop if the new interface reduces verified bookmark accuracy | ✅ 508/508, 470/470, 413/413 at 100% |
| Stop if a partial/conflicting FormulaSet emits `AUTO_MATCH` | ⚠️ conflicting capped; partial passes — §5.2 |
| Do not stop solely because recall fell after fail-closed gates | ⚠️ applies to every `UNKNOWN_PAIR` regime; measure §7.2 first |

**Recommendation.** The P0 safety gates are closed and the verified-bookmark
capability is fully intact. Two items should precede any release decision: the
recognizer (§7.1), and the lower-rung coverage measurement (§7.2) — without the
latter, the price of the `UNKNOWN_PAIR` and `LOW`-is-not-an-answer policies is
unknown rather than zero.

---

## 9. Known measurement artifact

One run reported a 6,718,355 ms maximum for 2024 Advanced Algebra `ansNone`.
That is a wall-clock artifact from a descheduled background process, not engine
latency; the p95 for the same run was 739 ms. Do not carry that figure forward —
re-measure in the foreground before quoting any 2024 maximum.
