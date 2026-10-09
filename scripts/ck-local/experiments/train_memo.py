"""Train a small independent memo head; channel/event-separated sampled evaluation."""
import argparse
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import time

import numpy as np
from sklearn.linear_model import LogisticRegression
from memo_dataset import load, ROOT, OUT


@lru_cache(maxsize=16)
def embeddings(vod):
    return load(vod)[0]['emb'].astype(np.float32)


def matrix(rows):
    return np.stack([embeddings(r['vod'])[r['index']] for r in rows])


def counts(y, scores, threshold):
    pred = scores >= threshold
    tp,fp,fn,tn = [int(np.sum(a)) for a in [(y==1)&pred,(y==0)&pred,(y==1)&~pred,(y==0)&~pred]]
    return dict(tp=tp,fp=fp,fn=fn,tn=tn,precision=tp/max(1,tp+fp),recall=tp/max(1,tp+fn))


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--evaluate',action='store_true');a=ap.parse_args()
    src=ROOT/'scripts/ck-local/detector/memo-labels.json'; labels=json.loads(src.read_text())
    train=[r for r in labels['rows'] if r['split']=='train']
    test=[r for r in labels['rows'] if r['split']=='test']
    assert not ({r['channel'] for r in train}&{r['channel'] for r in test})
    x=matrix(train); y=np.array([r['label'] for r in train]);vods=np.array([r['vod'] for r in train])
    augmented = np.load(OUT/'augmented.npz')['emb'] if (OUT/'augmented.npz').exists() else np.empty((0,768))
    provenance = json.loads((OUT/'augmented-provenance.json').read_text()) if len(augmented) else []
    cv=np.zeros(len(train))
    for vod in sorted(set(vods)):
        mask=vods!=vod
        model=LogisticRegression(C=10,class_weight='balanced',max_iter=2000,random_state=0)
        aug_mask = np.array([p['template_vod'] != vod and p['background_vod'] != vod for p in provenance], dtype=bool)
        ax = augmented[aug_mask]
        model.fit(np.concatenate([x[mask],ax]),np.concatenate([y[mask],np.ones(len(ax))]),
                  sample_weight=np.concatenate([np.ones(mask.sum()),np.full(len(ax),.3)]))
        cv[~mask]=model.predict_proba(x[~mask])[:,1]
    thresholds={str(t):counts(y,cv,t) for t in [.2,.3,.4,.5,.6,.7,.8]}
    # Candidates are human references: prioritize a clean queue. The recall limit
    # must be reported explicitly, never silently lower the threshold to flood it.
    feasible=[float(t) for t,m in thresholds.items() if m['precision']>=.90]
    threshold=min(feasible) if feasible else .8
    started=time.perf_counter()
    model=LogisticRegression(C=10,class_weight='balanced',max_iter=2000,random_state=0).fit(
        np.concatenate([x,augmented]),np.concatenate([y,np.ones(len(augmented))]),
        sample_weight=np.concatenate([np.ones(len(y)),np.full(len(augmented),.3)]))
    fit_seconds=time.perf_counter()-started
    artifact={'schema':1,'kind':'memo','encoder':'siglip','feature_dim':x.shape[1],
        'version':'memo-'+hashlib.sha256(src.read_bytes()).hexdigest()[:12],
        'label_sha256':hashlib.sha256(src.read_bytes()).hexdigest(),
        'threshold':threshold,'coef':model.coef_[0].astype(np.float32).tolist(),
        'intercept':float(model.intercept_[0]),'group_gap_seconds':15,'expansion_threshold':.5}
    OUT.mkdir(exist_ok=True,parents=True)
    (OUT/'memo.json').write_text(json.dumps(artifact,indent=2)+'\n')
    report={'training_examples':len(train),'training_channels':sorted({r['channel'] for r in train}),
        'training_only_augmentations':len(augmented),
        'threshold':threshold,'training_leave_vod_out':thresholds,'fit_seconds':fit_seconds,
        'evaluation_limit':labels['split_note']}
    if a.evaluate:
        scores=model.predict_proba(matrix(test))[:,1];ty=np.array([r['label'] for r in test])
        report['test']=counts(ty,scores,threshold)
        report['test_channels']=sorted({r['channel'] for r in test})
        report['test_rows']=[{**r,'score':float(s),'predicted':bool(s>=threshold)} for r,s in zip(test,scores)]
    (OUT/'training-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='test_rows'},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
