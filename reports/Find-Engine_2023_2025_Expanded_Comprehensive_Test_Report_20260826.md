# Find-Engine 2023/2024/2025 Expanded Comprehensive Test Report

[中文](Find-Engine_2023_2025_扩展全面测试报告_20260826.md) | [English](Find-Engine_2023_2025_Expanded_Comprehensive_Test_Report_20260826.md)

- Test date: 2026-08-26
- Git HEAD: `1e0e9bb3c608d7c33845d0d3f9834995c2a0ecb9`
- Target: the current uncommitted working tree, not the commit alone
- Platform: full-book desktop batch tests; no physical tablet testing
- Raw results: [expanded-regression-results-20260825.json](../tmp/expanded-regression-results-20260825.json)
- Reproduction harness: [run-expanded-regression.mjs](../tmp/run-expanded-regression.mjs)

## 1. Executive Decision

**The current build does not pass release acceptance.**

The engine has a strong question-bookmark fast path. The valid 2023 pair, 2024 Mathematical Analysis pair, and 2024 Advanced Algebra pair all achieved 100% strict precision and 100% unique recall when both documents retained question-level bookmarks. The additional 2024 books confirm that this strength generalizes.

The public matching flow still lacks integrated safety gates, general no-bookmark behavior, scanned-input handling, and complete per-question formula-set matching:

1. Of 60 wrong-book or wrong-role combinations, 52 produced accepted results and `HIGH` confidence in the Stage-0 gate probe. The other eight happened to share no labels; they were not rejected by a document gate.
2. Removing answer bookmarks from either 2024 pair reduced unique recall to 0%.
3. With exercise bookmarks removed or both bookmark sets removed, 2024 strict precision fell to 24.5%-33.8% for Mathematical Analysis and 27.5%-30.5% for Advanced Algebra.
4. The scanned 2025 exercise book is still classified as `USABLE`, `scanned=false`, and yields 18 false body questions. The four regimes accept 14, 4, 14, and 4 results, while true recall remains 0/573.
5. All three complete-formula-set safety probes fail. A unique label still produces `HIGH` when only one of two formulas is present or when both formulas conflict.
6. The 2024 no-exercise-bookmark p95 latencies are 1,688.2 ms and 1,572.9 ms, missing the design target and exceeding the approximate 1,500 ms safety boundary.

The repository remains salvageable. Preserve the bookmark index, hierarchical IDs, structural classifier, contents index, mathematical character signals, and existing tests; refactor the public orchestration path instead of rewriting everything.

## 2. Corpus and Ground Truth

| Key | Document | Pages | Lines | Characters | Question-level truth/index |
|---|---|---:|---:|---:|---:|
| q2023 | 2023 exercise book | 368 | 5,260 | 69,375 | 508 |
| ans2023 | 2023 answer book | 372 | 18,996 | 294,819 | 508 |
| a2024 | 2024 Mathematical Analysis exercise book | 200 | 14,164 | 243,509 | 271 |
| a2024_ma | 2024 Mathematical Analysis answer book | 202 | 20,800 | 336,156 | 271 |
| g2024 | 2024 Advanced Algebra exercise book | 197 | 9,316 | 188,815 | 217 |
| a2024_alg | 2024 Advanced Algebra answer book | 199 | 14,385 | 270,899 | 217 |
| q2025 | 2025 scanned exercise book | 465 | 65 | 609 | 0 (engine extracts 18 false body entries) |
| a2025 | 2025 answer book | 321 | 17,658 | 251,320 | 573 |

The 2023 and both 2024 valid pairs use independent question-level bookmark trees from the exercise and answer books. An accepted result is correct only when the label agrees, the exercise page falls inside the gold question span, and the answer start page falls inside the gold answer span.

The 2025 exercise book has no question-level bookmarks and almost no body text. No accepted result is counted as independently correct; strict unique recall is 0/573.

## 3. Current Repository Tests

`npm test` completed with **170 passed and 0 failed**.

