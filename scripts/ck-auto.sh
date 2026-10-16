#!/usr/bin/env bash
# 시간별 발견과 조사를 분리한다. 설치: scripts/systemd/install.sh --with-ck-auto
#   --poll (기본): 새 VOD 조회 → 실행 큐 갱신. Claude는 호출하지 않는다.
#   --work: 대기 큐를 롤 작업자 3개가 소비. 조사 중 들어온 VOD도 빈 작업자가 이어받는다.
#   --fc: FC API 맥락 조사(별도 매일 07:00 타이머).
#   --dry-run: 롤 대상만 확인. 큐 등록·조사 없음.
#   --print-prompt <VOD> [--who 표시] [--prep-line 'PREP: …'] [--listen-code N]: 롤 세션 지시문만 출력. 대기열·잠금·DB·Claude 없음.
# 중단: touch out/ck/auto/STOP (롤), FC_STOP (FC). 현재 세션 저장 후 멈추며 다음 회차에 재개한다.
# daily.lock으로 롤 조사 풀은 하나, 백필과 같은 채널 잠금으로 채널별 조사는 하나만 돈다.
# 완료·진척·반복 제한은 기존 ck:queue/DB 판정, queue.json은 실행 순서·소유권·재시도 시각만 관리한다.
# 세션 비용/이미지 예산, 저장 후 재개, 디스크 하한, 실행 시간 상한은 기존 조사와 같다.
# 운영 DB 점검(ops:usage --gate)을 회차 시작과 세션마다 본다. 쓰기 실패 표시(out/ops/write-blocked.json)가 생기면
# 진행 중인 롤 세션도 멈춘다(ck-image-budget 종료 코드 21).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/node/bin:$PATH"
cd "$ROOT"
# 감싸는 실행기(scripts/ops/run-job.ts)에 멈춘 이유를 남긴다 — 종료 코드 3 이 DB 관문·정지·시간 상한을 다 뜻해서 코드만으로는 모른다.
source "$ROOT/scripts/ops/ops-stop.sh"
# 이 실행기와 세션 안의 스크립트가 DB 에서 받은 바이트를 스크립트별로 남긴다(전송량 계측 — npm run ops:usage 가 묶어 보여 준다).
mkdir -p "$ROOT/out/ops"; export DB_WIRE_LOG="$ROOT/out/ops/db-wire.jsonl"

MODEL="${CK_AUTO_MODEL:-sonnet}"
MAX_BUDGET="${CK_AUTO_MAX_BUDGET:-3}"
LOL_JOBS="${CK_AUTO_LOL_JOBS:-3}"
FC_ENABLED="${CK_AUTO_FC:-1}"
MAX_MIN="${CK_AUTO_MAX_MIN:-300}"          # 이 시간이 지나면 새 대상을 시작하지 않는다
MIN_FREE_GB="${CK_AUTO_MIN_FREE_GB:-6}"    # C: 여유가 이 값 이하면 새 대상을 시작하지 않는다
IMAGE_WARN="${CK_AUTO_IMAGE_WARN_MIB:-8}"; IMAGE_LIMIT="${CK_AUTO_IMAGE_LIMIT_MIB:-12}"
SESSIONS_PER_VOD="${CK_AUTO_SESSIONS_PER_VOD:-3}"   # VOD 하나를 한 회차에 이어 볼 최대 세션 수(백필처럼 끝날 때까지, 단 상한)
MODE="${1:---poll}"
case "$MODE" in --poll|--work|--fc|--dry-run|--print-prompt) ;; *) echo "사용법: $0 [--poll|--work|--fc|--dry-run|--print-prompt <VOD>]" >&2; ops_stop error "사용법 오류: $MODE"; exit 1;; esac
DRY=0; [[ "$MODE" == --dry-run ]] && DRY=1
IDLE_SEC="${CK_AUTO_IDLE_SEC:-5}"
STAGGER_SEC="${CK_AUTO_STAGGER_SEC:-4}"

