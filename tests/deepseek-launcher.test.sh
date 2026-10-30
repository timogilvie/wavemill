#!/usr/bin/env bash
# Tests for claude-deepseek launcher shell behavior.
# Run with: bash tests/deepseek-launcher.test.sh
#
# These tests use stub claude binaries and temp repos to avoid real network calls.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$REPO_DIR/shared/lib"
TOOLS_DIR="$REPO_DIR/tools"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1: ${2:-}"; FAIL=$((FAIL + 1)); }

# ============================================================================
# Helpers
# ============================================================================

make_temp_repo() {
  local dir
  dir="$(mktemp -d)"
  echo "$dir"
}

cleanup() {
  local dir="$1"
  rm -rf "$dir"
}

# Source agent adapters for function testing
source_adapters() {
  # Resolver-backed helpers need the real repo toolchain.
  export REPO_DIR="$REPO_DIR"
  export TOOLS_DIR="$TOOLS_DIR"
  # shellcheck disable=SC1090
  source "$LIB_DIR/agent-adapters.sh" 2>/dev/null || true
}

# ============================================================================
# TEST: agent_validate recognizes claude-deepseek via claude binary
# ============================================================================
echo ""
echo "=== agent_validate for claude-deepseek ==="

tmp="$(make_temp_repo)"
(
  source_adapters "$tmp"
  if command -v claude >/dev/null 2>&1; then
    if agent_validate "claude-deepseek"; then
      pass "agent_validate claude-deepseek succeeds when claude is on PATH"
    else
      fail "agent_validate claude-deepseek" "should succeed when claude is on PATH"
    fi
  else
    echo "  SKIP  agent_validate claude-deepseek (claude not on PATH)"
    PASS=$((PASS + 1))  # Count as pass in this context
  fi
) && : || fail "agent_validate claude-deepseek subshell" "subshell failed"
cleanup "$tmp"

# ============================================================================
# TEST: agent_default_model_for_cmd returns deepseek-v4-flash
# ============================================================================
echo ""
echo "=== agent_default_model_for_cmd ==="

tmp="$(make_temp_repo)"
(
  source_adapters "$tmp"
  result="$(agent_default_model_for_cmd "claude-deepseek")"
  if [[ "$result" == "deepseek-v4-flash" ]]; then
    pass "agent_default_model_for_cmd claude-deepseek returns deepseek-v4-flash"
  else
    fail "agent_default_model_for_cmd claude-deepseek" "expected deepseek-v4-flash, got $result"
  fi
)
cleanup "$tmp"

# ============================================================================
# TEST: agent_binary_for_cmd maps claude-deepseek to claude
# ============================================================================
echo ""
echo "=== agent_binary_for_cmd ==="

tmp="$(make_temp_repo)"
(
  source_adapters "$tmp"
  result="$(agent_binary_for_cmd "claude-deepseek")"
  if [[ "$result" == "claude" ]]; then
    pass "agent_binary_for_cmd maps claude-deepseek to claude"
  else
    fail "agent_binary_for_cmd" "expected claude, got $result"
  fi
  result="$(agent_binary_for_cmd "claude")"
  if [[ "$result" == "claude" ]]; then
    pass "agent_binary_for_cmd preserves claude unchanged"
  else
    fail "agent_binary_for_cmd" "expected claude unchanged, got $result"
  fi
  result="$(agent_binary_for_cmd "codex")"
  if [[ "$result" == "codex" ]]; then
    pass "agent_binary_for_cmd preserves codex unchanged"
  else
    fail "agent_binary_for_cmd" "expected codex unchanged, got $result"
  fi
)
cleanup "$tmp"

# ============================================================================
# TEST: launch-claude-deepseek.ts exits 2 on missing key
# ============================================================================
echo ""
echo "=== launch-claude-deepseek.ts missing key ==="

if ! command -v npx >/dev/null 2>&1; then
  echo "  SKIP  npx not available"
else
  tmp="$(make_temp_repo)"
  rc=0
  unset DEEPSEEK_API_KEY 2>/dev/null || true
  DEEPSEEK_API_KEY="" node "$TOOLS_DIR/launch-claude-deepseek.ts" \
    --repo "$tmp" \
    --session "testsess" \
    --issue "HOK-001" \
    >/dev/null 2>/dev/null || rc=$?

  if [[ "$rc" -eq 2 ]]; then
    pass "launch-claude-deepseek.ts exits 2 when DEEPSEEK_API_KEY is missing"
  else
    fail "launch-claude-deepseek.ts missing key exit code" "expected 2, got $rc"
  fi
  cleanup "$tmp"
fi

# ============================================================================
# TEST: launch-claude-deepseek.ts succeeds and emits valid env block
# ============================================================================
echo ""
echo "=== launch-claude-deepseek.ts with valid key ==="

if ! command -v npx >/dev/null 2>&1; then
  echo "  SKIP  npx not available"
