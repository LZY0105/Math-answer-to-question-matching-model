"""The visible windows of a page built by clipping an embedded page.

The 2024 留白作答版 (blank-for-answers) books in the exam corpus are made with
PyMuPDF: each output page embeds the original typeset page as a form XObject
(fzFrm0) and clips it to one question's rectangle, leaving the rest of the page
blank for the student to write in. Text extraction ignores clipping, so the
text layer of every such page carries the WHOLE original page's text —
invisible, under the blank space. A tool that reads the text layer as what is
printed reads questions that are not on the page.

This reads each page's own content stream, which is tiny and regular for these
books, and reports the clip rectangles a form is drawn through, in page points
with the origin at the top-left (the space the demo adapter reports lines in):

    {"pages": {"1": [[56.69, 209.63, 500.69, 241.88]], ...}, "clipped_pages": N, "pages_total": M}

A page with no clipped form reports no windows; everything on it is visible.

Two clips decide what a form shows: the window's, and the form's own /BBox.
A question that runs over two pages of the original is shown through one
window as two forms, each cut by its /BBox to its part of the window; inside
the window, each form's text outside its own part is hidden under the other's.
And each form carries the whole original page, so on a page with two or three
windows, text of one form lies inside another's window. A rectangle test on
the window alone is therefore leaky. --split writes the exact alternative:
every clipped page becomes one copy per form, drawing only that form, plus one
copy drawing no form at all (the page's own running head and page number);
every other page is copied as it is. A text item from a form's copy is printed
if and only if it lies inside that form's visible part, which the map gives
(null for the native copy and for unclipped pages).

    {"copies": [{"page": 1, "window": null, "native": true},
                {"page": 1, "window": [56.69, 209.63, 500.69, 241.88], "form": "fzFrm0"}, ...]}

Usage: python -m ocr.clip_windows --pdf BOOK.pdf --output windows.json
       python -m ocr.clip_windows --pdf BOOK.pdf --output windows.json --split split.pdf --map split-map.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from pypdf import PdfReader

# q / 1 0 0 1 X Y cm / 0 0 W H re / W / n ... /fzFrmN Do  (the PyMuPDF show_pdf_page layout)
_WINDOW = re.compile(
    r"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm\s+"
    r"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+re\s+W\s+n"
    r"(?:(?!\bcm\b).)*?/(\S+)\s+Do",
    re.S,
)
_DO = re.compile(r"/(\S+)\s+Do\b")
_CM = re.compile(r"\bcm\b")
_IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _contents(page) -> str:
    # A content stream is a dictionary object to pypdf, and an empty one is
    # falsy; test for None, not for truth.
    contents = page.get_contents()
    return contents.get_data().decode("latin-1") if contents is not None else ""


def _box_through(matrix, box):
    """The axis-aligned box a matrix carries `box` (x0, y0, x1, y1) to."""
    a, b, c, d, e, f = matrix
    points = [(a * x + c * y + e, b * x + d * y + f) for x in (box[0], box[2]) for y in (box[1], box[3])]
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def _intersect(p, q):
    x0, y0, x1, y1 = max(p[0], q[0]), max(p[1], q[1]), min(p[2], q[2]), min(p[3], q[3])
    return (x0, y0, x1, y1) if x1 > x0 and y1 > y0 else None


def _top_left(box, height):
    x0, y0, x1, y1 = box
    return [round(x0, 2), round(height - y1, 2), round(x1, 2), round(height - y0, 2)]


def _form_box(page, name):
    """A form's /BBox and /Matrix, or None where the page cannot say."""
    try:
        resources = page.get("/Resources")
        form = resources.get_object()["/XObject"]["/" + name].get_object()
        bbox = tuple(float(v) for v in form["/BBox"])
        matrix = form.get("/Matrix")
        return bbox, tuple(float(v) for v in matrix) if matrix is not None else _IDENTITY
    except (AttributeError, KeyError, TypeError, ValueError):
        return None


