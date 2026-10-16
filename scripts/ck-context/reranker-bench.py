"""Offline evidence-selection experiment; never modifies production CK outputs.

Run with the existing Qwen ASR Python environment. Only --run loads the reranker.
Manual transcript annotations are evaluation references, not audio-verified facts.
"""
import argparse
import hashlib
import html
import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'out/analysis/reranker-20261012'
SOURCES = {
    '209492205': ['out/analysis/seonghun-asr-20261012/setup-earlier/sensevoice.transcript.json',
                  'out/analysis/seonghun-asr-20261012/phase1/sensevoice.transcript.json'],
    '207602969': ['.local/asr/runs/207602969/sensevoice.transcript.json'],
    '189903183': ['.local/asr/runs/ck-189903183/sensevoice.transcript.json'],
    '206891383': ['.local/asr/runs/ck-206891383/sensevoice.transcript.json'],
    '208117091': ['.local/asr/runs/ck-208117091/sensevoice.transcript.json'],
}
INSTRUCTION = (
    'Given a query, retrieve Korean gaming livestream dialogue that provides evidence '
    'about the streamers organizing their own matches. Select relevant proposals, '
    'negotiations, confirmations and changes, including tentative statements. '
    'The transcript may contain speech recognition errors. '
    'Unrelated gameplay tactics, champion picks, professional esports commentary, '
    'FC player-card prices and routine donation thanks do not meet the requirements.'
)
QUERIES = {
    'format': '방송인들이 직접 참여할 경기를 CK, 랜드, 내전, 스크림, 대회 또는 일반 게임으로 '
              '제안하거나 정하는 대화. 참가자를 모집하거나 초대하는 대화.',
    'rules': '방송인들이 직접 참여하는 경기의 총 몇 판, 몇 선승, 세트 수, 시리즈 종료 또는 연장, '
             '피어리스 같은 시리즈 공통 규칙을 협의하거나 확인하거나 변경하는 대화.',
    'stakes': '방송인들이 직접 참여하는 경기에 걸린 내기, 몇 개 빵, 상금, 펀딩, 후원 조건이나 '
              '보상 규모를 협의하거나 확인하거나 변경하는 대화.',
    'teams': '방송인들이 직접 참여하는 경기의 참가자 명단, 누가 어느 팀인지, 선수 교체, '
             '상대와의 밸런스, 팀 재편성 또는 대기실에서 팀을 바꾸는 대화.',
}
SIMPLE_INSTRUCTION = 'Given a query, retrieve relevant passages that answer the query.'
SIMPLE_QUERIES = {
    'format': '랜드, CK, 내전, 대회, 스크림을 할지 정하고 함께 할 사람을 구하거나 초대하는 대화.',
    'rules': '몇 판 몇 선승으로 게임을 할지, 피어리스를 적용할지, 시리즈 규칙과 종료를 정하는 대화.',
    'stakes': '경기에 몇 개 빵을 할지, 내기 금액, 펀딩, 상금이나 보상을 정하는 대화.',
    'teams': '경기 전 팀을 나누거나 바꾸고, 누가 어느 편인지와 상대 밸런스를 조율하는 대화.',
}
# Fixed before inference. These are broad lexical candidates, not hand-picked timestamps.
PATTERN = r'랜드|렌드|씨케이|시케이|ck|내전|스크림|대회|멸망전|내기|개빵|빵이|몇개|펀딩|상금|후원|선승|몇판|몇선|피어리스|피아리스|팀|밸런|벨런|라인바꿔|레드가|레드내려|구해|초대|할래|하실래|들어오'
PREFIX = '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
SUFFIX = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'


def save(name, obj):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n')


def load_data():
    documents, chunks, hashes = [], {}, {}
    for vod, paths in SOURCES.items():
        rows = {}
        for source in paths:
            raw = (ROOT / source).read_bytes()
            hashes[source] = hashlib.sha256(raw).hexdigest()
            for c in json.loads(raw)['chunks']:
                if c['end'] - c['at'] < 1:
                    continue
                key = f"{vod}:{c['at']:g}"
                row = dict(id=key, vod=vod, start=c['at'], end=c['end'], text=c['text'], source=source)
                if key in rows:
                    assert rows[key]['text'] == row['text'], key
                rows[key] = row
        ordered = sorted(rows.values(), key=lambda c: c['start'])
        chunks.update(rows)
        for i, center in enumerate(ordered):
            window = [center]
            if i and abs(ordered[i-1]['end'] - center['start']) < 0.01:
                window.insert(0, ordered[i-1])
            if i+1 < len(ordered) and abs(center['end'] - ordered[i+1]['start']) < 0.01:
                window.append(ordered[i+1])
            documents.append(dict(center_id=center['id'], vod=vod,
                                  chunk_ids=[c['id'] for c in window],
                                  text='\n'.join(c['text'] for c in window)))
    return dict(chunks=chunks, documents=documents, source_sha256=hashes)