# VOD 하나의 지시문 — 백필(scripts/ck-backfill.sh 의 롤 지시문)과 대부분 같은 문장이다. 다른 곳(2026-10-16 대조):
#   실행기 이름·재개 파일 경로, 접근 불가 기록 명령(ck:queue / ck:backfill), "안 닫으면 …" 문장,
#   FC 단서·랜드 판 한 줄(자동만 — 같은 규칙이 ck-local 스킬에도 있다), 이미지 예산 안내(자동은 늘, 백필은 --image-limit-mib 일 때만).
#   공통 규칙 문장을 고치면 백필도 같이 고친다 — 두 실행기의 --print-prompt 를 diff 해서 확인한다.
lol_prompt() {  # $1 VOD · $2 표시 · $3 재개 요약 파일
  cat <<PROMPT
/ck-local 매일 와치리스트 조사의 VOD 하나를 조사한다: vod:$1 ($2). 사람이 없으니 묻지 말고 끝까지 간다.
분석은 ck-local 스킬을 그대로 따른다. 백필·매일 조사 셸을 재귀 실행하지 않고, 이 VOD 외의 VOD 는 시작하지 않는다.
SOOP 조사 도구는 병렬 실행하지 않는다. 먼저 $3 의 DB 재개 요약과 ck:merge --find-match --vod $1 를 본다.
요약에서 부족한 후보 근거·질문만 ck:record --lead 로 조회한다. 동일 VOD에서 저장 확인된 경기를 처음부터 재판독하지 않는다.
다른 VOD의 시점을 추가할 때는 기존 값을 복사하지 않고 직접 읽는다.
중단된 조사면 남은 지점부터 잇는다. 탐색 단계를 마칠 때마다 scan 을 running 과 지금까지의 범위로 ck:merge 에 저장해
세션이 중간에 끊겨도 진척이 남게 한다. 필수 조사를 모두 마쳤을 때만 done 으로 저장한다.
done은 탐색 완료이지 모든 값 확정이 아니다. 필수 탐색·결과창 보완·교차검증 처리를 끝냈다면 미해결 후보와 질문을 보존하고 done으로 저장한다.
완료 전 후보별 확인 구간·탐색 종료 사유·교차검증 시도와 한계를 확인한다. 남은 필수 탐색이 있으면 running과 구체적인 다음 행동을 남긴다.
미해결을 억지로 not_target으로 닫거나 삭제하지 않는다. 이전 인계의 사용자 판단 필요라는 말만으로 종료하지 말고 재개 요약의 completion_policy로 재평가한다.
재송출 결과창은 방송 주인이 그 경기·같은 시리즈·같은 대회의 참가자일 때만 rebroadcast 근거로 쓴다. 방송 주인과 무관한 남의 경기 시청은 not_target으로 관찰만 남긴다.
FC 온라인 화면을 실제로 열었으면 fco:context clue 만 넘긴다. 랜드·보너스 판(범인찾기 등)은 ck-research 의 '진행 방식' 규칙대로 낸다.
삭제·비공개를 실제 확인했으면 npm run ck:queue -- access --vod $1 --status unavailable --reason <확인 근거> 로 남긴다.
일시 오류는 --status temporary 로 남기고 이 세션을 끝낸다. scan.failed 는 시간 범위 배열이며 사유를 넣지 않는다.
못 본 구간이 영상 길이 밖이거나 세그먼트가 영구 누락이라 다시 봐도 못 푸는 것이면 scan.resolved_failed 로 닫고 이유를 note 에 남긴다.
안 닫으면 매일 같은 VOD 가 다시 대상에 들어오고 진척 없음으로 멈춘다.
종료 뒤 셸이 DB 도장으로 진척을 확인한다. 완료·연결·접근 불가·남은 범위를 요약한다.
작업 폴더는 $ROOT 이다. 스킬이 명령으로 안 보이면 $ROOT/.claude/skills/ck-local/SKILL.md 를 Read로 직접 읽는다. 다른 프로젝트 폴더로 이동하지 않는다.
이 세션은 이미지 ${IMAGE_WARN} MiB에서 저장 안내, ${IMAGE_LIMIT} MiB 초과 열람 차단을 적용한다.
안내를 받으면 읽은 관찰·후보·경기를 ck:merge에 저장하고 종료한다. 필수 탐색이 남으면 running과 scan.resume의 next_action·context를 남긴다. 이미 필수 탐색을 모두 마쳤으면 위 done 조건을 따른다.
모든 조사 산출물 JSON은 out/ck/$1/ 아래에 Write/Edit로 작성한다. 원본 사진을 자르거나 화질을 낮추지 않는다.
차단 뒤에는 새 탐색을 하지 않는다. 저장은 단일 npm run ck:merge -- --result <파일>, 필요한 기록 조회는 npm run ck:record -- --lead vod:$1 명령으로 한다.
ck:local --finish를 쓰면 --status running --resume <인계 JSON>을 명시한다(요청 범위는 준비 단계가 영상 전체로 정해 두었으니 적지 않는다).
개요만 본 상태는 원본 opened를 꾸미지 말고 기존 scan 입력으로 ck:merge에 저장한다. 경기값을 모르면 후보의 관찰·질문으로 남긴다.
이미지를 준비한 사실은 열람 근거가 아니다. 예산 소진은 done 조건이 아니며, 다음 세션은 DB 저장분만 이어받는다.
PROMPT
}

