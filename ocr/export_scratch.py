"""Export this repository's locally trained formula network as an offline ONNX bundle."""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import json
import math
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper
import onnxruntime as ort
import torch
from torch import nn
from torch.nn import functional as F

from scratch_model import OCRConfig, ScratchFormulaOCR, TeXTokenizer
from recognize_scratch import sha256


class EncoderGraph(nn.Module):
    def __init__(self, model: ScratchFormulaOCR):
        super().__init__()
        self.model = model

    def forward(self, images):
        return self.model.encode(images)


class DecoderGraph(nn.Module):
    def __init__(self, model: ScratchFormulaOCR):
        super().__init__()
        self.model = model

    @staticmethod
    def _attention(module, query, key, value, mask=None):
        # Express projection/attention with tensor-derived sequence lengths.
        # Legacy export of nn.MultiheadAttention freezes its trace prefix length.
        # This adapter uses the very same trained tensors, without new weights.
        dimension = module.embed_dim
        heads = module.num_heads
        head_dimension = dimension // heads
        weights = module.in_proj_weight.chunk(3, dim=0)
        biases = module.in_proj_bias.chunk(3, dim=0)
        q = F.linear(query, weights[0], biases[0])
        k = F.linear(key, weights[1], biases[1])
        v = F.linear(value, weights[2], biases[2])
        batch, query_length = q.shape[0], q.shape[1]
        key_length = k.shape[1]
        q = q.reshape(batch, query_length, heads, head_dimension).transpose(1, 2)
        k = k.reshape(batch, key_length, heads, head_dimension).transpose(1, 2)
        v = v.reshape(batch, key_length, heads, head_dimension).transpose(1, 2)
        scores = torch.matmul(q, k.transpose(-2, -1)) / math.sqrt(head_dimension)
        if mask is not None:
            scores = scores.masked_fill(mask, float("-inf"))
        attended = torch.matmul(torch.softmax(scores, dim=-1), v)
        attended = attended.transpose(1, 2).reshape(batch, query_length, dimension)
        return F.linear(attended, module.out_proj.weight, module.out_proj.bias)

    def forward(self, memory, tokens):
        length = tokens.shape[1]
        hidden = self.model.embedding(tokens) * math.sqrt(self.model.config.d_model)
        hidden = hidden + self.model.token_positions[:, :length]
        mask = self.model.causal_mask[:length, :length][None, None, :, :]
        mask = mask | tokens.eq(TeXTokenizer.pad_id)[:, None, None, :]
        for layer in self.model.decoder.layers:
            normalized = layer.norm1(hidden)
            hidden = hidden + self._attention(layer.self_attn, normalized, normalized, normalized, mask)
            normalized = layer.norm2(hidden)
            hidden = hidden + self._attention(layer.multihead_attn, normalized, memory, memory)
            hidden = hidden + layer.linear2(layer.activation(layer.linear1(layer.norm3(hidden))))
        return self.model.output(self.model.decoder.norm(hidden))


# 带缓存的解码接口在包里标作 scratch-formula-ocr-v1-kv；不认识它的旧运行器会在加载时拒绝，而不是跑错
CACHED_ARCHITECTURE_SUFFIX = "-kv"


def _heads(projected, module):
    """[1, 长度, d] → [头数, 长度, 每头维度]（批大小固定为 1）。"""
    return projected.reshape(-1, module.num_heads, module.head_dim).transpose(0, 1)


def _attend(module, query, keys, values):
    """query [头数, 1, 每头维度] 对 keys / values [头数, 长度, 每头维度] 做注意力，过输出投影，返回 [1, 1, d]。"""
    scores = torch.matmul(query, keys.transpose(-2, -1)) / math.sqrt(module.head_dim)
    attended = torch.matmul(torch.softmax(scores, dim=-1), values)
    return F.linear(attended.transpose(0, 1).reshape(1, 1, module.embed_dim), module.out_proj.weight, module.out_proj.bias)


