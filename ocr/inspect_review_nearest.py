from __future__ import annotations

import argparse
import csv
import json
import sqlite3
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(r"T:\pure_formula_dataset"))
    parser.add_argument("--source", default="source_001")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()

    db = sqlite3.connect(args.output / "dataset.sqlite", timeout=60)
    accepted = db.execute(
        """
        SELECT f.id, f.image, l.latex, fp.perceptual_hash,
               fp.difference_hash, fp.aspect_bucket
        FROM review_fingerprints AS fp
        JOIN formulas AS f ON f.id = fp.id
        JOIN labels AS l ON l.id = fp.id
        WHERE f.source_id = ? AND l.label_status = 'accepted'
        ORDER BY f.id
        """,
        (args.source,),
    ).fetchall()
    pending = db.execute(
        """
        SELECT f.id, f.image, l.latex, l.review_reason,
               fp.perceptual_hash, fp.difference_hash, fp.aspect_bucket,
               COALESCE(c.latex, ''), COALESCE(c.review_reason, '')
        FROM review_fingerprints AS fp
        JOIN formulas AS f ON f.id = fp.id
        JOIN labels AS l ON l.id = fp.id
        LEFT JOIN review_candidates AS c
          ON c.id = fp.id AND c.variant = 'original_beam1'
        WHERE f.source_id = ? AND l.label_status = 'needs_review'
        ORDER BY f.id LIMIT ? OFFSET ?
        """,
        (args.source, args.limit, args.offset),
    ).fetchall()
    db.close()

    if not accepted:
        raise RuntimeError(f"No indexed accepted samples in {args.source}")
    accepted_phash = np.array([int(row[3], 16) for row in accepted], dtype=np.uint64)
    accepted_dhash = np.array([int(row[4], 16) for row in accepted], dtype=np.uint64)
    accepted_aspect = np.array([row[5] for row in accepted], dtype=np.int32)
    results = []
    for row in pending:
        aspect = row[6]
        eligible = np.flatnonzero(np.abs(accepted_aspect - aspect) <= 2)
        if len(eligible) < 3:
            eligible = np.arange(len(accepted))
        pd = np.bitwise_count(accepted_phash[eligible] ^ np.uint64(int(row[4], 16)))
        dd = np.bitwise_count(accepted_dhash[eligible] ^ np.uint64(int(row[5], 16)))
        score = pd.astype(np.int16) * 2 + dd.astype(np.int16)
        score += np.abs(accepted_aspect[eligible] - aspect).astype(np.int16) * 4
        best_local = np.argsort(score, kind="stable")[:3]
        neighbors = []
        for position in best_local:
            index = int(eligible[position])
            neighbors.append(
                {
                    "id": accepted[index][0],
                    "image": accepted[index][1],
                    "latex": accepted[index][2],
                    "phash_distance": int(pd[position]),
                    "dhash_distance": int(dd[position]),
                    "aspect_difference": int(abs(accepted_aspect[index] - aspect)),
                    "score": int(score[position]),
                }
            )
        results.append(
            {
                "id": row[0],
                "image": row[1],
                "old_latex": row[2],
                "old_reason": row[3],
                "candidate_latex": row[7],
                "candidate_reason": row[8],
                "neighbors": neighbors,
            }
        )

    destination = args.output / "review_pass2" / "nearest" / args.source
    destination.mkdir(parents=True, exist_ok=True)
    suffix = f"{args.offset:06d}_{args.offset + len(results):06d}"
    json_path = destination / f"nearest_{suffix}.json"
    json_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    csv_path = destination / f"nearest_{suffix}.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "id", "image", "candidate_latex", "candidate_reason",
                "nearest_id", "nearest_latex", "phash_distance",
                "dhash_distance", "aspect_difference", "score",
            ]
        )
        for item in results:
            neighbor = item["neighbors"][0]
            writer.writerow(
                [
                    item["id"], item["image"], item["candidate_latex"],
                    item["candidate_reason"], neighbor["id"], neighbor["latex"],
                    neighbor["phash_distance"], neighbor["dhash_distance"],
                    neighbor["aspect_difference"], neighbor["score"],
                ]
            )

    font = ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", 17)
    bold = ImageFont.truetype(r"C:\Windows\Fonts\consolab.ttf", 17)
    cell_width, cell_height, columns, rows_per_sheet = 680, 290, 3, 4
    for start in range(0, len(results), columns * rows_per_sheet):
        chunk = results[start : start + columns * rows_per_sheet]
        canvas = Image.new("RGB", (cell_width * columns, cell_height * rows_per_sheet), "white")
        draw = ImageDraw.Draw(canvas)
        for local_index, item in enumerate(chunk):
            left = (local_index % columns) * cell_width
            top = (local_index // columns) * cell_height
            draw.rectangle(
                (left, top, left + cell_width - 1, top + cell_height - 1),
                outline=(160, 160, 160), width=1,
            )
            draw.text((left + 8, top + 5), item["id"], font=bold, fill="black")
            draw.text(
                (left + 8, top + 27),
                "candidate: " + item["candidate_latex"][:70],
                font=font, fill=(0, 70, 150),
            )
            neighbor = item["neighbors"][0]
            draw.text(
                (left + 8, top + 145),
                "nearest: " + neighbor["id"] + f"  p={neighbor['phash_distance']} d={neighbor['dhash_distance']}",
                font=font, fill=(90, 90, 90),
            )
            draw.text(
                (left + 8, top + 168),
                "label: " + neighbor["latex"][:70],
                font=font, fill=(120, 70, 0),
            )
            for relative_image, ybase in ((item["image"], 53), (neighbor["image"], 194)):
                with Image.open(args.output / relative_image) as loaded:
                    crop = loaded.convert("RGB")
                    crop.thumbnail((cell_width - 30, 85), Image.Resampling.LANCZOS)
                    scale = min(3.0, (cell_width - 30) / crop.width, 85 / crop.height)
                    if scale > 1:
                        crop = crop.resize(
                            (max(1, round(crop.width * scale)), max(1, round(crop.height * scale))),
                            Image.Resampling.NEAREST,
                        )
                    canvas.paste(crop, (left + (cell_width - crop.width) // 2, top + ybase))
        first = args.offset + start + 1
        last = first + len(chunk) - 1
        canvas.save(destination / f"pairs_{first:06d}_{last:06d}.png", compress_level=1)

    stats = {
        "source": args.source,
        "accepted_indexed": len(accepted),
        "pending_inspected": len(results),
        "nearest_phash_distance": dict(
            Counter(item["neighbors"][0]["phash_distance"] for item in results)
        ),
        "candidate_equals_nearest_label": sum(
            item["candidate_latex"].replace(" ", "")
            == item["neighbors"][0]["latex"].replace(" ", "")
            for item in results
        ),
        "json": str(json_path),
        "csv": str(csv_path),
        "sheets": (len(results) + columns * rows_per_sheet - 1) // (columns * rows_per_sheet),
    }
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
