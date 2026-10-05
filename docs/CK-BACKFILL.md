# 수동 CK 백필

Node.js·npm 의존성과 기존 Claude CLI 로그인, ffmpeg 등 ck-research 환경을 준비한다.
Linux/WSL의 `flock`, `setsid`를 사용한다. 자동·수동 조사 컴퓨터는 한 대로 운영한다.
DB에는 `0071_aram_collection_split`까지 적용한 뒤 새 수집 코드를 실행한다.
운영 적용 전 `npm run db:migrate -- --status`로 대기 목록을 확인한다(다른 작업의 마이그레이션도 함께 있을 수 있다).

```bash
npm run ck:backfill -- status --streamer 이상호
scripts/ck-backfill.sh --streamer 이상호 --from 2026-08-20 --to 2026-09-25   # 기간 지정(저장됨)
scripts/ck-backfill.sh --streamer 이상호                                    # 마지막 기간 이어서
scripts/ck-backfill.sh --streamer 이상호 --model haiku                      # 조사 세션(claude -p)만 다른 모델로
scripts/ck-backfill.sh --streamer 이상호 --session-games 5                   # 시험용 세션 분할(기본 0: 분할 목표 끔)
scripts/ck-backfill.sh --streamer 임아니 --from 2026-09-10 --to 2026-09-10 --vod 206719759 --image-limit-mib 12 # 이미지 제한 시험
scripts/ck-backfill.sh --stop                                               # 현재 세션의 저장 경계에서 멈춤
npm run ck:backfill -- context --vod 123456                                  # DB에서 만든 짧은 재개 요약
```

## 동작

1. **목록** — 기간의 VOD 를 SOOP 에서 전부 받는다(60개씩 페이지). SOOP 목록 API 는 `startDate`·`endDate`
   를 **둘 다** 줄 때만 날짜로 거르고, 한쪽만 주면 채널 전체를 준다(2026-09-28 실측). 날짜는 VOD 등록(=종료)
   시각의 KST 날짜다. 잘린 목록이나 기간 밖 VOD 가 섞인 응답은 오류로 멈춘다.
2. **거르기** — VOD 마다 조사 도장을 읽어 완료·확인된 접근 불가는 뺀다. 판정은 자동 조사(`ck:queue`)와 같은
   `vodWork` 다: `done`·실패 구간 없음·연 화면 있음·요청 범위가 영상 끝까지(끝 경계만 5초 허용).
3. **하나씩 조사** — 세션 하나는 VOD 하나만 맡는다. 분할을 지정하면 긴 영상을 경기 저장 경계에서 여러 세션으로 나눈다.
   시작 직전에 DB 도장·저장 시점·후보를 다시 읽어 `resume.json`으로 전달한다. 세션이 끝나면
   남은 일 감소 또는 새 원본 열람·후보 결론·시점 저장을 확인한다. `running`이면 같은 VOD를 잇는다.
   같은 파일 재전송이나 메모 변경만으로 진척으로 보지 않는다. 원본 열람만 늘고 결과 진척이 없는 세션은 연속 3회 후 미완료로 멈춘다.
4. **끝** — 남은 VOD 가 없거나, 멈춤 요청(`--stop`)·진척 없음(4)·Claude 실패·중단(130)에서 끝난다.

진척 기록은 `event_lead.raw` 하나다. `ck_backfill_request` 는 채널별 **마지막 요청 기간**만 담는다 —
기간을 생략했을 때의 기본값이다. 목록에서 사라졌는데 DB 에 미완료로 남은 VOD 는 `missing` 으로 보고한다.

로그·큐·현재 VOD 는 `out/ck/backfill/run-*/`, 마지막 계획은 `out/ck/backfill/last-<채널>.json` 에 남는다.

