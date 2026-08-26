# Find-Engine Orchestration-Layer Complete Remediation Checklist

- Date: 2026-08-26
- Decision: **salvage the engine; do not rewrite it from scratch.** Preserve the indexing, outline classification, text-quality assessment, OCR seam, normalization, local similarity and existing regression assets. Replace the current caller-controlled orchestration with one deep `MatchingEngine` module.
- Safety objective: a wrong automatic answer is worse than an explicit refusal. Recall may recover in later phases, but unsafe `AUTO_MATCH` results must be eliminated first.
- Scope: engine-side orchestration. Tablet click targeting is supported as an input, but no safety rule may depend on the tablet host enforcing it correctly.

## 1. Preserved Baseline Artifacts

The following reports are evidence baselines and must not be overwritten, renamed or silently regenerated:

- [Chinese expanded test report](./Find-Engine_2023_2025_扩展全面测试报告_20260826.md)
- [English expanded test report](./Find-Engine_2023_2025_Expanded_Comprehensive_Test_Report_20260826.md)
- [Previous Chinese modification checklist](./Find-Engine_修改建议清单_20260825.md)
- [Previous English modification checklist](./Find-Engine_Modification_Checklist_20260825.md)
- [Find-Engine v2 Chinese architecture](./Find-Engine_v2_产品需求与架构设计_20260825.md)
- [Find-Engine v2 English architecture](./Find-Engine_v2_Product_Requirements_and_Architecture_20260825.md)

Verified SHA-256 values before this remediation document was created:

- Chinese expanded test report: `47268E867C16729DFF2BB7648EE61F4EA3CE373C8F89CD88B9C5EEB8E3343249`
- English expanded test report: `9B63DB084A1460BC82E7D3B8BDD52B20D93846FC39908D23FB2EA3C8712974DE`

Checklist:

- [ ] Store every new regression run in a newly dated file.
- [ ] Record the Git commit, dirty-worktree state, corpus manifest and runner version in every report.
- [ ] Compare a new run with the preserved baseline instead of replacing the baseline.
- [ ] Keep raw result JSON beside the human-readable report.

## 2. Evidence-Based Diagnosis

### 2.1 What is already reusable

- `src/answer-index.js::indexDocument` already supports outline-first and body-text indexing, sampled text-quality assessment, printed-contents corroboration and lazy indexing.
- `src/text-source.js::createTextSource` already provides a useful OCR seam: the recognizer is injected, page text is cached, and OCR is used only when the text layer cannot serve the request.
- `src/outline-classify.js`, `src/toc-filter.js`, `src/contents-index.js` and `src/boilerplate.js` are useful structure-cleaning implementations.
- `src/question-matcher.js` contains reusable pure or near-pure implementations for normalization, local content scoring, outline alignment and bounded monotonic alignment.
- `src/decision.js` already defines pair statuses, output rungs and pair-permission capping.
- The current local suite passes 170/170 tests. This is a valuable regression asset, but it does not prove orchestration safety.

### 2.2 What is unsafe in the current main path

- `matchQuestion(question, candidates, options)` accepts caller-controlled evidence flags such as `exactId`, `sectionAligned` and `crossBookComparable`.
- A unique label with `exactId=true` returns `matched=true` and `HIGH` before content or complete-formula verification.
- `matchPage()` defaults `pairStatus` to `VERIFIED_PAIR`. Its own source comment states that this default is wrong for the product and exists only to preserve legacy behavior.
- Pair permissions are applied at the end by `assignRungs()`. They can cap a result only when the caller supplied the correct pair status; the engine does not currently establish that status itself.
- `matchPage()` mixes candidate selection, exact-label shortcuts, range selection, monotonic alignment, positional handling, scoring and final decision. This is a shallow public interface around a large amount of caller-visible policy.
- The repository has no implemented `preparePair` symbol. There is no production `FormulaSet` implementation; the term appears only in regression probes. No bidirectional matcher implementation was found. The existing `alignSequences()` is monotonic and one-to-one, but it is not a non-monotonic global assignment solver for reordered books.
- The source package exposes many low-level functions. Tests and tools call `indexQuestionDocument`, `indexAnswerDocument`, `alignOutlines`, `matchPage` and `matchQuestion` directly, so no single interface guarantees the required gate order.

