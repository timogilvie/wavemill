#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# linear_batch_set_state and linear_enqueue_retry live in wavemill-common.sh
# (HOK-3115). The startup runner has no log_warn, so warnings fall back to
# the startup_log fake below.
# shellcheck source=/dev/null
source "$REPO_DIR/shared/lib/wavemill-common.sh"

LOG_FILE="$(mktemp /tmp/wavemill-startup-linear-warn.XXXXXX)"
NPX_LOG="$(mktemp /tmp/wavemill-startup-linear-npx.XXXXXX)"
trap 'rm -f "$LOG_FILE" "$NPX_LOG"' EXIT

startup_log() {
  printf '%s\n' "$*" >> "$LOG_FILE"
}

npx() {
  printf '%s\n' "$*" >> "$NPX_LOG"
  if [[ "$*" == *"set-issues-state.ts"* ]]; then
    cat <<'EOF'
{
  "updated": ["HOK-101"],
  "failed": [
    {
      "issueId": "HOK-102",
      "error": "Linear API request failed with HTTP 429: rate limited",
      "category": "rate_limit",
      "httpStatus": 429,
      "isRetryable": true
    }
  ]
}
EOF
    return 1
  fi
  return 0
}

TOOLS_DIR="$REPO_DIR/tools"
DRY_RUN="false"

STATE_FILE=""

# HOK-3115: task IDs go in as-is; the challenger arm is dropped before the call.
linear_batch_set_state "In Progress" "HOK-101" "HOK-101_c" "HOK-102"

if ! grep -q "set-issues-state.ts --state In Progress HOK-101 HOK-102$" "$NPX_LOG"; then
  echo "batch call must carry only writer Linear IDs" >&2
  cat "$NPX_LOG" >&2
  exit 1
fi

if ! grep -q "WARN: Linear state update to 'In Progress' failed for HOK-102: Linear API request failed with HTTP 429: rate limited \[category=rate_limit, http=429, retryable=true\]" "$LOG_FILE"; then
  echo "missing per-issue startup warning" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

if grep -q "WARN: Batch Linear state update to 'In Progress' failed for 2 issue(s)" "$LOG_FILE"; then
  echo "unexpected generic batch warning" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "linear-retry-drain.ts enqueue --state In Progress --issues HOK-102 --category rate_limit --http 429" "$NPX_LOG"; then
  echo "missing retry queue enqueue call" >&2
  cat "$NPX_LOG" >&2
  exit 1
fi
