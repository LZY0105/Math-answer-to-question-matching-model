import json
from pathlib import Path
import tempfile
import unittest

from .prepare_mixed_data import normalize_label, prepare


class MixedDataTests(unittest.TestCase):
    def test_only_presentation_commands_are_removed(self):
        self.assertEqual(normalize_label(r"\left(\frac{x}{y}\right)^{2}\,dx"), r"(\frac{x}{y})^{2}dx")
        self.assertEqual(normalize_label(r"x\leftarrow y\cdot z"), r"x\leftarrow y\cdot z")
        self.assertEqual(normalize_label(r"\left\{x\right."), r"\{x")
        self.assertEqual(normalize_label(r"x.\quad y"), "x.y")
        self.assertEqual(normalize_label(r"\sin\,x"), r"\sin x")

    def test_reserved_normalized_labels_exclude_training_and_repeats_stay_in_train(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            synthetic, symbols, pdf = [root / name for name in ('synthetic', 'symbols', 'pdf')]
            counter = 0
            def data(folder, name, labels):
                nonlocal counter
                folder.mkdir(exist_ok=True)
                rows = []
                for label in labels:
                    image = f'{counter}.png'
                    # Mixing hashes bytes; image decoding is separately tested by the PDF importer.
                    (folder / image).write_bytes(str(counter).encode())
                    rows.append(dict(id=str(counter), image=image, latex=label, review_status='visual-verified'))
                    counter += 1
                (folder / name).write_text(''.join(json.dumps(r)+'\n' for r in rows), encoding='utf-8')
            data(synthetic, 'train.jsonl', [r'\left(x\right)', 'x+y', 'y+x', 'x', 'y'])
            data(synthetic, 'validation.jsonl', ['x-y'])
            data(synthetic, 'test.jsonl', ['x+y+y'])
            data(synthetic, 'challenge.jsonl', ['x+y+x'])
            data(symbols, 'train.jsonl', ['x-y+x'])
            data(pdf, 'train.jsonl', ['y-y'])
            data(pdf, 'validation.jsonl', ['y-x'])
            data(pdf, 'test.jsonl', ['(x)'])
            # Independent notation coverage supplies every validation token.
            data(symbols, 'train.jsonl', ['x-y+x', '(y)'])
            for folder, marker in [(synthetic,'data-manifest.json'),(symbols,'data-manifest.json'),(pdf,'import-report.json')]:
                (folder / marker).write_text('{}', encoding='utf-8')
            output = root / 'mixed'
            report = prepare(synthetic, symbols, pdf, output, repeats=3)
            train = [json.loads(s) for s in (output/'train.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertNotIn('(x)', [r['latex'] for r in train])
            self.assertEqual(sum(r['source_kind']=='supplied-pdf' for r in train), 3)
            self.assertEqual(report['manifests']['pdf-test']['samples'], 1)
            self.assertTrue(any(r['reason']=='training_overlaps_reserved_evaluation' for r in report['rejected']))
            self.assertTrue(all((output/r['image']).is_file() for r in train))


if __name__ == '__main__':
    unittest.main()