### 2.3 Why 170 passing tests are not sufficient

- The core suite confirms useful local behavior and the strongest 2023/2024 bookmark paths.
- The expanded report exercises broader full-book and invalid-pair combinations that the normal suite does not block.
- Preserved expanded-test findings include 52 failing cases out of 60 wrong-book/wrong-role scenarios, 11,629 incorrect `HIGH` probes, zero 2024 recall when the answer key lacks bookmarks, low strict precision in several 2024 no-bookmark regimes, scanned 2025 pages being treated as usable text, and all three complete-formula safety probes failing.
- Therefore the new test surface must be the `MatchingEngine` interface, not only the current shallow functions.

## 3. Target Deep Module and Interface

The orchestration seam must live at one module:

```text
preparePair(input) -> PairPrepared | PairRejected
PairSession.matchQuestion(target) -> MatchDecision
PairSession.matchAll(options?) -> BookMatchResult
```

Illustrative use:

```js
const prepared = await matchingEngine.preparePair({
  exerciseDocument,
  answerDocument,
  recognizer,
  binding,
});

if (prepared.status === 'REJECTED_PAIR') return prepared.decision;

const one = await prepared.session.matchQuestion({ page, region });
const all = await prepared.session.matchAll();
```

Only the following facts may cross the external interface:

- document handles or document adapters;
- an optional recognizer adapter;
- an optional previously verified manual binding;
- a target question identifier, page or click region;
- cancellation, timeout and explicitly documented performance options.

The following values must **not** be accepted from callers:

- `exactId`;
- `sectionAligned`;
- `crossBookComparable`;
- `pairStatus`;
- `confidence` or an output-rung ceiling;
- any Boolean claiming that a formula, role or document identity was verified.

Those are internal evidence derived by the module implementation.

### 3.1 Real seams and adapters

Keep only two external seams:

1. `DocumentAdapter`
   - production adapter: the actual PDF workspace implementation;
   - test adapter: an in-memory/fixed-corpus document.
2. `RecognizerAdapter`
   - production adapter: the selected OCR implementation;
   - test adapter: deterministic OCR fixtures/fakes.

Do not create public interfaces for every internal step. Candidate retrieval, scoring, formula comparison and assignment are internal seams unless two genuinely different adapters are required.

### 3.2 Required state machine

```text
NEW
 -> ROLE_CHECKED
 -> VERIFIED_PAIR | UNKNOWN_PAIR | REJECTED_PAIR
 -> INDEX_READY | OCR_REQUIRED
 -> QUESTION_READY
 -> FORMULA_SET_READY
 -> CANDIDATES_READY
 -> SCORED
 -> REVERSE_CHECKED
 -> ASSIGNED
 -> DECIDED
```

Forbidden transitions:

- `UNKNOWN_PAIR -> AUTO_MATCH`
- `REJECTED_PAIR -> any matching operation`
- `OCR_REQUIRED -> content-based AUTO_MATCH`
- `QUESTION_READY -> scoring` before formula-set extraction completes
- partial, truncated or conflicting `FormulaSet -> AUTO_MATCH`
- a caller-provided label or position hint -> `AUTO_MATCH` without independent engine evidence

## 4. Target Data Contracts

### 4.1 `PairDecision`

```text
status: VERIFIED_PAIR | UNKNOWN_PAIR | REJECTED_PAIR
exerciseRole: EXERCISE | ANSWER | UNKNOWN
answerRole: EXERCISE | ANSWER | UNKNOWN
reasonCodes: string[]
evidence: {
  normalizedTitle,
  year,
  edition,
  subject,
  outlineAgreement,
  anchorAgreement,
  manualBinding
}
```

### 4.2 `FormulaSet`

