#!/usr/bin/env bash
# 매일 와치리스트 조사 — systemd 타이머(ck-auto.timer)가 매일 아침 부른다. 손으로 돌려도 된다.
#
#   scripts/ck-auto.sh             # 롤: 채널마다 이전에 조사한 다음부터 · FC: 최근 30일 API 경기 맥락 판정
#   scripts/ck-auto.sh --dry-run   # 대상만 만든다(Claude 를 부르지 않는다)
#   touch out/ck/auto/STOP         # 지금 조사 중인 대상을 저장까지 마친 뒤 멈춘다
#
# 설치(한 번):
#   ln -sf $PWD/scripts/systemd/ck-auto.{service,timer} ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now ck-auto.timer
#   loginctl enable-linger $USER     # 로그인 안 해도 돈다 · 다음 회차: systemctl --user list-timers
#
# ★ 매일 조사와 백필은 다른 일이다(2026-10-08 개편) — 대상 규칙은 scripts/ck-queue.ts 머리말.
#   백필 코드(ck-backfill*.sh·ck-backfill.ts)와 그 진척 기준은 건드리지 않는다. 공용 부품만 같이 쓴다:
#   ck-local 준비(scripts/ck-local/scan.mjs), 이미지 예산(scripts/ck-image-budget.ts), 완료 판정(vodWork).
# ★ 잠금 — 백필의 공통 잠금(out/ck/auto/.lock)은 잡지 않는다. 백필이 몇 시간 쥐고 있어 그걸 기다리면 매일 조사가
#   백필이 도는 날마다 통째로 밀린다. 대신 ① 자기 잠금(daily.lock)으로 매일 조사끼리 겹치지 않고
#   ② 백필과 **같은 채널 잠금**(out/ck/backfill/channel-<채널>.lock)을 VOD 마다 잡아, 백필이 그 채널을 조사 중이면
#   그 VOD 만 건너뛴다(다음 날 잇는다). 다른 채널은 백필과 동시에 간다.
# ★ 백필과 같은 안전장치를 건다: sonnet · 세션 비용 상한 · 세션 기록 끄기(--no-session-persistence, 세션 기록이
#   하루 21.7GB 쌓여 C: 를 채운 적이 있다) · 이미지 예산(롤) · 진척 없음 3회면 그 대상 건너뜀 · C: 여유 하한 ·
#   실행 시간 상한 · 판별기는 낮은 우선순위(nice/ionice — 게임과 같이 돌 때 부하).
# ★ 동시 실행 — 롤은 채널 단위로 LOL_JOBS 개(채널 안은 순서대로), FC 는 1개. 기본 3+1=4(게임 병행 기준).
#   밀린 분량은 실행 시간 상한 안에서 하루씩 따라잡는다.
# ★ 종료 코드: 0 정상 · 1 대상 생성 실패 · 3 디스크 하한·중단 요청으로 멈춤 · 그 밖은 Claude 실패 코드(로그인 만료·사용량 한도).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/node/bin:$PATH"
cd "$ROOT"

MODEL="${CK_AUTO_MODEL:-sonnet}"
MAX_BUDGET="${CK_AUTO_MAX_BUDGET:-3}"
LOL_JOBS="${CK_AUTO_LOL_JOBS:-3}"
FC_ENABLED="${CK_AUTO_FC:-1}"
MAX_MIN="${CK_AUTO_MAX_MIN:-300}"          # 이 시간이 지나면 새 대상을 시작하지 않는다
MIN_FREE_GB="${CK_AUTO_MIN_FREE_GB:-6}"    # C: 여유가 이 값 이하면 새 대상을 시작하지 않는다
IMAGE_WARN="${CK_AUTO_IMAGE_WARN_MIB:-8}"; IMAGE_LIMIT="${CK_AUTO_IMAGE_LIMIT_MIB:-12}"
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1

BASE="$ROOT/out/ck/auto"
STATE="$BASE/daily-state.json"
STOP_FILE="$BASE/STOP"
mkdir -p "$BASE"
exec 9>"$BASE/daily.lock"
if ! flock -n 9; then
  echo "$(date -Is) 이전 매일 조사가 아직 돈다 — 이번 회차는 건너뛴다" >>"$BASE/skipped.log"
  exit 0
