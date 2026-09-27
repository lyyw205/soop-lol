#!/usr/bin/env bash
set -euo pipefail
ASR_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${ASR_ENV_READY:-}" != 1 ]]; then
  exec bash "$ASR_SCRIPT_DIR/env.sh" env ASR_ENV_READY=1 bash "$ASR_SCRIPT_DIR/install.sh"
fi
cd "$ASR_SCRIPT_DIR/../.."
for ASR_ENGINE in sensevoice qwen; do
  if [[ ! -x "$ASR_ROOT/$ASR_ENGINE/bin/python" ]]; then
    uv venv --python /usr/bin/python3 "$ASR_ROOT/$ASR_ENGINE"
  fi
  uv pip install --python "$ASR_ROOT/$ASR_ENGINE/bin/python" \
    torch==2.7.1 torchaudio==2.7.1 \
    --index-url https://download.pytorch.org/whl/cu126
done
uv pip install --python "$ASR_ROOT/sensevoice/bin/python" \
  'torch==2.7.1' 'torchaudio==2.7.1' 'funasr==1.4.16' modelscope huggingface_hub soundfile
uv pip install --python "$ASR_ROOT/qwen/bin/python" \
  'torch==2.7.1' 'torchaudio==2.7.1' 'qwen-asr==0.0.6'
for ASR_ENGINE in sensevoice qwen; do
  uv pip check --python "$ASR_ROOT/$ASR_ENGINE/bin/python"
  uv pip freeze --python "$ASR_ROOT/$ASR_ENGINE/bin/python" > "$ASR_ROOT/$ASR_ENGINE.freeze.txt"
done
for ASR_ENGINE in sensevoice qwen; do
  "$ASR_ROOT/$ASR_ENGINE/bin/python" "$ASR_SCRIPT_DIR/prepare.py" "$ASR_ENGINE"
done
for ASR_ENGINE in sensevoice qwen; do
  bash "$ASR_SCRIPT_DIR/check.sh" "$ASR_ENGINE"
done
