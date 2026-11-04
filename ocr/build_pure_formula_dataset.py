from __future__ import annotations

import argparse
import contextlib
import csv
import gc
import hashlib
import io
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

import pypdf
import onnxruntime as ort
from optimum.onnxruntime import ORTModelForVision2Seq
from PIL import Image, ImageOps
from texteller import img2latex, latex_detect, load_latexdet_model, load_model, load_tokenizer


# poppler 的 pdftoppm，从 PATH 上找——和 ocr/import_pdf_formulas.py 一样的做法，
# --pdftoppm 可以覆盖。不写某台机器上的绝对路径：主干的 b0b5d56（Keep home
# directories out of the extractor and its output）就是为这件事做的，一条写死的
# 家目录会让这个脚本只在作者那台机器上跑得起来，而且是安静地跑不起来。
#
# --source 和 --output 没有默认值，同一个理由：源书目录和数据集落地处都是机器
# 相关的，给一个默认值等于把别人的路径当成约定。
POPPLER_PDFTOPPM = shutil.which("pdftoppm") or "pdftoppm"
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
URL_RE = re.compile(r"(?:https?\s*:|www\s*\.|bilibili|cnblogs)", re.IGNORECASE)
BEGIN_RE = re.compile(r"\\begin\s*\{([^{}]+)\}")
END_RE = re.compile(r"\\end\s*\{([^{}]+)\}")
SPECIAL_CATEGORY_PATTERNS = {
    "极限": re.compile(r"\\(?:lim|limsup|liminf)\b|\\to\b|\\infty\b"),
    "积分": re.compile(r"\\(?:int|iint|iiint|iiiint|oint|oiint|smallint)\b"),
    "微分与分析算子": re.compile(
        r"\\(?:partial|nabla|Delta|mathrm\s*\{d\}|operatorname\s*\{d\})"
    ),
    "求和乘积与大型算子": re.compile(
        r"\\(?:sum|prod|coprod|bigcup|bigcap|bigoplus|bigotimes|bigsqcup)\b"
    ),
    "函数与命名算子": re.compile(
        r"\\(?:operatorname|sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|"
        r"sinh|cosh|tanh|log|ln|exp|max|min|sup|inf|arg|deg|gcd|hom|ker|det)\b"
    ),
    "集合与逻辑": re.compile(
        r"\\(?:forall|exists|nexists|in|notin|ni|subset|subseteq|supset|supseteq|"
        r"cup|cap|setminus|emptyset|varnothing|land|lor|neg|implies|iff)\b"
    ),
    "线性代数与高代": re.compile(
        r"\\begin\s*\{(?:matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|array)\}|"
        r"\\(?:det|ker|rank|dim|tr|operatorname)\b|(?:rank|Ker|Im|span|diag)"
    ),
    "复变函数": re.compile(
        r"\\mathbb\s*\{C\}|\\(?:Re|Im|arg|overline|bar|oint)\b|(?:Res|residue)"
    ),
    "实变与测度": re.compile(
        r"\\(?:mathcal|sigma|mu|nu|lambda|chi)\b|L\s*\^\s*\{|"
        r"(?:a\.e\.|almost\s+everywhere|ess\s*sup)"
    ),
    "解析几何与向量": re.compile(
        r"\\(?:vec|overrightarrow|overleftarrow|mathbf|boldsymbol|angle|perp|parallel|"
        r"cdot|times|cross|triangle)\b"
    ),
    "希腊字母": re.compile(
        r"\\(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|"
        r"iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|tau|"
        r"upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|"
        r"Upsilon|Phi|Psi|Omega)\b"
    ),
    "关系符号与箭头": re.compile(
        r"\\(?:leq|geq|neq|equiv|approx|sim|simeq|cong|propto|ll|gg|prec|succ|"
        r"preceq|succeq|mapsto|rightarrow|leftarrow|leftrightarrow|Rightarrow|"
        r"Leftarrow|Leftrightarrow|uparrow|downarrow)\b"
    ),
    "分式根式与分段结构": re.compile(
        r"\\(?:frac|dfrac|tfrac|sqrt|binom|cases|substack)\b|"
        r"\\begin\s*\{(?:cases|aligned|gathered|split)\}"
    ),
}

Image.MAX_IMAGE_PIXELS = None