```text
expressions: FormulaExpression[]
complete: boolean
source: TEXT_LAYER | OCR
coverage: number
missing: FormulaReference[]
conflicts: FormulaConflict[]
contexts: { expressionId, left3, right3 }[]
```

An expression must retain grouping, signs, roots, fractions, subscripts, superscripts, limits, integral/sum/product ranges and operator structure. The left/right three-character context is evaluated only after the corresponding complete expression matches.

### 4.3 `MatchDecision`

```text
status: AUTO_MATCH | REVIEW | LOCATED | REFUSED | BLOCKED
band: HIGH | MEDIUM | LOW | NONE
answerLocation: object | null
region: object | null
cappedBy: string | null
reasonCodes: string[]
evidence: {
  pairVerified,
  questionBoundaryVerified,
  labelAgreement,
  formulaCoverage,
  formulaConflicts,
  operatorContextAgreement,
  topTwoMargin,
  bidirectionalAgreement,
  assignmentStability,
  orderPriorUsed
}
candidates: CandidateSummary[]
```

## 5. File-Level Remediation Map

### Preserve and move behind the new interface

- [ ] `src/answer-index.js`: preserve indexing, printed-contents corroboration and immutable index records.
- [ ] `src/text-source.js`: preserve lazy hydration, cache and recognizer injection.
- [ ] `src/text-quality.js`: preserve the quality vocabulary; revise sparse-layer classification and whole-document density evidence.
- [ ] `src/outline-classify.js`, `src/toc-filter.js`, `src/contents-index.js`, `src/boilerplate.js`: preserve as internal structure implementations.
- [ ] `src/question-id.js`, `src/symbol-context.js`, `src/glyph-map.js`: preserve as internal pure implementations.
- [ ] `src/region-locator.js`: preserve the ability to return a useful region without claiming an identified answer.
- [ ] `src/decision.js`: preserve rung capping, but make the final arbiter consume internally produced evidence.

### Refactor

- [ ] `src/question-matcher.js`: stop treating it as the product orchestrator. Keep pure scoring/alignment implementations internally.
- [ ] Convert `matchQuestion()` and `matchPage()` into temporary compatibility adapters after callers migrate.
- [ ] Remove caller-controlled verification flags from the new interface.
- [ ] Change any legacy default from `VERIFIED_PAIR` to `UNKNOWN_PAIR` during the safety phase.
- [ ] Prevent `applyPositionalSupport()` from promoting a result beyond the ceiling allowed by pair, formula and assignment evidence.

### Add

- [ ] `src/matching-engine.js`
- [ ] `src/pair-session.js`
- [ ] `src/pair-verifier.js`
- [ ] `src/question-boundary.js`
- [ ] `src/formula-set.js`
- [ ] `src/candidate-retriever.js`
- [ ] `src/bidirectional-check.js`
- [ ] `src/assignment-solver.js`
- [ ] `src/confidence-calibrator.js`
- [ ] `src/reason-codes.js`

Do not add all files as pass-through wrappers. Merge internal steps when their interface would be nearly as complex as their implementation. The deletion test applies: deleting `MatchingEngine` should force its gate ordering and safety policy to reappear in every caller.

## 6. Ordered Remediation Checklist

## P0-A. Freeze evidence and create failing interface tests

- [ ] **A01 — Freeze the corpus manifest.**
  - Include 2023 matched books, both 2024 subjects, 2025 scanned questions/answers, wrong-year pairs, cross-subject pairs, A/A, Q/Q and A/Q role reversals.
  - Done when every alias has a file fingerprint, page count, expected role, expected pair status and ground-truth source.

- [ ] **A02 — Add `test/test_matching_engine.js` as the primary test surface.**
  - Tests must call only `preparePair`, `matchQuestion` and `matchAll`.
  - Done when the known unsafe scenarios fail before implementation and cannot bypass the new seam.

