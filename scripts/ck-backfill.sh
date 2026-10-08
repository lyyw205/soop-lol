#!/usr/bin/env bash
# 수동 백필 — 사용자 요청으로만 실행. 요청 기간의 VOD 를 최신순으로 하나씩, 남은 게 없을 때까지 조사한다.
#
#   scripts/ck-backfill.sh --streamer 이상호 --from 2026-08-20 --to 2026-09-25   # 기간 지정(저장된다)
#   scripts/ck-backfill.sh --streamer 이상호                                    # 마지막 요청 기간을 이어서
#   scripts/ck-backfill.sh --streamer 김민교 --model haiku --from ...           # 조사 세션만 다른 모델로
#   scripts/ck-backfill.sh --streamer 걍하리 --game fconline --from ... --to ...   # FC 과거 백필(도장 fco_scan · FC 스킬)
#   scripts/ck-backfill.sh --streamer 임아니 --image-limit-mib 12 --max-sessions 1 # 이미지 제한 시험(기본 꺼짐)
#   scripts/ck-backfill.sh --stop                                               # 지금 조사 세션을 저장한 뒤 멈춤
#   Ctrl-C / TERM                                                               # 즉시 멈춤(조사 중 VOD 는 마지막 저장 지점부터)
#
# ★ --model 은 claude -p 조사 세션에만 건다. 전역 기본 모델(/model, ~/.claude/settings.json)은
#   안 건드린다 — 다른 백필·자동 조사가 이 실행이 끝난 뒤에도 계속 원래 기본값을 쓰게 한다.
# ★ 세션 하나는 VOD 하나만 다룬다. 긴 VOD는 저장 경계에서 나눠 잇는다. 세션이 끝날 때마다 DB 도장을 다시 읽어 실제 진척을 확인한다.
#   진척이 없거나 Claude 가 실패하면 멈춘다 — 사용량 한도·로그인 만료에 목록을 헛돌지 않는다.
# ★ 자동 조사와 같은 flock 을 잡는다. 둘을 동시에 띄운 사고로 SOOP 호출 속도가 두 배가 되는 걸 막는다.
#
# 종료 코드: 0 끝까지·요청으로 멈춤 · 75 다른 조사 실행 중 · 130 중단 · 4 진척 없음 · 그 외 실패
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/node/bin:$PATH"
cd "$ROOT"
STOP_FILE="$ROOT/out/ck/backfill/STOP"
STREAMER=""; FROM=""; TO=""; ONLY_VOD=""; MODEL="${CK_BACKFILL_MODEL:-sonnet}"; GAME="lol"
SESSION_GAMES="${CK_BACKFILL_SESSION_GAMES:-0}"
MAX_SESSIONS=0; RESET_STALL=0
# ★ 세션당 비용 상한(달러, claude -p --max-budget-usd). 0 이면 끈다. 문맥이 수십만 토큰까지 자라는 세션이
#   사용량 대부분을 먹었다(2026-10-05 집계: 상위 3세션이 47%). 프롬프트의 분량 목표는 강제가 아니라서 여기서 끊는다.
#   상한에 걸린 세션은 실패가 아니다 — DB 저장분까지 진척으로 보고 다음 세션이 재개 요약으로 잇는다.
MAX_BUDGET="${CK_BACKFILL_MAX_BUDGET:-3}"
IMAGE_LIMIT="${CK_BACKFILL_IMAGE_LIMIT_MIB:-0}"
IMAGE_WARN="${CK_BACKFILL_IMAGE_WARN_MIB:-8}"
IMAGE_FLUSH_SECONDS="${CK_BACKFILL_IMAGE_FLUSH_SECONDS:-180}"
# 조사 세션이 따를 스킬. 기본은 ck-local(로컬 판별기 준비 + 원본 판독) — 2026-10-01 비교 시험(VOD 8개)에서
#   ck-research 가 찾은 경기를 하나도 놓치지 않고 같은 값을 읽으면서 비용 64%·시간 44% 를 줄였다(docs/CK-LOCAL-DETECTOR.md).
#   예전 방식으로 돌리려면 CK_BACKFILL_SKILL=ck-research (그러면 준비 단계도 기본으로 꺼진다).
SKILL_ENV="${CK_BACKFILL_SKILL:-}"
# VOD 마다 Claude 세션 **전에** 돌릴 준비 명령({vod} 자리에 번호). ck-local 이면 기본으로 판별기 준비를 돌린다.
#   CK_BACKFILL_PREP 를 **빈 값으로** 주면 준비를 끈다(그때 ck-local 스킬은 준비 실패 절차 = ck-research 로 간다).
# ★ 같은 잠금·같은 중단 처리(프로세스 그룹) 안에서 직렬로 돈다 — SOOP 호출이 Claude 조사와 겹치지 않는다.
# ★ 준비 명령이 성공하며 찍은 마지막 `PREP:` 줄만 프롬프트에 넘긴다. 실패하면 실패했다고만 넘긴다 — 옛 산출물을 새 결과로 오인하지 않게.