def annotations():
    # Only source text was read when these references were prepared; no model scores.
    # All listed chunks must survive selection to count the event as retained.
    main = [
        ('참가자 모집', [4800]),
        ('랜드 초대 제안(확정 아님)', [5010, 5040]),
        ('상대 밸런스/참가 조건', [5190, 5250]),
        ('피어리스 예외 요청', [5400]),
        ('참가자 명단 힌트(이름 인식 불량)', [5550]),
        ('팀 이동과 보상 조율', [5580, 5610]),
        ('피어리스 확인 문답', [5670]),
        ('몇 개 빵 질문과 300/200개 답변', [5910, 5940]),
        ('로비 팀 확인', [7350]),
        ('상대/팀 조합 변경', [11960, 11990, 12020]),
        ('팀 이동 지시', [12110, 12140]),
        ('레드 팀 이동', [14730]),
        ('후속 참가자 밸런스 논의', [14850, 14880]),
        ('다음부터 랜드 챔피언 제한 제안', [15000]),
        ('참가 예정자 솔랭 종료 대기', [17130, 17190]),
    ]
    events = [dict(id=f'main-{i+1:02}', vod='209492205', label=label,
                   required_ids=[f'209492205:{t}' for t in times])
              for i, (label, times) in enumerate(main)]
    events.extend([
        dict(id='aux-stakes', vod='207602969', label='끝난 경기 5000빵 회고',
             required_ids=['207602969:29700', '207602969:29730']),
        dict(id='aux-invite', vod='207602969', label='FC 중 협곡 초대 제안(실행 아님)',
             required_ids=['207602969:42600']),
    ])
    negative = {
        '209492205': [4860, 4890, 4920, 4950, 5310, 5340, 5370,
                      *range(5760, 5910, 30), *range(7200, 7320, 30),
                      *range(7380, 7500, 30), *range(12170, 12800, 30),
                      14760, 14790, 14820, 14940, 14970,
                      *range(15030, 15300, 30), 17160, 17220, 17250,
                      17280, 17310, 17340, 17370],
        '207602969': [*range(600, 900, 30), *range(7200, 7500, 30),
                      *range(21600, 21900, 30), 29790, *range(29850, 30000, 30),
                      *range(42630, 42900, 30)],
        '206891383': [12540, 12570, 12600, 12630, 12660],
    }
    return dict(events=events, clear_negative_ids=[f'{vod}:{t}' for vod, ts in negative.items() for t in ts],
                caveat='Manually marked retrieval targets in noisy transcripts; not audio-verified truth, '
                'not an exhaustive accuracy set and not a blind/random validation sample. '
                'Unmarked dialogue is ambiguous or context; negative chunks adjacent to a target '
                'may be deliberately delivered to preserve context.')


def prepare():
    data = load_data()
    gold = annotations()
    for event in gold['events']:
        assert all(i in data['chunks'] for i in event['required_ids']), event
    assert set(gold['clear_negative_ids']) <= data['chunks'].keys()
    save('dataset.json', data)
    save('annotations.json', gold)
    protocol = dict(version=1, model='Qwen/Qwen3-Reranker-0.6B', instruction=INSTRUCTION,
                    queries=QUERIES, primary_threshold=0.5, exploratory_thresholds=[0.01, 0.05, 0.1, 0.2, 0.5, 0.8],
                    context='30-second chunks with the immediate continuous neighbor on each side; max 90 seconds',
                    delivery='Union of all original chunks in every retained document; preserve bytes and timestamps',
                    score='Maximum yes/no relevance score over four fixed queries. Not truth/confidence calibration.',
                    keyword_pattern=PATTERN, source_sha256=data['source_sha256'],
                    annotation_sha256=hashlib.sha256((OUT / 'annotations.json').read_bytes()).hexdigest(),
                    runtime='Existing ASR Qwen venv; FP16 CUDA; SDPA; no generation, no local summaries',
                    limitation='89.5 minutes of previously sampled ASR, not a complete VOD. '
                    'Auxiliary VOD 207602969 has a legacy API time axis; never align to production HLS frames.',
                    prepared_at=time.strftime('%Y-%m-%dT%H:%M:%S%z'))
    save('protocol.json', protocol)
    print(json.dumps(dict(chunks=len(data['chunks']), documents=len(data['documents']),
                          events=len(gold['events']), pairs=len(data['documents'])*len(QUERIES)), ensure_ascii=False))


