"""Evaluate a linear memo head on existing SigLIP patch features (no second encoder).

Training-only bounding boxes and synthetic placement supervise local regions.
Unseen real VOD frames are evaluated separately; never used to fit region weights.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from sklearn.linear_model import LogisticRegression

from memo_dataset import ROOT, OUT
from augment_memo import tile
sys.path.insert(0,str(ROOT/'scripts/ck-local/detector'))
from embed import load_model,letterbox
from sheets import cell_image

SIZES=[2,3,4,6]


def regions(tokens):
    import torch
    x=torch.nn.functional.normalize(tokens.float(),dim=-1).reshape(-1,14,14,768).permute(0,3,1,2)
    return torch.cat([torch.nn.functional.avg_pool2d(x[:,:,3:11],k,stride=2).flatten(2).transpose(1,2) for k in SIZES],dim=1),x


def labeled_image(row):
    if 'sample' in row:
        source='hard' if row['audit'].startswith('Second') else 'initial'
        return np.asarray(tile(row['vod'],source,row['sample']))
    for name in ['overview','memo-first-pass','memo-label-check','memo-second-pass']:
        directory=ROOT/'out/ck-context-pilot/206156659'/name
        items=json.loads((directory/'items.json').read_text())
        for n,item in enumerate(items):
            if item['index']==row['index']:
                with Image.open(directory/f'{n//48+1:02}.jpg') as im:
                    x=n%6*256;y=n%48//6*166
                    return np.asarray(im.crop((x,y,x+256,y+144)).resize((192,108)))
    raise ValueError(f'No visually inspected image for {row}')


def extract():
    import torch
    torch.set_num_threads(2);torch.cuda.set_per_process_memory_fraction(.25)
    enc,size,mean,std=load_model('siglip','cuda');mean=mean.cuda().half();std=std.cuda().half()
    captured=[]
    model=enc.__closure__[0].cell_contents
    hook=model.visual.trunk.norm.register_forward_hook(lambda _,args,out:captured.append(out.detach()))
    def forward(pixels):
        captured.clear()
        x=(letterbox(np.stack(pixels),size).cuda().half()-mean)/std
        with torch.inference_mode():enc(x);return regions(captured[-1])
    rows=json.loads((ROOT/'scripts/ck-local/detector/memo-labels.json').read_text())['rows']
    output=[]
    for start in range(0,len(rows),24):
        pooled,_=forward([labeled_image(r) for r in rows[start:start+24]])
        output.append(pooled.cpu().numpy().astype(np.float16))
    np.savez(OUT/'spatial-real.npz',regions=np.concatenate(output))
    print('real region features',len(rows),flush=True)
    augmented=np.load(OUT/'augmented-pixels.npz')['pixels'];provenance=json.loads((OUT/'augmented-provenance.json').read_text())
    positives=[]
    for start in range(0,len(augmented),24):
        _,dense=forward(augmented[start:start+24])
        for j,p in enumerate(provenance[start:start+24]):
            x0,y0,x1,y1=p['box']
            # A thumbnail is letterboxed to 224x224 (126px image, 49px top pad).
            c0=max(0,int(np.floor(x0*224/192/16)));c1=min(14,int(np.ceil(x1*224/192/16)))
            r0=max(3,int(np.floor((49+y0*224/192)/16)));r1=min(11,int(np.ceil((49+y1*224/192)/16)))
            positives.append(dense[j,:,r0:r1,c0:c1].mean((1,2)).cpu().numpy())
    np.savez(OUT/'spatial-positive.npz',emb=np.stack(positives).astype(np.float16))
    print('positive region features',len(positives),flush=True)
    for vod in ['206719759','206994099','208295391']:
        refs=json.loads((OUT/f'fresh-{vod}.json').read_text());pixels=[];cache={}
        for r in refs:
            if r['sheet'] not in cache:
                with Image.open(ROOT/r['sheet']) as im:cache[r['sheet']]=im.convert('RGB')
            pixels.append(np.asarray(cell_image(cache[r['sheet']],r['cell'])))
        output=[]
        for start in range(0,len(pixels),24):
            pooled,_=forward(pixels[start:start+24]);output.append(pooled.cpu().numpy().astype(np.float16))
        np.savez(OUT/'fresh'/vod/'spatial.npz',regions=np.concatenate(output))
    hook.remove()


def fit():
    rows=json.loads((ROOT/'scripts/ck-local/detector/memo-labels.json').read_text())['rows']
    real=np.load(OUT/'spatial-real.npz')['regions'].astype(np.float32)
    positives=np.load(OUT/'spatial-positive.npz')['emb'].astype(np.float32)
    provenance=json.loads((OUT/'augmented-provenance.json').read_text())
    train=np.array([r['split']=='train' for r in rows]);y=np.array([r['label'] for r in rows]);vods=np.array([r['vod'] for r in rows])
    def train_head(mask,aug_mask):
        negative=real[mask&(y==0)].reshape(-1,768)
        positive=positives[aug_mask]
        x=np.concatenate([negative,positive]);target=np.concatenate([np.zeros(len(negative)),np.ones(len(positive))])
        return LogisticRegression(C=10,class_weight='balanced',max_iter=500,random_state=0).fit(x,target)
    # CV on original frames only; neither source nor background of a held-out VOD
    # may be present in the synthetic positive examples used for that fold.
    cv=np.zeros(len(rows))
    for vod in sorted(set(vods[train])):
        m=train_head(train&(vods!=vod),np.array([p['template_vod']!=vod and p['background_vod']!=vod for p in provenance]))
        ix=train&(vods==vod);cv[ix]=(real[ix]@m.coef_[0]+m.intercept_[0]).max(1)
        print('cv',vod,flush=True)
    m=train_head(train,np.ones(len(positives),dtype=bool))
    scores=(real@m.coef_[0]+m.intercept_[0]).max(1)
    def counts(actual,s,threshold):
        pred=s>=threshold;tp=int(np.sum((actual==1)&pred));fp=int(np.sum((actual==0)&pred));fn=int(np.sum((actual==1)&~pred));tn=int(np.sum((actual==0)&~pred))
        return {'tp':tp,'fp':fp,'fn':fn,'tn':tn,'precision':tp/max(tp+fp,1),'recall':tp/max(tp+fn,1)}
    cv_metrics={str(t):counts(y[train],cv[train],t) for t in [-1,0,1,2,3,4,5,6,7,8]}
    eligible=[float(t) for t,v in cv_metrics.items() if v['precision']>=.90]
    threshold=min(eligible) if eligible else 8
    report={'cv':cv_metrics,'margin_threshold':threshold,'development_frames':counts(y[~train],scores[~train],threshold),
            'note':'Fresh global-head test VODs are now diagnostic, not untouched for the spatial architecture.'}
    fresh=json.loads((OUT/'fresh-evaluation.json').read_text())['rows']
    for vod in sorted({r['vod'] for r in fresh}):
        f=[r for r in fresh if r['vod']==vod];features=np.load(OUT/'fresh'/vod/'spatial.npz')['regions'].astype(np.float32)
        s=(features@m.coef_[0]+m.intercept_[0]).max(1)
        report[vod]=counts(np.array([r['label'] for r in f]),s[[r['sample'] for r in f]],threshold)
    artifact={'schema':2,'kind':'memo','encoder':'siglip','spatial':'final_norm_l2_14x14','sizes':SIZES,'stride':2,
        'threshold':threshold,'expansion_threshold':max(threshold-2,0),'coef':m.coef_[0].astype(np.float32).tolist(),
        'intercept':float(m.intercept_[0]),'group_gap_seconds':15,
        'labels_sha256':hashlib.sha256((ROOT/'scripts/ck-local/detector/memo-labels.json').read_bytes()).hexdigest()}
    (OUT/'spatial-memo.json').write_text(json.dumps(artifact,indent=2)+'\n')
    (OUT/'spatial-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))


if __name__=='__main__':
    os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
    ap=argparse.ArgumentParser();ap.add_argument('command',choices=['extract','fit']);args=ap.parse_args()
    extract() if args.command=='extract' else fit()
