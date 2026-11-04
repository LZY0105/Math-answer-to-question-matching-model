from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import shutil
import sqlite3
import sys
import time
import textwrap
from concurrent.futures import ThreadPoolExecutor
from collections import Counter, defaultdict
from pathlib import Path

import onnxruntime as ort
import numpy as np
from optimum.onnxruntime import ORTModelForVision2Seq
from PIL import Image, ImageDraw, ImageFont, ImageOps
from scipy.fftpack import dct
from texteller import img2latex, load_tokenizer

from build_pure_formula_dataset import review_reasons, strip_math_wrappers


DEFAULT_OUTPUT = Path(r"T:\pure_formula_dataset")


def connect(root: Path) -> sqlite3.Connection:
    db = sqlite3.connect(root / "dataset.sqlite", timeout=60)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=60000")
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS review_candidates (
            id TEXT NOT NULL,
            variant TEXT NOT NULL,
            latex TEXT NOT NULL,
            review_reason TEXT NOT NULL,
            generated_tokens INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id, variant),
            FOREIGN KEY (id) REFERENCES formulas(id) ON DELETE CASCADE
        )
        """
    )
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS review_adjudications (
            id TEXT PRIMARY KEY,
            decision TEXT NOT NULL,
            latex TEXT NOT NULL,
            method TEXT NOT NULL,
            note TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (id) REFERENCES formulas(id) ON DELETE CASCADE
        )
        """
    )
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS review_fingerprints (
            id TEXT PRIMARY KEY,
            binary_hash TEXT NOT NULL,
            perceptual_hash TEXT NOT NULL,
            difference_hash TEXT NOT NULL,
            aspect_bucket INTEGER NOT NULL,
            ink_bucket INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (id) REFERENCES formulas(id) ON DELETE CASCADE
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_review_fingerprints_binary "
        "ON review_fingerprints(binary_hash)"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_review_fingerprints_perceptual "
        "ON review_fingerprints(perceptual_hash, difference_hash, aspect_bucket)"
    )
    db.commit()
    return db


def load_review_model():
    options = ort.SessionOptions()
    options.enable_mem_reuse = False
    provider = (
        "CUDAExecutionProvider"
        if "CUDAExecutionProvider" in ort.get_available_providers()
        else "CPUExecutionProvider"
    )
    model = ORTModelForVision2Seq.from_pretrained(
        "OleehyO/TexTeller",
        provider=provider,
        session_options=options,
        use_io_binding=True,
        local_files_only=True,
    )
    return model, load_tokenizer(), provider


def tier_specs(batch_size: int):
    return [
        ("tiny", "f.width <= 80 AND f.height <= 80", batch_size, 128),
        (
            "small",
            "NOT (f.width <= 80 AND f.height <= 80) "
            "AND f.width <= 220 AND f.height <= 120",
            batch_size,
            128,
        ),
        (
            "medium",
            "NOT (f.width <= 220 AND f.height <= 120) "
            "AND f.width <= 700 AND f.height <= 320",
            min(batch_size, 8),
            384,
        ),
        (
            "large",
            "NOT (f.width <= 700 AND f.height <= 320) "
            "AND f.width <= 1200 AND f.height <= 500",
            min(batch_size, 4),
            768,
        ),
        (
            "huge",
            "NOT (f.width <= 1200 AND f.height <= 500)",
            1,
            768,
        ),
    ]


