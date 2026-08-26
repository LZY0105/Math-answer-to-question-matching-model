# Find-Engine Full Checklist Rerun Test Report

- Test date: 2026-08-26 (Asia/Shanghai)
- Repository snapshot: `1e0e9bb3c608d7c33845d0d3f9834995c2a0ecb9`
- Working tree: modified and uncommitted; this report identifies the tested corpus and evidence by SHA-256
- Checklist: `C:\Users\卢昭元\Desktop\Find-Engine_Test_Checklist_20260826.md`
- Checklist SHA-256: `179FB6481E402E8B39522E41D061A228F80272D131AF4015FABB7BE078AA28A6`
- Runtime: Node.js `v24.16.0`, npm `11.13.0`
- Scope: testing and analysis only; no engine business logic was changed during this rerun

## 1. Executive conclusion

**Overall release decision: NO-GO for a general tablet/scanned-book release.**

The verified dual-bookmark fast path is excellent: all three measurable 2023/2024 valid pairs retained 100% strict precision and 100% unique recall, and all 60 invalid pair/role combinations emitted zero automatic answers. The engine therefore has a sound safety foundation and is worth repairing rather than rewriting.

However, the current build does not satisfy the agreed product contract for a general release:

1. Passing any truthy OCR recognizer suppresses `OCR_REQUIRED`, although the recognizer is never called by pair preparation/indexing.
2. A partial FormulaSet can still become `AUTO_MATCH`; an exact structural ID can bypass even conflicting formulas.
3. the plus/minus-three-character operator context is blended into ordinary content similarity before the complete FormulaSet gate, rather than being used only after every complete expression has matched.
4. `matchQuestion({ page, region })` ignores `region`; two different click regions on a page with two questions return the same two answers.
5. manual binding accepts any truthy object when evidence is insufficient; it does not validate or invalidate document fingerprints.
6. answer reordering is handled by monotonic alignment only, so local and large reorderings reduce recall.
7. degraded 2024 modes remain slow and have limited useful review coverage because bounded Top-K retrieval and precise body-entry segmentation are missing.

The recommended strategy is **retain the present parsers, pair gate, decision rungs, and bookmark fast path; replace/refactor the orchestration layer around them**. A full rewrite is not justified.

## 2. Source sample verification

All eight user-supplied PDFs were present and readable. Page counts and recursive bookmark counts were independently checked against the current files. The corpus contains the same eight filenames and the same page counts.

| Document | Pages | Bookmarks | SHA-256 |
|---|---:|---:|---|
| `2023年名校数学专业考研真题分类_留白作答版.pdf` | 368 | 528 | `d1ef3049f07383aa4dca294943958d239220479c28a0600a768086f23b7a9fbc` |
| `2023年名校数学专业考研真题分类_完整答案解析.pdf` | 372 | 529 | `dd15188b3e48d180f7259241ba26e21ceb71dda98fe31d68550408baa40d24ff` |
| `2024年名校数学专业考研真题分类_数学分析留白作答版.pdf` | 200 | 271 | `04bdc1d03d655e018daa94b91eb28bc52f12715d0effcd3af17922f883cbcc72` |
| `2024年名校数学专业考研真题分类_高等代数留白作答版.pdf` | 197 | 217 | `7cfa19b27ea83faff0daf120bb79ecde2a60ce0f8b34976caaeb1a2aa8e95eba` |
| `2024年名校数学专业考研真题分类_高等代数完整答案.pdf` | 199 | 226 | `388db34cd7678c9b9a36cd186b63c639381a6d8c892c32c8cc8aa6d2b71fb3c4` |
| `2024年名校数学专业考研真题分类_数学分析完整答案.pdf` | 202 | 280 | `ab9d30db5197b01db54194667b4ea1cd71079e9d11dbe0469d1d15c3b6e76787` |
| `2025年数学专业考研真题分类(计算题证明题精分类无重影版).pdf` | 465 | 56 | `91e666f62b940df05f5dae95ad8c02a62c79a56bf8d52a87d0d674e28ea57f4f` |
| `2025年数学专业考研真题分类_573题完整答案解析.pdf` | 321 | 631 | `d27af445ea11b04afd4b7e188482f230371eb93e316a7ea2091c608749917141` |

Corpus: `C:\Users\卢昭元\Documents\ChatGPT\题目答案匹配引擎\tmp\expanded-corpus-20260825.json`

