"""Contact sheets for checking set-and-number answers against the page.

A set-and-number id finds the answer with the same id by construction, so
whether an automatic answer is right is a question for the page image, not
for the lookup. tools/measure-sets.mjs writes every tap; this sets each one
beside what the page prints there.

  python -m ocr.set_crops --pdf BOOK.pdf --taps TAPS.json --out DIR \
      [--run "bound calibrated"] [--dpi 110]

Writes, under DIR:

  numbers-N.png  each automatic answer's id beside its tap point: the printed
                 number there must be the id's last part;
  sets-N.png     the page above each set's first exercise read: its 习题
                 heading must be the id's set;
  last-N.png     each set's last exercise with its band's end in red: the band
                 must stay inside the exercise;
  cross-N.png    the next-page part of each exercise that runs over a page
                 break, between red lines: only that exercise's continuation.

Pages are rendered with pdftoppm, which must be on the PATH.
"""

import argparse
import json
import os
import subprocess
import sys
from collections import OrderedDict

from PIL import Image, ImageDraw, ImageFont


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--taps", required=True, help="tools/measure-sets.mjs --json output")
    parser.add_argument("--out", required=True)
    parser.add_argument("--run", default="bound calibrated")
    parser.add_argument("--dpi", type=int, default=110)
    args = parser.parse_args(argv)

    taps = json.load(open(args.taps, encoding="utf-8"))[args.run]["taps"]
    os.makedirs(os.path.join(args.out, "pages"), exist_ok=True)
    scale = args.dpi / 72.0
    cache = {}

    def page(n):
        if n not in cache:
            path = os.path.join(args.out, "pages", f"p-{n:04d}.png")
            if not os.path.exists(path):
                base = os.path.join(args.out, "pages", f"r-{n:04d}")
                subprocess.run(["pdftoppm", "-f", str(n), "-l", str(n), "-r", str(args.dpi), "-gray", "-png",
                                "-singlefile", args.pdf, base], check=True, stderr=subprocess.DEVNULL)
                os.replace(base + ".png", path)
            cache[n] = Image.open(path).convert("RGB")
        return cache[n]

    def crop(n, left, top, right, bottom, marks=()):
        image = page(n)
        box = (max(0, int(left * scale)), max(0, int(top * scale)),
               min(image.width, int(right * scale)), min(image.height, int(bottom * scale)))
        cut = image.crop(box)
        draw = ImageDraw.Draw(cut)
        for y in marks:
            yy = int(y * scale) - box[1]
            draw.line([(0, yy), (cut.width, yy)], fill=(220, 0, 0), width=2)
        return cut

    font = ImageFont.load_default()
    for candidate in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",):
        if os.path.exists(candidate):
            font = ImageFont.truetype(candidate, 16)

    def sheets(name, cells, cols, per):
        for k in range(0, len(cells), per):
            chunk = cells[k:k + per]
            width = max(c.width for _, c in chunk) + 130
            rows = (len(chunk) + cols - 1) // cols
            heights = [max(c.height for _, c in chunk[r * cols:(r + 1) * cols]) + 6 for r in range(rows)]
            sheet = Image.new("RGB", (width * cols, sum(heights)), (255, 255, 255))
            draw = ImageDraw.Draw(sheet)
            y = 0
            for r in range(rows):
                for j, (label, cut) in enumerate(chunk[r * cols:(r + 1) * cols]):
                    x = j * width
                    draw.text((x + 4, y + 4), label, fill=(0, 0, 0), font=font)
                    sheet.paste(cut, (x + 125, y + 2))
                y += heights[r]
                draw.line([(0, y - 1), (width * cols, y - 1)], fill=(150, 150, 150))
            path = os.path.join(args.out, f"{name}-{k // per + 1}.png")
            sheet.save(path)
            print(path, len(chunk))

    def x0(tap):
        return tap["left"] if tap.get("left") is not None else 60.0

    automatic = [t for t in taps if t["rung"] == "AUTO_MATCH"]
    sheets("numbers", [(t["label"], crop(t["page"], x0(t) - 12, t["top"] - 3, x0(t) + 150, t["top"] + 14))
                       for t in automatic], 4, 120)

    firsts = OrderedDict()
    for t in taps:
        firsts.setdefault(t["label"].rsplit(".", 1)[0], t)
    sheets("sets", [(f"{s} ({t['label'].rsplit('.', 1)[1]})", crop(t["page"], x0(t) - 12, t["top"] - 46, x0(t) + 230, t["top"] + 14))
                    for s, t in firsts.items()], 3, 36)

    lasts = []
    for t in taps:
        if not t.get("lastOfSet") or not t.get("spans"):
            continue
        band = t["spans"][0]
        lasts.append((t["label"], crop(band["page"], 40, band["top"] - 4, 400,
                                       max(band["bottom"], band["top"] + 40) + 50, [band["bottom"]])))
    sheets("last", lasts, 3, 24)

    crossing = []
    for t in taps:
        spans = t.get("spans") or []
        if len(spans) < 2:
            continue
        band = spans[-1]
        crossing.append((t["label"], crop(band["page"], 30, band["top"] - 40, 420, band["bottom"] + 16,
                                          [band["top"], band["bottom"]])))
    sheets("cross", crossing, 3, 21)
    return 0


if __name__ == "__main__":
    sys.exit(main())