fi
rm -f "$STOP_FILE"
RUN="$BASE/run-$(TZ=Asia/Seoul date +%Y%m%d-%H%M)"
mkdir -p "$RUN"
LOG="$RUN/run.log"
START=$(date +%s)
say() { echo "$(TZ=Asia/Seoul date +%T) $*" >>"$LOG"; }
say "=== 매일 조사 시작 · model=$MODEL budget=\$$MAX_BUDGET lol-jobs=$LOL_JOBS fc=$FC_ENABLED max-min=$MAX_MIN min-free=${MIN_FREE_GB}GB"

# 같은 상태 파일을 여러 작업자가 고친다 — 갱신은 잠금 아래에서만.
queue_cmd() { flock "$BASE/daily-state.lock" npm run -s ck:queue -- "$@" --state "$STATE"; }

# ── 대상 ────────────────────────────────────────────────────────────
queue_cmd plan --write "$RUN/lol.json" >>"$LOG" 2>&1; QCODE=$?
if [[ "$QCODE" != 0 && "$QCODE" != 2 ]] || [[ ! -s "$RUN/lol.json" ]]; then
  say "!!! 롤 대상 생성 실패(종료 코드 $QCODE) — 이번 회차는 조사하지 않는다. 빈 큐가 아니다"; exit 1
fi
(( QCODE == 2 )) && say "경고: VOD 목록이 일부 잘렸다 — 받은 만큼만 조사한다"
if (( FC_ENABLED )); then
  queue_cmd fc --write "$RUN/fc.json" >>"$LOG" 2>&1 || { say "!!! FC 대상 생성 실패 — FC 는 건너뛴다"; FC_ENABLED=0; }
fi
LOL_N=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).queue.length)' "$RUN/lol.json")
FC_N=0; (( FC_ENABLED )) && FC_N=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).queue.length)' "$RUN/fc.json")
say "대상: 롤 VOD ${LOL_N}개 · FC 스트리머 ${FC_N}명"
if (( DRY )) || (( LOL_N + FC_N == 0 )); then say "Claude 를 부르지 않는다"; exit 0; fi

# 작업자 몫 나누기 — 같은 채널은 한 작업자에게(채널 안은 오래된 것부터 순서대로).
node -e '
  const q = JSON.parse(require("fs").readFileSync(process.argv[1])).queue, n = Number(process.argv[2]);
  const chans = [...new Set(q.map((x) => x.channel_id))], load = Array(n).fill(0), at = new Map();
  for (const c of chans) { const i = load.indexOf(Math.min(...load)); at.set(c, i); load[i] += q.filter((x) => x.channel_id === c).length; }
  const out = Array.from({ length: n }, () => []);
  for (const x of q) out[at.get(x.channel_id)].push([x.title_no, x.channel_id, x.reason, x.streamer].join("\t"));
  out.forEach((lines, i) => require("fs").writeFileSync(`${process.argv[3]}/lol-${i}.tsv`, lines.join("\n") + (lines.length ? "\n" : "")));
' "$RUN/lol.json" "$LOL_JOBS" "$RUN"

# ── 공통 판정 ───────────────────────────────────────────────────────
# 0 계속 · 3 멈춤(디스크·시간·중단 요청·다른 작업자의 Claude 실패)
may_start() {
  [[ -f "$STOP_FILE" ]] && { say "[$1] 중단 요청 — 새 대상을 시작하지 않는다"; return 3; }
  [[ -f "$RUN/abort" ]] && return 3
  (( ($(date +%s) - START) / 60 >= MAX_MIN )) && { say "[$1] 실행 시간 상한 ${MAX_MIN}분 — 남은 대상은 다음 회차"; return 3; }
  if [[ -d /mnt/c ]]; then
    local free; free=$(df -BG /mnt/c | awk 'NR==2{gsub("G","",$4);print $4}')
    (( free <= MIN_FREE_GB )) && { say "[$1] C: 여유 ${free}GB ≤ ${MIN_FREE_GB}GB — 멈춘다"; touch "$RUN/abort"; return 3; }
  fi
  return 0
}
# Claude 종료 코드 정리 — 비용 상한·이미지 차단은 정상 인계다(진척은 settle 이 DB 로 판정한다).
claude_code() {  # $1 원래 코드 · $2 세션 출력 JSON
  local code=$1
  (( code == 20 )) && return 0
  if (( code != 0 )) && node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).subtype==="error_max_budget_usd"?0:1)' "$2" 2>/dev/null; then return 0; fi
  return "$code"
}
CLAUDE_BASE=(--permission-mode bypassPermissions --output-format json --no-session-persistence --model "$MODEL" --max-budget-usd "$MAX_BUDGET")