- [ ] **A03 — Standardize metrics.**
  - `strict_precision = correct AUTO_MATCH / total AUTO_MATCH`
  - `unique_recall = correct unique answers / total questions`
  - `located_coverage`, `located_precision`, `review_hit_rate`, refusal rate and false-auto rate must be reported separately.
  - Done when README, console output, raw JSON and reports use the same definitions.

## P0-B. Establish the orchestration seam

- [ ] **B01 — Implement `MatchingEngine.preparePair()`.**
  - It owns role inspection, pair verification, text-quality/OCR gating and index construction.
  - Done when no host constructs pair status or comparability flags.

- [ ] **B02 — Implement `PairSession`.**
  - It owns immutable indexes, verified anchors, caches, provisional assignments and locked high-confidence assignments.
  - Done when single-question and full-book flows use the same evidence and decision rules.

- [ ] **B03 — Make legacy calls fail safe.**
  - Default legacy `pairStatus` to `UNKNOWN_PAIR` or require it explicitly.
  - Temporarily cap the legacy exact-label shortcut at `REVIEW` until complete-formula verification exists.
  - Done when direct legacy calls cannot produce an unverified `AUTO_MATCH`.

- [ ] **B04 — Enforce import discipline.**
  - Product callers may import only the new engine interface.
  - Low-level exports may remain temporarily for focused pure-function tests and migration tools, not product decisions.

## P0-C. Role and pair-identity gate

- [ ] **C01 — Classify document roles.**
  - Evidence may include answer prefixes, worked-solution density, blank-answer-space patterns, title/metadata and structure.
  - `EXERCISE -> ANSWER` is the only auto-matchable orientation.

- [ ] **C02 — Build a pair fingerprint.**
  - Normalize year, edition, subject, title, outline hierarchy, approximate question count and sampled anchors.
  - Generic shared titles are weak evidence; year or subject conflict is a hard rejection.

- [ ] **C03 — Define pair-state policy.**
  - `VERIFIED_PAIR`: eligible for all rungs, subject to later gates.
  - `UNKNOWN_PAIR`: may return `REVIEW` or `LOCATED`, never `AUTO_MATCH`.
  - `REJECTED_PAIR`: return `BLOCKED` and perform no matching.

- [ ] **C04 — Support verified manual binding.**
  - Store both document fingerprints. Any file change invalidates the binding.
  - Manual binding may resolve insufficient metadata; it must not override a detected year/subject conflict without an explicit unsafe mode outside normal product behavior.

## P0-D. Text-quality and OCR gate

- [ ] **D01 — Move text assessment into `preparePair()`.**
  - Judge both sampled page quality and whole-document density signals such as pages, non-empty lines, characters per page and spatial coverage.

- [ ] **D02 — Correct sparse-layer classification.**
  - A 465-page document with only 65 lines and 609 extracted characters must not be `USABLE` merely because those few characters are readable.
  - Introduce `SPARSE_LAYER` or map it to `SCANNED/OCR_REQUIRED`.

- [ ] **D03 — Fail closed without a recognizer.**
  - `SCANNED`, `BLANK`, `CORRUPT` and unsafe sparse layers return `OCR_REQUIRED`; accepted and auto-match counts must be zero.

- [ ] **D04 — Preserve provenance.**
  - Every hydrated record records `TEXT_LAYER` or `OCR` plus quality and page coverage.

- [ ] **D05 — OCR locally.**
  - Single-question mode OCRs only the located question/answer regions where possible.
  - Full-book OCR is an explicit preparation job with progress, cancellation and cache reuse.

## P0-E. Structure and question-boundary gate

- [ ] **E01 — Use an explicit node vocabulary.**
  - `BOOK`, `SECTION`, `QUESTION_TYPE`, `QUESTION`, `UNKNOWN`.
  - A node with children or a descriptive chapter title is never silently promoted to a question.

- [ ] **E02 — Separate body parsing from printed-contents corroboration.**
  - Body parsing proposes question records.
  - Printed contents may corroborate location/structure; it does not by itself prove a question-answer identity.

- [ ] **E03 — Resolve one complete question boundary.**
  - Click mode starts from the user-selected page/region.
  - Batch mode uses question-level structure and page geometry.
  - Multiple questions on one page must not share one undifferentiated range.

