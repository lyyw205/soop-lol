#!/usr/bin/env bash
# 수동 백필 — 사용자 요청으로만 실행. 요청 기간의 VOD 를 최신순으로 하나씩, 남은 게 없을 때까지 조사한다.
#
#   scripts/ck-backfill.sh --streamer 이상호 --from 2026-08-20 --to 2026-09-25   # 기간 지정(저장된다)
#   scripts/ck-backfill.sh --streamer 이상호                                    # 마지막 요청 기간을 이어서
#   scripts/ck-backfill.sh --streamer 김민교 --model haiku --from ...           # 조사 세션만 다른 모델로
#   scripts/ck-backfill.sh --stop                                               # 지금 VOD 를 마친 뒤 멈춤
#   Ctrl-C / TERM                                                               # 즉시 멈춤(조사 중 VOD 는 마지막 저장 지점부터)
#
# ★ --model 은 claude -p 조사 세션에만 건다. 전역 기본 모델(/model, ~/.claude/settings.json)은
#   안 건드린다 — 다른 백필·자동 조사가 이 실행이 끝난 뒤에도 계속 원래 기본값을 쓰게 한다.
# ★ VOD 하나에 Claude 세션 하나. 세션이 끝날 때마다 DB 도장을 다시 읽어 실제 진척을 확인한다.
#   진척이 없거나 Claude 가 실패하면 멈춘다 — 사용량 한도·로그인 만료에 목록을 헛돌지 않는다.
# ★ 자동 조사와 같은 flock 을 잡는다. 둘을 동시에 띄운 사고로 SOOP 호출 속도가 두 배가 되는 걸 막는다.
#
# 종료 코드: 0 끝까지·요청으로 멈춤 · 75 다른 조사 실행 중 · 130 중단 · 4 진척 없음 · 그 외 실패
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/node/bin:$PATH"
cd "$ROOT"
STOP_FILE="$ROOT/out/ck/backfill/STOP"
STREAMER=""; FROM=""; TO=""; MODEL=""
while (( $# )); do
  case "$1" in
    --streamer|--from|--to|--model)
      if (( $# < 2 )); then echo "$1 값 필요" >&2; exit 1; fi
      case "$1" in --streamer) STREAMER="$2";; --from) FROM="$2";; --to) TO="$2";; --model) MODEL="$2";; esac
      shift 2;;
    --stop)
      mkdir -p "$(dirname "$STOP_FILE")"; touch "$STOP_FILE"
      echo '멈춤 요청을 남겼다. 지금 조사 중인 VOD 를 마친 뒤 멈춘다.'; exit 0;;
    --help) sed -n 2,16p "$0"; exit 0;;
    *) echo "알 수 없는 인자: $1" >&2; exit 1;;
  esac
done
[[ -n "$STREAMER" ]] || { echo '--streamer 필요' >&2; exit 1; }
for program in node claude flock setsid; do command -v "$program" >/dev/null || { echo "$program 필요" >&2; exit 1; }; done
mkdir -p out/ck/auto out/ck/backfill
exec 9>out/ck/auto/.lock
flock -n 9 || { echo '다른 CK 조사가 실행 중이다. 이번 백필은 시작하지 않는다.'; exit 75; }
export CK_BACKFILL_LOCKED=1
# 지난 실행이 소비하지 못한 멈춤 요청이 새 실행을 곧바로 멈추지 않게 한다.
rm -f "$STOP_FILE"
DIR="$(mktemp -d "$ROOT/out/ck/backfill/run-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
QUEUE="$DIR/queue.json"; CURRENT="$DIR/current.json"; LOG="$DIR/run.log"
: >"$LOG"  # cli() 의 첫 호출이 아직 없는 파일을 <로 열다 리다이렉션 오류를 내는 것을 막는다.
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
  echo '중단됨. 다음 실행이 DB 도장을 다시 읽어 이어간다.' | tee -a "$LOG"
  exit 130
}
trap stop INT TERM
run_child() {
  setsid "$@" >>"$LOG" 2>&1 & CHILD=$!
  wait "$CHILD"; local code=$?; CHILD=""; return "$code"
}
# 로그에 쌓되, 이번 명령이 남긴 줄은 화면에도 보여준다.
cli() {
  local n; n=$(wc -l <"$LOG" 2>/dev/null || echo 0)
  run_child node --env-file-if-exists=apps/web/.env.local scripts/ck-backfill.ts "$@"; local code=$?
  tail -n +"$((n+1))" "$LOG"; return "$code"
}
say() { echo "$*" | tee -a "$LOG"; }

