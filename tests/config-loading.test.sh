#!/usr/bin/env bash
set -euo pipefail

# Tests for layered config resolution in wavemill-common.sh
# Verifies: defaults < repo config < env vars
#
# Uses a fake HOME to isolate from user-level ~/.wavemill/config.json

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMON="$SCRIPT_DIR/../shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1 (expected '$2', got '$3')"; FAIL=$((FAIL + 1)); }

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name" "$expected" "$actual"
  fi
}

check_matches() {
  local name="$1" pattern="$2" actual="$3"
  if [[ "$actual" =~ $pattern ]]; then
    pass "$name"
  else
    fail "$name" "$pattern" "$actual"
  fi
}

# Create isolated temp directories
TMP=$(mktemp -d)
FAKE_HOME=$(mktemp -d)
trap 'rm -rf "$TMP" "$FAKE_HOME"' EXIT

# All config vars to unset for clean tests
UNSET_VARS="SESSION MAX_PARALLEL POLL_SECONDS BASE_BRANCH AGENT_CMD WORKTREE_ROOT
  REQUIRE_CONFIRM PLANNING_MODE MAX_RETRIES RETRY_DELAY MAX_SELECT MAX_DISPLAY
  PROJECT_NAME LINEAR_PROJECT PLAN_MAX_DISPLAY PLAN_RESEARCH PLAN_MODEL ROUTER_ENABLED
  ROUTER_DEFAULT_MODEL AUTO_EVAL SETUP_CMD _WAVEMILL_CONFIG_LOADED"

# ============================================================================
# Test 1: Default values (no config files at all)
# ============================================================================
echo "=== Default Values ==="

eval "$(
  export HOME="$FAKE_HOME"
  unset $UNSET_VARS 2>/dev/null || true
  source "$COMMON"
  load_config "$TMP"
  echo "D_SESSION='$SESSION'"
  echo "D_MAX_PARALLEL='$MAX_PARALLEL'"
  echo "D_BASE_BRANCH='$BASE_BRANCH'"
  echo "D_AGENT_CMD='$AGENT_CMD'"
  echo "D_REQUIRE_CONFIRM='$REQUIRE_CONFIRM'"
  echo "D_PLANNING_MODE='$PLANNING_MODE'"
  echo "D_MAX_SELECT='$MAX_SELECT'"
  echo "D_MAX_DISPLAY='$MAX_DISPLAY'"
)"

check_matches "default SESSION" '^wavemill-' "$D_SESSION"
check "default MAX_PARALLEL" "3" "$D_MAX_PARALLEL"
check "default BASE_BRANCH" "main" "$D_BASE_BRANCH"
check "default AGENT_CMD" "claude" "$D_AGENT_CMD"
check "default REQUIRE_CONFIRM" "true" "$D_REQUIRE_CONFIRM"
check "default PLANNING_MODE" "skip" "$D_PLANNING_MODE"
check "default MAX_SELECT" "3" "$D_MAX_SELECT"
check "default MAX_DISPLAY" "9" "$D_MAX_DISPLAY"

# ============================================================================
# Test 2: Repo config overrides defaults
# ============================================================================
echo ""
echo "=== Repo Config Overrides ==="

cat > "$TMP/.wavemill-config.json" << 'EOF'
{
  "linear": {
    "project": "Repo Project"
  },
  "mill": {
    "session": "custom-session",
    "maxParallel": 5,
    "baseBranch": "develop",
    "agentCmd": "codex"
  },
  "expand": {
    "maxSelect": 2,
    "maxDisplay": 6
  }
}
EOF

eval "$(
  export HOME="$FAKE_HOME"
  unset $UNSET_VARS 2>/dev/null || true
  source "$COMMON"
  load_config "$TMP"
  echo "R_SESSION='$SESSION'"
  echo "R_MAX_PARALLEL='$MAX_PARALLEL'"
  echo "R_BASE_BRANCH='$BASE_BRANCH'"
  echo "R_AGENT_CMD='$AGENT_CMD'"
  echo "R_MAX_SELECT='$MAX_SELECT'"
  echo "R_MAX_DISPLAY='$MAX_DISPLAY'"
  echo "R_PROJECT_NAME='$PROJECT_NAME'"
)"

check "repo SESSION override" "custom-session" "$R_SESSION"
check "repo MAX_PARALLEL override" "5" "$R_MAX_PARALLEL"
check "repo BASE_BRANCH override" "develop" "$R_BASE_BRANCH"
check "repo AGENT_CMD override" "codex" "$R_AGENT_CMD"
check "repo MAX_SELECT override" "2" "$R_MAX_SELECT"
check "repo MAX_DISPLAY override" "6" "$R_MAX_DISPLAY"
check "repo PROJECT_NAME override" "Repo Project" "$R_PROJECT_NAME"

# ============================================================================
# Test 3: Env vars override repo config
# ============================================================================
echo ""
echo "=== Environment Variable Overrides ==="

eval "$(
  export HOME="$FAKE_HOME"
  export SESSION="env-session"
  export MAX_PARALLEL="7"
  unset _WAVEMILL_CONFIG_LOADED 2>/dev/null || true
  source "$COMMON"
  load_config "$TMP"
  echo "E_SESSION='$SESSION'"
  echo "E_MAX_PARALLEL='$MAX_PARALLEL'"
  echo "E_AGENT_CMD='$AGENT_CMD'"
)"

check "env SESSION override" "env-session" "$E_SESSION"
check "env MAX_PARALLEL override" "7" "$E_MAX_PARALLEL"
# AGENT_CMD should come from repo config since we didn't set it as env var
check "repo AGENT_CMD preserved" "codex" "$E_AGENT_CMD"

# ============================================================================
# Test 4: Repo project beats ambient PROJECT_NAME; LINEAR_PROJECT is explicit
# ============================================================================
echo ""
echo "=== Project Override Precedence ==="

eval "$(
  export HOME="$FAKE_HOME"
  export PROJECT_NAME="Leaked Project"
  unset LINEAR_PROJECT _WAVEMILL_CONFIG_LOADED 2>/dev/null || true
  source "$COMMON"
  load_config "$TMP"
  echo "P_LEGACY_PROJECT_NAME='$PROJECT_NAME'"
)"

check "repo project beats ambient PROJECT_NAME" "Repo Project" "$P_LEGACY_PROJECT_NAME"

eval "$(
  export HOME="$FAKE_HOME"
  export PROJECT_NAME="Leaked Project"
  export LINEAR_PROJECT="Explicit Project"
  unset _WAVEMILL_CONFIG_LOADED 2>/dev/null || true
  source "$COMMON"
  load_config "$TMP"
  echo "P_LINEAR_PROJECT_NAME='$PROJECT_NAME'"
)"

check "LINEAR_PROJECT explicitly overrides repo project" "Explicit Project" "$P_LINEAR_PROJECT_NAME"

# ============================================================================
# Test 5: Missing config files don't cause errors
# ============================================================================
echo ""
echo "=== Missing Config Files ==="

EMPTY_TMP=$(mktemp -d)
eval "$(
  export HOME="$FAKE_HOME"
  unset $UNSET_VARS 2>/dev/null || true
  source "$COMMON"
  load_config "$EMPTY_TMP" 2>/dev/null
  echo "M_SESSION='$SESSION'"
  echo "M_MAX_PARALLEL='$MAX_PARALLEL'"
)"
rm -rf "$EMPTY_TMP"

check_matches "defaults with no config files" '^wavemill-' "$M_SESSION"
check "defaults with no config files (parallel)" "3" "$M_MAX_PARALLEL"

# ============================================================================
# Results
# ============================================================================
echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