- [ ] **E04 — Degrade honestly.**
  - If only a section range is known, return `LOCATED`, not an identified answer.

## P0-F. Complete FormulaSet gate

- [ ] **F01 — Extract every complete mathematical expression in the question.**
  - Preserve expression order and/or multiset multiplicity.
  - Record extraction completeness, truncation and OCR uncertainty.

- [ ] **F02 — Compare complete mathematical structure first.**
  - Parentheses, grouping, signs, exponents, indices, fractions, roots, limits and operator neighborhoods are structural evidence.

- [ ] **F03 — Require full question-level formula coverage for `AUTO_MATCH`.**
  - Missing or extra material, a structural conflict or incomplete extraction caps the decision at `REVIEW` or `REFUSED`.

- [ ] **F04 — Apply the three-character context rule correctly.**
  - Only after each complete expression matches, compare approximately three characters on its left and right.
  - Context breaks ties; it cannot trigger or rescue a match.

- [ ] **F05 — Remove the exact-label bypass.**
  - Exact labels narrow retrieval. They do not bypass question-boundary or FormulaSet gates.

## P1-A. Bounded candidate retrieval

- [ ] **G01 — Build independent indexes.**
  - Pair/subject, section path, normalized label, formula structural fingerprint and selected keywords.

- [ ] **G02 — Retrieve bounded Top-K candidates.**
  - Measure `K=3, 5, 8, 16`; choose by recall-at-K and latency, not intuition.

- [ ] **G03 — Record retrieval reasons.**
  - Every candidate records which indexes admitted it and which hard filters removed alternatives.

- [ ] **G04 — Keep order as a soft accelerator.**
  - Use a local window only after high-confidence anchors show that order is reliable.
  - Always retain an escape route for reordered material.

## P1-B. Scoring, reverse checking and global assignment

- [ ] **H01 — Fuse independent evidence without hiding conflicts.**
  - Pair identity, label, section, complete formulas, context, prose, order and OCR quality remain separate features.
  - A hard conflict caps the result regardless of a high total score.

- [ ] **H02 — Add bidirectional consistency.**
  - Q->A and A->Q must select each other before `AUTO_MATCH` is possible.

- [ ] **H03 — Add full-book one-to-one assignment.**
  - Ordered books may use bounded monotonic alignment.
  - Reordered books require a sparse non-monotonic assignment over Top-K edges with gaps and unmatched records allowed.

- [ ] **H04 — Use reversible occupancy.**
  - Lock only high-confidence stable pairs.
  - Keep medium/low pairs provisional and reassign them when conflicts appear.
  - Never delete source entries during matching.

- [ ] **H05 — Run stability checks.**
  - Small harmless perturbations to formatting, OCR whitespace or candidate order should not change an automatic decision.
  - An unstable top result is capped at `REVIEW`.

## P1-C. Decision and calibrated confidence

- [ ] **I01 — Centralize the final arbiter.**
  - It is the only implementation allowed to emit `AUTO_MATCH`.

- [ ] **I02 — Replace `matched + HIGH/MEDIUM/LOW` ambiguity.**
  - `AUTO_MATCH`, `REVIEW`, `LOCATED`, `REFUSED`, `BLOCKED` are behavioral outcomes.
  - A `LOW` band is never an automatic match.

- [ ] **I03 — Require an evidence certificate for `AUTO_MATCH`.**
  - Verified pair, verified question boundary, complete FormulaSet, no structural conflict, sufficient Top-2 margin, bidirectional agreement and stable one-to-one assignment.

- [ ] **I04 — Calibrate confidence on held-out data.**
  - Include hard negatives: adjacent years, same label/different question, same prose/different formula, partial OCR and reordered answer books.
  - Do not report a probability until calibration error and reliability curves are measured.

