"""把 export_scratch.py 导出的 ONNX 模型包转成 ORT 格式模型包，给精简版 ONNX Runtime（--minimal_build）用。

精简版 ORT 只认 ORT 格式模型，也只含编进去的那些算子。这个脚本写出：
- encoder.ort / decoder.ort：转换设置与 onnxruntime.tools.convert_onnx_models_to_ort 的 Fixed 风格、
  --target_platform arm 相同（优化级别 all、不做 x86 专用的 NCHWc 布局、允许 QDQ 用 int8）。常量折叠照做：它会把
  编码器里按行表、列表存放的位置编码展开回一整块常量（编码器大约 0.56 MB），但这样转出来的图与完整版 ORT 在 ARM
  上加载原包时现做的优化逐位相同；关掉折叠反而会改变算子融合、带来细微的浮点差别，还要多编几个算子。
- required_operators_and_types.config：按数据类型精简的算子清单，编精简版 ORT 时交给 --include_ops_by_config。
- model.properties / metadata.json：文件名（encoder_file、decoder_file）和哈希换成 .ort 的，其余照抄。
最后用同一批验证图比较：原包按 ARM 上的做法加载（关掉 NCHWc），新包用完整版 ORT 读（它也认 ORT 格式），
编码器输出要逐位相同、识别结果要逐记号相同。

python ocr/android/to_ort_bundle.py --bundle tmp/formula-scratch-kv-int8-texteller-r10 \
    --output tmp/formula-scratch-kv-int8-texteller-r10-ort --manifest 验证清单.jsonl [--limit 300]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import random
import shutil
import sys

import onnxruntime as ort
from onnxruntime.tools.ort_format_model import create_config_from_models

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recognize_scratch import ScratchOnnxRecognizer, preprocess_image, sha256


def convert(source: Path, target: Path) -> None:
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.optimized_model_filepath = str(target)
    options.add_session_config_entry("session.qdqisint8allowed", "1")
    options.add_session_config_entry("session.save_model_format", "ORT")
    ort.InferenceSession(str(source), sess_options=options, providers=["CPUExecutionProvider"],
                         disabled_optimizers=["NchwcTransformer"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True, help="核对用的验证清单（image 为绝对路径）")
    parser.add_argument("--limit", type=int, default=300)
    parser.add_argument("--seed", type=int, default=20261016)
    args = parser.parse_args()
    if args.output.exists() and any(args.output.iterdir()):
        raise SystemExit(f"{args.output} 不是空目录")
    args.output.mkdir(parents=True, exist_ok=True)

    convert(args.bundle / "encoder.onnx", args.output / "encoder.ort")
    convert(args.bundle / "decoder.onnx", args.output / "decoder.ort")
    create_config_from_models([args.output / "encoder.ort", args.output / "decoder.ort"],
                              args.output / "required_operators_and_types.config", enable_type_reduction=True)
    shutil.copyfile(args.bundle / "tokenizer.json", args.output / "tokenizer.json")
    shutil.copyfile(args.bundle / "export-validation.json", args.output / "export-validation.json")

    hashes = {name: sha256(args.output / name) for name in ("encoder.ort", "decoder.ort")}
    lines = []
    for line in (args.bundle / "model.properties").read_text(encoding="ascii").splitlines():
        if line.startswith("encoder_sha256="):
            lines += ["encoder_file=encoder.ort", f"encoder_sha256={hashes['encoder.ort']}"]
        elif line.startswith("decoder_sha256="):
            lines += ["decoder_file=decoder.ort", f"decoder_sha256={hashes['decoder.ort']}"]
        else:
            lines.append(line)
    (args.output / "model.properties").write_text("\n".join(lines) + "\n", encoding="ascii")

    metadata = json.loads((args.bundle / "metadata.json").read_text(encoding="utf-8"))
    source_files = metadata["files"]
    files = {name: {"sha256": hashes[name], "bytes": (args.output / name).stat().st_size}
             for name in ("encoder.ort", "decoder.ort")}
    files["tokenizer.json"] = source_files["tokenizer.json"]
    metadata["files"] = files
    metadata["model_files"] = {"encoder": "encoder.ort", "decoder": "decoder.ort"}
    metadata["model_format"] = "ort"
    metadata["model_bytes"] = files["encoder.ort"]["bytes"] + files["decoder.ort"]["bytes"]
    metadata["ort_format_conversion"] = {
        "source_bundle_files": source_files,
        "optimization": "Fixed style, level all, target arm (no NchwcTransformer, session.qdqisint8allowed=1)",
        "onnxruntime_version": ort.__version__,
        "operator_config": "required_operators_and_types.config",
    }
    (args.output / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
                                               encoding="utf-8")

    rows = [json.loads(line) for line in args.manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = [row for row in rows if not row["id"].startswith("source_017_")]
    rows = random.Random(args.seed).sample(rows, min(args.limit, len(rows)))
    source, converted = ScratchOnnxRecognizer(args.bundle), ScratchOnnxRecognizer(args.output)
    # 原包按 ARM 上的做法加载：x86 专用的 NCHWc 布局在平板上本来就不会用
    for part in ("encoder", "decoder"):
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        setattr(source, part, ort.InferenceSession(str(args.bundle / f"{part}.onnx"), sess_options=options,
                                                   providers=["CPUExecutionProvider"],
                                                   disabled_optimizers=["NchwcTransformer"]))
    same, bitwise, different = 0, 0, []
    for row in rows:
        image = preprocess_image(row["image"], source.height, source.width)
        expected = source.encoder.run(None, {"images": image})
        actual = converted.encoder.run(None, {"images": image})
        bitwise += all(x.tobytes() == y.tobytes() for x, y in zip(expected, actual))
        a, b = source.recognize_tensor(image), converted.recognize_tensor(image)
        if a["tokenIds"] == b["tokenIds"] and a["endedWithEos"] == b["endedWithEos"]:
            same += 1
        else:
            different.append({"id": row["id"], "source": a["latex"], "ort": b["latex"]})
    report = {"images": len(rows), "identical_tokens": same, "encoder_bitwise_identical": bitwise, "different": different,
              "bytes": {name: entry["bytes"] for name, entry in files.items()}}
    (args.output / "ort-conversion-check.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                                                           encoding="utf-8")
    print(json.dumps({key: (len(value) if key == "different" else value) for key, value in report.items()},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
