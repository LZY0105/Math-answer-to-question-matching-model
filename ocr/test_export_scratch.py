"""导出检查：带缓存的解码器与整段前缀的解码器给出相同的识别结果；位置编码按行、列两张小表存放。

Run (from ocr/): python -m unittest test_export_scratch
"""

import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import onnx
import torch

from export_scratch import export_bundle
from recognize_scratch import ScratchOnnxRecognizer
from scratch_model import OCRConfig, ScratchFormulaOCR, TeXTokenizer


class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        cls.directory = tempfile.TemporaryDirectory()
        root = Path(cls.directory.name)
        torch.manual_seed(23)
        tokenizer = TeXTokenizer.from_labels([r"\frac{x^2}{3}", r"\sin x", r"a_{n}+b"])
        config = OCRConfig(image_height=32, image_width=64, d_model=32, nhead=4, encoder_layers=1,
                           decoder_layers=2, feedforward_dim=64, max_tokens=12, dropout=0, visual_variant="v2")
        model = ScratchFormulaOCR(config, len(tokenizer))
        # 输出层偏向 EOS 以外的记号，逼解码器多走几步，才看得出缓存是否接对
        with torch.no_grad():
            model.output.bias[tokenizer.eos_id] = -3
        checkpoint = root / "smoke.pt"
        torch.save({"format_version": 1, "config": config.to_dict(), "tokenizer": tokenizer.to_dict(),
                    "state_dict": model.state_dict(), "training_state": {"global_step": 0},
                    "provenance": {"initialization": "random", "pretrained_weights": False, "teacher_model": None}},
                   checkpoint)
        cls.plain, cls.cached = root / "plain", root / "cached"
        export_bundle(checkpoint, cls.plain, allow_untrained=True)
        export_bundle(checkpoint, cls.cached, cached_decoder=True, allow_untrained=True)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_cached_decoder_matches_full_prefix_decoder(self):
        plain, cached = ScratchOnnxRecognizer(self.plain), ScratchOnnxRecognizer(self.cached)
        self.assertFalse(plain.cached)
        self.assertTrue(cached.cached)
        metadata = json.loads((self.cached / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["architecture"], "scratch-formula-ocr-v1-kv")
        lengths = set()
        for seed in range(6):
            image = np.random.default_rng(seed).uniform(-1, 1, (1, 1, 32, 64)).astype(np.float32)
            expected, actual = plain.recognize_tensor(image), cached.recognize_tensor(image)
            self.assertEqual(actual["tokenIds"], expected["tokenIds"])
            self.assertEqual(actual["endedWithEos"], expected["endedWithEos"])
            self.assertAlmostEqual(actual["meanLogProbability"], expected["meanLogProbability"], places=5)
            lengths.add(len(expected["tokenIds"]))
        self.assertGreater(max(lengths), 3)

    def test_spatial_positions_are_stored_as_row_and_column_tables(self):
        for bundle in (self.plain, self.cached):
            graph = onnx.load(str(bundle / "encoder.onnx")).graph
            shapes = [tuple(tensor.dims) for tensor in graph.initializer]
            # 32×64 画布是 2×4 个位置、d=32：只剩 [2,1,16] 与 [1,4,16] 两张表，没有完整的 [1,8,32]
            self.assertIn((2, 1, 16), shapes)
            self.assertIn((1, 4, 16), shapes)
            self.assertNotIn((1, 8, 32), shapes)
            validation = json.loads((bundle / "export-validation.json").read_text(encoding="utf-8"))
            self.assertTrue(validation["spatial_positions"]["encoder_output_bit_identical"])

    def test_unknown_bundle_architecture_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory)
            for path in self.cached.iterdir():
                (copy / path.name).write_bytes(path.read_bytes())
            metadata = json.loads((copy / "metadata.json").read_text(encoding="utf-8"))
            metadata["architecture"] = "scratch-formula-ocr-v2"
            (copy / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Unsupported"):
                ScratchOnnxRecognizer(copy)


if __name__ == "__main__":
    unittest.main()
