"""Compare Python and Java ONNX predictions on identical preprocessed image tensors.

This is a desktop deployment parity check. It does not measure OCR accuracy or
prove execution/performance on an Android device.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recognize_scratch import ScratchOnnxRecognizer, preprocess_image


def check_vocabulary_integrity(args, tensor_path: Path) -> list[dict]:
    properties_text = (args.bundle / "model.properties").read_text(encoding="ascii")
    properties = dict(line.split("=", 1) for line in properties_text.splitlines() if line and not line.startswith("#"))
    tokenizer_bytes = (args.bundle / "tokenizer.json").read_bytes()
    variants = [
        ("swapped-regular-tokens", {"token.3": properties["token.4"], "token.4": properties["token.3"]},
         "Properties vocabulary differs from tokenizer.json"),
        ("duplicate-token", {"token.4": properties["token.3"]}, "Vocabulary tokens must be nonempty and unique"),
        ("empty-token", {"token.3": ""}, "Missing bundle property: token.3"),
        ("swapped-special-ids", {"bos_id": "2", "eos_id": "1"}, "Expected PAD/BOS/EOS IDs 0/1/2"),
        ("changed-tokenizer-json", {}, "Model checksum mismatch: tokenizer.json"),
    ]
    checks = []
    for name, changes, expected_error in variants:
        directory = args.output / ("corrupt-" + name)
        directory.mkdir(parents=True, exist_ok=True)
        changed = dict(properties)
        changed.update(changes)
        (directory / "model.properties").write_text("\n".join(f"{key}={value}" for key, value in changed.items()) + "\n", encoding="ascii")
        content = tokenizer_bytes
        if name == "changed-tokenizer-json":
            tokenizer = json.loads(tokenizer_bytes)
            tokenizer["tokens"][3] = "CORRUPTED_TOKEN"
            content = json.dumps(tokenizer, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        (directory / "tokenizer.json").write_bytes(content)
        command = [str(args.java), "-Dfile.encoding=UTF-8", "-Dsun.stderr.encoding=UTF-8",
                   "-cp", os.pathsep.join((str(args.runner_jar), str(args.runtime_jar))),
                   "com.answermatcher.ocr.ScratchFormulaCli", str(directory), str(tensor_path), "1", str(args.threads)]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if result.returncode == 0 or expected_error not in result.stderr:
            raise AssertionError(f"Missing vocabulary rejection for {name}: {result.stderr[:2000]}")
        checks.append({"case": name, "status": "REJECTED", "error": expected_error})
    return checks


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True, action="append")
    parser.add_argument("--java", type=Path, required=True)
    parser.add_argument("--runner-jar", type=Path, required=True)
    parser.add_argument("--runtime-jar", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-tokens", type=int)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    recognizer = ScratchOnnxRecognizer(args.bundle, args.threads)
    limit = recognizer.max_tokens if args.max_tokens is None else args.max_tokens
    checks = []
    for index, source in enumerate(args.image):
        tensor_path = args.output / f"input-{index:03d}.f32"
        pixels = preprocess_image(source, recognizer.height, recognizer.width)
        pixels.astype("<f4").tofile(tensor_path)
        python_prediction = recognizer.recognize_tensor(pixels, limit)
        command = [str(args.java), "-Dfile.encoding=UTF-8", "-Dsun.stderr.encoding=UTF-8",
                   "-cp", os.pathsep.join((str(args.runner_jar), str(args.runtime_jar))),
                   "com.answermatcher.ocr.ScratchFormulaCli", str(args.bundle),
                   str(tensor_path), str(limit), str(args.threads)]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if result.returncode not in (0, 2):
            raise RuntimeError(f"Java inference failed (exit {result.returncode}): {result.stderr[:4000]}")
        java_prediction = json.loads(result.stdout)
        for key in ("latex", "tokenIds", "endedWithEos", "modelTrainingStatus", "reviewRequired", "reasonCodes"):
            if python_prediction[key] != java_prediction[key]:
                raise AssertionError(f"Python/Java disagreement for {source}: {key}")
        difference = abs(python_prediction["meanLogProbability"] - java_prediction["meanLogProbability"])
        if difference > 1e-5:
            raise AssertionError(f"Python/Java score drift for {source}: {difference}")
        expected_exit = 0 if python_prediction["endedWithEos"] and python_prediction["latex"] else 2
        if result.returncode != expected_exit:
            raise AssertionError(f"Incorrect Java incomplete-output exit code: {result.returncode}")
        python_cli = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parents[1] / "recognize_scratch.py"),
             "--bundle", str(args.bundle), "--tensor", str(tensor_path),
             "--max-tokens", str(limit), "--threads", str(args.threads)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if python_cli.returncode != expected_exit:
            raise AssertionError(f"Incorrect Python CLI exit code: {python_cli.returncode}; {python_cli.stderr[:2000]}")
        cli_prediction = json.loads(python_cli.stdout)
        if cli_prediction != python_prediction:
            raise AssertionError("Python class/CLI prediction disagreement")
        checks.append({"source_image": str(source), "tensor": str(tensor_path), "token_agreement": "EXACT",
                       "mean_log_probability_absolute_difference": difference, "java_exit_code": result.returncode,
                       "python_cli_exit_code": python_cli.returncode, "prediction": python_prediction})
    integrity_checks = check_vocabulary_integrity(args, args.output / "input-000.f32")
    report = {"status": "PASS", "bundle": str(args.bundle), "checkpoint_sha256": recognizer.metadata["checkpoint_sha256"],
              "training_status": recognizer.metadata["training_status"], "samples": checks,
              "accuracy_measured": False, "vocabulary_integrity_checks": integrity_checks, "android_device_validation": "NOT RUN"}
    report_path = args.output / "parity-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PASS", "samples": len(checks), "report": str(report_path),
                      "android_device_validation": "NOT RUN"}))


if __name__ == "__main__":
    main()
