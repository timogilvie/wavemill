#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_LIB="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

assert_last_log() {
  local name="$1" expected_level="$2" expected_fragment="$3"

  if [[ "${LOG_LEVELS[-1]:-}" == "$expected_level" ]] \
    && [[ "${LOG_MESSAGES[-1]:-}" == *"$expected_fragment"* ]]; then
    pass "$name"
  else
    fail "$name"
  fi
}

assert_no_log_since_last() {
  local name="$1" previous_count="$2"

  if (( ${#LOG_MESSAGES[@]} == previous_count )); then
    pass "$name"
  else
    fail "$name"
  fi
}

echo "=== Hook Status Verbosity ==="

if [[ ! -f "$COMMON_LIB" ]]; then
  fail "wavemill-common.sh not found"
else
  # shellcheck source=/dev/null
  source "$COMMON_LIB"

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"; rm -f "/tmp/wavemill-${SESSION:-}-hook-warnings.txt"' EXIT

  declare -a LOG_LEVELS=()
  declare -a LOG_MESSAGES=()

  log() {
    local level message
    if (( $# == 1 )); then
      level="info"
      message="$1"
    else
      level="$1"
      message="$2"
    fi
    LOG_LEVELS+=("$level")
    LOG_MESSAGES+=("$message")
  }

  mkdir -p "$TMP_DIR/worktree/.claude"
  echo '{}' > "$TMP_DIR/worktree/.claude/settings.local.json"
  export TOOLS_DIR="$REPO_DIR/tools"
  export SESSION="hook-status-test-$$"
  rm -f "/tmp/wavemill-${SESSION}-hook-warnings.txt"

  configure_agent_hooks "claude" "$TMP_DIR/worktree"
  assert_last_log "claude hook setup logs at debug" "debug" "Configured Claude hook status in"

  configure_agent_hooks "codex" "$TMP_DIR/worktree"
  assert_last_log "codex hook setup logs at debug" "debug" "Codex status tracking via launcher exit hook"

  configure_agent_hooks "cursor" "$TMP_DIR/worktree"
  assert_last_log "generic hook setup logs at debug" "debug" "Generic agent status tracking via process monitor"

  export TOOLS_DIR="$TMP_DIR/missing-tools"
  warning_count=${#LOG_MESSAGES[@]}
  configure_agent_hooks "claude" "$TMP_DIR/worktree"
  assert_last_log "missing install hook warns once" "warn" "Hook status unavailable"

  configure_agent_hooks "claude" "$TMP_DIR/worktree"
  assert_no_log_since_last "missing install hook is silent after first warning" $((warning_count + 1))
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
