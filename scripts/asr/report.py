"""Produce a local comparison with seekable audio and original VOD timestamps."""
import html
import json
from pathlib import Path
import sys

directory = Path(sys.argv[1]).resolve()
manifest = json.loads((directory / "samples.json").read_text())
observations_path = directory / 'frame-observations.json'
observations = json.loads(observations_path.read_text()) if observations_path.exists() else {"labels": {}}
models = {name: json.loads((directory / f"{name}.transcript.json").read_text())
          for name in ["sensevoice", "qwen"]}
if not all(d.get("complete") and d.get("summary") for d in models.values()):
    raise SystemExit("Both transcriptions must be complete")
if models["sensevoice"]["signature"]["clips"] != models["qwen"]["signature"]["clips"]:
    raise SystemExit("Models did not receive identical audio")


def hms(seconds):
    seconds = int(seconds)
    return f"{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}"


markdown = [f"# VOD {manifest['vodId']} ASR 비교", "", manifest["title"], "",
            f"원본 길이: {hms(manifest['vodSeconds'])}. 전체 중 여섯 구간 약 30분만 비교.",
            "동일한 16kHz mono 오디오, 30초 고정 구간, batch=1, VAD 없음, 모델별 순차 실행.",
            "입력 구간 시작·끝을 기록했으며 단어별 시각 정렬은 하지 않았다.", "",
            "| 모델 | 오디오 | 순수 인식 | 프로세스 소요 | 인식 배속 | 최대 예약 VRAM | 최대 프로세스 RAM |",
            "|---|---:|---:|---:|---:|---:|---:|"]
summary_rows = []
for name, data in models.items():
    summary = data["summary"]
    sessions = data["sessions"]
    cells = [name, f"{summary['audio_seconds'] / 60:.2f}분",
             f"{summary['inference_seconds']:.1f}초",
             f"{sum(s['wall_seconds'] for s in sessions):.1f}초",
             f"{summary['audio_per_inference_second']:.2f}배",
             f"{max(s['peak_reserved_mib'] for s in sessions):.0f}MiB",
             f"{max(s['peak_process_rss_mib'] for s in sessions):.0f}MiB"]
    markdown.append("| " + " | ".join(cells) + " |")
    summary_rows.append("<tr>" + "".join(f"<td>{html.escape(c)}</td>" for c in cells) + "</tr>")
markdown += ["", "프로세스 소요에는 모델 로딩과 파일 읽기가 포함된다. 다운로드·오디오 추출은 제외한다.",
             "VRAM은 PyTorch 예약량, RAM은 해당 프로세스의 최대 RSS로 시스템 전체 사용량과 다르다.",
             "정답 전사문이 없어 WER/CER 및 인식 정확도 우열은 산출하지 않았다.", "",
             "나란히 전사문을 보며 원음을 들으려면 comparison.html을 연다.", ""]
segment_bytes = sum(p.stat().st_size for p in (directory / 'segments').glob('*.m4s'))
markdown += [f"표본 HLS 조각: {segment_bytes / 1_000_000:.1f}MB. 오디오 전용 트랙 없이 540p를 받아 음성 추출.", "",
             "| 표본 시작 | 중간 프레임에서 확인한 화면 | SenseVoice 인식 | Qwen 인식 |", "|---|---|---:|---:|"]
for clip in manifest['clips']:
    timings = {name: sum(c['inference_seconds'] for c in data['chunks'] if c['clip_id'] == clip['id'])
               for name, data in models.items()}
    markdown.append(f"| {hms(clip['at'])} | {observations['labels'].get(clip['id'], '미확인')} | {timings['sensevoice']:.2f}초 | {timings['qwen']:.2f}초 |")
