"""Checks for crop geometry and preventing unverified/leaked PDF labels."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

from . import import_pdf_formulas as importer


class PdfImportTests(unittest.TestCase):
    def setUp(self):
        self.meta = {"book": {"sha256": "same-pdf", "page_count": 2,
                              "pages": [{"width": 100, "height": 100}] * 2}}

    def wrapped(self, identifier="a", page=1, split="train", latex="x+1", **changes):
        row = dict(id=identifier, source="book", page=page, split=split,
                   latex=latex, bbox=[10, 10, 60, 60], review_status="visual-verified")
        row.update(changes)
        return {"annotation": row, "line": 1}

    def test_invalid_annotations_are_rejected(self):
        for change in [dict(review_status="pending"), dict(latex=" "), dict(page=True),
                       dict(bbox=[0, 0, 101, 10]), dict(bbox=[0, 0, float("nan"), 5]),
                       dict(source="unknown")]:
            accepted, rejected = importer.validate_annotations([self.wrapped(**change)], self.meta)
            self.assertEqual(accepted, [])
            self.assertEqual(len(rejected), 1)

    def test_same_page_through_source_aliases_cannot_cross_splits(self):
        self.meta["alias"] = self.meta["book"]
        rows = [self.wrapped(), self.wrapped("b", split="test", latex="y", source="alias")]
        accepted, rejected = importer.validate_annotations(rows, self.meta)
        self.assertFalse(accepted)
        self.assertTrue(all("page_shared_across_splits" in row["reasons"] for row in rejected))

    def test_same_label_on_different_pages_cannot_cross_splits(self):
        rows = [self.wrapped(), self.wrapped("b", page=2, split="validation", latex="x + 1")]
        accepted, rejected = importer.validate_annotations(rows, self.meta)
        self.assertFalse(accepted)
        self.assertTrue(all("canonical_latex_shared_across_splits" in row["reasons"] for row in rejected))

    def test_duplicate_ids_are_rejected_on_both_sides(self):
        accepted, rejected = importer.validate_annotations([self.wrapped(), self.wrapped(latex="y")], self.meta)
        self.assertFalse(accepted)
        self.assertEqual(len(rejected), 2)

    def test_crop_uses_actual_render_dimensions_and_rejects_blank(self):
        image = Image.new("RGB", (200, 400), "white")
        ImageDraw.Draw(image).rectangle((20, 80, 40, 120), fill="black")
        crop = importer.crop_region(image, [10, 20, 21, 31], {"width": 100, "height": 100})
        self.assertEqual(crop.size, (22, 44))
        with self.assertRaisesRegex(ValueError, "crop_is_blank"):
            importer.crop_region(image, [70, 70, 80, 80], {"width": 100, "height": 100})

    def test_candidate_font_detector_includes_mathtime_but_not_chinese(self):
        for name in ["ABCDEF+CMMI10", "ABCDEF+MT2MIT", "ABCDEF+MT2SYF", "ABCDEF+MT2EXA"]:
            self.assertIsNotNone(importer._MATH_FONT.search(name))
        self.assertIsNone(importer._MATH_FONT.search("ABCDEF+FandolSong-Regular"))

    def _import(self, folder, rows):
        source = folder / "fixture.pdf"
        source.write_bytes(b"mock PDF; renderer and metadata replaced in this unit test")
        metadata = {"book": {**self.meta["book"], "path": str(source),
                              "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}}
        annotations = folder / "annotations.jsonl"
        annotations.write_text("".join(json.dumps(row["annotation"]) + "\n" for row in rows), encoding="utf-8")
        def render(pdf, page, prefix, renderer, dpi):
            image = Image.new("RGB", (100, 100), "white")
            ImageDraw.Draw(image).rectangle((20, 20, 40, 40), fill="black")
            path = prefix.with_suffix(".png")
            image.save(path)
            return path
        output = folder / "dataset"
        with patch.object(importer, "source_metadata", return_value=metadata), patch.object(importer, "render_page", side_effect=render):
            result = importer.import_annotations({"book": source}, annotations, output)
        return result, output

    def test_import_publishes_readable_relative_images_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            result, output = self._import(folder, [self.wrapped()])
            self.assertEqual(result["accepted"], 1)
            row = json.loads((output / "train.jsonl").read_text(encoding="utf-8"))
            self.assertTrue((output / row["image"]).is_file())
            self.assertTrue((output / "import-report.json").is_file())
            with self.assertRaises(FileExistsError):
                importer.import_annotations({}, folder / "annotations.jsonl", output)

    def test_identical_images_with_conflicting_labels_are_not_adopted(self):
        with tempfile.TemporaryDirectory() as name:
            result, _ = self._import(Path(name), [self.wrapped(), self.wrapped("b", page=2, latex="y")])
            self.assertEqual(result["accepted"], 0)
            self.assertEqual(result["rejection_reasons"], {"same_image_conflicting_labels": 2})

    def test_identical_images_cannot_cross_splits_even_with_different_labels(self):
        with tempfile.TemporaryDirectory() as name:
            result, _ = self._import(Path(name), [self.wrapped(), self.wrapped("b", page=2, split="test", latex="y")])
            self.assertEqual(result["accepted"], 0)
            self.assertEqual(result["rejection_reasons"], {"image_shared_across_splits": 2})


if __name__ == "__main__":
    unittest.main()
