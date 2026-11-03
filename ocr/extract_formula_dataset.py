from __future__ import annotations

import argparse
import contextlib
import csv
import io
import json
import os
import re
import sys
import gc
import shutil
import subprocess
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
import pypdf


# 从 PATH 上找 pdftoppm，--pdftoppm 可以覆盖。和 ocr/import_pdf_formulas.py 一样
# 的做法；写死家目录的后果见主干 b0b5d56。
#
# 走环境变量而不是模块全局，是因为渲染在 ProcessPoolExecutor 的工作进程里跑
# （process_source → render_pages）。Windows 用 spawn 起子进程，父进程里改过的
# 全局变量到不了子进程——那样 --pdftoppm 会只在父进程生效，而且不报错。环境变量
# 是子进程继承得到的。
POPPLER_PDFTOPPM = os.environ.get("PDFTOPPM") or shutil.which("pdftoppm") or "pdftoppm"


def safe_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "_", value)
    return value.strip("._") or "source"


def page_image(page):
    images = page.images
    if not images:
        return None
    best = max(images, key=lambda item: item.image.width * item.image.height)
    return best.image.convert("RGB")


def render_pages(pdf_path: Path, first_page: int, last_page: int, render_dir: Path):
    render_dir.mkdir(parents=True, exist_ok=True)
    prefix = render_dir / "render"
    command = [str(POPPLER_PDFTOPPM), "-png", "-r", "150", "-f", str(first_page), "-l", str(last_page), str(pdf_path), str(prefix)]
    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"pdftoppm failed with exit code {result.returncode}")
    output = {}
    for path in render_dir.glob("render-*.png"):
        match = re.search(r"-(\d+)\.png$", path.name)
        if match:
            page_no = int(match.group(1))
            with Image.open(path) as loaded:
                output[page_no] = loaded.convert("RGB").copy()
    return output


def line_bands(image: Image.Image):
    gray = np.asarray(ImageOps.grayscale(image), dtype=np.uint8)
    ink = gray < 210
    h, w = ink.shape
    row_score = ink.mean(axis=1)
    active = row_score > 0.0015
    for _ in range(3):
        active[1:-1] |= active[:-2] & active[2:]
    raw = []
    start = None
    for i, value in enumerate(active):
        if value and start is None:
            start = i
        elif not value and start is not None:
            if i - start >= 3:
                raw.append([start, i])
            start = None
    if start is not None:
        raw.append([start, len(active)])

    merged = []
    for y0, y1 in raw:
        if merged and y0 - merged[-1][1] <= 5:
            merged[-1][1] = y1
        else:
            merged.append([y0, y1])

    bands = []
    component_limit = max(5, int(h * 0.012))
    for y0, y1 in merged:
        if y1 < h * 0.035 or y0 > h * 0.94:
            continue
        sub = ink[y0:y1]
        columns = sub.any(axis=0)
        runs = []
        x0 = None
        for x, value in enumerate(columns):
            if value and x0 is None:
                x0 = x
            elif not value and x0 is not None:
                if x - x0 >= 2:
                    runs.append((x0, x))
                x0 = None
        if x0 is not None:
            runs.append((x0, len(columns)))
        if not runs:
            continue
        bx0, bx1 = runs[0][0], runs[-1][1]
        widths = [x1 - x0 for x0, x1 in runs]
        small_fraction = sum(x <= component_limit for x in widths) / max(1, len(widths))
        density = float(sub[:, bx0:bx1].mean())
        width_ratio = (bx1 - bx0) / w
        center = (bx0 + bx1) / (2 * w)
        centered = abs(center - 0.5) < 0.18
        display = centered and width_ratio < 0.78 and small_fraction >= 0.38 and density < 0.24
        mixed = small_fraction >= 0.50 and len(runs) >= 8 and width_ratio > 0.18
        block = (y1 - y0) / h >= 0.05 and small_fraction >= 0.25 and width_ratio < 0.86
        if display or mixed or block:
            if display:
                kind = "display_block"
            elif block:
                kind = "possible_formula_block"
            else:
                kind = "mixed_line"
            score = min(1.0, 0.55 * small_fraction + 0.25 * (1.0 - min(1.0, density / 0.35)) + 0.20 * (1.0 - min(1.0, width_ratio)))
            bands.append({
                "x0": int(bx0), "y0": int(y0), "x1": int(bx1), "y1": int(y1),
                "width": int(bx1 - bx0), "height": int(y1 - y0),
                "width_ratio": round(width_ratio, 6), "density": round(density, 6),
                "small_fraction": round(small_fraction, 6), "component_count": len(runs),
                "kind": kind, "score": round(score, 6),
            })
    return bands