# 세션 하나에 넘기는 전체 지시문 — 실제 실행과 --print-prompt 가 같은 함수를 쓴다(문장을 고치면 둘이 함께 바뀐다).
lol_session_prompt() {  # $1 VOD · $2 표시 · $3 재개 요약 파일 · $4 준비 PREP 줄(빈 값: 준비 실패) · $5 준비 로그 · $6 음성 준비 종료 코드(빈 값: 음성 준비 안 함) · $7 음성 로그
  local prompt
  prompt="$(lol_prompt "$1" "$2" "$3")"
  if [[ -n "$4" ]]; then
    prompt+=$'\n'"준비 단계 결과(이번 실행): ${4#PREP: } — 이 run_id 의 산출물만 쓴다."
  else
    prompt+=$'\n'"준비 단계 실패(로그 $5) — 준비 산출물을 쓰지 말고 스킬의 준비 실패 절차로 조사한다."
  fi
  if [[ -n "$6" ]]; then
    prompt+=$'\n'"음성 준비 종료 코드 $6 (로그 $7). ck:listen status --vod $1 확인. 활성화됐으면 결과창 판독 뒤 분류 제출 전에 준비 대화를 필수 열람한다(첫 경기 전 기본 30분). 준비 종료 코드가 실패여도 status 의 coverage(이미 전사된 범위)는 읽는다 — missing 만 확인 불가로 기록하고 기존 조사로 진행한다. 준비는 화면 지도의 첫 경기 30분 전~마지막 경기 끝(+5분)만 했다(--plan) — 그 밖 범위가 필요하면 npm run ck:listen -- prepare --vod $1 --between 시작초:끝초 로 그 범위만 준비한 뒤 읽는다."
  fi
  printf '%s' "$prompt"
}

# 지시문만 출력하고 끝낸다 — 대기열·잠금·DB·Claude 를 건드리지 않는다. 문장을 고칠 때 전후를 diff 로 확인하는 용도
#   (docs/AUTOMATION-REDESIGN-PLAN.md §5.5.7). 경로는 실제 실행의 run 폴더 대신 run-print 로 찍힌다.
#   --prep-line 이 없으면 준비 실패 문장, --listen-code 가 없으면 음성 준비 문장을 뺀다(실행에서는 ck-listen 이 있으면 늘 붙는다).
if [[ "$MODE" == --print-prompt ]]; then
  P_VOD="${2:-}"; [[ "$P_VOD" =~ ^[0-9]+$ ]] || { echo "사용법: $0 --print-prompt <VOD> [--who 표시] [--prep-line 줄] [--listen-code N]" >&2; exit 1; } # ops: 출력 모드는 감싸지 않는다
  P_WHO="print, 대상 사유: print, 이번 회차 1번째 세션"; P_PREP=""; P_LISTEN=""
  shift 2
  while (( $# )); do
    (( $# >= 2 )) || { echo "$1 값 필요" >&2; exit 1; } # ops: 출력 모드
    case "$1" in --who) P_WHO="$2";; --prep-line) P_PREP="$2";; --listen-code) P_LISTEN="$2";; *) echo "알 수 없는 인자: $1" >&2; exit 1;; esac # ops: 출력 모드
    shift 2
  done
  P_RUN="$ROOT/out/ck/auto/run-print"; P_TAG="$P_VOD-0-1"
  lol_session_prompt "$P_VOD" "$P_WHO" "$P_RUN/resume-$P_VOD.json" "$P_PREP" "$P_RUN/prep-$P_TAG.log" "$P_LISTEN" "$P_RUN/listen-$P_TAG.log"
  echo
  exit 0 # ops: 출력 모드
fi

