"""Offline training-only memo-window placement/occlusion augmentation.

The collection pipeline and displayed media never use these synthetic images.
Inputs are confirmed training examples; test channels are excluded.
"""
import json
import os
from pathlib import Path
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

from memo_dataset import ROOT, OUT
sys.path.insert(0, str(ROOT/'scripts/ck-local/detector'))
from embed import load_model, letterbox


def tile(vod, source, sample):
    with Image.open(OUT/source/vod/f'{sample//48+1:02}.jpg') as im:
        x=sample%6*256;y=(sample%48)//6*166
        return im.crop((x,y,x+256,y+144)).resize((192,108))


def main():
    os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
    import torch
    torch.set_num_threads(2)
    torch.cuda.set_per_process_memory_fraction(.18)
    labels=json.loads((ROOT/'scripts/ck-local/detector/memo-labels.json').read_text())['rows']
    templates=json.loads(Path(__file__).with_name('memo-augmentation-templates.json').read_text())
    train_vods={r['vod'] for r in labels if r['split']=='train'}
    assert all(t[0] in train_vods for t in templates)
    negatives=[r for r in labels if r['split']=='train' and r['label']==0 and 'sample' in r]
    # Source contact sheets are lossily recompressed; all augmentation is training-only.
    memo_images=[tile(v,s,n).crop(box) for v,s,n,box in templates]
    background=[]
    for r in negatives:
        source='hard' if r['audit'].startswith('Second') else 'initial'
        background.append(tile(r['vod'],source,r['sample']))
    rng=np.random.default_rng(20261005);pixels=[];provenance=[]
    for n in range(1320):
        t=n%len(templates);b=int(rng.integers(len(background)))
        im=background[b].copy();note=memo_images[t]
        width=int(rng.integers(50,160));height=round(width*note.height/note.width)
        if height>97:width=round(width*97/height);height=97
        note=note.resize((width,height))
        x=int(rng.integers(0,193-width));y=int(rng.integers(0,109-height))
        im.paste(note,(x,y))
        if n%3==0:
            # Keep at least 65% of the window visibly present.
            cover=round(width*.3)
            im.paste(background[b].crop((x+width-cover,y,x+width,y+height)),(x+width-cover,y))
        pixels.append(np.asarray(im));provenance.append({'template_vod':templates[t][0],
            'background_vod':negatives[b]['vod'],'template':t,'background_index':negatives[b]['index'],
            'box':[x,y,x+width,y+height]})
    np.savez_compressed(OUT/'augmented-pixels.npz',pixels=np.stack(pixels))
    canvas=Image.new('RGB',(6*256,8*166),'#202020');draw=ImageDraw.Draw(canvas)
    for n,i in enumerate(np.linspace(0,len(pixels)-1,48,dtype=int)):
        x=n%6*256;y=n//6*166;canvas.paste(Image.fromarray(pixels[i]).resize((256,144)),(x,y));draw.text((x+3,y+145),str(i),fill='white')
    canvas.save(OUT/'augmentation-audit.jpg',quality=90)
    model,size,mean,std=load_model('siglip','cuda');mean=mean.cuda().half();std=std.cuda().half()
    vectors=[];start=time.perf_counter()
    for offset in range(0,len(pixels),32):
        x=(letterbox(np.stack(pixels[offset:offset+32]),size).cuda().half()-mean)/std
        with torch.inference_mode():
            vectors.append(torch.nn.functional.normalize(model(x).float(),dim=-1).cpu().numpy())
    np.savez(OUT/'augmented.npz',emb=np.concatenate(vectors))
    (OUT/'augmented-provenance.json').write_text(json.dumps(provenance))
    print('training-only augmented cells',len(pixels),'encode_seconds',round(time.perf_counter()-start,2))


if __name__=='__main__':main()