- [ ] **I05 — Define stable reason codes.**
  - `LEFT_ROLE_INVALID`, `RIGHT_ROLE_INVALID`, `PAIR_IDENTITY_MISMATCH`, `PAIR_IDENTITY_UNKNOWN`, `OCR_REQUIRED`, `NO_QUESTION_LEVEL_INDEX`, `FORMULA_EXTRACTION_INCOMPLETE`, `FORMULA_SET_MISSING`, `FORMULA_CONFLICT`, `AMBIGUOUS_TOP2`, `BIDIRECTIONAL_MISMATCH`, `ASSIGNMENT_CONFLICT`, `UNSTABLE_MATCH`, `TIMEOUT`.

## P1-D. Performance and resource safety

- [ ] **J01 — Cache pair preparation and immutable indexes by document fingerprint.**
- [ ] **J02 — Hydrate only the target and Top-K candidate regions.**
- [ ] **J03 — Bound candidate counts, alignment bands, memory and elapsed time.**
- [ ] **J04 — Propagate cancellation through OCR, retrieval, scoring and assignment.**
- [ ] **J05 — Report stage-level p50/p95/max latency separately from OCR time.**
- [ ] **J06 — Target single-question p95 below 150 ms excluding external OCR, while preserving the fast verified-bookmark path near its current performance.**

## P2. Migration, observability and cleanup

- [ ] **K01 — Migrate product callers first, then tools and tests.**
- [ ] **K02 — Mark `matchPage()` and `matchQuestion()` deprecated after parity.**
- [ ] **K03 — Remove or privatize caller-facing safety flags.**
- [ ] **K04 — Replace shallow orchestration unit tests with interface tests.**
  - Keep pure-function tests for normalization, formula parsing, text quality and assignment.
  - Remove redundant tests that assert internal call order after the same behavior is covered through `MatchingEngine`.
- [ ] **K05 — Emit structured evidence traces with no page text or personal data by default.**
- [ ] **K06 — Update README, integration guide, result schema and migration notes.**
- [ ] **K07 — Add a feature flag for staged rollout and a documented rollback to legacy review-only behavior.**
- [ ] **K08 — Remove legacy orchestration only after all release gates pass in two consecutive full-corpus runs.**

## 7. Required Test Matrix

### 7.1 Valid document pairs

- [ ] 2023 Q/A: both bookmarks, question-only bookmarks, answer-only bookmarks, no bookmarks.
- [ ] 2024 Mathematical Analysis Q/A: same four structure regimes.
- [ ] 2024 Advanced Algebra Q/A: same four structure regimes.
- [ ] 2025 Q/A: without OCR and with validated OCR.

### 7.2 Pair and role rejection

- [ ] wrong-year Q->A;
- [ ] same-year wrong-subject Q->A;
- [ ] A->A;
- [ ] Q->Q;
- [ ] A->Q;
- [ ] one exercise book with two answer books;
- [ ] two exercise books with one answer book;
- [ ] generic titles with insufficient identity evidence;
- [ ] verified manual binding and invalidated binding after file change.

### 7.3 Structure and ordering

- [ ] section title resembling a hierarchical question number;
- [ ] multiple questions on one page;
- [ ] repeated labels across sections;
- [ ] reordered answers;
- [ ] missing answer;
- [ ] extra answer;
- [ ] duplicated answer;
- [ ] large reordered blocks and local swaps;
- [ ] question-level structure missing but section-level region available.

### 7.4 Formula safety

- [ ] all complete formulas match;
- [ ] only a subset matches;
- [ ] one formula missing;
- [ ] one conflicting formula;
- [ ] same prose but different formula;
- [ ] same formula but different local context;
- [ ] formatting-equivalent formula;
- [ ] OCR-truncated formula;
- [ ] formulas reordered with preserved multiplicity;
- [ ] a question with no mathematical expression.

### 7.5 Text quality and OCR

- [ ] clean layer;
- [ ] degraded layer;
- [ ] opaque but mutually comparable font mapping;
- [ ] corrupt layer;
- [ ] blank layer;
- [ ] sparse layer;
- [ ] scanned document;
- [ ] mixed layer/OCR pages;
- [ ] recognizer unavailable, timeout and empty OCR output.

