#!/usr/bin/env bash
# 자동 조사 한 번 — systemd 타이머(ck-auto.timer)가 6/12/18/24시에 부른다. 손으로 돌려도 된다.
#
#   scripts/ck-auto.sh            # 큐를 만들고, VOD 마다 ck-local 준비 → ck-local 조사(CK_AUTO_SKILL=ck-research 면 예전 방식)
#   scripts/ck-auto.sh --dry-run  # 큐만 만든다
#
# 설치(한 번):
#   ln -sf $PWD/scripts/systemd/ck-auto.{service,timer} ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now ck-auto.timer
#   loginctl enable-linger $USER     # 로그인 안 해도 돈다
#   systemctl --user list-timers     # 다음 회차 확인 · 로그는 out/ck/auto/run-*.log
#
# ★ 겹쳐 돌지 않는다. 6시간 안에 못 끝내면 다음 실행은 그냥 비킨다(flock).
#   못 끝낸 VOD 중 다음 회차가 다시 집는 것: running 도장이 있는 것(기간과 무관), 그리고 최근 3일 창 안의 new·partial·failed_left.
#   ⚠ 3일 창을 벗어난 미착수(new)·partial·failed_left 는 자동 큐가 다시 안 집는다 — 그건 사용자 요청 백필(ck-backfill) 몫이다.
#     타이머가 3일 넘게 못 돌았거나 큐 생성이 실패한 날이 있으면 그 기간을 백필로 채운다(이 스크립트는 그 경우 0 이 아닌 코드로 끝난다).
# ★ 큐가 비면 Claude 를 부르지 않는다. 토큰 0 으로 끝난다.
# ★ 지시문은 스킬을 대신하지 않는다 — 무엇을 반드시 하는지는 SKILL.md 가 정하고, 여기선 큐 파일 위치와
#   무인 실행에서 틀리기 쉬운 자리만 짚는다.
# ★ 조회가 잘려도(ck:queue 종료 코드 2) 받은 만큼은 조사한다. 로그에 경고가 남는다.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/out/ck/auto"
STAMP="$(TZ=Asia/Seoul date +%Y%m%d-%H%M)"
QUEUE="$DIR/queue-$STAMP.json"
LOG="$DIR/run-$STAMP.log"
export PATH="$HOME/.local/node/bin:$PATH"

mkdir -p "$DIR"
cd "$ROOT"

exec 9>"$DIR/.lock"
if ! flock -n 9; then
  echo "$(date -Is) 이전 실행이 아직 돈다 — 이번 회차는 건너뛴다" >>"$DIR/skipped.log"
  exit 0
fi

# ★ 종료 코드는 실패를 숨기지 않는다 — systemd 가 이 코드를 그대로 본다(systemctl --user status 에 실패가 보인다).
#   0 정상 · 1 큐 생성 실패(DB 접속 등 — 빈 큐와 구분된다) · 그 밖은 claude 조사 세션의 종료 코드.
#   ck:queue 가 2(목록이 잘림)면 받은 만큼 조사하되 로그에 경고를 남긴다(경고는 실패가 아니다).
QCODE=0
{
  echo "=== $(date -Is) ck-auto ==="
  npm run -s ck:queue -- --write "$QUEUE"
  QCODE=$?
  echo "ck:queue 종료 코드 $QCODE"
} >>"$LOG" 2>&1

if { [[ "$QCODE" != "0" && "$QCODE" != "2" ]]; } || [[ ! -s "$QUEUE" ]]; then
  echo "!!! 큐 생성 실패(종료 코드 $QCODE, 큐 파일 $([[ -s "$QUEUE" ]] && echo 있음 || echo 없음)) — 이번 회차는 조사하지 않는다. 빈 큐가 아니다" >>"$LOG"
  exit 1
fi
[[ "$QCODE" == "2" ]] && echo "경고: 목록 조회가 일부 잘렸다 — 받은 만큼만 조사한다" >>"$LOG"

N="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).queue.length)' "$QUEUE" 2>>"$LOG")" || {
  echo "!!! 큐 파일을 읽지 못했다($QUEUE) — 이번 회차는 조사하지 않는다" >>"$LOG"
  exit 1
}
if [[ "$N" == "0" || "${1:-}" == "--dry-run" ]]; then
  echo "큐 ${N}개 — Claude 를 부르지 않는다" >>"$LOG"
  exit 0
fi

# 조사 스킬. 기본은 ck-local — VOD 하나마다 로컬 판별기 준비를 먼저 돌리고 Claude 세션 하나로 조사한다.
#   2026-10-01 비교 시험(VOD 8개): ck-research 가 찾은 경기를 하나도 놓치지 않고 같은 값을 읽으면서 비용 64%·시간 44% 절감.
#   예전 방식(큐 전체를 세션 하나로 ck-research)으로 돌리려면 CK_AUTO_SKILL=ck-research.
SKILL="${CK_AUTO_SKILL:-ck-local}"

