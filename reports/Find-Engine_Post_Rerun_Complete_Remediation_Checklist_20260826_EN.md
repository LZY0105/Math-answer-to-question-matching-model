# Find-Engine Post-Rerun Complete Remediation Checklist

- Date: 2026-08-26
- Basis: full rerun of `Find-Engine_Test_Checklist_20260826.md`
- Product decision: **preserve the engine core; refactor the orchestration layer; do not rewrite from scratch**
- Target: reliable question-to-answer matching for bookmarked, unbookmarked, reordered, and scanned mathematics books

## 1. Target orchestration architecture

The new coordinator should own the following pipeline and be the only public automatic-matching entry point:

1. **Document preparation** — stable fingerprint, role, title/year/subject identity, text-layer quality, OCR readiness, and manual-binding validation.
2. **Question selection** — full-book batch mode or one tablet click region; determine exactly one question boundary before extracting evidence.
3. **Index preparation** — chapter/section/question hierarchy, body-entry boundaries, FormulaSet multiset, keywords, and provenance for every field.
4. **Candidate retrieval** — hard filters followed by bounded Top-K retrieval; never compare every question with the whole answer book.
5. **Evidence evaluation** — complete FormulaSet gate first; plus/minus-three-character context only after that gate; then number, chapter, keywords, and prose similarity.
6. **Global resolver** — bidirectional consistency, one-to-one assignment, optional monotonic acceleration, crossing-order fallback, gaps, duplicates, and rollback.
7. **Decision arbiter** — calibrated `AUTO_MATCH / REVIEW / LOCATED / REFUSED / BLOCKED`; conflicts cap confidence and no lower rung is silently promoted.
8. **Operational layer** — cancellation, timeouts, cache, telemetry, explanation, and regression evidence.

Existing parsers and matchers may remain internal. Callers must not bypass pair preparation or the decision arbiter.

## 2. P0 — release blockers

### P0-1. Integrate a real OCR lifecycle

- [ ] Replace the truthy `recognizer` presence check with a typed adapter such as `recognizePage(page, region, signal)`.
- [ ] Keep `OCR_REQUIRED` until at least one required page/region has returned validated, non-empty, readable OCR text.
- [ ] Hydrate question/answer index entries from OCR output; do not merely set `recognizerAvailable`.
- [ ] Return explicit states: unavailable, queued, success, empty, timeout, cancelled, and failed.
- [ ] Add a per-page and per-region timeout; convert timeout/empty/failure to a fail-closed result, not an uncaught promise or silent `UNKNOWN_PAIR`.
- [ ] Cache successful OCR by document fingerprint + page + region + recognizer version.
- [ ] Negative-cache bounded failures with a short TTL to avoid retry storms.
- [ ] Never allow OCR presence alone to change pair status or remove `OCR_REQUIRED`.

Acceptance:

- [ ] On the 2025 pair, unavailable, empty, throwing, and timed-out recognizers all keep `OCR_REQUIRED` and `AUTO_MATCH=0`.
- [ ] A validated recognizer is called and its output appears in the index provenance.
- [ ] Mixed text/OCR pages select the readable source per page without combining stale or duplicate text.
- [ ] Cancellation stops rendering and recognition within the defined deadline.

### P0-2. Enforce complete FormulaSet before local context

- [ ] Determine one complete question region before formula extraction.
- [ ] Extract every complete mathematical expression from that region as a multiset; preserve duplicates.
- [ ] Canonicalize equivalent notation: `\\left/\\right`, whitespace, Unicode/LaTeX operators, bracket forms, commutative formatting only where mathematically safe, fractions, roots, limits, integrals, superscripts, and subscripts.
- [ ] Reject/cap automatic matching when any question expression is missing, conflicting, duplicated incorrectly, or structurally incomplete.
- [ ] Apply the gate to structural exact-ID matches as well as content-derived matches; a bookmark ID may retrieve a candidate but may not bypass the agreed automatic-match rule.
- [ ] Only after complete FormulaSet success, compare the three characters immediately to the left and right of each corresponding mathematical symbol/operator.
- [ ] Do not compute operator context over unrelated prose or across formula boundaries.
- [ ] Store evidence per expression: canonical form, completeness, matched candidate expression, structural comparison, left/right context, and conflict reason.

Acceptance:

- [ ] Partial one-of-two FormulaSet: `AUTO_MATCH=0` in content, aligned-section, and exact-ID paths.
- [ ] One conflict among otherwise matching formulas: `AUTO_MATCH=0`.
- [ ] Duplicate expression missing from the candidate: `AUTO_MATCH=0`.
- [ ] Truncated brackets/OCR formula: `AUTO_MATCH=0` and reason `FORMULA_INCOMPLETE`.
- [ ] Formatting-equivalent expressions pass canonical comparison.
- [ ] Reordered expressions pass while preserving multiset multiplicity.
- [ ] The plus/minus-three-character score is absent when FormulaSet did not pass.

