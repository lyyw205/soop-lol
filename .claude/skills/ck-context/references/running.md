# 실행 안내

저장소 루트에서 실행한다. 기존 package.json·자동 실행기는 변경하지 않았다.

## 로컬 서버

이미 설치된 Ollama 실행 파일을 쓴다. 기본은 `~/.local/ollama/bin/ollama`, 다른 경로는 `CK_CONTEXT_OLLAMA`로 지정한다.
서버는 포그라운드로 실행하며 별도 터미널에서 분석을 실행한다. 타이머·시스템 서비스는 설치하지 않는다.

```bash
bash scripts/ck-context/runtime.sh serve
```

최초 모델 준비 및 확인:

```bash
bash scripts/ck-context/runtime.sh pull qwen3.5:4b
bash scripts/ck-context/runtime.sh status
```

기본 설정: 요청 1개, 컨텍스트 8192, thinking 끔, 구조화 출력. ASR과 언어모델은 순차 실행한다.
`--thinking true`로 로컬 추론 모드를 비교할 수 있다. 추론 토큰도 로컬 실행 시간/토큰에 포함한다.
이 PC의 최초 시험에서는 thinking 모드가 출력 한도에 걸려 중단됐다. 품질 향상을 가정해 기본값으로 켜지 않는다.
서버/모델이 없으면 음성 전체 다운로드 전에 실패하며 Claude 또는 외부 API로 자동 대체하지 않는다.
명시한 로컬 모델이 요청 형식을 지원하는지 실제로 시험한다. 참고: [Ollama API](https://docs.ollama.com/api/chat), [구조화 출력](https://docs.ollama.com/capabilities/structured-outputs).

## 기존 자료를 이용한 비교

```bash
node scripts/ck-context/cli.mjs run --vod 209492205 \
  --out out/ck-context/209492205/selection-test \
  --transcript out/analysis/seonghun-asr-20261012/setup-earlier/sensevoice.transcript.json \
  --transcript out/analysis/seonghun-asr-20261012/phase1/sensevoice.transcript.json \
  --frame 7302=out/analysis/vod-storage-quality-20261012/g7302-1080p.jpg \
  --frame 5760=out/ck/209492205/g0005760.jpg
```

이는 55분 표본이다. 앞서 작성한 `context-analysis.json`이나 수동 전달 예시는 모델 입력에 넣지 않는다.
이미지 원본은 모두 유지하며 추가 이미지 모델은 기본 꺼져 있다. `--vision-limit 2`로 화면 종류·가시성 선별만 비교할 수 있다.
`samples.json`의 VOD와 HLS 전역 시간축을 확인한다. API duration 축의 옛 전사는 먼저 정확한 축으로 변환해야 한다.

## 전체 VOD

```bash
node scripts/ck-context/cli.mjs run --vod 209492205 \
  --out out/ck-context/209492205/full
```

기존 `out/ck/<vod>/local/scan.json`이 있으면 읽고 복사한다. 없으면 공용 시간축·다운로더와 기존 SigLIP 판별기를 이용해 별도로 준비한다.
네트워크 요청은 기존 SOOP 게이트웨이를 통과한다. 후보/모델 학습 데이터나 운영 장부는 변경하지 않는다.
새로 준비할 때는 기존 `out/ck-detector/venv`와 SigLIP 분류기, 음성 처리에는 기존 `scripts/asr/transcribe.sh` 환경이 필요하다.
이 도구가 해당 환경을 재설치하거나 가중치를 학습하지 않는다. 검증된 이름 확대 함수도 새 실험 폴더 안에서 재사용한다.

음성 다운로드는 최대 5분씩, HLS 파일 경계를 나눠서 받는다. 원본 영상 조각은 `finally`에서 삭제한다.
WAV·전사·분석 체크포인트는 재개/검증을 위해 실험 폴더에 남긴다. **현재 버전은 WAV까지 자동 삭제하지 않는다.**
13시간 44분의 16kHz 모노 PCM은 약 1.58GB이며, 임시 영상·프레임·모델 공간은 별도다.
이 PC의 WSL 가상 여유 공간은 Windows 호스트 여유 공간과 다르다. 긴 실행 전 실제 저장소 공간을 확인한다.

전체 대신 일부 새 전사: `--ranges 4800:1200,11900:900`.
로컬에서 요청한 중요 구간만 한 차례 Qwen ASR 재확인: `--recheck-seconds 180`.
기본값은 0이므로 최초 비교에서는 재전사 없이 관련 자료의 선별 품질·시간을 확인한다.

## 재개와 실패

동일 `--out`은 음성/분석 캐시를 재사용한다. 모델 digest·입력·프롬프트·출력 형식이 달라지면 분석 캐시를 다시 만든다.
기존 해석 방식(v1) 출력 폴더는 새 선별 실행에서 사용하지 않는다. 비교할 수 있게 별도 폴더로 보존한다.
원본 scan이 바뀌었다면 새 실행 폴더로 비교한다. 프레임 누락·모델 실패는 보고서에 표시한다.
`.running`은 중복 실행 잠금이다. 강제 종료 뒤 남으면 기록된 PID의 종료를 확인한 뒤 그 실행의 잠금만 제거한다.
종료 코드 2는 일부 모델 분석/이미지 판독 실패가 있어 부분 산출물을 남겼다는 뜻이다. 1은 실행 실패, 0은 요청 처리가 끝난 상태다.
0도 전체 VOD 분석 완료·정답 검증을 의미하지 않는다. `coverage`를 확인한다.
`out/ck-context/_gpu/.running`은 이 실험 도구끼리만 공유한다. 기존 자동 조사에는 적용되지 않으므로 GPU가 바쁜 시간은 피한다.

## 검증

```bash
node --test scripts/ck-context/context.test.ts scripts/ck-local/finish.test.ts scripts/ck-local/review.test.ts scripts/ck-local/preparation-compat.test.mjs
```

전체 DB·웹 테스트는 이 독립 파일 도구에 필요하지 않다. 운영 코드나 스키마를 바꾸는 후속 작업에서는 저장소의 해당 검증을 수행한다.
