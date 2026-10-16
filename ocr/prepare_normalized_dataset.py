"""在 TexTeller 数据集的基础上生成「统一写法」版本的清单与 Colab 补充包。

  python ocr/prepare_normalized_dataset.py --base-zip texteller-dataset.zip \\
      --dataset-root pure_formula_dataset --splits-dir pure_formula_dataset/splits-page-isolated \\
      --output-dir OUT

依次做五件事：

1. 用 normalize_labels 改写训练、验证、测试三份清单的标签，原标签留在 latex_texteller。
2. 找回当初因超过 158 个词法单元被丢掉、去掉看不见的记号后能放下的样本。只收落在训练页
   上、不在人工真值保留页上、不含中文、不像识别器重复生成的死循环、且图片内容和标签都不与
   验证集或测试集重复的。
3. 用严格 MathJax 渲染校验全部改写过的标签和找回的样本（与当初过滤数据集的是同一个渲染器）：
   改写后渲染失败的退回原标签，找回的样本渲染失败就不要。
4. 重新生成早停子集：验证集中标签不在训练集出现、且 token 全在训练词表内的样本。
5. 写出 report.json，把四份清单、report.json 和找回样本的图片打成补充包。补充包解压到
   基础数据集旁边即可，清单里的图片路径与基础包一致。
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

try:
    from .normalize_labels import VERSION, detokenize, normalize_label, tokenize
except ImportError:
    from normalize_labels import VERSION, detokenize, normalize_label, tokenize

CJK = re.compile(r"[㐀-鿿]")
BOOK_TAG = re.compile(r"【[^】]*】")
SPLITS = ("train", "validation", "test")


def page_key(row: dict) -> tuple[str, int]:
    """与划分时相同的分组键：去掉【教材】【习题集】等标签后的书名 + 页码。"""
    return BOOK_TAG.sub("", row["book"]).strip(), int(row["page"])


def is_loop(tokens: list[str], width: int = 8, repeats: int = 4) -> bool:
    """识别器的死循环会把同一段 token 重复很多遍。"""
    grams = Counter(tuple(tokens[i:i + width]) for i in range(max(0, len(tokens) - width + 1)))
    return bool(grams) and grams.most_common(1)[0][1] >= repeats


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def render_failures(rows: list[dict], work: Path, repo: Path) -> dict[str, str]:
    """返回 {id: 失败原因}。"""
    manifest, verdicts = work / "render-check.jsonl", work / "render-check-verdicts.jsonl"
    write_jsonl(manifest, [{"id": row["id"], "latex": row["latex"]} for row in rows])
    subprocess.run(["node", str(repo / "ocr" / "validate-labels.mjs"), str(manifest), str(verdicts)],
                   check=True, cwd=repo)
    return {v["id"]: v.get("reason", "") for v in read_jsonl(verdicts) if not v["ok"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-zip", type=Path, required=True)
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--splits-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--max-tokens", type=int, default=158, help="不含 BOS/EOS 的词法单元上限，与训练配置一致")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    out = args.output_dir
    out.mkdir(parents=True, exist_ok=True)
    report: dict = {"version": VERSION, "max_tokens": args.max_tokens}

    # 1. 改写三个分区
    with zipfile.ZipFile(args.base_zip) as archive:
        base = {split: [json.loads(line) for line in archive.read(f"{split}.jsonl").decode("utf-8").splitlines()
                        if line.strip()] for split in SPLITS}
    data: dict[str, list[dict]] = {}
    changed: set[str] = set()
    tokens_before = tokens_after = 0
    for split in SPLITS:
        rows = []
        for row in base[split]:
            original = row["latex"]
            normalized = normalize_label(original)
            if normalized != detokenize(tokenize(original)):
                changed.add(row["id"])
            if split == "train":
                tokens_before += len(tokenize(original))
                tokens_after += len(tokenize(normalized))
            rows.append({**row, "latex": normalized, "latex_texteller": original})
        data[split] = rows
    report["rows"] = {split: len(rows) for split, rows in data.items()}
    report["changed"] = {split: sum(row["id"] in changed for row in rows) for split, rows in data.items()}
    report["train_tokens"] = {"before": tokens_before, "after": tokens_after}

    # 2. 找回超长样本
    split_of: dict[tuple[str, int], str] = {}
    for split in SPLITS:
        for row in read_jsonl(args.splits_dir / f"{split}.jsonl"):
            split_of[page_key(row)] = split
    reserved = {page_key(row) for row in read_jsonl(args.splits_dir / "reserved-human-truth-pages.jsonl")}
    held_out_labels = {tuple(tokenize(row["latex"])) for split in ("validation", "test") for row in data[split]}
    held_out_images = {sha256(args.dataset_root / row["image"]) for split in ("validation", "test") for row in data[split]}
    why: Counter = Counter()
    candidates = []
    for row in read_jsonl(args.dataset_root / "all.jsonl"):
        if len(tokenize(row["latex"])) <= args.max_tokens:
            continue
        why["超长"] += 1
        key = page_key(row)
        if key in reserved or split_of.get(key) != "train":
            why["不在训练页"] += 1
            continue
        normalized = normalize_label(row["latex"])
        tokens = tokenize(normalized)
        image = args.dataset_root / row["image"]
        if len(tokens) > args.max_tokens:
            why["统一后仍超长"] += 1
        elif CJK.search(normalized):
            why["含中文"] += 1
        elif is_loop(tokens):
            why["重复死循环"] += 1
        elif not image.is_file():
            why["缺图片"] += 1
        elif tuple(tokens) in held_out_labels:
            why["标签与验证或测试集重复"] += 1
        elif sha256(image) in held_out_images:
            why["图片与验证或测试集重复"] += 1
        else:
            candidates.append({"id": row["id"], "image": row["image"], "latex": normalized, "book": row["book"],
                               "page": row["page"], "split": "train", "latex_texteller": row["latex"],
                               "recovered": True})

    # 3. 严格渲染校验
    to_check = [row for split in SPLITS for row in data[split] if row["id"] in changed] + candidates
    failed = render_failures(to_check, out, repo)
    reverted = Counter()
    for split in SPLITS:
        for row in data[split]:
            if row["id"] in failed:
                row["latex"] = row["latex_texteller"]
                row["normalization_reverted"] = failed[row["id"]]
                reverted[split] += 1
    recovered = [row for row in candidates if row["id"] not in failed]
    why["渲染失败"] = len(candidates) - len(recovered)
    report["render_checked"] = len(to_check)
    report["reverted_to_texteller"] = dict(reverted)
    report["recovered"] = {"rows": len(recovered), "funnel": dict(why)}
    data["train"].extend(recovered)

    # 4. 早停子集
    train_labels = {tuple(tokenize(row["latex"])) for row in data["train"]}
    vocabulary = {token for labels in train_labels for token in labels}
    disjoint = [{**row, "split": "validation-disjoint"} for row in data["validation"]
                if tuple(tokenize(row["latex"])) not in train_labels and set(tokenize(row["latex"])) <= vocabulary]
    report["train_vocabulary"] = len(vocabulary)
    report["validation_disjoint"] = len(disjoint)

    # 5. 写出清单与补充包
    names = {"train": "train-norm.jsonl", "validation": "validation-norm.jsonl", "test": "test-norm.jsonl"}
    for split, name in names.items():
        write_jsonl(out / name, data[split])
    write_jsonl(out / "validation-disjoint-norm.jsonl", disjoint)
    manifests = [*names.values(), "validation-disjoint-norm.jsonl"]
    report["sha256"] = {name: sha256(out / name) for name in manifests}
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    addon = out / "texteller-norm-addon.zip"
    with zipfile.ZipFile(addon, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in [*manifests, "report.json"]:
            archive.write(out / name, name)
        for row in recovered:
            archive.write(args.dataset_root / row["image"], row["image"])
    report["addon"] = {"path": str(addon), "bytes": addon.stat().st_size}
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
