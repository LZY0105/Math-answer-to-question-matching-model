"""Import visually verified formula crops from local PDFs, without OCR models.

Coordinates are PDF points from the top-left of the rendered MediaBox, with
page rotation applied. Page numbers are one-based. Candidate discovery is only
a review queue: its regions can contain text or incomplete formulas and have
no LaTeX labels. It never creates training samples.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from PIL import Image, ImageChops
import pdfplumber


SPLITS = ("train", "validation", "test")
LABEL_PROVENANCE = "assistant visual transcription verified against rendered source"
_TEX_TOKEN = re.compile(r"\\(?:begin|end)\{[a-zA-Z*]+\}|\\[A-Za-z]+|\\.|.", re.DOTALL)
_MATH_FONT = re.compile(r"(?:^|[+_-])(?:CM(?:MI|SY|EX|R|B|TI)|LM(?:MATH|MATHITALIC|ROMAN)|MT2(?:MI|SY|EX)|MS[AB]M|MATH|STIX)|(?:CambriaMath|LatinModernMath)", re.I)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_label(latex: str) -> tuple[str, ...]:
    return tuple(token for token in _TEX_TOKEN.findall(latex) if not token.isspace())


def _json_hash(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def read_sources(path: Path) -> dict[str, Path]:
    values = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(values, dict) or not values:
        raise ValueError("Sources must be a nonempty JSON object mapping keys to absolute PDF paths")
    result = {}
    for key, value in values.items():
        if not isinstance(key, str) or not key or not isinstance(value, str):
            raise ValueError("Source keys and paths must be nonempty strings")
        pdf = Path(value)
        if not pdf.is_absolute() or not pdf.is_file() or pdf.suffix.lower() != ".pdf":
            raise ValueError(f"Source {key!r} must name an existing absolute PDF path")
        result[key] = pdf.resolve()
    return result


def read_annotations(path: Path) -> list[dict]:
    rows = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"Annotation line {line_number}: invalid JSON: {error}") from error
        if not isinstance(row, dict):
            raise ValueError(f"Annotation line {line_number}: expected an object")
        rows.append({"annotation": row, "line": line_number})
    if not rows:
        raise ValueError("Annotations contain no records")
    return rows


def source_metadata(sources: dict[str, Path]) -> dict[str, dict]:
    result = {}
    for key, path in sources.items():
        with pdfplumber.open(path) as pdf:
            pages = []
            for page in pdf.pages:
                # Poppler renders /UserUnit physically, while PDF text coordinates
                # remain points; a dimension ratio maps both into the same view.
                pages.append({"width": float(page.width), "height": float(page.height)})
        result[key] = {"path": str(path), "sha256": sha256_file(path), "page_count": len(pages), "pages": pages}
    return result


def validate_annotations(records: list[dict], metadata: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    """Reject all sides of cross-split conflicts; never silently choose a side."""
    errors: dict[int, list[str]] = defaultdict(list)
    id_groups: dict[str, list[int]] = defaultdict(list)
    page_groups: dict[tuple, list[int]] = defaultdict(list)
    label_groups: dict[tuple, list[int]] = defaultdict(list)
    eligible = []
    for index, wrapped in enumerate(records):
        row = wrapped["annotation"]
        identifier = row.get("id")
        if not isinstance(identifier, str) or not identifier.strip():
            errors[index].append("missing_or_invalid_id")
        else:
            id_groups[identifier].append(index)
        if row.get("review_status") != "visual-verified":
            errors[index].append("label_not_visual_verified")
        latex = row.get("latex")
        if not isinstance(latex, str) or not canonical_label(latex):
            errors[index].append("empty_or_invalid_latex")
        split = row.get("split")
        if split not in SPLITS:
            errors[index].append("invalid_split")
        source = row.get("source")
        if not isinstance(source, str) or source not in metadata:
            errors[index].append("unknown_source")
        else:
            page_number = row.get("page")
            if type(page_number) is not int or not 1 <= page_number <= metadata[source]["page_count"]:
                errors[index].append("invalid_page")
            else:
                page = metadata[source]["pages"][page_number - 1]
                bbox = row.get("bbox")
                if not isinstance(bbox, list) or len(bbox) != 4 or any(type(x) not in (int, float) or not math.isfinite(x) for x in bbox):
                    errors[index].append("invalid_bbox")
                elif not (0 <= bbox[0] < bbox[2] <= page["width"] and 0 <= bbox[1] < bbox[3] <= page["height"]):
                    errors[index].append("bbox_outside_page")
        if not errors[index]:
            eligible.append(index)
            page_groups[(metadata[source]["sha256"], row["page"])].append(index)
            label_groups[canonical_label(latex)].append(index)
    for indexes in id_groups.values():
        if len(indexes) > 1:
            for index in indexes:
                errors[index].append("duplicate_id")
    for groups, reason in ((page_groups, "page_shared_across_splits"), (label_groups, "canonical_latex_shared_across_splits")):
        for indexes in groups.values():
            if len({records[index]["annotation"]["split"] for index in indexes}) > 1:
                for index in indexes:
                    errors[index].append(reason)
    accepted = [records[index] for index in eligible if not errors[index]]
    rejected = [{**records[index], "reasons": reasons} for index, reasons in sorted(errors.items()) if reasons]
    return accepted, rejected


def render_page(pdf: Path, page: int, prefix: Path, renderer: str, dpi: int) -> Path:
    subprocess.run([renderer, "-f", str(page), "-l", str(page), "-r", str(dpi), "-singlefile", "-png", str(pdf), str(prefix)], check=True, capture_output=True)
    result = prefix.with_suffix(".png")
    if not result.is_file():
        raise RuntimeError(f"Poppler did not produce page {page}")
    return result


def crop_region(page_image: Image.Image, bbox: list[float], dimensions: dict) -> Image.Image:
    sx, sy = page_image.width / dimensions["width"], page_image.height / dimensions["height"]
    region = (max(0, math.floor(bbox[0] * sx)), max(0, math.floor(bbox[1] * sy)), min(page_image.width, math.ceil(bbox[2] * sx)), min(page_image.height, math.ceil(bbox[3] * sy)))
    image = page_image.crop(region).convert("RGB")
    ink = ImageChops.difference(image.convert("L"), Image.new("L", image.size, 255)).point(lambda value: 255 if value > 10 else 0)
    if ink.getbbox() is None:
        raise ValueError("crop_is_blank")
    return image


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def import_annotations(sources: dict[str, Path], annotation_path: Path, output: Path, *, renderer: str = "pdftoppm", dpi: int = 300) -> dict:
    """Create a new dataset directory exclusively; an existing dataset is an error."""
    output = output.resolve()
    if dpi != 300:
        raise ValueError("Verified PDF imports use exactly 300 dpi")
    if output.exists():
        raise FileExistsError(f"Output already exists; choose a new dataset directory: {output}")
    metadata = source_metadata(sources)
    records = read_annotations(annotation_path)
    accepted, rejected = validate_annotations(records, metadata)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Render and validate before publishing. Copying to a normally created
    # directory preserves inherited Windows permissions instead of carrying a
    # TemporaryDirectory's restrictive ACL into the published dataset.
    # import-report.json is the completion marker and is published last.
    with tempfile.TemporaryDirectory(prefix="pdf-formula-import-", dir=output.parent) as temporary:
        work = Path(temporary)
        dataset = work / "dataset"
        (dataset / "images").mkdir(parents=True)
        rendered = work / "pages"
        rendered.mkdir()
        by_page = defaultdict(list)
        for wrapped in accepted:
            row = wrapped["annotation"]
            by_page[(row["source"], row["page"])].append(wrapped)
        imported = []
        for (source, page_number), group in by_page.items():
            image_path = render_page(sources[source], page_number, rendered / _json_hash([source, page_number]), renderer, dpi)
            with Image.open(image_path) as page_image:
                for wrapped in group:
                    row = wrapped["annotation"]
                    try:
                        crop = crop_region(page_image, row["bbox"], metadata[source]["pages"][page_number - 1])
                    except ValueError as error:
                        rejected.append({**wrapped, "reasons": [str(error)]})
                        continue
                    filename = f"{_json_hash(row['id'])[:24]}.png"
                    destination = dataset / "images" / filename
                    crop.save(destination, format="PNG")
                    pixel_hash = hashlib.sha256(str(crop.size).encode("ascii") + b"\0" + crop.tobytes()).hexdigest()
                    imported.append({"id": row["id"], "image": f"images/{filename}", "latex": row["latex"], "split": row["split"], "category": row.get("category", "pdf-formula"), "source": source, "source_pdf_sha256": metadata[source]["sha256"], "page": page_number, "bbox": row["bbox"], "annotation_sha256": _json_hash(row), "label_provenance": LABEL_PROVENANCE, "review_status": "visual-verified", "dpi": dpi, "image_sha256": sha256_file(destination), "image_pixel_sha256": pixel_hash, "_wrapped": wrapped})
            image_path.unlink()
        images = defaultdict(list)
        for row in imported:
            images[row["image_pixel_sha256"]].append(row)
        kept, duplicate_count = [], 0
        for rows in images.values():
            if len({row["split"] for row in rows}) > 1:
                for row in rows:
                    rejected.append({**row["_wrapped"], "reasons": ["image_shared_across_splits"]})
            elif len({canonical_label(row["latex"]) for row in rows}) > 1:
                for row in rows:
                    rejected.append({**row["_wrapped"], "reasons": ["same_image_conflicting_labels"]})
            else:
                kept.append(rows[0])
                duplicate_count += len(rows) - 1
            for row in rows:
                if row not in kept:
                    (dataset / row["image"]).unlink()
        for source, path in sources.items():
            if sha256_file(path) != metadata[source]["sha256"]:
                raise RuntimeError(f"Source changed during import: {source}")
        for row in kept:
            row.pop("_wrapped")
        kept.sort(key=lambda row: row["id"])
        for split in SPLITS:
            _write_jsonl(dataset / f"{split}.jsonl", [row for row in kept if row["split"] == split])
        _write_jsonl(dataset / "rejected.jsonl", rejected)
        report = {"format_version": 1, "created_at": datetime.now(timezone.utc).isoformat(), "annotation_file_sha256": sha256_file(annotation_path), "sources": {key: {field: value for field, value in meta.items() if field != "pages"} for key, meta in metadata.items()}, "input_annotations": len(records), "accepted": len(kept), "deduplicated": duplicate_count, "rejected": len(rejected), "rejection_reasons": dict(Counter(reason for row in rejected for reason in row["reasons"])), "splits": {split: {"samples": sum(row["split"] == split for row in kept), "manifest_sha256": sha256_file(dataset / f"{split}.jsonl")} for split in SPLITS}, "label_provenance": LABEL_PROVENANCE, "geometry": "one-based page; rotated MediaBox top-left PDF points", "limitations": ["visual-verified is an explicit annotation assertion; this importer cannot verify transcription correctness", "formula crops only; source PDFs remain read-only; no automatic OCR labels", "cross-dataset split checks are additionally required before mixing this dataset with another dataset"]}
        (dataset / "import-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        output.mkdir()
        shutil.copytree(dataset / "images", output / "images", copy_function=shutil.copyfile)
        for name in (*[f"{split}.jsonl" for split in SPLITS], "rejected.jsonl"):
            shutil.copyfile(dataset / name, output / name)
        shutil.copyfile(dataset / "import-report.json", output / "import-report.json")
    return report


def candidate_regions(page) -> list[dict]:
    """Conservative math-font grouping; all proposed boxes require visual review."""
    origin_x, origin_y = page.bbox[:2]
    chars = [char for char in page.chars if _MATH_FONT.search(char.get("fontname", "")) and char.get("text", "").strip()]
    lines: list[list[dict]] = []
    for char in sorted(chars, key=lambda char: (char["top"], char["x0"])):
        center = (char["top"] + char["bottom"]) / 2
        for line in reversed(lines[-5:]):
            top = min(item["top"] for item in line)
            bottom = max(item["bottom"] for item in line)
            if top - 4 <= center <= bottom + 4:
                line.append(char)
                break
        else:
            lines.append([char])
    regions = []
    for line in lines:
        line.sort(key=lambda char: char["x0"])
        groups = [[]]
        previous_right = None
        for char in line:
            if previous_right is not None and char["x0"] - previous_right > 30:
                groups.append([])
            groups[-1].append(char)
            previous_right = char["x1"] if previous_right is None else max(previous_right, char["x1"])
        for group in groups:
            if len(group) < 2:
                continue
            bbox = [max(0.0, min(c["x0"] for c in group) - origin_x - 4), max(0.0, min(c["top"] for c in group) - origin_y - 5), min(float(page.width), max(c["x1"] for c in group) - origin_x + 4), min(float(page.height), max(c["bottom"] for c in group) - origin_y + 5)]
            if bbox[0] < bbox[2] and bbox[1] < bbox[3]:
                regions.append({"bbox": [round(value, 3) for value in bbox], "math_glyph_count": len(group), "font_names": sorted({char.get("fontname", "") for char in group})})
    return regions


def scan_candidates(sources: dict[str, Path], output: Path, *, max_pages: int | None = None) -> dict:
    if output.exists():
        raise FileExistsError(f"Candidate output already exists: {output}")
    if max_pages is not None and max_pages < 1:
        raise ValueError("max-pages must be positive")
    output.parent.mkdir(parents=True, exist_ok=True)
    stats = {}
    with output.open("x", encoding="utf-8", newline="\n") as stream:
        for source, path in sources.items():
            source_hash = sha256_file(path)
            counts = Counter()
            with pdfplumber.open(path) as pdf:
                for page_index, page in enumerate(pdf.pages, 1):
                    if max_pages is not None and page_index > max_pages:
                        break
                    counts["pages_scanned"] += 1
                    for region_index, region in enumerate(candidate_regions(page), 1):
                        row = {"id": f"{source}-p{page_index:04d}-candidate-{region_index:04d}", "source": source, "source_pdf_sha256": source_hash, "page": page_index, **region, "review_status": "pending", "train_eligible": False, "warning": "Heuristic math-font region may omit fractions, limits, matrix rows, or include surrounding prose. Inspect the full rendered page and correct the box before transcribing LaTeX."}
                        stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                        counts["pending_candidates"] += 1
                    page.close()
            if sha256_file(path) != source_hash:
                raise RuntimeError(f"Source changed during scan: {source}")
            stats[source] = dict(counts)
    return {"candidate_file": str(output), "sources": stats, "accepted_training_samples": 0, "status": "pending_visual_review_only"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--annotations", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--candidates", type=Path, help="Independently write a pending-only candidate JSONL; no OCR labels")
    parser.add_argument("--max-pages", type=int, help="Optional per-source limit for candidate scanning")
    parser.add_argument("--pdftoppm", default=shutil.which("pdftoppm") or "pdftoppm")
    args = parser.parse_args()
    if not args.annotations and not args.candidates:
        parser.error("Provide --annotations for verified imports or --candidates for discovery")
    if bool(args.annotations) != bool(args.output_dir):
        parser.error("--annotations and --output-dir must be supplied together")
    sources = read_sources(args.sources)
    if args.annotations:
        print(json.dumps(import_annotations(sources, args.annotations, args.output_dir, renderer=args.pdftoppm), ensure_ascii=False, indent=2))
    if args.candidates:
        print(json.dumps(scan_candidates(sources, args.candidates, max_pages=args.max_pages), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