BASE="$ROOT/out/ck/auto"
STATE="$BASE/daily-state.json"
STOP_FILE="$BASE/STOP"
LOCK=poll
[[ "$MODE" == --work ]] && LOCK=daily
[[ "$MODE" == --fc ]] && { LOCK=fc; STOP_FILE="$BASE/FC_STOP"; }
mkdir -p "$BASE" "$ROOT/out/ck/backfill"
exec 9>"$BASE/$LOCK.lock"
if ! flock -n 9; then
  if [[ "$MODE" == --work ]]; then
    # 수동 조사 풀이 있으면 대기한다. wake를 남긴 채 즉시 끝내면 path가 무한 재기동한다.
    echo "$(date -Is) 이전 조사 풀이 끝나기를 기다린다" >>"$BASE/skipped.log"
    flock 9 || { ops_stop error "조사 잠금을 기다리다 실패"; exit 1; }
  else
    echo "$(date -Is) $MODE 이전 실행이 아직 돈다 — 중복 실행 생략" >>"$BASE/skipped.log"
    ops_stop skipped "이전 $MODE 실행이 아직 돈다 — 중복 실행 생략"; exit 0
  fi
fi
RUN=$(mktemp -d "$BASE/run-${MODE#--}-$(TZ=Asia/Seoul date +%Y%m%d-%H%M%S)-XXXXXX")
LOG="$RUN/run.log"
START=$(date +%s)
say() { echo "$(TZ=Asia/Seoul date +%T) $*" >>"$LOG"; }
fail() { say "!!! $*"; echo "$*" >>"$RUN/failures"; }
say "=== $MODE 시작 · model=$MODEL budget=\$$MAX_BUDGET lol-jobs=$LOL_JOBS max-min=$MAX_MIN"

# DB 판정 상태와 실행 큐의 갱신을 각각 직렬화한다. poll은 daily.lock을 잡지 않는다.
queue_cmd() { flock "$BASE/daily-state.lock" npm run -s ck:queue -- "$@" --state "$STATE"; }
work_cmd() { flock "$BASE/queue.lock" node scripts/ck-auto-queue.ts "$1" "$BASE" "${@:2}"; }
# 운영 DB 점검(npm run ops:usage) — 잠겼거나 한도 95%·물리 디스크 90% 이상이거나 쓰기 실패 기록이 있으면 3.
# 정상이 아니면 판정 문장을 실행 로그에 남긴다(미확인 항목도 그대로).
WRITE_FLAG="$ROOT/out/ops/write-blocked.json"
db_gate() {  # $1 표시 · 나머지는 ops:usage 인자
  local out c; out=$(npm run -s ops:usage -- --gate "${@:2}" 2>&1); c=$?
  [[ "$out" == "DB 점검 정상" ]] || say "[$1] $out"
  return "$c"
}

if [[ "$MODE" == --poll || "$MODE" == --dry-run ]]; then
  PLAN_ARGS=(); (( DRY )) || PLAN_ARGS+=(--enqueue)
  queue_cmd plan "${PLAN_ARGS[@]}" --write "$RUN/lol.json" >>"$LOG" 2>&1; QCODE=$?
  if [[ "$QCODE" != 0 && "$QCODE" != 2 ]] || [[ ! -s "$RUN/lol.json" ]]; then
    say "!!! 롤 대상 생성 실패(코드 $QCODE) — 기존 실행 큐를 보존한다"; ops_stop error "롤 대상 생성 실패(코드 $QCODE)"; exit 1
  fi
  (( QCODE == 2 )) && say "경고: 목록 일부 잘림 — 받은 대상과 기존 대기 목록을 보존한다"
  if (( DRY )); then say "미리보기 — 큐 등록·Claude 호출 없음"; ops_stop completed "미리보기(큐 등록 없음)"; exit 0; fi
  work_cmd enqueue "$RUN/lol.json" >>"$LOG" 2>&1 || { fail "실행 큐 등록 실패"; ops_stop error "실행 큐 등록 실패"; exit 1; }
  say "목록 갱신 완료 — worker.path가 빈 조사 풀을 깨운다"
  ops_stop completed "목록 갱신$( (( QCODE == 2 )) && echo " · 목록 일부 잘림(받은 대상만 등록)")"; exit 0
fi

rm -f "$STOP_FILE"
# 회차 시작 점검 — 통과하면 지난 쓰기 실패 표시를 지운다. 막히면 세션을 하나도 띄우지 않는다
# (2026-10-12 읽기 전용인 줄 모르고 조사 세션이 저장에 실패했다).
if ! db_gate 시작 --clear-flag; then
  [[ "$MODE" == --work ]] && work_cmd pause >>"$LOG" 2>&1  # 깨우기 요청을 지워 path 가 곧바로 다시 띄우지 않게 한다
  say "=== 운영 DB 점검에서 멈춤 — npm run ops:usage 로 확인. 다음 시간별 회차가 다시 본다"; ops_stop blocked_external "운영 DB 점검(회차 시작) — npm run ops:usage"; exit 3
