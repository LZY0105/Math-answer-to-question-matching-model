---
name: "Find-Engine"
description: "A calm evidence workbench where answers are earned, reviewed, or refused."
colors:
  paper-ground: "#f4f1e8"
  paper-deep: "#ebe6da"
  reading-surface: "#fbfaf6"
  ink-navy: "#17243d"
  ink-soft: "#536070"
  rule: "#c9c3b5"
  rule-strong: "#9c978d"
  auto-sage: "#4e7569"
  auto-sage-soft: "#dce6df"
  review-amber: "#a66f27"
  review-amber-soft: "#f0e2ca"
  blocked-red: "#9f4d45"
  blocked-red-soft: "#edd9d5"
typography:
  display:
    fontFamily: "Iowan Old Style, Palatino Linotype, Noto Serif SC, serif"
    fontSize: "clamp(34px, 4.2vw, 58px)"
    fontWeight: 500
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Iowan Old Style, Palatino Linotype, Noto Serif SC, serif"
    fontSize: "25px"
    fontWeight: 500
    lineHeight: 1.12
  body:
    fontFamily: "Segoe UI Variable Text, Noto Sans SC, Microsoft YaHei UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Segoe UI Variable Text, Noto Sans SC, Microsoft YaHei UI, sans-serif"
    fontSize: "11px"
    fontWeight: 800
    letterSpacing: "0.13em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "10px"
    fontWeight: 400
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
rounded:
  near-square: "3px"
  circular: "50%"
components:
  workbench:
    backgroundColor: "{colors.reading-surface}"
    textColor: "{colors.ink-navy}"
    rounded: "{rounded.near-square}"
  scenario-active:
    backgroundColor: "{colors.ink-navy}"
    textColor: "{colors.reading-surface}"
    rounded: "{rounded.near-square}"
    padding: "11px 14px"
    height: "66px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink-navy}"
    rounded: "{rounded.near-square}"
    padding: "8px 16px"
    height: "38px"
  status-auto:
    backgroundColor: "{colors.auto-sage}"
    textColor: "{colors.reading-surface}"
    rounded: "{rounded.circular}"
    size: "36px"
  status-review:
    backgroundColor: "{colors.review-amber}"
    textColor: "{colors.reading-surface}"
    rounded: "{rounded.circular}"
    size: "36px"
  status-blocked:
    backgroundColor: "{colors.blocked-red}"
    textColor: "{colors.reading-surface}"
    rounded: "{rounded.circular}"
    size: "36px"
---

# Design System: Find-Engine

## Overview

**Creative North Star: "The Evidence Desk"**

Find-Engine is a calm editorial workbench, not a generic dashboard. Warm paper, navy ink, mathematical serif type, compact operational labels, and fine rules make the interface feel like a carefully annotated proof. The central visual idea is a split-document desk: exercise evidence and answer evidence are joined by a narrow decision spine that makes the engine's gates legible.

The interface must communicate epistemic discipline. An automatic answer is visually positive only after every gate completes; incomplete evidence is held for review; incompatible documents are visibly refused. Real source identity and the evidence trail take priority over decoration or promotional claims.

**Key Characteristics:**

- Editorial paper and ink rather than SaaS chrome.
- Dense but calm information hierarchy built with fine rules.
- One continuous evidence ledger instead of a grid of cards.
- Semantic status expressed with words, icons, structure, and color together.
- Near-square surfaces, restrained elevation, and honest source material.

## Colors

The palette is warm, low-saturation, and evidence-led. Paper Ground and Reading Surface carry nearly the entire page; Ink Navy supplies typography, the local-product header, active controls, and strong boundaries.

### Primary

- **Ink Navy:** The authoritative ink for text, active controls, footer/header fields, and the strongest structural edge.
- **Paper Ground:** The editorial canvas behind the workbench and evidence sections.

### Secondary

- **Automatic Sage:** Reserved for verified completion, shared anchors, completed trace steps, and local-ready indicators.
- **Review Amber:** Reserved for evidence caps, manual-review outcomes, and keyboard focus.
- **Blocked Red:** Reserved for pair rejection, stopped gates, missing output, and local-run failure.

### Neutral

- **Reading Surface:** The cleanest layer for document work, excerpts, and the complete workbench.
- **Paper Deep:** A recessed field behind embedded PDF pages.
- **Ink Soft:** Supporting prose, metadata, filenames, and secondary measurements.
- **Rule / Rule Strong:** Hairline grouping and stronger section boundaries; rules structure the interface without turning regions into cards.

**The Semantic Accent Rule.** Sage, amber, and red describe evidence states only. Never use them as interchangeable decoration.

**The Ink Majority Rule.** Navy and paper dominate every screen. Status color stays rare enough to remain diagnostic.

## Typography

**Display Font:** Iowan Old Style, with Palatino Linotype and Noto Serif SC fallbacks

**Body Font:** Segoe UI Variable Text, with Noto Sans SC and Microsoft YaHei UI fallbacks

**Label/Mono Font:** The platform monospace stack, led by ui-monospace and SFMono-Regular/Consolas

**Character:** The serif voice names evidence and outcomes with scholarly calm. Sans-serif copy handles explanation; monospaced type identifies files, counts, timings, section indices, and machine verdicts.

### Hierarchy

- **Display:** Use only for the page thesis or similarly singular editorial statements; keep the tight line height and slightly compressed tracking.
- **Headline:** Use for verdicts and document titles. Prefer medium weight over bold display type.
- **Body:** Use for explanations and operating guidance. Keep paragraphs short and legible against warm paper.
- **Label:** Use compact uppercase text for provenance, source roles, gate status, and section kickers.
- **Mono:** Use for filenames, timing, counts, IDs, and literal decision terms such as `AUTO_MATCH`.