class CachedEncoderGraph(nn.Module):
    """编码器顺带算出各解码层对图像的 K、V 投影：每张图只算一次，不必每生成一个记号重算一遍。

    输出 cross_keys / cross_values，形状 [解码层数, 头数, 图像位置数, 每头维度]。这两组投影权重
    随之从解码器图移到编码器图，包里不重复存放。
    """

    def __init__(self, model: ScratchFormulaOCR):
        super().__init__()
        self.model = model

    def forward(self, images):
        memory = self.model.encode(images)
        keys, values = [], []
        for layer in self.model.decoder.layers:
            attention = layer.multihead_attn
            weights = attention.in_proj_weight.chunk(3, dim=0)
            biases = attention.in_proj_bias.chunk(3, dim=0)
            keys.append(_heads(F.linear(memory, weights[1], biases[1]), attention))
            values.append(_heads(F.linear(memory, weights[2], biases[2]), attention))
        return torch.stack(keys), torch.stack(values)


class CachedDecoderGraph(nn.Module):
    """每步只算一个新记号。

    输入这个记号、此前各层自注意力的 K / V（past_keys / past_values，[层数, 头数, 已有长度, 每头维度]，
    第一步长度为 0）和编码器给的图像侧 K / V；输出这一步的 logits 和接上本步之后的 K / V。
    已有长度就是这个记号的位置，BOS 为 0。与 DecoderGraph 用同一套训练好的张量，没有新权重。
    """

    def __init__(self, model: ScratchFormulaOCR):
        super().__init__()
        self.model = model

    def forward(self, token, past_keys, past_values, cross_keys, cross_values):
        model = self.model
        position = past_keys.shape[2]
        hidden = model.embedding(token) * math.sqrt(model.config.d_model)
        hidden = hidden + model.token_positions[:, position:position + 1]
        present_keys, present_values = [], []
        for index, layer in enumerate(model.decoder.layers):
            attention = layer.self_attn
            weights = attention.in_proj_weight.chunk(3, dim=0)
            biases = attention.in_proj_bias.chunk(3, dim=0)
            normalized = layer.norm1(hidden)
            query = _heads(F.linear(normalized, weights[0], biases[0]), attention)
            keys = torch.cat((past_keys[index], _heads(F.linear(normalized, weights[1], biases[1]), attention)), dim=1)
            values = torch.cat((past_values[index], _heads(F.linear(normalized, weights[2], biases[2]), attention)), dim=1)
            present_keys.append(keys)
            present_values.append(values)
            hidden = hidden + _attend(attention, query, keys, values)
            cross = layer.multihead_attn
            query = _heads(F.linear(layer.norm2(hidden), cross.in_proj_weight.chunk(3, dim=0)[0],
                                    cross.in_proj_bias.chunk(3, dim=0)[0]), cross)
            hidden = hidden + _attend(cross, query, cross_keys[index], cross_values[index])
            hidden = hidden + layer.linear2(layer.activation(layer.linear1(layer.norm3(hidden))))
        logits = model.output(model.decoder.norm(hidden))[:, 0]
        return logits, torch.stack(present_keys), torch.stack(present_values)


def _write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _factor_spatial_positions(path: Path, positions: np.ndarray, height: int, width: int) -> int:
    """把编码器图里 [1, 高×宽, d] 的二维位置编码常量换成行表、列表两张小表，在图里展开拼回原样。

    二维位置编码就是「行编码 ∥ 列编码」，展开和拼接只是复制，数值逐位不变；256 × 768 画布下
    589,824 字节的常量变成约 2.5 万字节。ONNX Runtime 加载时会把这几步常量折叠回原来的张量。
    返回文件少了多少字节。
    """
    before = path.stat().st_size
    model = onnx.load(str(path))
    graph = model.graph
    matches = [tensor for tensor in graph.initializer
               if tuple(tensor.dims) == positions.shape and np.array_equal(numpy_helper.to_array(tensor), positions)]
    if len(matches) != 1:
        raise AssertionError(f"Expected one spatial-position constant in the encoder graph, found {len(matches)}")
    half = positions.shape[-1] // 2
    grid = positions.reshape(height, width, -1)
    row, column = grid[:, :1, :half], grid[:1, :, half:]
    if not (np.array_equal(np.broadcast_to(row, (height, width, half)), grid[..., :half])
            and np.array_equal(np.broadcast_to(column, (height, width, half)), grid[..., half:])):
        raise AssertionError("Spatial positions are not a row encoding concatenated with a column encoding")
    name = matches[0].name
    graph.initializer.remove(matches[0])
    graph.initializer.extend([
        numpy_helper.from_array(np.ascontiguousarray(row), f"{name}.row"),
        numpy_helper.from_array(np.ascontiguousarray(column), f"{name}.column"),
        numpy_helper.from_array(np.array([height, width, half], dtype=np.int64), f"{name}.grid_shape"),
        numpy_helper.from_array(np.array(positions.shape, dtype=np.int64), f"{name}.shape"),
    ])
    nodes = [
        helper.make_node("Expand", [f"{name}.row", f"{name}.grid_shape"], [f"{name}.rows"]),
        helper.make_node("Expand", [f"{name}.column", f"{name}.grid_shape"], [f"{name}.columns"]),
        helper.make_node("Concat", [f"{name}.rows", f"{name}.columns"], [f"{name}.grid"], axis=-1),
        helper.make_node("Reshape", [f"{name}.grid", f"{name}.shape"], [name]),
    ]
    for index, node in enumerate(nodes):
        graph.node.insert(index, node)
    onnx.checker.check_model(model)
    onnx.save(model, str(path))
    return before - path.stat().st_size


