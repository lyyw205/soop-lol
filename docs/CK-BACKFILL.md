# 수동 CK 백필

Node.js·npm 의존성과 기존 Claude CLI 로그인, ffmpeg 등 ck-research 환경을 준비한다.
Linux/WSL의 `flock`, `setsid`를 사용한다. 자동·수동 조사 컴퓨터는 한 대로 운영한다.
새 DB에는 `npm run db:migrate`로 `0046_ck_backfill_request`까지 적용한다.

```bash
npm run ck:backfill -- status --streamer 이상호
scripts/ck-backfill.sh --streamer 이상호 --from 2026-08-20 --to 2026-09-25   # 기간 지정(저장됨)
scripts/ck-backfill.sh --streamer 이상호                                    # 마지막 기간 이어서
scripts/ck-backfill.sh --streamer 이상호 --model haiku                      # 조사 세션(claude -p)만 다른 모델로
scripts/ck-backfill.sh --stop                                               # 지금 VOD 마친 뒤 멈춤
```

## 동작

1. **목록** — 기간의 VOD 를 SOOP 에서 전부 받는다(60개씩 페이지). SOOP 목록 API 는 `startDate`·`endDate`
   를 **둘 다** 줄 때만 날짜로 거르고, 한쪽만 주면 채널 전체를 준다(2026-09-28 실측). 날짜는 VOD 등록(=종료)
   시각의 KST 날짜다. 잘린 목록이나 기간 밖 VOD 가 섞인 응답은 오류로 멈춘다.
2. **거르기** — VOD 마다 조사 도장을 읽어 완료·확인된 접근 불가는 뺀다. 판정은 자동 조사(`ck:queue`)와 같은
   `vodWork` 다: `done`·실패 구간 없음·연 화면 있음·요청 범위가 영상 끝까지(끝 경계만 5초 허용).
3. **하나씩 조사** — VOD 하나에 `claude -p` 세션 하나. 시작 직전에 DB 도장을 다시 읽는다. 세션이 끝나면
   남은 일(못 본 초·실패 초·미해결 후보)이 줄었는지 확인한다. `running` 이 남으면 같은 VOD 를 새 세션으로 잇는다.
4. **끝** — 남은 VOD 가 없거나, 멈춤 요청(`--stop`)·진척 없음(4)·Claude 실패·중단(130)에서 끝난다.

진척 기록은 `event_lead.raw` 하나다. `ck_backfill_request` 는 채널별 **마지막 요청 기간**만 담는다 —
기간을 생략했을 때의 기본값이다. 목록에서 사라졌는데 DB 에 미완료로 남은 VOD 는 `missing` 으로 보고한다.

로그·큐·현재 VOD 는 `out/ck/backfill/run-*/`, 마지막 계획은 `out/ck/backfill/last-<채널>.json` 에 남는다.

## 자동 조사와의 관계

같은 `out/ck/auto/.lock` 을 잡는다. 백필이 도는 동안 자동 타이머는 건너뛰고, 자동이 도는 중이면 백필은 75 로
시작하지 않는다. 어느 쪽을 돌릴지는 사람이 정한다. 잠금은 둘을 동시에 띄운 사고로 SOOP 호출 속도가 두 배가
되는 것만 막는다(속도 제한이 프로세스마다 따로 있다).

백필이 `running` 으로 멈춘 VOD 는 와치리스트 채널이면 자동 조사가 기간과 무관하게 이어받는다(의도한 정책).
두 쪽이 같은 도장을 보므로 먼저 끝낸 쪽이 찍고, 다른 쪽은 건너뛴다.

## 접근 불가

사유·확인 시각은 `raw.access` 에 저장한다(자동·수동 공용). 이 기록은 VOD 를 읽었다는 뜻이 아니다.
확인된 `unavailable` 만 건너뛰고 `temporary` 는 다시 조사 대상이다. 재확인할 때:

```bash
mkdir -p out/ck/auto
flock -n out/ck/auto/.lock env CK_BACKFILL_LOCKED=1 \
  npm run ck:backfill -- access --vod 123456 --status retry --reason '사용자가 재확인 요청'
# 이어서 ck-backfill.sh 를 실행한다.
```

`plan`·`access` 는 잠금 아래에서만 쓰는 변경 명령이고, `next`·`after` 는 셸이 부르는 내부 명령이다.
환경변수 표시는 운영 계약이며 보안 인증 수단이 아니다.

## 검증

- `npm run verify:ck:backfill` — 임시 DB 와 **실제 SOOP 규칙대로 동작하는** HTTP fixture 로 옛 기록 정리,
  기간·페이지 조회, 공통 판정(끝 1초), 목록 밖 대조, 진척 판정, 재개, 접근 상태를 확인한다.
- `npm test` — 판정 함수·목록 조회 단위 테스트와 실제 셸의 반복·멈춤·잠금·중단 회귀 테스트.

설계 경위: [CK-BACKFILL-PLAN.md](CK-BACKFILL-PLAN.md)(0044, 대체됨) → 이 문서(0046).
