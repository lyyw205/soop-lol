# 수동 CK 백필

Node.js·npm 의존성과 기존 Claude CLI 로그인, ffmpeg 등 ck-research 환경을 준비한다.
Linux/WSL의 `flock`, `setsid`를 사용한다. 자동·수동 조사 컴퓨터는 한 대로 운영한다.
새 DB에는 `npm run db:migrate`로 `0044_ck_backfill_progress`까지 적용한다.

```bash
npm run ck:backfill -- status --streamer 이상호
scripts/ck-backfill.sh --streamer 이상호 --limit 5 --max-video-hours 20
```

사용자 요청 시에만 실행한다. 기본 5개·영상 합계 20시간이며 첫 영상이 상한보다 길면 단독 선택한다.
watch 대상은 최초 실행 시 자동 큐의 최근 3개 KST 날짜 밖부터, 나머지는 최초 실행 시각부터 최근순으로 내려간다.
이후 요청은 고정된 상한·진행 지점·미완료 VOD에서 이어간다.

로그와 큐는 `out/ck/backfill/run-*/`에 남는다. 타이머가 실행 중이면 종료 코드 75로 시작하지 않는다.
수동 실행 중에는 타이머가 같은 잠금을 얻지 못해 건너뛴다. Ctrl-C/TERM은 자식 조사 그룹도 종료한다.
Claude 실패 후에도 DB를 대조하고, 셸 자체가 중단되면 다음 요청에서 복구한다.

접근 불가 사유는 `raw.backfill_access`에 저장한다. 이 기록은 VOD를 읽었다는 뜻이 아니다.
확인된 접근 불가만 커서가 지나갈 수 있고 일시 오류는 재개 대상으로 남는다.
삭제·비공개로 처리한 VOD를 사용자가 명시적으로 재확인할 때:

```bash
mkdir -p out/ck/auto
flock -n out/ck/auto/.lock env CK_BACKFILL_LOCKED=1 \
  npm run ck:backfill -- access --streamer 이상호 --vod 123456 --status retry --reason '사용자가 재확인 요청'
# 이어서 위의 ck-backfill.sh를 실행한다.
```

`plan`, `checkpoint`, `access`는 잠금 아래에서만 사용하는 내부 변경 명령이다.
환경변수 표시는 운영 계약이며 보안 인증 수단이 아니다. 커서를 SQL로 임의 이동하지 않는다.

백필 표시만 있는 lead_only도 자동 큐에서 제외된다. 자동이 맡은 미완료 running을 만나면
그 앞까지 처리하고 중단한다. 자동 완료 뒤 다음 사용자 요청에서 이어간다.
전체 목록 소진은 확인 시점의 조회 가능 범위에 대한 결과다. 뒤늦게 공개된 과거 VOD의 전체 재대조는
일반 이어서 실행에 포함되지 않는다. 실행 컴퓨터를 바꾸면 이전 타이머·조사를 중지하고
같은 DB 설정과 out/ 근거 파일을 별도로 옮긴다.

검증 명령: `npm run verify:ck:backfill`은 임시 DB와 HTTP fixture로 진행 저장·CLI 재개를 확인한다.
`npm test`에는 날짜 경계·분량 제한과 실제 셸의 잠금·중단 회귀 테스트가 포함된다.
