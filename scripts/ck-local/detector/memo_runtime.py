"""Sampled reference collection. Failure never changes result detection."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import numpy as np
from memo import MemoCollector, atomic

CONFIG = Path(__file__).parent / 'models/memo-rollout.json'


def selected(vod, mode, config):
    if mode == 'off' or os.environ.get('CK_MEMO_ENABLED') == '0': return False
    if mode == 'on': return True
    if not config.get('enabled'): return False
    percent = int(config.get('percent', 0))
    if not 0 <= percent <= 100: raise ValueError('Memo rollout percent must be 0..100')
    bucket = int(hashlib.sha256(f'memo-v1:{vod}'.encode()).hexdigest()[:8], 16) % 100
    return bucket < percent


class MemoSession:
    def __init__(self, meta_path, encoder, mode='auto'):
        self.directory = Path(meta_path).parent
        self.started = time.perf_counter()
        self.elapsed = 0.
        self.hook = None
        self.collector = None
        self.scores = None
        self.status = 'not_selected'
        try:
            raw = Path(meta_path).read_bytes()
            self.source_hash = hashlib.sha256(raw).hexdigest()
            vod = str(json.loads(raw)['vod'])
            config = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
            if not selected(vod, mode, config): return
            self.collector = MemoCollector(vod)
            if self.collector.schema != 2: raise ValueError('Rollout requires spatial model')
            self.hook = encoder.memo_norm.register_forward_hook(self.capture)
            self.status = 'collecting'
        except Exception as e:
            self.disable(e)

    def disable(self, error):
        self.status = 'failed'
        self.error = str(error)[:300]
        if self.hook: self.hook.remove(); self.hook = None
        self.collector = None
        self.scores = None
        print(f'MEMO skipped: {self.error}', file=sys.stderr)

    def capture(self, _module, _args, tokens):
        start = time.perf_counter()
        try:
            self.scores = self.collector.spatial_scores(tokens)
        except Exception as e:
            self.disable(e)
        finally:
            self.elapsed += time.perf_counter() - start

    def observe(self, ats, cells, end):
        if self.collector is None: return
        start = time.perf_counter()
        try:
            valid = np.asarray(ats) < end
            if self.scores is None: raise ValueError('Missing spatial tokens')
            self.collector.add_scores(self.scores[valid], np.asarray(ats)[valid], cells[valid])
            self.scores = None
        except Exception as e:
            self.disable(e)
        finally:
            self.elapsed += time.perf_counter() - start

    def finish(self):
        if self.hook: self.hook.remove(); self.hook = None
        report = {'status': self.status, 'observer_wall_seconds': self.elapsed,
                  'timing_note': 'Observer time includes waiting for GPU work; use paired process wall times for overhead.',
                  'detection_seconds': time.perf_counter() - self.started}
        try:
            if self.collector:
                start = time.perf_counter()
                manifest = self.collector.finish(self.directory, self.source_hash)
                report.update(status='collected', groups=len(manifest['groups']),
                              thumbnail_bytes=manifest['thumbnail_bytes'],
                              publish_seconds=time.perf_counter() - start)
            if hasattr(self, 'error'): report['error'] = self.error
            atomic(self.directory/'memo-run.json', (json.dumps(report)+'\n').encode())
        except Exception as e:
            print(f'MEMO publication skipped: {e}', file=sys.stderr)
            try: atomic(self.directory/'memo-run.json', (json.dumps({'status': 'failed', 'error': str(e)[:300]})+'\n').encode())
            except OSError: pass