markdown += ["", "프레임 설명은 해당 한 장을 직접 확인한 결과이며 구간 전체의 정답 라벨은 아니다.", ""]
index = {name: {c["key"]: c for c in d["chunks"]} for name, d in models.items()}
sections = []
for clip in manifest["clips"]:
    rows = []
    chunks = [c for c in models["sensevoice"]["chunks"] if c["clip_id"] == clip["id"]]
    for chunk in chunks:
        other = index["qwen"][chunk["key"]]
        start, end = chunk["at"] - clip["at"], chunk["end"] - clip["at"]
        rows.append(f'<tr><td><button data-start="{start}" data-end="{end}">{hms(chunk["at"])}</button></td>'
                    f'<td>{html.escape(chunk["text"])}</td><td>{html.escape(other["text"])}</td></tr>')
    audio = Path(clip["audio"]).relative_to(directory).as_posix()
    frame = Path(clip["frame"]).relative_to(directory).as_posix() if clip.get("frame") else None
    image = f'<img loading="lazy" src="{html.escape(frame)}" alt="구간 중간 프레임">' if frame else ''
    label = html.escape(observations['labels'].get(clip['id'], ''))
    sections.append(f'<section><h2>{hms(clip["at"])}–{hms(clip["at"] + clip["seconds"])} · {label}</h2>'
                    f'{image}<audio controls preload="none" src="{html.escape(audio)}"></audio>'
                    '<table><thead><tr><th>VOD 시각 · 재생</th><th>SenseVoiceSmall</th><th>Qwen3-ASR 0.6B</th></tr></thead>'
                    f'<tbody>{"".join(rows)}</tbody></table></section>')
html_report = '''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ASR 비교</title><style>
body{max-width:1400px;margin:32px auto;padding:0 24px;font:16px/1.65 system-ui;background:#f7f8fa;color:#192230}
table{width:100%;border-collapse:collapse;background:white}td,th{padding:12px;border:1px solid #d7dde5;vertical-align:top;text-align:left}
section{margin:40px 0}section td:first-child{width:115px}section td:not(:first-child){width:44%}
img{display:block;width:min(480px,100%);margin-bottom:12px}audio{width:min(600px,100%);margin:12px 0}
button{cursor:pointer;padding:8px;background:#e5eefb;border:1px solid #aac4ec;border-radius:5px}p{max-width:1000px}
</style><h1>VOD ASR 비교</h1>'''
html_report += f'<p>{html.escape(manifest["title"])} · 전체 {hms(manifest["vodSeconds"])} 중 약 30분 표본</p>'
html_report += '<p>같은 음성을 30초씩 나눠 모델 하나씩 실행했습니다. 시간은 입력 구간의 경계이며 단어별 시각이 아닙니다. '
html_report += '정답 전사문이 없어 정확도 점수는 산출하지 않았습니다. 시각 버튼을 누르면 해당 원음을 들을 수 있습니다.</p>'
html_report += '<table><thead><tr>' + ''.join(f'<th>{x}</th>' for x in ['모델','오디오','순수 인식','프로세스 소요','배속','예약 VRAM','프로세스 RAM']) + '</tr></thead><tbody>' + ''.join(summary_rows) + '</tbody></table>'
html_report += '<p>프로세스 소요에는 로딩·파일 읽기가 포함됩니다. 다운로드·오디오 추출은 제외합니다. 메모리는 해당 Python 프로세스 측정치입니다.</p>'
html_report += ''.join(sections)
html_report += '''<script>
document.querySelectorAll('section').forEach(section=>{
  const audio=section.querySelector('audio'); let stopAt=null;
  audio.addEventListener('timeupdate',()=>{if(stopAt!==null&&audio.currentTime>=stopAt){audio.pause();stopAt=null;}});
  section.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{
    document.querySelectorAll('audio').forEach(other=>{if(other!==audio)other.pause();});
    const start=Number(button.dataset.start); stopAt=Number(button.dataset.end);
    const seek=()=>{audio.currentTime=start;audio.play().catch(()=>{});};
    if(audio.readyState>=1)seek();else{audio.addEventListener('loadedmetadata',seek,{once:true});audio.load();}
  }));
});
</script></html>'''
(directory / 'comparison.html').write_text(html_report, encoding='utf-8')
(directory / 'comparison.md').write_text('\n'.join(markdown), encoding='utf-8')
print('\n'.join(markdown))
