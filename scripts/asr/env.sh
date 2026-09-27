#!/usr/bin/env bash
# Run installation and inference through this wrapper to keep ASR data local.
set -euo pipefail
ASR_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)/.local/asr"
export ASR_ROOT
export XDG_CACHE_HOME="$ASR_ROOT/cache"
export UV_CACHE_DIR="$ASR_ROOT/cache/uv"
export UV_PYTHON_INSTALL_DIR="$ASR_ROOT/python"
export UV_PYTHON_DOWNLOADS=never
export UV_HTTP_TIMEOUT=300
export PIP_CACHE_DIR="$ASR_ROOT/cache/pip"
export HF_HOME="$ASR_ROOT/models/huggingface"
export HF_HUB_CACHE="$HF_HOME/hub"
export HF_ASSETS_CACHE="$HF_HOME/assets"
export HF_XET_CACHE="$HF_HOME/xet"
export HF_MODULES_CACHE="$ASR_ROOT/cache/hf-modules"
export MODELSCOPE_CACHE="$ASR_ROOT/models/modelscope"
export TORCH_HOME="$ASR_ROOT/cache/torch"
export TORCH_EXTENSIONS_DIR="$ASR_ROOT/cache/torch-extensions"
export TORCHINDUCTOR_CACHE_DIR="$ASR_ROOT/cache/torchinductor"
export TRITON_CACHE_DIR="$ASR_ROOT/cache/triton"
export CUDA_CACHE_PATH="$ASR_ROOT/cache/cuda"
export NUMBA_CACHE_DIR="$ASR_ROOT/cache/numba"
export MPLCONFIGDIR="$ASR_ROOT/cache/matplotlib"
export TMPDIR="$ASR_ROOT/tmp"
export TEMP="$TMPDIR"
export TMP="$TMPDIR"
export GRADIO_TEMP_DIR="$TMPDIR/gradio"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONNOUSERSITE=1
export HF_HUB_DISABLE_TELEMETRY=1
export HF_HUB_DOWNLOAD_TIMEOUT=300
export GRADIO_ANALYTICS_ENABLED=False
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$HF_HOME" "$MODELSCOPE_CACHE"
if [[ $# -eq 0 ]]; then
  echo 'Usage: bash scripts/asr/env.sh <command> [args...]' >&2
  exit 2
fi
exec "$@"
