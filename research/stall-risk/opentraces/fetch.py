#!/usr/bin/env python3
"""Reproduce the pinned HOK-3478 sample using public HTTP and stdlib only.
Raw records remain in ignored .cache/. No SDK, credentials, uploads or training.
"""
import argparse
import collections
import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(manifest):
    audit = json.loads((ROOT / 'assessments.json').read_text())
    by_name = {x['sample']: x for x in audit['rows']}
    counts = collections.Counter()
    for sample in manifest['samples']:
        raw = (ROOT / '.cache/samples' / sample['local_name']).read_bytes().rstrip(b'\n')
        if digest(raw) != sample['record_sha256']:
            raise ValueError('record digest mismatch: ' + sample['local_name'])
        row, assessed = json.loads(raw), by_name[sample['local_name']]
        if row['trace_id'] != sample['trace_id']:
            raise ValueError('trace id mismatch')
        for parent, key, field in [('agent', 'model', 'agent_model'),
                                   ('outcome', 'success', 'success'),
                                   ('outcome', 'signal_confidence', 'signal_confidence'),
                                   ('metrics', 'estimated_cost_usd', 'estimated_cost_usd')]:
            if (row.get(parent) or {}).get(key) != assessed[field]:
                raise ValueError('assessment mismatch: ' + field)
        counts[sample['dataset_id']] += 1
    if len(by_name) != len(manifest['samples']) or len(by_name) != 50:
        raise ValueError('sample/assessment cardinality mismatch')
    labels = dict(collections.Counter(x['label'] for x in audit['rows']))
    labels.setdefault('positive', 0)
    labels.setdefault('negative', 0)
    if audit['labels'] != labels:
        raise ValueError('label count mismatch')
    print(json.dumps({'verified_records': len(by_name), 'source_counts': counts,
                      'labels': labels}, indent=2))


def reproduce(manifest):
    wanted = {(x['dataset_id'], x['file_path'], x['line_index']): x
              for x in manifest['samples']}
    top, total, extracted = [], 0, {}
    for shard in manifest['file_frame']:
        source, path = shard['dataset_id'], shard['file_path']
        cached = ROOT / '.cache/shards' / (shard['source_file_sha256'] + '.jsonl')
        cached.parent.mkdir(parents=True, exist_ok=True)
        if not cached.exists():
            url = f"https://huggingface.co/datasets/{source}/resolve/{shard['revision']}/{path}"
            req = urllib.request.Request(url, headers={'User-Agent': 'HOK-3478-read-only-audit'})
            with urllib.request.urlopen(req, timeout=60) as response, cached.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        h = hashlib.sha256()
        with cached.open('rb') as stream:
            for line_number, line in enumerate(stream, 1):
                h.update(line)
                if not line.strip():
                    continue
                row = json.loads(line)
                if not row.get('trace_id'):
                    continue
                total += 1
                key = digest((manifest['sample_seed'] + row['trace_id']).encode())
                top.append((key, source, path, line_number, row['trace_id']))
                top.sort()
                del top[50:]
                sample = wanted.get((source, path, line_number))
                if sample:
                    raw = line.rstrip(b'\r\n')
                    if digest(raw) != sample['record_sha256']:
                        raise ValueError('pinned record mismatch: ' + sample['local_name'])
                    extracted[sample['local_name']] = raw
        if h.hexdigest() != shard['source_file_sha256']:
            raise ValueError('shard digest mismatch: ' + path)
        print('verified shard:', source, path, flush=True)
    selected = {(x[1], x[2], x[3], x[4]) for x in top}
    expected = {(x['dataset_id'], x['file_path'], x['line_index'], x['trace_id'])
                for x in manifest['samples']}
    if selected != expected or total != manifest['total_candidate_records']:
        raise ValueError('sampling frame or deterministic selection differs')
    out = ROOT / '.cache/samples'
    out.mkdir(parents=True, exist_ok=True)
    for name, raw in extracted.items():
        (out / name).write_bytes(raw + b'\n')
    verify(manifest)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--verify-local', action='store_true')
    mode.add_argument('--reproduce', action='store_true')
    args = parser.parse_args()
    pinned = json.loads((ROOT / 'manifest.json').read_text())
    (reproduce if args.reproduce else verify)(pinned)