def _validate_plain(model, tokenizer, encoder, decoder, images, memory, quantized):
    config = model.config
    ort_memory = encoder.run(["memory"], {"images": images.numpy()})[0]
    expected_memory = memory.numpy()
    encoder_error = float(np.max(np.abs(ort_memory - expected_memory)))
    if not np.isfinite(ort_memory).all():
        raise AssertionError("ONNX encoder returned non-finite memory")
    if not quantized:
        np.testing.assert_allclose(ort_memory, expected_memory, rtol=1e-4, atol=2e-4)
    prefix_checks = []
    for length in sorted({1, 2, min(7, config.max_tokens - 1), config.max_tokens - 1}):
        ids = torch.full((1, length), 3, dtype=torch.long)
        ids[:, 0] = tokenizer.bos_id
        expected_logits = model.decode_logits(memory, ids).numpy()
        actual_logits = decoder.run(["logits"], {"memory": ort_memory, "tokens": ids.numpy()})[0]
        if actual_logits.shape != (1, length, len(tokenizer)) or not np.isfinite(actual_logits).all():
            raise AssertionError("ONNX decoder returned invalid output")
        error = float(np.max(np.abs(actual_logits - expected_logits)))
        if not quantized:
            np.testing.assert_allclose(actual_logits, expected_logits, rtol=1e-4, atol=2e-4)
        prefix_checks.append({"prefix_length": length, "max_absolute_error": error,
                              "last_token_argmax_equal": bool(np.argmax(expected_logits[0, -1]) == np.argmax(actual_logits[0, -1]))})
    return encoder_error, prefix_checks


def _validate_cached(model, tokenizer, encoder, decoder, images, memory, quantized):
    """带缓存的图逐步走完最长的序列，每一步都与不带缓存的整段前缀计算比。

    解码器是因果的，整段一次算出的第 t 个位置的 logits 就是只看前 t 个记号的结果。
    """
    config = model.config
    cross_keys, cross_values = encoder.run(["cross_keys", "cross_values"], {"images": images.numpy()})
    expected = [tensor.numpy() for tensor in CachedEncoderGraph(model)(images)]
    encoder_error = max(float(np.max(np.abs(actual - wanted))) for actual, wanted in zip((cross_keys, cross_values), expected))
    if not (np.isfinite(cross_keys).all() and np.isfinite(cross_values).all()):
        raise AssertionError("ONNX encoder returned non-finite cross-attention keys/values")
    if not quantized:
        for actual, wanted in zip((cross_keys, cross_values), expected):
            np.testing.assert_allclose(actual, wanted, rtol=1e-4, atol=2e-4)
    length = config.max_tokens - 1
    ids = torch.full((1, length), 3, dtype=torch.long)
    ids[:, 0] = tokenizer.bos_id
    expected_logits = model.decode_logits(memory, ids)[0].numpy()
    past_keys = np.zeros((cross_keys.shape[0], cross_keys.shape[1], 0, cross_keys.shape[3]), dtype=np.float32)
    past_values = past_keys
    prefix_checks = []
    for step in range(length):
        logits, past_keys, past_values = decoder.run(None, {
            "token": ids[:, step:step + 1].numpy(), "past_keys": past_keys, "past_values": past_values,
            "cross_keys": cross_keys, "cross_values": cross_values})
        if (logits.shape != (1, len(tokenizer)) or past_keys.shape[2] != step + 1
                or not np.isfinite(logits).all()):
            raise AssertionError("ONNX cached decoder returned invalid output")
        if not quantized:
            np.testing.assert_allclose(logits[0], expected_logits[step], rtol=1e-4, atol=2e-4)
        if step + 1 in (1, 2, min(7, length), length):
            prefix_checks.append({"prefix_length": step + 1,
                                  "max_absolute_error": float(np.max(np.abs(logits[0] - expected_logits[step]))),
                                  "last_token_argmax_equal": bool(np.argmax(logits[0]) == np.argmax(expected_logits[step]))})
    return encoder_error, prefix_checks