### 7.6 Interface and operational behavior

- [ ] click-region single-question match;
- [ ] explicit question-id match;
- [ ] full-section and full-book match;
- [ ] cancellation at every expensive stage;
- [ ] timeout produces no partial automatic answer;
- [ ] repeated calls reuse indexes and OCR cache;
- [ ] evidence and reason-code schema remains stable.

## 8. Release Gates

### Mandatory safety gates

- [ ] All 60 wrong-book/wrong-role/double-answer/double-exercise scenarios: `AUTO_MATCH=0`, accepted automatic answers=0.
- [ ] All complete-formula safety probes: `AUTO_MATCH=0` when a formula is missing, partial, truncated or conflicting.
- [ ] 2025 without OCR: `OCR_REQUIRED`, `AUTO_MATCH=0` and accepted=0.
- [ ] No caller can force an automatic result by passing a Boolean evidence flag.

### Capability preservation

- [ ] 2023 valid dual-bookmark strict precision = 100% and unique recall = 100%.
- [ ] Both 2024 valid dual-bookmark sets strict precision = 100% and unique recall = 100%.
- [ ] The existing 170 tests remain green until equivalent interface tests replace redundant shallow tests.

### Degraded-mode quality

- [ ] Automatic strict precision remains 100% on the locked evaluation corpus.
- [ ] Coverage, review hit rate and location precision are reported separately; none may be presented as automatic-match precision.
- [ ] No-bookmark recall improvements are accepted only if strict precision does not regress.

### Performance

- [ ] Single-question p95 < 150 ms excluding external OCR.
- [ ] Candidate comparisons are bounded by configured Top-K and documented fallbacks.
- [ ] Full-book execution respects timeout and memory limits.
- [ ] Verified bookmark fast path has a measured non-regression budget.

## 9. Safe Delivery Sequence

Each line should be a small reviewable commit with its own tests:

1. Add failing `MatchingEngine` interface tests and frozen corpus manifest.
2. Add the interface as a compatibility wrapper with no intended behavior change.
3. Change legacy defaults to fail safe and block caller-forged evidence.
4. Implement role and pair verification; make invalid-pair tests pass.
5. Implement sparse-layer/OCR gating; make 2025 no-OCR tests pass.
6. Implement question boundaries and complete FormulaSet; make formula probes pass.
7. Introduce bounded candidate retrieval while preserving valid bookmark behavior.
8. Add bidirectional consistency and sparse global one-to-one assignment.
9. Add final arbitration, stability checks and confidence calibration.
10. Migrate product callers and deprecate the legacy entry points.
11. Replace redundant shallow orchestration tests with interface tests.
12. Run the full locked corpus twice, archive both reports, then remove legacy orchestration.

## 10. Stop/Go Rules

- Stop the release if any invalid pair emits `AUTO_MATCH`.
- Stop the release if a partial/conflicting FormulaSet emits `AUTO_MATCH`.
- Stop the release if a scanned or sparse document proceeds without OCR or an explicit non-answer degradation.
- Stop the release if the new interface reduces verified bookmark accuracy.
- Do not stop solely because recall initially falls after fail-closed gates; measure refused cases and recover recall in the next phase.
- Do not tune similarity thresholds before the P0 gates are enforced through the only production interface.

## 11. Final Recommendation

The engine is recoverable. Its indexing, normalization, structure, OCR seam and local scoring provide useful leverage. The defect is architectural: the current shallow entry points let callers supply verification facts, apply pair restrictions too late, and allow exact labels to bypass evidence. The remediation should therefore preserve the existing implementations behind a new deep `MatchingEngine` interface, centralize gate ordering and make that interface the test surface.

The development priority is:

1. close the pair and OCR gates;
2. remove exact-label automatic acceptance;
3. establish question boundaries and complete FormulaSet coverage;
4. add bounded retrieval, reverse checking and global one-to-one assignment;
5. calibrate confidence and optimize performance only after safety is proven.