fi
FC_N=0
if [[ "$MODE" == --fc ]]; then
  (( FC_ENABLED )) || { ops_stop no_work "FC 조사 꺼짐(CK_AUTO_FC=0)"; exit 0; }
  queue_cmd fc --write "$RUN/fc.json" >>"$LOG" 2>&1 || { fail "FC 대상 생성 실패"; ops_stop error "FC 대상 생성 실패"; exit 1; }
  FC_N=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).queue.length)' "$RUN/fc.json") || { ops_stop error "FC 대상 수 읽기 실패"; exit 1; }
  (( FC_N > 0 )) || { say "FC 대상 없음"; ops_stop no_work "FC 맥락 미조사 경기 없음"; exit 0; }
else
  [[ "$LOL_JOBS" =~ ^[1-9][0-9]*$ ]] || { fail "잘못된 LOL_JOBS"; ops_stop error "잘못된 LOL_JOBS"; exit 1; }
  # 독점 조사 잠금을 잡은 뒤에만 이전 실행의 소유권과 깨우기 요청을 회수한다.
  work_cmd recover >>"$LOG" 2>&1 || { fail "실행 큐 복구 실패"; ops_stop error "실행 큐 복구 실패"; exit 1; }
fi

# ── 공통 판정 ───────────────────────────────────────────────────────
# 0 계속 · 3 멈춤(디스크·시간·중단 요청·다른 작업자의 Claude 실패)
# 멈춘 이유는 회차 끝에 한 번 남긴다(ops_stop) — 작업자 여럿이 동시에 멈추면 처음 이유를 쓴다.
note_stop() { (set -C; printf '%s\t%s\n' "$1" "$2" >"$RUN/stop-note") 2>/dev/null || true; }
may_start() {
  [[ -f "$STOP_FILE" ]] && { say "[$1] 중단 요청 — 새 대상을 시작하지 않는다"; note_stop user_stop "멈춤 파일(${STOP_FILE#"$ROOT"/})"; return 3; }
  [[ -f "$RUN/abort" ]] && return 3
  (( ($(date +%s) - START) / 60 >= MAX_MIN )) && { say "[$1] 실행 시간 상한 ${MAX_MIN}분 — 남은 대상은 다음 회차"; note_stop time_cap "실행 시간 상한 ${MAX_MIN}분"; return 3; }
  if [[ -d /mnt/c ]]; then
    local free; free=$(df -BG /mnt/c | awk 'NR==2{gsub("G","",$4);print $4}')
    (( free <= MIN_FREE_GB )) && { say "[$1] C: 여유 ${free}GB ≤ ${MIN_FREE_GB}GB — 멈춘다"; note_stop blocked_external "C: 여유 ${free}GB ≤ ${MIN_FREE_GB}GB"; touch "$RUN/abort"; return 3; }
  fi
  # 세션마다 다시 본다 — 회차 도중에 잠기거나 다른 세션이 쓰기에 실패했으면 새 세션을 띄우지 않는다.
  [[ -f "$WRITE_FLAG" ]] && { say "[$1] 운영 DB 쓰기 실패 기록($WRITE_FLAG) — 새 세션을 시작하지 않는다"; note_stop blocked_external "운영 DB 쓰기 실패 기록(out/ops/write-blocked.json)"; touch "$RUN/abort"; return 3; }
  db_gate "$1" || { note_stop blocked_external "운영 DB 점검(세션 전) — npm run ops:usage"; touch "$RUN/abort"; return 3; }
  return 0
}
# Claude 종료 코드 정리 — 비용 상한·이미지 차단은 정상 인계다(진척은 settle 이 DB 로 판정한다).
claude_code() {  # $1 원래 코드 · $2 세션 출력 JSON
  local code=$1
  (( code == 20 )) && return 0
  if (( code != 0 )) && node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).subtype==="error_max_budget_usd"?0:1)' "$2" 2>/dev/null; then return 0; fi
  return "$code"
}
# 무인 세션은 자동 메모리를 쓰지 않는다 — FC 세션들이 사람용 메모리 폴더에 회차 메모를 7개 남겼다(2026-10-08).
export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
CLAUDE_BASE=(--permission-mode bypassPermissions --output-format json --no-session-persistence --model "$MODEL" --max-budget-usd "$MAX_BUDGET")

