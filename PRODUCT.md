# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated for this demo: static HTML, CSS, and JavaScript served by Node's built-in HTTP server. The matching core remains dependency-free; PDF.js is confined to the public demo adapter as a development dependency.

## Users

- Primary: recruiters and technical interviewers evaluating the project quickly on a local machine.
- Secondary: developers integrating the matching engine into a document reader or study application.

## Product Purpose

Find-Engine matches questions in an exercise PDF to entries in a separate answer key, or refuses when the evidence is insufficient or the documents do not belong together. The public demo must let a reviewer observe that behavior without access to copyrighted textbooks.

## Positioning

The distinguishing mechanism is fail-closed document matching: a wrong automatic answer is treated as more costly than no answer, so role, identity, text-quality, and structure gates constrain a five-rung decision system.

## Operating Context

The demo runs locally from one npm command, reads committed CC0 synthetic PDFs through a PDF.js adapter, and calls the same engine interface used by host applications. It presents a correct pair, a wrong-year pair, and an unsupported click-region case.

## Capabilities and Constraints

- Preserve the dependency-free `src/` matching core.
- Public demo content is synthetic and carries no textbook copyright.
- Current measured evidence: 996 resolved questions with zero wrong across three paired corpora; 0 of 60 invalid pairings auto-answered; 278 checks passed before this demo suite was added.
- The scanned-book automatic matching path is not released and its per-question accuracy remains unmeasured.
- The public page demonstrates local execution; it must not imply hosted production deployment.

## Brand Commitments

- Name: Find-Engine.
- User direction: simple and elegant.
- Canva is the visual concept source for this surface; reference design `DAHTlaPNzs8`, titled “Refined Find-Engine Developer Dashboard.”

## Evidence on Hand

- `README.md` and `RESEARCH-REPORT.md` contain the current methodology, limits, and measured results.
- `output/pdf/demo/` contains the public synthetic exercise book, correct answer key, and wrong-year answer key.
- `test/test_demo.js` verifies the PDF adapter, all three scenarios, and the HTTP adapter.
- No customer testimonials, production traffic, or deployment claims are available and none may be fabricated.

## Product Principles

1. Show the engine deciding, not a static imitation of its result.
2. Make refusal and downgrade as legible as successful matching.
3. Keep evidence scoped and label synthetic data explicitly.
4. Let a reviewer reach a meaningful result within one minute.
5. Keep adapters thin so the core remains reusable and independently testable.
