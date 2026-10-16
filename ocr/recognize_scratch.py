"""Offline ONNX inference for the repository's own formula model.

No PyTorch or pretrained assets are needed at inference time. The two ONNX
graphs, vocabulary, and metadata must already exist in a local bundle.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re

import numpy as np
from PIL import Image, ImageChops
import onnxruntime as ort


ARCHITECTURES = ("scratch-formula-ocr-v1", "scratch-formula-ocr-v1-kv")


def sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def preprocess_image(source: str | Path | Image.Image, height: int, width: int) -> np.ndarray:
    """Match scratch_model.preprocess_image, without importing a training runtime."""
    if min(height, width) < 16:
        raise ValueError("Image dimensions must be at least 16 pixels")
    if not isinstance(source, Image.Image):
        with Image.open(source) as opened:
            return preprocess_image(opened.copy(), height, width)
    if "A" in source.getbands() or "transparency" in source.info:
        rgba = source.convert("RGBA")
        gray = Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba).convert("L")
    else:
        gray = source.convert("L")
    difference = ImageChops.difference(gray, Image.new("L", gray.size, 255))
    bbox = difference.point(lambda value: 255 if value > 10 else 0).getbbox()
    if bbox is None:
        raise ValueError("Input crop is blank; no formula pixels found")
    gray = gray.crop(bbox)
    scale = min((width - 8) / gray.width, (height - 8) / gray.height)
    size = (max(1, round(gray.width * scale)), max(1, round(gray.height * scale)))
    gray = gray.resize(size, Image.Resampling.LANCZOS)
    canvas = Image.new("L", (width, height), 255)
    canvas.paste(gray, ((width - size[0]) // 2, (height - size[1]) // 2))
    return (np.asarray(canvas, dtype=np.float32) / np.float32(127.5) - np.float32(1.0))[None, None, :, :]


def detokenize(token_ids: list[int], vocabulary: list[str]) -> str:
    pieces = []
    previous = ""
    for index in token_ids:
        token = vocabulary[index]
        if re.fullmatch(r"\\[A-Za-z]+", previous) and re.match(r"[A-Za-z]", token):
            pieces.append(" ")
        pieces.append(token)
        previous = token
    return "".join(pieces)


class ScratchOnnxRecognizer:
    def __init__(self, bundle: str | Path, threads: int = 2):
        if threads < 1:
            raise ValueError("threads must be positive")
        self.bundle = Path(bundle)
        self.metadata = json.loads((self.bundle / "metadata.json").read_text(encoding="utf-8"))
        if self.metadata.get("format_version") != 1 or self.metadata.get("architecture") not in ARCHITECTURES:
            raise ValueError("Unsupported formula model bundle")
        # -kv：解码器每步只算一个新记号，靠传入、传出的 K / V 缓存接上前文
        self.cached = self.metadata["architecture"].endswith("-kv")
        tokenizer = json.loads((self.bundle / "tokenizer.json").read_text(encoding="utf-8"))
        self.vocabulary = tokenizer["tokens"]
        if (tokenizer.get("version") != 1 or self.vocabulary[:3] != ["<pad>", "<bos>", "<eos>"]
                or len(self.vocabulary) != len(set(self.vocabulary))
                or len(self.vocabulary) != self.metadata["vocab_size"]
                or any(not isinstance(token, str) or not token for token in self.vocabulary)):
            raise ValueError("Invalid tokenizer")
        self.height = int(self.metadata["input"]["height"])
        self.width = int(self.metadata["input"]["width"])
        self.max_tokens = int(self.metadata["decoding"]["max_new_tokens"])
        self.pad_id = int(self.metadata["decoding"]["pad_id"])
        self.bos_id = int(self.metadata["decoding"]["bos_id"])
        self.eos_id = int(self.metadata["decoding"]["eos_id"])
        if (self.pad_id, self.bos_id, self.eos_id) != (0, 1, 2):
            raise ValueError("Unsupported special token IDs")
        # ORT 格式的包（to_ort_bundle.py）文件名是 encoder.ort / decoder.ort，记在 metadata 的 model_files 里
        model_files = self.metadata.get("model_files", {"encoder": "encoder.onnx", "decoder": "decoder.onnx"})
        for name in (model_files["encoder"], model_files["decoder"], "tokenizer.json"):
            if sha256(self.bundle / name) != self.metadata["files"][name]["sha256"]:
                raise ValueError(f"Bundle checksum mismatch: {name}")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self.encoder = ort.InferenceSession(str(self.bundle / model_files["encoder"]), sess_options=options,
                                            providers=["CPUExecutionProvider"])
        self.decoder = ort.InferenceSession(str(self.bundle / model_files["decoder"]), sess_options=options,
                                            providers=["CPUExecutionProvider"])

    def recognize_tensor(self, image: np.ndarray, max_tokens: int | None = None) -> dict:
        limit = self.max_tokens if max_tokens is None else max_tokens
        if not isinstance(limit, int) or not 1 <= limit <= self.max_tokens:
            raise ValueError(f"max_tokens must be between 1 and {self.max_tokens}")
        image = np.asarray(image, dtype=np.float32)
        if image.shape != (1, 1, self.height, self.width) or not np.isfinite(image).all():
            raise ValueError("Expected finite float32 NCHW image with the bundle's fixed dimensions")
        step_logits = self._cached_steps(image) if self.cached else self._prefix_steps(image)
        prefix = [self.bos_id]
        output = []
        log_probabilities = []
        ended = False
        for _ in range(limit):
            raw = step_logits(prefix).astype(np.float64)
            if raw.shape != (len(self.vocabulary),) or not np.isfinite(raw).all():
                raise RuntimeError("Invalid decoder logits")
            selectable = raw.copy()
            selectable[[self.pad_id, self.bos_id]] = -np.inf
            next_id = int(np.argmax(selectable))
            maximum = float(np.max(raw))
            log_probabilities.append(float(raw[next_id] - maximum - np.log(np.exp(raw - maximum).sum())))
            if next_id == self.eos_id:
                ended = True
                break
            output.append(next_id)
            prefix.append(next_id)
        return {
            "latex": detokenize(output, self.vocabulary),
            "tokenIds": output,
            "endedWithEos": ended,
            "meanLogProbability": math.fsum(log_probabilities) / len(log_probabilities),
            "modelTrainingStatus": self.metadata["training_status"],
            "reviewRequired": True,
            "reasonCodes": ["MODEL_NOT_REALWORLD_VALIDATED"] + ([] if ended else ["NO_EOS"]) + ([] if output else ["EMPTY"]),
        }

    def _prefix_steps(self, image: np.ndarray):
        """不带缓存：每步把整段前缀送进解码器，取最后一个位置的 logits。"""
        memory = self.encoder.run(["memory"], {"images": image})[0]

        def step(prefix: list[int]) -> np.ndarray:
            return self.decoder.run(["logits"], {"memory": memory, "tokens": np.asarray([prefix], dtype=np.int64)})[0][0, -1]
        return step

    def _cached_steps(self, image: np.ndarray):
        """带缓存：每步只送最新的一个记号，前文的 K / V 由上一步传回。"""
        cross_keys, cross_values = self.encoder.run(["cross_keys", "cross_values"], {"images": image})
        cache = {"past_keys": np.zeros(cross_keys.shape[:2] + (0,) + cross_keys.shape[3:], dtype=np.float32)}
        cache["past_values"] = cache["past_keys"]

        def step(prefix: list[int]) -> np.ndarray:
            logits, cache["past_keys"], cache["past_values"] = self.decoder.run(None, {
                "token": np.asarray([[prefix[-1]]], dtype=np.int64), "cross_keys": cross_keys,
                "cross_values": cross_values, **cache})
            if cache["past_keys"].shape[2] != len(prefix):
                raise RuntimeError("Decoder cache length does not match the prefix")
            return logits[0]
        return step

    def recognize(self, image: str | Path | Image.Image, max_tokens: int | None = None) -> dict:
        return self.recognize_tensor(preprocess_image(image, self.height, self.width), max_tokens)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--image", type=Path)
    source.add_argument("--tensor", type=Path, help="Little-endian float32 NCHW file for parity checks")
    parser.add_argument("--save-tensor", type=Path, help="Write preprocessed input as little-endian float32")
    parser.add_argument("--max-tokens", type=int)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    recognizer = ScratchOnnxRecognizer(args.bundle, args.threads)
    if args.image is not None:
        image = preprocess_image(args.image, recognizer.height, recognizer.width)
    else:
        flat = np.fromfile(args.tensor, dtype="<f4")
        image = flat.reshape(1, 1, recognizer.height, recognizer.width)
    if args.save_tensor:
        args.save_tensor.parent.mkdir(parents=True, exist_ok=True)
        image.astype("<f4").tofile(args.save_tensor)
    prediction = recognizer.recognize_tensor(image, args.max_tokens)
    print(json.dumps(prediction, ensure_ascii=False))
    if not prediction["endedWithEos"] or not prediction["latex"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
