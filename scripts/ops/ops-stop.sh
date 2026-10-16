# shellcheck shell=bash
# 감싸는 실행기(scripts/ops/run-job.ts)에 멈춘 이유·진척을 알린다 — 실행기 셸이 source 한다.
#   ops_stop <이유> [설명]         — 종료 직전 그 분기에서 부른다(마지막 것이 이긴다). 이유는 job_run.stop_reason(0088) 목록 중 하나:
#                                   completed no_work skipped user_stop time_cap blocked_external no_progress budget lock_busy error killed
#   ops_progress <완료 수> [전체 수] [단위] [마지막 항목]
# ★ 종료 코드는 그대로 둔다 — 같은 코드가 여러 이유를 뜻하므로 이유는 여기서 따로 남긴다(docs/AUTOMATION-REDESIGN-PLAN.md §5.2-3).
# ★ $OPS_RUN_DIR 이 없으면(감싸지 않고 손으로 돌림) 아무것도 하지 않는다. 쓰기에 실패해도 작업을 멈추지 않는다.
_ops_json() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}; s=${s//$'\r'/}; printf '%s' "$s"; }
_ops_write() {  # $1 파일 이름 · $2 내용
  [[ -n "${OPS_RUN_DIR:-}" ]] || return 0
  { mkdir -p "$OPS_RUN_DIR" && printf '%s\n' "$2" >"$OPS_RUN_DIR/.$1.$$" && mv -f "$OPS_RUN_DIR/.$1.$$" "$OPS_RUN_DIR/$1"; } 2>/dev/null || true
}
ops_stop() {
  _ops_write stop.json "{\"reason\":\"$(_ops_json "$1")\",\"detail\":\"$(_ops_json "${2:-}")\",\"at\":\"$(date -Is)\"}"
}
ops_progress() {
  local total=null; [[ -n "${2:-}" ]] && total=$2
  _ops_write progress.json "{\"done\":${1:-0},\"total\":$total,\"unit\":\"$(_ops_json "${3:-}")\",\"last_item\":\"$(_ops_json "${4:-}")\",\"at\":\"$(date -Is)\"}"
}