def connect_db(root: Path) -> sqlite3.Connection:
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / "dataset.sqlite", timeout=60)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS sources (
            source_id TEXT PRIMARY KEY,
            source_file TEXT NOT NULL,
            source_path TEXT NOT NULL,
            page_total INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pages (
            source_id TEXT NOT NULL,
            page INTEGER NOT NULL,
            status TEXT NOT NULL,
            error TEXT,
            formula_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (source_id, page)
        );
        CREATE TABLE IF NOT EXISTS formulas (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            source_file TEXT NOT NULL,
            page INTEGER NOT NULL,
            image TEXT NOT NULL,
            bbox_json TEXT NOT NULL,
            formula_type TEXT NOT NULL,
            detector_label TEXT NOT NULL,
            detection_confidence REAL NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_formulas_source_page
            ON formulas(source_id, page);
        CREATE INDEX IF NOT EXISTS idx_formulas_confidence
            ON formulas(detection_confidence);
        CREATE TABLE IF NOT EXISTS labels (
            id TEXT PRIMARY KEY,
            latex TEXT NOT NULL,
            label_status TEXT NOT NULL,
            review_reason TEXT NOT NULL,
            model_name TEXT NOT NULL
        );
        """
    )
    return db


def page_image(page) -> Image.Image | None:
    try:
        images = page.images
        if not images:
            return None
        best = max(images, key=lambda item: item.image.width * item.image.height)
        return best.image.convert("RGB")
    except Exception:
        return None


def render_page(pdf_path: Path, page_number: int, work_dir: Path) -> Image.Image:
    prefix = work_dir / "rendered"
    output = prefix.with_suffix(".png")
    output.unlink(missing_ok=True)
    command = [
        str(POPPLER_PDFTOPPM),
        "-png",
        "-r",
        "150",
        "-f",
        str(page_number),
        "-l",
        str(page_number),
        "-singlefile",
        str(pdf_path),
        str(prefix),
    ]
    result = subprocess.run(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0 or not output.exists():
        detail = result.stderr.decode("utf-8", errors="replace")[-500:]
        raise RuntimeError(f"pdftoppm failed ({result.returncode}): {detail}")
    with Image.open(output) as loaded:
        return loaded.convert("RGB").copy()


def clamp_detection(item, image_width: int, image_height: int):
    x0 = max(0, int(round(float(item.p.x))))
    y0 = max(0, int(round(float(item.p.y))))
    x1 = min(image_width, int(round(float(item.p.x) + float(item.w))))
    y1 = min(image_height, int(round(float(item.p.y) + float(item.h))))
    if x1 - x0 < 3 or y1 - y0 < 3:
        return None
    return {
        "x0": x0,
        "y0": y0,
        "x1": x1,
        "y1": y1,
        "label": str(item.label),
        "confidence": float(item.confidence),
    }


def intersection_over_union(left, right) -> float:
    x0 = max(left["x0"], right["x0"])
    y0 = max(left["y0"], right["y0"])
    x1 = min(left["x1"], right["x1"])
    y1 = min(left["y1"], right["y1"])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    intersection = (x1 - x0) * (y1 - y0)
    left_area = (left["x1"] - left["x0"]) * (left["y1"] - left["y0"])
    right_area = (right["x1"] - right["x0"]) * (right["y1"] - right["y0"])
    return intersection / max(1, left_area + right_area - intersection)


def deduplicate(detections):
    kept = []
    for candidate in sorted(detections, key=lambda item: item["confidence"], reverse=True):
        if any(intersection_over_union(candidate, existing) >= 0.82 for existing in kept):
            continue
        kept.append(candidate)
    return sorted(kept, key=lambda item: (item["y0"], item["x0"]))


def completed_pages(db: sqlite3.Connection, source_id: str) -> set[int]:
    return {
        row[0]
        for row in db.execute(
            "SELECT page FROM pages WHERE source_id = ? AND status = 'done'", (source_id,)
        )
    }


def save_detected_page(
    db: sqlite3.Connection,
    output_root: Path,
    source_id: str,
    source_file: str,
    page_number: int,
    image: Image.Image,
    detections,
) -> int:
    source_dir = output_root / "images" / source_id
    source_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for formula_index, detection in enumerate(detections, start=1):
        pad = max(3, int(round(image.height * 0.002)))
        left = max(0, detection["x0"] - pad)
        top = max(0, detection["y0"] - pad)
        right = min(image.width, detection["x1"] + pad)
        bottom = min(image.height, detection["y1"] + pad)
        crop = ImageOps.grayscale(image.crop((left, top, right, bottom)))
        crop = ImageOps.expand(crop, border=4, fill=255)
        formula_id = f"{source_id}_p{page_number:05d}_f{formula_index:03d}"
        relative_image = f"images/{source_id}/p{page_number:05d}_f{formula_index:03d}.png"
        crop.save(output_root / relative_image, format="PNG", compress_level=1)
        formula_type = "display" if detection["label"] == "isolated" else "inline"
        bbox = [left, top, right, bottom]
        rows.append(
            (
                formula_id,
                source_id,
                source_file,
                page_number,
                relative_image,
                json.dumps(bbox, ensure_ascii=False),
                formula_type,
                detection["label"],
                detection["confidence"],
                crop.width,
                crop.height,
            )
        )

    with db:
        previous_ids = [
            row[0]
            for row in db.execute(
                "SELECT id FROM formulas WHERE source_id = ? AND page = ?",
                (source_id, page_number),
            )
        ]
        if previous_ids:
            db.executemany("DELETE FROM labels WHERE id = ?", [(item,) for item in previous_ids])
        db.execute(
            "DELETE FROM formulas WHERE source_id = ? AND page = ?",
            (source_id, page_number),
        )
        db.executemany(
            """
            INSERT INTO formulas (
                id, source_id, source_file, page, image, bbox_json,
                formula_type, detector_label, detection_confidence, width, height
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        db.execute(
            """
            INSERT INTO pages (source_id, page, status, error, formula_count)
            VALUES (?, ?, 'done', NULL, ?)
            ON CONFLICT(source_id, page) DO UPDATE SET
                status = 'done', error = NULL, formula_count = excluded.formula_count
            """,
            (source_id, page_number, len(rows)),
        )
    return len(rows)


def record_page_error(
    db: sqlite3.Connection, source_id: str, page_number: int, error: Exception
) -> None:
    message = f"{type(error).__name__}: {error}"[:2000]
    with db:
        db.execute(
            """
            INSERT INTO pages (source_id, page, status, error, formula_count)
            VALUES (?, ?, 'error', ?, 0)
            ON CONFLICT(source_id, page) DO UPDATE SET
                status = 'error', error = excluded.error, formula_count = 0
            """,
            (source_id, page_number, message),
        )


def detection_phase(
    db: sqlite3.Connection,
    source_root: Path,
    output_root: Path,
    source_limit: int,
    page_limit: int,
    max_new_pages: int,
    source_start: int,
    source_end: int,
    write_completion_marker: bool,
) -> None:
    completion_path = output_root / "detection_complete.json"
    if not max_new_pages and write_completion_marker:
        completion_path.unlink(missing_ok=True)
    all_pdfs = sorted(source_root.glob("*.pdf"), key=lambda path: path.name)
    if source_limit:
        all_pdfs = all_pdfs[:source_limit]
    pdfs = [
        (index, path)
        for index, path in enumerate(all_pdfs, start=1)
        if index >= source_start and (not source_end or index <= source_end)
    ]
    detector = load_latexdet_model()
    range_name = f"{source_start:03d}_{source_end or len(all_pdfs):03d}"
    work_dir = output_root / f"_page_cache_{range_name}"
    work_dir.mkdir(parents=True, exist_ok=True)
    page_path = work_dir / "page.png"
    new_pages = 0
    started = time.perf_counter()

    for source_index, pdf_path in pdfs:
        source_id = f"source_{source_index:03d}"
        with contextlib.redirect_stderr(io.StringIO()):
            reader = pypdf.PdfReader(str(pdf_path), strict=False)
        page_total = len(reader.pages)
        del reader
        gc.collect()
        if page_limit:
            page_total = min(page_total, page_limit)
        with db:
            db.execute(
                """
                INSERT INTO sources (source_id, source_file, source_path, page_total)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(source_id) DO UPDATE SET
                    source_file = excluded.source_file,
                    source_path = excluded.source_path,
                    page_total = excluded.page_total
                """,
                (source_id, pdf_path.name, str(pdf_path), page_total),
            )
        done = completed_pages(db, source_id)
        source_formula_count = db.execute(
            "SELECT COUNT(*) FROM formulas WHERE source_id = ?", (source_id,)
        ).fetchone()[0]
        print(
            f"DETECT source={source_id} pages={page_total} resume_done={len(done)} "
            f"formulas={source_formula_count}",
            flush=True,
        )

        chunk_size = 36
        for chunk_start in range(0, page_total, chunk_size):
            chunk_end = min(page_total, chunk_start + chunk_size)
            if all(page in done for page in range(chunk_start + 1, chunk_end + 1)):
                continue
            with contextlib.redirect_stderr(io.StringIO()):
                reader = pypdf.PdfReader(str(pdf_path), strict=False)
            pages = reader.pages[chunk_start:chunk_end]
            for offset, page in enumerate(pages):
                page_number = chunk_start + offset + 1
                if page_number in done:
                    continue
                if max_new_pages and new_pages >= max_new_pages:
                    print("DETECT reached --max-new-pages", flush=True)
                    shutil.rmtree(work_dir, ignore_errors=True)
                    return
                try:
                    image = page_image(page)
                    if image is None:
                        image = render_page(pdf_path, page_number, work_dir)
                    image.save(page_path, format="PNG", compress_level=1)
                    raw_detections = latex_detect(str(page_path), detector)
                    normalized = []
                    for item in raw_detections:
                        detection = clamp_detection(item, image.width, image.height)
                        if detection is not None:
                            normalized.append(detection)
                    detections = deduplicate(normalized)
                    count = save_detected_page(
                        db,
                        output_root,
                        source_id,
                        pdf_path.name,
                        page_number,
                        image,
                        detections,
                    )
                    source_formula_count += count
                except Exception as error:
                    record_page_error(db, source_id, page_number, error)
                    print(
                        f"DETECT_ERROR source={source_id} page={page_number} error={error}",
                        flush=True,
                    )
                new_pages += 1
                if new_pages % 25 == 0:
                    elapsed = max(0.001, time.perf_counter() - started)
                    print(
                        f"DETECT_PROGRESS new_pages={new_pages} rate={new_pages / elapsed:.2f}/s "
                        f"last={source_id}:{page_number} formulas={source_formula_count}",
                        flush=True,
                    )
                page_path.unlink(missing_ok=True)
            del pages
            del reader
            gc.collect()
    shutil.rmtree(work_dir, ignore_errors=True)
    completion = {
        "completed": True,
        "sources": db.execute("SELECT COUNT(*) FROM sources").fetchone()[0],
        "pages_done": db.execute(
            "SELECT COUNT(*) FROM pages WHERE status = 'done'"
        ).fetchone()[0],
        "page_errors": db.execute(
            "SELECT COUNT(*) FROM pages WHERE status = 'error'"
        ).fetchone()[0],
        "formulas": db.execute("SELECT COUNT(*) FROM formulas").fetchone()[0],
    }
    if write_completion_marker:
        completion_path.write_text(
            json.dumps(completion, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"DETECT_COMPLETE {json.dumps(completion, ensure_ascii=False)}", flush=True)
    else:
        print(
            f"DETECT_WORKER_COMPLETE range={range_name} "
            f"{json.dumps(completion, ensure_ascii=False)}",
            flush=True,
        )


def strip_math_wrappers(latex: str) -> str:
    value = latex.strip()
    if value.startswith("\\[") and value.endswith("\\]"):
        value = value[2:-2].strip()
    if value.startswith("$$") and value.endswith("$$") and len(value) >= 4:
        value = value[2:-2].strip()
    return value


def braces_balanced(value: str) -> bool:
    depth = 0
    escaped = False
    for character in value:
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0


def review_reasons(latex: str, confidence: float) -> list[str]:
    reasons = []
    if not latex.strip():
        reasons.append("empty_latex")
    if CJK_RE.search(latex):
        reasons.append("contains_chinese")
    if URL_RE.search(latex):
        reasons.append("contains_url")
    if any(ord(character) < 32 and character not in "\n\r\t" for character in latex):
        reasons.append("control_character")
    if "\ufffd" in latex or any(
        0xD800 <= ord(character) <= 0xDFFF for character in latex
    ):
        reasons.append("invalid_unicode")
    if not braces_balanced(latex):
        reasons.append("unbalanced_braces")
    if sorted(BEGIN_RE.findall(latex)) != sorted(END_RE.findall(latex)):
        reasons.append("environment_mismatch")
    left_count = len(re.findall(r"\\left(?![A-Za-z])", latex))
    right_count = len(re.findall(r"\\right(?![A-Za-z])", latex))
    if left_count != right_count:
        reasons.append("left_right_mismatch")
    trailing_backslashes = len(latex) - len(latex.rstrip("\\"))
    if trailing_backslashes % 2:
        reasons.append("dangling_backslash")
    if len(latex.strip()) > 1 and re.search(r"[=+\-*/<>_^&]\s*$", latex):
        reasons.append("dangling_formula_ending")
    if len(latex) > 3500:
        reasons.append("latex_too_long")
    if latex.count("\\boxed") > 8:
        reasons.append("suspicious_repetition")
    if confidence < 0.75:
        reasons.append("low_detection_confidence")
    return reasons


def labeling_phase(
    db: sqlite3.Connection,
    output_root: Path,
    batch_size: int,
    max_new_labels: int,
    follow_detection: bool,
    source_start: int,
    source_end: int,
    disable_io_binding: bool,
    safe_io_binding_fallback: bool,
    disable_ort_memory_reuse: bool,
    label_tier: str,
    large_batch_cap: int,
    wide_batch_cap: int,
) -> None:
    if disable_ort_memory_reuse:
        session_options = ort.SessionOptions()
        session_options.enable_mem_reuse = False
        provider = (
            "CUDAExecutionProvider"
            if "CUDAExecutionProvider" in ort.get_available_providers()
            else "CPUExecutionProvider"
        )
        model = ORTModelForVision2Seq.from_pretrained(
            "OleehyO/TexTeller",
            provider=provider,
            session_options=session_options,
            use_io_binding=True,
            local_files_only=True,
        )
        print("LABEL_ORT_MEMORY_REUSE disabled", flush=True)
    else:
        model = load_model(use_onnx=True)
    if disable_io_binding and hasattr(model, "use_io_binding"):
        model.use_io_binding = False
        print("LABEL_IO_BINDING disabled", flush=True)
    tokenizer = load_tokenizer()

    def predict_without_io_binding(paths: list[str], max_tokens: int) -> list[str]:
        previous = getattr(model, "use_io_binding", None)
        if previous is not None:
            model.use_io_binding = False
        try:
            return img2latex(
                model,
                tokenizer,
                paths,
                out_format="latex",
                keep_style=False,
                max_tokens=max_tokens,
                num_beams=1,
            )
        finally:
            if previous is not None:
                model.use_io_binding = previous

    started = time.perf_counter()
    new_labels = 0
    source_conditions = ["f.source_id >= ?"]
    source_parameters = [f"source_{source_start:03d}"]
    if source_end:
        source_conditions.append("f.source_id <= ?")
        source_parameters.append(f"source_{source_end:03d}")
    source_where = " AND ".join(source_conditions)
    while True:
        limit = batch_size
        if max_new_labels:
            remaining = max_new_labels - new_labels
            if remaining <= 0:
                print("LABEL reached --max-new-labels", flush=True)
                return
            limit = min(limit, remaining)
        rows = []
        token_limit = 768
        tier_queries = [
            ("small", "f.width <= 220 AND f.height <= 120", limit, 128),
            (
                "medium",
                "NOT (f.width <= 220 AND f.height <= 120) "
                "AND f.width <= 700 AND f.height <= 320",
                limit,
                384,
            ),
            (
                "large-moderate",
                "NOT (f.width <= 700 AND f.height <= 320) "
                "AND f.width <= 1200 AND f.height <= 500",
                min(limit, large_batch_cap),
                768,
            ),
            (
                "large-wide",
                "NOT (f.width <= 1200 AND f.height <= 500) "
                "AND f.width <= 2000 AND f.height <= 800",
                min(limit, wide_batch_cap),
                768,
            ),
            (
                "huge",
                "NOT (f.width <= 2000 AND f.height <= 800)",
                1,
                768,
            ),
        ]
        if label_tier != "auto":
            tier_queries = [item for item in tier_queries if item[0] == label_tier]
        for _, tier_where, tier_limit, tier_token_limit in tier_queries:
            rows = db.execute(
                f"""
                SELECT f.id, f.image, f.detection_confidence, f.width, f.height
                FROM formulas AS f
                LEFT JOIN labels AS l ON l.id = f.id
                WHERE l.id IS NULL
                  AND f.detection_confidence >= 0.75
                  AND {source_where}
                  AND {tier_where}
                ORDER BY f.source_id, f.page, f.id
                LIMIT ?
                """,
                (*source_parameters, tier_limit),
            ).fetchall()
            if rows:
                token_limit = tier_token_limit
                break
        if not rows and follow_detection and not (output_root / "detection_complete.json").exists():
            time.sleep(5)
            continue
        if not rows:
            return
        paths = [str(output_root / row[1]) for row in rows]
        token_limits = [token_limit] * len(rows)
        try:
            predictions = img2latex(
                model,
                tokenizer,
                paths,
                out_format="latex",
                keep_style=False,
                max_tokens=max(token_limits),
                num_beams=1,
            )
        except Exception as error:
            predictions = []
            if safe_io_binding_fallback and getattr(model, "use_io_binding", False):
                print(
                    f"LABEL_BATCH_ERROR error={error}; retrying safe chunks without I/O binding",
                    flush=True,
                )
                try:
                    for chunk_start in range(0, len(paths), 4):
                        predictions.extend(
                            predict_without_io_binding(
                                paths[chunk_start : chunk_start + 4],
                                max(token_limits[chunk_start : chunk_start + 4]),
                            )
                        )
                except Exception as fallback_error:
                    predictions = []
                    print(
                        "LABEL_SAFE_CHUNK_ERROR "
                        f"error={fallback_error}; retrying individually without I/O binding",
                        flush=True,
                    )
            else:
                print(f"LABEL_BATCH_ERROR error={error}; retrying individually", flush=True)
            if not predictions:
                for path, item_token_limit in zip(paths, token_limits):
                    try:
                        if safe_io_binding_fallback:
                            prediction = predict_without_io_binding(
                                [path], item_token_limit
                            )[0]
                        else:
                            prediction = img2latex(
                                model,
                                tokenizer,
                                [path],
                                out_format="latex",
                                keep_style=False,
                                max_tokens=item_token_limit,
                                num_beams=1,
                            )[0]
                    except Exception as item_error:
                        prediction = (
                            f"__INFERENCE_ERROR__ {type(item_error).__name__}: {item_error}"
                        )
                    predictions.append(prediction)

        for index, (row, prediction) in enumerate(zip(rows, predictions)):
            preview = strip_math_wrappers(str(prediction))
            generated_tokens = len(
                tokenizer.encode(preview, add_special_tokens=False)
            )
            if token_limit < 768 and generated_tokens >= token_limit - 8:
                try:
                    retry_path = str(output_root / row[1])
                    if safe_io_binding_fallback:
                        predictions[index] = predict_without_io_binding(
                            [retry_path], 768
                        )[0]
                    else:
                        predictions[index] = img2latex(
                            model,
                            tokenizer,
                            [retry_path],
                            out_format="latex",
                            keep_style=False,
                            max_tokens=768,
                            num_beams=1,
                        )[0]
                except Exception as retry_error:
                    predictions[index] = (
                        f"__INFERENCE_ERROR__ {type(retry_error).__name__}: {retry_error}"
                    )

        label_rows = []
        for row, prediction in zip(rows, predictions):
            latex = strip_math_wrappers(str(prediction))
            reasons = review_reasons(latex, float(row[2]))
            generated_tokens = len(
                tokenizer.encode(latex, add_special_tokens=False)
            )
            if generated_tokens >= 760:
                reasons.append("generation_token_limit_reached")
            if latex.startswith("__INFERENCE_ERROR__"):
                reasons.append("inference_error")
            status = "accepted" if not reasons else "needs_review"
            label_rows.append(
                (
                    row[0],
                    latex,
                    status,
                    ";".join(sorted(set(reasons))),
                    "TexTeller-3.0-ONNX",
                )
            )
        with db:
            db.executemany(
                """
                INSERT OR REPLACE INTO labels
                    (id, latex, label_status, review_reason, model_name)
                VALUES (?, ?, ?, ?, ?)
                """,
                label_rows,
            )
        new_labels += len(label_rows)
        if new_labels % max(batch_size, 20) == 0:
            elapsed = max(0.001, time.perf_counter() - started)
            accepted = sum(item[2] == "accepted" for item in label_rows)
            print(
                f"LABEL_PROGRESS new_labels={new_labels} rate={new_labels / elapsed:.2f}/s "
                f"batch_accepted={accepted}/{len(label_rows)} last={rows[-1][0]}",
                flush=True,
            )


def dataset_row(db_row) -> dict:
    (
        formula_id,
        image,
        latex,
        formula_type,
        source_file,
        page,
        bbox_json,
        width,
        height,
        confidence,
        label_status,
        review_reason,
        model_name,
    ) = db_row
    # Keep JSONL/CSV labels single-line and free of control characters while
    # preserving ordinary spaces and TeX row separators such as ``\\\\``.
    latex = re.sub(r"[\x00-\x1f\x7f]+", " ", latex).strip()
    categories = [
        category
        for category, pattern in SPECIAL_CATEGORY_PATTERNS.items()
        if pattern.search(latex)
    ]
    return {
        "id": formula_id,
        "image": image,
        "latex": latex,
        "type": formula_type,
        "subject": "数学",
        "book": source_file,
        "page": page,
        "bbox": json.loads(bbox_json),
        "width": width,
        "height": height,
        "detection_confidence": round(float(confidence), 6),
        "verification_status": (
            "auto_detector_recognizer_syntax_checked"
            if label_status == "accepted"
            else "needs_review"
        ),
        "review_reason": review_reason,
        "label_model": model_name,
        "special_symbol_categories": categories,
        "is_special_symbol_sample": bool(categories),
    }


def write_jsonl(path: Path, rows) -> int:
    count = 0
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
    return count


def split_is_validation(formula_id: str) -> bool:
    digest = hashlib.sha256(formula_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % 10 == 0


def revalidate_labels(db: sqlite3.Connection) -> None:
    with db:
        db.execute(
            """
            INSERT OR IGNORE INTO labels
                (id, latex, label_status, review_reason, model_name)
            SELECT id, '', 'needs_review', 'low_detection_confidence', 'detector-only'
            FROM formulas
            WHERE detection_confidence < 0.75
            """
        )
    rows = db.execute(
        """
        SELECT l.id, l.latex, f.detection_confidence, l.review_reason
        FROM labels AS l
        JOIN formulas AS f ON f.id = l.id
        """
    ).fetchall()
    updates = []
    for formula_id, latex, confidence, prior_review_reason in rows:
        reasons = review_reasons(latex, float(confidence))
        reasons.extend(
            reason
            for reason in (prior_review_reason or "").split(";")
            if reason.startswith("manual_")
        )
        status = "accepted" if not reasons else "needs_review"
        updates.append((status, ";".join(sorted(set(reasons))), formula_id))
    with db:
        db.executemany(
            "UPDATE labels SET label_status = ?, review_reason = ? WHERE id = ?",
            updates,
        )


def finalize_phase(db: sqlite3.Connection, output_root: Path) -> None:
    revalidate_labels(db)
    query = """
        SELECT f.id, f.image, l.latex, f.formula_type, f.source_file, f.page,
               f.bbox_json, f.width, f.height, f.detection_confidence,
               l.label_status, l.review_reason, l.model_name
        FROM formulas AS f
        JOIN labels AS l ON l.id = f.id
        ORDER BY f.source_id, f.page, f.id
    """
    all_rows = [dataset_row(row) for row in db.execute(query)]
    accepted = [row for row in all_rows if row["verification_status"] != "needs_review"]
    review = [row for row in all_rows if row["verification_status"] == "needs_review"]
    train = [row for row in accepted if not split_is_validation(row["id"])]
    validation = [row for row in accepted if split_is_validation(row["id"])]
    special_focus = [row for row in accepted if row["is_special_symbol_sample"]]
    special_train = [row for row in train if row["is_special_symbol_sample"]]
    special_validation = [row for row in validation if row["is_special_symbol_sample"]]
    complex_categories = {
        "极限",
        "积分",
        "微分与分析算子",
        "求和乘积与大型算子",
        "线性代数与高代",
        "复变函数",
        "实变与测度",
        "解析几何与向量",
        "分式根式与分段结构",
    }
    complex_focus = [
        row
        for row in accepted
        if complex_categories.intersection(row["special_symbol_categories"])
    ]
    ordinary_train = [row for row in train if not row["is_special_symbol_sample"]]
    ordinary_train.sort(
        key=lambda row: hashlib.sha256(row["id"].encode("utf-8")).digest()
    )
    balanced_train = sorted(
        special_train + ordinary_train[: len(special_train)],
        key=lambda row: row["id"],
    )

    write_jsonl(output_root / "all.jsonl", accepted)
    write_jsonl(output_root / "train.jsonl", train)
    write_jsonl(output_root / "val.jsonl", validation)
    write_jsonl(output_root / "review_needed.jsonl", review)
    write_jsonl(output_root / "special_symbol_focus.jsonl", special_focus)
    write_jsonl(output_root / "train_special_symbol_focus.jsonl", special_train)
    write_jsonl(output_root / "val_special_symbol_focus.jsonl", special_validation)
    write_jsonl(output_root / "complex_formula_focus.jsonl", complex_focus)
    write_jsonl(output_root / "train_balanced_special_1to1.jsonl", balanced_train)

    columns = [
        "id",
        "image",
        "latex",
        "type",
        "subject",
        "book",
        "page",
        "bbox",
        "width",
        "height",
        "detection_confidence",
        "verification_status",
        "review_reason",
        "label_model",
        "special_symbol_categories",
        "is_special_symbol_sample",
    ]
    with (output_root / "latex_correspondence.csv").open(
        "w", encoding="utf-8-sig", newline=""
    ) as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in all_rows:
            csv_row = dict(row)
            csv_row["bbox"] = json.dumps(csv_row["bbox"], ensure_ascii=False)
            csv_row["special_symbol_categories"] = ";".join(
                csv_row["special_symbol_categories"]
            )
            writer.writerow(csv_row)

    coverage = Counter(
        category
        for row in accepted
        for category in row["special_symbol_categories"]
    )
    with (output_root / "special_symbol_coverage.csv").open(
        "w", encoding="utf-8-sig", newline=""
    ) as handle:
        writer = csv.writer(handle)
        writer.writerow(["类别", "样本数"])
        for category in SPECIAL_CATEGORY_PATTERNS:
            writer.writerow([category, coverage.get(category, 0)])

    vocabulary = sorted(
        {
            character
            for row in accepted
            for character in row["latex"]
            if not character.isspace() and not CJK_RE.match(character)
        }
    )
    (output_root / "vocab.txt").write_text("\n".join(vocabulary) + "\n", encoding="utf-8")

    source_count = db.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    page_count = db.execute("SELECT COUNT(*) FROM pages WHERE status = 'done'").fetchone()[0]
    page_errors = db.execute("SELECT COUNT(*) FROM pages WHERE status = 'error'").fetchone()[0]
    detected_count = db.execute("SELECT COUNT(*) FROM formulas").fetchone()[0]
    unlabeled_count = db.execute(
        """
        SELECT COUNT(*) FROM formulas AS f
        LEFT JOIN labels AS l ON l.id = f.id
        WHERE l.id IS NULL
        """
    ).fetchone()[0]
    info = {
        "sources": source_count,
        "processed_pages": page_count,
        "page_errors": page_errors,
        "detected_formula_images": detected_count,
        "accepted_labeled_formulas": len(accepted),
        "train_count": len(train),
        "val_count": len(validation),
        "review_needed_count": len(review),
        "special_symbol_focus_count": len(special_focus),
        "special_symbol_train_count": len(special_train),
        "special_symbol_val_count": len(special_validation),
        "complex_formula_focus_count": len(complex_focus),
        "balanced_special_1to1_train_count": len(balanced_train),
        "special_symbol_category_counts": dict(coverage),
        "unlabeled_count": unlabeled_count,
        "contains_chinese_policy": "accepted labels contain no CJK characters",
        "english_formula_text_policy": "retained",
        "model_training_performed": False,
        "verification_scope": "formula detection + LaTeX recognition + automated syntax/content checks; visual audit is reported separately",
    }
    (output_root / "dataset_info.json").write_text(
        json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    readme = f"""纯数学公式 OCR 训练集

本目录只制作训练集，没有训练、微调或更新任何 OCR 模型参数。

文件：
- train.jsonl：正式训练集，共 {len(train)} 条。
- val.jsonl：正式验证集，共 {len(validation)} 条。
- all.jsonl：train 与 val 的合集，共 {len(accepted)} 条。
- review_needed.jsonl：自动检查未通过的候选，不应直接用于训练，共 {len(review)} 条。
- special_symbol_focus.jsonl：极限、积分、算子、分析、高代、复变、实变、解析几何等特殊公式重点集，共 {len(special_focus)} 条。
- train_special_symbol_focus.jsonl / val_special_symbol_focus.jsonl：特殊公式训练/验证子集。
- complex_formula_focus.jsonl：复杂积分、极限、分析算子、矩阵、复变/实变、解析几何、分式与分段结构的完整性复核清单，共 {len(complex_focus)} 条。
- train_balanced_special_1to1.jsonl：特殊公式与普通公式约 1:1 的平衡训练清单，共 {len(balanced_train)} 条，避免普通字母样本淹没特殊符号。
- special_symbol_coverage.csv：特殊公式类别覆盖统计。
- latex_correspondence.csv：图片与 LaTeX 全量对照表，可用 Excel 打开。
- dataset_info.json：统计与处理口径。
- vocab.txt：正式数据中的字符表。
- images/：公式图片。

筛选规则：
1. 使用公式检测器从原 PDF 页面定位独立公式和行内公式。
2. 公式中的英文（如 rank、det、lim、Ker）保留。
3. 极限、积分、微分、求和/乘积、函数算子、集合逻辑、矩阵/行列式、复变、实变、解析几何、希腊字母、关系符号均分类保留。
4. 含中文、网址、空标签、非格式控制字符、括号/环境明显不配对、疑似截断等记录移入 review_needed.jsonl；换行和制表等格式控制字符在导出时规范为空格。
5. 短公式若触及初始生成长度上限，会自动以 768 tokens 单张重识别；仍触及上限的记录不进入正式训练集。
6. verification_status=auto_detector_recognizer_syntax_checked 表示通过自动检测和语法检查，不等同于逐条人工核对。
"""
    (output_root / "README.txt").write_text(readme, encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False), flush=True)


def main() -> None:
    global POPPLER_PDFTOPPM
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True, help="源书目录（PDF）")
    parser.add_argument("--output", type=Path, required=True, help="数据集落地目录")
    parser.add_argument(
        "--pdftoppm", default=POPPLER_PDFTOPPM,
        help="poppler 的 pdftoppm；默认取 PATH 上的那个",
    )
    parser.add_argument("--phase", choices=["detect", "label", "finalize", "all"], default="all")
    parser.add_argument("--source-limit", type=int, default=0)
    parser.add_argument("--page-limit", type=int, default=0)
    parser.add_argument("--max-new-pages", type=int, default=0)
    parser.add_argument("--max-new-labels", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--follow-detection", action="store_true")
    parser.add_argument("--source-start", type=int, default=1)
    parser.add_argument("--source-end", type=int, default=0)
    parser.add_argument("--disable-io-binding", action="store_true")
    parser.add_argument("--safe-io-binding-fallback", action="store_true")
    parser.add_argument("--disable-ort-memory-reuse", action="store_true")
    parser.add_argument(
        "--label-tier",
        choices=["auto", "small", "medium", "large-moderate", "large-wide", "huge"],
        default="auto",
    )
    parser.add_argument("--large-batch-cap", type=int, default=4)
    parser.add_argument("--wide-batch-cap", type=int, default=2)
    parser.add_argument("--no-completion-marker", action="store_true")
    args = parser.parse_args()
    # render_page 按模块名取这个值，而它在调用链的深处，所以在这里落一次，而不是
    # 把一个参数穿过中间那几层函数签名。
    POPPLER_PDFTOPPM = args.pdftoppm
    args.output.mkdir(parents=True, exist_ok=True)
    db = connect_db(args.output)
    try:
        if args.phase in {"detect", "all"}:
            detection_phase(
                db,
                args.source,
                args.output,
                args.source_limit,
                args.page_limit,
                args.max_new_pages,
                args.source_start,
                args.source_end,
                not args.no_completion_marker,
            )
        if args.phase in {"label", "all"}:
            labeling_phase(
                db,
                args.output,
                args.batch_size,
                args.max_new_labels,
                args.follow_detection,
                args.source_start,
                args.source_end,
                args.disable_io_binding,
                args.safe_io_binding_fallback,
                args.disable_ort_memory_reuse,
                args.label_tier,
                max(1, args.large_batch_cap),
                max(1, args.wide_batch_cap),
            )
        if args.phase in {"finalize", "all"}:
            finalize_phase(db, args.output)
    finally:
        db.close()


if __name__ == "__main__":
    main()