def page_layout(page) -> list[dict] | None:
    """Each window of a clipped page, with the part of it each of its forms paints.

    [{"rect": [x0, top, x1, bottom],
      "parts": [{"form": "fzFrm0", "span": (start, end), "rect": [...] or None}]}]

    `span` is where the form's `Do` sits in the content stream; a part's `rect`
    is the window cut by the form's /BBox, None if nothing of the form shows.
    Every form drawn after a window's clip and before the next window's belongs
    to that window. Returns [] for a page with no clipped form, and None for one
    that clips in a way this does not read (a rotated window, or a transform
    between the clip and a form), which a caller should leave whole.
    """
    data = _contents(page)
    height = float(page.mediabox.height)
    matches = list(_WINDOW.finditer(data))
    out = []
    for i, m in enumerate(matches):
        cm = tuple(float(m.group(k)) for k in range(1, 7))
        if abs(cm[1]) > 1e-6 or abs(cm[2]) > 1e-6:
            return None  # rotated or sheared: not the layout this reads
        rx, ry, rw, rh = (float(m.group(k)) for k in range(7, 11))
        window = _box_through(cm, (rx, ry, rx + rw, ry + rh))
        end = matches[i + 1].start() if i + 1 < len(matches) else len(data)
        parts = []
        for do in _DO.finditer(data, m.start(7), end):
            if _CM.search(data, m.start(7), do.start()):
                return None
            visible = window
            form = _form_box(page, do.group(1))
            if form is not None:
                bbox, matrix = form
                visible = _intersect(window, _box_through(cm, _box_through(matrix, bbox)))
            parts.append({"form": do.group(1), "span": do.span(),
                          "rect": _top_left(visible, height) if visible else None})
        out.append({"rect": _top_left(window, height), "parts": parts})
    return out


def page_windows(page) -> list[list[float]]:
    return [w["rect"] for w in page_layout(page) or []]


def window_forms(data: str) -> list[list[str]]:
    """The forms each clip window draws, in window order (see page_layout)."""
    matches = list(_WINDOW.finditer(data))
    return [[do.group(1) for do in _DO.finditer(data, m.start(7),
                                                matches[i + 1].start() if i + 1 < len(matches) else len(data))]
            for i, m in enumerate(matches)]


def without_forms(data: str, spans, keep=None) -> str:
    """The content stream with every form `Do` in `spans` removed but `keep`."""
    out, at = [], 0
    for span in sorted(spans):
        if span == keep:
            continue
        out.append(data[at:span[0]])
        at = span[1]
    out.append(data[at:])
    return "".join(out)


def split_document(reader: PdfReader, split_path: Path, map_path: Path) -> dict:
    """One copy per form of every clipped page; see the module docstring."""
    from pypdf import PdfWriter
    from pypdf.generic import NameObject, StreamObject

    writer = PdfWriter()
    copies = []
    hidden_forms = 0

    def add_copy(page, data: str, entry: dict) -> None:
        width, height = float(page.mediabox.width), float(page.mediabox.height)
        blank = writer.add_blank_page(width=width, height=height)
        resources = page.get("/Resources")
        if resources is not None:
            blank[NameObject("/Resources")] = resources.get_object().clone(writer)
        stream = StreamObject()
        stream.set_data(data.encode("latin-1"))
        blank[NameObject("/Contents")] = writer._add_object(stream)
        copies.append(entry)

    for number, page in enumerate(reader.pages, 1):
        data = _contents(page)
        layout = page_layout(page)
        if not layout:
            add_copy(page, data, {"page": number, "window": None})
            continue
        spans = [part["span"] for window in layout for part in window["parts"]]
        # The native copy: every clipped form removed, the page's own drawing kept.
        add_copy(page, without_forms(data, spans), {"page": number, "window": None, "native": True})
        for window in layout:
            for part in window["parts"]:
                if part["rect"] is None:
                    hidden_forms += 1
                    continue
                add_copy(page, without_forms(data, spans, keep=part["span"]),
                         {"page": number, "window": part["rect"], "form": part["form"]})

    with split_path.open("wb") as sink:
        writer.write(sink)
    map_path.write_text(json.dumps({"source_pages": len(reader.pages), "copies": copies}, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    return {"copies": len(copies), "hidden_forms": hidden_forms}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--split", type=Path, help="write the one-form-per-copy PDF here")
    parser.add_argument("--map", type=Path, help="write the copy map here (with --split)")
    args = parser.parse_args()
    if bool(args.split) != bool(args.map):
        parser.error("--split and --map go together")
    reader = PdfReader(str(args.pdf))
    pages = {}
    unread = 0
    for number, page in enumerate(reader.pages, 1):
        layout = page_layout(page)
        if layout is None:
            unread += 1
        elif layout:
            pages[str(number)] = [w["rect"] for w in layout]
    result = {"pages": pages, "clipped_pages": len(pages), "pages_total": len(reader.pages)}
    args.output.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
    counts = [len(w) for w in pages.values()]
    summary = {"pages_total": len(reader.pages), "clipped_pages": len(pages), "unread_pages": unread,
               "windows": sum(counts), "max_windows_per_page": max(counts) if counts else 0}
    if args.split:
        summary.update(split_document(reader, args.split, args.map))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
