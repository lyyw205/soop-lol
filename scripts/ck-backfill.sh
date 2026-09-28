#!/usr/bin/env bash
# 사용자 요청으로만 실행. 자동과 같은 flock을 큐 생성~자식 종료~체크포인트 동안 유지한다.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/node/bin:$PATH"
cd "$ROOT"
STREAMER=""; LIMIT=5; HOURS=20
while (( $# )); do
  case "$1" in
    --streamer|--limit|--max-video-hours)
      if (( $# < 2 )); then echo "$1 값 필요" >&2; exit 1; fi
      case "$1" in --streamer) STREAMER="$2";; --limit) LIMIT="$2";; --max-video-hours) HOURS="$2";; esac
      shift 2;;
    --help) echo 'scripts/ck-backfill.sh --streamer <이름> [--limit 5] [--max-video-hours 20]'; exit 0;;
    *) echo "알 수 없는 인자: $1" >&2; exit 1;;
  esac
done
[[ -n "$STREAMER" ]] || { echo '--streamer 필요' >&2; exit 1; }
for program in node claude flock setsid; do command -v "$program" >/dev/null || { echo "$program 필요" >&2; exit 1; }; done
mkdir -p out/ck/auto out/ck/backfill
exec 9>out/ck/auto/.lock
flock -n 9 || { echo '다른 CK 조사가 실행 중이다. 이번 백필은 시작하지 않는다.'; exit 75; }
export CK_BACKFILL_LOCKED=1
DIR="$(mktemp -d "$ROOT/out/ck/backfill/run-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
QUEUE="$DIR/queue.json"; LOG="$DIR/run.log"
echo "로그: $LOG"
CHILD=""
stop() {
  trap '' INT TERM
  if [[ -n "$CHILD" ]]; then
    kill -TERM -- "-$CHILD" 2>/dev/null || true
    # 외부 조사 도구를 포함한 프로세스 그룹을 회수한 뒤 잠금을 놓는다.
    for _ in {1..20}; do kill -0 -- "-$CHILD" 2>/dev/null || break; sleep 0.2; done
    kill -KILL -- "-$CHILD" 2>/dev/null || true
    wait "$CHILD" 2>/dev/null || true
  fi
  echo '중단됨. 다음 요청에서 저장된 DB 상태를 대조해 재개한다.' >>"$LOG"
  exit 130
}
trap stop INT TERM
run_child() {
  setsid "$@" >>"$LOG" 2>&1 & CHILD=$!
  wait "$CHILD"; local code=$?; CHILD=""; return "$code"
}
run_child node --env-file-if-exists=apps/web/.env.local scripts/ck-backfill.ts plan --streamer "$STREAMER" --limit "$LIMIT" --max-video-hours "$HOURS" --write "$QUEUE"
PLAN_CODE=$?
[[ -f "$QUEUE" ]] || { tail -20 "$LOG"; exit "$PLAN_CODE"; }
N="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).queue.length)' "$QUEUE")" || exit 1
CLAUDE_CODE=0
if [[ "$N" != 0 ]]; then
  PROMPT="/ck-research 수동 백필 실행이다. $QUEUE 의 queue VOD를 주어진 최근순으로 최대 $N 개 조사한다.
분석은 ck-research 스킬을 그대로 따른다. ck-backfill 스킬이나 셸을 재귀 실행하지 않는다.
SOOP 조사 도구는 병렬 실행하지 않는다. VOD마다 이전 기록과 --find-match --vod를 먼저 보고 근거를 재사용한다.
각 VOD 결과를 ck:merge로 즉시 저장한다. 시간 부족/일시 실패로 못 끝내면 running과 남은 범위를 기록하고 뒤 VOD를 시작하지 않는다.
삭제·비공개를 실제 확인했으면 ck:backfill access --streamer <queue.target.slug> --vod <번호> --status unavailable --reason <확인 근거>로 남긴다. 단순 오류는 temporary다. scan.failed는 시간 범위 배열이며 사유를 넣지 않는다.
진행 커서는 직접 수정하지 않는다. 종료 뒤 셸이 DB를 확인한다. 완료·연결·접근 불가·미완료를 구분해 요약한다."
  run_child claude -p "$PROMPT" --permission-mode bypassPermissions
  CLAUDE_CODE=$?
fi
run_child node --env-file-if-exists=apps/web/.env.local scripts/ck-backfill.ts checkpoint --streamer "$STREAMER"
CHECK_CODE=$?
tail -35 "$LOG"
echo "전체 로그: $LOG"
(( CHECK_CODE == 0 )) || exit "$CHECK_CODE"
(( CLAUDE_CODE == 0 )) || exit "$CLAUDE_CODE"
exit "$PLAN_CODE"