def process_source(item):
    source_id, pdf_path, output_root, page_limit = item
    pdf_path = Path(pdf_path)
    output_root = Path(output_root)
    source_dir = output_root / "images" / source_id
    source_dir.mkdir(parents=True, exist_ok=True)
    records = []
    failures = []
    fallback_pages = 0
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            reader = pypdf.PdfReader(str(pdf_path), strict=False)
        page_total = len(reader.pages)
        if page_limit:
            page_total = min(page_total, page_limit)
        del reader
        gc.collect()
        # Reopen in bounded chunks so decoded JP2/JPEG page images are not
        # retained for the entire book by pypdf's object cache.
        chunk_size = 48
        for chunk_start in range(0, page_total, chunk_size):
            with contextlib.redirect_stderr(io.StringIO()):
                chunk_reader = pypdf.PdfReader(str(pdf_path), strict=False)
            chunk_pages = chunk_reader.pages[chunk_start:min(page_total, chunk_start + chunk_size)]
            chunk_end = min(page_total, chunk_start + chunk_size)
            fallback_mode = False
            rendered = {}
            render_dir = output_root / "_render_cache" / source_id / f"chunk_{chunk_start + 1:05d}"
            for offset, page in enumerate(chunk_pages):
                page_index = chunk_start + offset + 1
                try:
                    if fallback_mode:
                        image = rendered.get(page_index)
                    else:
                        try:
                            with contextlib.redirect_stderr(io.StringIO()):
                                image = page_image(page)
                        except Exception:
                            image = None
                            fallback_mode = True
                            rendered = render_pages(pdf_path, page_index, chunk_end, render_dir)
                            fallback_pages += len(rendered)
                            image = rendered.get(page_index)
                    if image is None and not fallback_mode:
                        fallback_mode = True
                        rendered = render_pages(pdf_path, page_index, chunk_end, render_dir)
                        fallback_pages += len(rendered)
                        image = rendered.get(page_index)
                    if image is None:
                        failures.append({"page": page_index, "error": "no_page_image"})
                        continue
                    bands = line_bands(image)
                    for candidate_index, band in enumerate(bands, start=1):
                        pad = max(8, int(image.height * 0.006))
                        left = max(0, band["x0"] - pad)
                        top = max(0, band["y0"] - pad)
                        right = min(image.width, band["x1"] + pad)
                        bottom = min(image.height, band["y1"] + pad)
                        crop = ImageOps.grayscale(image.crop((left, top, right, bottom)))
                        rel = Path("images") / source_id / f"p{page_index:04d}_c{candidate_index:03d}.png"
                        out_path = output_root / rel
                        crop.save(out_path, format="PNG", compress_level=1)
                        record = {
                            "id": f"{source_id}_p{page_index:04d}_c{candidate_index:03d}",
                            "source_id": source_id,
                            "source_file": pdf_path.name,
                            "source_path": str(pdf_path),
                            "page": page_index,
                            "page_size_px": [image.width, image.height],
                            "bbox_px": [left, top, right, bottom],
                            "crop_file": str(rel).replace("\\", "/"),
                            **band,
                        }
                        records.append(record)
                except Exception as exc:
                    failures.append({"page": page_index, "error": f"{type(exc).__name__}: {exc}"})
            del chunk_pages
            del chunk_reader
            if render_dir.exists():
                shutil.rmtree(render_dir, ignore_errors=True)
            gc.collect()
        return {
            "source_id": source_id,
            "source_file": pdf_path.name,
            "source_path": str(pdf_path),
            "page_total": page_total,
            "pages_with_candidates": len({r["page"] for r in records}),
            "candidate_count": len(records),
            "failure_count": len(failures),
            "fallback_page_count": fallback_pages,
            "failures": failures[:20],
            "records": records,
        }
    except Exception as exc:
        return {
            "source_id": source_id,
            "source_file": pdf_path.name,
            "source_path": str(pdf_path),
            "page_total": 0,
            "pages_with_candidates": 0,
            "candidate_count": 0,
            "failure_count": 1,
            "fallback_page_count": fallback_pages,
            "failures": [{"page": 0, "error": f"{type(exc).__name__}: {exc}"}],
            "records": [],
        }


def write_jsonl(path: Path, records):
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="源书目录（PDF）")
    parser.add_argument("--output", required=True, help="抽出来的公式落地目录")
    parser.add_argument(
        "--pdftoppm", default=POPPLER_PDFTOPPM,
        help="poppler 的 pdftoppm；默认取 PATH 上的那个",
    )
    parser.add_argument("--workers", type=int, default=max(1, min(4, os.cpu_count() or 1)))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--page-limit", type=int, default=0)
    args = parser.parse_args()
    # 落进环境，子进程起来时各自读到同一个值。必须在建进程池之前。
    os.environ["PDFTOPPM"] = str(args.pdftoppm)
    global POPPLER_PDFTOPPM
    POPPLER_PDFTOPPM = str(args.pdftoppm)
    source = Path(args.source)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    pdfs = sorted(source.glob("*.pdf"), key=lambda p: p.name)
    if args.limit:
        pdfs = pdfs[:args.limit]
    items = [(f"source_{i:03d}", str(path), str(output), args.page_limit) for i, path in enumerate(pdfs, start=1)]
    all_records = []
    summaries = []
    if args.workers <= 1:
        results = [process_source(item) for item in items]
    else:
        results = []
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(process_source, item): item[0] for item in items}
            for future in as_completed(futures):
                results.append(future.result())
    results.sort(key=lambda x: x["source_id"])
    for result in results:
        summaries.append({k: result[k] for k in ["source_id", "source_file", "source_path", "page_total", "pages_with_candidates", "candidate_count", "failure_count", "fallback_page_count", "failures"]})
        all_records.extend(result["records"])
    write_jsonl(output / "formula_candidates.jsonl", all_records)
    write_jsonl(output / "source_summary.jsonl", summaries)
    with (output / "source_summary.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        fields = ["source_id", "source_file", "source_path", "page_total", "pages_with_candidates", "candidate_count", "failure_count", "fallback_page_count"]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in summaries:
            writer.writerow({key: row[key] for key in fields})
    readme = output / "README.txt"
    readme.write_text(
        "公式 OCR 候选训练集\n\n"
        "images/ 下是从训练集5的扫描 PDF 页面中按版面候选规则切出的 PNG 图像。\n"
        "formula_candidates.jsonl 记录每张图像的来源文件、页码、像素坐标和候选类型。\n"
        "本批次以高召回为目标，候选图像可能包含少量公式上下文或低置信度行；\n"
        "在用于监督训练前，请根据候选类型/score 做一次人工确认并补充标签。\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "sources": len(pdfs),
        "pages": sum(x["page_total"] for x in summaries),
        "candidates": len(all_records),
        "failures": sum(x["failure_count"] for x in summaries),
        "output": str(output),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