RULES="- 먼저 ck:record --lead vod:<번호> 와 ck:merge --find-match --vod <번호> 를 본다. 이미 기록된 경기도 처음부터 읽되 결과창은 도구가 준 예측 위치부터 찾고(못 찾으면 넓힌다), 그 match_id 로 이 화면에서 직접 읽은 칸만 match 제출한다(pov.link_basis 필수). 같다·다르다는 저장 도구가 판정한다.
- 카테고리와 상관없이 VOD 전 범위를 본다. 롤 화면을 보면 스킬의 '경기 추적'을 끝까지 한다. FC 온라인 화면을 실제로 열었으면 fco:context clue 만 넘긴다.
- 탐색 단계를 마칠 때마다 scan 을 running 과 지금까지의 범위로 ck:merge 에 저장해 세션이 끊겨도 진척이 남게 한다. 필수 추적을 다 했으면 done(롤이 없었어도 done), 못 끝냈으면 running 과 scan.resume 의 next_action 을 남긴다 — 다음 날 이어서 한다.
- 못 본 지점이 영상 길이 밖이거나 영구 누락이라 다시 봐도 못 푸는 구간이면 scan.resolved_failed 로 닫고 note 에 이유를 남긴다. 안 닫으면 매일 다시 대상에 들어온다.
- 랜드·보너스 판(범인찾기 등)은 ck-research 의 '진행 방식' 규칙대로 낸다.
- 이 세션은 이미지 ${IMAGE_WARN} MiB 에서 저장 안내, ${IMAGE_LIMIT} MiB 초과 열람 차단을 적용한다. 안내를 받으면 읽은 관찰·후보·경기를 ck:merge 에 저장하고 종료한다. 차단 뒤에는 새 탐색을 하지 않는다.
- 모든 조사 산출물 JSON 은 out/ck/<VOD 번호>/ 아래에 쓴다. 저장은 npm run ck:merge -- --result <파일> 하나로 한다. 비용 상한은 done 조건이 아니며, 다음 세션은 DB 저장분만 이어받는다."

# ── 롤 작업자 — 자기 몫 VOD 를 하나씩: 채널 잠금 → 준비 → 세션 → 진척 판정 ─────────────
lol_worker() {  # $1 작업자 번호
  local w=$1 vod ch reason who key code prep line prompt out
  while IFS=$'\t' read -r vod ch reason who; do
    [[ -z "$vod" ]] && continue
    may_start "롤$w" || return 0
    key="vod:$vod"
    exec {lockfd}>"$ROOT/out/ck/backfill/channel-$ch.lock"
    if ! flock -n "$lockfd"; then say "[롤$w] $key ($who) — 백필이 이 채널을 조사 중이라 건너뛴다(다음 날 잇는다)"; exec {lockfd}>&-; continue; fi
    say "[롤$w] $key ($who, $reason) 시작"
    queue_cmd snapshot --key "$key" >>"$LOG" 2>&1
    prep="$RUN/prep-$vod.log"
    nice -n 10 ionice -c3 node scripts/ck-local/scan.mjs --vod "$vod" --reuse >"$prep" 2>&1
    prompt="/ck-local 무인 매일 자동 조사다. 사람이 없으니 묻지 말고 끝까지 간다. VOD 하나만 조사한다: vod:$vod ($who, 대상 사유: $reason).
분석은 ck-local 스킬을 그대로 따른다. 이 VOD 외의 VOD 는 시작하지 않고, SOOP 조사 도구는 병렬 실행하지 않는다.
작업 폴더는 $ROOT 이다. 스킬이 명령으로 안 보이면 $ROOT/.claude/skills/ck-local/SKILL.md 를 Read 로 직접 읽는다.
$RULES"
    if line="$(grep '^PREP: ' "$prep" | tail -1)" && [[ -n "$line" ]]; then
      prompt+=$'\n'"준비 단계 결과(이번 실행): ${line#PREP: } — 이 run_id 의 산출물만 쓴다."
    else
      prompt+=$'\n'"준비 단계 실패(로그 $prep) — 준비 산출물을 쓰지 말고 스킬의 준비 실패 절차로 조사한다."
    fi
    out="$RUN/session-$vod.json"
    setsid node scripts/ck-image-budget.ts run --state "$RUN/image-$vod.json" --output "$out" --vod "$vod" \
      --warn-mib "$IMAGE_WARN" --limit-mib "$IMAGE_LIMIT" --flush-seconds 180 -- claude -p "$prompt" "${CLAUDE_BASE[@]}" >>"$LOG" 2>&1
    claude_code $? "$out"; code=$?
    queue_cmd settle --key "$key" >>"$LOG" 2>&1
    exec {lockfd}>&-
    if (( code != 0 )); then say "[롤$w] $key Claude 실패(코드 $code) — 모든 작업자를 멈춘다"; echo "$code" >"$RUN/abort"; return 0; fi
  done <"$RUN/lol-$w.tsv"
}

