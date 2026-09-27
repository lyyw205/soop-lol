# 프로젝트 내부 음성인식 환경

SenseVoiceSmall과 Qwen3-ASR 0.6B를 비교하기 위한 로컬 설치다.
설치·실행은 아래 스크립트로 한다. `env.sh`가 모델·패키지·CUDA/Numba 캐시와
임시 파일을 저장소의 `.local/asr/` 아래로 지정한다. 환경만 활성화해서 직접
실행하면 이 경로 설정이 빠지므로 반드시 래퍼를 사용한다.

기존 시스템의 Python 3.12, uv, ffmpeg, NVIDIA 드라이버를 사용한다.
시스템 패키지나 드라이버는 변경하지 않는다. `.local/asr/`는 Git에서 제외한다.
저장소 전체를 삭제하면 이번 설치의 환경·모델·캐시도 함께 사라진다.

## 설치

```bash
bash scripts/asr/install.sh
```

RTX 2070 8GB / 드라이버 560.94에 맞춰 PyTorch 2.7.1 CUDA 12.6을 사용한다.
모델마다 별도 가상환경을 만들되 uv 다운로드 캐시는 공유한다.
Qwen은 FP16, SDPA, batch=1을 사용한다. vLLM·FlashAttention·ForcedAligner는
설치하지 않는다. SenseVoice는 FunASR에 포함된 구현을 사용하며
`trust_remote_code=False`로 실행한다.

설치 명령은 패키지 호환성 검사, 공식 모델 다운로드, 같은 한국어 샘플의
GPU 인식 검사까지 수행한다. 최초 설치에는 인터넷과 GPU 접근이 필요하다.

## 설치 확인

```bash
bash scripts/asr/check.sh sensevoice
bash scripts/asr/check.sh qwen
# 직접 준비한 60초 이하 한국어 파일도 확인할 수 있다.
bash scripts/asr/check.sh sensevoice --audio /absolute/path/short.wav
```

설치 후 검사는 로컬 파일만 사용한다. 공식 SenseVoice 모델의 `example/ko.mp3`를
공통 샘플로 사용하며 다운로드나 VOD 조회를 하지 않는다.
두 번 인식해 최초 실행과 재실행 시간을 따로 기록한다.
짧은 샘플의 설치 확인 결과이므로 긴 CK 방송의 처리량·정확도 벤치마크가 아니다.
VOD 표본의 분할 처리·재시작·원본 시각 보존은 아래 비교 명령을 사용한다.
자동 watchlist 스캔·후보 판단·DB 반영은 이 실험 스크립트에 포함되지 않는다.

2026-09-22 RTX 2070에서 두 모델 모두 설치 검사를 통과했다. 4.644초 공식
한국어 샘플에서 둘 다 `조금만 생각을 하면서 살면 훨씬 편할 거야.`로 인식했다.

| 모델 | 두 번째 인식 시간 (모델 로딩 제외) | PyTorch 최대 예약 메모리 |
|---|---:|---:|
| SenseVoiceSmall | 0.437초 | 1,008MiB |
| Qwen3-ASR 0.6B | 1.304초 | 1,834MiB |

이 메모리는 드라이버·화면 출력 등 GPU 전체 사용량이 아니다.
설치 직후 `.local/asr/`의 실제 디스크 사용량은 약 8.8GiB였다.

## 실제 VOD 표본 비교

```bash
# 네트워크 필요. 기존 soop-http 게이트웨이의 요청 간격을 유지한다.
bash scripts/asr/env.sh node scripts/asr/probe-vod.mjs 207602969
bash scripts/asr/env.sh node scripts/asr/sample-vod.mjs 207602969 \
  600:300,7200:300,14400:300,21600:300,29700:300,42600:300

# 두 모델은 동시에 돌리지 않는다. 같은 입력과 GPU를 순차 비교한다.
bash scripts/asr/transcribe.sh sensevoice .local/asr/runs/207602969/samples.json
bash scripts/asr/transcribe.sh qwen .local/asr/runs/207602969/samples.json
python3 scripts/asr/report.py .local/asr/runs/207602969
```

`probe-vod`는 분할 파일의 API 길이와 HLS 길이·화질·오디오 전용 트랙을 확인한다.
`sample-vod`의 구간은 `VOD 전체 시작초:길이초`이며 파일 경계를 넘는 범위는 거부한다.
오디오 전용 트랙이 있으면 사용하고, 없으면 가장 낮은 대역폭의 영상을 받는다.
선택한 세그먼트만 프로젝트 안에 저장하고 ffmpeg으로 mono 16kHz WAV를 만든다.
암호화·byte-range·discontinuity HLS는 현재 지원하지 않는다.

전사 모델은 한 번 불러온 뒤 30초씩 순차 처리한다. VAD·겹침 구간은 사용하지 않는다.
중간 결과를 원자적으로 저장하므로 같은 명령을 다시 실행하면 완료 구간을 건너뛴다.
입력 오디오 해시·모델 revision·분할 설정이 다르면 기존 결과를 덮지 않고 거부한다.
타임스탬프는 입력 구간 경계이며, 단어별 시각이 아니다. 파일 간 offset은 API 길이 기준이다.

결과는 `.local/asr/runs/<vodId>/`에 저장된다:

- `probe.json`, `samples.json`: 원본 정보·선택 구간·오디오 경로
- `sensevoice.txt`, `qwen.txt`: `(시작초–끝초) 전사문`
- `*.transcript.json`: 구간별 인식 시간·전사문·체크포인트·메모리 측정
- `comparison.md`, `comparison.html`: 비교 요약 및 원음을 재생하며 나란히 읽는 화면
- `segments/`, `audio/`, `frames/`: 받은 HLS 조각·변환 음성·표본 중간 프레임

처리 속도는 해당 표본에서의 실측값이다. 전체 VOD 처리량이나 CK 단서 탐지 정확도로
확대 해석하지 않는다. 프레임은 표본 맥락 확인용이며 경기 확정·DB 반영 근거가 아니다.

## 저장 위치

| 위치 (`.local/asr/` 기준) | 내용 |
|---|---|
| `sensevoice/`, `qwen/` | Python 가상환경 |
| `models/` | 모델 파일·공식 예제 |
| `cache/` | 패키지·연산 캐시 |
| `tmp/` | 임시 파일 |
| `*.model.json` | 모델 저장 경로와 다운로드한 revision |
| `*.freeze.txt` | 설치된 패키지의 정확한 버전 |
| `*.check.json` | GPU·인식문·시간·PyTorch 최대 메모리 측정 |

출처: [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR),
[SenseVoiceSmall](https://huggingface.co/FunAudioLLM/SenseVoiceSmall),
[PyTorch CUDA wheels](https://pytorch.org/get-started/previous-versions/).
