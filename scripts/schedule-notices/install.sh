#!/usr/bin/env bash
# 편성표 타이머 설치 — 통합 설치기(scripts/systemd/install.sh)의 schedule 묶음을 부른다(2026-10-16 합침).
# 무엇을 설치하나는 등록부 ops/jobs/schedule-*.json 이 정한다. 설정 파일 준비(run.sh init)도 등록부의 install_hook 이다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
case "${1:-status}" in
  enable) exec "$ROOT/scripts/systemd/install.sh" --bundle schedule ;;
  disable) exec "$ROOT/scripts/systemd/install.sh" --disable schedule ;;
  status) systemctl --user list-timers --all 'soop-schedule-*' ;;
  *) echo 'Usage: install.sh enable|disable|status' >&2; exit 1 ;;
esac