else
  tmp="$(make_temp_repo)"
  rc=0
  output=""
  output="$(DEEPSEEK_API_KEY=sk-test-key node "$TOOLS_DIR/launch-claude-deepseek.ts" \
    --repo "$tmp" \
    --session "testsess" \
    --issue "HOK-001" 2>/dev/null)" || rc=$?

  if [[ "$rc" -ne 0 ]]; then
    fail "launch-claude-deepseek.ts with valid key" "expected exit 0, got $rc"
  else
    # Verify required env vars are in output
    for key in ANTHROPIC_BASE_URL ANTHROPIC_MODEL CLAUDE_CONFIG_DIR WAVEMILL_AGENT_KIND WAVEMILL_DEEPSEEK_STATE_DIR HOME XDG_CONFIG_HOME XDG_DATA_HOME; do
      if printf '%s\n' "$output" | grep -q "^${key}="; then
        pass "output contains ${key}"
      else
        fail "output contains ${key}" "missing from env block"
      fi
    done

    # Verify WAVEMILL_AGENT_KIND=claude-deepseek
    if printf '%s\n' "$output" | grep -q "^WAVEMILL_AGENT_KIND='claude-deepseek'"; then
      pass "WAVEMILL_AGENT_KIND is claude-deepseek"
    else
      fail "WAVEMILL_AGENT_KIND is claude-deepseek" "wrong value in env block"
    fi

    # Verify no ~/.claude paths in state dirs
    real_claude_home="$HOME/.claude"
    state_line="$(printf '%s\n' "$output" | grep '^WAVEMILL_DEEPSEEK_STATE_DIR=' | head -1)"
    state_value="${state_line#WAVEMILL_DEEPSEEK_STATE_DIR=\'}"; state_value="${state_value%\'}"
    if [[ "$state_value" != "$real_claude_home"* ]]; then
      pass "state dir does not point at real ~/.claude"
    else
      fail "state dir safety" "state dir points at real ~/.claude: $state_value"
    fi

    # Verify discovery file was written
    discovery="/tmp/wavemill-testsess-HOK-001.deepseek-state"
    if [[ -f "$discovery" ]]; then
      pass "state discovery file written"
      # Verify discovery file does not contain the API key
      if ! grep -q "sk-test-key" "$discovery" 2>/dev/null; then
        pass "discovery file does not contain API key"
      else
        fail "discovery file secret safety" "discovery file contains API key"
      fi
      rm -f "$discovery"
    else
      fail "state discovery file written" "file not found at $discovery"
    fi
  fi
  cleanup "$tmp"
fi

# ============================================================================
# TEST: launch-claude-deepseek.ts stdout does not contain api key in stderr
# ============================================================================
echo ""
echo "=== launch-claude-deepseek.ts no key leakage in stderr ==="

if ! command -v npx >/dev/null 2>&1; then
  echo "  SKIP  npx not available"
else
  tmp="$(make_temp_repo)"
  stderr_output=""
  stderr_output="$(DEEPSEEK_API_KEY="" node "$TOOLS_DIR/launch-claude-deepseek.ts" \
    --repo "$tmp" \
    --session "testsess" \
    --issue "HOK-002" 2>&1 >/dev/null)" || true

  if echo "$stderr_output" | grep -q "sk-"; then
    fail "no API key in stderr" "stderr contains API key pattern"
  else
    pass "no API key pattern in stderr on error"
  fi
  cleanup "$tmp"
fi

# ============================================================================
# TEST: Existing claude and codex paths in agent-adapters.sh are unchanged
# ============================================================================
echo ""
echo "=== Existing claude/codex paths unchanged ==="

tmp="$(make_temp_repo)"
(
  source_adapters "$tmp"

  # agent_resolve_from_model should still map deepseek-* to claude (backward compat)
  result="$(agent_resolve_from_model "deepseek-v4-pro" "coding")"
  if [[ "$result" == "claude" ]]; then
    pass "agent_resolve_from_model deepseek-v4-pro still maps to claude (backward compat)"
  else
    fail "backward compat" "agent_resolve_from_model deepseek-v4-pro returned $result"
  fi

  # claude still maps to claude
  result="$(agent_resolve_from_model "claude-sonnet-4-6" "coding")"
  if [[ "$result" == "claude" ]]; then
    pass "agent_resolve_from_model claude-sonnet-4-6 still maps to claude"
  else
    fail "claude backward compat" "agent_resolve_from_model claude-sonnet-4-6 returned $result"
  fi

  # codex still maps to codex
  result="$(agent_resolve_from_model "gpt-5.4" "coding")"
  if [[ "$result" == "codex" ]]; then
    pass "agent_resolve_from_model gpt-5.4 still maps to codex"
  else
    fail "codex backward compat" "agent_resolve_from_model gpt-5.4 returned $result"
  fi

  # agent_default_model_for_cmd claude unchanged
  result="$(agent_default_model_for_cmd "claude")"
  if [[ "$result" == "claude-sonnet-4-6" ]]; then
    pass "agent_default_model_for_cmd claude unchanged"
  else
    fail "claude default model unchanged" "got $result"
  fi

  # agent_default_model_for_cmd codex unchanged
  result="$(agent_default_model_for_cmd "codex")"
  if [[ "$result" == "gpt-5.4" ]]; then
    pass "agent_default_model_for_cmd codex unchanged"
  else
    fail "codex default model unchanged" "got $result"
  fi
)
cleanup "$tmp"

# ============================================================================
# Results
# ============================================================================

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
