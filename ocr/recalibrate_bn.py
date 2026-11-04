"""对训练好的检查点重估卷积层 BatchNorm 的滑动统计（权重不动），另存一份供 export_scratch 导出。

做法与 train_scratch --bn-recalibration-images 相同（见 train_scratch.recalibrate_batchnorm）：
按固定种子从训练清单抽不增强的图，用累积平均重算 running_mean / running_var。抽图只取决于
清单和种子，重跑结果一致。清单须是训练这个模型用的那份（SHA-256 与检查点 provenance 一致），
图片路径默认相对清单所在目录，图片放在别处时用 --image-root 指定。做法写进 provenance，
随导出包的 metadata.json 一起走。

    python -m ocr.recalibrate_bn --checkpoint last.pt --train-manifest train.jsonl --output last-bn.pt
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import torch
from torch.utils.data import DataLoader

try:
    from .scratch_model import OCRConfig, ScratchFormulaOCR, TeXTokenizer
    from .train_scratch import (BN_BUFFER_SUFFIXES, BN_RECALIBRATION_BATCH, BN_RECALIBRATION_IMAGES,
                                BN_RECALIBRATION_SEED, RecalibrationImages, _save_checkpoint,
                                bn_recalibration_provenance, recalibrate_batchnorm, select_recalibration_records)
except ImportError:
    from scratch_model import OCRConfig, ScratchFormulaOCR, TeXTokenizer
    from train_scratch import (BN_BUFFER_SUFFIXES, BN_RECALIBRATION_BATCH, BN_RECALIBRATION_IMAGES,
                               BN_RECALIBRATION_SEED, RecalibrationImages, _save_checkpoint,
                               bn_recalibration_provenance, recalibrate_batchnorm, select_recalibration_records)


def recalibrate_checkpoint(checkpoint_path: Path, manifest_path: Path, output_path: Path, *,
                           image_root: Path | None = None, images: int = BN_RECALIBRATION_IMAGES,
                           seed: int = BN_RECALIBRATION_SEED, device: str = "cpu") -> dict:
    if output_path.resolve() == checkpoint_path.resolve():
        raise ValueError("Write the recalibrated checkpoint to a new file; the original stays as trained")
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    if checkpoint.get("format_version") != 1:
        raise ValueError("Unsupported checkpoint format")
    provenance = checkpoint.get("provenance", {})
    manifest_bytes = manifest_path.read_bytes()
    manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
    if manifest_sha256 != provenance.get("train_manifest_sha256"):
        raise ValueError("Manifest is not the one this checkpoint was trained on (train_manifest_sha256 differs)")
    # 与 train_scratch.read_manifest 同样按换行符逐行读、跳过空行，抽到的行与训练中重估时一致；
    # 不用 splitlines()，它还会在 U+2028 之类的字符处断行
    rows = [json.loads(line) for line in manifest_bytes.decode("utf-8").split("\n") if line.strip()]
    root = (image_root or manifest_path.parent).resolve()
    picked = [{**row, "image_path": str((root / row["image"]).resolve())}
              for row in select_recalibration_records(rows, images, seed)]
    missing = [row["image_path"] for row in picked if not Path(row["image_path"]).is_file()]
    if missing:
        raise ValueError(f"{len(missing)} recalibration images do not exist, e.g. {missing[0]}")

    config = OCRConfig.from_dict(checkpoint["config"])
    model = ScratchFormulaOCR(config, len(TeXTokenizer.from_dict(checkpoint["tokenizer"])))
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    target = torch.device(device)
    model.to(target)
    loader = DataLoader(RecalibrationImages(picked, config), batch_size=BN_RECALIBRATION_BATCH, shuffle=False)
    seen = recalibrate_batchnorm(model, loader, target)

    before = checkpoint["state_dict"]
    after = {name: value.detach().cpu() for name, value in model.state_dict().items()}
    changed = [name for name, value in after.items() if not torch.equal(value, before[name])]
    unexpected = [name for name in changed if not name.endswith(BN_BUFFER_SUFFIXES)]
    if unexpected:
        raise RuntimeError(f"Recalibration changed tensors other than BatchNorm statistics: {unexpected}")
    checkpoint["state_dict"] = after
    checkpoint["provenance"] = {**provenance, "bn_recalibration": bn_recalibration_provenance(seen, seed, "after training")}
    _save_checkpoint(output_path, checkpoint)
    return {"output": str(output_path), "images": seen, "seed": seed, "changed_buffers": len(changed),
            "train_manifest_sha256": manifest_sha256}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--train-manifest", type=Path, required=True, help="训练这个模型用的清单")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--image-root", type=Path, default=None, help="图片路径的基准目录，默认是清单所在目录")
    parser.add_argument("--images", type=int, default=BN_RECALIBRATION_IMAGES)
    parser.add_argument("--seed", type=int, default=BN_RECALIBRATION_SEED)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args(argv)
    if args.threads > 0:
        torch.set_num_threads(args.threads)
    result = recalibrate_checkpoint(args.checkpoint, args.train_manifest, args.output, image_root=args.image_root,
                                    images=args.images, seed=args.seed, device=args.device)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