- Corpus SHA-256: `972FEC4A8D4FFB1138884B4C1E2364547F11D3D3C95D5C92CC76FB53471477C0`
- 2025 exercise text layer: 465 pages, 65 extracted lines, 609 characters; not sufficient for a question-level oracle

## 3. Commands and automated results

| Command | Result |
|---|---|
| `npm test` | PASS: 9 suites, 208 checks, 0 failed |
| `npm run test:unit` | PASS: 154 checks, 0 failed |
| `npm run test:scenarios` | PASS: 23 checks, 0 failed |
| `node tools/measure-regimes.mjs ...` | PASS as measurement; 16 valid-pair/bookmark regimes completed |
| `node tools/measure-pair-matrix.mjs ...` | PASS: 60 invalid combinations, zero `AUTO_MATCH` |
| `node tools/measure-located.mjs` | Completed; 2023 lower-rung and simulated page-only measurements |
| `node tmp/measure-lower-rungs-rerun-20260826.mjs ...` | Completed; lower-rung measurements for all four pair groups and four regimes |

Regime result file: `C:\Users\卢昭元\Documents\ChatGPT\题目答案匹配引擎\tmp\regimes-rerun-20260826.json`

- SHA-256: `88BFD2B99DF1EB90B68EFDC954235B29CAC0E6CA0BCAF1B539DB843B6BE753EC`

## 4. Mandatory safety gates

### 4.1 Invalid pair and role matrix

- Invalid combinations: 60
- Document-level blocked: 53/60
- Any automatic answer: **0/60**
- Total leaked automatic answers: **0**
- Reasons:
  - `RIGHT_ROLE_INVALID`: 24
  - `LEFT_ROLE_INVALID`: 20
  - `PAIR_IDENTITY_MISMATCH`: 9
  - `PAIR_IDENTITY_UNKNOWN + OCR_REQUIRED`: 7

This covers answer/exercise mismatch, answer/answer, exercise/exercise, reversed orientation, wrong year, and wrong subject. **PASS.**

### 4.2 Valid dual-bookmark capability

| Pair | Automatic rows | Wrong | Strict precision | Unique recall | p95 / max |
|---|---:|---:|---:|---:|---:|
| 2023 | 872 | 0 | 100.0% | 508/508 (100.0%) | 1 / 1 ms |
| 2024 Mathematical Analysis | 470 | 0 | 100.0% | 271/271 (100.0%) | 2 / 3 ms |
| 2024 Advanced Algebra | 413 | 0 | 100.0% | 217/217 (100.0%) | 1 / 2 ms |

**PASS.** The verified bookmark path is accurate and fast.

### 4.3 Scanned/sparse documents without OCR

The 2025 exercise book produced zero indexed questions and `OCR_REQUIRED` in all four bookmark regimes, with zero automatic answers. **PASS as fail-closed behavior; recognition accuracy is not measurable because no OCR recognizer or independent question-level oracle is available.**

## 5. All bookmark regimes and performance

| Pair | Regime | Q/A index | Auto | Wrong auto | Unique auto recall | p95 / max | Pair status |
|---|---|---|---:|---:|---:|---:|---|
| 2023 | both | OUTLINE/OUTLINE | 872 | 0 | 100.0% | 1 / 1 ms | VERIFIED |
| 2023 | answer no bookmarks | OUTLINE/CONTENTS | 0 | 0 | 0% | 68 / 227 ms | UNKNOWN |
| 2023 | exercise no bookmarks | BODY/OUTLINE | 30 | 0 | 3.7% | 359 / 531 ms | VERIFIED |
| 2023 | neither | BODY/CONTENTS | 0 | 0 | 0% | 53 / 173 ms | UNKNOWN |
| 2024 MA | both | OUTLINE/OUTLINE | 470 | 0 | 100.0% | 2 / 3 ms | VERIFIED |
| 2024 MA | answer no bookmarks | OUTLINE/BODY | 0 | 0 | 0% | 938 / 1,064 ms | UNKNOWN |
| 2024 MA | exercise no bookmarks | BODY/OUTLINE | 0 | 0 | 0% | 1,641 / 1,894 ms | UNKNOWN |
| 2024 MA | neither | BODY/BODY | 0 | 0 | 0% | 708 / 1,091 ms | UNKNOWN |
| 2024 ALG | both | OUTLINE/OUTLINE | 413 | 0 | 100.0% | 1 / 2 ms | VERIFIED |
| 2024 ALG | answer no bookmarks | OUTLINE/BODY | 0 | 0 | 0% | 635 / 969 ms | UNKNOWN |
| 2024 ALG | exercise no bookmarks | BODY/OUTLINE | 0 | 0 | 0% | 893 / 1,401 ms | UNKNOWN |
| 2024 ALG | neither | BODY/BODY | 0 | 0 | 0% | 866 / 1,028 ms | UNKNOWN |