| Suite | Result |
|---|---:|
| question matcher | 53/53 |
| answer index | 29/29 |
| lazy text / OCR seam | 12/12 |
| glyph map | 13/13 |
| structure / rung ladder | 32/32 |
| real PDFs | 22/22 |
| no bookmarks | 9/9 |

This proves that the existing unit constraints and legacy corpus did not regress. It does not prove the new safety requirements. The repository no-bookmark suite still reports precision over `identified` results and samples some page paths. This report uses `strict_precision = independently_confirmed / accepted` and runs every page for each valid pair.

## 4. Valid Pairs Across Four Bookmark Regimes

Accepted results are counted per emitted match, so a multi-page question can appear more than once. Unique recall is measured against independent question IDs.

| Pair | Exercise bookmarks | Answer bookmarks | Q/A index | Accepted | Strict precision | Unique recall | p95/page | Verdict |
|---|---|---|---|---:|---:|---:|---:|---|
| 2023 | Yes | Yes | OUTLINE/OUTLINE | 872 | **100.0%** | **100.0%** | 0.0 ms | Pass |
| 2023 | Yes | No | OUTLINE/CONTENTS | 839 | **100.0%** | 96.5% | 0.1 ms | Recall below target |
| 2023 | No | Yes | BODY/OUTLINE | 732 | 74.3% | 78.7% | 424.1 ms | Fail |
| 2023 | No | No | BODY/CONTENTS | 664 | 99.4% | 96.7% | 62.4 ms | Four wrong accepts; fail |
| 2024 Mathematical Analysis | Yes | Yes | OUTLINE/OUTLINE | 470 | **100.0%** | **100.0%** | 0.0 ms | Pass |
| 2024 Mathematical Analysis | Yes | No | OUTLINE/BODY | 0 | - | 0.0% | 993.6 ms | Unusable |
| 2024 Mathematical Analysis | No | Yes | BODY/OUTLINE | 337 | 33.8% | 36.5% | 1,688.2 ms | Severe fail |
| 2024 Mathematical Analysis | No | No | BODY/BODY | 747 | 24.5% | 40.2% | 576.7 ms | Severe fail |
| 2024 Advanced Algebra | Yes | Yes | OUTLINE/OUTLINE | 413 | **100.0%** | **100.0%** | 0.0 ms | Pass |
| 2024 Advanced Algebra | Yes | No | OUTLINE/BODY | 0 | - | 0.0% | 562.4 ms | Unusable |
| 2024 Advanced Algebra | No | Yes | BODY/OUTLINE | 1,043 | 30.5% | 89.9% | 1,572.9 ms | Severe fail |
| 2024 Advanced Algebra | No | No | BODY/BODY | 597 | 27.5% | 44.7% | 411.7 ms | Severe fail |
| 2025 scanned | Yes | Yes | BODY/OUTLINE | 14 | 0.0% | 0/573 | 1,425.4 ms | Expected OCR_REQUIRED; fail |
| 2025 scanned | Yes | No | BODY/BODY | 4 | 0.0% | 0/573 | 343.2 ms | Expected OCR_REQUIRED; fail |
| 2025 scanned | No | Yes | BODY/OUTLINE | 14 | 0.0% | 0/573 | 1,102.8 ms | Expected OCR_REQUIRED; fail |
| 2025 scanned | No | No | BODY/BODY | 4 | 0.0% | 0/573 | 485.2 ms | Expected OCR_REQUIRED; fail |

### 4.1 Over-extraction

- 2024 Mathematical Analysis exercise without bookmarks: 1,960 body candidates versus 271 true questions.
- 2024 Mathematical Analysis answer without bookmarks: 1,756 body candidates versus 271 true answers.
- 2024 Advanced Algebra exercise without bookmarks: 1,352 body candidates versus 217 true questions.
- 2024 Advanced Algebra answer without bookmarks: 1,235 body candidates versus 217 true answers.

The body parser promotes contents rows, within-question numbering, subquestions, and mathematical numerals into question-level candidates. A shared label is not enough to establish the correct page.

## 5. Wrong-book and Wrong-role Matrix

