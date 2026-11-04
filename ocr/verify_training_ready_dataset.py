import argparse
import json
import re
from pathlib import Path


CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def inspect_jsonl(path: Path, root: Path, check_images: bool) -> dict:
    ids: set[str] = set()
    duplicate_ids: list[str] = []
    missing_images: list[str] = []
    empty_latex: list[str] = []
    cjk_latex: list[str] = []
    control_latex: list[str] = []
    needs_review_status: list[str] = []
    count = 0
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            row = json.loads(line)
            formula_id = row["id"]
            count += 1
            if formula_id in ids and len(duplicate_ids) < 20:
                duplicate_ids.append(formula_id)
            ids.add(formula_id)
            latex = row.get("latex", "")
            if not latex.strip() and len(empty_latex) < 20:
                empty_latex.append(formula_id)
            if CJK_RE.search(latex) and len(cjk_latex) < 20:
                cjk_latex.append(formula_id)
            if any(ord(character) < 32 for character in latex) and len(control_latex) < 20:
                control_latex.append(formula_id)
            if row.get("verification_status") == "needs_review" and len(needs_review_status) < 20:
                needs_review_status.append(formula_id)
            if check_images and not (root / row["image"]).is_file() and len(missing_images) < 20:
                missing_images.append(f"{line_number}:{formula_id}:{row['image']}")
    return {
        "count": count,
        "ids": ids,
        "duplicate_ids": duplicate_ids,
        "missing_images": missing_images,
        "empty_latex": empty_latex,
        "cjk_latex": cjk_latex,
        "control_latex": control_latex,
        "needs_review_status": needs_review_status,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    root = args.root

    all_result = inspect_jsonl(root / "all.jsonl", root, True)
    train_result = inspect_jsonl(root / "train.jsonl", root, False)
    val_result = inspect_jsonl(root / "val.jsonl", root, False)
    review_result = inspect_jsonl(root / "review_needed.jsonl", root, False)

    train_ids = train_result.pop("ids")
    val_ids = val_result.pop("ids")
    all_ids = all_result.pop("ids")
    review_ids = review_result.pop("ids")
    errors = {
        "train_val_overlap": len(train_ids & val_ids),
        "all_union_difference": len(all_ids ^ (train_ids | val_ids)),
        "formal_review_overlap": len(all_ids & review_ids),
    }
    detail_fields = (
        "duplicate_ids",
        "missing_images",
        "empty_latex",
        "cjk_latex",
        "control_latex",
        "needs_review_status",
    )
    for name, result in (
        ("all", all_result),
        ("train", train_result),
        ("val", val_result),
    ):
        for field in detail_fields:
            errors[f"{name}_{field}"] = result[field]

    info = json.loads((root / "dataset_info.json").read_text(encoding="utf-8"))
    report = {
        "passed": not any(bool(value) for value in errors.values())
        and all_result["count"] == info["accepted_labeled_formulas"]
        and train_result["count"] == info["train_count"]
        and val_result["count"] == info["val_count"]
        and review_result["count"] == info["review_needed_count"],
        "counts": {
            "all": all_result["count"],
            "train": train_result["count"],
            "val": val_result["count"],
            "review_excluded": review_result["count"],
        },
        "dataset_info_counts_match": {
            "all": all_result["count"] == info["accepted_labeled_formulas"],
            "train": train_result["count"] == info["train_count"],
            "val": val_result["count"] == info["val_count"],
            "review": review_result["count"] == info["review_needed_count"],
        },
        "errors": errors,
        "model_training_performed": info.get("model_training_performed"),
    }
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    print(output, end="")
    if args.report:
        args.report.write_text(output, encoding="utf-8")
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