All valid degraded pairs remained `VERIFIED` or `UNKNOWN`, never `REJECTED`, and no wrong automatic result was emitted. Safety passes; the 150 ms degraded-mode target fails on most body-index regimes.

## 6. Lower-rung measurement

“Actionable” below means the independently verified correct answer occurs in an `AUTO_MATCH`, the review candidate set, or the returned answer region. It does **not** mean the answer was automatically selected. Counts are distinct gold questions.

| Pair | Regime | Auto-correct | Review hit | Located hit | Actionable / gold |
|---|---|---:|---:|---:|---:|
| 2023 | both | 508 | 0 | 0 | 508/508 (100.0%) |
| 2023 | answer no bookmarks | 0 | 508 | 0 | 508/508 (100.0%) |
| 2023 | exercise no bookmarks | 19 | 381 | 0 | 400/508 (78.7%) |
| 2023 | neither | 0 | 508 | 0 | 508/508 (100.0%) |
| 2024 MA | both | 271 | 0 | 0 | 271/271 (100.0%) |
| 2024 MA | answer no bookmarks | 0 | 117 | 0 | 117/271 (43.2%) |
| 2024 MA | exercise no bookmarks | 0 | 135 | 0 | 135/271 (49.8%) |
| 2024 MA | neither | 0 | 103 | 0 | 103/271 (38.0%) |
| 2024 ALG | both | 217 | 0 | 0 | 217/217 (100.0%) |
| 2024 ALG | answer no bookmarks | 0 | 118 | 0 | 118/217 (54.4%) |
| 2024 ALG | exercise no bookmarks | 0 | 96 | 0 | 96/217 (44.2%) |
| 2024 ALG | neither | 0 | 78 | 0 | 78/217 (35.9%) |
| 2025 | all four | 0 | 0 | 0 | not measurable; no question-level oracle |

The earlier “lower-rung cost not measured” gap is now substantially closed for 2023/2024. Review/located precision is not represented by the coverage column; review misses were also observed in 2024, so candidates must not be silently promoted.

The existing page-only simulation on the 2023 bookmark oracle returned a region on 100% of 365 pages and contained the correct answer for 97.9% of covered questions. This is a simulation, not a result for the scanned 2025 book.

## 7. Formula and operator-context probes

The agreed rule is: identify one complete question region; extract **all complete mathematical expressions** as a multiset; require all of them to match; only then compare the three characters on each side of the corresponding mathematical symbol/operator.

| Probe | Current result | Verdict |
|---|---|---|
| Two expressions, candidate contains only one | coverage 0.5; content path `AUTO_MATCH`; exact-ID path `AUTO_MATCH` | **FAIL** |
| Two expressions, both structurally conflicting | content path capped to `REVIEW`; exact-ID path `AUTO_MATCH` with `notApplied=STRUCTURAL_ID` | **FAIL** against the agreed universal rule |
| Reordered complete formulas | coverage 1.0, both matched | PASS |
| Duplicate expression appears twice in question, once in answer | coverage 0.5, no ceiling | **FAIL multiplicity** |
| Truncated bracket/formula | incomplete and conflicting; capped to `REVIEW` | PASS |
| No formula in the question | not gated | PASS |
| Formatting-equivalent `\\left(...\\right)` versus ordinary parentheses | treated as a conflict and capped | **FAIL canonical equivalence** |

The operator-context radius is correctly set to three characters. It is currently computed for every operator in the normalized text and blended into content similarity before `formulaCeiling` runs. Therefore the required sequencing—complete FormulaSet first, local context second—is **not implemented**.

The current 0.10 FormulaSet coverage threshold was chosen to preserve the old corpus recall. Enforcing the user's 100% rule will intentionally move many correct-but-incomplete answers from automatic matching to review/refusal. The implementation must treat that as a product recall trade-off, not weaken the rule silently.

## 8. Ordering, uniqueness, and cancellation probes

Synthetic sequence results:

- Same order: 4/4 correct.
- One local swap (`A,C,B,D`): 3/4 correct, one unmatched, zero wrong.
- Large reorder (`C,A,D,B`): 2/4 correct, two unmatched, zero wrong.
- Missing answer: remaining answers correct, missing question unmatched.
- Extra answer: all four questions correct.
- Duplicate answer: no duplicate assignment in the synthetic control.