The run covers all 60 original-bookmark combinations: 12 wrong exercise-to-answer pairs, 16 answer-to-answer pairs, 16 exercise-to-exercise pairs, and 16 answer-to-exercise pairs. A correct product must reject these before any question-level scoring, so the exhaustive matrix uses the public Stage-0 matching path for every shared label. One accepted result fails the combination.

| Category | Cases | Cases with accepts | Cases with `HIGH` | Accepted probes | `HIGH` probes |
|---|---:|---:|---:|---:|---:|
| Wrong exercise-to-answer | 12 | 10 | 10 | 2,008 | 2,008 |
| Answer-to-answer | 16 | 14 | 14 | 4,537 | 4,537 |
| Exercise-to-exercise | 16 | 14 | 14 | 2,062 | 2,062 |
| Answer-to-exercise | 16 | 14 | 14 | 3,022 | 3,022 |
| **Total** | **60** | **52** | **52** | **11,629** | **11,629** |

The remaining eight combinations share no labels because Mathematical Analysis primarily uses `1.x` and Advanced Algebra uses `2.x`. Their zero accepts are accidental, not evidence of role or pair-identity validation.

A representative full-book wrong-pair run, 2023 exercise to 2024 Mathematical Analysis answer, produced **463 accepts and 463 `HIGH` results**.

## 6. No-bookmark Negative Probes

| Scenario | Shared-label probes | Accepted | `HIGH` | Expected |
|---|---:|---:|---:|---|
| 2023 exercise to 2025 answer (wrong year) | 712 | 650 | 489 | Whole-book refusal |
| 2024 Math Analysis exercise to Algebra answer | 28 | 27 | 27 | Whole-book refusal |
| 2023 answer to 2024 Math Analysis answer | 376 | 27 | 0 | Whole-book refusal |
| 2023 exercise to 2024 Math Analysis exercise | 379 | 18 | 2 | Whole-book refusal |
| 2023 answer to 2024 Math Analysis exercise | 380 | 4 | 4 | Whole-book refusal |
| 2025 scanned exercise to 2025 answer | 18 | 4 | 0 | OCR_REQUIRED; accepted=0 |

Document gates cannot depend on bookmarks. Identical labels extracted from body text bypass the same role and pair-identity checks.

## 7. Complete Formula-set Requirement

Three safety probes use a question containing two complete expressions: `f(x)=x^2+1` and `g(x)=sin(x)`.

| Probe | Candidate | Current result | Expected |
|---|---|---|---|
| Unique label with only the first expression | Missing `g(x)=sin(x)` | `HIGH` | REVIEW/REFUSED |
| Aligned section with only the first expression | Similarity 0.468 | `HIGH` | REVIEW/REFUSED |
| Unique label with both expressions conflicting | `x^3+1`, `cos(x)` | `HIGH` | REFUSED |

All three probes fail. The unique `exactId` path returns `HIGH` before content is inspected, and there is no `FormulaSet` coverage gate in the current code. The agreed rule - match every complete expression first, then use three characters to the left and right of each expression only for disambiguation - is not implemented.

## 8. Confirmed Improvements and Remaining Blockers

### Confirmed improvements

- The repository grew from the earlier 138 checks to 170, adding structure classification, contents suppression, location, and rung-ladder coverage.
- 2025 chapter bookmarks no longer produce 479 `HIGH` results directly; section/question classification improved.
- The 2023 neither-bookmarks path improved substantially through the contents index, reaching 96.7% unique recall.

### Release blockers

- Pair identity and two-sided role validation are not integrated into the public matching entry point.
- `exactId` still bypasses content, formula, and pair identity and returns `HIGH`.
- The sparse-layer gate classifies a 465-page, 609-character scanned book as `USABLE`.
- The 2025 contents-page labels still become 18 body questions.
- 2024 body question/answer segmentation over-extracts severely, while answer-without-bookmarks recall is 0%.
- Complete formula-set coverage, per-formula three-character context, bidirectional consistency, and global reversible one-to-one assignment are not one enforceable public flow.

## 9. Recommended Fix Order

### P0: eliminate wrong accepts

