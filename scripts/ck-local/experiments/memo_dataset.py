"""Offline memo label sheets; reuses cached SigLIP features, never downloads media."""
import argparse
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'detector'))
from sheets import cell_image

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'out/ck-memo-training'


def load(vod):
    if vod == '206156659':
        p = ROOT / 'out/ck-context-pilot' / vod
        return np.load(p / 'features.npz'), json.loads((p / 'frames.json').read_text()), 'babamba'
    meta = json.loads((ROOT / 'out/ck-detector/vods' / f'{vod}.json').read_text())
    data = np.load(ROOT / 'out/ck-detector/emb/siglip' / f'{vod}.npz')
    refs = []
    for part in meta['parts']:
        if not part.get('reliable') or not part['cells']:
            continue
        for k, sheet in enumerate(part['sheets']):
            for cell in range(min(100, part['cells'] - k * 100)):
                refs.append({'at': part['offset'] + (k * 100 + cell) * 3,
                             'sheet': sheet, 'cell': cell})
    assert len(refs) == len(data['at']), (vod, len(refs), len(data['at']))
    assert np.allclose([r['at'] for r in refs], data['at'], atol=.01)
    return data, refs, meta['channel']


def contact(vod, indices, name):
    data, refs, channel = load(vod)
    dest = OUT / name / vod; dest.mkdir(parents=True, exist_ok=True)
    rows = [{'sample': n, 'vod': vod, 'channel': channel, 'index': int(i), **refs[i]}
            for n, i in enumerate(indices)]
    (dest / 'samples.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    for start in range(0, len(rows), 48):
        part = rows[start:start+48]
        canvas = Image.new('RGB', (1536, ((len(part)+5)//6)*166), '#202020')
        draw = ImageDraw.Draw(canvas)
        cache = {}
        for n, r in enumerate(part):
            if r['sheet'] not in cache:
                local = OUT / 'sheet-cache' / Path(r['sheet']).relative_to('out/ck')
                with Image.open(local if local.exists() else ROOT / r['sheet']) as im:
                    cache[r['sheet']] = im.convert('RGB')
            tile = cell_image(cache[r['sheet']], r['cell']).resize((256,144))
            x,y = n%6*256,n//6*166;canvas.paste(tile,(x,y))
            draw.text((x+2,y+145),f"#{r['sample']} i{r['index']} {int(r['at'])}s",fill='white')
        canvas.save(dest/f'{start//48+1:02}.jpg',quality=90)
    return rows


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--vods',required=True);ap.add_argument('--name',default='initial')
    ap.add_argument('--model',default='out/ck-context-pilot/206156659/memo-head.npz')
    ap.add_argument('--indices');a=ap.parse_args()
    head=np.load(ROOT/a.model)
    for vod in a.vods.split(','):
        data,_,_=load(vod)
        if a.indices:
            picked=[int(i) for i in a.indices.split(',')]
        else:
            picked=list(np.linspace(0,len(data['at'])-1,32,dtype=int))
            scores=data['emb'].astype(np.float32)@head['coef'].reshape(-1)+float(head['intercept'][0])
            for i in np.argsort(scores)[::-1]:
                if all(abs(data['at'][i]-data['at'][j])>=45 for j in picked):
                    picked.append(int(i))
                if len(picked)>=48:break
            picked.sort()
        contact(vod,picked,a.name)
        print(vod,len(picked),flush=True)


if __name__=='__main__':main()
