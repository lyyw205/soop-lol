#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
cd "$ROOT"
exec node --env-file-if-exists=apps/web/.env.local scripts/schedule-notices/main.mjs "${@:-status}"
