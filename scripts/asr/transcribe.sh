#!/usr/bin/env bash
set -euo pipefail
ASR_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ASR_ENGINE="${1:-}"
case "$ASR_ENGINE" in
  sensevoice|qwen) shift ;;
  *) echo 'Usage: bash scripts/asr/transcribe.sh sensevoice|qwen <samples.json>' >&2; exit 2 ;;
esac
ASR_PROJECT_ROOT="$(cd -- "$ASR_SCRIPT_DIR/../.." && pwd)"
exec bash "$ASR_SCRIPT_DIR/env.sh" env HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  "$ASR_PROJECT_ROOT/.local/asr/$ASR_ENGINE/bin/python" \
  "$ASR_SCRIPT_DIR/transcribe.py" "$ASR_ENGINE" "$@"
