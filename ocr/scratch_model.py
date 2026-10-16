"""A formula recognizer initialized from scratch, with no external model weights.

This module owns the architecture, lexical TeX vocabulary, image preprocessing,
and autoregressive inference shared by training and deployment export. It does
not download assets or load any pretrained tokenizer or network.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import re
from typing import Iterable, NamedTuple

import torch
from torch import Tensor, nn
from PIL import Image, ImageChops


_TEX_TOKEN = re.compile(r"\\(?:begin|end)\{[a-zA-Z*]+\}|\\[A-Za-z]+|\\.|.", re.DOTALL)
_CONTROL_WORD = re.compile(r"\\[A-Za-z]+$")
_SPECIAL = ("<pad>", "<bos>", "<eos>")
VISUAL_VARIANTS = ("v1", "v2")


class TeXTokenizer:
    """A dataset-derived TeX lexer; unknown tokens are errors, never substitutions.

    Whitespace separates control words but is otherwise insignificant. This
    tokenizer targets mathematical TeX, not text-mode commands with spaces.
    """

    pad_id = 0
    bos_id = 1
    eos_id = 2
    version = 1

    def __init__(self, tokens: Iterable[str]):
        self.tokens = tuple(tokens)
        if self.tokens[:3] != _SPECIAL or len(set(self.tokens)) != len(self.tokens):
            raise ValueError("Vocabulary must start with unique PAD, BOS, EOS tokens")
        if any(not isinstance(token, str) or not token for token in self.tokens):
            raise ValueError("Vocabulary entries must be nonempty strings")
        self.token_to_id = {token: index for index, token in enumerate(self.tokens)}

    def __len__(self) -> int:
        return len(self.tokens)

    @staticmethod
    def tokenize(latex: str) -> list[str]:
        if not isinstance(latex, str):
            raise TypeError("LaTeX must be a string")
        return [token for token in _TEX_TOKEN.findall(latex) if not token.isspace()]

    @classmethod
    def from_labels(cls, labels: Iterable[str]) -> "TeXTokenizer":
        vocabulary = {token for latex in labels for token in cls.tokenize(latex)}
        if not vocabulary:
            raise ValueError("Cannot build a vocabulary from empty formulas")
        return cls((*_SPECIAL, *sorted(vocabulary)))

    def encode(self, latex: str, max_tokens: int | None = None) -> list[int]:
        tokens = self.tokenize(latex)
        if not tokens:
            raise ValueError("An empty formula cannot be a training target")
        missing = sorted(set(tokens) - self.token_to_id.keys())
        if missing:
            raise ValueError(f"Unseen TeX tokens: {missing!r}")
        ids = [self.bos_id, *(self.token_to_id[token] for token in tokens), self.eos_id]
        if max_tokens is not None and len(ids) > max_tokens:
            raise ValueError(f"Formula requires {len(ids)} tokens including BOS/EOS, limit is {max_tokens}")
        return ids

    def decode(self, ids: Iterable[int]) -> str:
        pieces: list[str] = []
        previous = ""
        for raw_index in ids:
            index = int(raw_index)
            if index == self.eos_id:
                break
            if index in (self.pad_id, self.bos_id):
                continue
            if index < 0 or index >= len(self.tokens):
                raise ValueError(f"Token id {index} is outside vocabulary")
            token = self.tokens[index]
            if _CONTROL_WORD.fullmatch(previous) and re.match(r"[A-Za-z]", token):
                pieces.append(" ")
            pieces.append(token)
            previous = token
        return "".join(pieces)

    def canonicalize(self, latex: str) -> str:
        return self.decode(self.encode(latex))

    def to_dict(self) -> dict:
        return {"version": self.version, "tokens": list(self.tokens)}

    @classmethod
    def from_dict(cls, data: dict) -> "TeXTokenizer":
        if data.get("version") != cls.version:
            raise ValueError("Unsupported tokenizer version")
        return cls(data["tokens"])

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> "TeXTokenizer":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))


@dataclass(frozen=True)
class OCRConfig:
    image_height: int = 128
    image_width: int = 512
    d_model: int = 192
    nhead: int = 6
    encoder_layers: int = 2
    decoder_layers: int = 3
    feedforward_dim: int = 576
    max_tokens: int = 160
    dropout: float = 0.1
    # 视觉部分：v1 为四段深度可分离卷积；v2 第一层改普通卷积，1/8、1/16 两段后各加一个倒残差块
    visual_variant: str = "v1"

    def __post_init__(self) -> None:
        if self.image_height % 16 or self.image_width % 16 or min(self.image_height, self.image_width) < 16:
            raise ValueError("Image dimensions must be positive multiples of 16")
        if self.d_model <= 0 or self.nhead <= 0 or self.d_model % 4 or self.d_model % self.nhead:
            raise ValueError("d_model must be divisible by both four and nhead")
        if self.max_tokens < 3 or min(self.encoder_layers, self.decoder_layers, self.feedforward_dim) <= 0:
            raise ValueError("Invalid sequence or layer configuration")
        if not 0 <= self.dropout < 1:
            raise ValueError("Dropout must be in [0, 1)")
        if self.visual_variant not in VISUAL_VARIANTS:
            raise ValueError(f"visual_variant must be one of {VISUAL_VARIANTS}")

    def to_dict(self) -> dict:
        data = asdict(self)
        # 默认的 v1 不写这一项：与旧检查点、旧导出包里的 config 逐项相等，续训比对和 metadata 都不变
        if data["visual_variant"] == "v1":
            del data["visual_variant"]
        return data

    @classmethod
    def from_dict(cls, data: dict) -> "OCRConfig":
        return cls(**data)


def preprocess_image(image: str | Path | Image.Image, image_height: int = 128, image_width: int = 512) -> Tensor:
    """White-pad a tight formula crop, preserve aspect ratio, normalize to [-1,1].

    Transparent pixels are composited on white before conversion. A nonwhite
    bounding box removes source margins; a four-pixel output margin is retained.
    The same routine must be used for training, evaluation, and exported inference.
    """
    if image_height < 16 or image_width < 16:
        raise ValueError("Image dimensions must be at least 16 pixels")
    if not isinstance(image, Image.Image):
        with Image.open(image) as opened:
            return preprocess_image(opened.copy(), image_height, image_width)
    if "A" in image.getbands() or "transparency" in image.info:
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        gray = Image.alpha_composite(background, rgba).convert("L")
    else:
        gray = image.convert("L")
    # Threshold only the bounding-box mask; retain antialiasing in the real image.
    difference = ImageChops.difference(gray, Image.new("L", gray.size, 255))
    bbox = difference.point(lambda value: 255 if value > 10 else 0).getbbox()
    if bbox is None:
        raise ValueError("Input crop is blank; no formula pixels found")
    gray = gray.crop(bbox)
    scale = min((image_width - 8) / gray.width, (image_height - 8) / gray.height)
    size = (max(1, round(gray.width * scale)), max(1, round(gray.height * scale)))
    gray = gray.resize(size, Image.Resampling.LANCZOS)
    canvas = Image.new("L", (image_width, image_height), 255)
    canvas.paste(gray, ((image_width - size[0]) // 2, (image_height - size[1]) // 2))
    # A bytearray is writable and avoids NumPy as a preprocessing dependency.
    pixels = torch.frombuffer(bytearray(canvas.tobytes()), dtype=torch.uint8)
    return pixels.reshape(1, image_height, image_width).float().div_(127.5).sub_(1.0)


def _sinusoidal(length: int, dimensions: int) -> Tensor:
    position = torch.arange(length, dtype=torch.float32).unsqueeze(1)
    frequency = torch.exp(torch.arange(0, dimensions, 2, dtype=torch.float32) * (-math.log(10000.0) / dimensions))
    result = torch.zeros(length, dimensions)
    result[:, 0::2] = torch.sin(position * frequency)
    result[:, 1::2] = torch.cos(position * frequency)
    return result


def _spatial_positions(height: int, width: int, dimensions: int) -> Tensor:
    row = _sinusoidal(height, dimensions // 2)[:, None, :].expand(-1, width, -1)
    column = _sinusoidal(width, dimensions // 2)[None, :, :].expand(height, -1, -1)
    return torch.cat((row, column), dim=-1).reshape(1, height * width, dimensions)


class _ConvStage(nn.Sequential):
    def __init__(self, input_channels: int, output_channels: int):
        super().__init__(
            nn.Conv2d(input_channels, input_channels, 3, stride=2, padding=1, groups=input_channels, bias=False),
            nn.BatchNorm2d(input_channels),
            nn.ReLU(inplace=False),
            nn.Conv2d(input_channels, output_channels, 1, bias=False),
            nn.BatchNorm2d(output_channels),
            nn.ReLU(inplace=False),
            nn.Conv2d(output_channels, output_channels, 3, padding=1, groups=output_channels, bias=False),
            nn.BatchNorm2d(output_channels),
            nn.ReLU(inplace=False),
        )


class _StemStage(nn.Sequential):
    """v2 的第一段：普通 3×3 卷积直接从灰度图取出多个特征。

    v1 的第一段在单通道输入上做逐通道卷积，等于只有一个 3×3 滤波器：整张图先被压成半分辨率的
    一张特征图再过 ReLU，后面所有特征都只能从这一张图里取。
    """

    def __init__(self, output_channels: int):
        super().__init__(
            nn.Conv2d(1, output_channels, 3, stride=2, padding=1, bias=False),
            nn.BatchNorm2d(output_channels),
            nn.ReLU(inplace=False),
            nn.Conv2d(output_channels, output_channels, 3, padding=1, groups=output_channels, bias=False),
            nn.BatchNorm2d(output_channels),
            nn.ReLU(inplace=False),
        )


class _InvertedResidual(nn.Module):
    """MobileNetV2 式倒残差块：1×1 扩张 → 3×3 逐通道 → 1×1 投影，再加回输入。

    投影后的 BN 缩放初始为 0，块在训练开始时等于恒等映射，加深不会扰乱初期训练。
    """

    def __init__(self, channels: int, expansion: int):
        super().__init__()
        hidden = channels * expansion
        self.body = nn.Sequential(
            nn.Conv2d(channels, hidden, 1, bias=False),
            nn.BatchNorm2d(hidden),
            nn.ReLU(inplace=False),
            nn.Conv2d(hidden, hidden, 3, padding=1, groups=hidden, bias=False),
            nn.BatchNorm2d(hidden),
            nn.ReLU(inplace=False),
            nn.Conv2d(hidden, channels, 1, bias=False),
            nn.BatchNorm2d(channels),
        )
        nn.init.zeros_(self.body[-1].weight)

    def forward(self, features: Tensor) -> Tensor:
        return features + self.body(features)


class GenerationResult(NamedTuple):
    tokens: Tensor
    truncated: Tensor


class ScratchFormulaOCR(nn.Module):
    """Small convolution + 2D transformer encoder + causal TeX decoder."""

    architecture_version = "scratch-formula-ocr-v1"

    def __init__(self, config: OCRConfig, vocab_size: int):
        super().__init__()
        if vocab_size <= len(_SPECIAL):
            raise ValueError("Vocabulary must contain formula tokens")
        self.config = config
        self.vocab_size = vocab_size
        if config.visual_variant == "v2":
            self.visual = nn.Sequential(
                _StemStage(32), _ConvStage(32, 64),
                _ConvStage(64, 96), _InvertedResidual(96, 4),
                _ConvStage(96, config.d_model), _InvertedResidual(config.d_model, 2),
            )
        else:
            self.visual = nn.Sequential(
                _ConvStage(1, 32), _ConvStage(32, 64),
                _ConvStage(64, 96), _ConvStage(96, config.d_model),
            )
        self.register_buffer("spatial_positions", _spatial_positions(config.image_height // 16, config.image_width // 16, config.d_model))
        self.register_buffer("token_positions", _sinusoidal(config.max_tokens, config.d_model).unsqueeze(0))
        self.register_buffer("causal_mask", torch.triu(torch.ones(config.max_tokens, config.max_tokens, dtype=torch.bool), diagonal=1))
        self.visual_norm = nn.LayerNorm(config.d_model)
        encoder_layer = nn.TransformerEncoderLayer(
            config.d_model, config.nhead, config.feedforward_dim, config.dropout,
            activation="relu", batch_first=True, norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, config.encoder_layers, norm=nn.LayerNorm(config.d_model), enable_nested_tensor=False)
        self.embedding = nn.Embedding(vocab_size, config.d_model, padding_idx=TeXTokenizer.pad_id)
        decoder_layer = nn.TransformerDecoderLayer(
            config.d_model, config.nhead, config.feedforward_dim, config.dropout,
            activation="relu", batch_first=True, norm_first=True,
        )
        self.decoder = nn.TransformerDecoder(decoder_layer, config.decoder_layers, norm=nn.LayerNorm(config.d_model))
        self.output = nn.Linear(config.d_model, vocab_size)
        self.dropout = nn.Dropout(config.dropout)
        self.apply(self._initialize)

    @staticmethod
    def _initialize(module: nn.Module) -> None:
        if isinstance(module, (nn.Linear, nn.Conv2d)):
            nn.init.xavier_uniform_(module.weight)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0, std=0.02)
            if module.padding_idx is not None:
                with torch.no_grad():
                    module.weight[module.padding_idx].zero_()
        elif isinstance(module, nn.MultiheadAttention):
            # Transformer stacks are cloned by PyTorch; initialize each cloned
            # packed Q/K/V projection independently as well as their linears.
            if module.in_proj_weight is not None:
                nn.init.xavier_uniform_(module.in_proj_weight)
            if module.in_proj_bias is not None:
                nn.init.zeros_(module.in_proj_bias)

    def parameter_count(self) -> int:
        return sum(parameter.numel() for parameter in self.parameters())

    def encode(self, images: Tensor) -> Tensor:
        features = self.visual(images).flatten(2).transpose(1, 2)
        features = self.visual_norm(features) + self.spatial_positions
        return self.encoder(self.dropout(features))

    def decode_logits(self, memory: Tensor, tokens: Tensor) -> Tensor:
        length = tokens.shape[1]
        embedded = self.embedding(tokens) * math.sqrt(self.config.d_model)
        embedded = self.dropout(embedded + self.token_positions[:, :length])
        decoded = self.decoder(
            embedded, memory,
            tgt_mask=self.causal_mask[:length, :length],
            tgt_key_padding_mask=tokens.eq(TeXTokenizer.pad_id),
        )
        return self.output(decoded)

    def forward(self, images: Tensor, tokens: Tensor) -> Tensor:
        return self.decode_logits(self.encode(images), tokens)

    @torch.no_grad()
    def generate(self, images: Tensor, max_new_tokens: int | None = None) -> GenerationResult:
        """Greedy inference with an explicit unfinished-sequence flag per image.

        This is intentionally an eager loop. Export ``encode`` and
        ``decode_logits`` separately and run a bounded decoder loop on device.
        Call ``eval()`` first to disable dropout and freeze batch normalization.
        """
        if self.training:
            raise RuntimeError("Call model.eval() before generation")
        limit = self.config.max_tokens - 1 if max_new_tokens is None else max_new_tokens
        if not isinstance(limit, int) or not 1 <= limit <= self.config.max_tokens - 1:
            raise ValueError("max_new_tokens must be between 1 and max_tokens - 1")
        memory = self.encode(images)
        tokens = torch.full((images.shape[0], 1), TeXTokenizer.bos_id, dtype=torch.long, device=images.device)
        finished = torch.zeros(images.shape[0], dtype=torch.bool, device=images.device)
        for _ in range(limit):
            logits = self.decode_logits(memory, tokens)[:, -1, :]
            # BOS and PAD have no role as generated formula content.
            logits[:, TeXTokenizer.pad_id] = -torch.inf
            logits[:, TeXTokenizer.bos_id] = -torch.inf
            next_token = logits.argmax(dim=-1)
            next_token = torch.where(finished, TeXTokenizer.pad_id, next_token)
            tokens = torch.cat((tokens, next_token[:, None]), dim=1)
            finished = finished | next_token.eq(TeXTokenizer.eos_id)
            if bool(finished.all()):
                break
        return GenerationResult(tokens, ~finished)
