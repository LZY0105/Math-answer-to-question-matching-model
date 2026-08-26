# Find-Engine 2023/2025 Comprehensive Test Report

- Test date: 2026-08-25
- Engine commit under test: `f84225a34203f0ca4f0857136971ff8a585638a0`
- Current GitHub `main`: `1e0e9bb3c608d7c33845d0d3f9834995c2a0ecb9` (only bilingual README files were added; the algorithm code is unchanged)
- Test method: full-book batch testing on desktop; tablet testing was not performed, as requested
- Core principle: a wrong match is more serious than a refusal; under the strict metric, an accepted result that cannot be independently verified is counted as incorrect

## 1. Executive Summary

The current version is reliable only when matching the paired 2023 exercise and answer books and both documents contain question-level bookmarks. In that configuration, all 508 unique question IDs were covered, independently verified precision was 100%, and no mismatch occurred.

However, the engine does not yet satisfy the product requirement that wrong books, two answer books, and scanned books must be rejected safely. Three release blockers remain:

1. Cross-year mismatches are not rejected. Matching the 2023 exercise book to the 2025 answer book produced 872 incorrect `HIGH` acceptances; the reverse direction produced 479.
2. Two-answer-book inputs are not rejected. All four same-year and cross-year answer-to-answer combinations produced many `HIGH` matches.
3. The scanned 2025 exercise book has no question-level bookmarks and almost no usable text, yet the engine treats 18 chapter numbers as question IDs. With bookmarks retained on both sides, this produced 479 incorrect `HIGH` acceptances and a true-question recall of 0/573.

Therefore, the current version is not ready for release under a zero-mismatch and safe-refusal acceptance standard. Its question-level bookmark fast path is strong, but document identity gating, role gating, chapter-versus-question classification, and OCR integration are incomplete.

## 2. Test Documents and Ground Truth

| Document | Pages | Text layer | Outline/bookmarks | Question-level bookmarks |
|---|---:|---:|---:|---:|
| 2023 exercise book | 368 | 5,260 lines | 528 entries | 508 |
| 2023 answer book | 372 | 18,996 lines | 529 entries | 508 |
| 2025 exercise book | 465 | 65 lines, 609 characters | 56 entries | 0 |
| 2025 answer book | 321 | 17,658 lines | 631 entries | 573 |

The 2023 ground truth comes from the independent question-level bookmark trees in both books, with question IDs ranging from `1.1` to `2.231`. The 573 question-level bookmarks in the 2025 answer book agree with the existing inventory: 314 Mathematical Analysis questions and 259 Advanced Algebra questions. The 2025 exercise book contains only chapter and “calculation/proof” bookmarks, and its body is almost entirely scanned images.

## 3. Existing Repository Test Suites

All six repository test suites were run individually. The result was 138 passed and 0 failed:

- Question matcher: 53/53
- Answer index: 29/29
- Lazy text / OCR seam: 12/12
- Glyph map: 13/13
- Real PDFs: 22/22
- No bookmarks: 9/9

This confirms that the unit-level constraints and the existing 2023/2024 baseline did not regress, but it does not prove that the newly required safety scenarios work. Some paths in the existing no-bookmark tests sample every 8 or 16 pages and classify accepted entries that cannot be identified by bookmark ground truth as `unidentifiable`. Those entries are excluded from the precision denominator, so the reported precision can still appear as 100%.

## 4. Correct 2023 Pair: With and Without Bookmarks

“Accepted” is counted per page, so the same multi-page question can be accepted more than once. “Unique recall” is measured against the 508 real question IDs. “Strict precision” counts accepted entries that cannot be confirmed by independent bookmark ground truth as incorrect.

| Exercise bookmarks | Answer bookmarks | Accepted | Independently confirmed | Unconfirmed | Strict precision | Unique recall | Refused | p95/page |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Yes | Yes | 872 | 872 | 0 | **100.0%** | **508/508 (100.0%)** | 0 | 0.017 ms |
| Yes | No | 14 | 14 | 0 | **100.0%** | 8/508 (1.57%) | 858 | 124.9 ms |
| No | Yes | 732 | 544 | 188 | **74.3%** | 400/508 (78.74%) | 182 | 380.9 ms |
| No | No | 74 | 67 | 7 | **90.5%** | 50/508 (9.84%) | 840 | 45.7 ms |

Key findings:

- With question-level bookmarks on both sides, precision, recall, and performance are excellent.
- When the answer book loses its bookmarks, recall nearly disappears: only 8 unique question IDs are covered even though the exercise bookmarks remain intact.
- When the exercise book loses its bookmarks, body parsing produces 730 candidates although only 508 true questions exist. A total of 188 accepted results cannot be confirmed by the independent ground truth. If these results are shown to users, strict precision is only 74.3%.
- The no-exercise-bookmarks / answer-bookmarks path has a p95 latency of 380.9 ms and a maximum single-page latency of 1,534.6 ms, reaching the current alignment timeout of approximately 1,500 ms.

## 5. Correct 2025 Pair: Scanned Exercise Book and Chapter Misclassification

The 2025 exercise book has no question-level bookmarks, and only 609 characters can be extracted from its 465 pages. None of the four configurations identifies a real question; unique question recall is 0/573 in every case.