`done`은 필수 탐색을 마쳤다는 뜻이다. 미해결 후보는 `review_pending`과 `review_pending_vods`로 별도 보고한다.
재개 요약의 `completion_policy`는 매 `next`/`context` 호출 때 생성한다. 이전 인계가 ‘미해결이라 완료 불가’라고 해도
후보별 확인 구간·결과창 보완 탐색·교차검증 시도와 한계로 다시 판단한다. 필수 수행이 끝났으면 질문을 보존하고 `done`,
남은 필수 수행이 있으면 구체적인 다음 행동과 `running`이다. 미해결 수만 보고 자동 완료하거나 후보를 삭제하지 않는다.
다른 방송을 비춘 결과창도 직접 판독한 `rebroadcast` 근거로 사용할 수 있다. 방송 주인의 참가 여부만으로 보류하지 않는다.
실행 중 셸도 다음 재개 요약부터 최신 규칙을 받는다. 이미 종료된 워커의 자동 재시작이나 기존 도장의 변경은 하지 않는다.
이 수는 경기의 빈 칸이나 시점 간 불일치 총수가 아니다. 저장 경기의 불일치는 기존 검수 화면과 `ck:record --match`에서 확인한다.
대체 후보의 부모(`supersedes`)는 이력으로 남지만 미해결 수에서 제외한다.

## 짧은 세션과 사용량

이미지 제한은 `--image-limit-mib 12`로 켜는 시험 기능이며 기본은 꺼져 있다. LoL 백필과 Claude Code 2.1.285에서 검증한다.
기본 8 MiB에서 저장·종료를 안내하고 12 MiB 초과 열람은 거부한다. `--image-warn-mib`로 안내 지점을 조절할 수 있다.
많은 작은 사진은 60회에서 끊는다. 원본 파일은 바꾸지 않으며, 계수는 JPEG/PNG의 base64 크기 상한을 사용한다.
현재 검증 범위는 가로·세로 각각 2000px 이하, 파일 3 MiB 이하의 JPEG/PNG다. 다른 형식·큰 이미지는 변환하지 않고 거부한다.

이 모드에서는 백필 자식만 기본 거부 권한과 `PermissionRequest` 훅을 사용한다. 훅 정상 승인 없이는 도구가 실행되지 않아
훅 오류·타임아웃·누락도 열람 허용으로 바뀌지 않는다. 도구는 조사에 필요한 기본 도구로 제한하고 MCP는 싣지 않는다.
8 MiB 안내는 권고이며, 실제 저장 여부는 세션 종료 후 기존 DB 재조회로 확인한다.
12 MiB 차단 뒤에는 Write/Edit와 저장·텍스트 조회 명령만 허용한다. 저장·종료는 기본 180초 또는 30회 도구 요청까지이며,
`CK_BACKFILL_IMAGE_FLUSH_SECONDS`로 시간만 조절할 수 있다. 강제 종료 후에도 저장 진척이 없으면 기존 규칙으로 중단한다.

`--vod <번호>`는 요청 채널·기간 안에서 해당 영상 하나만 고른다. 다른 채널·기간의 번호나 없는 번호로 전체 백필을 시작하지 않는다.
세션별 `image-*.json`, 이미지 승인·거부 기록, `session-*.json.stream.jsonl`, 종료 사유 `.exit.json`을 실행 폴더에 남긴다.
강제 종료로 최종 사용량이 없으면 0으로 보고하지 않는다. 상세 계획과 검증 기록은 [이미지 누적 개선 계획](CK-BACKFILL-SESSION-PLAN.md)을 본다.

운영 DB에 쓰지 않는 유료 비교 시험은 아래 명령으로 실행한다. 새 PGlite와 별도 작업 폴더를 만들고 과거 판독 결과를 입력에서 제외한다.
운영 DB는 이름 자료·평가 정답을 SELECT로만 읽으며, 정답은 판독 작업 폴더 밖에 둔다.

```bash
node --env-file-if-exists=apps/web/.env.local scripts/benchmark-ck-image-budget.ts --run --vod 206719759 --budget 12
```

기본 실행 모델은 `sonnet`이다. `--model` 또는 `CK_BACKFILL_MODEL`로 바꾸며 전역 Claude 설정을 바꾸지 않는다.
`--session-games`/`CK_BACKFILL_SESSION_GAMES`는 **지시문상의 목표**로서 강제 중단 한도가 아니다.
대조 시험 전 기본값은 **0(분할 목표 끔)**이다. 5경기가 최적이거나 토큰이 절반 줄어든다는 근거는 없다.
0이 더 저렴하다는 뜻도 아니다. 어려운 경기 하나는 여전히 오래 걸릴 수 있다.

