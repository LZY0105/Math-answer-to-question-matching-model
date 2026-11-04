"""Read the formulas off whole PDF pages, for the matching engine.

The recogniser in this directory reads ONE formula crop. The engine consumes
a page: a list of regions, each with its vertical extent and either the LaTeX
the model produced or, with --oracle, the text the PDF's own layer holds in
that region. The second is the upper bound the first is measured against,
and the way the engine's plumbing is checked before a model is involved.

Regions come from a detector, or from a file:

  --regions   boxes already found — tools/formula-regions.mjs reads them off a
              text layer through the demo's PDF.js adapter, which decodes every
              glyph the matcher sees; this is the oracle's own detector
  math-font   the text layer's character fonts (ocr/import_pdf_formulas.py):
              exact boxes, needs a text layer; pdfplumber leaves some glyphs
              of Computer Modern fonts unmapped, so prefer --regions
  ink         ink bands on the rendered page (ocr/extract_formula_dataset.py):
              coarse display blocks and mixed lines, works on a scan

Output is JSON lines, one region per line, in PDF points with the origin at
the top-left of the page, which is the coordinate space the demo adapter
reports text lines in:

  {"page": 4, "bbox": [x0, top, x1, bottom], "latex": "...", "meanLogProbability": -0.1,
   "endedWithEos": true}                                  (model)
  {"page": 4, "bbox": [...], "text": "f ( x ) = x 2 + 1"} (--oracle)

Usage, from the repository root:

  python -m ocr.ocr_pages --pdf BOOK.pdf --pages 4-20 --oracle --output tmp/book-oracle.jsonl
  python -m ocr.ocr_pages --pdf BOOK.pdf --pages 4-20 --bundle tmp/formula-bundle --output tmp/book-ocr.jsonl
  python -m ocr.ocr_pages --pdf BOOK.pdf --regions tmp/book-regions.jsonl --bundle tmp/formula-bundle --output tmp/book-ocr.jsonl

Nothing here downloads a model or calls a service.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pdfplumber
from PIL import Image

from ocr.import_pdf_formulas import candidate_regions

PDFTOPPM = os.environ.get("PDFTOPPM") or shutil.which("pdftoppm") or "pdftoppm"


def parse_pages(spec: str | None, count: int) -> list[int]:
    if not spec:
        return list(range(1, count + 1))
    pages: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            pages.extend(range(int(a), min(int(b), count) + 1))
        elif part:
            pages.append(int(part))
    return [p for p in pages if 1 <= p <= count]


def render_page(pdf: Path, page: int, dpi: int, work: Path) -> Image.Image:
    prefix = work / f"p{page:05d}"
    subprocess.run([PDFTOPPM, "-png", "-r", str(dpi), "-f", str(page), "-l", str(page), str(pdf), str(prefix)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    produced = sorted(work.glob(f"p{page:05d}*.png"))
    if not produced:
        raise RuntimeError(f"pdftoppm produced nothing for page {page}")
    with Image.open(produced[-1]) as image:
        return image.convert("L").copy()


def ink_regions(image: Image.Image, dpi: int) -> list[dict]:
    """Rendered-page detector, in PDF points."""
    from ocr.extract_formula_dataset import line_bands
    scale = 72.0 / dpi
    out = []
    for band in line_bands(image):
        out.append({"bbox": [round(band["x0"] * scale, 3), round(band["y0"] * scale, 3),
                             round(band["x1"] * scale, 3), round(band["y1"] * scale, 3)],
                    "kind": band["kind"], "score": band["score"]})
    return out


def oracle_text(page, bbox: list[float]) -> str:
    """The text layer's characters inside the box, in reading order, scripts inline."""
    x0, top, x1, bottom = bbox
    chars = [c for c in page.chars if c["x0"] >= x0 - 0.5 and c["x1"] <= x1 + 0.5
             and c["top"] >= top - 0.5 and c["bottom"] <= bottom + 0.5 and c.get("text", "").strip()]
    chars.sort(key=lambda c: c["x0"])
    pieces = []
    previous = None
    for c in chars:
        if previous is not None and c["x0"] - previous > 1.0:
            pieces.append(" ")
        pieces.append(c["text"])
        previous = max(previous or 0, c["x1"])
    return "".join(pieces).strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--pages", help="e.g. 4-20,25; default all")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, help="exported model bundle; omit with --oracle")
    parser.add_argument("--oracle", action="store_true", help="emit the text layer's own text per region")
    parser.add_argument("--detector", choices=["math-font", "ink"], default="math-font")
    parser.add_argument("--regions", type=Path, help="JSON lines of {page, bbox} to crop instead of detecting")
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--crops", type=Path, help="also save each crop as PNG under this directory")
    parser.add_argument("--min-chars", type=int, default=2, help="math-font regions with fewer glyphs are skipped")
    args = parser.parse_args()
    if not args.oracle and not args.bundle:
        parser.error("either --oracle or --bundle is required")
    if args.output.exists():
        parser.error(f"output exists: {args.output}")

    given: dict[int, list[dict]] = {}
    if args.regions:
        with args.regions.open(encoding="utf-8") as stream:
            for line in stream:
                if line.strip():
                    row = json.loads(line)
                    given.setdefault(int(row["page"]), []).append({"bbox": row["bbox"], "math_glyph_count": 99})

    recognizer = None
    if args.bundle:
        from ocr.recognize_scratch import ScratchOnnxRecognizer, preprocess_image
        recognizer = ScratchOnnxRecognizer(args.bundle, threads=args.threads)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.crops:
        args.crops.mkdir(parents=True, exist_ok=True)
    stats = {"pages": 0, "regions": 0, "recognised": 0, "blank": 0, "unfinished": 0}
    with tempfile.TemporaryDirectory(prefix="ocr-pages-") as tmp, pdfplumber.open(args.pdf) as pdf, \
            args.output.open("x", encoding="utf-8") as sink:
        work = Path(tmp)
        for number in parse_pages(args.pages, len(pdf.pages)):
            page = pdf.pages[number - 1]
            stats["pages"] += 1
            image = None
            if args.detector == "ink" or recognizer is not None:
                image = render_page(args.pdf, number, args.dpi, work)
            if args.regions:
                regions = given.get(number, [])
            elif args.detector == "math-font":
                regions = [r for r in candidate_regions(page) if r["math_glyph_count"] >= args.min_chars]
            else:
                regions = ink_regions(image, args.dpi)
            for index, region in enumerate(regions, 1):
                bbox = [float(v) for v in region["bbox"]]
                row = {"page": number, "bbox": [round(v, 3) for v in bbox]}
                if args.oracle:
                    text = oracle_text(page, bbox)
                    if not text:
                        continue
                    row["text"] = text
                else:
                    scale = args.dpi / 72.0
                    crop = image.crop((int(bbox[0] * scale), int(bbox[1] * scale),
                                       int(bbox[2] * scale) + 1, int(bbox[3] * scale) + 1))
                    if args.crops:
                        crop.save(args.crops / f"p{number:04d}-{index:03d}.png")
                    try:
                        tensor = preprocess_image(crop, recognizer.height, recognizer.width)
                    except ValueError:
                        stats["blank"] += 1
                        continue
                    result = recognizer.recognize_tensor(tensor)
                    row.update({"latex": result["latex"], "meanLogProbability": result["meanLogProbability"],
                                "endedWithEos": result["endedWithEos"]})
                    if not result["endedWithEos"]:
                        stats["unfinished"] += 1
                    stats["recognised"] += 1
                stats["regions"] += 1
                sink.write(json.dumps(row, ensure_ascii=False) + "\n")
            page.close()
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
