#!/usr/bin/env bash
# soop-lol 정기 작업 타이머 설치 — 사용자 systemd(WSL).
# 무엇을 설치하나는 등록부(ops/jobs/*.json)의 install 칸이 정한다 — 이 파일에 유닛 이름을 적지 않는다.
# 작업을 빼려면 그 등록부 파일의 remove 절차를 따른다(npm run verify:automation 이 남은 흔적을 잡는다).
#
#   scripts/systemd/install.sh                  # 기본 묶음(default): 랭크·FC 경기·구단가치·티어·시세 · 운영 DB 점검 · 운영 오피스
#   scripts/systemd/install.sh --with-ck-auto   # 기본 + ck-auto 묶음(롤 자동 조사 목록 확인·조사, FC 맥락 자동 조사)
#   scripts/systemd/install.sh --bundle <묶음>  # 그 묶음만 — schedule(편성표) · community(가입을 열 때) · t7-archive(보관 디스크가 있는 PC) · ck-auto · default
#   scripts/systemd/install.sh --job <id>       # 작업 하나만 (예: --job ops-office)
#   scripts/systemd/install.sh --disable <묶음> | --disable-job <id>   # 타이머를 끄고 도는 서비스를 멈춘다(링크는 남긴다)
#   scripts/systemd/install.sh --status         # 설치 대상 작업마다 상태·마지막 실행·다음 실행
#   scripts/systemd/install.sh --list           # 묶음별 작업 목록
#   --dry-run 을 맨 앞에 붙이면 할 일만 출력한다(링크·systemctl 없음).
#   예전 이름: --office-only = --job ops-office · --t7-archive = --bundle t7-archive
#   (2026-10-16 등록부로 바꾸며 community 는 기본 묶음에서 뺐다 — 가입을 열 때 --bundle community. 편성표 설치기도 여기로 합쳤다.)
#
# ★ 설치하면 Persistent=true 라 그동안 놓친 회차가 곧바로 한 번씩 돈다.
# ★ WSL 은 열린 창이 없으면 스스로 꺼진다 — 꺼져 있는 동안은 타이머도 안 돈다. 윈도우 로그인 때 WSL 을 깨우는
#   작업을 작업 스케줄러에 걸어 둘 것(docs/SETUP.md 정기 작업 절).
# ★ 상주 워커(worker -- loop)와 같이 쓰지 않는다 — loop 가 이 작업들을 안에서 또 돈다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$HOME/.config/systemd/user"
export PATH="$HOME/.local/node/bin:$PATH"
DRY=0; [[ "${1:-}" == --dry-run ]] && { DRY=1; shift; }
run() { if (( DRY )); then echo "+ $*"; else "$@"; fi; }
jobs_cli() { node "$ROOT/scripts/ops/jobs.ts" "$@"; }
usage() { sed -n 2,16p "$0" >&2; exit 1; }
need() { [[ -n "${1:-}" ]] || usage; }

MODE="${1:-}"; ARG="${2:-}"
case "$MODE" in
  --status)
    # ★ systemctl show 는 한 번도 안 돈 유닛·설치 안 된 유닛도 Result=success 를 돌려준다 — 그대로 찍으면 미실행이 성공으로 보인다.
    #   등록(타이머·경로 활성화) → 실행 이력(시작 시각) → 지금 상태 → 마지막 결과 순서로 가른다.
    printf '%-22s %-8s %-30s %-30s %s\n' 작업 상태 마지막실행 다음실행 비고
    while IFS=$'\t' read -r id trigger service; do
      enabled=$(systemctl --user is-enabled "$trigger" 2>/dev/null || true)
      if [[ "$enabled" != enabled ]]; then printf '%-22s %-8s\n' "$id" 미등록; continue; fi
      eval "$(systemctl --user show "$service" -p ActiveState -p Result -p ExecMainStatus -p ExecMainStartTimestamp \
        | sed -E 's/^([A-Za-z]+)=(.*)$/\1="\2"/')"
      if [[ "$trigger" == *.timer ]]; then next=$(systemctl --user show "$trigger" -p NextElapseUSecRealtime --value)
      else next="경로 대기($trigger)"; fi
      if [[ "$ActiveState" == activating ]]; then state=실행중
      elif [[ -z "$ExecMainStartTimestamp" ]]; then state=미실행
      elif [[ "$Result" == success ]]; then state=성공
      else state=실패; fi
      note=""; [[ "$state" == 실패 ]] && note="결과 $Result · 종료 코드 $ExecMainStatus (3 = 일부 대상 실패) · journalctl --user -u $service"
      printf '%-22s %-8s %-30s %-30s %s\n' "$id" "$state" "${ExecMainStartTimestamp:--}" "${next:--}" "$note"
    done < <(jobs_cli status-units)
    exit 0;;
  --list) jobs_cli list; exit 0;;
  --disable|--disable-job)
    need "$ARG"
    if [[ "$MODE" == --disable ]]; then PLAN="$(jobs_cli plan --bundle "$ARG")"; else PLAN="$(jobs_cli plan --job "$ARG")"; fi
    # 깨우는 유닛(타이머·경로)을 먼저 끈다 — 서비스부터 멈추면 그 사이 타이머가 다시 깨울 수 있다.
    while IFS=$'\t' read -r kind value; do
      if [[ "$kind" == enable ]]; then run systemctl --user disable --now "$value" || echo "  $value 끄기 실패(설치 안 됨?)"; fi
    done <<<"$PLAN"
    while IFS=$'\t' read -r kind value; do
      if [[ "$kind" == link && "$value" == *.service ]]; then run systemctl --user stop "$(basename "$value")" || echo "  $(basename "$value") 멈추기 실패"; fi
    done <<<"$PLAN"
    exit 0;;
  "") PICK=(--bundle default);;
  --with-ck-auto) PICK=(--bundle default,ck-auto);;
  --bundle) need "$ARG"; PICK=(--bundle "$ARG");;
  --job) need "$ARG"; PICK=(--job "$ARG");;
  --office-only) PICK=(--job ops-office);;
  --t7-archive) PICK=(--bundle t7-archive);;
  *) usage;;
esac

PLAN="$(jobs_cli plan "${PICK[@]}")"
[[ -n "$PLAN" ]] || { echo "설치할 유닛이 없다: ${PICK[*]}" >&2; exit 1; }
run mkdir -p "$DEST"
# 준비 명령(예: 편성표 설정 파일 만들기)은 유닛을 잇기 전에 한 번.
while IFS=$'\t' read -r kind value; do
  [[ "$kind" == hook ]] || continue
  # shellcheck disable=SC2086 — 등록부의 준비 명령은 공백으로 나뉜 단순 명령이다.
  (cd "$ROOT" && run $value)
done <<<"$PLAN"
while IFS=$'\t' read -r kind value; do if [[ "$kind" == link ]]; then run ln -sf "$ROOT/$value" "$DEST/"; fi; done <<<"$PLAN"
run systemctl --user daemon-reload
while IFS=$'\t' read -r kind value; do if [[ "$kind" == enable ]]; then run systemctl --user enable --now "$value"; fi; done <<<"$PLAN"
if (( DRY )); then exit 0; fi
loginctl enable-linger "$USER" 2>/dev/null || echo "linger 설정 실패 — 로그인 세션이 있을 때만 돈다"
systemctl --user list-timers --all 'soop-*' 'ck-auto*' 't7-*' --no-pager
