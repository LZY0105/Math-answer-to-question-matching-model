"""What the formula model reads at the start of each line of a scanned page.

A scanned exercise set prints its question numbers at the left margin — "1.",
"2.", ... — and those numbers are the ids a match within the set needs. This
finds the text lines of each page, crops the first ink cluster of each line
(at most a two-digit number and its period), and asks the formula model what
it says. One JSON line per line start:

    {"page": 23, "x0": 137.3, "top": 180.0, "bottom": 189.6, "width": 5.8, "latex": "1.", "eos": true}

Positions are PDF points from the top-left. The line finder is deliberately
simple and was written for the 2026-09 textbook scans (book-026, the 绿皮书):
ink is pixels darker than 128 at 150 dpi; the binding shadow is kept out by
ignoring the inner margin, on the left of an odd (right-hand) page and on the
right of an even one; a scan speck narrower than 3 px does not start a line.
ocr/ocr_pages.py --detector ink, written for clean renders, finds no lines on
these pages: their shadow inks 72–89% of pixel rows.

Usage: python -m ocr.scan_line_starts --pdf BOOK.pdf --pages 23-25,27 --bundle BUNDLE --output starts.jsonl
"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

DPI = 150


def parse_pages(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        a, _, b = part.strip().partition("-")
        out += list(range(int(a), int(b or a) + 1))
    return out


def text_block(width: int, page: int) -> tuple[int, int]:
    """Columns clear of the binding shadow, by which side of the spread the page is on."""
    return (int(width * 0.12), int(width * 0.95)) if page % 2 else (int(width * 0.05), int(width * 0.82))


def line_starts(gray: np.ndarray, page: int) -> list[tuple[int, int, int, int]]:
    """(x0, y0, x1, y1) in pixels: the first ink cluster of each text line."""
    h, w = gray.shape
    ink = gray < 128
    left, right = text_block(w, page)
    block = ink[:, left:right]
    active = block.mean(axis=1) > 0.004
    bands, start = [], None
    for y, on in enumerate(active):
        if on and start is None:
            start = y
        elif not on and start is not None:
            if y - start >= 8:
                bands.append((start, y))
            start = None
    out = []
    for y0, y1 in bands:
        if y1 < h * 0.05 or y0 > h * 0.93:
            continue
        cols = block[y0:y1].sum(axis=0) >= 2
        xs = np.where(cols)[0]
        x0 = None
        k = 0
        while k < len(xs):
            end = k
            while end + 1 < len(xs) and xs[end + 1] - xs[end] <= 2:
                end += 1
            if xs[end] - xs[k] + 1 >= 3:
                x0 = int(xs[k])
                break
            k = end + 1
        if x0 is None:
            continue
        gap_limit = max(3, int(0.3 * (y1 - y0)))
        x, last = x0, x0
        while x < len(cols) and x - last <= gap_limit:
            if cols[x]:
                last = x
            x += 1
        x1 = min(last + 1, x0 + int(1.4 * (y1 - y0)))
        out.append((left + x0, y0, left + x1, y1))
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--pages", required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    if args.output.exists():
        parser.error(f"output exists: {args.output}")

    from ocr.recognize_scratch import ScratchOnnxRecognizer, preprocess_image
    recognizer = ScratchOnnxRecognizer(args.bundle, threads=args.threads)
    pt = 72.0 / DPI
    rows = []
    with tempfile.TemporaryDirectory(prefix="scan-starts-") as tmp:
        for number in parse_pages(args.pages):
            prefix = Path(tmp) / f"p{number}"
            subprocess.run(["pdftoppm", "-f", str(number), "-l", str(number), "-r", str(DPI), "-gray", "-png",
                            str(args.pdf), str(prefix)], check=True, stderr=subprocess.DEVNULL)
            image = Image.open(next(Path(tmp).glob(f"p{number}-*.png"))).convert("L")
            for x0, y0, x1, y1 in line_starts(np.asarray(image), number):
                crop = image.crop((x0 - 3, y0 - 3, x1 + 3, y1 + 3))
                try:
                    tensor = preprocess_image(crop, recognizer.height, recognizer.width)
                except ValueError:
                    continue
                result = recognizer.recognize_tensor(tensor)
                rows.append({"page": number, "x0": round(x0 * pt, 1), "top": round(y0 * pt, 1),
                             "bottom": round(y1 * pt, 1), "width": round((x1 - x0) * pt, 1),
                             "latex": result["latex"], "eos": result["endedWithEos"]})
    with args.output.open("x", encoding="utf-8") as sink:
        for row in rows:
            sink.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps({"pages": len(parse_pages(args.pages)), "line_starts": len(rows)}))


if __name__ == "__main__":
    main()
