# Find-Engine Modification Checklist

[中文](Find-Engine_修改建议清单_20260825.md) | [English](Find-Engine_Modification_Checklist_20260825.md)

The order is deliberate: eliminate confidently wrong matches before improving recall or speed.

## P0: Release blockers

- [ ] **Gate both document roles**
  - The current host checks only whether the right document is an answer key.
  - Require left=`EXERCISE` and right=`ANSWER` before indexing or matching.
  - Cover Q→A, A→A, Q→Q, and A→Q through the public matching interface.

- [ ] **Add pair identity before stage 0**
  - Introduce `VERIFIED_PAIR`, `UNKNOWN_PAIR`, and `REJECTED_PAIR`.
  - An exact shared label cannot produce `HIGH` unless the pair is verified.
  - Alphabet overlap is a comparability check, not identity. The wrong 2023-question/2025-answer pair still reached 0.9638 overlap.
  - Combine normalized title, year, edition, subject, section structure, label distribution, and sampled same-label content margin.
  - Scanned input without content evidence remains unknown until OCR or other strong evidence is available.

- [ ] **Separate section and question bookmarks**
  - `1.2 Single-variable differential calculus` and `2.7 Linear transformations` are sections, not questions.
  - Prefer explicit markers such as `Example`, `Exercise`, `Problem`, or their Chinese equivalents.
  - Use depth, children, page span, label density, and sequence continuity.
  - A node spanning dozens of pages cannot represent one question.

- [ ] **Recognize sparse layers as scanned input**
  - Add text-page coverage, characters per page, and distribution to the quality gate.
  - The 2025 exercise book has 465 pages, 65 extracted lines, and 609 characters and must become `SCANNED` or `SPARSE_LAYER`.
  - Existing section entries must not bypass the OCR requirement.

- [ ] **Connect a real OCR recognizer to the host path**
  - `createTextSource` has a recognizer seam, but the current workspace path never uses it.
  - OCR pages or regions on demand and cache them.
  - Missing or failed OCR returns `OCR_REQUIRED` with accepted=0.
  - OCR output still passes structural and pair-identity gates.

## P1: No-bookmark precision and performance

- [ ] **Implement the complete per-question flow agreed during design**
  - In single-question mode, determine the exercise boundary from the user's click or explicit ID and read only that question. In full-book mode, process from the first exercise onward without irreversible greedy commitment that can cause cascading drift.
  - Build the answer-book index once and keep it immutable. Filter by pair identity, label, section, and inverted indexes before scoring content.
  - Extract **every complete mathematical expression** in the current question into a `FormulaSet` that preserves multiplicity, order, and location. Grouping, fractions, radicals, scripts, integral/limit bounds, and matrix structure must remain complete.
  - High confidence requires complete `FormulaSet` coverage with no strong conflict. Matching only a subset is insufficient. A truncated expression, broken OCR, or uncertain question boundary can only produce review or refusal.
  - Compare the three characters to the left and right of each expression only after that complete expression matches. Context cannot trigger a match alone or rescue an incomplete or conflicting formula.
  - Require exercise-to-answer and answer-to-exercise consistency. Use order only as a windowing optimization when reliable; use global one-to-one assignment when order differs.
  - Add high-confidence answers to an occupied set. Keep lower-confidence assignments provisional and reversible; never delete questions or answers from the source indexes.

- [ ] **Count `unidentifiable` accepted results as false positives**
  - Report both `verified_precision` and `strict_precision`.
  - Release acceptance uses `strict_precision = correct / accepted`.
  - The full 2023 no-question-bookmark regime scored 544/732 = 74.3% under this strict definition.

- [ ] **Tighten body question parsing**
  - Body parsing produced 730 candidates against 508 gold questions.
  - Exclude table-of-contents rows, sections, page numbers, years, and subquestions.
  - Use PDF layout coordinates, font data, density, page span, and chapter sequence where available.

- [ ] **Tighten body answer segmentation**
  - Body parsing produced 1,235 candidates against 508 answers.
  - Use answer prefixes, sequential labels, section boundaries, and solution-block termination.
  - A repeated label without content or section evidence is not an accepted answer.