PLAN_ARGS=(plan --streamer "$STREAMER" --write "$QUEUE")
[[ -n "$FROM" ]] && PLAN_ARGS+=(--from "$FROM")
[[ -n "$TO" ]] && PLAN_ARGS+=(--to "$TO")
cli "${PLAN_ARGS[@]}"; CODE=$?
(( CODE == 0 )) || exit "$CODE"

SESSIONS=0; RESULT=""
while true; do
  if [[ -f "$STOP_FILE" ]]; then rm -f "$STOP_FILE"; RESULT='요청으로 멈춤'; CODE=0; break; fi
  cli next --queue "$QUEUE" --current "$CURRENT"; CODE=$?
  if (( CODE == 3 )); then RESULT='요청 기간을 끝까지 처리'; CODE=0; break; fi
  (( CODE == 0 )) || { RESULT='다음 VOD 선택 실패'; break; }
  VOD="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(c.vod.title_no)' "$CURRENT")" || { CODE=1; RESULT='current.json 읽기 실패'; break; }
  SESSIONS=$((SESSIONS+1))
  PROMPT="/ck-research 수동 백필의 VOD 하나를 조사한다: $CURRENT 의 vod (번호 $VOD).
분석은 ck-research 스킬을 그대로 따른다. ck-backfill 스킬이나 셸을 재귀 실행하지 않고, 이 VOD 외의 VOD 는 시작하지 않는다.
SOOP 조사 도구는 병렬 실행하지 않는다. 먼저 이전 기록(ck:record --lead)과 ck:merge --find-match --vod $VOD 를 보고,
중단된 조사면 남은 지점부터 잇는다. 탐색 단계를 마칠 때마다 scan 을 running 과 지금까지의 범위로 ck:merge 에 저장해
세션이 중간에 끊겨도 진척이 남게 한다. 필수 조사를 모두 마쳤을 때만 done 으로 저장한다.
삭제·비공개를 실제 확인했으면 npm run ck:backfill -- access --vod $VOD --status unavailable --reason <확인 근거> 로 남긴다.
일시 오류는 --status temporary 로 남기고 이 세션을 끝낸다. scan.failed 는 시간 범위 배열이며 사유를 넣지 않는다.
못 본 구간이 영상 길이 밖이거나 세그먼트가 영구 누락이라 다시 봐도 못 푸는 것이면 scan.resolved_failed 로 닫고 이유를 note 에 남긴다.
안 닫으면 다음 실행이 같은 VOD 에서 진척 없음으로 멈춘다.
종료 뒤 셸이 DB 도장으로 진척을 확인한다. 완료·연결·접근 불가·남은 범위를 요약한다."
  CLAUDE_ARGS=(-p "$PROMPT" --permission-mode bypassPermissions)
  [[ -n "$MODEL" ]] && CLAUDE_ARGS+=(--model "$MODEL")
  run_child claude "${CLAUDE_ARGS[@]}"; CLAUDE_CODE=$?
  cli after --current "$CURRENT"; AFTER_CODE=$?
  if (( CLAUDE_CODE != 0 )); then RESULT="Claude 실행 실패(종료 코드 $CLAUDE_CODE)"; CODE=$CLAUDE_CODE; break; fi
  if (( AFTER_CODE == 4 )); then RESULT='진척 없음'; CODE=4; break; fi
  (( AFTER_CODE == 0 )) || { RESULT='진척 확인 실패'; CODE=$AFTER_CODE; break; }
done
say "종료: $RESULT · 조사 세션 ${SESSIONS}회"
cli status --streamer "$STREAMER"
echo "전체 로그: $LOG"
exit "$CODE"
