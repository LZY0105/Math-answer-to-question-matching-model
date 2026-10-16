"""Evaluate independently labelled formula crops; never equate loss with accuracy.

Use validation for choosing quantization. Reserve test/challenge manifests until
the checkpoint and precision have been selected. No model weights are changed.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import time

TOKEN = re.compile(r"\\(?:begin|end)\{[a-zA-Z*]+\}|\\[A-Za-z]+|\\.|.", re.DOTALL)


def lexical(text):
    return [x for x in TOKEN.findall(text) if not x.isspace()]


def edit_distance(left, right):
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    model = parser.add_mutually_exclusive_group(required=True)
    model.add_argument('--checkpoint', type=Path)
    model.add_argument('--bundle', type=Path)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--limit', type=int)
    parser.add_argument('--batch-size', type=int, default=32)
    parser.add_argument('--device', default='cuda')
    parser.add_argument('--threads', type=int, default=2)
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0 or args.batch_size <= 0 or args.threads <= 0:
        parser.error('limits, batch size and threads must be positive')
    records = [json.loads(x) for x in args.manifest.read_text(encoding='utf-8').splitlines() if x.strip()]
    selected = records[:args.limit] if args.limit else records
    if not selected:
        raise ValueError('No evaluation samples')
    rows, latencies = [], []

    def record(sample, predicted, terminated):
        expected_tokens, actual_tokens = lexical(sample['latex']), lexical(predicted)
        exact = bool(terminated and expected_tokens == actual_tokens)
        rows.append({
            'id': sample['id'], 'category': sample.get('category', 'unknown'), 'image': sample['image'],
            'expected': sample['latex'], 'predicted': predicted, 'ended_with_eos': bool(terminated),
            'exact': exact, 'token_edit_distance': edit_distance(expected_tokens, actual_tokens),
            'expected_tokens': len(expected_tokens),
        })

    started = time.perf_counter()
    if args.bundle:
        from recognize_scratch import ScratchOnnxRecognizer
        recognizer = ScratchOnnxRecognizer(args.bundle, threads=args.threads)
        metadata = recognizer.metadata
        if metadata['training_status'] != 'experimental-locally-trained':
            raise ValueError('Do not report recognition accuracy for an untrained smoke bundle')
        model_info = {'runtime': 'ONNX Runtime CPU', 'threads': args.threads,
                      'bundle_metadata_sha256': file_sha(args.bundle / 'metadata.json'),
                      'weight_format': metadata['weight_format'], 'model_bytes': metadata['model_bytes'],
                      'training_steps': metadata['training_steps'], 'parameter_count': metadata['parameter_count']}
        for i, sample in enumerate(selected):
            tick = time.perf_counter()
            prediction = recognizer.recognize(args.manifest.parent / sample['image'])
            latencies.append((time.perf_counter() - tick) * 1000)
            record(sample, prediction['latex'], prediction['endedWithEos'])
            if (i + 1) % 100 == 0:
                print(json.dumps({'evaluated': i + 1, 'total': len(selected)}), flush=True)
        latency_kind = 'desktop CPU per-image preprocessing plus greedy inference; first image includes warmup'
    else:
        import torch
        from scratch_model import OCRConfig, ScratchFormulaOCR, TeXTokenizer, preprocess_image
        torch.set_num_threads(args.threads)
        checkpoint = torch.load(args.checkpoint, map_location='cpu', weights_only=True)
        if checkpoint.get('provenance', {}).get('pretrained_weights') is not False or checkpoint['training_state']['global_step'] < 1:
            raise ValueError('Expected a trained from-scratch checkpoint')
        config = OCRConfig.from_dict(checkpoint['config'])
        tokenizer = TeXTokenizer.from_dict(checkpoint['tokenizer'])
        device = torch.device(args.device)
        network = ScratchFormulaOCR(config, len(tokenizer)).to(device)
        network.load_state_dict(checkpoint['state_dict'], strict=True)
        network.eval()
        model_info = {'runtime': 'PyTorch', 'device': str(device), 'checkpoint_sha256': file_sha(args.checkpoint),
                      'training_steps': checkpoint['training_state']['global_step'], 'parameter_count': network.parameter_count(),
                      'weight_format': 'float32', 'batch_size': args.batch_size}
        with torch.inference_mode():
            for begin in range(0, len(selected), args.batch_size):
                batch = selected[begin:begin + args.batch_size]
                images = torch.stack([preprocess_image(args.manifest.parent / row['image'], config.image_height, config.image_width) for row in batch]).to(device)
                if device.type == 'cuda':
                    torch.cuda.synchronize()
                tick = time.perf_counter()
                predicted = network.generate(images)
                if device.type == 'cuda':
                    torch.cuda.synchronize()
                latencies.append((time.perf_counter() - tick) * 1000)
                for sample, ids, truncated in zip(batch, predicted.tokens.cpu().tolist(), predicted.truncated.cpu().tolist()):
                    record(sample, tokenizer.decode(ids), not truncated)
        latency_kind = 'desktop batch generation latency, excludes preprocessing; not per-image or Android latency'

    categories = defaultdict(lambda: {'samples': 0, 'exact': 0, 'missing_eos': 0})
    for row in rows:
        group = categories[row['category']]
        group['samples'] += 1
        group['exact'] += int(row['exact'])
        group['missing_eos'] += int(not row['ended_with_eos'])
    for group in categories.values():
        group['exact_rate'] = group['exact'] / group['samples']
    ordered = sorted(latencies)
    def percentile(fraction):
        return ordered[min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))]
    data_sources = Counter(sample.get('source_kind', 'supplied-pdf' if sample.get('source_pdf_sha256') else 'synthetic') for sample in selected)
    contains_pdf = 'supplied-pdf' in data_sources
    scope = ('Includes locally supplied PDF crops with assistant-verified transcriptions. Small selected page holdouts are diagnostic, not representative production accuracy.'
             if contains_pdf else 'Synthetic formula crops rendered by the same renderer as training. This does not establish real-book accuracy.')
    scope += ' No photograph, full-page, handwriting or Android-device accuracy claim.'
    report = {
        'created_at': datetime.now(timezone.utc).isoformat(), 'model': model_info,
        'manifest_sha256': file_sha(args.manifest), 'manifest_name': args.manifest.name,
        'samples': len(rows), 'manifest_samples': len(records), 'limited': len(rows) != len(records),
        'exact_count': sum(x['exact'] for x in rows), 'exact_rate': sum(x['exact'] for x in rows) / len(rows),
        'missing_eos': sum(not x['ended_with_eos'] for x in rows),
        'token_error_rate': sum(x['token_edit_distance'] for x in rows) / sum(x['expected_tokens'] for x in rows),
        'categories': dict(categories), 'elapsed_seconds': time.perf_counter() - started,
        'latency': {'kind': latency_kind, 'p50_ms': percentile(.5), 'p95_ms': percentile(.95)},
        'data_sources': dict(data_sources), 'scope': scope,
        'labels': 'Dataset canonical targets remove presentation commands; original transcriptions are retained in source_latex.' if any('source_latex' in s for s in selected) else 'Original manifest targets.',
        'comparison': 'Exact lexical TeX sequence including termination, ignoring only whitespace. It is not symbolic-equivalence grading.',
        'predictions': rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'predictions'}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
