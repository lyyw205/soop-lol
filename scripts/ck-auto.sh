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
# ★ VOD 하나의 조사는 백필과 같다 — 같은 지시문(재개 요약 resume·완료 조건·접근 불가 기록), 같은 진척 판정·반복 제한
#   (core madeProgress·scripts/lib/ck-backfill-guard), 끝날 때까지 세션을 이어 보기(회차당 VOD 하나에 최대 SESSIONS_PER_VOD),
#   세션별 사용량 기록(usage.jsonl). 다른 것은 대상(이전 조사 다음부터)과 FC 방식(API 맥락 판정)뿐이다.
# ★ 백필과 같은 안전장치를 건다: sonnet · 세션 비용 상한 · 세션 기록 끄기(--no-session-persistence, 세션 기록이
#   하루 21.7GB 쌓여 C: 를 채운 적이 있다) · 이미지 예산(롤) · 진척 없음 3회면 그 대상 건너뜀 · C: 여유 하한 ·
#   실행 시간 상한 · 판별기는 낮은 우선순위(nice/ionice — 게임과 같이 돌 때 부하).
# ★ 동시 실행 — 롤은 채널 단위로 LOL_JOBS 개(채널 안은 순서대로), FC 는 1개. 기본 3+1=4(게임 병행 기준).
#   밀린 분량은 실행 시간 상한 안에서 하루씩 따라잡는다.
# ★ 종료 코드: 0 정상 · 1 대상 생성 실패, 또는 작업자·판정 명령의 예상 밖 실패(로그의 '!!!') · 3 디스크 하한·중단 요청으로 멈춤 ·
#   그 밖은 Claude 실패 코드(로그인 만료·사용량 한도). 실패를 0 으로 덮지 않는다 — systemd 가 이 코드로 실패를 알린다.
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
SESSIONS_PER_VOD="${CK_AUTO_SESSIONS_PER_VOD:-3}"   # VOD 하나를 한 회차에 이어 볼 최대 세션 수(백필처럼 끝날 때까지, 단 상한)
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1

BASE="$ROOT/out/ck/auto"
STATE="$BASE/daily-state.json"
STOP_FILE="$BASE/STOP"
mkdir -p "$BASE" "$ROOT/out/ck/backfill"   # 채널 잠금 파일 자리 — 백필을 한 번도 안 돌린 환경에도 있어야 한다
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
# 작업자 안의 예상 밖 실패 — 그 대상은 건너뛰고 계속하되, 회차의 종료 코드는 1 로 남긴다.
fail() { say "!!! $*"; echo "$*" >>"$RUN/failures"; }
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
  queue_cmd fc --write "$RUN/fc.json" >>"$LOG" 2>&1 || { fail "FC 대상 생성 실패 — 이번 회차 FC 는 건너뛴다"; FC_ENABLED=0; }
fi
LOL_N=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).queue.length)' "$RUN/lol.json")
FC_N=0; (( FC_ENABLED )) && FC_N=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).queue.length)' "$RUN/fc.json")
say "대상: 롤 VOD ${LOL_N}개 · FC 스트리머 ${FC_N}명"
if (( DRY )) || (( LOL_N + FC_N == 0 )); then
  say "Claude 를 부르지 않는다"
  [[ -s "$RUN/failures" ]] && exit 1   # 대상이 없더라도 대상 생성 실패는 실패다
  exit 0
fi

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

# VOD 하나의 지시문 — 백필(scripts/ck-backfill.sh 의 롤 지시문)과 같은 문장이다. 다른 것은 실행기 이름과 접근 불가 기록 명령뿐.
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
방송 주인이 참가하지 않은 재송출 결과창도 직접 읽어 rebroadcast 근거로 쓸 수 있다. 본인 VOD에서만 읽어야 한다는 이유로 보류하지 않는다.
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

