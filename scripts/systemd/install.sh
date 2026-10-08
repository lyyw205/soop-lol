#!/usr/bin/env bash
# soop-lol 정기 작업 타이머 설치 — 사용자 systemd(WSL).
#
#   scripts/systemd/install.sh                 # 데이터 수집 4종(랭크·FC 경기·구단가치·시세)
#   scripts/systemd/install.sh --with-ck-auto  # + 매일 와치리스트 조사(Claude 사용 — 비용·디스크·GPU 부하가 크다)
#   scripts/systemd/install.sh --status        # 다음 실행 시각과 마지막 결과
#
# ★ 설치하면 Persistent=true 라 그동안 놓친 회차가 곧바로 한 번씩 돈다.
# ★ WSL 은 열린 창이 없으면 스스로 꺼진다 — 꺼져 있는 동안은 타이머도 안 돈다. 윈도우 로그인 때 WSL 을 깨우는
#   작업을 작업 스케줄러에 걸어 둘 것(docs/SETUP.md 정기 작업 절).
# ★ 상주 워커(worker -- loop)와 같이 쓰지 않는다 — loop 가 이 작업들을 안에서 또 돌린다.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.config/systemd/user"
DATA=(soop-rank soop-fco soop-fco-club soop-fco-rating soop-fco-prices)

if [[ "${1:-}" == "--status" ]]; then
  # ★ systemctl show 는 한 번도 안 돈 유닛·설치 안 된 유닛도 Result=success 를 돌려준다 — 그대로 찍으면 미실행이 성공으로 보인다.
  #   등록(타이머 활성화) → 실행 이력(시작 시각) → 지금 상태 → 마지막 결과 순서로 가른다.
  printf '%-16s %-8s %-20s %-20s %s\n' 작업 상태 마지막실행 다음실행 비고
  for u in "${DATA[@]}" ck-auto; do
    enabled=$(systemctl --user is-enabled "$u.timer" 2>/dev/null || true)
    if [[ "$enabled" != enabled ]]; then printf '%-16s %-8s\n' "$u" 미등록; continue; fi
    eval "$(systemctl --user show "$u.service" -p ActiveState -p Result -p ExecMainStatus -p ExecMainStartTimestamp \
      | sed -E 's/^([A-Za-z]+)=(.*)$/\1="\2"/')"
    next=$(systemctl --user show "$u.timer" -p NextElapseUSecRealtime --value)
    if [[ "$ActiveState" == activating ]]; then state=실행중
    elif [[ -z "$ExecMainStartTimestamp" ]]; then state=미실행
    elif [[ "$Result" == success ]]; then state=성공
    else state=실패; fi
    note=""; [[ "$state" == 실패 ]] && note="결과 $Result · 종료 코드 $ExecMainStatus (3 = 일부 대상 실패) · journalctl --user -u $u.service"
    printf '%-16s %-8s %-20s %-20s %s\n' "$u" "$state" "${ExecMainStartTimestamp:--}" "${next:--}" "$note"
  done
  exit 0
fi

UNITS=("${DATA[@]}"); [[ "${1:-}" == "--with-ck-auto" ]] && UNITS+=(ck-auto)
mkdir -p "$DEST"
for u in "${UNITS[@]}"; do ln -sf "$DIR/$u.service" "$DIR/$u.timer" "$DEST/"; done
systemctl --user daemon-reload
for u in "${UNITS[@]}"; do systemctl --user enable --now "$u.timer"; done
loginctl enable-linger "$USER" 2>/dev/null || echo "linger 설정 실패 — 로그인 세션이 있을 때만 돈다"
systemctl --user list-timers --all 'soop-*' 'ck-auto*' --no-pager
