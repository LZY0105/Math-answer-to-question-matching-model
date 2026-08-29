# Public synthetic PDF fixture

This directory contains the source specification for Find-Engine's public demo corpus. The rendered PDFs live in [`output/pdf/demo`](../../output/pdf/demo) and can be regenerated with:

```bash
python tools/generate-demo-fixtures.py
```

The fixture is deliberately synthetic: 24 derivative questions, their matching 2026 answer key, and a structurally similar 2025 answer key used to prove wrong-book refusal. Every PDF has a chapter bookmark and 24 question-level bookmarks, readable text, and deterministic labels.

The fixture data and generated PDFs are dedicated to the public domain under CC0 1.0. The engine remains MIT-licensed. `pdfjs-dist` is a development-only adapter dependency used to open these PDFs in Node; it is not imported by the zero-runtime-dependency core under `src/`.

One-command terminal demo:

```bash
npm install
npm run demo
```

Local web workbench:

```bash
npm run demo:web
```

Then open <http://127.0.0.1:4173>.
