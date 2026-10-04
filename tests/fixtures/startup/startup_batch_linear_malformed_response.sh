#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# linear_batch_set_state and linear_enqueue_retry live in wavemill-common.sh
# (HOK-3115). The startup runner has no log_warn, so warnings fall back to
# the startup_log fake below.
# shellcheck source=/dev/null
source "$REPO_DIR/shared/lib/wavemill-common.sh"

LOG_FILE="$(mktemp /tmp/wavemill-startup-linear-malformed.XXXXXX)"
trap 'rm -f "$LOG_FILE"' EXIT

startup_log() {
  printf '%s\n' "$*" >> "$LOG_FILE"
}

npx() {
  if [[ "$*" == *"set-issues-state.ts"* ]]; then
    cat <<'EOF'
{
  "updated": [],
  "failed": [
    {
      "issueId": "HOK-503",
      "error": "Linear API response missing issueUpdate result",
      "category": "graphql",
      "httpStatus": null,
      "isRetryable": false
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

linear_batch_set_state "In Progress" "HOK-503"

if ! grep -q "WARN: Linear state update to 'In Progress' failed for HOK-503: Linear API response missing issueUpdate result \[category=graphql, http=none, retryable=false\]" "$LOG_FILE"; then
  echo "missing structured malformed-response warning" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

if grep -q "WARN: Batch Linear state update to 'In Progress' failed" "$LOG_FILE"; then
  echo "unexpected generic batch warning" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
