"""Refresh only local memo references from cached features, without re-preparing a VOD.

Example: python scripts/ck-local/memo-refresh.py --vod 206156659 \
    --model out/ck-memo-training/memo.json --experimental
Models are experimental until independent interval-level validation passes.
This command is deliberately not wired into normal result preparation yet.
No SOOP calls, DB writes, scan.json changes or evidence/read state changes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE/'detector'))
from memo import MemoCollector, MODEL
from sheets import cell_image


def references(meta):
    refs = []
    for n, part in enumerate(meta['parts']):
        if not part.get('reliable') or not part.get('cells'):
            continue
        end = part['offset'] + part['length']
        if n + 1 < len(meta['parts']):
            end = min(end, meta['parts'][n + 1]['offset'])
        for k, sheet in enumerate(part['sheets']):
            for cell in range(min(100, part['cells']-k*100)):
                refs.append({'at': part['offset']+(k*100+cell)*3, 'sheet': sheet, 'cell': cell, 'end': end})
    return refs


class Cells:
    def __init__(self, refs, sheet_cache=None):
        self.refs, self.sheet_cache = refs, sheet_cache
        self.images = {}

    def __len__(self):
        return len(self.refs)

    def __getitem__(self, i):
        ref = self.refs[i]
        file = ROOT/ref['sheet']
        if self.sheet_cache:
            cached = Path(self.sheet_cache)/Path(ref['sheet']).relative_to('out/ck')
            if cached.exists(): file = cached
        if str(file) not in self.images:
            with Image.open(file) as im: self.images[str(file)] = im.convert('RGB')
            if len(self.images)>4: del self.images[next(iter(self.images))]
        return np.asarray(cell_image(self.images[str(file)],ref['cell']))


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--vod',required=True)
    ap.add_argument('--model',default=str(MODEL));ap.add_argument('--features');ap.add_argument('--meta')
    ap.add_argument('--sheet-cache');ap.add_argument('--output')
    ap.add_argument('--experimental', action='store_true', help='Publish explicitly marked experimental reference candidates')
    args=ap.parse_args()
    if not args.experimental:
        raise SystemExit('Memo detector has not passed rollout validation. Use --experimental for a selected pilot VOD only.')
    if not Path(args.model).is_file():raise SystemExit('No memo model. Train a candidate first and pass --model; no production model is installed.')
    if not args.vod.isdigit():raise SystemExit('Invalid VOD')
    candidates=[ROOT/f'out/ck-detector/emb/siglip/{args.vod}.npz',ROOT/f'out/ck-context-pilot/{args.vod}/features.npz']
    feature_path=Path(args.features) if args.features else next((p for p in candidates if p.exists()),None)
    if not feature_path:raise SystemExit('No cached features. This pilot requires existing SigLIP features; do not rerun result preparation for memo alone.')
    meta_path=Path(args.meta) if args.meta else (ROOT/f'out/ck-detector/vods/{args.vod}.json' if feature_path==candidates[0] else ROOT/f'out/ck/{args.vod}/local/sheets.json')
    raw=meta_path.read_bytes();refs=references(json.loads(raw));data=np.load(feature_path)
    if len(refs)!=len(data['at']) or not np.allclose(data['at'],[r['at'] for r in refs],atol=.01):
        raise SystemExit('Cached features do not match sheet timestamps')
    local_meta=ROOT/f'out/ck/{args.vod}/local/sheets.json'
    if local_meta.exists():
        local_raw=local_meta.read_bytes();local_refs=references(json.loads(local_raw))
        if len(local_refs)!=len(refs) or any(a['sheet']!=b['sheet'] or a['cell']!=b['cell'] or abs(a['at']-b['at'])>.01 or abs(a['end']-b['end'])>.01 for a,b in zip(refs,local_refs)):
            raise SystemExit('Current local sheet layout differs from cached features; refuse stale publication')
        raw=local_raw
    collector=MemoCollector(args.vod,args.model)
    # Sheet counts may round past a video part's end. The next part owns that
    # time range, as in the review player's existing cell lookup. Keep cache
    # alignment intact, then exclude only those trailing cells from this sidecar.
    indices=[i for i,r in enumerate(refs) if r['at'] < r['end']]
    selected=[refs[i] for i in indices]
    collector.add(data['emb'][indices].astype(np.float32),[r['at'] for r in selected],Cells(selected,args.sheet_cache))
    output=collector.finish(Path(args.output) if args.output else ROOT/f'out/ck/{args.vod}/local',hashlib.sha256(raw).hexdigest())
    print(json.dumps({k:v for k,v in output.items() if k!='groups'},ensure_ascii=False))
    print('memo_groups',len(output['groups']))


if __name__=='__main__':main()