def prepare_variant(source: Path, destination: Path, variant: str) -> Path:
    if variant.startswith("original_"):
        return source
    with Image.open(source) as loaded:
        image = ImageOps.grayscale(loaded)
        if variant.startswith("padded_"):
            image = ImageOps.expand(image, border=16, fill=255)
        elif variant.startswith("contrast_"):
            image = ImageOps.autocontrast(image, cutoff=1)
            image = ImageOps.expand(image, border=16, fill=255)
        else:
            raise ValueError(f"Unsupported variant: {variant}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        image.save(destination, format="PNG", compress_level=1)
    return destination


def predict_batch(model, tokenizer, paths: list[str], max_tokens: int, beams: int):
    try:
        return img2latex(
            model,
            tokenizer,
            paths,
            out_format="latex",
            keep_style=False,
            max_tokens=max_tokens,
            num_beams=beams,
        )
    except Exception as first_error:
        previous = getattr(model, "use_io_binding", None)
        if previous is not None:
            model.use_io_binding = False
        try:
            results = []
            for path in paths:
                try:
                    result = img2latex(
                        model,
                        tokenizer,
                        [path],
                        out_format="latex",
                        keep_style=False,
                        max_tokens=max_tokens,
                        num_beams=beams,
                    )[0]
                except Exception as item_error:
                    result = (
                        f"__INFERENCE_ERROR__ {type(item_error).__name__}: {item_error}; "
                        f"batch={type(first_error).__name__}: {first_error}"
                    )
                results.append(result)
            return results
        finally:
            if previous is not None:
                model.use_io_binding = previous


def recognize(args) -> None:
    # Keep the ASCII subst-drive path. OpenCV used inside TexTeller cannot
    # reliably decode Windows paths containing non-ASCII account/folder names.
    root = args.output
    db = connect(root)
    model, tokenizer, provider = load_review_model()
    beams = 3 if args.variant.endswith("beam3") else 1
    temp_root = root / "review_pass2" / "tmp" / args.variant
    temp_root.mkdir(parents=True, exist_ok=True)
    reason_clause = ""
    parameters: list[object] = [args.variant]
    if args.reason_like:
        reason_clause = "AND l.review_reason LIKE ?"
        parameters.append(f"%{args.reason_like}%")
    source_clause = ""
    if args.source_start:
        source_clause += " AND f.source_id >= ?"
        parameters.append(f"source_{args.source_start:03d}")
    if args.source_end:
        source_clause += " AND f.source_id <= ?"
        parameters.append(f"source_{args.source_end:03d}")

    processed = 0
    started = time.perf_counter()
    print(
        f"REVIEW_RECOGNIZE_START variant={args.variant} beams={beams} provider={provider}",
        flush=True,
    )
    try:
        while not args.max_items or processed < args.max_items:
            rows = []
            token_limit = 768
            tier_name = ""
            for name, tier_where, tier_batch, tier_tokens in tier_specs(args.batch_size):
                limit = tier_batch
                if args.max_items:
                    limit = min(limit, args.max_items - processed)
                if limit <= 0:
                    break
                query = f"""
                    SELECT f.id, f.image, f.detection_confidence, f.width, f.height,
                           l.latex, l.review_reason
                    FROM labels AS l
                    JOIN formulas AS f ON f.id = l.id
                    LEFT JOIN review_candidates AS c
                      ON c.id = l.id AND c.variant = ?
                    WHERE l.label_status = 'needs_review'
                      AND c.id IS NULL
                      {reason_clause}
                      {source_clause}
                      AND {tier_where}
                    ORDER BY f.source_id, f.page, f.id
                    LIMIT ?
                """
                rows = db.execute(query, (*parameters, limit)).fetchall()
                if rows:
                    tier_name = name
                    token_limit = tier_tokens
                    break
            if not rows:
                break

            generated_paths: list[Path] = []
            inference_paths: list[str] = []
            for formula_id, image, *_ in rows:
                source = root / image
                destination = temp_root / f"{formula_id}.png"
                prepared = prepare_variant(source, destination, args.variant)
                inference_paths.append(str(prepared))
                if prepared == destination:
                    generated_paths.append(destination)

            predictions = predict_batch(
                model, tokenizer, inference_paths, token_limit, beams
            )
            inserts = []
            for row, prediction in zip(rows, predictions):
                latex = strip_math_wrappers(str(prediction))
                tokens = len(tokenizer.encode(latex, add_special_tokens=False))
                reasons = review_reasons(latex, 1.0)
                if tokens >= token_limit - 8:
                    reasons.append("generation_token_limit_reached")
                if latex.startswith("__INFERENCE_ERROR__"):
                    reasons.append("inference_error")
                inserts.append(
                    (
                        row[0],
                        args.variant,
                        latex,
                        ";".join(sorted(set(reasons))),
                        tokens,
                    )
                )
            with db:
                db.executemany(
                    """
                    INSERT OR REPLACE INTO review_candidates
                        (id, variant, latex, review_reason, generated_tokens)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    inserts,
                )
            for path in generated_paths:
                path.unlink(missing_ok=True)
            processed += len(rows)
            elapsed = max(time.perf_counter() - started, 0.001)
            valid = sum(not item[3] for item in inserts)
            print(
                f"REVIEW_RECOGNIZE_PROGRESS variant={args.variant} tier={tier_name} "
                f"processed={processed} rate={processed / elapsed:.2f}/s "
                f"batch_valid={valid}/{len(rows)} last={rows[-1][0]}",
                flush=True,
            )
    finally:
        db.close()
        shutil.rmtree(temp_root, ignore_errors=True)
    print(
        f"REVIEW_RECOGNIZE_COMPLETE variant={args.variant} processed={processed}",
        flush=True,
    )


def stats(args) -> None:
    db = connect(args.output)
    try:
        payload = {
            "needs_review": db.execute(
                "SELECT COUNT(*) FROM labels WHERE label_status = 'needs_review'"
            ).fetchone()[0],
            "candidate_counts": dict(
                db.execute(
                    "SELECT variant, COUNT(*) FROM review_candidates GROUP BY variant"
                ).fetchall()
            ),
            "candidate_valid_counts": dict(
                db.execute(
                    """
                    SELECT variant, COUNT(*) FROM review_candidates
                    WHERE review_reason = '' GROUP BY variant
                    """
                ).fetchall()
            ),
            "adjudication_counts": dict(
                db.execute(
                    "SELECT decision, COUNT(*) FROM review_adjudications GROUP BY decision"
                ).fetchall()
            ),
        }
        print(json.dumps(payload, ensure_ascii=False), flush=True)
    finally:
        db.close()


def adjudicate(args) -> None:
    """Import visually checked decisions without changing training labels."""
    if args.decisions_file is None:
        raise ValueError("--decisions-file is required for --phase adjudicate")
    db = connect(args.output)
    decisions = []
    seen = set()
    with args.decisions_file.open("r", encoding="utf-8") as stream:
        for line_number, raw in enumerate(stream, start=1):
            if not raw.strip():
                continue
            item = json.loads(raw)
            formula_ids = item.get("ids", [item.get("id")])
            if not isinstance(formula_ids, list) or not formula_ids or any(
                not isinstance(value, str) or not value for value in formula_ids
            ):
                raise ValueError(f"invalid ids on line {line_number}")
            decision = item["decision"]
            latex = item.get("latex", "")
            method = item["method"]
            note = item.get("note", "")
            if decision not in {"accept_visual", "reject_nonformula", "unresolved"}:
                raise ValueError(f"invalid decision on line {line_number}: {decision}")
            if decision == "accept_visual" and not latex.strip():
                raise ValueError(f"missing LaTeX on line {line_number}")
            if decision in {"reject_nonformula", "unresolved"} and latex:
                raise ValueError(f"nonempty LaTeX for {decision} on line {line_number}")
            if not method.startswith("assistant_visual"):
                raise ValueError(f"unsupported review method on line {line_number}")
            for formula_id in formula_ids:
                if formula_id in seen:
                    raise ValueError(f"duplicate id on line {line_number}: {formula_id}")
                seen.add(formula_id)
                row = db.execute(
                    "SELECT label_status FROM labels WHERE id = ?", (formula_id,)
                ).fetchone()
                if row is None or row[0] != "needs_review":
                    raise ValueError(f"id not pending review on line {line_number}: {formula_id}")
                stored_decision = decision
                if decision == "accept_visual":
                    candidate = db.execute(
                        "SELECT latex FROM review_candidates WHERE id = ? AND variant = 'original_beam1'",
                        (formula_id,),
                    ).fetchone()
                    stored_decision = (
                        "verified" if candidate is not None and canonical_latex(candidate[0]) == canonical_latex(latex)
                        else "corrected"
                    )
                previous = db.execute(
                    "SELECT decision, latex, method, note FROM review_adjudications WHERE id = ?",
                    (formula_id,),
                ).fetchone()
                fields = (stored_decision, latex, method, note)
                if previous is not None and previous != fields:
                    raise ValueError(f"conflicting prior decision for {formula_id}")
                decisions.append((formula_id, *fields))
    with db:
        db.executemany(
            """
            INSERT OR IGNORE INTO review_adjudications
                (id, decision, latex, method, note)
            VALUES (?, ?, ?, ?, ?)
            """,
            decisions,
        )
    print(f"ADJUDICATE checked={len(decisions)} total={db.execute('SELECT COUNT(*) FROM review_adjudications').fetchone()[0]}")
    db.close()


def make_sheets(args) -> None:
    root = args.output
    db = connect(root)
    try:
        reason_clause = ""
        parameters: list[object] = [args.variant]
        if args.reason_like:
            reason_clause = "AND l.review_reason LIKE ?"
            parameters.append(f"%{args.reason_like}%")
        rows = db.execute(
            f"""
            SELECT f.id, f.image, f.detection_confidence, f.width, f.height,
                   l.latex, l.review_reason, c.latex, c.review_reason
            FROM review_candidates AS c
            JOIN formulas AS f ON f.id = c.id
            JOIN labels AS l ON l.id = c.id
            WHERE c.variant = ? {reason_clause}
            ORDER BY f.source_id, f.page, f.id
            LIMIT ? OFFSET ?
            """,
            (*parameters, args.sheet_limit, args.sheet_offset),
        ).fetchall()
    finally:
        db.close()

    destination = root / "review_pass2" / "sheets" / args.variant
    destination.mkdir(parents=True, exist_ok=True)
    font_path = Path(r"C:\Windows\Fonts\consola.ttf")
    bold_path = Path(r"C:\Windows\Fonts\consolab.ttf")
    font = ImageFont.truetype(str(font_path), 18)
    small = ImageFont.truetype(str(font_path), 15)
    bold = ImageFont.truetype(str(bold_path), 18)
    columns, rows_per_sheet = 4, 5
    cell_width, cell_height = 700, 250
    per_sheet = columns * rows_per_sheet
    manifest_path = destination / (
        f"manifest_{args.sheet_offset:06d}_{args.sheet_offset + len(rows):06d}.csv"
    )
    with manifest_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "sheet",
                "cell",
                "id",
                "image",
                "detection_confidence",
                "current_latex",
                "current_reason",
                "candidate_latex",
                "candidate_reason",
            ]
        )
        for sheet_index in range(0, len(rows), per_sheet):
            chunk = rows[sheet_index : sheet_index + per_sheet]
            absolute_start = args.sheet_offset + sheet_index + 1
            sheet_name = f"sheet_{absolute_start:06d}_{absolute_start + len(chunk) - 1:06d}.png"
            canvas = Image.new(
                "RGB",
                (columns * cell_width, rows_per_sheet * cell_height),
                "white",
            )
            draw = ImageDraw.Draw(canvas)
            for local_index, row in enumerate(chunk):
                column = local_index % columns
                grid_row = local_index // columns
                x0, y0 = column * cell_width, grid_row * cell_height
                draw.rectangle(
                    (x0, y0, x0 + cell_width - 1, y0 + cell_height - 1),
                    outline=(150, 150, 150),
                    width=1,
                )
                formula_id, image, confidence, width, height = row[:5]
                current_latex, current_reason, candidate, candidate_reason = row[5:]
                draw.text(
                    (x0 + 8, y0 + 6),
                    f"{args.sheet_offset + sheet_index + local_index + 1}. {formula_id}",
                    fill="black",
                    font=bold,
                )
                draw.text(
                    (x0 + 8, y0 + 30),
                    f"det={confidence:.3f}  {width}x{height}  old={current_reason}",
                    fill=(70, 70, 70),
                    font=small,
                )
                with Image.open(root / image) as loaded:
                    crop = loaded.convert("RGB")
                    crop.thumbnail((cell_width - 24, 105), Image.Resampling.LANCZOS)
                    scale = min(
                        (cell_width - 24) / max(crop.width, 1),
                        105 / max(crop.height, 1),
                        3.0,
                    )
                    if scale > 1.0:
                        crop = crop.resize(
                            (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
                            Image.Resampling.NEAREST,
                        )
                    image_x = x0 + (cell_width - crop.width) // 2
                    image_y = y0 + 55 + (105 - crop.height) // 2
                    canvas.paste(crop, (image_x, image_y))
                candidate_lines = textwrap.wrap(
                    candidate.replace("\n", " "), width=78, break_long_words=True
                )[:3]
                draw.text(
                    (x0 + 8, y0 + 166),
                    "NEW: " + (candidate_lines[0] if candidate_lines else ""),
                    fill=(0, 70, 150) if not candidate_reason else (170, 40, 40),
                    font=font,
                )
                for line_index, line in enumerate(candidate_lines[1:], start=1):
                    draw.text(
                        (x0 + 8, y0 + 166 + 22 * line_index),
                        "     " + line,
                        fill=(0, 70, 150) if not candidate_reason else (170, 40, 40),
                        font=font,
                    )
                if candidate_reason:
                    draw.text(
                        (x0 + 8, y0 + 232),
                        "new reason=" + candidate_reason,
                        fill=(170, 40, 40),
                        font=small,
                    )
                writer.writerow(
                    [
                        sheet_name,
                        local_index + 1,
                        formula_id,
                        image,
                        confidence,
                        current_latex,
                        current_reason,
                        candidate,
                        candidate_reason,
                    ]
                )
            canvas.save(destination / sheet_name, format="PNG", compress_level=1)
    print(
        json.dumps(
            {
                "variant": args.variant,
                "rows": len(rows),
                "sheets": (len(rows) + per_sheet - 1) // per_sheet,
                "directory": str(destination),
                "manifest": str(manifest_path),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def _bits_to_hex(bits: np.ndarray) -> str:
    value = 0
    for bit in bits.astype(bool).flat:
        value = (value << 1) | int(bit)
    width = (bits.size + 3) // 4
    return f"{value:0{width}x}"


def image_fingerprint(item):
    formula_id, path = item
    with Image.open(path) as loaded:
        image = ImageOps.grayscale(loaded)
        array = np.asarray(image)
    mask = array < 245
    if not mask.any():
        return formula_id, "empty", "0" * 16, "0" * 16, 0, 0
    ys, xs = np.nonzero(mask)
    cropped = image.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    width, height = cropped.size
    aspect_bucket = round(24 * width / max(height, 1))
    ink_bucket = round(40 * float(mask.mean()))

    normalized_height = 64
    normalized_width = max(1, round(width * normalized_height / max(height, 1)))
    binary_image = cropped.resize(
        (normalized_width, normalized_height), Image.Resampling.LANCZOS
    )
    binary_array = np.asarray(binary_image) < 200
    packed = np.packbits(binary_array, axis=None).tobytes()
    binary_hash = hashlib.sha1(
        normalized_width.to_bytes(2, "big") + packed
    ).hexdigest()

    canvas = Image.new("L", (96, 96), 255)
    scale = min(88 / max(width, 1), 88 / max(height, 1))
    fitted = cropped.resize(
        (max(1, round(width * scale)), max(1, round(height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas.paste(fitted, ((96 - fitted.width) // 2, (96 - fitted.height) // 2))
    square = 255.0 - np.asarray(canvas.resize((32, 32), Image.Resampling.LANCZOS), dtype=np.float32)
    transformed = dct(dct(square, axis=0, norm="ortho"), axis=1, norm="ortho")
    low = transformed[:8, :8]
    perceptual_hash = _bits_to_hex(low > np.median(low[1:, :]))
    difference = np.asarray(canvas.resize((9, 8), Image.Resampling.LANCZOS))
    difference_hash = _bits_to_hex(difference[:, 1:] < difference[:, :-1])
    return (
        formula_id,
        binary_hash,
        perceptual_hash,
        difference_hash,
        aspect_bucket,
        ink_bucket,
    )


def fingerprint(args) -> None:
    root = args.output
    db = connect(root)
    conditions = ["fp.id IS NULL"]
    parameters: list[object] = []
    if args.fingerprint_scope == "pending":
        conditions.append("l.label_status = 'needs_review'")
    elif args.fingerprint_scope == "accepted":
        conditions.append("l.label_status = 'accepted'")
    if args.source_start:
        conditions.append("f.source_id >= ?")
        parameters.append(f"source_{args.source_start:03d}")
    if args.source_end:
        conditions.append("f.source_id <= ?")
        parameters.append(f"source_{args.source_end:03d}")
    where = " AND ".join(conditions)
    processed = 0
    started = time.perf_counter()
    try:
        while not args.max_items or processed < args.max_items:
            limit = 500
            if args.max_items:
                limit = min(limit, args.max_items - processed)
            rows = db.execute(
                f"""
                SELECT f.id, f.image
                FROM formulas AS f
                JOIN labels AS l ON l.id = f.id
                LEFT JOIN review_fingerprints AS fp ON fp.id = f.id
                WHERE {where}
                ORDER BY f.source_id, f.page, f.id
                LIMIT ?
                """,
                (*parameters, limit),
            ).fetchall()
            if not rows:
                break
            work = [(formula_id, root / image) for formula_id, image in rows]
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                fingerprints = list(pool.map(image_fingerprint, work))
            with db:
                db.executemany(
                    """
                    INSERT OR REPLACE INTO review_fingerprints
                        (id, binary_hash, perceptual_hash, difference_hash,
                         aspect_bucket, ink_bucket)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    fingerprints,
                )
            processed += len(rows)
            elapsed = max(time.perf_counter() - started, 0.001)
            print(
                f"REVIEW_FINGERPRINT_PROGRESS scope={args.fingerprint_scope} "
                f"processed={processed} rate={processed / elapsed:.2f}/s "
                f"last={rows[-1][0]}",
                flush=True,
            )
    finally:
        db.close()
    print(
        f"REVIEW_FINGERPRINT_COMPLETE scope={args.fingerprint_scope} processed={processed}",
        flush=True,
    )


def canonical_latex(value: str) -> str:
    return re.sub(r"\s+", "", value or "")


def propose(args) -> None:
    root = args.output
    db = connect(root)
    try:
        pending_rows = db.execute(
            """
            SELECT p.id, pf.source_id, fp.binary_hash, fp.perceptual_hash,
                   fp.difference_hash, fp.aspect_bucket, c.latex, c.review_reason
            FROM labels AS p
            JOIN formulas AS pf ON pf.id = p.id
            JOIN review_fingerprints AS fp ON fp.id = p.id
            LEFT JOIN review_candidates AS c
              ON c.id = p.id AND c.variant = 'original_beam1'
            WHERE p.label_status = 'needs_review'
            ORDER BY pf.source_id, pf.page, p.id
            """
        ).fetchall()
        binary_groups: dict[tuple[str, str], list[tuple[str, str]]] = defaultdict(list)
        perceptual_groups: dict[tuple[str, str, str, int], list[tuple[str, str]]] = defaultdict(list)
        accepted_rows = db.execute(
            """
            SELECT f.source_id, fp.binary_hash, fp.perceptual_hash,
                   fp.difference_hash, fp.aspect_bucket, l.id, l.latex
            FROM labels AS l
            JOIN formulas AS f ON f.id = l.id
            JOIN review_fingerprints AS fp ON fp.id = l.id
            WHERE l.label_status = 'accepted'
            """
        )
        for source_id, binary_hash, phash, dhash, aspect, formula_id, latex in accepted_rows:
            binary_groups[(source_id, binary_hash)].append((formula_id, latex))
            perceptual_groups[(source_id, phash, dhash, aspect)].append(
                (formula_id, latex)
            )

        proposals = []
        method_counts = Counter()
        for (
            formula_id,
            source_id,
            binary_hash,
            phash,
            dhash,
            aspect,
            candidate,
            candidate_reason,
        ) in pending_rows:
            exact_matches = binary_groups.get((source_id, binary_hash), [])
            visual_matches = perceptual_groups.get((source_id, phash, dhash, aspect), [])
            selected = []
            method = ""
            if exact_matches:
                selected = exact_matches
                method = "same_source_binary_hash_consensus"
            elif len(visual_matches) >= 3:
                selected = visual_matches
                method = "same_source_perceptual_hash_consensus"
            if not selected:
                continue
            counts = Counter(canonical_latex(latex) for _, latex in selected)
            canonical, count = counts.most_common(1)[0]
            share = count / len(selected)
            if not canonical:
                continue
            if method.startswith("same_source_binary"):
                required_share = 1.0 if len(selected) < 3 else 0.9
            else:
                required_share = 1.0
            if share < required_share:
                continue
            chosen_latex = next(
                latex for _, latex in selected if canonical_latex(latex) == canonical
            )
            if review_reasons(chosen_latex, 1.0):
                continue
            candidate_match = bool(candidate) and not candidate_reason and (
                canonical_latex(candidate) == canonical
            )
            if method.startswith("same_source_perceptual") and not candidate_match:
                continue
            note = (
                f"accepted_matches={len(selected)};top_count={count};share={share:.3f};"
                f"candidate_match={int(candidate_match)};"
                f"representatives={','.join(item[0] for item in selected[:5])}"
            )
            proposals.append(
                (
                    formula_id,
                    "proposed_accept",
                    chosen_latex,
                    method,
                    note,
                )
            )
            method_counts[method] += 1
        with db:
            db.executemany(
                """
                INSERT OR IGNORE INTO review_adjudications
                    (id, decision, latex, method, note, created_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                proposals,
            )
        print(
            json.dumps(
                {
                    "pending_with_fingerprints": len(pending_rows),
                    "proposals": len(proposals),
                    "methods": dict(method_counts),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    finally:
        db.close()


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--phase",
        choices=["recognize", "stats", "sheet", "fingerprint", "propose", "adjudicate"],
        required=True,
    )
    parser.add_argument(
        "--variant",
        choices=[
            "original_beam1",
            "original_beam3",
            "padded_beam1",
            "padded_beam3",
            "contrast_beam1",
            "contrast_beam3",
        ],
        default="original_beam1",
    )
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-items", type=int, default=0)
    parser.add_argument("--reason-like", default="")
    parser.add_argument("--source-start", type=int, default=0)
    parser.add_argument("--source-end", type=int, default=0)
    parser.add_argument("--sheet-limit", type=int, default=100)
    parser.add_argument("--sheet-offset", type=int, default=0)
    parser.add_argument(
        "--fingerprint-scope",
        choices=["pending", "accepted", "all"],
        default="pending",
    )
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--decisions-file", type=Path)
    args = parser.parse_args()
    if args.phase == "recognize":
        recognize(args)
    elif args.phase == "stats":
        stats(args)
    elif args.phase == "sheet":
        make_sheets(args)
    elif args.phase == "fingerprint":
        fingerprint(args)
    elif args.phase == "adjudicate":
        adjudicate(args)
    else:
        propose(args)


if __name__ == "__main__":
    main()
