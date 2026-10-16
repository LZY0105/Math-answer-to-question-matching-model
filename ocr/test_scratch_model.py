"""Behavior checks for autoregression and training data boundaries.

Run: python -m unittest ocr.test_scratch_model
"""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw
import torch
from torch import nn

from .recalibrate_bn import recalibrate_checkpoint
from .scratch_model import OCRConfig, ScratchFormulaOCR, TeXTokenizer, preprocess_image
from .train_scratch import (BN_BUFFER_SUFFIXES, WeightAverage, assert_disjoint, augment_training_images,
                            collate_formulas, recalibrate_batchnorm, select_recalibration_records,
                            validate_resume_best)


class FormulaModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def setUp(self):
        torch.manual_seed(17)
        self.tokenizer = TeXTokenizer.from_labels([r"\frac{x^2}{3}", r"\sin x", r"\begin{pmatrix}a&b\\c&d\end{pmatrix}"])
        self.config = OCRConfig(image_height=32, image_width=64, d_model=32, nhead=4,
                                encoder_layers=2, decoder_layers=2, feedforward_dim=64,
                                max_tokens=24, dropout=0)
        self.model = ScratchFormulaOCR(self.config, len(self.tokenizer))

    def test_lexical_round_trip_and_unknown_tokens(self):
        latex = r"\sin x+\frac{x^{2}}{3}"
        tokenizer = TeXTokenizer.from_labels([latex])
        self.assertEqual(tokenizer.decode(tokenizer.encode(latex)), latex)
        self.assertEqual(tokenizer.tokens[:3], ("<pad>", "<bos>", "<eos>"))
        self.assertEqual(TeXTokenizer.from_dict(tokenizer.to_dict()).tokens, tokenizer.tokens)
        with self.assertRaisesRegex(ValueError, "Unseen"):
            tokenizer.encode(r"\int x")
        with self.assertRaisesRegex(ValueError, "limit"):
            tokenizer.encode(latex, max_tokens=3)

    def test_future_tokens_do_not_change_earlier_logits(self):
        self.model.eval()
        images = torch.randn(1, 1, 32, 64)
        one = torch.tensor([[1, 3, 4, 5, 6]])
        two = torch.tensor([[1, 3, 4, 8, 9]])
        with torch.no_grad():
            memory = self.model.encode(images)
            logits_one = self.model.decode_logits(memory, one)
            logits_two = self.model.decode_logits(memory, two)
        torch.testing.assert_close(logits_one[:, :3], logits_two[:, :3], atol=1e-6, rtol=1e-5)
        self.assertFalse(torch.allclose(logits_one[:, 3:], logits_two[:, 3:]))

    def test_gradients_reach_visual_encoder_and_decoder(self):
        self.model.train()
        target = torch.tensor([self.tokenizer.encode(r"\sin x")])
        logits = self.model(torch.randn(1, 1, 32, 64), target[:, :-1])
        loss = nn.functional.cross_entropy(logits.reshape(-1, len(self.tokenizer)), target[:, 1:].reshape(-1))
        loss.backward()
        for weight in (self.model.visual[0][0].weight, self.model.encoder.layers[0].self_attn.in_proj_weight,
                       self.model.decoder.layers[0].multihead_attn.in_proj_weight):
            self.assertIsNotNone(weight.grad)
            self.assertTrue(torch.isfinite(weight.grad).all())
            self.assertGreater(float(weight.grad.abs().sum()), 0)
        self.assertFalse(torch.equal(self.model.encoder.layers[0].self_attn.in_proj_weight,
                                     self.model.encoder.layers[1].self_attn.in_proj_weight))

    def test_visual_variant_v2_keeps_interface_and_old_configs(self):
        # 旧检查点的 config 没有 visual_variant：按 v1 读，写回时也不多出这一项
        old = self.config.to_dict()
        self.assertNotIn("visual_variant", old)
        self.assertEqual(OCRConfig.from_dict(old).visual_variant, "v1")
        self.assertEqual(self.model.visual[0][0].weight.shape, (1, 1, 3, 3))
        config = OCRConfig.from_dict({**old, "visual_variant": "v2"})
        self.assertEqual(config.to_dict()["visual_variant"], "v2")
        self.assertEqual(OCRConfig.from_dict(config.to_dict()), config)
        with self.assertRaises(ValueError):
            OCRConfig.from_dict({**old, "visual_variant": "v3"})
        model = ScratchFormulaOCR(config, len(self.tokenizer))
        self.assertEqual(model.visual[0][0].weight.shape, (32, 1, 3, 3))
        model.eval()
        images = torch.randn(2, 1, 32, 64)
        with torch.no_grad():
            self.assertEqual(model.encode(images).shape, self.model.encode(images).shape)
            # 倒残差块投影后的 BN 缩放初始为 0：刚建好的块是恒等映射
            for block in (model.visual[3], model.visual[5]):
                features = torch.randn(2, block.body[0].in_channels, 4, 8)
                self.assertTrue(torch.equal(block(features), features))
        model.train()
        target = torch.tensor([self.tokenizer.encode(r"\sin x")])
        logits = model(images[:1], target[:, :-1])
        nn.functional.cross_entropy(logits.reshape(-1, len(self.tokenizer)), target[:, 1:].reshape(-1)).backward()
        for weight in (model.visual[0][0].weight, model.visual[5].body[-1].weight):
            self.assertIsNotNone(weight.grad)
            self.assertGreater(float(weight.grad.abs().sum()), 0)
        # BN 重估要求所有 BN 都在视觉部分里，v2 新加的块也一样
        self.assertEqual(recalibrate_batchnorm(model, [images], torch.device("cpu")), 2)

    def test_generation_reports_eos_and_token_limit(self):
        self.model.eval()
        images = torch.randn(2, 1, 32, 64)
        with torch.no_grad():
            self.model.output.weight.zero_()
            self.model.output.bias.zero_()
            self.model.output.bias[self.tokenizer.eos_id] = 100
        finished = self.model.generate(images, max_new_tokens=3)
        self.assertEqual(finished.tokens.tolist(), [[1, 2], [1, 2]])
        self.assertEqual(finished.truncated.tolist(), [False, False])
        with torch.no_grad():
            self.model.output.bias.zero_()
            self.model.output.bias[3] = 100
        unfinished = self.model.generate(images, max_new_tokens=3)
        self.assertEqual(unfinished.tokens.shape, (2, 4))
        self.assertEqual(unfinished.truncated.tolist(), [True, True])
        with self.assertRaises(ValueError):
            self.model.generate(images, max_new_tokens=self.config.max_tokens)

    def test_preprocessing_blank_alpha_padding_and_aspect(self):
        image = Image.new("RGBA", (100, 20), (0, 0, 0, 0))
        ImageDraw.Draw(image).rectangle((10, 5, 90, 15), fill=(0, 0, 0, 255))
        result = preprocess_image(image, 32, 64)
        self.assertEqual(result.shape, (1, 32, 64))
        self.assertEqual(float(result.min()), -1)
        self.assertEqual(float(result.max()), 1)
        self.assertTrue(torch.all(result[:, :4] == 1))
        self.assertTrue(torch.all(result[:, :, :4] == 1))
        with self.assertRaisesRegex(ValueError, "blank"):
            preprocess_image(Image.new("L", (12, 20), 255), 32, 64)

    def test_collate_pads_after_eos(self):
        image = torch.zeros(1, 32, 64)
        _, targets, labels = collate_formulas([(image, torch.tensor([1, 4, 2]), "x"),
                                               (image, torch.tensor([1, 4, 4, 2]), "xx")])
        self.assertEqual(targets.tolist(), [[1, 4, 2, 0], [1, 4, 4, 2]])
        self.assertEqual(labels, ["x", "xx"])

    def test_augmentation_is_bounded_and_does_not_mutate_source(self):
        image = torch.ones(2, 1, 32, 64)
        image[:, :, 10:20, 10:40] = -1
        original = image.clone()
        torch.manual_seed(41)
        augmented = augment_training_images(image)
        self.assertEqual(augmented.shape, image.shape)
        self.assertTrue(torch.isfinite(augmented).all())
        self.assertGreaterEqual(float(augmented.min()), -1)
        self.assertLessEqual(float(augmented.max()), 1)
        torch.testing.assert_close(image, original, atol=0, rtol=0)
        self.assertLess(float(augmented[:, :, 12:18, 12:38].mean()), -0.5)
        self.assertGreater(float(augmented[:, :, :4, :4].mean()), 0.8)

    def test_weight_average_tracks_weights_and_always_swaps_back(self):
        model = nn.Linear(1, 1, bias=False)
        with torch.no_grad():
            model.weight.fill_(1.0)
        average = WeightAverage(model, decay=0.9)
        with torch.no_grad():
            model.weight.fill_(3.0)
        average.update(model, step=0)        # 前期衰减取 min(0.9, 1/10) = 0.1
        self.assertAlmostEqual(float(average.shadow["weight"]), 0.1 * 1 + 0.9 * 3, places=5)
        average.update(model, step=1000)     # 之后固定为 0.9
        expected = 0.9 * 2.8 + 0.1 * 3
        self.assertAlmostEqual(float(average.shadow["weight"]), expected, places=5)
        with average.applied(model):
            self.assertAlmostEqual(float(model.weight), expected, places=5)
        self.assertEqual(float(model.weight), 3.0)
        with self.assertRaisesRegex(RuntimeError, "boom"):
            with average.applied(model):
                raise RuntimeError("boom")
        self.assertEqual(float(model.weight), 3.0)
        with self.assertRaises(ValueError):
            WeightAverage(model, decay=1.0)

    def test_weight_average_copies_non_float_buffers(self):
        average = WeightAverage(self.model, decay=0.99)
        average.update(self.model, step=5)
        state = self.model.state_dict()
        for name, value in average.shadow.items():
            self.assertEqual(value.dtype, state[name].dtype, name)
            if not value.dtype.is_floating_point:
                self.assertTrue(torch.equal(value, state[name]), name)
        restored = ScratchFormulaOCR(self.config, len(self.tokenizer))
        restored.load_state_dict(average.state_dict(), strict=True)

    def test_batchnorm_recalibration_uses_the_given_images_only(self):
        images = torch.randn(6, 1, 32, 64)
        first = self.model.visual[0][1]                      # 第一层 BN，输入是第一个卷积的输出
        with torch.no_grad():
            inputs = self.model.visual[0][0](images)
        untouched = {name: value.clone() for name, value in self.model.state_dict().items()
                     if not name.endswith(BN_BUFFER_SUFFIXES)}
        self.model.train()
        self.assertEqual(recalibrate_batchnorm(self.model, [images[:3], images[3:]], torch.device("cpu")), 6)
        # 两批等大：均值是全部图的均值，方差是两批无偏方差的平均
        torch.testing.assert_close(first.running_mean, inputs.mean(dim=(0, 2, 3)))
        expected_var = (inputs[:3].var(dim=(0, 2, 3), correction=1) + inputs[3:].var(dim=(0, 2, 3), correction=1)) / 2
        torch.testing.assert_close(first.running_var, expected_var)
        self.assertTrue(self.model.training)
        self.assertEqual(first.momentum, 0.1)
        for name, value in self.model.state_dict().items():
            if name in untouched:
                self.assertTrue(torch.equal(value, untouched[name]), name)
        with self.assertRaisesRegex(ValueError, "No images"):
            recalibrate_batchnorm(self.model, [], torch.device("cpu"))

    def test_recalibration_records_are_seeded_and_bounded(self):
        records = [{"id": index} for index in range(10)]
        picked = select_recalibration_records(records, 4, seed=3)
        self.assertEqual(len(picked), 4)
        self.assertEqual(picked, select_recalibration_records(records, 4, seed=3))
        self.assertEqual([row["id"] for row in records], list(range(10)))
        self.assertEqual(sorted(row["id"] for row in select_recalibration_records(records, 50, seed=3)), list(range(10)))
        with self.assertRaises(ValueError):
            select_recalibration_records(records, 0)

    def test_recalibrated_checkpoint_changes_only_batchnorm_statistics(self):
        temporary_root = Path(__file__).resolve().parents[1] / "tmp"
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root) as directory:
            root = Path(directory)
            rows = []
            for index in range(6):
                image = Image.new("L", (64, 32), 255)
                ImageDraw.Draw(image).rectangle((4 + index, 6, 40 + 3 * index, 20 + index), fill=index * 30)
                image.save(root / f"{index}.png")
                rows.append(json.dumps({"image": f"{index}.png", "latex": r"\sin x"}))
            manifest = root / "train.jsonl"
            manifest.write_text("\n".join(rows) + "\n", encoding="utf-8")
            source = root / "last.pt"
            torch.save({"format_version": 1, "config": self.config.to_dict(), "tokenizer": self.tokenizer.to_dict(),
                        "state_dict": self.model.state_dict(),
                        "provenance": {"train_manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest()}},
                       source)
            result = recalibrate_checkpoint(source, manifest, root / "a.pt", images=4, seed=1)
            recalibrate_checkpoint(source, manifest, root / "b.pt", images=4, seed=1)
            self.assertEqual(result["images"], 4)
            original = torch.load(source, weights_only=True)
            first = torch.load(root / "a.pt", weights_only=True)
            second = torch.load(root / "b.pt", weights_only=True)
            self.assertEqual(first["provenance"]["bn_recalibration"]["images"], 4)
            self.assertEqual(first["provenance"]["bn_recalibration"]["when"], "after training")
            changed = [name for name, value in first["state_dict"].items()
                       if not torch.equal(value, original["state_dict"][name])]
            self.assertTrue(changed)
            self.assertTrue(all(name.endswith(BN_BUFFER_SUFFIXES) for name in changed), changed)
            for name, value in first["state_dict"].items():
                self.assertTrue(torch.equal(value, second["state_dict"][name]), name)
            with self.assertRaisesRegex(ValueError, "new file"):
                recalibrate_checkpoint(source, manifest, source)
            manifest.write_text("\n".join(rows[:5]) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "trained on"):
                recalibrate_checkpoint(source, manifest, root / "c.pt", images=4, seed=1)

    def test_checkpoint_can_load_without_pickle_execution(self):
        temporary_root = Path(__file__).resolve().parents[1] / "tmp"
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root) as directory:
            path = Path(directory) / "weights.pt"
            torch.save({"config": self.config.to_dict(), "tokenizer": self.tokenizer.to_dict(),
                        "state_dict": self.model.state_dict()}, path)
            restored = torch.load(path, weights_only=True)
            model = ScratchFormulaOCR(OCRConfig.from_dict(restored["config"]), len(TeXTokenizer.from_dict(restored["tokenizer"])))
            model.load_state_dict(restored["state_dict"], strict=True)

    def test_split_leakage_rejects_formula_or_copied_image(self):
        temporary_root = Path(__file__).resolve().parents[1] / "tmp"
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root) as directory:
            first, second = Path(directory) / "first.png", Path(directory) / "second.png"
            first.write_bytes(b"original image")
            second.write_bytes(b"different image")
            train = [{"image_path": str(first), "latex": r"\sin x"}]
            validation = [{"image_path": str(second), "latex": r"\sin   x"}]
            with self.assertRaisesRegex(ValueError, "leakage"):
                assert_disjoint(train, validation)
            validation[0]["latex"] = "y"
            assert_disjoint(train, validation)
            second.write_bytes(first.read_bytes())
            with self.assertRaisesRegex(ValueError, "image-file hashes"):
                assert_disjoint(train, validation)

    def test_resume_preserves_the_actual_historical_best(self):
        temporary_root = Path(__file__).resolve().parents[1] / "tmp"
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root) as directory:
            output = Path(directory)
            resumed = {"config": {}, "tokenizer": {}, "provenance": {},
                       "training_state": {"best_score": [0.8, -0.1], "global_step": 30}}
            best = {**resumed, "training_state": {"best_score": [0.8, -0.1], "global_step": 20}}
            with self.assertRaisesRegex(ValueError, "original output directory"):
                validate_resume_best(output / "new-run", output / "last.pt", resumed)
            with self.assertRaisesRegex(ValueError, "original best.pt"):
                validate_resume_best(output, output / "last.pt", resumed)
            torch.save(best, output / "best.pt")
            validate_resume_best(output, output / "last.pt", resumed)
            best["training_state"]["best_score"] = [0.9, -0.1]
            torch.save(best, output / "best.pt")
            with self.assertRaisesRegex(ValueError, "historical best"):
                validate_resume_best(output, output / "last.pt", resumed)


if __name__ == "__main__":
    unittest.main()
