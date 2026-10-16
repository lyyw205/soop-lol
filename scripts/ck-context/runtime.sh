#!/usr/bin/env bash
set -euo pipefail
CK_CONTEXT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
CK_CONTEXT_RUNTIME="$CK_CONTEXT_ROOT/.local/ck-context"
CK_CONTEXT_OLLAMA="${CK_CONTEXT_OLLAMA:-$HOME/.local/ollama/bin/ollama}"
if [[ ! -x "$CK_CONTEXT_OLLAMA" ]]; then
  CK_CONTEXT_OLLAMA="$(command -v ollama || true)"
fi
if [[ -z "$CK_CONTEXT_OLLAMA" || ! -x "$CK_CONTEXT_OLLAMA" ]]; then
  echo 'Ollama 실행 파일이 없습니다. CK_CONTEXT_OLLAMA=/경로/ollama 를 지정하세요.' >&2
  exit 1
fi
mkdir -p "$CK_CONTEXT_RUNTIME"
printf '*\n' > "$CK_CONTEXT_RUNTIME/.gitignore"
export OLLAMA_HOST=127.0.0.1:11439
export OLLAMA_MODELS="$CK_CONTEXT_RUNTIME/models"
export OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NO_CLOUD=true
case "${1:-}" in
  serve) exec "$CK_CONTEXT_OLLAMA" serve ;;
  pull)
    CK_CONTEXT_MODEL="${2:-qwen3.5:4b}"
    if [[ "$CK_CONTEXT_MODEL" == *:cloud* ]]; then echo '로컬 모델만 사용합니다.' >&2; exit 1; fi
    exec "$CK_CONTEXT_OLLAMA" pull "$CK_CONTEXT_MODEL" ;;
  status) exec "$CK_CONTEXT_OLLAMA" ps ;;
  *) echo '사용법: bash scripts/ck-context/runtime.sh serve|pull [모델]|status' >&2; exit 1 ;;
esac