# ── FC 작업자 — 스트리머마다 최근 30일 맥락 미조사 API 경기를 판정 ───────────────────
fc_worker() {
  local slug who n key out code from
  from=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).from)' "$RUN/fc.json")
  while IFS=$'\t' read -r slug who n; do
    [[ -z "$slug" ]] && continue
    may_start "FC" || return 0
    key="fc:$slug"
    say "[FC] $who 미조사 ${n}건 시작"
    queue_cmd snapshot --key "$key" >>"$LOG" 2>&1
    out="$RUN/session-fc-$slug.json"
    setsid claude -p "/fco-match-context 무인 매일 자동 조사다. 사람이 없으니 묻지 말고 끝까지 간다.
대상: 스트리머 $slug($who)의 $from 이후 넥슨 API 경기 중 맥락 '미조사' 경기 — npm run fco:context -- list --streamer $slug --from $from --status uninvestigated --vods 로 시작한다.
API 경기의 맥락 판정만 한다. VOD 결과 화면으로 API 에 없는 경기를 새로 기록하는 일(screen, 30일 이전)은 하지 않는다.
경기마다 casual/event 결론 또는 unresolved 사유를 fco:context apply 로 반영하고, 실제로 연 프레임은 근거로 건다. 행사명·주최자를 지어내지 않는다.
세션 비용 상한 안에서 다 못 하면 처리한 만큼 반영하고 끝낸다 — 다음 날 남은 미조사부터 잇는다.
작업 폴더는 $ROOT 이다. 스킬이 명령으로 안 보이면 $ROOT/.claude/skills/fco-match-context/SKILL.md 를 Read 로 직접 읽는다." \
      "${CLAUDE_BASE[@]}" >"$out" 2>>"$LOG"
    claude_code $? "$out"; code=$?
    queue_cmd settle --key "$key" >>"$LOG" 2>&1
    if (( code != 0 )); then say "[FC] Claude 실패(코드 $code) — 모든 작업자를 멈춘다"; echo "$code" >"$RUN/abort"; return 0; fi
  done < <(node -e 'for (const q of JSON.parse(require("fs").readFileSync(process.argv[1])).queue) console.log([q.slug, q.streamer, q.uninvestigated].join("\t"))' "$RUN/fc.json")
}

trap 'say "TERM — 작업자를 회수한다"; touch "$STOP_FILE"; kill -TERM $(jobs -p) 2>/dev/null; wait; exit 130' INT TERM
for ((w = 0; w < LOL_JOBS; w++)); do lol_worker "$w" & sleep 4; done
(( FC_ENABLED && FC_N > 0 )) && fc_worker &
wait

CODE=0
if [[ -f "$RUN/abort" ]]; then c=$(cat "$RUN/abort" 2>/dev/null); [[ "$c" =~ ^[0-9]+$ ]] && CODE=$c || CODE=3; fi
[[ -f "$STOP_FILE" ]] && (( CODE == 0 )) && CODE=3
say "=== 끝 (종료 코드 $CODE, $(( ($(date +%s) - START) / 60 ))분) · 상태 $STATE"
exit "$CODE"
