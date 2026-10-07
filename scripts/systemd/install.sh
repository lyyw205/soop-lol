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
DATA=(soop-rank soop-fco soop-fco-club soop-fco-prices)

if [[ "${1:-}" == "--status" ]]; then
  systemctl --user list-timers --all 'soop-*' 'ck-auto*' --no-pager
  for u in "${DATA[@]}" ck-auto; do
    systemctl --user show "$u.service" -p Result -p ExecMainStatus -p ExecMainExitTimestamp --value 2>/dev/null | paste -sd' ' | sed "s/^/$u: /"
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
