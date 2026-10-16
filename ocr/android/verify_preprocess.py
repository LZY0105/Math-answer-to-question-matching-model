"""Java 预处理（FormulaImagePreprocessor）与 Python 预处理逐字节比对。

设备上送来的是网页画布导出的 RGBA PNG，所以这里先把每张裁图转成 RGBA PNG（再随机把一部分像素设成半透明、
全透明，覆盖合成到白底那一步），两边读同一份文件，比较输出的 float32 张量是否逐字节相同。

python ocr/android/verify_preprocess.py --manifest 清单.jsonl --java .../java.exe --runner-jar .../scratch-formula-ocr.jar \
    --output tmp/preprocess-parity [--limit 300]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import random
import subprocess
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recognize_scratch import preprocess_image


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--java", type=Path, required=True)
    parser.add_argument("--runner-jar", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=300)
    parser.add_argument("--height", type=int, default=256)
    parser.add_argument("--width", type=int, default=768)
    parser.add_argument("--seed", type=int, default=20261012)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(line) for line in args.manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
    rng = random.Random(args.seed)
    rows = rng.sample(rows, min(args.limit, len(rows)))
    pairs, expected = [], {}
    for index, row in enumerate(rows):
        with Image.open(row["image"]) as opened:
            rgba = opened.convert("RGBA")
        if index % 5 == 0:
            # 五张里挑一张做透明度：一部分像素半透明、一部分全透明，覆盖合成到白底那一步。
            pixels = np.array(rgba)
            mask = np.random.default_rng(index).random(pixels.shape[:2])
            pixels[mask < 0.05, 3] = 0
            pixels[(mask >= 0.05) & (mask < 0.15), 3] = 128
            rgba = Image.fromarray(pixels, "RGBA")
        png = args.output / f"{index:04d}.png"
        rgba.save(png)
        tensor_path = args.output / f"{index:04d}.java.f32"
        pairs += [str(png), str(tensor_path)]
        try:
            expected[index] = preprocess_image(png, args.height, args.width).astype("<f4").tobytes()
        except ValueError:
            expected[index] = None
    # Windows 命令行有长度上限，分批交给 Java，每批 50 张。
    for start in range(0, len(pairs), 100):
        command = [str(args.java), "-cp", str(args.runner_jar), "com.answermatcher.ocr.FormulaPreprocessCli",
                   str(args.height), str(args.width)] + pairs[start:start + 100]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if result.returncode:
            raise SystemExit(result.stderr[-3000:])
    same, different, blank = 0, [], 0
    for index in range(len(rows)):
        java_path = args.output / f"{index:04d}.java.f32"
        if expected[index] is None:
            blank += 1
            if java_path.exists():
                different.append({"index": index, "reason": "Python 判为空白，Java 没有"})
            continue
        actual = java_path.read_bytes() if java_path.exists() else b""
        if actual == expected[index]:
            same += 1
        else:
            a = np.frombuffer(expected[index], dtype="<f4")
            b = np.frombuffer(actual, dtype="<f4") if actual else np.zeros_like(a)
            different.append({"index": index, "image": rows[index]["image"],
                              "differing_values": int(np.count_nonzero(a != b)),
                              "max_gray_levels": float(np.max(np.abs(a - b)) * 127.5)})
    report = {"images": len(rows), "identical": same, "blank": blank, "different": different}
    (args.output / "preprocess-parity.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                                                        encoding="utf-8")
    print(json.dumps({k: (len(v) if k == "different" else v) for k, v in report.items()}, ensure_ascii=False))
    if different:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