# ── 롤 작업자 — 공용 큐에서 VOD 를 하나씩: 채널 잠금 → (begin → 준비 → 세션 → finish) × 최대 SESSIONS_PER_VOD ──
lol_worker() {  # $1 작업자 번호
  local w=$1 vod ch reason who n bcode fcode code prep line prompt out tag lockfd claimed delay_seconds listen_log listen_code
  local owner="$RUN/$1"
  # 예상 밖 작업자 종료도 다른 작업자를 영원히 기다리게 하지 않는다.
  claimed_vod=""; claimed_owner="$owner"
  trap 'if [[ -n "$claimed_vod" ]]; then work_cmd release "vod:$claimed_vod" "$claimed_owner" 3600 >>"$LOG" 2>&1; fi' EXIT
  while true; do
    may_start "롤$w" || return 0
    claimed=$(work_cmd claim "$owner" 2>>"$LOG"); code=$?
    if (( code == 4 )); then sleep "$IDLE_SEC"; continue; fi
    (( code == 3 )) && return 0
    (( code == 0 )) || { fail "[롤$w] 실행 큐 읽기 실패($code)"; return 1; }
    IFS=$'\t' read -r vod ch reason who <<<"$claimed"
    claimed_vod="$vod"
    delay_seconds=3600
    exec {lockfd}>"$ROOT/out/ck/backfill/channel-$ch.lock" || { fail "[롤$w] 채널 잠금 실패"; return 1; }
    if ! flock -n "$lockfd"; then
      say "[롤$w] vod:$vod ($who) — 백필 조사 중, 1시간 뒤 재시도"
      exec {lockfd}>&-
      work_cmd release "vod:$vod" "$owner" 3600 >>"$LOG" 2>&1 || return 1
      claimed_vod=""; continue
    fi
    say "[롤$w] vod:$vod ($who, $reason) 시작"
    for ((n = 1; n <= SESSIONS_PER_VOD; n++)); do
      (( n > 1 )) && { may_start "롤$w" || break; }
      queue_cmd begin --vod "$vod" --dir "$RUN" >>"$LOG" 2>&1; bcode=$?
      (( bcode == 3 )) && { say "[롤$w] vod:$vod 끝"; delay_seconds=done; break; }
      (( bcode == 4 )) && { say "[롤$w] vod:$vod 반복 제한으로 보류"; delay_seconds=done; break; }
      (( bcode == 0 )) || { fail "[롤$w] vod:$vod 시작 판정 실패(코드 $bcode) — 건너뛴다"; break; }
      tag="$vod-$(date +%s%N)-$n" # 같은 실행 중 재시도해도 이전 세션 로그를 덮지 않는다
      prep="$RUN/prep-$tag.log"
      nice -n 10 ionice -c3 node scripts/ck-local/scan.mjs --vod "$vod" --reuse >"$prep" 2>&1
      line="$(grep '^PREP: ' "$prep" | tail -1)"
      listen_code=""; listen_log=""
      if [[ -f scripts/ck-listen/cli.mjs ]]; then
        listen_log="$RUN/listen-$tag.log"
        node scripts/ck-listen.mjs prepare --vod "$vod" --if-enabled --plan lol >"$listen_log" 2>&1 # 화면 지도의 경기 활동 구간만
        listen_code=$?
      fi
      prompt="$(lol_session_prompt "$vod" "$who, 대상 사유: $reason, 이번 회차 $n번째 세션" "$RUN/resume-$vod.json" "$line" "$prep" "$listen_code" "$listen_log")"
      out="$RUN/session-$tag.json"
      setsid node scripts/ck-image-budget.ts run --state "$RUN/image-$tag.json" --output "$out" --vod "$vod" \
        --warn-mib "$IMAGE_WARN" --limit-mib "$IMAGE_LIMIT" --flush-seconds 180 -- claude -p "$prompt" "${CLAUDE_BASE[@]}" </dev/null >>"$LOG" 2>&1
      claude_code $? "$out"; code=$?
      queue_cmd finish --vod "$vod" --dir "$RUN" >>"$LOG" 2>&1; fcode=$?
      if (( fcode == 0 || fcode == 3 )); then echo "$vod" >>"$RUN/sessions-done"; ops_progress "$(wc -l <"$RUN/sessions-done")" "" "세션" "vod:$vod"; fi
      node scripts/ck-session-usage.ts "$out" "$RUN/after-$vod.json" "$BASE/usage.jsonl" "$MODEL" >>"$LOG" 2>&1 \
        || say "[롤$w] vod:$vod 사용량을 집계하지 못했다. 원본: $out"
      # 경기에 연결된 결과창마다 앞뒤 3장(3초 간격) 원본을 사람 검수용으로 올린다 — 셸이 하므로 토큰 0. 실패해도 조사는 계속.
      nice -n 10 node --env-file-if-exists=apps/web/.env.local scripts/ck-neighbors.ts --vod "$vod" >>"$LOG" 2>&1 \
        || say "[롤$w] vod:$vod 앞뒤 원본을 다 못 올렸다 — 나중에: npm run ck:neighbors -- --vod $vod"
      (( code == 21 )) && say "[롤$w] vod:$vod 운영 DB 쓰기가 막혀 세션을 멈췄다($WRITE_FLAG)"
      if (( code != 0 )); then say "[롤$w] vod:$vod Claude 실패(코드 $code) — 모든 작업자를 멈춘다"; note_stop error "Claude 실패(코드 $code, vod:$vod)"; echo "$code" >"$RUN/abort"; exec {lockfd}>&-; return 0; fi
      (( fcode == 3 )) && { say "[롤$w] vod:$vod 끝"; delay_seconds=done; break; }
      (( fcode == 4 )) && { say "[롤$w] vod:$vod 진척 없음/반복 제한 — 6시간 뒤 판정"; delay_seconds=21600; break; }
      (( fcode == 0 )) || { fail "[롤$w] vod:$vod 진척 확인 실패(코드 $fcode)"; break; }
    done
    exec {lockfd}>&-
    work_cmd release "vod:$vod" "$owner" "$delay_seconds" >>"$LOG" 2>&1 || { fail "[롤$w] 실행 큐 반환 실패"; return 1; }
    claimed_vod=""
  done
}

