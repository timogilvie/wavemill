#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"
STATUS_LIB="$REPO_DIR/shared/lib/wavemill-status.sh"

extract_function() {
  local file="$1"
  local name="$2"
  awk -v name="$name" '
    $0 ~ ("^" name "\\(\\)") { capture=1 }
    capture { print }
    capture && /^}/ { exit }
  ' "$file"
}

STARTUP_FUNCS="$(
  extract_function "$RUNNER" write_openrouter_warning_cache
  echo
  extract_function "$RUNNER" startup_openrouter_credit_warning
  echo
  extract_function "$RUNNER" startup_warn_openrouter_status
)"

STATUS_FUNCS="$(
  extract_function "$STATUS_LIB" cached_openrouter_warning
  echo
  extract_function "$STATUS_LIB" render_dashboard
)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SESSION="openrouter-test"
REPO_DIR_TEST="$TMP_DIR/repo"
TOOLS_DIR="$REPO_DIR/tools"
mkdir -p "$REPO_DIR_TEST"
mkdir -p "$REPO_DIR_TEST/.wavemill"
REPO_DIR="$REPO_DIR_TEST"
STATUS_LOG_FILE="$TMP_DIR/status.log"
OPENROUTER_WARNING_CACHE="/tmp/${SESSION}-openrouter-warning.txt"
rm -f "$OPENROUTER_WARNING_CACHE"

startup_log() {
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

npx() {
  if [[ "$*" == *"openrouter-doctor.ts"* ]]; then
    cat <<'EOF'
{"zeroTrafficAlert":{"headline":"OpenRouter is configured, but the last 20 recent selections used no OpenRouter/native model."},"zeroTrafficAlertText":"OpenRouter is configured, but the last 20 recent selections used no OpenRouter/native model.\n  Eligible configured models: 1.\n  Next challenge candidate: glm-5.2 (least-used-zero-record)."}
EOF
    return 1
  fi
  return 0
}

eval "$STARTUP_FUNCS"
startup_warn_openrouter_status

if ! grep -q 'WARN: OpenRouter is configured, but the last 20 recent selections used no OpenRouter/native model.' "$STATUS_LOG_FILE"; then
  echo "startup warning headline was not logged" >&2
  cat "$STATUS_LOG_FILE" >&2
  exit 1
fi

if ! grep -q 'Eligible configured models: 1.' "$STATUS_LOG_FILE"; then
  echo "startup warning detail was not logged" >&2
  cat "$STATUS_LOG_FILE" >&2
  exit 1
fi

if [[ ! -f "$OPENROUTER_WARNING_CACHE" ]]; then
  echo "startup warning cache was not written" >&2
  exit 1
fi

cat > "$REPO_DIR_TEST/.wavemill/quota-state.json" <<'EOF'
{"version":2,"updatedAt":"2026-08-19T12:00:00.000Z","models":{},"providers":{"openrouter":{"totalCredits":110,"totalUsage":110.16,"balanceUsd":-0.16,"usageDaily":10.05,"updatedAt":"2026-08-19T12:00:00.000Z","lastFetchError":null}}}
EOF
: > "$STATUS_LOG_FILE"
startup_warn_openrouter_status
if [[ "$(cat "$OPENROUTER_WARNING_CACHE")" != *"credits exhausted"* ]]; then
  echo "credit exhaustion warning did not take precedence" >&2
  cat "$OPENROUTER_WARNING_CACHE" >&2
  exit 1
fi

STATE_FILE="$TMP_DIR/state.json"
cat > "$STATE_FILE" <<EOF
{"freeSlots":1,"tasks":{}}
EOF

FRAME="$TMP_DIR/frame.txt"
REFRESH=5
EL=""
B=""
N=""
D=""
G=""
_LAST_TIP_REFRESH_AT=0
TIP_REFRESH=60
_CURRENT_TIP="tip"
gather_tasks() { :; }
render_inbox_section() { :; }
render_active_section() { :; }
render_backstage_retained_section() { :; }
render_project_context_suggestion() { :; }
wavemill_pick_usage_tip() { printf 'tip\n'; }

eval "$STATUS_FUNCS"
render_dashboard

if ! grep -q 'WARN: OpenRouter credits exhausted - challenge coverage disabled' "$FRAME"; then
  echo "dashboard did not render cached OpenRouter warning" >&2
  cat "$FRAME" >&2
  exit 1
fi

rm -f "$OPENROUTER_WARNING_CACHE"