while (( $# )); do
  case "$1" in
    --streamer|--from|--to|--vod|--model|--game|--session-games|--max-sessions|--max-budget|--image-limit-mib|--image-warn-mib)
      if (( $# < 2 )); then echo "$1 값 필요" >&2; exit 1; fi
      case "$1" in --streamer) STREAMER="$2";; --from) FROM="$2";; --to) TO="$2";; --vod) ONLY_VOD="$2";; --model) MODEL="$2";; --game) GAME="$2";; --session-games) SESSION_GAMES="$2";; --max-sessions) MAX_SESSIONS="$2";; --max-budget) MAX_BUDGET="$2";; --image-limit-mib) IMAGE_LIMIT="$2";; --image-warn-mib) IMAGE_WARN="$2";; esac
      shift 2;;
    --stop)
      mkdir -p "$(dirname "$STOP_FILE")"; touch "$STOP_FILE"
      echo '멈춤 요청을 남겼다. 지금 조사 세션을 마친 뒤 멈춘다.'; exit 0;;
    --reset-stall) RESET_STALL=1; shift;;
    --help) sed -n 2,16p "$0"; exit 0;;
    *) echo "알 수 없는 인자: $1" >&2; exit 1;;
  esac
done
[[ -n "$STREAMER" ]] || { echo '--streamer 필요' >&2; exit 1; }
[[ "$GAME" == lol || "$GAME" == fconline ]] || { echo "--game 은 lol 또는 fconline" >&2; exit 1; }
[[ -n "$MODEL" && "$SESSION_GAMES" =~ ^[0-9]+$ ]] || { echo '모델 이름과 --session-games 0 이상 정수가 필요하다' >&2; exit 1; }
[[ "$MAX_SESSIONS" =~ ^[0-9]+$ ]] || { echo '--max-sessions 0 이상 정수가 필요하다(0: 제한 없음)' >&2; exit 1; }
[[ "$MAX_BUDGET" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo '--max-budget 은 0 이상 숫자(달러, 0: 제한 없음)' >&2; exit 1; }
[[ "$IMAGE_LIMIT" =~ ^[0-9]+(\.[0-9]+)?$ && "$IMAGE_WARN" =~ ^[0-9]+(\.[0-9]+)?$ && "$IMAGE_FLUSH_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  || { echo '이미지 한도·경고는 0 이상 숫자, 저장 종료 유예는 양의 정수' >&2; exit 1; }
IMAGE_ENABLED=0
if [[ ! "$IMAGE_LIMIT" =~ ^0*(\.0*)?$ ]]; then
  [[ "$GAME" == lol ]] || { echo '이미지 제한 1차 검증은 LoL 백필만 지원한다' >&2; exit 1; }
  node -e 'const [w,l]=process.argv.slice(1).map(Number);process.exit(w>0&&w<l&&l<=12?0:1)' "$IMAGE_WARN" "$IMAGE_LIMIT" \
    || { echo '이미지 한도는 0 < 경고 < 차단 <= 12 MiB' >&2; exit 1; }
  IMAGE_ENABLED=1
fi
# 게임별 기본값. 롤: ck-local + 판별기 준비. FC: FC 스킬(VOD 에서 출발하기) + 공용 준비 → FC 전용 판별기(fc.json).
if [[ "$GAME" == fconline ]]; then SKILL="${SKILL_ENV:-fco-match-context}"; else SKILL="${SKILL_ENV:-ck-local}"; fi
if [[ -n "${CK_BACKFILL_PREP+set}" ]]; then PREP_CMD="$CK_BACKFILL_PREP"
elif [[ "$GAME" == fconline ]]; then PREP_CMD='node scripts/ck-local/scan.mjs --vod {vod} && (cd scripts/fco-local && ../../out/ck-detector/venv/bin/python fc_detect.py --vod {vod})'
elif [[ "$SKILL" == "ck-local" ]]; then PREP_CMD='node scripts/ck-local/scan.mjs --vod {vod} --reuse'
else PREP_CMD=""; fi
# ★ 세션이 끝나고 진척이 확인되면 그 VOD 의 결과 화면 앞뒤 **원본**을 뽑아 둔다(FC: fco:frames · 롤: ck:neighbors).
#   검수 화면은 결과 화면 앞뒤를 원본으로 넘겨 보는데, 조사 세션은 결과 화면만 원본으로 뽑는다. 검수할 때 기다리지 않게 여기서 받는다.
#   실패해도 백필은 멈추지 않는다(검수 재료일 뿐 조사 결과가 아니다). CK_BACKFILL_FRAMES 를 빈 값으로 주면 끈다.
if [[ -n "${CK_BACKFILL_FRAMES+set}" ]]; then FRAMES_CMD="$CK_BACKFILL_FRAMES"
elif [[ "$GAME" == fconline ]]; then FRAMES_CMD='node --env-file-if-exists=apps/web/.env.local scripts/fco-context-frames.ts --vod {vod}'
# 롤: 경기에 연결된 결과창마다 앞뒤 3장(3초 간격) 원본을 사람 검수용으로 올린다(ck-neighbors.ts, 토큰 0 · 2026-10-09).
else FRAMES_CMD='node --env-file-if-exists=apps/web/.env.local scripts/ck-neighbors.ts --vod {vod}'; fi
for program in node claude flock setsid; do command -v "$program" >/dev/null || { echo "$program 필요" >&2; exit 1; }; done
mkdir -p out/ck/auto out/ck/backfill
# ★ CK_BACKFILL_PARENT_LOCK=1 — scripts/ck-backfill-par.sh 가 이미 잠금을 쥐고 스트리머별로 이 셸을 병렬로 띄운 경우.
#   잠금(자동 조사와의 상호 배제)은 부모가 갖고 있으니 여기서 다시 잡지 않고, 멈춤 요청도 부모가 지운다
#   (한 워커가 지우면 나머지 워커가 멈춤을 못 본다).
if [[ "${CK_BACKFILL_PARENT_LOCK:-}" != 1 ]]; then
  exec 9>out/ck/auto/.lock
  flock -n 9 || { echo '다른 CK 조사가 실행 중이다. 이번 백필은 시작하지 않는다.'; exit 75; }
  # 지난 실행이 소비하지 못한 멈춤 요청이 새 실행을 곧바로 멈추지 않게 한다.
  rm -f "$STOP_FILE"
fi
export CK_BACKFILL_LOCKED=1
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
  run_child node --env-file-if-exists=apps/web/.env.local scripts/ck-backfill.ts "$@" --game "$GAME"; local code=$?
  tail -n +"$((n+1))" "$LOG"; return "$code"
}
say() { echo "$*" | tee -a "$LOG"; }

# 별칭이 달라도 같은 채널을 동시에 조사하지 않는다. 부모 공통 잠금과 역할이 다르다.
cli target --streamer "$STREAMER" --write "$DIR/target.json" || exit "$?"
CHANNEL="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1])); if(!/^[a-zA-Z0-9_-]+$/.test(c.channel_id))process.exit(1);console.log(c.channel_id)' "$DIR/target.json")" || exit 1
exec 8>"out/ck/backfill/channel-$CHANNEL.lock"
flock -n 8 || { say "이미 조사 중인 채널: $CHANNEL"; exit 75; }
say "설정: game=$GAME model=$MODEL session-games=$SESSION_GAMES max-sessions=$MAX_SESSIONS max-budget=$MAX_BUDGET image-limit-mib=$IMAGE_LIMIT"
GUARD_ARGS=(--guard-dir "$ROOT/out/ck/backfill/guards")

PLAN_ARGS=(plan --streamer "$STREAMER" --write "$QUEUE")
[[ -n "$FROM" ]] && PLAN_ARGS+=(--from "$FROM")
[[ -n "$TO" ]] && PLAN_ARGS+=(--to "$TO")
[[ -n "$ONLY_VOD" ]] && PLAN_ARGS+=(--vod "$ONLY_VOD")
cli "${PLAN_ARGS[@]}"; CODE=$?
(( CODE == 0 )) || exit "$CODE"

SESSIONS=0; RESULT=""
while true; do
  if [[ -f "$STOP_FILE" ]]; then [[ "${CK_BACKFILL_PARENT_LOCK:-}" == 1 ]] || rm -f "$STOP_FILE"; RESULT='요청으로 멈춤'; CODE=0; break; fi
  NEXT_ARGS=(next --queue "$QUEUE" --current "$CURRENT" "${GUARD_ARGS[@]}")
  (( RESET_STALL == 0 )) || NEXT_ARGS+=(--reset-stall)
  cli "${NEXT_ARGS[@]}"; CODE=$?
  RESET_STALL=0  # 명시적 재개도 첫 대상 한 번만 허용한다. 반복 제한을 매 세션 지우지 않는다.
  if (( CODE == 3 )); then RESULT='요청 기간을 끝까지 처리'; CODE=0; break; fi
  if (( CODE == 4 )); then RESULT='결과 진척 없는 반복으로 재개 보류'; break; fi
  (( CODE == 0 )) || { RESULT='다음 VOD 선택 실패'; break; }
  VOD="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(String(c.vod.title_no))' "$CURRENT")" || { CODE=1; RESULT='current.json 읽기 실패'; break; }
  SESSIONS=$((SESSIONS+1))
  if [[ "$GAME" == fconline ]]; then
  PROMPT="/$SKILL FC 과거 백필의 VOD 하나를 조사한다: $CURRENT 의 vod (번호 $VOD). 스킬의 'VOD 에서 출발하기' 흐름을 그대로 따른다.
ck-backfill 스킬이나 셸을 재귀 실행하지 않고, 이 VOD 외의 VOD 는 시작하지 않는다. SOOP 조사 도구는 병렬 실행하지 않는다.
- VOD 안의 FC 경기를 전부 찾는다. 결과 화면 원본을 열어 읽은 경기만 fco:context screen 으로 저장한다(--dry-run 으로 형식을 먼저 확인).
- 탐색 단계를 마칠 때마다 npm run fco:context -- scan --vod $VOD --status running --requested <본 범위> --opened <연 초> 로 진척을 남긴다.
- VOD 전 범위를 다 봤을 때만 --status done --requested 0-<영상 길이>. FC 화면이 하나도 없으면 무엇을 보고 그렇게 판단했는지 --note 에 적고 done.
- 재생 파일이 없거나(구독자 전용 등) 삭제·비공개를 실제 확인했으면 npm run ck:backfill -- access --vod $VOD --status unavailable --reason <확인 근거>.
  일시 오류는 --status temporary 로 남기고 이 세션을 끝낸다.
종료 뒤 셸이 DB 도장(fco_scan)으로 진척을 확인한다. 찾은 경기 수·저장 결과(created/linked/needs_review)·못 찾은 구간을 요약한다."
  else
    PROMPT="/$SKILL 수동 백필의 VOD 하나를 조사한다: $CURRENT 의 vod (번호 $VOD).
분석은 $SKILL 스킬을 그대로 따른다. ck-backfill 스킬이나 셸을 재귀 실행하지 않고, 이 VOD 외의 VOD 는 시작하지 않는다.
SOOP 조사 도구는 병렬 실행하지 않는다. 먼저 $DIR/resume.json 의 DB 재개 요약과 ck:merge --find-match --vod $VOD 를 본다.
요약에서 부족한 후보 근거·질문만 ck:record --lead 로 조회한다. 동일 VOD에서 저장 확인된 경기를 처음부터 재판독하지 않는다.
다른 VOD의 시점을 추가할 때는 기존 값을 복사하지 않고 직접 읽는다.
중단된 조사면 남은 지점부터 잇는다. 탐색 단계를 마칠 때마다 scan 을 running 과 지금까지의 범위로 ck:merge 에 저장해
세션이 중간에 끊겨도 진척이 남게 한다. 필수 조사를 모두 마쳤을 때만 done 으로 저장한다.
done은 탐색 완료이지 모든 값 확정이 아니다. 필수 탐색·결과창 보완·교차검증 처리를 끝냈다면 미해결 후보와 질문을 보존하고 done으로 저장한다.
완료 전 후보별 확인 구간·탐색 종료 사유·교차검증 시도와 한계를 확인한다. 남은 필수 탐색이 있으면 running과 구체적인 다음 행동을 남긴다.
미해결을 억지로 not_target으로 닫거나 삭제하지 않는다. 이전 인계의 사용자 판단 필요라는 말만으로 종료하지 말고 resume.json의 completion_policy로 재평가한다.
방송 주인이 참가하지 않은 재송출 결과창도 직접 읽어 rebroadcast 근거로 쓸 수 있다. 본인 VOD에서만 읽어야 한다는 이유로 보류하지 않는다.
삭제·비공개를 실제 확인했으면 npm run ck:backfill -- access --vod $VOD --status unavailable --reason <확인 근거> 로 남긴다.
일시 오류는 --status temporary 로 남기고 이 세션을 끝낸다. scan.failed 는 시간 범위 배열이며 사유를 넣지 않는다.
못 본 구간이 영상 길이 밖이거나 세그먼트가 영구 누락이라 다시 봐도 못 푸는 것이면 scan.resolved_failed 로 닫고 이유를 note 에 남긴다.
안 닫으면 다음 실행이 같은 VOD 에서 진척 없음으로 멈춘다.
종료 뒤 셸이 DB 도장으로 진척을 확인한다. 완료·연결·접근 불가·남은 범위를 요약한다."
    if (( SESSION_GAMES > 0 )); then
      PROMPT+=$'\n'"이번 세션 목표는 새 경기/시점 $SESSION_GAMES 개까지다. 각 경기마다 ck:merge 저장 응답을 확인한다.
목표에 닿으면 현재 경기의 저장을 마친 안전한 경계에서 running으로 종료한다(필수 조사를 실제 모두 끝냈으면 done).
경기를 못 찾은 탐색도 확인 범위와 다음 행동을 남겨 running으로 인계할 수 있다.
원본 열람만 늘고 저장·후보 결론·남은 범위 감소가 없는 세션은 연속 3회 뒤 실행기가 멈춘다. 제한을 피하려고 완료나 결론을 만들지 않는다.
scan.resume에 next_action(다음 행동), next_at(알면 VOD 초), context(확인된 참가자·순서 등 짧은 사실)를 남긴다.
ck:local --finish는 --resume <요약 JSON 파일>을 받는다. 다음 작업에 필요한 미해결 후보는 안정적인 id로 저장한다.
지금 확인한 범위만 기록하고, 준비된 이미지가 있다는 이유로 전체를 본 것으로 쓰지 않는다. 묶음 크기는 완료 조건이 아니다."
    fi
  fi
  if [[ -n "$PREP_CMD" ]]; then
    PREP_OUT="$DIR/prep-$VOD.log"
    say "준비: ${PREP_CMD//\{vod\}/$VOD}"
    run_child bash -c "${PREP_CMD//\{vod\}/$VOD} >'$PREP_OUT' 2>&1"; PREP_CODE=$?
    if (( PREP_CODE == 0 )) && PREP_LINE="$(grep '^PREP: ' "$PREP_OUT" | tail -1)" && [[ -n "$PREP_LINE" ]]; then
      PROMPT+=$'\n'"준비 단계 결과(이번 실행): ${PREP_LINE#PREP: } — 이 run_id 의 산출물만 쓴다."
    else
      PROMPT+=$'\n'"준비 단계 실패(종료 코드 $PREP_CODE, 로그 $PREP_OUT) — 준비 산출물을 쓰지 말고 스킬의 준비 실패 절차로 조사한다."
    fi
  fi
  if (( IMAGE_ENABLED )); then
    PROMPT+=$'\n'"작업 폴더는 $ROOT 이다. 스킬이 명령으로 안 보이면 $ROOT/.claude/skills/$SKILL/SKILL.md 를 Read로 직접 읽는다. 다른 프로젝트 폴더로 이동하지 않는다.
이 세션은 이미지 ${IMAGE_WARN} MiB에서 저장 안내, ${IMAGE_LIMIT} MiB 초과 열람 차단을 적용한다.
안내를 받으면 읽은 관찰·후보·경기를 ck:merge에 저장하고 종료한다. 필수 탐색이 남으면 running과 scan.resume의 next_action·context를 남긴다. 이미 필수 탐색을 모두 마쳤으면 위 done 조건을 따른다.
모든 조사 산출물 JSON은 out/ck/$VOD/ 아래에 Write/Edit로 작성한다. 원본 사진을 자르거나 화질을 낮추지 않는다.
차단 뒤에는 새 탐색을 하지 않는다. 저장은 단일 npm run ck:merge -- --result <파일>, 필요한 기록 조회는 npm run ck:record -- --lead vod:$VOD 명령으로 한다.
ck:local --finish를 쓰면 --status running --resume <인계 JSON>을 명시한다(요청 범위는 준비 단계가 영상 전체로 정해 두었으니 적지 않는다).
개요만 본 상태는 원본 opened를 꾸미지 말고 기존 scan 입력으로 ck:merge에 저장한다. 경기값을 모르면 후보의 관찰·질문으로 남긴다.
이미지를 준비한 사실은 열람 근거가 아니다. 예산 소진은 done 조건이 아니며, 다음 세션은 DB 저장분만 이어받는다."
  fi
  # ★ --no-session-persistence — 세션 대화 기록(~/.claude/projects/*.jsonl)을 남기지 않는다. 이미지가 base64 로
  #   통째로 들어가 백필 세션 기록만 하루에 21.7GB 가 쌓여 C: 를 채웠다(2026-10-05). 재개는 DB 로 하고,
  #   사용량은 실행 폴더의 session-*.json·usage.jsonl 에 따로 남으므로 이 기록은 쓰지 않는다.
  CLAUDE_ARGS=(-p "$PROMPT" --permission-mode bypassPermissions --output-format json --no-session-persistence)
  CLAUDE_ARGS+=(--model "$MODEL")
  [[ "$MAX_BUDGET" =~ ^0*(\.0*)?$ ]] || CLAUDE_ARGS+=(--max-budget-usd "$MAX_BUDGET")
  SESSION_OUT="$DIR/session-$SESSIONS.json"
  if (( IMAGE_ENABLED )); then
    run_child node scripts/ck-image-budget.ts run --state "$DIR/image-$SESSIONS.json" --output "$SESSION_OUT" --vod "$VOD" \
      --warn-mib "$IMAGE_WARN" --limit-mib "$IMAGE_LIMIT" --flush-seconds "$IMAGE_FLUSH_SECONDS" -- claude "${CLAUDE_ARGS[@]}"; CLAUDE_CODE=$?
    if (( CLAUDE_CODE == 20 )); then
      say '  이미지 차단 후 저장·종료 유예가 끝났다 — DB 저장분을 확인한다'; CLAUDE_CODE=0
    fi
  else
    run_child bash -c 'output=$1; shift; exec "$@" >"$output"' _ "$SESSION_OUT" claude "${CLAUDE_ARGS[@]}"; CLAUDE_CODE=$?
  fi
  # 비용 상한으로 끊긴 세션은 정상 인계다. 진척은 아래 after 가 DB 로 판정한다(저장 없이 끊겼으면 진척 없음으로 멈춘다).
  if (( CLAUDE_CODE != 0 )) && node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).subtype==="error_max_budget_usd"?0:1)' "$SESSION_OUT" 2>/dev/null; then
    say "  세션 비용 상한(\$$MAX_BUDGET)에서 끊었다 — 저장된 진척부터 다음 세션이 잇는다"; CLAUDE_CODE=0
  fi
  rm -f "$DIR/after.json"  # 이번 조회가 실패하면 지난 세션의 저장 수를 사용량에 붙이지 않는다.
  cli after --current "$CURRENT" "${GUARD_ARGS[@]}"; AFTER_CODE=$?
  run_child node scripts/ck-session-usage.ts "$SESSION_OUT" "$DIR/after.json" "$DIR/usage.jsonl" "$MODEL" \
    || say "사용량은 집계하지 못했다. 원본: $SESSION_OUT"
  if (( CLAUDE_CODE != 0 )); then RESULT="Claude 실행 실패(종료 코드 $CLAUDE_CODE)"; CODE=$CLAUDE_CODE; break; fi
  if (( AFTER_CODE == 4 )); then RESULT='진척 없음 또는 결과 없는 반복 제한'; CODE=4; break; fi
  (( AFTER_CODE == 0 )) || { RESULT='진척 확인 실패'; CODE=$AFTER_CODE; break; }
  if [[ -n "$FRAMES_CMD" ]]; then
    say "앞뒤 원본: ${FRAMES_CMD//\{vod\}/$VOD}"
    run_child bash -c "${FRAMES_CMD//\{vod\}/$VOD}" \
      || say "  ⚠ 앞뒤 원본을 다 못 뽑았다 — 백필은 계속한다. 나중에: ${FRAMES_CMD//\{vod\}/$VOD}"
  fi
  if (( MAX_SESSIONS > 0 && SESSIONS >= MAX_SESSIONS )); then RESULT='지정한 세션 수까지 처리(기간 완료와 별개)'; CODE=0; break; fi
done
say "종료: $RESULT · 조사 세션 ${SESSIONS}회"
cli status --streamer "$STREAMER"
echo "전체 로그: $LOG"
exit "$CODE"