Product note: the current corpus shows that many correct answer entries do not restate every question formula. Enforcing this rule will reduce automatic recall; such cases must move to `REVIEW`, not be silently promoted or called incorrect.

### P0-3. Implement click-region single-question matching

- [ ] Change the public request to include a validated page-space region and coordinate transform metadata.
- [ ] Map the tablet click/selection to exactly one question boundary.
- [ ] If the text layer is usable, extract only that region; otherwise OCR only that region.
- [ ] Reject ambiguous overlap with two questions or return a small explicit selection list.
- [ ] Do not scan or match all questions on the page after a region was supplied.
- [ ] Include the resolved question region and provenance in every result.

Acceptance:

- [ ] On 2023 page 5, a region over question `1.1` returns only `1.1`; a region over `1.2` returns only `1.2`.
- [ ] Same-page multi-question, margin click, boundary overlap, rotated page, zoomed coordinates, and crop-box offsets are covered.
- [ ] Region OCR is invoked only for the selected area.

### P0-4. Validate and invalidate manual bindings

- [ ] Define a signed/versioned binding record containing left fingerprint, right fingerprint, expected roles, corpus/product version, and creation time.
- [ ] Recompute both document fingerprints before accepting a binding.
- [ ] Reject a binding if either file changes, pages change, roles reverse, or version policy invalidates it.
- [ ] A binding may resolve missing positive identity evidence; it may never override a detected role/year/subject/content conflict.
- [ ] Replace `if (manualBinding)` with exact field validation and constant-time fingerprint comparison where appropriate.

Acceptance:

- [ ] Empty object, wrong fingerprints, reversed fingerprints, and stale fingerprints do not verify a pair.
- [ ] A valid binding verifies only the exact two files.
- [ ] One-byte/file revision invalidates the binding and returns an explicit reason.

## 3. P1 — accuracy, recall, and performance

### P1-1. Add bounded Top-K retrieval

- [ ] Build inverted indexes for normalized question ID, section path, formula skeleton/hash, rare keywords, and document-local anchors.
- [ ] Retrieve a bounded Top-K candidate set before expensive similarity scoring.
- [ ] Keep positional order as an optional acceleration signal, never a hard identity signal.
- [ ] Record which retrieval channel admitted each candidate.
- [ ] Stop at a strict candidate/time budget and abstain when evidence is insufficient.

Acceptance:

- [ ] Degraded-mode p95 below 150 ms on the current 2023/2024 corpus after warm indexing.
- [ ] No reduction in the 60-pair safety matrix.
- [ ] 2024 degraded Top-K review-hit coverage materially exceeds the current 35.9–54.4% baseline.

### P1-2. Repair body question/answer segmentation

- [ ] Separate section headings, contents rows, headers/footers, question openers, continuations, solutions, and neighbouring-question text.
- [ ] Keep entry text bounded to one question/answer; do not attach whole page ranges when a local heading boundary exists.
- [ ] Treat body-index missing evidence as `UNKNOWN`, not a conflict calibrated on outline indexes.
- [ ] Add 2024 MA and ALG page-level fixtures for over-extraction and repeated labels.

Acceptance:

- [ ] Body index size is close to the bookmark oracle, with documented tolerance.
- [ ] No formula from an adjacent entry is attached to the current entry.
- [ ] 2024 no-bookmark review misses fall substantially from the current baseline.

### P1-3. Add bidirectional consistency

- [ ] Compute question-to-answer and answer-to-question rankings independently.
- [ ] Automatic matching requires mutual agreement or an explicitly stronger structural proof.
- [ ] A contradiction caps to review/refusal; missing reverse evidence does not become a fabricated conflict.
- [ ] Record forward rank, reverse rank, and margin to runner-up.

Acceptance:

- [ ] Hard decoys and repeated-number candidates fail mutual agreement.
- [ ] Valid dual-bookmark recall remains 100% unless the complete-FormulaSet product rule intentionally caps it.

### P1-4. Add non-monotonic global one-to-one assignment

- [ ] Generate Top-K candidate edges per question.
- [ ] Lock only high-confidence anchors; medium/low matches remain provisional and reversible.
- [ ] Detect crossing anchors and switch from monotonic alignment to min-cost flow/Hungarian-style one-to-one assignment with explicit unmatched nodes.
- [ ] Maintain an occupied-answer set for speed, but never delete source entries; allow rollback on conflict.
- [ ] Support missing, extra, duplicated, locally swapped, block-reordered, and fully reordered answers.