def _session(path: Path, threads: int) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


def export_bundle(checkpoint_path: Path, output: Path, *, quantize_dynamic: bool = False,
                  quantize_embedding: bool = False, cached_decoder: bool = False, allow_untrained: bool = False,
                  overwrite: bool = False, threads: int = 2) -> dict:
    if threads < 1:
        raise ValueError("threads must be positive")
    if quantize_embedding and not quantize_dynamic:
        raise ValueError("quantize_embedding requires quantize_dynamic")
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    if checkpoint.get("format_version") != 1:
        raise ValueError("Unsupported checkpoint format")
    provenance = checkpoint.get("provenance", {})
    # Label distillation (training labels produced by another recognizer) still trains
    # these weights from random initialization; the teacher's name, when recorded,
    # travels into metadata.json with the rest of the provenance.
    teacher = provenance.get("teacher_model")
    if (provenance.get("initialization") != "random" or provenance.get("pretrained_weights") is not False
            or not (teacher is None or (isinstance(teacher, str) and teacher.strip()))):
        raise ValueError("Expected the repository's from-scratch checkpoint provenance")
    config = OCRConfig.from_dict(checkpoint["config"])
    tokenizer = TeXTokenizer.from_dict(checkpoint["tokenizer"])
    model = ScratchFormulaOCR(config, len(tokenizer))
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.eval()
    steps = int(checkpoint.get("training_state", {}).get("global_step", 0))
    if steps < 1 and not allow_untrained:
        raise ValueError("Checkpoint is untrained; use --allow-untrained only for an explicitly labeled smoke test")
    status = "experimental-locally-trained" if steps > 0 else "untrained-smoke"
    files = ["encoder.onnx", "decoder.onnx", "tokenizer.json", "metadata.json", "model.properties", "export-validation.json"]
    if not overwrite and any((output / name).exists() for name in files):
        raise FileExistsError("Bundle already exists; choose a new directory or use --overwrite")
    output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(threads)
    torch.manual_seed(3917)
    images = torch.rand(1, 1, config.image_height, config.image_width) * 2 - 1
    # Keep batch/image size fixed to reduce mobile shape complexity; only the
    # growing decoder prefix is dynamic. Disable fused MHA before tracing.
    previous_fastpath = torch.backends.mha.get_fastpath_enabled()
    torch.backends.mha.set_fastpath_enabled(False)
    try:
        with torch.no_grad():
            memory = model.encode(images)
            if cached_decoder:
                cross_keys, cross_values = CachedEncoderGraph(model)(images)
                past = torch.zeros(cross_keys.shape[0], cross_keys.shape[1], 3, cross_keys.shape[3])
                torch.onnx.export(
                    CachedEncoderGraph(model).eval(), (images,), str(output / "encoder.onnx"),
                    input_names=["images"], output_names=["cross_keys", "cross_values"], opset_version=17,
                    dynamo=False, do_constant_folding=True,
                )
                torch.onnx.export(
                    CachedDecoderGraph(model).eval(),
                    (torch.full((1, 1), 3, dtype=torch.long), past, past.clone(), cross_keys, cross_values),
                    str(output / "decoder.onnx"),
                    input_names=["token", "past_keys", "past_values", "cross_keys", "cross_values"],
                    output_names=["logits", "present_keys", "present_values"], opset_version=17,
                    dynamic_axes={"past_keys": {2: "past_length"}, "past_values": {2: "past_length"},
                                  "present_keys": {2: "present_length"}, "present_values": {2: "present_length"}},
                    dynamo=False, do_constant_folding=True,
                )
            else:
                prefix = torch.full((1, min(7, config.max_tokens - 1)), tokenizer.bos_id, dtype=torch.long)
                torch.onnx.export(
                    EncoderGraph(model).eval(), (images,), str(output / "encoder.onnx"),
                    input_names=["images"], output_names=["memory"], opset_version=17,
                    dynamo=False, do_constant_folding=True,
                )
                torch.onnx.export(
                    DecoderGraph(model).eval(), (memory, prefix), str(output / "decoder.onnx"),
                    input_names=["memory", "tokens"], output_names=["logits"], opset_version=17,
                    dynamic_axes={"tokens": {1: "prefix_length"}, "logits": {1: "prefix_length"}},
                    dynamo=False, do_constant_folding=True,
                )
            # 位置编码常量换成行表、列表；换之前先记下原图的输出，换完必须逐位相同
            encoder_inputs = {"images": images.numpy()}
            reference_outputs = _session(output / "encoder.onnx", threads).run(None, encoder_inputs)
            position_bytes_saved = _factor_spatial_positions(
                output / "encoder.onnx", model.spatial_positions.numpy(),
                config.image_height // 16, config.image_width // 16)
            factored_outputs = _session(output / "encoder.onnx", threads).run(None, encoder_inputs)
            if not all(np.array_equal(after, before) for after, before in zip(factored_outputs, reference_outputs)):
                raise AssertionError("Factoring the spatial positions changed the encoder output")
            if quantize_dynamic:
                from onnxruntime.quantization import QuantType, quantize_dynamic as quantize
                # Gather 只会量化以常量权重为数据的那一个，即词嵌入；取形状用的 Gather 不受影响
                op_types = ["MatMul", "Gemm"] + (["Gather"] if quantize_embedding else [])
                for name in ("encoder", "decoder"):
                    target = output / f"{name}.onnx"
                    temporary = output / f"{name}.quantized.tmp.onnx"
                    quantize(str(target), str(temporary), weight_type=QuantType.QInt8,
                             per_channel=True, op_types_to_quantize=op_types)
                    temporary.replace(target)
            for name in ("encoder.onnx", "decoder.onnx"):
                onnx.checker.check_model(str(output / name))
            encoder = _session(output / "encoder.onnx", threads)
            decoder = _session(output / "decoder.onnx", threads)
            validate = _validate_cached if cached_decoder else _validate_plain
            encoder_error, prefix_checks = validate(model, tokenizer, encoder, decoder, images, memory, quantize_dynamic)
    finally:
        torch.backends.mha.set_fastpath_enabled(previous_fastpath)
    # Canonical UTF-8/LF JSON gives Python and Java the same vocabulary digest on every OS.
    (output / "tokenizer.json").write_bytes((json.dumps(tokenizer.to_dict(), ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    file_details = {name: {"sha256": sha256(output / name), "bytes": (output / name).stat().st_size}
                    for name in ("encoder.onnx", "decoder.onnx", "tokenizer.json")}
    weight_format = "float32"
    if quantize_dynamic:
        weight_format = "dynamic-int8-matmul-embedding" if quantize_embedding else "dynamic-int8-matmul"
    architecture = model.architecture_version + (CACHED_ARCHITECTURE_SUFFIX if cached_decoder else "")
    if cached_decoder:
        cache_shape = [config.decoder_layers, config.nhead, "past_length", config.d_model // config.nhead]
        encoder_interface = {"outputs": ["cross_keys", "cross_values"],
                             "shape": [config.decoder_layers, config.nhead, int(memory.shape[1]), config.d_model // config.nhead]}
        decoder_interface = {
            "inputs": ["token", "past_keys", "past_values", "cross_keys", "cross_values"], "token_dtype": "int64",
            "token_shape": [1, 1], "cache_shape": cache_shape, "first_step_past_length": 0,
            "outputs": ["logits", "present_keys", "present_values"], "logits_shape": [1, len(tokenizer)],
        }
    else:
        encoder_interface = {"output": "memory", "shape": list(memory.shape)}
        decoder_interface = {"inputs": ["memory", "tokens"], "token_dtype": "int64", "output": "logits"}
    metadata = {
        "format_version": 1,
        "architecture": architecture,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "training_status": status,
        "training_steps": steps,
        "checkpoint_sha256": sha256(checkpoint_path),
        "provenance": provenance,
        "parameter_count": model.parameter_count(),
        "vocab_size": len(tokenizer),
        "weight_format": weight_format,
        "model_bytes": sum(file_details[name]["bytes"] for name in ("encoder.onnx", "decoder.onnx")),
        "config": config.to_dict(),
        "input": {
            "name": "images", "dtype": "float32", "layout": "NCHW", "batch": 1, "channels": 1,
            "height": config.image_height, "width": config.image_width,
            "preprocessing": {
                "alpha": "composite-on-white", "color": "Pillow-L-grayscale",
                "crop": "tight-bbox-of-gray-less-than-245; reject-blank",
                "resize": "aspect-preserving-Pillow-LANCZOS",
                "resize_scale": "min((width-8)/crop_width,(height-8)/crop_height)",
                "resize_rounding": "Python-round-ties-to-even; minimum-1",
                "padding": "center-on-white-canvas; integer-floor-offset",
                "normalization": "pixel/127.5-1",
            },
        },
        "encoder": encoder_interface,
        "decoder": decoder_interface,
        "decoding": {
            "strategy": "greedy", "max_new_tokens": config.max_tokens - 1,
            "pad_id": tokenizer.pad_id, "bos_id": tokenizer.bos_id, "eos_id": tokenizer.eos_id,
            "suppressed_output_ids": [tokenizer.pad_id, tokenizer.bos_id],
            "score": "mean full-vocabulary log probability of generated tokens including EOS; not calibrated confidence",
            "detokenization": "concatenate; add ASCII space after a backslash-letter command when the next token starts with an ASCII letter",
        },
        "files": file_details,
        "recognition_accuracy": "Not established by export validation; evaluate on independent formula images.",
        "android_device_validation": "NOT RUN",
    }
    validation = {
        "checkpoint_training_status": status,
        "onnx_checker": "PASS",
        "numerical_comparison": "reported-only-int8" if quantize_dynamic else "PASS",
        "encoder_max_absolute_error": encoder_error,
        "spatial_positions": {"stored_as": "row and column tables expanded in graph",
                              "bytes_saved": position_bytes_saved, "encoder_output_bit_identical": True},
        "decoder_prefix_checks": prefix_checks,
        "input": "seeded synthetic tensor; this is numerical deployment validation, not OCR accuracy",
        "pytorch_version": torch.__version__,
        "onnx_version": onnx.__version__,
        "onnxruntime_version": ort.__version__,
        "android_device_validation": "NOT RUN",
    }
    _write_json(output / "metadata.json", metadata)
    _write_json(output / "export-validation.json", validation)
    properties = {
        "format_version": 1, "architecture": architecture,
        "image_height": config.image_height, "image_width": config.image_width,
        "max_tokens": config.max_tokens - 1, "vocab_size": len(tokenizer),
        "pad_id": tokenizer.pad_id, "bos_id": tokenizer.bos_id, "eos_id": tokenizer.eos_id,
        "training_status": status,
        "encoder_sha256": file_details["encoder.onnx"]["sha256"],
        "decoder_sha256": file_details["decoder.onnx"]["sha256"],
        "tokenizer_sha256": file_details["tokenizer.json"]["sha256"],
    }
    lines = ["# Generated with metadata.json and tokenizer.json; do not edit independently."]
    lines.extend(f"{key}={value}" for key, value in properties.items())
    lines.extend(f"token.{index}={base64.b64encode(token.encode('utf-8')).decode('ascii')}"
                 for index, token in enumerate(tokenizer.tokens))
    (output / "model.properties").write_text("\n".join(lines) + "\n", encoding="ascii")
    return {"bundle": str(output), "training_status": status, "model_bytes": metadata["model_bytes"],
            "parameter_count": model.parameter_count(), "validation": validation}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--quantize-dynamic", action="store_true", help="INT8 linear weights; requires a separate accuracy evaluation")
    parser.add_argument("--quantize-embedding", action="store_true",
                        help="With --quantize-dynamic, also store the token embedding as INT8; requires a separate accuracy evaluation")
    parser.add_argument("--cached-decoder", action="store_true",
                        help="Export the step-wise decoder with a key/value cache (architecture scratch-formula-ocr-v1-kv)")
    parser.add_argument("--allow-untrained", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    result = export_bundle(args.checkpoint, args.output, quantize_dynamic=args.quantize_dynamic,
                           quantize_embedding=args.quantize_embedding, cached_decoder=args.cached_decoder,
                           allow_untrained=args.allow_untrained, overwrite=args.overwrite, threads=args.threads)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