RULES="- 먼저 ck:record --lead vod:<번호> 와 ck:merge --find-match --vod <번호> 를 본다. 이미 기록된 경기도 처음부터 읽되 결과창은 도구가 준 예측 위치부터 찾고(못 찾으면 넓힌다), 그 match_id 로 이 화면에서 직접 읽은 칸만 match 제출한다(pov.link_basis 필수). 같다·다르다는 저장 도구가 판정한다.
- 카테고리와 상관없이 VOD 전 범위를 본다. 롤 화면을 보면 스킬의 '경기 추적'을 끝까지 한다. FC 온라인 화면을 실제로 열었으면 fco:context clue 만 넘긴다.
- VOD 를 끝낼 때마다 ck:merge 로 scan 을 반영한다. 필수 추적을 다 했으면 done(롤이 없었어도 done), 못 끝냈으면 running 으로 남긴다 — 다음 회차가 이어서 한다.
- reason 이 failed_left 인데 못 본 지점이 영상 길이 밖이라 원래 없는 구간이면, 그 구간을 scan.resolved_failed 로 닫는다. 안 닫으면 매 회차 다시 큐에 들어온다.
- reason 이 partial 이면 done 으로 기록됐지만 요청 범위가 영상 끝까지 닿지 않은 VOD 다. 빠진 범위를 훑고 opened·후보·note 에 남긴다. 요청 범위(requested)는 준비 단계가 정하니 직접 줄이거나 바꾸지 않는다."

# 세션 ID 를 정해서 넘기고 로그에 적는다 — 전체 기록(도구 호출 하나하나)은
# ~/.claude/projects/<프로젝트>/<세션ID>.jsonl 에 남는다. 이 로그엔 최종 요약만 찍힌다.
run_session() {  # $1 프롬프트 · $2 표시
  local session code
  session="$(cat /proc/sys/kernel/random/uuid)"
  echo "--- claude 시작 $(date -Is) · $2 · 세션 $session" >>"$LOG"
  claude -p "$1" --permission-mode bypassPermissions --session-id "$session" >>"$LOG" 2>&1
  code=$?
  echo "--- claude 종료 $(date -Is) · 코드 $code" >>"$LOG"
  return "$code"
}

if [[ "$SKILL" == "ck-research" ]]; then
  PROMPT="/ck-research 무인 자동 실행이다. 사람이 없으니 묻지 말고 끝까지 간다.
대상은 $QUEUE 의 queue 배열 VOD ${N}개다(와치리스트 채널 최근 3일 중 조사가 끝나지 않은 것 + 기간 밖의 running). 오래된 것부터 하나씩 한다. VOD 마다:
$RULES
- 끝나면 VOD 별 결과(경기 수·연결·미해결·못 본 구간·running 으로 남긴 것)를 짧게 요약한다."
  run_session "$PROMPT" "큐 ${N}개(ck-research)"
  # 조사 세션이 실패했으면(로그인 만료·사용량 한도 등) 그대로 알린다. 못 끝낸 VOD 는 다음 회차 큐에 다시 들어온다.
  exit $?
fi

# ── ck-local: VOD 하나마다 준비 → 세션 하나 (ck-backfill.sh 와 같은 모양) ─────────────
# ★ 준비가 실패해도 조사는 한다 — 실패를 프롬프트로 알리면 ck-local 스킬이 준비 실패 절차(ck-research 방식)로 간다.
# ★ Claude 세션이 실패하면(로그인 만료·사용량 한도 등) 남은 VOD 를 헛돌지 않고 그 코드로 끝낸다 — 다음 회차가 이어서 한다.
mapfile -t ITEMS < <(node -e 'for (const q of JSON.parse(require("fs").readFileSync(process.argv[1])).queue) console.log(`${q.title_no}\t${q.reason ?? ""}`)' "$QUEUE" 2>>"$LOG")
i=0
for item in "${ITEMS[@]}"; do
  i=$((i+1))
  VOD="${item%%$'\t'*}"; REASON="${item#*$'\t'}"
  PREP_OUT="$DIR/prep-$STAMP-$VOD.log"
  echo "=== [$i/${#ITEMS[@]}] vod:$VOD ($REASON) 준비 $(date -Is)" >>"$LOG"
  node scripts/ck-local/scan.mjs --vod "$VOD" >"$PREP_OUT" 2>&1; PCODE=$?
  PROMPT="/ck-local 무인 자동 실행이다. 사람이 없으니 묻지 말고 끝까지 간다. VOD 하나만 조사한다: vod:$VOD (큐 사유: ${REASON:-없음}, 큐 파일 $QUEUE).
분석은 ck-local 스킬을 그대로 따른다. 이 VOD 외의 VOD 는 시작하지 않고, SOOP 조사 도구는 병렬 실행하지 않는다.
$RULES"
  if (( PCODE == 0 )) && PREP_LINE="$(grep '^PREP: ' "$PREP_OUT" | tail -1)" && [[ -n "$PREP_LINE" ]]; then
    PROMPT+=$'\n'"준비 단계 결과(이번 실행): ${PREP_LINE#PREP: } — 이 run_id 의 산출물만 쓴다."
  else
    echo "준비 실패(종료 코드 $PCODE) — 로그 $PREP_OUT" >>"$LOG"
    PROMPT+=$'\n'"준비 단계 실패(종료 코드 $PCODE, 로그 $PREP_OUT) — 준비 산출물을 쓰지 말고 스킬의 준비 실패 절차로 조사한다."
  fi
  run_session "$PROMPT" "vod:$VOD" || exit $?
done
exit 0