# ── FC 작업자 — 스트리머마다 최근 30일 맥락 미조사 API 경기를 판정 ───────────────────
fc_worker() {
  local slug who n key out code from
  from=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).from)' "$RUN/fc.json")
  # ★ claude -p 는 파이프로 들어온 표준입력을 프롬프트에 붙여 읽는다 — 반복문의 남은 목록을 삼켜서
  #   첫 스트리머 뒤에 작업자가 끝났다(2026-10-08). 그래서 claude 호출은 항상 </dev/null.
  while IFS=$'\t' read -r slug who n; do
    [[ -z "$slug" ]] && continue
    may_start "FC" || return 0
    key="fc:$slug"
    say "[FC] $who 미조사 ${n}건 시작"
    queue_cmd snapshot --key "$key" >>"$LOG" 2>&1 || { fail "[FC] $key 시작 기록 실패 — 건너뛴다"; continue; }
    out="$RUN/session-fc-$slug.json"
    setsid claude -p "/fco-match-context 무인 매일 자동 조사다. 사람이 없으니 묻지 말고 끝까지 간다.
대상: 스트리머 $slug($who)의 $from 이후 넥슨 API 경기 중 맥락 '미조사' 경기 — npm run fco:context -- list --streamer $slug --from $from --status uninvestigated --vods 로 시작한다.
API 경기의 맥락 판정만 한다. VOD 결과 화면으로 API 에 없는 경기를 새로 기록하는 일(screen, 30일 이전)은 하지 않는다.
경기마다 event 결론(대회·CK·컨셉 행사 소속) 또는 unresolved 사유를 fco:context apply 로 반영하고, 실제로 연 프레임은 근거로 건다. 행사명·주최자를 지어내지 않는다.
세션 비용 상한 안에서 다 못 하면 처리한 만큼 반영하고 끝낸다 — 다음 날 남은 미조사부터 잇는다.
작업 폴더는 $ROOT 이다. 스킬이 명령으로 안 보이면 $ROOT/.claude/skills/fco-match-context/SKILL.md 를 Read 로 직접 읽는다." \
      "${CLAUDE_BASE[@]}" </dev/null >"$out" 2>>"$LOG"
    claude_code $? "$out"; code=$?
    queue_cmd settle --key "$key" >>"$LOG" 2>&1; local scode=$?
    (( scode == 0 || scode == 4 )) || fail "[FC] $key 진척 확인 실패(코드 $scode)"
    echo "$slug" >>"$RUN/fc-done"; ops_progress "$(wc -l <"$RUN/fc-done")" "$FC_N" "스트리머" "$slug"
    if (( code != 0 )); then say "[FC] Claude 실패(코드 $code) — 모든 작업자를 멈춘다"; note_stop error "Claude 실패(코드 $code, $slug)"; echo "$code" >"$RUN/abort"; return 0; fi
  done < <(node -e 'for (const q of JSON.parse(require("fs").readFileSync(process.argv[1])).queue) console.log([q.slug, q.streamer, q.uninvestigated].join("\t"))' "$RUN/fc.json")
}