The monotonic alignment is safe around gaps and extras but loses recall when order crosses. Global non-monotonic one-to-one assignment is not implemented.

Cancellation probes:

- Pre-aborted signal: all entries returned unmatched, `timedOut=true`, no guess.
- Forced deadline expiry: all entries returned unmatched, `timedOut=true`, no guess.

This passes the core bounded-alignment cancellation behavior. Cancellation has not yet been proven at PDF rendering, OCR, index construction, pair verification, and candidate retrieval stages.

## 9. Click-region, binding, OCR, and cache probes

### 9.1 Click-region interface

On 2023 page 5, the index contains questions `1.1` and `1.2`. Baseline, left-side region, and right-side region calls all returned the identical two automatic matches (`1.1` at answer page 19 and `1.2` at page 20). `region` is not part of the public method signature and is ignored. **FAIL.**

### 9.2 Manual binding

A truthy binding object with deliberately wrong fingerprints changed a 2025 pair from `UNKNOWN_PAIR` to `VERIFIED_PAIR`; the fingerprints were not read. OCR still prevented an automatic answer in that probe. Binding invalidation after a file change is not implemented. **FAIL.**

Hard role/year/subject conflicts are checked before manual binding in the current verifier, so a binding cannot override an already detected hard conflict. The unsafe gap is insufficient-evidence pairs: any truthy binding is accepted.

### 9.3 OCR lifecycle

Using the real 2025 pair:

| Recognizer probe | Recognizer calls | Decision | Q entries |
|---|---:|---|---:|
| absent | 0 | `OCR_REQUIRED` | 0 |
| returns empty text | 0 | `UNKNOWN_PAIR` (no `OCR_REQUIRED`) | 0 |
| throws | 0 | `UNKNOWN_PAIR` (no `OCR_REQUIRED`) | 0 |
| returns text | 0 | `UNKNOWN_PAIR` (no `OCR_REQUIRED`) | 0 |

This proves the recognizer is a presence flag in pair preparation, not an integrated recognition stage. **P0 FAIL.**

At the standalone text-source seam, a successful OCR page is cached (two reads, one recognizer call). A failing recognizer is called again, its exception propagates, and no failure/timeout result is cached. No timeout policy is implemented there.

### 9.4 Pair/index cache

Preparing the same 2023 adapter objects twice caused zero additional PDF text-extraction calls, so the in-process `WeakMap` document/index cache works. A fresh adapter object re-indexes. The repeated preparation still took about 5.3 seconds because pair verification/alignment work is recomputed. There is no persistent fingerprint-keyed cache across object recreation or process restart.

## 10. Checklist disposition

| Area | Result |
|---|---|
| 208 automated checks | PASS |
| 60 invalid combinations, zero automatic answers | PASS |
| Three dual-bookmark valid pairs | PASS |
| All valid degraded regimes never falsely rejected | PASS |
| 2025 without OCR fails closed | PASS |
| 2025 with validated OCR | BLOCKED / recognizer not integrated |
| Complete FormulaSet before local context | FAIL |
| Formula multiplicity and canonical formatting | FAIL |
| Reordered answer books | PARTIAL; safe abstention but recall loss |
| Missing/extra/duplicated answers | synthetic PASS; real corpus absent |
| Generic-title insufficient identity document | NOT MEASURABLE; corpus lacks such a sample |
| Manual binding validation/invalidation | FAIL |
| Mixed layer/OCR, timeout, empty OCR | FAIL at orchestration; standalone seam only partially works |
| Click-region single-question selection | FAIL |
| Cancellation | PARTIAL PASS; alignment only |
| Pair/index caching | PARTIAL PASS; in-process object cache only |
| Bidirectional consistency | NOT IMPLEMENTED |
| Global non-monotonic one-to-one assignment | NOT IMPLEMENTED |
| Bounded Top-K retrieval | NOT IMPLEMENTED |
| Confidence calibration/reliability curves | NOT IMPLEMENTED |

## 11. Final assessment

The current engine is **repairable**. Its strongest assets—the role/pair safety gate, bookmark structure, explicit decision rungs, abstention behavior, and verified fast path—should be preserved. Rewriting those components would add risk without solving the measured weaknesses.

Release should remain blocked until at least the OCR presence-flag defect, complete FormulaSet ordering, click-region API, and binding fingerprint validation are fixed and re-run against this same corpus and the same 60-pair safety matrix. The companion remediation checklist translates these findings into development tasks and acceptance gates.