1. Expose one mandatory `preparePair -> matchQuestion/matchAll` path. Require left=`EXERCISE`, right=`ANSWER`, and resolve `VERIFIED_PAIR/UNKNOWN_PAIR/REJECTED_PAIR` before indexing or any `exactId` shortcut.
2. `UNKNOWN_PAIR` may locate or request review but cannot auto-answer. `REJECTED_PAIR` must return accepted=0.
3. Fix sparse-layer detection. The 2025 exercise must become `SCANNED/SPARSE_LAYER`; without a recognizer it returns `OCR_REQUIRED` and never enters body-label parsing.
4. Remove unconditional unique-label `HIGH`. An exact label is only candidate-retrieval evidence inside a verified pair.
5. Implement a per-question `FormulaSet`: determine the complete question boundary, extract every complete expression, require 100% coverage and zero structural conflicts, and only then compare three characters on either side of each formula. Partial coverage or broken OCR cannot produce `AUTO_MATCH`.
6. Return `AUTO_MATCH/REVIEW/REFUSED`. A `LOW` record must not keep `matched=true` in a way the host can display as a final answer.

### P1: recover no-bookmark accuracy and performance

1. Fix 2024 body segmentation first: suppress contents, subquestion numbering, within-question numbers, formula constants, and repeated headers.
2. Build one immutable answer index and retrieve top-K by label, section, formula structure, and keywords. Do not repeat whole-book dynamic programming for every page.
3. Estimate order reliability from strong anchors. Use a local window only when reliable; otherwise perform global one-to-one assignment that allows reordering and gaps.
4. Keep a reversible occupied set for high-confidence assignments. Never delete source index records.
5. Target desktop single-question p95 below 150 ms. Timeout must refuse rather than return a partial alignment.

### P2: freeze this matrix as regression

1. Keep all 170 existing checks and add the eight-document external corpus entry point.
2. Run all four bookmark regimes over complete valid books and report strict precision, unique recall, refusal rate, and p95.
3. Require all 60 wrong-book/wrong-role cases to reject through the same public API; testing an internal decision helper is insufficient.
4. Add the three FormulaSet negatives, wrong-subject shared labels, cross-year shared labels, reordered answers, missing/extra items, and rollback tests.

## 10. Proposed Release Gates

- The three text-based dual-bookmark pairs: 100% unique recall and 100% strict precision.
- All 60 wrong-book/wrong-role combinations: 100% whole-book refusal, accepted=0, `HIGH`=0.
- 2025 without OCR: `OCR_REQUIRED`, accepted=0.
- 2025 with OCR: first milestone at least 95% unique recall and 100% strict precision.
- Automatic multi-formula matches: 100% complete `FormulaSet` coverage, zero structural conflicts; three-character context cannot independently reverse a refusal.
- Every unidentifiable accepted result counts as a false positive.
- Desktop single-question p95 below 150 ms without relying on a 1,500 ms timeout.

## 11. Test Boundaries

- No tablet or physical-device testing was performed.
- Mathematical correctness of the answer solutions was not evaluated; only question-to-answer location matching was tested.
- The 60-case invalid matrix uses an exhaustive Stage-0 gate probe over shared labels. It determines whether document-level rejection can be bypassed but does not count every page-level duplicate. One representative wrong pair was also run over the full book.
- Local PDF pages could not be re-rendered for visual sampling in this run: no PDF rendering runtime was available, and local-file browser navigation was blocked by the browser security policy. The 2023/2024 conclusions rely on independent bookmark labels and page spans. Because the 2025 exercise lacks question-level truth, its recall is conservatively recorded as 0/573 and no unverifiable accept is counted as correct.

## 12. Final Assessment

**Salvage the engine, but refactor orchestration before tuning similarity.**

Preserve bookmark indexing, hierarchical IDs, structural classification, the contents index, mathematical character signals, and the existing tests. Replace the public decision chain with one non-bypassable deep `MatchingEngine` module that owns role and pair identity, OCR quality, question boundaries, complete formula sets, candidate retrieval, bidirectional verification, global one-to-one assignment, and confidence calibration.
