"""Train the in-repository formula OCR from random initialization.

Input manifests are UTF-8 JSONL rows containing ``image`` and ``latex``. Image
paths are relative to the manifest directory. No pretrained weights are loaded
and no teacher model is run. When the manifest labels were produced by another
recognizer, name it with ``--teacher-model`` so the provenance records the
distillation. Checkpoints contain tensors and basic Python containers so they
can be loaded with ``torch.load(..., weights_only=True)``.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import random
import time
from typing import Callable

import torch
from torch import Tensor, nn
from torch.utils.data import DataLoader, Dataset

try:
    from .scratch_model import VISUAL_VARIANTS, OCRConfig, ScratchFormulaOCR, TeXTokenizer, preprocess_image
except ImportError:
    from scratch_model import VISUAL_VARIANTS, OCRConfig, ScratchFormulaOCR, TeXTokenizer, preprocess_image


def read_manifest(path: str | Path) -> list[dict]:
    path = Path(path).resolve()
    records: list[dict] = []
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                if not isinstance(row.get("image"), str) or not isinstance(row.get("latex"), str):
                    raise ValueError("image and latex must be strings")
                image = (path.parent / row["image"]).resolve()
                if not image.is_file():
                    raise ValueError(f"Image does not exist: {image}")
                if not TeXTokenizer.tokenize(row["latex"]):
                    raise ValueError("Formula is empty")
                records.append({**row, "image_path": str(image), "manifest_line": line_number})
            except (ValueError, TypeError, AttributeError) as error:
                raise ValueError(f"{path}:{line_number}: {error}") from error
    if not records:
        raise ValueError(f"Manifest has no samples: {path}")
    return records


def assert_disjoint(train: list[dict], validation: list[dict]) -> None:
    """Reject shared paths, image-file content, or canonical formula labels."""
    train_images = {os.path.normcase(row["image_path"]) for row in train}
    validation_images = {os.path.normcase(row["image_path"]) for row in validation}
    train_labels = {tuple(TeXTokenizer.tokenize(row["latex"])) for row in train}
    validation_labels = {tuple(TeXTokenizer.tokenize(row["latex"])) for row in validation}
    duplicate_images = train_images & validation_images
    duplicate_labels = train_labels & validation_labels
    train_hashes = {hashlib.sha256(Path(row["image_path"]).read_bytes()).digest() for row in train}
    validation_hashes = {hashlib.sha256(Path(row["image_path"]).read_bytes()).digest() for row in validation}
    duplicate_contents = train_hashes & validation_hashes
    if duplicate_images or duplicate_labels or duplicate_contents:
        raise ValueError(
            f"Training/validation leakage: {len(duplicate_images)} shared image paths, "
            f"{len(duplicate_contents)} shared image-file hashes, {len(duplicate_labels)} shared canonical formulas. "
            "Split before rendering augmentations."
        )


class FormulaDataset(Dataset):
    def __init__(self, records: list[dict], tokenizer: TeXTokenizer, config: OCRConfig):
        self.records = records
        self.tokenizer = tokenizer
        self.config = config
        self.targets: list[Tensor] = []
        for row in records:
            try:
                target = tokenizer.encode(row["latex"], config.max_tokens)
            except ValueError as error:
                raise ValueError(f"Manifest line {row['manifest_line']}: {error}") from error
            self.targets.append(torch.tensor(target, dtype=torch.long))

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> tuple[Tensor, Tensor, str]:
        row = self.records[index]
        image = preprocess_image(row["image_path"], self.config.image_height, self.config.image_width)
        return image, self.targets[index], self.tokenizer.decode(self.targets[index])


def collate_formulas(batch: list[tuple[Tensor, Tensor, str]]) -> tuple[Tensor, Tensor, list[str]]:
    images, targets, labels = zip(*batch)
    return torch.stack(images), nn.utils.rnn.pad_sequence(targets, batch_first=True, padding_value=TeXTokenizer.pad_id), list(labels)


def _seed_worker(worker_id: int) -> None:
    random.seed(torch.initial_seed() % (2**32))


def augment_training_images(images: Tensor) -> Tensor:
    """Small photometric changes only; geometry and every formula pixel remain.

    Runs on the batch's existing device. White stays the reference background;
    blur is a mild blend with a 3x3 average, not a symbol-erasing full filter.
    """
    shape = (images.shape[0], 1, 1, 1)
    contrast = 0.8 + 0.35 * torch.rand(shape, device=images.device)
    result = 1.0 - (1.0 - images) * contrast
    blur_strength = 0.3 * torch.rand(shape, device=images.device)
    blur_strength *= torch.rand(shape, device=images.device).lt(0.3)
    blurred = nn.functional.avg_pool2d(nn.functional.pad(result, (1, 1, 1, 1), value=1.0), 3, stride=1)
    result = torch.lerp(result, blurred, blur_strength)
    noise_scale = 0.005 + 0.02 * torch.rand(shape, device=images.device)
    result = result + torch.randn_like(result) * noise_scale
    return result.clamp(-1.0, 1.0)


class WeightAverage:
    """训练权重的指数滑动平均（EMA）。评估、保存的 state_dict 和导出都用平均后的权重，
    续训需要的原始权重另存为 raw_state_dict。

    前期用 min(decay, (1 + step) / (10 + step)) 代替固定衰减，免得平均值被随机初值拖住。
    非浮点缓冲（如因果掩码）直接照抄。
    """

    def __init__(self, model: nn.Module, decay: float):
        if not 0 < decay < 1:
            raise ValueError("EMA decay must be between 0 and 1")
        self.decay = decay
        self.shadow = {name: value.detach().clone() for name, value in model.state_dict().items()}

    @torch.no_grad()
    def update(self, model: nn.Module, step: int) -> None:
        decay = min(self.decay, (1 + step) / (10 + step))
        for name, value in model.state_dict().items():
            if value.dtype.is_floating_point:
                self.shadow[name].mul_(decay).add_(value.detach(), alpha=1 - decay)
            else:
                self.shadow[name].copy_(value)

    def state_dict(self) -> dict:
        return {name: value.clone() for name, value in self.shadow.items()}

    def load_state_dict(self, state: dict) -> None:
        for name, value in state.items():
            self.shadow[name].copy_(value)

    @contextmanager
    def applied(self, model: nn.Module):
        """临时换上平均权重，离开时恢复原始权重（出错也恢复）。"""
        raw = {name: value.detach().clone() for name, value in model.state_dict().items()}
        model.load_state_dict(self.shadow, strict=True)
        try:
            yield
        finally:
            model.load_state_dict(raw, strict=True)


# BatchNorm 统计重估（precise BN）。训练时 BN 用当批统计，评估和导出用 running_mean / running_var；
# 动量 0.1 的滑动统计只反映最后十来批，高学习率下权重变得快，统计跟不上，验证就会时好时坏
# （学习率 0.002 的完整训练第 12 轮原样 80.00%，只重估统计、权重不动后 83.95%）。
BN_RECALIBRATION_VERSION = "precise-bn-v1"
BN_RECALIBRATION_IMAGES = 3200
BN_RECALIBRATION_SEED = 20261005
BN_RECALIBRATION_BATCH = 64
BN_BUFFER_SUFFIXES = ("running_mean", "running_var", "num_batches_tracked")


class RecalibrationImages(Dataset):
    """只取图、不编码标签：重估 BN 用不到标签，换一份清单也不会因生词报错。不做增强，与评估、导出看到的图一致。"""

    def __init__(self, records: list[dict], config: OCRConfig):
        self.records = records
        self.config = config

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> Tensor:
        return preprocess_image(self.records[index]["image_path"], self.config.image_height, self.config.image_width)


def select_recalibration_records(records: list[dict], count: int, seed: int = BN_RECALIBRATION_SEED) -> list[dict]:
    """按固定种子打乱清单后取前 count 条；只取决于清单和种子，与训练顺序无关，重跑一致。不改动传入的列表。"""
    if count <= 0:
        raise ValueError("BatchNorm recalibration needs a positive image count")
    order = list(records)
    random.Random(seed).shuffle(order)
    return order[:count]


@torch.no_grad()
def recalibrate_batchnorm(model: ScratchFormulaOCR, loader, device: torch.device) -> int:
    """用 loader 给出的图重算卷积部分全部 BN 层的 running_mean / running_var（累积平均，每批权重相同）。

    BN 层都在 model.visual 里，只跑这一段，按 FP32 计算，与评估、导出一致。权重、其余缓冲、
    各层 momentum 和模型的 train / eval 状态在返回时都与调用前相同。返回用到的图数。
    """
    norms = [module for module in model.visual.modules() if isinstance(module, nn.modules.batchnorm._BatchNorm)]
    if len(norms) != sum(isinstance(module, nn.modules.batchnorm._BatchNorm) for module in model.modules()):
        raise ValueError("BatchNorm outside the visual stem would keep stale statistics")
    was_training = model.training
    momenta = [module.momentum for module in norms]
    for module in norms:
        module.reset_running_stats()
        module.momentum = None
    model.eval()
    for module in norms:
        module.train()
    seen = 0
    try:
        for images in loader:
            model.visual(images.to(device, non_blocking=True))
            seen += len(images)
    finally:
        for module, momentum in zip(norms, momenta):
            module.momentum = momentum
        model.train(was_training)
    if not seen:
        raise ValueError("No images for BatchNorm recalibration")
    return seen


def bn_recalibration_provenance(images: int, seed: int, when: str) -> dict:
    return {"version": BN_RECALIBRATION_VERSION, "images": images, "seed": seed,
            "batch_size": BN_RECALIBRATION_BATCH, "augmented": False, "when": when}


@torch.no_grad()
def evaluate(
    model: ScratchFormulaOCR,
    loader: DataLoader,
    tokenizer: TeXTokenizer,
    device: torch.device,
    *,
    greedy_samples: int | None = None,
    on_progress: Callable[[dict], None] | None = None,
) -> dict:
    """Teacher-forced loss is diagnostic; accuracy uses actual greedy decoding."""
    model.eval()
    total_loss = 0.0
    token_count = 0
    sample_count = 0
    greedy_count = 0
    exact_count = 0
    truncated_count = 0
    predictions: list[dict] = []
    criterion = nn.CrossEntropyLoss(ignore_index=tokenizer.pad_id, reduction="sum")
    for batch_index, (images, targets, labels) in enumerate(loader):
        images = images.to(device, non_blocking=True)
        targets = targets.to(device, non_blocking=True)
        logits = model(images, targets[:, :-1])
        expected = targets[:, 1:]
        total_loss += float(criterion(logits.reshape(-1, logits.shape[-1]), expected.reshape(-1)).item())
        token_count += int(expected.ne(tokenizer.pad_id).sum().item())
        sample_count += len(labels)
        remaining = len(labels) if greedy_samples is None else max(0, min(len(labels), greedy_samples - greedy_count))
        if remaining:
            generation = model.generate(images[:remaining])
            sequences = generation.tokens.cpu().tolist()
            truncations = generation.truncated.cpu().tolist()
            for label, sequence, truncated in zip(labels[:remaining], sequences, truncations):
                prediction = tokenizer.decode(sequence)
                exact = prediction == label and not truncated
                exact_count += int(exact)
                truncated_count += int(truncated)
                if len(predictions) < 20:
                    predictions.append({"expected": label, "predicted": prediction, "exact": exact, "truncated": truncated})
            greedy_count += remaining
        if on_progress is not None and (batch_index + 1) % 10 == 0:
            on_progress({"event": "validation_progress", "samples": sample_count, "greedy_samples": greedy_count})
    return {
        "loss_per_token": total_loss / max(1, token_count),
        "samples": sample_count,
        "tokens": token_count,
        "greedy_samples": greedy_count,
        "greedy_exact_count": exact_count,
        "greedy_exact_match": exact_count / greedy_count if greedy_count else None,
        "truncated_count": truncated_count,
        "examples": predictions,
    }


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _save_checkpoint(path: Path, checkpoint: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save(checkpoint, temporary)
    temporary.replace(path)


def validate_resume_best(output_dir: Path, resume_path: Path, checkpoint: dict) -> None:
    """Keep the recorded historical best tied to an existing model on resume."""
    if resume_path.resolve().parent != output_dir.resolve():
        raise ValueError("Resume must use its original output directory so historical best.pt is preserved")
    best_path = output_dir / "best.pt"
    if not best_path.is_file():
        raise ValueError("Resume requires the original best.pt; last.pt cannot substitute for historical best weights")
    best = torch.load(best_path, map_location="cpu", weights_only=True)
    for key in ("config", "tokenizer", "provenance"):
        if best.get(key) != checkpoint.get(key):
            raise ValueError(f"Resume historical best mismatch: {key}")
    state, best_state = checkpoint["training_state"], best["training_state"]
    if (best_state["best_score"] != state["best_score"]
            or best_state["global_step"] > state["global_step"]):
        raise ValueError("Resume checkpoint does not match the historical best in this directory")


def _log(output_dir: Path, payload: dict) -> None:
    payload = {"utc": datetime.now(timezone.utc).isoformat(), **payload}
    line = json.dumps(payload, ensure_ascii=False)
    print(line, flush=True)
    with (output_dir / "metrics.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")


def train(args: argparse.Namespace) -> dict:
    train_path = Path(args.train_manifest).resolve()
    val_path = Path(args.val_manifest).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    if args.batch_size <= 0 or args.epochs <= 0 or args.workers < 0 or args.max_steps < 0 or args.log_every <= 0:
        raise ValueError("Batch size/epochs/log-every must be positive; workers/max steps must be nonnegative")
    if args.eval_samples is not None and args.eval_samples <= 0:
        raise ValueError("eval-samples must be positive when provided")
    if args.learning_rate <= 0 or args.weight_decay < 0 or args.grad_clip <= 0 or args.warmup_steps < 0:
        raise ValueError("Invalid optimizer settings")
    if args.patience < 0:
        raise ValueError("patience must be nonnegative")
    if not 0 <= args.label_smoothing < 1 or not 0 <= args.ema_decay < 1:
        raise ValueError("label-smoothing and ema-decay must be in [0, 1)")
    if args.bn_recalibration_images < 0:
        raise ValueError("bn-recalibration-images must be nonnegative")
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu") if args.device == "auto" else torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is unavailable")
    if device.type == "cuda":
        torch.cuda.manual_seed_all(args.seed)
    if args.threads > 0:
        torch.set_num_threads(args.threads)
    train_records = read_manifest(train_path)
    val_records = read_manifest(val_path)
    assert_disjoint(train_records, val_records)
    tokenizer = TeXTokenizer.from_labels(row["latex"] for row in train_records)
    config = OCRConfig(
        image_height=args.image_height, image_width=args.image_width,
        d_model=args.d_model, nhead=args.nhead, encoder_layers=args.encoder_layers,
        decoder_layers=args.decoder_layers, feedforward_dim=args.feedforward_dim,
        max_tokens=args.max_tokens, dropout=args.dropout, visual_variant=args.visual_variant,
    )
    train_dataset = FormulaDataset(train_records, tokenizer, config)
    val_dataset = FormulaDataset(val_records, tokenizer, config)
    generator = torch.Generator().manual_seed(args.seed)
    loader_options = {
        "batch_size": args.batch_size, "num_workers": args.workers,
        "collate_fn": collate_formulas, "pin_memory": device.type == "cuda",
        "persistent_workers": args.workers > 0, "worker_init_fn": _seed_worker,
    }
    train_loader = DataLoader(train_dataset, shuffle=True, generator=generator, **loader_options)
    val_loader = DataLoader(val_dataset, shuffle=False, **loader_options)
    recalibration_loader = None
    recalibration = None
    if args.bn_recalibration_images:
        # 每轮验证前用同一批不增强的训练图重估 BN，验证与保存的检查点都用重估后的统计
        picked = select_recalibration_records(train_records, args.bn_recalibration_images)
        recalibration_loader = DataLoader(RecalibrationImages(picked, config), batch_size=BN_RECALIBRATION_BATCH,
                                          shuffle=False, num_workers=min(args.workers, 4),
                                          pin_memory=device.type == "cuda")
        recalibration = bn_recalibration_provenance(len(picked), BN_RECALIBRATION_SEED, "before every validation")
    model = ScratchFormulaOCR(config, len(tokenizer)).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    use_amp = device.type == "cuda" and not args.no_amp
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    steps_per_epoch = len(train_loader)
    total_steps = args.max_steps or args.epochs * steps_per_epoch
    # 标签平滑只作用于训练损失；验证损失由 evaluate 另行计算，不平滑，各设置之间可比
    criterion = nn.CrossEntropyLoss(ignore_index=tokenizer.pad_id, label_smoothing=args.label_smoothing)
    average = WeightAverage(model, args.ema_decay) if args.ema_decay else None
    provenance = {
        "architecture": model.architecture_version,
        "initialization": "random",
        "pretrained_weights": False,
        "teacher_model": args.teacher_model,
        "label_normalization": args.label_normalization,
        # 关闭时记 None，与没有这两项的旧检查点一致，续训比对不受影响
        "label_smoothing": args.label_smoothing or None,
        "ema_decay": args.ema_decay or None,
        "bn_recalibration": recalibration,
        "tokenizer_source": "training_manifest_lexical_tokens_only",
        "training_augmentation": "contrast_subpixel_blur_additive_noise_v1" if args.augment else None,
        "seed": args.seed,
        "train_manifest_sha256": _sha256(train_path),
        "validation_manifest_sha256": _sha256(val_path),
        "train_samples": len(train_records),
        "validation_samples": len(val_records),
        "split_check": "distinct_image_paths_file_sha256_and_canonical_formula_labels",
        "torch_version": str(torch.__version__),
        "training_device": str(device),
        "gpu_name": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
    }
    start_epoch = 0
    step = 0
    best_score = (-1.0, -math.inf)
    epochs_without_improvement = 0
    if args.resume:
        checkpoint = torch.load(args.resume, map_location="cpu", weights_only=True)
        if checkpoint.get("format_version") != 1:
            raise ValueError("Unsupported checkpoint format")
        saved_provenance = checkpoint["provenance"]
        for key in ("architecture", "initialization", "pretrained_weights", "teacher_model", "label_normalization",
                    "label_smoothing", "ema_decay", "bn_recalibration", "training_augmentation", "seed",
                    "train_manifest_sha256", "validation_manifest_sha256"):
            if saved_provenance.get(key) != provenance[key]:
                raise ValueError(f"Resume provenance mismatch: {key}")
        if checkpoint["config"] != config.to_dict() or checkpoint["tokenizer"] != tokenizer.to_dict():
            raise ValueError("Resume architecture/tokenizer differs from this run")
        if not checkpoint.get("training_state", {}).get("epoch_complete", False):
            raise ValueError("Resume requires an epoch-complete checkpoint; interrupted partial epochs cannot silently skip samples")
        validate_resume_best(output_dir, Path(args.resume), checkpoint)
        if average:
            model.load_state_dict(checkpoint["raw_state_dict"], strict=True)
            average.load_state_dict(checkpoint["state_dict"])
        else:
            model.load_state_dict(checkpoint["state_dict"], strict=True)
        optimizer.load_state_dict(checkpoint["optimizer"])
        scaler.load_state_dict(checkpoint["scaler"])
        state = checkpoint["training_state"]
        start_epoch = state["epoch"] + 1
        step = state["global_step"]
        best_score = tuple(state["best_score"])
        epochs_without_improvement = state.get("epochs_without_improvement", 0)
        torch.set_rng_state(state["torch_rng_state"])
        generator.set_state(state["loader_rng_state"])
        random.setstate(state["python_rng_state"])
        if device.type == "cuda" and state.get("cuda_rng_state") is not None:
            torch.cuda.set_rng_state_all(state["cuda_rng_state"])
    elif (output_dir / "last.pt").exists() or (output_dir / "best.pt").exists():
        raise ValueError("Output already contains weights; use a new directory or explicit --resume")
    if start_epoch >= args.epochs or step >= total_steps:
        raise ValueError("Training schedule is already complete; increase epochs/max-steps")
    tokenizer.save(output_dir / "tokenizer.json")
    (output_dir / "config.json").write_text(json.dumps(config.to_dict(), indent=2) + "\n", encoding="utf-8")
    (output_dir / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _log(output_dir, {"event": "start", "parameters": model.parameter_count(), "vocab_size": len(tokenizer), "amp": use_amp, "total_steps": total_steps, **provenance})
    started = time.perf_counter()
    final_metrics: dict = {}
    for epoch in range(start_epoch, args.epochs):
        model.train()
        running_loss = 0.0
        running_tokens = 0
        epoch_start = time.perf_counter()
        completed_batches = 0
        for batch_index, (images, targets, _) in enumerate(train_loader):
            if step >= total_steps:
                break
            step += 1
            completed_batches += 1
            if args.warmup_steps and step <= args.warmup_steps:
                multiplier = step / args.warmup_steps
            else:
                progress = (step - args.warmup_steps) / max(1, total_steps - args.warmup_steps)
                multiplier = 0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * max(0, min(1, progress))))
            for group in optimizer.param_groups:
                group["lr"] = args.learning_rate * multiplier
            images = images.to(device, non_blocking=True)
            targets = targets.to(device, non_blocking=True)
            if args.augment:
                images = augment_training_images(images)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=use_amp):
                logits = model(images, targets[:, :-1])
                expected = targets[:, 1:]
                loss = criterion(logits.reshape(-1, logits.shape[-1]), expected.reshape(-1))
            if not bool(torch.isfinite(loss)):
                raise FloatingPointError(f"Non-finite training loss at step {step}")
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            gradient_norm = nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip, error_if_nonfinite=not use_amp)
            scaler.step(optimizer)
            scaler.update()
            if average:
                average.update(model, step)
            count = int(expected.ne(tokenizer.pad_id).sum().item())
            running_tokens += count
            running_loss += float(loss.item()) * count
            if step == 1 or step % args.log_every == 0:
                _log(output_dir, {"event": "train", "epoch": epoch + 1, "step": step,
                    "loss_per_token": running_loss / running_tokens, "lr": optimizer.param_groups[0]["lr"],
                    "gradient_norm": float(gradient_norm.item()),
                    "elapsed_seconds": time.perf_counter() - started,
                    "samples_per_second": completed_batches * args.batch_size / max(1e-9, time.perf_counter() - epoch_start)})
        epoch_complete = completed_batches == steps_per_epoch
        with average.applied(model) if average else nullcontext():
            if recalibration_loader is not None:
                recalibrate_batchnorm(model, recalibration_loader, device)
            metrics = evaluate(model, val_loader, tokenizer, device, greedy_samples=args.eval_samples,
                               on_progress=lambda event: _log(output_dir, event))
            # 存的就是刚验证过的权重：有 EMA 时是平均权重，重估时带着重估后的 BN 统计
            evaluated_state = {name: value.detach().clone() for name, value in model.state_dict().items()}
        metrics.update({"epoch": epoch + 1, "step": step, "epoch_complete": epoch_complete,
                        "train_loss_per_token": running_loss / max(1, running_tokens),
                        "elapsed_seconds": time.perf_counter() - started})
        score = (metrics["greedy_exact_match"] if metrics["greedy_exact_match"] is not None else -1.0, -metrics["loss_per_token"])
        improved = score > best_score
        if improved:
            best_score = score
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
        training_state = {
            "epoch": epoch, "epoch_complete": epoch_complete, "global_step": step,
            "best_score": list(best_score), "total_steps": total_steps,
            "epochs_without_improvement": epochs_without_improvement,
            "torch_rng_state": torch.get_rng_state(), "loader_rng_state": generator.get_state(),
            "python_rng_state": random.getstate(),
            "cuda_rng_state": torch.cuda.get_rng_state_all() if device.type == "cuda" else None,
        }
        checkpoint = {"format_version": 1, "config": config.to_dict(), "tokenizer": tokenizer.to_dict(),
                      "state_dict": evaluated_state, "provenance": provenance,
                      "optimizer": optimizer.state_dict(), "scaler": scaler.state_dict(),
                      "training_state": training_state, "validation": metrics}
        if average:
            checkpoint["raw_state_dict"] = model.state_dict()
        _save_checkpoint(output_dir / "last.pt", checkpoint)
        if improved:
            _save_checkpoint(output_dir / "best.pt", checkpoint)
        _log(output_dir, {"event": "validation", "best_updated": improved, **metrics})
        final_metrics = metrics
        if args.patience and epochs_without_improvement >= args.patience:
            _log(output_dir, {"event": "early_stop", "epoch": epoch + 1, "patience": args.patience,
                              "epochs_without_improvement": epochs_without_improvement})
            break
        if step >= total_steps:
            break
    _log(output_dir, {"event": "finished", "steps": step, "elapsed_seconds": time.perf_counter() - started,
                      "best_greedy_exact_match": best_score[0], "best_checkpoint": str(output_dir / "best.pt")})
    return final_metrics


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train-manifest", required=True)
    parser.add_argument("--val-manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--resume")
    parser.add_argument("--device", default="auto", help="auto, cpu, cuda, or cuda:N")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--max-steps", type=int, default=0, help="0 means all requested epochs; a short probe may end mid-epoch")
    parser.add_argument("--learning-rate", type=float, default=0.0005)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--warmup-steps", type=int, default=100)
    parser.add_argument("--grad-clip", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=1729)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--log-every", type=int, default=20)
    parser.add_argument("--eval-samples", type=int, default=None, help="Optional bounded greedy validation subset; loss still uses all validation samples")
    parser.add_argument("--augment", action="store_true", help="Training only: mild contrast, blur, and Gaussian pixel noise")
    parser.add_argument("--patience", type=int, default=0, help="Stop after this many validation epochs without improvement; 0 disables")
    parser.add_argument("--no-amp", action="store_true")
    parser.add_argument("--image-height", type=int, default=128)
    parser.add_argument("--image-width", type=int, default=512)
    parser.add_argument("--d-model", type=int, default=192)
    parser.add_argument("--nhead", type=int, default=6)
    parser.add_argument("--encoder-layers", type=int, default=2)
    parser.add_argument("--decoder-layers", type=int, default=3)
    parser.add_argument("--feedforward-dim", type=int, default=576)
    parser.add_argument("--max-tokens", type=int, default=160)
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--visual-variant", choices=VISUAL_VARIANTS, default="v1",
                        help="v1: four depthwise-separable stages; v2: full-convolution stem plus an inverted "
                             "residual block after the 1/8 and 1/16 stages")
    parser.add_argument("--teacher-model", default=None,
                        help="Name of the recogniser that produced the training labels, if any; recorded in provenance")
    parser.add_argument("--label-normalization", default=None,
                        help="Version of the rules the manifest labels were rewritten with (normalize_labels.VERSION), if any; recorded in provenance")
    parser.add_argument("--label-smoothing", type=float, default=0.0,
                        help="Cross-entropy label smoothing for the training loss only; 0 disables")
    parser.add_argument("--ema-decay", type=float, default=0.0,
                        help="Exponential moving average of weights used for validation, best.pt and export; 0 disables")
    parser.add_argument("--bn-recalibration-images", type=int, default=0,
                        help="Before every validation, recompute BatchNorm statistics on this many unaugmented "
                             f"training images (seeded); checkpoints keep them. 0 disables; {BN_RECALIBRATION_IMAGES} recommended")
    return parser


if __name__ == "__main__":
    train(build_parser().parse_args())