trap 'say "TERM — 작업자를 회수한다"; touch "$STOP_FILE"; kill -TERM $(jobs -p) 2>/dev/null; wait; [[ "$MODE" == --work ]] && work_cmd pause; ops_stop killed "중단 신호(TERM·INT) — 작업자를 회수했다"; exit 130' INT TERM
PIDS=()
if [[ "$MODE" == --work ]]; then
  for ((w = 0; w < LOL_JOBS; w++)); do (lol_worker "$w") & PIDS+=("$!"); sleep "$STAGGER_SEC"; done
else
  fc_worker & PIDS+=("$!")
fi
# 작업자가 스스로 죽으면(잠금 파일을 못 여는 등) 그 코드를 놓치지 않는다 — wait 하나로 뭉치면 0 이 된다.
for pid in "${PIDS[@]}"; do wait "$pid" || fail "작업자(pid $pid)가 비정상 종료(코드 $?) — 그 몫의 대상은 다음 회차"; done

# 조사가 끝난 VOD 폴더를 보관 디스크(T7)로 옮긴다 — C: 를 채우는 건 끝난 VOD 의 사진이었다(2026-10-09 여유 6GB 이하로 멈춤).
# 보관 디스크가 없거나 끊기면 건너뛰고(첫 실패에서 멈춤) 조사 결과에는 영향을 주지 않는다. 다음 회차가 다시 시도한다.
if grep -q " /mnt/d " /proc/mounts && touch /mnt/d/.ck-probe 2>/dev/null && rm -f /mnt/d/.ck-probe; then
  say "끝난 VOD 폴더를 보관 디스크로 옮긴다"
  nice -n 15 ionice -c3 node --env-file-if-exists=apps/web/.env.local scripts/ck-archive.ts --stop-on-error >>"$LOG" 2>&1 \
    || say "보관 일부 실패 — 원본은 그대로다. 나중에: npm run ck:archive -- --stop-on-error"
else
  say "보관 디스크(/mnt/d)가 없거나 쓸 수 없어 VOD 폴더 보관을 건너뛴다"
fi

CODE=0
if [[ -f "$RUN/abort" ]]; then c=$(cat "$RUN/abort" 2>/dev/null); [[ "$c" =~ ^[0-9]+$ ]] && CODE=$c || CODE=3; fi
(( CODE == 0 )) && [[ -s "$RUN/failures" ]] && CODE=1
[[ -f "$STOP_FILE" ]] && (( CODE == 0 )) && CODE=3
if [[ "$MODE" == --work ]] && { (( CODE != 0 )) || (( ($(date +%s) - START) / 60 >= MAX_MIN )); }; then
  work_cmd pause >>"$LOG" 2>&1 || CODE=1
fi
say "=== 끝 (종료 코드 $CODE, $(( ($(date +%s) - START) / 60 ))분) · 상태 $STATE"
# 멈춘 이유 — 실패 기록 > 작업자가 남긴 이유 > 멈춤 파일 > 정상 종료. 이유를 못 정하면 종료 코드만 적는다(오류).
if [[ -s "$RUN/failures" ]] && (( CODE == 1 )); then ops_stop error "실패 $(wc -l <"$RUN/failures")건 — $(head -1 "$RUN/failures")"
elif [[ -s "$RUN/stop-note" ]]; then IFS=$'\t' read -r note_reason note_detail <"$RUN/stop-note"; ops_stop "$note_reason" "$note_detail"
elif [[ -f "$STOP_FILE" ]]; then ops_stop user_stop "멈춤 파일(${STOP_FILE#"$ROOT"/})"
elif (( CODE == 0 )); then ops_stop completed "$([[ "$MODE" == --fc ]] && echo "FC 스트리머 ${FC_N}명" || echo "대기 소진")"
else ops_stop error "종료 코드 $CODE"; fi
exit "$CODE"