def run():
    import torch
    import transformers
    from transformers import AutoModelForCausalLM, AutoTokenizer
    data = json.loads((OUT / 'dataset.json').read_text())
    protocol = json.loads((OUT / 'protocol.json').read_text())
    assert protocol['queries'] == QUERIES and protocol['instruction'] == INSTRUCTION
    model_info = json.loads((ROOT / '.local/ck-context-reranker/model.json').read_text())
    torch.set_num_threads(4)
    begin = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(model_info['path'], padding_side='left', local_files_only=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(model_info['path'], torch_dtype=torch.float16,
                attn_implementation='sdpa', local_files_only=True).to('cuda').eval()
    torch.cuda.synchronize()
    load_seconds = time.perf_counter() - begin
    no_id, yes_id = [tokenizer.convert_tokens_to_ids(x) for x in ['no', 'yes']]
    pairs = [(d, topic, query) for d in data['documents'] for topic, query in QUERIES.items()]
    texts = [PREFIX + f'<Instruct>: {INSTRUCTION}\n<Query>: {query}\n<Document>: {d["text"]}' + SUFFIX
             for d, topic, query in pairs]
    tokens = tokenizer(texts, add_special_tokens=False, truncation=False)['input_ids']
    lengths = [len(x) for x in tokens]
    assert max(lengths) <= 4096, max(lengths)
    torch.cuda.reset_peak_memory_stats()
    scores, batches = [], []

    def infer(ids):
        batch = tokenizer.pad(dict(input_ids=ids), padding=True, return_tensors='pt').to('cuda')
        with torch.inference_mode():
            logits = model(**batch, use_cache=False, logits_to_keep=1).logits[:, -1, [no_id, yes_id]].float()
            values = logits.softmax(dim=-1)[:, 1].cpu().tolist()
        return values

    # Warm up kernels, then compare one independently scored pair against batched scoring.
    warm_start = time.perf_counter()
    sanity_single = infer(tokens[:1])[0]
    warm_seconds = time.perf_counter() - warm_start
    batch_size = 4
    inference_start = time.perf_counter()
    for start in range(0, len(pairs), batch_size):
        tick = time.perf_counter()
        scores.extend(infer(tokens[start:start+batch_size]))
        batches.append(time.perf_counter()-tick)
        if start % 80 == 0 or start + batch_size >= len(pairs):
            print(json.dumps(dict(done=min(start+batch_size, len(pairs)), total=len(pairs),
                                  seconds=round(time.perf_counter()-inference_start, 2))), flush=True)
    inference_seconds = time.perf_counter()-inference_start
    assert abs(sanity_single-scores[0]) < 0.02, (sanity_single, scores[0])
    grouped = {d['center_id']: dict(center_id=d['center_id'], scores={}) for d in data['documents']}
    for (d, topic, _), score in zip(pairs, scores):
        grouped[d['center_id']]['scores'][topic] = score
    for row in grouped.values():
        row['max_score'] = max(row['scores'].values())
    meta = dict(model=model_info, torch=torch.__version__, transformers=transformers.__version__,
                device=torch.cuda.get_device_name(), dtype='float16', batch_size=batch_size,
                load_seconds=load_seconds, warmup_seconds=warm_seconds, inference_seconds=inference_seconds,
                wall_seconds=time.perf_counter()-begin, pairs=len(pairs), input_tokens=sum(lengths),
                min_input_tokens=min(lengths), max_input_tokens=max(lengths), truncated_documents=0,
                peak_gpu_allocated_bytes=torch.cuda.max_memory_allocated(),
                peak_gpu_reserved_bytes=torch.cuda.max_memory_reserved(),
                sanity_single=sanity_single, sanity_batched=scores[0],
                protocol_sha256=hashlib.sha256((OUT/'protocol.json').read_bytes()).hexdigest(),
                dataset_sha256=hashlib.sha256((OUT/'dataset.json').read_bytes()).hexdigest())
    save('scores.json', dict(metadata=meta, results=list(grouped.values())))
    print(json.dumps(meta, ensure_ascii=False), flush=True)


def evaluate():
    data = json.loads((OUT/'dataset.json').read_text())
    gold = json.loads((OUT/'annotations.json').read_text())
    scored = json.loads((OUT/'scores.json').read_text())
    scores = {r['center_id']: r for r in scored['results']}
    docs = {d['center_id']: d for d in data['documents']}
    keyword = {i for i, c in data['chunks'].items() if re.search(PATTERN, re.sub(r'\s+', '', c['text']), re.I)}

    def measure(name, centers, vod=None):
        rows = {i:c for i,c in data['chunks'].items() if vod is None or c['vod']==vod}
        picked_centers = set(centers) & rows.keys()
        delivered = {i for center in picked_centers for i in docs[center]['chunk_ids']}
        chars = sum(len(c['text']) for c in rows.values())
        seconds = sum(c['end']-c['start'] for c in rows.values())
        events = [e for e in gold['events'] if vod is None or e['vod']==vod]
        covered = [e['id'] for e in events if set(e['required_ids']) <= delivered]
        partial = [e['id'] for e in events if set(e['required_ids']) & delivered and e['id'] not in covered]
        negatives = set(gold['clear_negative_ids']) & rows.keys()
        return dict(method=name, vod=vod or 'all', selected_centers=len(picked_centers),
                    delivered_chunks=len(delivered), total_chunks=len(rows),
                    delivered_seconds=sum(rows[i]['end']-rows[i]['start'] for i in delivered),
                    total_seconds=seconds, delivered_chars=sum(len(rows[i]['text']) for i in delivered),
                    total_chars=chars, chars_fraction=sum(len(rows[i]['text']) for i in delivered)/chars,
                    events_retained=len(covered), event_count=len(events), retained_event_ids=covered,
                    partial_event_ids=partial, missed_event_ids=[e['id'] for e in events if e['id'] not in covered],
                    clear_negative_centers=len(negatives & picked_centers),
                    clear_negative_delivered=len(negatives & delivered), total_clear_negatives=len(negatives),
                    delivered_ids=sorted(delivered, key=lambda i:(rows[i]['vod'], rows[i]['start'])))

    methods = [('all-text', set(data['chunks'])), ('keywords', keyword)]
    for threshold in [0.01, 0.05, 0.1, 0.2, 0.5, 0.8]:
        selected = {i for i, s in scores.items() if s['max_score'] >= threshold}
        methods.append((f'reranker-{threshold:g}', selected))
    # Diagnostic safety path, not a tuned production choice: retain lexical matches regardless of rank.
    methods.append(('keywords-union-reranker-0.5', keyword | {i for i,s in scores.items() if s['max_score']>=0.5}))
    # Rank within each VOD, using the original-text character budget after context expansion.
    # These curves are diagnostics on this inspected sample, not a production threshold choice.
    for fraction in [0.2, 0.4, 0.58, 0.6, 0.8]:
        selected = set()
        for vod in SOURCES:
            rows = {i:c for i,c in data['chunks'].items() if c['vod']==vod}
            budget = sum(len(c['text']) for c in rows.values())*fraction
            delivered = set()
            for i in sorted(rows, key=lambda i:scores[i]['max_score'], reverse=True):
                expanded = delivered | set(docs[i]['chunk_ids'])
                if sum(len(rows[j]['text']) for j in expanded) > budget:
                    break
                delivered = expanded
                selected.add(i)
        methods.append((f'rank-budget-{fraction:g}', selected))
    metrics = [measure(name, centers, vod) for vod in [None, *SOURCES] for name, centers in methods]
    save('metrics.json', dict(metadata=scored['metadata'], metrics=metrics, annotation_caveat=gold['caveat']))
    for name, centers in methods:
        if name in ['keywords', 'reranker-0.5', 'keywords-union-reranker-0.5']:
            delivered = {i for center in centers for i in docs[center]['chunk_ids']}
            rows = sorted([data['chunks'][i] for i in delivered], key=lambda c:(c['vod'], c['start']))
            assert all(c['text'] == data['chunks'][c['id']]['text'] for c in rows)
            save(f'packet-{name}.json', dict(method=name, warning='Raw ASR evidence only. '
                'Relevance is not truth. Proposals and past/third-party events must not be treated as current agreement.',
                time_axes={v:('legacy-api' if v=='207602969' else 'hls-global') for v in SOURCES}, chunks=rows))
    summary_rows = ''.join('<tr>'+''.join(f'<td>{html.escape(str(value))}</td>' for value in [
        m['vod'], m['method'], f"{m['delivered_seconds']/60:.1f}/{m['total_seconds']/60:.1f}",
        f"{m['chars_fraction']:.1%}", f"{m['events_retained']}/{m['event_count']}",
        ', '.join(m['missed_event_ids'])])+'</tr>' for m in metrics if m['vod'] in ['all','209492205','207602969'])
    event_rows = ''.join(f'<li><b>{html.escape(e["id"])} {html.escape(e["label"])}</b> '
                         f'{html.escape(", ".join(e["required_ids"]))}</li>' for e in gold['events'])
    detail = []
    for i, c in data['chunks'].items():
        s = scores[i]
        label = ' / '.join(e['label'] for e in gold['events'] if i in e['required_ids'])
        detail.append(f'<details><summary>{html.escape(i)} | score {s["max_score"]:.4f} | '
                      f'keyword {i in keyword} | {html.escape(label)}</summary><pre>'
                      f'{html.escape(json.dumps(s["scores"], ensure_ascii=False, indent=2))}</pre>'
                      f'<p>중심 원문:</p><pre>{html.escape(c["text"])}</pre>'
                      f'<p>모델 입력(연속 이웃 포함):</p><pre>{html.escape(docs[i]["text"])}</pre></details>')
    (OUT/'report.html').write_text('<!doctype html><meta charset="utf-8"><title>Qwen3 Reranker 실제 전사 실험</title>'
        '<style>body{font:16px system-ui;max-width:1250px;margin:32px auto;padding:20px;line-height:1.55}'
        'table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:7px}pre{white-space:pre-wrap}'
        'details{border:1px solid #ddd;margin:8px 0;padding:10px}summary{cursor:pointer}</style>'
        '<h1>Qwen3-Reranker 0.6B: 원문 선택 실험</h1>'
        '<p>사전에 정한 4개 질의 · 30초 중심+양옆 연속 30초 · 기본 임계값 0.5. '
        '원문을 생성/교정/요약하지 않음. 전체 VOD 실험이 아니며, 전사에서 손으로 고른 근거 사례에 대한 회수 검사임.</p>'
        '<p>점수는 관련도이며 사실 여부나 확정 여부의 확률이 아님. 전달량은 실제 Claude 토큰/청구 비용과 다름. '
        '사례는 음성 재청취로 검증하지 않았음. 207602969는 과거 API 시간축이므로 화면과 연결 금지.</p>'
        '<table><tr><th>VOD</th><th>방법</th><th>전달/원본 분</th><th>문자 비중</th>'
        '<th>핵심 사례 보존</th><th>부분/누락</th></tr>'+summary_rows+'</table>'
        '<h2>사전 표시 사례</h2><ul>'+event_rows+'</ul><h2>실행 정보</h2><pre>'+
        html.escape(json.dumps(scored['metadata'], ensure_ascii=False, indent=2))+'</pre>'
        '<h2>원문과 구간별 점수</h2>'+''.join(detail))
    print(json.dumps([{k:v for k,v in m.items() if k not in ['delivered_ids','retained_event_ids']}
                      for m in metrics if m['vod'] in ['all','209492205','207602969']], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'run', 'evaluate'])
    parser.add_argument('--simple', action='store_true', help='Exploratory shorter queries; separate artifacts')
    args = parser.parse_args()
    if args.simple:
        OUT = OUT / 'simple-query'
        INSTRUCTION = SIMPLE_INSTRUCTION
        QUERIES = SIMPLE_QUERIES
    {'prepare': prepare, 'run': run, 'evaluate': evaluate}[args.action]()
