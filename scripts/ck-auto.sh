#!/usr/bin/env bash
# 자동 조사 한 번 — systemd 타이머(ck-auto.timer)가 6/12/18/24시에 부른다. 손으로 돌려도 된다.
#
#   scripts/ck-auto.sh            # 큐를 만들고, 있으면 ck-research 스킬에 넘긴다
#   scripts/ck-auto.sh --dry-run  # 큐만 만든다
#
# 설치(한 번):
#   ln -sf $PWD/scripts/systemd/ck-auto.{service,timer} ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now ck-auto.timer
#   loginctl enable-linger $USER     # 로그인 안 해도 돈다
#   systemctl --user list-timers     # 다음 회차 확인 · 로그는 out/ck/auto/run-*.log
#
# ★ 겹쳐 돌지 않는다. 6시간 안에 못 끝내면 다음 실행은 그냥 비킨다(flock).
#   못 끝낸 VOD 는 scan.status 가 done 이 아니므로 다음 큐에 다시 들어온다 — 버려지지 않는다.
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

{
  echo "=== $(date -Is) ck-auto ==="
  npm run -s ck:queue -- --write "$QUEUE"
  echo "ck:queue 종료 코드 $?"
} >>"$LOG" 2>&1

N="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).queue.length)' "$QUEUE" 2>>"$LOG" || echo 0)"
if [[ "$N" == "0" || "${1:-}" == "--dry-run" ]]; then
  echo "큐 ${N}개 — Claude 를 부르지 않는다" >>"$LOG"
  exit 0
fi

PROMPT="/ck-research 무인 자동 실행이다. 사람이 없으니 묻지 말고 끝까지 간다.
대상은 $QUEUE 의 queue 배열 VOD ${N}개다(와치리스트 채널 최근 3일 중 조사가 끝나지 않은 것 + 기간 밖의 running). 오래된 것부터 하나씩 한다.
- VOD 마다 먼저 ck:record --lead vod:<번호> 와 ck:merge --find-match --vod <번호> 를 본다. 이미 기록된 경기도 처음부터 읽고, 그 match_id 로 이 화면에서 직접 읽은 칸만 match 제출한다(pov.link_basis 필수). 같다·다르다는 저장 도구가 판정한다.
- 카테고리와 상관없이 VOD 전 범위를 훑는다. 롤 화면을 보면 스킬의 '경기 추적' 세 단계를 반드시 끝까지 한다. FC 온라인이 보이면 fco:context clue 만 넘긴다.
- VOD 하나를 끝낼 때마다 ck:merge 로 scan 을 반영한다. 필수 추적을 다 했으면 done(롤이 없었어도 done), 못 끝냈으면 running 으로 남긴다 — 다음 회차가 이어서 한다.
- reason 이 failed_left 인데 못 본 지점이 영상 길이 밖이라 원래 없는 구간이면, 그 구간을 scan.resolved_failed 로 닫는다. 안 닫으면 매 회차 다시 큐에 들어온다.
- reason 이 partial 이면 done 으로 기록됐지만 요청 범위가 영상 끝까지 닿지 않은 VOD 다. 빠진 범위를 훑고 requested 에 넣는다.
- 끝나면 VOD 별 결과(경기 수·연결·미해결·못 본 구간·running 으로 남긴 것)를 짧게 요약한다."

# 세션 ID 를 정해서 넘기고 로그에 적는다 — 전체 기록(도구 호출 하나하나)은
# ~/.claude/projects/<프로젝트>/<세션ID>.jsonl 에 남는다. 이 로그엔 최종 요약만 찍힌다.
SESSION="$(cat /proc/sys/kernel/random/uuid)"
{
  echo "--- claude 시작 $(date -Is) · 큐 ${N}개 · 세션 $SESSION"
  claude -p "$PROMPT" --permission-mode bypassPermissions --session-id "$SESSION"
  echo "--- claude 종료 $(date -Is) · 코드 $?"
} >>"$LOG" 2>&1
