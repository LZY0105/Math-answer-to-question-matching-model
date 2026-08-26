# Find-Engine — Response to the Post-Rerun Remediation Checklist

- Date: 2026-08-26
- Applies to: the working tree (**uncommitted**)
- Corpus: `tmp/expanded-corpus-20260825.json`, 8 documents — the same corpus as the rerun report
- Suites: 9 files, **212 automated checks**, 0 failed
- Answers: `Find-Engine_Full_Checklist_Rerun_Test_Report_20260826_EN.md`

Every figure below is reproducible with a command in §7. Where something could
not be measured, or could not be reproduced, it says so.

---

## 1. The four P0 blockers

| Blocker | Before | Now |
|---|---|---|
| OCR interface never invoked | recognizer was a presence flag; 0 calls | **called; only successful recognition clears `OCR_REQUIRED`** |
| Complete FormulaSet not enforced | partial coverage → `AUTO_MATCH`; exact ID bypassed conflicts | **STRICT is the default; no structural-ID exemption** |
| Click regions ignored | `region` not in the signature | **`region` selects per page; never silently ignored** |
| Manual binding unvalidated | any truthy object promoted a pair | **fingerprints checked; stale bindings invalidate** |

### 1.1 OCR lifecycle (§9.3)

| Recognizer | Calls | `OCR_REQUIRED` | Q entries | Origin |
|---|---:|---|---:|---|
| absent | 0 | true | 0 | TEXT_LAYER |
| returns empty text | 397 | true | 0 | TEXT_LAYER |
| throws | 397 | true | 0 | TEXT_LAYER |
| returns text | 397 | **false** | **397** | **OCR** |

The gate is no longer "was a recognizer supplied" but "did recognition produce
text this engine can index". A recognizer that returns nothing, throws, or yields
a layer still too sparse leaves `OCR_REQUIRED` set. Per-page failures are
contained so one bad page cannot abort a document. Recognised documents carry
`textOrigin: 'OCR'` and an `ocr` provenance block.

### 1.2 Manual binding (§9.2)

| Binding | Result |
|---|---|
| none | `UNKNOWN_PAIR` |
| truthy junk object | `UNKNOWN_PAIR` + `BINDING_MALFORMED` |
| deliberately wrong fingerprints | `UNKNOWN_PAIR` + `BINDING_STALE` |
| valid binding | **`VERIFIED_PAIR` + `PAIR_BOUND_MANUALLY`** |
| valid binding, file then changed | **`UNKNOWN_PAIR` + `BINDING_STALE`** |

A fingerprint is pages + outline shape + label count + label range + a digest
over sampled lines. No cryptographic claim: this detects a document being
replaced or re-issued, which is what invalidation is for.

### 1.3 Click region (§9.1)

Region selection needs geometry, which is the adapter's to provide.

- **Text-only adapter** → returns the page's questions **and reports
  `regionApplied: false, regionReason: 'REGION_UNSUPPORTED_BY_ADAPTER'`**. It no
  longer silently returns everything as though it had selected.
- **Adapter reporting line geometry** → different taps return different
  questions. Measured on 2023 page 5 (questions 1.1 and 1.2): top-of-page → 1.2
  only; bottom-of-page → none, `REGION_EMPTY`.

Geometry is stored **per page**, not once per entry: a question spanning two
pages occupies a different band on each, and a first-page-only extent selected
everything when the tap landed on the second.

---

## 2. The FormulaSet rule — enforced, and what it costs

STRICT is now the default: every complete expression in the question must have a
counterpart, zero structural conflicts, **no exemption for an exact identifier**.

### 2.1 First, the rule was made much cheaper

The rule looked unenforceable because coverage on *known-correct* pairs was
0.41–0.89. The cause was that an entry's text was its whole **page range**, so
the expressions attributed to a question were partly its neighbours'. Three
changes, each measured against decoys so coverage was not bought with false
positives:

- **Entry-scoped text** — bounded by the printed headings the book itself supplies.
- **Intra-line cleaning** — running heads, section titles and page numbers are
  glued *inside* the character stream (`limf(x)=…=0x` vs `…=035x`, where 35 is a
  page number), so line-level filtering cannot reach them.
- **Fuzzy expression matching at 0.80** — chosen from a measured table; decoys
  stay at 0.0% full coverage at that threshold and only begin to appear at 0.70.

Share of known-correct pairs reaching **full** coverage:

| Pair | Before | After |
|---|---:|---:|
| 2023 | 42.5% | **92.5%** |
| 2024 Math Analysis | 0.0% | **60.5%** |
| 2024 Adv Algebra | 0.0% | **78.8%** |

### 2.2 Then the residual cost, measured

| Pair | CALIBRATED | STRICT (agreed rule) | Wrong, either policy |
|---|---|---|---|
| 2023 | 508/508 (100%) | **470/508 (92.5%)** | **0** |
| 2024 Math Analysis | 271/271 (100%) | **159/271 (58.7%)** | **0** |
| 2024 Adv Algebra | 217/217 (100%) | **175/217 (80.6%)** | **0** |

**This is the decision that belongs to you, and it is the one thing in this
document I cannot settle.** Two facts sit beside each other:

- Your report is right that a partial FormulaSet reaching `AUTO_MATCH` is a
  defect, and STRICT closes it.
- On this corpus STRICT's measured precision gain is **zero** — both policies
  produce 0 wrong — because the bookmark identifier is already correct on all
  1,755 questions. It removes correct answers and no incorrect ones.

Two further findings bear on the choice:

- The dominant cap reason is `FORMULA_CONFLICT` (71 / 107 / 64), not
  `FORMULA_SET_MISSING`. Those are expressions differing by an extraction
  artefact, not by mathematics.
- **The rule fails multiplicatively with question size.** Full coverage is 76.7%
  for questions with 1–2 expressions and 12.9% for 11+. Requiring all of N
  things from noisy input has a failure rate that compounds — a property of the
  rule, not evidence that the answer is wrong.

Both policies are exercised in the suite, so neither can drift silently:
`preparePair({ formulaPolicy: FORMULA_POLICY.CALIBRATED })` switches.

---

## 3. One reported item I could not reproduce

**Canonical formatting equivalence (§7) is already correct.**

```
raw        : 求 f(x) = \left( x^2 + 1 \right) 的导数
normalised : 求f(x)=(x^2+1)的导数
plain      : 求f(x)=(x^2+1)的导数
coverage 1.0, conflicts 0
```

Full-width parentheses and arbitrary spacing also fold correctly. The reported
`ight)` artefact is what a shell produces when `\r` becomes a carriage return —
I hit exactly that while probing. I have not "fixed" this, because there is
nothing there to fix and the change would have been complexity for nothing.

`\dfrac{...}` does extract no expressions — a real limitation, but these PDFs
emit glyphs rather than LaTeX, so it does not arise on this corpus.

---

## 4. Safety, re-verified after all changes

- **60 invalid combinations: 0 automatic answers.** 53/60 blocked at document
  level (24 `RIGHT_ROLE_INVALID`, 20 `LEFT_ROLE_INVALID`, 9
  `PAIR_IDENTITY_MISMATCH`); 7 held at `UNKNOWN_PAIR` + `OCR_REQUIRED`.
- **No valid pair is ever rejected**, in any of the 12 degraded regimes.
- **2025 without OCR**: `OCR_REQUIRED`, 0 accepted, all four regimes.
- **Both oracles still agree** — the bookmark trees and the printed-label content
  check — with zero contradictions on every accepted match.

---

## 5. Defects I introduced and caught during this work

Recorded because they are the kind that would otherwise be discovered later:

1. **Repetition key stripped digits** — collapsed every question from one
   university onto one key; would have deleted 495 of 508 real questions.
2. **Cleaner stripped question headings** — it derived titles from the *whole*
   outline, and question bookmarks are titled `例题 1.6`, so it deleted the very
   boundary the scoping relies on. Took the content oracle from 100% to 0% and
   rejected two valid pairs. Now section titles only.
3. **Scoping applied to the entry's main text** — cut 2024 answer entries from
   3,265 to 587 characters, moving every threshold calibrated against them at
   once. Scoped text now lives *alongside* the page-range text, used only where
   contamination actually matters.
4. **Post-OCR guards tested pre-OCR state** — successful recognition produced 0
   entries because the body-parse guard and the structure filters still described
   the discarded layer.

The pattern in 2–4 is one thing: **a threshold calibrated on one representation
must not be silently handed a different one.**

---

## 6. What remains — unchanged from your report

1. **A real recognizer.** The seam is now exercised end-to-end with a
   deterministic fake; no OCR engine is connected, so 2025 recognition accuracy
   remains unmeasurable.
2. **Bidirectional consistency (H02)** — not implemented.
3. **Global non-monotonic assignment (H03)** — not implemented; reordered books
   still lose recall safely rather than answering wrongly.
4. **Bounded Top-K retrieval (G01–G04)** — not implemented; 2024 degraded p95
   remains ~0.7–1.6 s.
5. **Confidence calibration (I04)** — ordinal bands remain the decision
   mechanism, as the architecture requires until ≥6 book pairs exist.
6. **Persistent fingerprint-keyed cache** — the in-process object cache stands
   (matrix ~10 min → 21 s); nothing survives a restart.

**Release recommendation: unchanged — NO-GO for a general scanned/tablet
release**, on item 1 alone. The four P0 orchestration blockers are closed and the
verified-bookmark path is intact, but a scanned book still cannot be served
without a recognizer, and that is a capability gap no amount of gate work
removes.

---

## 7. Reproduction

```bash
cd ~/Documents/ChatGPT/题目答案匹配引擎

npm test                              # 9 suites, 212 checks
node tools/measure-pair-matrix.mjs    # 60 invalid combinations (~21 s)
node tools/measure-regimes.mjs tmp/expanded-corpus-20260825.json

node tmp/ocr-lifecycle.mjs            # §9.3 table
node tmp/region-binding-probe.mjs     # §9.1 and §9.2 tables
node tmp/policy-cost.mjs              # STRICT vs CALIBRATED
node tmp/canonical-probe.mjs          # the non-reproducible §7 item
```