**The Three-Voice Rule.** Serif names the evidence, sans-serif explains it, and monospace records it. Do not blur those roles.

## Layout

The page uses a broad centered canvas (`min(1500px, 94vw)`) beneath a slim sticky navy header. The opening region pairs one editorial thesis with a ruled proof strip; the scenario selector follows as one segmented control so all three safety paths are visible together.

The signature desktop composition is a three-column workbench: exercise document, narrow decision spine, answer document (`1fr / 0.56fr / 1fr`). It is a single bordered object with a strong navy top rule, not three detached cards. The evidence ledger continues the same reading axis below.

At `1100px` and below, preserve the exercise-plus-decision relationship on the first row and move the answer source below. At `720px` and below, use one vertical flow with the decision first, then both source readers. The mobile first viewport must still expose all scenario paths, both source identities, the verdict, the three evidence gates, counts/timing, and the rerun action before the long PDF readers begin.

Use the compact spacing scale for operational interiors and the larger steps between evidence regions. Hairline rules provide most grouping; blank space separates major chapters rather than individual cards.

**The Evidence-Before-Reader Rule.** On narrow screens, preserve decision context and document identity before asking the user to scroll through a PDF.

## Elevation & Depth

The system is flat by default. Depth comes from paper tone, inset document frames, rules, and one restrained ambient shadow (`0 16px 36px rgba(23, 36, 61, 0.08)`). Apply that shadow only to the complete workbench and the matched excerpt; everything else stays on the page plane.

**The One-Desk Rule.** Elevate the workbench as a whole, never each internal region.

## Shapes

Corners are nearly square. Use the small radius only to soften controls and containers without making them playful. One-pixel borders and a three-pixel navy top rule define the main desk.

Circles are semantic punctuation: local-ready dots, state marks, and numbered gate steps. Do not apply pill shapes to ordinary labels, controls, or metadata.

**The Circle Means State Rule.** Circular geometry signals progress, status, or ordered evidence; it is not ornamental.

## Components

### Local Product Header

A slim sticky navy band carries the Find-Engine name, local-demo state, core constraint, and repository link. Keep metadata compact and allow low-priority copy to disappear on narrow screens; never make the header feel like marketing navigation.

### Safety Path Selector

Present the three paths as one ruled segmented control. Every option includes an authored line icon, a plain-language title, and a short consequence. Selection uses navy fill plus `aria-pressed`; hover uses only a light paper wash. Disable every path while a run is active.

### Document Source Pane

Each pane shows its source role, document title, page count, literal filename, and a native embedded PDF. Use real committed PDF fixtures, not screenshots or decorative mock documents. The small “Open PDF” control may overlay the reader edge but must retain a visible amber focus outline.

### Decision Spine

This is the signature component. It combines a progress rule, status icon, verdict label, outcome headline, three ordered gates, results/timing, and a full-width rerun action. State changes must update the entire semantic cluster rather than recoloring a single badge.

- **Loading:** Use a short sage progress trace, pending copy, disabled controls, and no exposed answer.
- **AUTO_MATCH:** Use sage only after identity, question evidence, and safety verdict all complete.
- **REVIEW:** Use amber when a candidate exists but required evidence or adapter capability is incomplete.
- **BLOCKED:** Use red when identity conflicts, gates stop, or the local run fails; explain that no answer was shown.

### Evidence Ledger and Matched Excerpt

The ledger is one continuous ruled list with numbered entries and right-aligned semantic verdicts. The matched excerpt is the only secondary raised surface: two text fragments joined by a directional authored SVG, never a screenshot.

### Motion and Accessibility

Motion is functional and brief: control state changes use roughly `160ms`; decision progress uses `200–300ms`; the loading rule pulses at `900ms`. Do not animate PDFs or evidence content. Under `prefers-reduced-motion: reduce`, remove smooth scrolling and collapse animation/transition duration to an effectively immediate change.

Keyboard focus is a high-contrast three-pixel amber outline with offset. Active scenario state is exposed through `aria-pressed`; busy controls are disabled; status is never color-only. Maintain readable contrast on paper and navy, and preserve native PDF controls.

## Do's and Don'ts

### Do:

- **Do** keep evidence, refusal, and downgrade as legible as successful matching.
- **Do** keep both document identities adjacent to the verdict, especially before mobile readers.
- **Do** use authored inline SVG for interface icons and mathematical marks.
- **Do** label synthetic evidence honestly and keep measurements scoped to what the repository proves.
- **Do** preserve the approved Canva reference record at `.impeccable/mocks/canva-reference.json` as provenance for topology, palette, restrained density, and the central trace.

### Don't:

- **Don't** ship raster artwork in the web surface. `.impeccable/mocks/canva-reference.png` and review screenshots are review-only provenance, not runtime assets.
- **Don't** reproduce the Canva reference's tiny type, excessive empty space, decorative grid, or generated copy.
- **Don't** replace real public PDFs with screenshot facsimiles or imply that synthetic fixtures are customer data.
- **Don't** create repeated floating cards, generous pill UI, loud gradients, glossy effects, or multiple competing shadows.
- **Don't** use sage, amber, or red without the matching word, icon, and evidence explanation.
- **Don't** hide uncertainty, upgrade `REVIEW` to success, or expose an answer after a blocked gate.