열람만 있는 세션은 탐색 활동으로 기록하지만, 결과 진척(저장 시점·후보 결론·남은 범위 감소·완료)과 구분한다.
결과 진척 없는 세션이 연속 3회면 종료 코드 4로 멈춘다. 실제 결과 진척이 있으면 횟수를 초기화하므로 긴 VOD 전체에 3회 제한을 걸지는 않는다.
횟수와 마지막 비교 값은 `out/ck/backfill/guards/<게임>-<VOD>.json`에 원자적으로 기록해 백필 재실행에도 유지한다.
이는 실행 비용 제한이며 DB의 완료 상태나 재개 위치를 대신하지 않는다. 같은 `after` 재호출은 두 번 세지 않는다.
원인을 해결한 뒤 `scripts/ck-backfill.sh --streamer <채널> --reset-stall`로 첫 미완료 VOD의 제한만 명시적으로 초기화할 수 있다.
DB에서 실제 결과가 진척된 경우에도 재개할 수 있다. 파일이 손상되면 조용히 초기화하지 않고 오류로 멈춘다.

경기마다 `ck:merge` 저장을 확인하고 `running`·미해결 후보를 남긴다. 요청 범위(`scan.requested`)는 실행기(준비 단계)의 것이라 세션이 정하지 않는다 — 세션이 한 일은 `opened`·후보·`note`·`resume` 에 남긴다. `done` 저장이 요청 범위를 못 채우면 `ck:merge` 가 경고하고 종료 코드 3 으로 끝낸다. 과거에 그렇게 남은 VOD 는 `ck:backfill status` 의 `done_range_gap_vods` 로 본다. 다음 행동은
`scan.resume: {next_action, next_at?, context?}`에 짧게 기록한다. 이 메모가 완료 판정을 대신하지 않는다.
같은 VOD에서 저장된 결과는 재사용하되, 다른 VOD의 새 시점은 직접 읽는다.
`ck-local --reuse`는 준비 코드·모델 지문과 파일 존재·실패 범위를 검사해 유효한 준비물을 재사용한다.

- `session-N.json`: Claude CLI의 최종 JSON, 세션 ID·사용 모델·사용량 원본.
- `run.log`: 최종 응답의 한 줄 요약(최대 1,600자)과 원본 JSON 경로. 요약에 추가 모델 호출을 쓰지 않는다.
- `usage.jsonl`: 세션별 입력/캐시 쓰기/캐시 읽기/출력, 호출 턴 수, 시간, 새 저장 시점 수.
- `after.json`: 해당 세션 전후 DB 진척. 조회 실패 시 이전 세션 값을 재사용하지 않는다.

`api_equivalent_usd`는 CLI가 보고한 API 환산값이며 구독 계정의 실제 청구액이 아니다.
사용량 원본이 없으면 집계 실패로 보고하며 0으로 채우지 않는다. 저장 시점 0개인 탐색 세션도 비교에서 제외하지 않는다.
백필을 2시간 후 강제 종료하는 상위 실행기는 별도로 피해야 한다. 이 셸은 강제 종료된 상위 프로세스를 복원하지 못한다.

병렬 실행은 `scripts/ck-backfill-par.sh --jobs 3 --streamer A --streamer B ...`로 한다.
같은 채널의 다른 별칭도 중복 실행을 막는다. 진척 없는 채널은 나머지 채널의 진행을 막지 않지만 최종 코드는 4다.
워커의 채널 잠금 충돌(75)은 채널을 건너뛰고 나머지를 시작하며, 건너뛴 수를 보고한다.
병렬 실행기 자체의 공통 잠금 충돌(75)은 전체 실행을 시작하지 않는다. 실제 Claude/조회 실패는 계속 전체 신규 배정을 중단한다.
SOOP 도구의 채널 안 직렬 실행과 `SOOP_PACE`는 유지한다.

## 칼바람 분리

소량 운영 검증은 `scripts/ck-backfill.sh --streamer <채널> --session-games 2 --max-sessions 1`로 실행한다.
`--max-sessions`는 저장·진척·사용량 확인까지 마친 뒤 반복을 멈춘다. 기본 0은 제한 없음이며 기간 완료 도장을 만들지 않는다.