Acceptance:

- [ ] Local swap and full reorder synthetic sets recover all uniquely evidenced matches.
- [ ] One answer is never assigned to two questions.
- [ ] Missing questions/answers remain unmatched rather than shifting every following pair.

### P1-5. Calibrate decisions and margins

- [ ] Define features and conflict ceilings separately from retrieval scores.
- [ ] Require a minimum winner score and a measured margin over second place.
- [ ] Train/calibrate only when at least six independent book pairs and hard negatives are available.
- [ ] Publish reliability curves for `AUTO_MATCH` and hit rates for `REVIEW`/`LOCATED`.
- [ ] Keep `LOW` out of automatic answers.

Acceptance:

- [ ] `AUTO_MATCH` precision target is met on held-out book pairs, not only pages from known books.
- [ ] Confidence bands correspond to measured correctness probabilities.

## 4. P2 — operational hardening

### P2-1. Persistent caches

- [ ] Replace object-identity-only cache keys with stable document fingerprints.
- [ ] Cache indexes, OCR pages/regions, formula ASTs, and retrieval structures by engine/schema version.
- [ ] Invalidate on file fingerprint, parser version, recognizer version, or configuration change.
- [ ] Keep the existing in-process cache as the hot layer.

### P2-2. End-to-end cancellation and budgets

- [ ] Propagate `AbortSignal` through PDF reading/rendering, OCR, indexing, retrieval, scoring, global assignment, and report generation.
- [ ] Return `CANCELLED` separately from `TIMED_OUT` and from “no match”.
- [ ] Add deterministic tests at every expensive stage.

### P2-3. Evidence and observability

- [ ] Emit a structured trace for pair gate, index source, OCR provenance, candidate retrieval, FormulaSet, context score, forward/reverse rank, assignment, and final ceiling.
- [ ] Log timing per stage and cache hits without storing book text by default.
- [ ] Make every non-automatic result explainable with stable reason codes.

### P2-4. Public API migration

- [ ] Export one orchestration entry point for product callers.
- [ ] Mark direct matcher/index modules as internal or legacy.
- [ ] Remove caller-supplied flags that can imply trust.
- [ ] Provide a migration guide and compatibility window.

## 5. Required regression corpus and CI matrix

- [ ] Preserve the current eight PDF hashes and the extracted corpus hash as a baseline.
- [ ] Run all four bookmark regimes for every valid pair.
- [ ] Run all 60 invalid role/pair combinations.
- [ ] Add a generic-title pair with insufficient identity evidence.
- [ ] Add a validated OCR truth set for the 2025 exercise book, with page/question boundaries and answer-page oracle.
- [ ] Add mixed text/OCR, OCR empty, OCR timeout, OCR failure, and cancellation fixtures.
- [ ] Add complete/partial/conflicting/truncated/formatted/reordered/multiplicity FormulaSet fixtures.
- [ ] Add real reordered, missing, extra, and duplicated answer-book fixtures.
- [ ] Add same-page click-region fixtures and coordinate transforms.
- [ ] Report automatic precision/recall, review hit rate, located precision/coverage, rejection accuracy, p50/p95/max, and cache behavior separately.

## 6. Release gates

### Limited bookmarked-book alpha

- [x] 60 invalid combinations produce zero automatic answers.
- [x] 2023/2024 dual-bookmark pairs have 100% strict precision and unique recall under the current policy.
- [ ] Complete FormulaSet product rule is implemented or explicitly revised by product decision.
- [ ] Manual binding cannot verify arbitrary objects.

### Tablet/no-bookmark beta

- [ ] Click-region selection demonstrably changes the selected question.
- [ ] P0 OCR lifecycle passes on 2025.
- [ ] 2024 degraded-mode Top-K latency and review coverage meet targets.
- [ ] Body segmentation regression fixtures pass.

### General release

- [ ] Bidirectional consistency and global one-to-one assignment pass reordered-book tests.
- [ ] End-to-end cancellation and persistent cache pass.
- [ ] Held-out book-pair calibration is available.
- [ ] All P0/P1 items and the full regression matrix are green.

## 7. Recommended implementation sequence

1. OCR lifecycle fail-closed fix.
2. Click-region question boundary API.
3. Complete FormulaSet multiset and post-gate three-character context.
4. Manual-binding fingerprint validation.
5. Body segmentation and Top-K retrieval.
6. Bidirectional consistency.
7. Non-monotonic global one-to-one resolver.
8. Calibration, persistent caches, observability, and API migration.

After each item, rerun the 208 checks, 16 valid regimes, 60 invalid combinations, formula probes, OCR probes, ordering probes, and lower-rung measurements. Do not accept a recall improvement that reintroduces a wrong automatic answer.
