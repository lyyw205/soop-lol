"""Offline reference-screen pilot. Writes only a separate experiment directory.

No SOOP requests, DB access, production model changes, or scan status writes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import html
import re

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
DETECTOR = ROOT / 'scripts/ck-local/detector'
sys.path.insert(0, str(DETECTOR))
from sheets import cell_image


def read(path):
    return json.loads(Path(path).read_text())


def write(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def existing_detector_running():
    for p in Path('/proc').glob('[0-9]*/cmdline'):
        try:
            args = p.read_bytes().split(b'\0')
            if any(a.endswith(b'/detector/detect.py') for a in args):
                return True
        except (OSError, PermissionError):
            pass
    return False


def features(args):
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import torch
    from embed import letterbox, load_model
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'features.npz').exists():
        raise SystemExit('Features already exist; use the saved experiment.')
    meta_path = ROOT / f'out/ck/{args.vod}/local/sheets.json'
    model_dir = ROOT / 'out/ck-detector/model/siglip'
    protected = [meta_path, ROOT / f'out/ck/{args.vod}/local/scan.json',
                 ROOT / f'out/ck/{args.vod}/local/games.json',
                 model_dir / 'clf.npz', model_dir / 'multi.npz']
    fingerprints = {str(p.relative_to(ROOT)): sha(p) for p in protected}
    write(out / 'protected-before.json', fingerprints)
    device = args.device
    torch.set_num_threads(2)
    if device == 'cuda':
        torch.cuda.set_per_process_memory_fraction(.28)
        free, _ = torch.cuda.mem_get_info()
        if free < 3 * 2**30:
            raise SystemExit('Less than 3 GiB GPU memory free; defer the pilot.')
    while device == 'cuda' and existing_detector_running():
        print('Waiting for existing detector', flush=True)
        time.sleep(5)
    started = time.perf_counter()
    enc, size, mean, std = load_model('siglip', device)
    mean, std = mean.to(device).half(), std.to(device).half()
    load_seconds = time.perf_counter() - started
    result_model = np.load(model_dir / 'clf.npz')
    multi = np.load(model_dir / 'multi.npz')
    meta = read(meta_path)
    embeddings, refs, ats = [], [], []
    io_seconds = encode_seconds = wait_seconds = 0.
    for part in meta['parts']:
        if not part.get('reliable') or not part['cells']:
            continue
        for k, sheet in enumerate(part['sheets']):
            n = min(100, part['cells'] - k * 100)
            if n <= 0:
                break
            before = time.perf_counter()
            with Image.open(ROOT / sheet) as image:
                image = image.convert('RGB')
                cells = np.stack([np.asarray(cell_image(image, c)) for c in range(n)])
            io_seconds += time.perf_counter() - before
            for offset in range(0, n, args.batch):
                pause = time.perf_counter()
                while device == 'cuda' and existing_detector_running():
                    torch.cuda.empty_cache()
                    time.sleep(5)
                wait_seconds += time.perf_counter() - pause
                before = time.perf_counter()
                x = (letterbox(cells[offset:offset + args.batch], size).to(device).half() - mean) / std
                with torch.inference_mode():
                    e = torch.nn.functional.normalize(enc(x).float(), dim=-1).cpu().numpy()
                embeddings.append(e)
                encode_seconds += time.perf_counter() - before
                del x
            for c in range(n):
                at = float(part['offset'] + (k * 100 + c) * 3)
                ats.append(at)
                refs.append({'at': at, 'sheet': sheet, 'cell': c, 'part': part['index']})
            if (k + 1) % 20 == 0:
                print(f'{len(ats)} cells; {time.perf_counter() - started:.1f}s', flush=True)
    emb = np.concatenate(embeddings)
    before = time.perf_counter()
    scores = 1 / (1 + np.exp(-(emb @ result_model['coef'].astype(np.float32) + result_model['intercept'][0])))
    z = emb @ multi['coef'].T + multi['intercept']
    z = np.exp(z - z.max(1, keepdims=True)); probs = z / z.sum(1, keepdims=True)
    score_seconds = time.perf_counter() - before
    np.savez(out / 'features.npz', at=np.array(ats), emb=emb, result=scores,
             probs=probs, classes=multi['classes'], min_conf=multi['min_conf'])
    write(out / 'frames.json', refs)
    write(out / 'feature-timing.json', {'vod': args.vod, 'cells': len(ats), 'device': device,
        'batch': args.batch, 'model_load_seconds': load_seconds, 'sheet_io_decode_seconds': io_seconds,
        'encode_seconds': encode_seconds, 'existing_heads_seconds': score_seconds,
        'wait_for_existing_detector_seconds': wait_seconds, 'total_seconds': time.perf_counter() - started,
        'note': 'One-time historical re-embedding; not the marginal cost for future co-processing.',
        'protected_inputs_unchanged': all(sha(ROOT / p) == h for p, h in fingerprints.items())})
    print('Features complete', len(ats), flush=True)


def montage(args):
    out = Path(args.output)
    frames = read(out / 'frames.json')
    if args.indices:
        indices = [int(i) for i in args.indices.split(',')]
    else:
        indices = [i for i, f in enumerate(frames) if args.start <= f['at'] <= args.end][::args.stride]
    dest = out / args.name
    dest.mkdir(exist_ok=True)
    write(dest / 'items.json', [{'index': i, **frames[i]} for i in indices])
    cache = {}
    for page, offset in enumerate(range(0, len(indices), 48), 1):
        picked = indices[offset:offset+48]
        canvas = Image.new('RGB', (6*256, ((len(picked)+5)//6)*166), '#202020')
        draw = ImageDraw.Draw(canvas)
        for j, i in enumerate(picked):
            f = frames[i]
            if f['sheet'] not in cache:
                with Image.open(ROOT / f['sheet']) as im:
                    cache[f['sheet']] = im.convert('RGB')
            tile = cell_image(cache[f['sheet']], f['cell']).resize((256,144))
            x,y=(j%6)*256,(j//6)*166
            canvas.paste(tile,(x,y))
            t=round(f['at']); label=f"#{i} {t//3600}:{t//60%60:02}:{t%60:02}"
            draw.text((x+3,y+146),label,fill='white')
        canvas.save(dest/f'{page:02}.jpg',quality=90)
    print(f'{len(indices)} frames -> {dest}')


def groups(indices, ats, max_gap=9):
    """Keep every hit; only presentation is grouped, including isolated hits."""
    result = []
    for i in indices:
        i = int(i)
        if not result or ats[i] - ats[result[-1][-1]] > max_gap:
            result.append([])
        result[-1].append(i)
    return result


def select_sets(ats, probs, classes, matches):
    """Pilot associations: existing result evidence + duration + visual transitions.

    These are proposals only, not new authoritative match links or game clocks.
    A sustained in-game run must start near the result-minus-duration estimate.
    """
    labels = classes[probs.argmax(1)]
    confident = probs.max(1) >= .6
    runs = groups(np.flatnonzero((labels == 'ingame') & confident), ats)
    selected = []
    for match in matches:
        found = re.search(r'/g(\d+)\.jpg', match.get('result_evidence', ''))
        if not found or not match.get('duration'):
            selected.append({'match_id': match['match_id'], 'status': 'unresolved'})
            continue
        result_at = int(found[1])
        estimate = result_at - match['duration']
        candidates = [r for r in runs if abs(ats[r[0]] - estimate) <= 180
                      and ats[r[-1]] - ats[r[0]] >= 60]
        record = {'match_id': match['match_id'], 'set': match['series_game_no'],
                  'result_at': result_at, 'estimated_start': estimate,
                  'status': 'unresolved', 'frames': []}
        if len(candidates) == 1:
            run = candidates[0]
            start = float(ats[run[0]])
            target = start + 60
            # Do not silently use another game, a menu, or a distant frame.
            near = [i for i in run if abs(ats[i] - target) <= 15]
            draft = np.flatnonzero((ats < start) & (ats >= start - 180)
                                  & (labels == 'banpick') & confident)
            record.update(status='proposed', observed_ingame_start=start,
                          association_basis='Existing result evidence and duration agree with one sustained in-game transition within 180 seconds; needs visual review.')
            if len(draft):
                record['frames'].append({'kind': 'last_banpick', 'index': int(draft[-1]),
                    'selection': 'Last confident banpick within 180 seconds before observed in-game start.'})
            if near:
                record['frames'].append({'kind': 'ingame_plus_60',
                    'index': int(min(near, key=lambda i: abs(ats[i] - target))),
                    'selection': '60 seconds after first sustained in-game view; NOT verified game clock 01:00.'})
        selected.append(record)
    return selected


def analyze(args):
    from sklearn.linear_model import LogisticRegression
    out = Path(args.output).resolve()
    data = np.load(out / 'features.npz')
    emb, ats = data['emb'], data['at']
    refs = read(out / 'frames.json')
    labels = read(out / 'labels.json')
    train = [r for r in labels['rows'] if r['split'] == 'train']
    holdout = [r for r in labels['rows'] if r['split'] == 'holdout']
    before = time.perf_counter()
    head = LogisticRegression(C=10, class_weight='balanced', max_iter=1000, random_state=0)
    head.fit(emb[[r['index'] for r in train]], [r['label'] for r in train])
    fit_seconds = time.perf_counter() - before
    coef, intercept = head.coef_[0].astype(np.float32), float(head.intercept_[0])
    np.savez(out / 'memo-head.npz', coef=coef, intercept=np.array([intercept]),
             threshold=args.threshold, pilot_only=True)
    timings = []
    for _ in range(20):
        before = time.perf_counter()
        scores = 1 / (1 + np.exp(-(emb @ coef + intercept)))
        hits = np.flatnonzero(scores >= args.threshold)
        grouped = groups(hits, ats)
        timings.append(time.perf_counter() - before)
    metrics = {}
    for threshold in [.5, args.threshold]:
        rows = [{**r, 'score': round(float(scores[r['index']]), 5),
                 'predicted': bool(scores[r['index']] >= threshold)} for r in holdout]
        metrics[str(threshold)] = {'tp': sum(r['label'] == 1 and r['predicted'] for r in rows),
             'fn': sum(r['label'] == 1 and not r['predicted'] for r in rows),
             'fp': sum(r['label'] == 0 and r['predicted'] for r in rows),
             'tn': sum(r['label'] == 0 and not r['predicted'] for r in rows), 'rows': rows}
    def frame(i, kind, score=None):
        ref = refs[i]
        # Millisecond key retains the original timestamp across VOD file parts.
        return {'key': f'{args.vod}:{round(ref["at"] * 1000)}:{kind}',
                'vod': args.vod, 'at': ref['at'], 'kind': kind, 'index': i,
                'source': {'sheet': ref['sheet'], 'cell': ref['cell']},
                'score': score, 'status': 'unreviewed', 'match_id': None,
                'image': f'thumbnails/{i}.jpg'}
    memo = []
    for n, indices in enumerate(grouped, 1):
        representative = max(indices, key=lambda i: scores[i])
        memo.append({'group': n, 'start': float(ats[indices[0]]), 'end': float(ats[indices[-1]]),
            'representative': representative, 'match_id': None,
            'frames': [frame(i, 'memo', float(scores[i])) for i in indices]})
    matches = read(ROOT / f'out/ck/{args.vod}/local/games.json')['results']
    before = time.perf_counter()
    sets = select_sets(ats, data['probs'], data['classes'], matches)
    audit = read(out / 'manual-audit.json') if (out / 'manual-audit.json').exists() else {}
    for item in sets:
        item['frames'] = [{**f, **frame(f['index'], f['kind']),
            'collection': 'automatic_pilot',
            'proposed_match_id': item['match_id'], 'association_status': 'proposed'}
            for f in item.get('frames', [])]
        for loading in audit.get('loading_frames', []):
            if loading['set'] == item.get('set'):
                item['frames'].append({**frame(loading['index'], 'loading_manual'),
                    'collection': 'manual_pilot_audit', 'selection': loading['source'],
                    'proposed_match_id': item['match_id'], 'association_status': 'proposed'})
    selection_seconds = time.perf_counter() - before
    candidates = {'schema': 1, 'vod': args.vod, 'pilot_only': True,
        'memo_threshold': args.threshold, 'memo_groups': memo, 'sets': sets,
        'loading': {'supported_by_current_classifier': 'loading' in data['classes'].tolist(),
                    'status': 'not_automatically_collected'}}
    write(out / 'candidates.json', candidates)
    np.save(out / 'memo-scores.npy', scores)
    before = time.perf_counter()
    # Small local thumbnails only: no video extraction, network, or original writes.
    all_frames = [f for g in memo for f in g['frames']] + [f for s in sets for f in s.get('frames', [])]
    wanted = sorted({f['index'] for f in all_frames})
    dest = out / 'thumbnails'; dest.mkdir(exist_ok=True)
    cached_sheet, sheet_image = None, None
    for i in wanted:
        ref = refs[i]
        if ref['sheet'] != cached_sheet:
            with Image.open(ROOT / ref['sheet']) as im:
                sheet_image = im.convert('RGB')
            cached_sheet = ref['sheet']
        cell_image(sheet_image, ref['cell']).save(dest / f'{i}.jpg', quality=90)
    thumbnail_seconds = time.perf_counter() - before
    fingerprints = read(out / 'protected-before.json')
    report = {'vod': args.vod, 'frames_scanned': len(ats), 'memo_frames': len(hits),
        'memo_groups': len(memo), 'reference_frames': sum(len(s.get('frames', [])) for s in sets),
        'automatic_reference_frames': sum(f['collection'] == 'automatic_pilot' for s in sets for f in s.get('frames', [])),
        'manual_loading_frames': len(audit.get('loading_frames', [])),
        'training_examples': len(train), 'holdout_examples': len(holdout),
        'evaluation_limit': labels['method'], 'holdout': metrics,
        'fit_seconds': fit_seconds, 'memo_head_and_grouping_seconds_median': float(np.median(timings)),
        'set_selection_seconds': selection_seconds, 'thumbnail_export_seconds': thumbnail_seconds,
        'thumbnail_bytes': sum((dest / f'{i}.jpg').stat().st_size for i in wanted),
        'new_original_downloads': 0, 'soop_requests': 0, 'claude_api_calls': 0,
        'protected_inputs_unchanged': all(sha(ROOT / p) == h for p, h in fingerprints.items()),
        'manual_audit': audit,
        'limitations': ['No claim of cross-streamer accuracy or exhaustive memo recall.',
            'Original readability, retrieval cost and full-pipeline 5% target are not tested.',
            'In-game reference is relative to first observed game view, not OCR of game clock.',
            'Scores from this small pilot head are not calibrated confidence probabilities.']}
    write(out / 'report.json', report)
    def clock(t):
        t = round(t); return f'{t//3600}:{t//60%60:02}:{t%60:02}'
    def card(f):
        return (f'<figure><a href="{f["image"]}" target="_blank"><img loading="lazy" src="{f["image"]}"></a>'
                f'<figcaption>{html.escape(f["kind"])} · {clock(f["at"])} · #{f["index"]}</figcaption></figure>')
    body = ['<h1>밤바팀 vs 오뀨팀 · 참고 화면 수집 실험</h1>',
        '<p>운영 검수 큐와 분리된 미리보기입니다. 수집은 판독·검수 완료가 아닙니다. 원본 다운로드와 DB 변경은 없습니다.</p>',
        '<p>메모장은 미연결 후보입니다. 세트 연결도 기존 결과 시점·경기 길이와 화면 전환으로 만든 제안입니다. '
        '인게임 화면은 처음 게임이 보인 시점 +60초이며 게임 시계 01:00을 확인한 것은 아닙니다.</p>',
        '<p><strong>메모장 자동 수집은 운영 적용 보류입니다.</strong> 흰 웹페이지 오탐과 가려진 메모장 누락이 있습니다. '
        'loading_manual은 사람이 찾아 추가한 비교용 화면이며 자동 검출 결과가 아닙니다.</p>',
        '<p><a href="report.json">측정 결과</a> · <a href="candidates.json">전체 시각·출처</a> · '
        '<a href="labels.json">사람이 확인한 표본 라벨</a></p><h2>세트별 참고 화면</h2>']
    for s in sets:
        body.append(f'<h3>{html.escape(s["match_id"])} ({s["status"]})</h3><div class="grid">'
                    + ''.join(card(f) for f in s.get('frames', [])) + '</div>')
    body.append(f'<h2>메모장 후보 {len(memo)}묶음 / {len(hits)}장</h2><p>분류 점수가 높아도 오탐일 수 있습니다. 접힌 묶음을 열면 모든 후보를 볼 수 있습니다.</p>')
    for g in memo:
        rep = next(f for f in g['frames'] if f['index'] == g['representative'])
        body.append(f'<section><h3>#{g["group"]} {clock(g["start"])}–{clock(g["end"])} · {len(g["frames"])}장</h3>'
            + card(rep) + '<details><summary>묶음의 모든 후보 보기</summary><div class="grid">'
            + ''.join(card(f) for f in g['frames']) + '</div></details></section>')
    (out / 'index.html').write_text('<!doctype html><html lang="ko"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>참고 화면 수집 실험</title>'
        '<style>body{font:16px system-ui;max-width:1200px;margin:30px auto;padding:0 16px;background:#151922;color:#e8edf5}'
        'a{color:#83c5ff}.grid{display:flex;flex-wrap:wrap}figure{margin:8px}img{width:384px;max-width:100%;height:auto}'
        'section{border-top:1px solid #49505b;padding:16px 0}summary{cursor:pointer}figcaption{font-size:13px}</style>'
        + ''.join(body) + '</html>')
    print(json.dumps({k:v for k,v in report.items() if k != 'holdout'}, ensure_ascii=False, indent=2))
    print('holdout', {k: {kk:vv for kk,vv in v.items() if kk != 'rows'} for k,v in metrics.items()})


if __name__ == '__main__':
    ap=argparse.ArgumentParser(description=__doc__)
    sub=ap.add_subparsers(dest='command',required=True)
    a=sub.add_parser('features'); a.add_argument('--vod',required=True)
    a.add_argument('--output',required=True); a.add_argument('--device',choices=['cpu','cuda'],default='cuda')
    a.add_argument('--batch',type=int,default=32);a.set_defaults(fn=features)
    a=sub.add_parser('montage'); a.add_argument('--output',required=True)
    a.add_argument('--name',required=True);a.add_argument('--indices')
    a.add_argument('--start',type=float,default=0);a.add_argument('--end',type=float,default=float('inf'))
    a.add_argument('--stride',type=int,default=20);a.set_defaults(fn=montage)
    a=sub.add_parser('analyze');a.add_argument('--vod',required=True);a.add_argument('--output',required=True)
    a.add_argument('--threshold',type=float,default=.7);a.set_defaults(fn=analyze)
    args=ap.parse_args();args.fn(args)