보상 유무와 관계없이 스트리머끼리의 칼바람 내전도 수집한다. 새 `match` 제출에는
`game_mode: "ARAM"` 또는 `"CLASSIC"`이 필수다. 모드를 못 확인했으면 미해결 후보로 남긴다.
`event.kind`는 대회/보상 성격이고 모드와 별개다. 보상 미확인을 임의로 CK로 바꾸지 않는다.

0071은 칼바람 경기·상대전적·챔피언 통계를 일반 공개 뷰에서 분리하고
`core_public.aram_match`, `aram_encounter`, `aram_champion_stat`에 제공한다.
별도 상단 메뉴는 후속 모듈로 만들며 원본 테이블을 직접 읽지 않는다.
과거 `CUSTOM` 경기에는 모드 정보가 없으므로 제목으로 일괄 변환하지 않는다.
확인한 경기의 정정은 연결되어 있고 읽음이 기록된 근거 프레임을 사용한다:

```bash
node --env-file-if-exists=apps/web/.env.local scripts/ck-mode.ts \
  --match <경기ID> --mode ARAM --frame out/ck/<VOD>/g0000123.jpg --reason '123초 로비에서 칼바람 나락 확인'
# 출력된 변경을 실제 반영할 때만 같은 명령에 --apply를 붙인다.
```

기본은 미리보기다. 적용 시 경기 분류·맵·조우·챔피언 통계·수정 이력을 한 트랜잭션으로 갱신한다.
이미 다른 정정이 모드를 바꿨으면 거부하며, API 원본 경기는 이 도구로 수정하지 않는다.

## 자동 조사와의 관계

같은 `out/ck/auto/.lock` 을 잡는다. 백필이 도는 동안 자동 타이머는 건너뛰고, 자동이 도는 중이면 백필은 75 로
시작하지 않는다. 어느 쪽을 돌릴지는 사람이 정한다. 잠금은 둘을 동시에 띄운 사고로 SOOP 호출 속도가 두 배가
되는 것만 막는다(속도 제한이 프로세스마다 따로 있다).

백필이 `running` 으로 멈춘 VOD 는 와치리스트 채널이면 자동 조사가 기간과 무관하게 이어받는다(의도한 정책).
두 쪽이 같은 도장을 보므로 먼저 끝낸 쪽이 찍고, 다른 쪽은 건너뛴다.
위 연속 세션 제한은 수동 백필 실행기에 적용한다. 자동 조사의 기존 배정 정책은 바꾸지 않는다.

## 접근 불가

사유·확인 시각은 `raw.access` 에 저장한다(자동·수동 공용). 이 기록은 VOD 를 읽었다는 뜻이 아니다.
확인된 `unavailable` 만 건너뛰고 `temporary` 는 다시 조사 대상이다. 재확인할 때:

```bash
mkdir -p out/ck/auto
flock -n out/ck/auto/.lock env CK_BACKFILL_LOCKED=1 \
  npm run ck:backfill -- access --vod 123456 --status retry --reason '사용자가 재확인 요청'
# 이어서 ck-backfill.sh 를 실행한다.
```

`plan`·`access` 는 잠금 아래에서만 쓰는 변경 명령이고, `target`·`next`·`after` 는 셸이 부르는 내부 명령이다.
환경변수 표시는 운영 계약이며 보안 인증 수단이 아니다.

## 검증

- `npm run verify:ck:backfill` — 임시 DB 와 **실제 SOOP 규칙대로 동작하는** HTTP fixture 로 옛 기록 정리,
  기간·페이지 조회, 공통 판정(끝 1초), 목록 밖 대조, 진척 판정, 재개, 접근 상태를 확인한다.
- `npm test` — 판정 함수·목록 조회 단위 테스트와 실제 셸의 반복·멈춤·잠금·중단 회귀 테스트.

설계 경위: [CK-BACKFILL-PLAN.md](CK-BACKFILL-PLAN.md)(0044, 대체됨) → 이 문서(0046).
최신 검토·검증·운영 확대 계획: [CK-BACKFILL-HARDENING-PLAN.md](CK-BACKFILL-HARDENING-PLAN.md).