| Exercise bookmarks | Answer bookmarks | Engine candidates | Accepted | Confidence | True-question recall | Assessment |
|---|---|---:|---:|---|---:|---|
| Chapter bookmarks | Question bookmarks | 18 | 479 | 479 `HIGH` | **0/573** | Severe mismatch: chapter IDs treated as question IDs |
| Chapter bookmarks | None | 18 | 0 | All refused | **0/573** | Safe but unusable |
| None | Question bookmarks | 18 | 14 | 14 `LOW` | **0/573** | Contents-page numbers treated as question IDs |
| None | None | 18 | 4 | 4 `MEDIUM` | **0/573** | Contents-page numbers treated as question IDs |

Manual sample review confirmed the nature of the false positives:

- Page 59 of the exercise book actually contains examples `1.78` and `1.79`, but the engine treats chapter `1.2 Single-variable Differential Calculus` as question `1.2`.
- Page 400 actually contains examples `2.187` and `2.197`, but the engine treats chapter `2.7 Linear Transformations` as question `2.7`.
- The real example 1.1 can be seen manually on exercise page 4 and answer page 5, but the engine then maps the entire page range of chapter 1.1 to answer 1.1, producing many repeated `HIGH` results.

This is not merely low OCR accuracy. OCR is not connected in the current host path. `createTextSource` exposes a recogniser interface, but the application `PdfWorkspace` does not call it. At the same time, the sparse text layer is treated as usable because chapter bookmarks exist, so a document that should return “OCR required” continues into matching.

## 6. Refusal Matrix for Mismatched Exercise and Answer Books

All cross-book and same-role tests used the original bookmarks. For every invalid combination, the correct result is whole-book refusal, 0 accepted matches, and 0 `HIGH` matches.

| Scenario | Accepted | `HIGH` | Whole-book refusal | Result |
|---|---:|---:|---|---|
| 2023 exercise -> 2025 answer | 872 | 872 | No | **Fail** |
| 2025 exercise -> 2023 answer | 479 | 479 | No | **Fail** |
| 2023 answer -> 2023 answer | 861 | 861 | No | **Fail** |
| 2025 answer -> 2025 answer | 889 | 889 | No | **Fail** |
| 2023 answer -> 2025 answer | 861 | 861 | No | **Fail** |
| 2025 answer -> 2023 answer | 786 | 786 | No | **Fail** |
| 2023 exercise -> 2023 exercise | 0 | 0 | Yes | Pass |
| 2025 exercise -> 2025 exercise | 0 | 0 | Yes | Pass |
| 2023 exercise -> 2025 exercise | 0 | 0 | Yes | Pass |
| 2025 exercise -> 2023 exercise | 0 | 0 | Yes | Pass |
| 2023 answer -> 2025 exercise | 0 | 0 | Yes | Pass |
| 2025 answer -> 2023 exercise | 0 | 0 | Yes | Pass |

Two-exercise-book inputs are rejected because the interface checks only whether the right-hand document is marked as an answer book. It does not verify that the left-hand document is an exercise book, which is why all two-answer-book inputs pass through.

`indexesComparable` also cannot determine whether two books belong together. The character-set overlap between the 2023 exercise book and the incorrect 2025 answer book is 0.9638, so the pair is classified as comparable. For two Chinese mathematics books, character-set similarity means only that their text can be compared; it does not prove that they are a valid pair.

## 7. Overall Assessment

| Capability | Assessment |
|---|---|
| Same pair, question-level bookmarks on both sides | Excellent: 100% unique recall, zero mismatch, and high speed |
| One side without bookmarks | Recall and/or strict precision is insufficient; not stable enough for the primary path |
| Both sides without bookmarks | Unique recall is only 9.84%, with accepted results that cannot be independently confirmed |
| Scanned exercise book | OCR is not connected in the current host; chapters are treated as questions and can produce `HIGH` mismatches |
| Cross-book mismatch refusal | Fail |
| Two-answer-book refusal | Fail |
| Two-exercise-book refusal | Pass, but only because of a one-sided role check |

Overall, the algorithm already has a high-quality question-level bookmark fast path, but it is not yet a safe general-purpose question-to-answer matching engine. The first priority should not be similarity-score tuning. It should be document-level safety gating and question-structure recognition.

## 8. Test Boundaries

- No tablet or physical-device testing was performed in this round, as requested.
- This evaluation covers question-to-answer location matching. It does not assess the mathematical correctness of the 573 answer solutions.
- The complete 2023 book was verified against independent bookmark ground truth. Because the 2025 exercise book has no question-level bookmarks, its conclusions are supported by the 573 question-level bookmarks in the answer book, text-coverage statistics, and manual inspection of representative pages.
- External OCR was not used for the 2025 book because the recogniser is not connected in the current product path. Running external OCR separately would hide the actual product behavior.

## 9. README Update

`README.zh-CN.md` was added, and language switches were added to the top of both the English and Chinese README files. The update was pushed to GitHub `main`:

- Commit: `1e0e9bb3c608d7c33845d0d3f9834995c2a0ecb9`
- Repository: https://github.com/LZY0105/Math-answer-to-question-matching-model

The Chinese README is a faithful translation of the existing English README and does not silently rewrite the project's metric claims. The English README statement that no-bookmark precision is always 100% uses a metric that excludes `unidentifiable` entries. After the algorithm is fixed, the metrics should be republished using the strict definition in this report.
