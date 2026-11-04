"""Mix authored formulas and verified PDF crops without crossing split boundaries.

Only presentation commands are removed from targets. No algebraic equivalence
or guessed OCR output is used. Original transcriptions remain in source_latex.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import random
import re

TOKEN = re.compile(r"\\(?:begin|end)\{[a-zA-Z*]+\}|\\[A-Za-z]+|\\.|.", re.DOTALL)
LAYOUT = {r"\left", r"\right", r"\displaystyle", r"\textstyle", r"\,", r"\!", r"\;", r"\:", "\\ ", r"\quad", r"\qquad"}


def tokens(text):
    return [t for t in TOKEN.findall(text) if not t.isspace()]


def normalize_label(text):
    original = tokens(text)
    retained = []
    skip_dot = False
    for token in original:
        if skip_dot and token == ".":
            skip_dot = False
            continue
        skip_dot = token in {r"\left", r"\right"}
        if token not in LAYOUT:
            retained.append(token)
    result = []
    for index, token in enumerate(retained):
        if index and re.fullmatch(r"\\[A-Za-z]+", retained[index - 1]) and re.match(r"[A-Za-z]", token):
            result.append(" ")
        result.append(token)
    return "".join(result)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare(synthetic, symbols, pdf, output, repeats=32, seed=9152026, max_tokens=160):
    output = output.resolve()
    if output.exists():
        raise FileExistsError("Choose a new mixture directory")
    if repeats < 1 or max_tokens < 3:
        raise ValueError("Invalid repetition count or token limit")
    for root, marker in [(synthetic, "data-manifest.json"), (symbols, "data-manifest.json"), (pdf, "import-report.json")]:
        if not (root / marker).is_file():
            raise ValueError(f"Source dataset is incomplete: {root}")
    rejected = []
    source_manifests = {}

    def read(root, name, kind):
        path = root / name
        source_manifests[str(path)] = sha(path)
        records = []
        for row in map(json.loads, path.read_text(encoding="utf-8").splitlines()):
            image = (root / row["image"]).resolve()
            if kind == "supplied-pdf" and row.get("review_status") != "visual-verified":
                raise ValueError("Unverified PDF label in imported manifest")
            normalized = normalize_label(row["latex"])
            if len(tokens(normalized)) + 2 > max_tokens:
                rejected.append({"id": row["id"], "source_kind": kind, "reason": "token_limit"})
                continue
            records.append({**row, "id": f"{kind}:{row['id']}", "source_latex": row["latex"], "latex": normalized,
                            "image": Path(os.path.relpath(image, output)).as_posix(), "source_kind": kind,
                            "image_sha256": sha(image)})
        return records

    groups = {
        "pdf-test": read(pdf, "test.jsonl", "supplied-pdf"),
        "pdf-validation": read(pdf, "validation.jsonl", "supplied-pdf"),
        "challenge": read(synthetic, "challenge.jsonl", "authored-recursive"),
        "synthetic-test": read(synthetic, "test.jsonl", "authored-recursive"),
        "synthetic-validation": read(synthetic, "validation.jsonl", "authored-recursive"),
    }
    reserved_labels, reserved_images = set(), set()
    for name, rows in groups.items():
        kept = []
        for row in rows:
            label = tuple(tokens(row["latex"]))
            if label in reserved_labels or row["image_sha256"] in reserved_images:
                rejected.append({"id": row["id"], "group": name, "reason": "evaluation_overlap_after_normalization"})
                continue
            kept.append(row)
            reserved_labels.add(label)
            reserved_images.add(row["image_sha256"])
        groups[name] = kept

    training = []
    unique_counts = Counter()
    for root, kind, repeat in [(synthetic, "authored-recursive", 1), (symbols, "authored-symbol-coverage", 1), (pdf, "supplied-pdf", repeats)]:
        for row in read(root, "train.jsonl", kind):
            if tuple(tokens(row["latex"])) in reserved_labels or row["image_sha256"] in reserved_images:
                rejected.append({"id": row["id"], "reason": "training_overlaps_reserved_evaluation"})
                continue
            unique_counts[kind] += 1
            for repeat_index in range(repeat):
                training.append({**row, "id": f"{row['id']}:{repeat_index}", "repeat_index": repeat_index, "split": "train"})
    random.Random(seed).shuffle(training)
    vocabulary = {token for row in training for token in tokens(row["latex"])}
    missing = {name: sorted({token for row in rows for token in tokens(row["latex"])} - vocabulary) for name, rows in groups.items()}
    if missing["pdf-validation"] or missing["synthetic-validation"]:
        raise ValueError(f"Validation contains unsupported tokens: {missing}; add independent training coverage, never infer a tokenizer from evaluation labels")
    groups["train"] = training
    groups["validation"] = groups["pdf-validation"] + groups["synthetic-validation"]
    groups["test"] = groups["pdf-test"] + groups["synthetic-test"]
    output.mkdir(parents=True)
    manifests = {}
    for name, rows in groups.items():
        path = output / f"{name}.jsonl"
        path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        manifests[name] = {"samples": len(rows), "sha256": sha(path)}
    report = {"source_manifests": source_manifests, "manifests": manifests, "seed": seed,
              "training_unique_source_images": dict(unique_counts), "training_rows_including_repetitions": len(training),
              "pdf_training_repetitions": repeats, "training_lexical_vocabulary_size": len(vocabulary),
              "evaluation_tokens_missing_from_training": missing, "rejected": rejected,
              "label_normalization": "Remove only TeX delimiter-sizing/style/spacing commands; retain delimiters, operators, scripts, environments and punctuation. No algebraic rewriting.",
              "split_policy": "Evaluation labels and exact PNG hashes reserved before adopting any training row. Verified PDF input additionally enforces page/source separation. Training repetition never crosses a split.",
              "scope": "PDF labels are assistant visual transcriptions; source PDFs and crops remain local. Small PDF holdouts are diagnostic, not a representative production benchmark."}
    (output / "mixture-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--synthetic", type=Path, required=True)
    parser.add_argument("--symbols", type=Path, required=True)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pdf-repeats", type=int, default=32)
    args = parser.parse_args()
    report = prepare(args.synthetic, args.symbols, args.pdf, args.output, repeats=args.pdf_repeats)
    print(json.dumps({k: v for k, v in report.items() if k not in ("rejected", "source_manifests")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