# ── 롤 작업자 — 자기 몫 VOD 를 하나씩: 채널 잠금 → (begin → 준비 → 세션 → finish) × 최대 SESSIONS_PER_VOD ──
lol_worker() {  # $1 작업자 번호
  local w=$1 vod ch reason who n bcode fcode code prep line prompt out tag
  while IFS=$'\t' read -r vod ch reason who; do
    [[ -z "$vod" ]] && continue
    may_start "롤$w" || return 0
    exec {lockfd}>"$ROOT/out/ck/backfill/channel-$ch.lock"
    if ! flock -n "$lockfd"; then say "[롤$w] vod:$vod ($who) — 백필이 이 채널을 조사 중이라 건너뛴다(다음 날 잇는다)"; exec {lockfd}>&-; continue; fi
    say "[롤$w] vod:$vod ($who, $reason) 시작"
    for ((n = 1; n <= SESSIONS_PER_VOD; n++)); do
      (( n > 1 )) && { may_start "롤$w" || break; }
      queue_cmd begin --vod "$vod" --dir "$RUN" >>"$LOG" 2>&1; bcode=$?
      (( bcode == 3 )) && { say "[롤$w] vod:$vod 끝"; break; }
      (( bcode == 4 )) && { say "[롤$w] vod:$vod 반복 제한으로 보류"; break; }
      (( bcode == 0 )) || { fail "[롤$w] vod:$vod 시작 판정 실패(코드 $bcode) — 건너뛴다"; break; }
      tag="$vod-$n"
      prep="$RUN/prep-$tag.log"
      nice -n 10 ionice -c3 node scripts/ck-local/scan.mjs --vod "$vod" --reuse >"$prep" 2>&1
      prompt="$(lol_prompt "$vod" "$who, 대상 사유: $reason, 이번 회차 $n번째 세션" "$RUN/resume-$vod.json")"
      if line="$(grep '^PREP: ' "$prep" | tail -1)" && [[ -n "$line" ]]; then
        prompt+=$'\n'"준비 단계 결과(이번 실행): ${line#PREP: } — 이 run_id 의 산출물만 쓴다."
      else
        prompt+=$'\n'"준비 단계 실패(로그 $prep) — 준비 산출물을 쓰지 말고 스킬의 준비 실패 절차로 조사한다."
      fi
      out="$RUN/session-$tag.json"
      setsid node scripts/ck-image-budget.ts run --state "$RUN/image-$tag.json" --output "$out" --vod "$vod" \
        --warn-mib "$IMAGE_WARN" --limit-mib "$IMAGE_LIMIT" --flush-seconds 180 -- claude -p "$prompt" "${CLAUDE_BASE[@]}" </dev/null >>"$LOG" 2>&1
      claude_code $? "$out"; code=$?
      queue_cmd finish --vod "$vod" --dir "$RUN" >>"$LOG" 2>&1; fcode=$?
      node scripts/ck-session-usage.ts "$out" "$RUN/after-$vod.json" "$BASE/usage.jsonl" "$MODEL" >>"$LOG" 2>&1 \
        || say "[롤$w] vod:$vod 사용량을 집계하지 못했다. 원본: $out"
      if (( code != 0 )); then say "[롤$w] vod:$vod Claude 실패(코드 $code) — 모든 작업자를 멈춘다"; echo "$code" >"$RUN/abort"; exec {lockfd}>&-; return 0; fi
      (( fcode == 3 )) && { say "[롤$w] vod:$vod 끝"; break; }
      (( fcode == 4 )) && { say "[롤$w] vod:$vod 진척 없음 — 오늘은 여기까지(다음 회차가 잇는다)"; break; }
      (( fcode == 0 )) || { fail "[롤$w] vod:$vod 진척 확인 실패(코드 $fcode)"; break; }
    done
    exec {lockfd}>&-
  done <"$RUN/lol-$w.tsv"
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
경기마다 casual/event 결론 또는 unresolved 사유를 fco:context apply 로 반영하고, 실제로 연 프레임은 근거로 건다. 행사명·주최자를 지어내지 않는다.
세션 비용 상한 안에서 다 못 하면 처리한 만큼 반영하고 끝낸다 — 다음 날 남은 미조사부터 잇는다.
작업 폴더는 $ROOT 이다. 스킬이 명령으로 안 보이면 $ROOT/.claude/skills/fco-match-context/SKILL.md 를 Read 로 직접 읽는다." \
      "${CLAUDE_BASE[@]}" </dev/null >"$out" 2>>"$LOG"
    claude_code $? "$out"; code=$?
    queue_cmd settle --key "$key" >>"$LOG" 2>&1; local scode=$?
    (( scode == 0 || scode == 4 )) || fail "[FC] $key 진척 확인 실패(코드 $scode)"
    if (( code != 0 )); then say "[FC] Claude 실패(코드 $code) — 모든 작업자를 멈춘다"; echo "$code" >"$RUN/abort"; return 0; fi
  done < <(node -e 'for (const q of JSON.parse(require("fs").readFileSync(process.argv[1])).queue) console.log([q.slug, q.streamer, q.uninvestigated].join("\t"))' "$RUN/fc.json")
}

trap 'say "TERM — 작업자를 회수한다"; touch "$STOP_FILE"; kill -TERM $(jobs -p) 2>/dev/null; wait; exit 130' INT TERM
PIDS=()
for ((w = 0; w < LOL_JOBS; w++)); do lol_worker "$w" & PIDS+=("$!"); sleep 4; done
if (( FC_ENABLED && FC_N > 0 )); then fc_worker & PIDS+=("$!"); fi
# 작업자가 스스로 죽으면(잠금 파일을 못 여는 등) 그 코드를 놓치지 않는다 — wait 하나로 뭉치면 0 이 된다.
for pid in "${PIDS[@]}"; do wait "$pid" || fail "작업자(pid $pid)가 비정상 종료(코드 $?) — 그 몫의 대상은 다음 회차"; done

CODE=0
if [[ -f "$RUN/abort" ]]; then c=$(cat "$RUN/abort" 2>/dev/null); [[ "$c" =~ ^[0-9]+$ ]] && CODE=$c || CODE=3; fi
(( CODE == 0 )) && [[ -s "$RUN/failures" ]] && CODE=1
[[ -f "$STOP_FILE" ]] && (( CODE == 0 )) && CODE=3
say "=== 끝 (종료 코드 $CODE, $(( ($(date +%s) - START) / 60 ))분) · 상태 $STATE"
exit "$CODE"