- [ ] **Do not display `LOW` as a final answer**
  - Treat `LOW` as a review candidate.
  - Only a verified pair with sufficient calibrated evidence can become an automatic answer.

- [ ] **Reduce the no-question-bookmark candidate set**
  - Use normalized-label, section, and formula inverted indexes before similarity scoring.
  - Precompute math fragments, operator context, and normalized text.
  - Current p95 is 380.9 ms with a 1,534.6 ms maximum; target desktop p95 below 150 ms without relying on timeouts.

## P2: Regression tests, metrics, and documentation

- [ ] **Add the four PDFs to the external real-corpus checklist**
  - Keep copyrighted content out of Git if needed, but require explicit local/CI paths.
  - Lock file fingerprints, page counts, bookmark counts, and label ranges.

- [ ] **Add the whole-book mismatch matrix**
  - Q23→A25 and Q25→A23: document rejection, accepted=0, HIGH=0.
  - A23→A23, A25→A25, A23→A25, A25→A23: all rejected.
  - Same-year and cross-year Q/Q pairs: all rejected.
  - A→Q reverse pairs: all rejected.

- [ ] **Run no-bookmark tests over the complete books**
  - Do not rely on every-8th/every-16th-page sampling.
  - Any accepted result outside independent bookmark gold is a false positive.

- [ ] **Add a scanned-section regression**
  - Current 2025 exercise input without OCR returns `OCR_REQUIRED`, accepted=0.
  - Section titles such as `1.2 ...` and `2.7 ...` remain sections.
  - After OCR, the first target is at least 95% unique recall at 100% strict precision; improve recall later without trading away precision.

- [ ] **Add complete-formula-set and reordered-answer regressions**
  - A multi-formula question with only partial formula coverage cannot produce `AUTO_MATCH`.
  - Compare per-formula left/right three-character context only after every complete formula match; similar context alone cannot pass the gate.
  - A missing or truncated expression, or a conflict in scripts, integral bounds, or matrix elements, produces `REVIEW` or `REFUSED`.
  - Reordered answers still receive correct one-to-one assignments, and no answer is reused.
  - Perturbing an early high-confidence pair must allow provisional assignments to roll back without cascading drift.

- [ ] **Correct the README metric definition**
  - Explain the difference between verified and strict precision.
  - Do not use a 100% value that excludes `unidentifiable` accepted results as the headline for all matches.
  - State clearly that scanned input is unavailable without a configured recognizer.

- [ ] **Return document-level diagnostic reasons**
  - Standardize `LEFT_ROLE_INVALID`, `RIGHT_ROLE_INVALID`, `PAIR_IDENTITY_MISMATCH`, `PAIR_IDENTITY_UNKNOWN`, `OCR_REQUIRED`, and `NO_QUESTION_LEVEL_INDEX`.
  - Log evidence summaries, not complete copyrighted question text.

## Suggested acceptance gates

- [ ] All current 138 checks remain green.
- [ ] 2023 with question bookmarks: 508/508 unique recall and 100% strict precision.
- [ ] Every cross-book mismatch: 100% document rejection, accepted=0, HIGH=0.
- [ ] Every two-answer, two-exercise, and answer-to-exercise pair: 100% document rejection.
- [ ] Scanned input without OCR: `OCR_REQUIRED`, accepted=0.
- [ ] Scanned input with OCR: first milestone at least 95% unique recall and 100% strict precision.
- [ ] Every bookmark regime reports strict precision, unique recall, refusal rate, and p95 without hiding `unidentifiable`.
- [ ] No-question-bookmark desktop p95 below 150 ms; maximum does not hit the algorithm timeout.
- [ ] Every automatic multi-formula match has 100% complete `FormulaSet` coverage and zero structural conflicts; partial coverage never returns `AUTO_MATCH`.
- [ ] Three-character left/right context participates only after its complete formula matches and cannot independently reverse a refusal.
- [ ] Reordered, missing, and extra-item corpora preserve global one-to-one assignment; occupied state is reversible and source indexes remain immutable.
