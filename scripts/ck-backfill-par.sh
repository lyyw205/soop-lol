#!/usr/bin/env bash
# 수동 백필을 스트리머 단위로 병렬 실행 — 여러 스트리머의 같은 기간을 --jobs 개씩 동시에 돈다.
#
#   scripts/ck-backfill-par.sh --jobs 3 --from 2026-09-01 --to 2026-09-30 --streamer 이상호 --streamer 김민교 ...
#   scripts/ck-backfill-par.sh --stop      # 각 워커가 현재 세션을 저장한 뒤 멈춘다(새 스트리머도 안 시작)
#
# ★ 한 스트리머 안은 직렬이다. 긴 VOD는 여러 세션으로 잇고, 병렬은 스트리머 사이에서만 생긴다.
#   DB 도장과 저장된 경기로 이어간다. 같은 채널을 가리키는 별칭도 채널 잠금으로 중복 실행을 막는다.
# ★ 잠금(자동 조사와의 상호 배제)은 이 셸이 한 번 잡고, 워커는 CK_BACKFILL_PARENT_LOCK=1 로 다시 잡지 않는다.
# ★ SOOP 속도 제한은 프로세스마다 따로라 워커를 늘리면 합산 속도도 는다(차단되면 그날 치를 잃는다).
#   그래서 SOOP_PACE 를 안 주면 워커 수와 같게 건다 — 합산 호출 속도는 직렬일 때와 같다.
#   SOOP 이 병목이 아니면(판독 세션이 대부분이면) 이대로도 빨라진다. 더 올리려면 SOOP_PACE 를 직접 줄이되 권하지 않는다.
# ★ Claude 실패(사용량 한도·로그인 만료)가 나면 새 스트리머를 더 시작하지 않는다. "진척 없음"(4)은 그 스트리머만 건너뛴다.
#
# 종료 코드: 0 정상/중복 채널 건너뜀 · 4 진척 없이 멈춘 채널 있음 · 75 공통 잠금 충돌 · 130 중단 · 그 외 첫 실패 코드
set -o pipefail  # -u 는 안 쓴다: 빈 연관 배열의 ${#A[@]} 가 unbound 로 죽는다
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/node/bin:$PATH"
cd "$ROOT"
STOP_FILE="$ROOT/out/ck/backfill/STOP"
JOBS=3; STREAMERS=(); PASS=()
while (( $# )); do
  case "$1" in
    --jobs) (( $# >= 2 )) || { echo '--jobs 값 필요' >&2; exit 1; }; JOBS="$2"; shift 2;;
    --streamer) (( $# >= 2 )) || { echo '--streamer 값 필요' >&2; exit 1; }; STREAMERS+=("$2"); shift 2;;
    --from|--to|--vod|--model|--game|--session-games|--max-sessions|--max-budget|--image-limit-mib|--image-warn-mib) (( $# >= 2 )) || { echo "$1 값 필요" >&2; exit 1; }; PASS+=("$1" "$2"); shift 2;;
    --stop) mkdir -p "$(dirname "$STOP_FILE")"; touch "$STOP_FILE"; echo '멈춤 요청을 남겼다. 각 워커가 현재 세션을 저장한 뒤 멈춘다.'; exit 0;;
    --help) sed -n 2,17p "$0"; exit 0;;
    *) echo "알 수 없는 인자: $1" >&2; exit 1;;
  esac
done
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo '--jobs 는 1 이상의 정수' >&2; exit 1; }
(( ${#STREAMERS[@]} )) || { echo '--streamer 가 하나 이상 필요' >&2; exit 1; }
for program in node claude flock setsid; do command -v "$program" >/dev/null || { echo "$program 필요" >&2; exit 1; }; done
mkdir -p out/ck/auto out/ck/backfill
exec 9>out/ck/auto/.lock
flock -n 9 || { echo '다른 CK 조사가 실행 중이다. 이번 백필은 시작하지 않는다.'; exit 75; }
rm -f "$STOP_FILE"
export CK_BACKFILL_PARENT_LOCK=1 CK_BACKFILL_LOCKED=1
export SOOP_PACE="${SOOP_PACE:-$JOBS}"
DIR="$(mktemp -d "$ROOT/out/ck/backfill/par-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
echo "병렬 ${JOBS} · 스트리머 ${#STREAMERS[@]}명 · SOOP_PACE=$SOOP_PACE · 로그: $DIR"

declare -A PIDS NAMES   # pid → 번호·이름
FIRST_FAIL=0; INTERRUPTED=0; IDX=0; STALLED=0; SKIPPED=0
reap() {  # 끝난 워커 하나를 회수한다
  local pid code
  wait -n -p pid "${!PIDS[@]}"; code=$?
  echo "$(date +%T) 끝: ${NAMES[$pid]} rc=$code"
  (( code != 4 )) || STALLED=$((STALLED+1))
  if (( code == 75 )); then
    SKIPPED=$((SKIPPED+1)); echo "이미 조사 중인 채널 건너뜀: ${NAMES[$pid]}"
  fi
  (( code == 0 || code == 4 || code == 75 )) || { (( FIRST_FAIL )) || FIRST_FAIL=$code; }
  unset 'PIDS[$pid]' 'NAMES[$pid]'
}
stop_all() {
  trap '' INT TERM; INTERRUPTED=1
  for pid in "${!PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${!PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  echo '중단됨. 다음 실행이 DB 도장을 다시 읽어 이어간다.'; exit 130
}
trap stop_all INT TERM

for s in "${STREAMERS[@]}"; do
  while (( ${#PIDS[@]} >= JOBS )); do reap; done
  if [[ -f "$STOP_FILE" ]]; then echo '요청으로 멈춤 — 남은 스트리머는 시작하지 않는다.'; break; fi
  if (( FIRST_FAIL )); then echo "실패(rc=$FIRST_FAIL) — 남은 스트리머는 시작하지 않는다."; break; fi
  IDX=$((IDX+1)); LOGF="$DIR/$(printf %02d "$IDX")-${s//[^[:alnum:]가-힣]/_}.out"
  scripts/ck-backfill.sh --streamer "$s" "${PASS[@]}" >"$LOGF" 2>&1 &
  PIDS[$!]=$IDX; NAMES[$!]="$s"
  echo "$(date +%T) 시작: $s (워커 로그 $LOGF)"
  # 워커가 한꺼번에 SOOP 목록(plan)을 부르면 일부가 'fetch failed' 로 죽었다(2026-10-05, 6개 동시 시작에서 3개).
  # 시작을 조금씩 어긋나게 한다. 원인이 이것인지는 확인하지 못했다 — 재발하면 다시 본다.
  sleep "${CK_PAR_STAGGER:-4}"
done
while (( ${#PIDS[@]} )); do reap; done
rm -f "$STOP_FILE"
echo "전체 종료 · 첫 실패 코드 $FIRST_FAIL · 진척 없이 멈춘 채널 $STALLED · 중복 채널 건너뜀 $SKIPPED"
(( FIRST_FAIL != 0 || STALLED == 0 )) || FIRST_FAIL=4
exit "$FIRST_FAIL"
