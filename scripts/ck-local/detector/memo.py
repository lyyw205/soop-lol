"""Independent reference collection from existing SigLIP features.

No result labels, DB rows, scan progress, opened/read/reviewed marks or network calls.
One thumbnail per group is cached; all detected timestamps remain navigable.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import time

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
MODEL = Path(__file__).parent / 'models/memo.json'


def atomic(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    try:
        temp.write_bytes(body)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


class MemoCollector:
    def __init__(self, vod, model_path=MODEL):
        self.vod = str(vod)
        if not self.vod.isdigit():
            raise ValueError('Memo VOD must be numeric')
        self.model_path = Path(model_path)
        raw = self.model_path.read_bytes()
        self.model_hash = hashlib.sha256(raw).hexdigest()
        model = json.loads(raw)
        self.schema = model.get('schema')
        self.coef = np.asarray(model['coef'], dtype=np.float32)
        self.intercept = float(model['intercept'])
        self.threshold = float(model['threshold'])
        self.expansion_threshold = float(model.get('expansion_threshold', self.threshold))
        if self.schema == 2:
            if model.get('spatial') != 'final_norm_l2_14x14' or model.get('sizes') != [2, 3, 4, 6] or model.get('stride') != 2:
                raise ValueError('Unsupported spatial memo head')
            self.threshold = float(1 / (1 + np.exp(-self.threshold)))
            self.expansion_threshold = float(1 / (1 + np.exp(-self.expansion_threshold)))
        if (self.schema not in (1, 2) or model.get('kind') != 'memo'
                or model.get('encoder') != 'siglip' or self.coef.shape != (768,)
                or not np.isfinite(self.coef).all() or not np.isfinite(self.intercept)
                or not 0 < self.expansion_threshold <= self.threshold < 1):
            raise ValueError('Invalid memo head')
        self.gap = float(model.get('group_gap_seconds', 15))
        if not 3 <= self.gap <= 60:
            raise ValueError('Invalid memo group gap')
        self.groups = []
        self.cells = 0
        self.last_at = -1
        self.score_seconds = 0.

    def add(self, features, ats, cells):
        if self.schema != 1 or features.shape != (len(ats), 768):
            raise ValueError('Expected global memo features')
        self.add_scores(1 / (1 + np.exp(-np.clip(features @ self.coef + self.intercept, -60, 60))), ats, cells)

    def spatial_scores(self, tokens):
        """Score before pooling: avoid materializing 74×768 region vectors."""
        import torch
        if self.schema != 2 or tuple(tokens.shape[1:]) != (196, 768):
            raise ValueError('Expected SigLIP spatial tokens')
        x = torch.nn.functional.normalize(tokens.float(), dim=-1)
        w = torch.as_tensor(self.coef, device=x.device)
        scores = (x @ w).reshape(-1, 1, 14, 14)[:, :, 3:11]
        peaks = torch.stack([torch.nn.functional.avg_pool2d(scores, k, stride=2).flatten(1).max(1).values for k in [2, 3, 4, 6]])
        return torch.sigmoid(peaks.max(0).values + self.intercept).cpu().numpy()

    def add_scores(self, scores, ats, cells):
        ats = np.asarray(ats)
        scores = np.asarray(scores)
        if scores.shape != (len(ats),) or len(cells) != len(ats) or not np.isfinite(scores).all():
            raise ValueError('Memo feature/cell alignment mismatch')
        if len(ats) and (not np.isfinite(ats).all() or ats[0] <= self.last_at or (np.diff(ats) <= 0).any()):
            raise ValueError('Memo timestamps must be increasing')
        self.cells += len(ats)
        if len(ats):
            self.last_at = float(ats[-1])
        started = time.perf_counter()
        # High-score anchors start published groups. Nearby moderate-score frames
        # retain partially occluded notes without publishing an unanchored group.
        for i in np.flatnonzero(scores >= self.expansion_threshold):
            at = float(ats[i]); score = float(scores[i])
            if not self.groups or at - self.groups[-1]['to'] > self.gap:
                self.groups.append({'from': at, 'to': at, 'frames': [], 'peak_score': -1})
            group = self.groups[-1]
            group['to'] = at
            group['frames'].append({'at': at, 'score': round(score, 5)})
            if score > group['peak_score']:
                group.update(peak=at, peak_score=score)
                if score >= self.threshold:
                    group['image'] = np.asarray(cells[i]).copy()
        self.score_seconds += time.perf_counter() - started

    def finish(self, directory, source_hash):
        """Publish the manifest last so clients never see partially written images."""
        if hashlib.sha256(self.model_path.read_bytes()).hexdigest() != self.model_hash:
            raise ValueError('Memo model changed while collecting; discard stale output')
        directory = Path(directory)
        published = []; total_bytes = 0; started = time.perf_counter()
        version = self.model_hash[:16]
        for group in self.groups:
            if group['peak_score'] < self.threshold:
                continue
            at_ms = round(group['peak'] * 1000)
            image_name = f'memo/{version}/t{at_ms}.jpg'
            buffer = io.BytesIO()
            Image.fromarray(group['image']).save(buffer, format='JPEG', quality=90)
            image_bytes = buffer.getvalue();total_bytes += len(image_bytes)
            atomic(directory / image_name, image_bytes)
            published.append({'key': f'{self.vod}:{round(group["from"] * 1000)}:memo',
                'kind': 'memo', 'from': group['from'], 'to': group['to'],
                'representative_at': group['peak'], 'score': round(group['peak_score'], 5),
                'thumbnail': f'ck/{self.vod}/local/{image_name}', 'frames': group['frames']})
        output = {'schema': 1, 'vod': self.vod, 'kind': 'memo_references',
            'experimental': True,
            'model_sha256': self.model_hash, 'source_sha256': source_hash,
            'created_at': time.time(), 'cells': self.cells, 'threshold': self.threshold,
            'groups': published, 'score_seconds': self.score_seconds,
            'thumbnail_bytes': total_bytes, 'publish_seconds': time.perf_counter()-started}
        atomic(directory / 'memo.json', (json.dumps(output, ensure_ascii=False, separators=(',', ':'))+'\n').encode())
        return output
