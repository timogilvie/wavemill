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
  ROUTER_DEFAULT_MODEL AUTO_EVAL SETUP_CMD DASHBOARD_VERBOSITY DASHBOARD_LOG_TO_FILE
  GIT_FETCH_TTL_SECONDS ENTER_LAUNCHES_WAVE ENTER_ACTION
  _WAVEMILL_CONFIG_LOADED"

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
  echo "D_GIT_FETCH_TTL_SECONDS='$GIT_FETCH_TTL_SECONDS'"
  echo "D_BASE_BRANCH='$BASE_BRANCH'"
  echo "D_AGENT_CMD='$AGENT_CMD'"
  echo "D_REQUIRE_CONFIRM='$REQUIRE_CONFIRM'"
  echo "D_PLANNING_MODE='$PLANNING_MODE'"
  echo "D_MAX_SELECT='$MAX_SELECT'"
  echo "D_MAX_DISPLAY='$MAX_DISPLAY'"
  echo "D_DASHBOARD_VERBOSITY='$DASHBOARD_VERBOSITY'"
  echo "D_DASHBOARD_LOG_TO_FILE='$DASHBOARD_LOG_TO_FILE'"
  echo "D_ENTER_LAUNCHES_WAVE='$ENTER_LAUNCHES_WAVE'"
  echo "D_ENTER_ACTION='$ENTER_ACTION'"
)"

check_matches "default SESSION" '^wavemill-' "$D_SESSION"
check "default MAX_PARALLEL" "7" "$D_MAX_PARALLEL"
check "default GIT_FETCH_TTL_SECONDS" "60" "$D_GIT_FETCH_TTL_SECONDS"
check "default BASE_BRANCH" "main" "$D_BASE_BRANCH"
check "default AGENT_CMD" "claude" "$D_AGENT_CMD"
check "default REQUIRE_CONFIRM" "true" "$D_REQUIRE_CONFIRM"
check "default PLANNING_MODE" "interactive" "$D_PLANNING_MODE"
check "default MAX_SELECT" "3" "$D_MAX_SELECT"
check "default MAX_DISPLAY" "9" "$D_MAX_DISPLAY"
check "default DASHBOARD_VERBOSITY" "info" "$D_DASHBOARD_VERBOSITY"
check "default DASHBOARD_LOG_TO_FILE" "true" "$D_DASHBOARD_LOG_TO_FILE"
check "default ENTER_LAUNCHES_WAVE" "false" "$D_ENTER_LAUNCHES_WAVE"
check "default ENTER_ACTION is none (Enter never launches)" "none" "$D_ENTER_ACTION"

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
  "git": {
    "fetchTtlSeconds": 15
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
  },
  "dashboard": {
    "verbosity": "status",
    "logToFile": false
  },
  "taskSelection": {
    "enterLaunchesWave": false
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
  echo "R_GIT_FETCH_TTL_SECONDS='$GIT_FETCH_TTL_SECONDS'"
  echo "R_BASE_BRANCH='$BASE_BRANCH'"
  echo "R_AGENT_CMD='$AGENT_CMD'"
  echo "R_MAX_SELECT='$MAX_SELECT'"
  echo "R_MAX_DISPLAY='$MAX_DISPLAY'"
  echo "R_PROJECT_NAME='$PROJECT_NAME'"
  echo "R_DASHBOARD_VERBOSITY='$DASHBOARD_VERBOSITY'"
  echo "R_DASHBOARD_LOG_TO_FILE='$DASHBOARD_LOG_TO_FILE'"
  echo "R_ENTER_LAUNCHES_WAVE='$ENTER_LAUNCHES_WAVE'"
  echo "R_ENTER_ACTION='$ENTER_ACTION'"
)"

check "repo SESSION override" "custom-session" "$R_SESSION"
check "repo MAX_PARALLEL override" "5" "$R_MAX_PARALLEL"
check "repo GIT_FETCH_TTL_SECONDS override" "15" "$R_GIT_FETCH_TTL_SECONDS"
check "repo BASE_BRANCH override" "develop" "$R_BASE_BRANCH"
check "repo AGENT_CMD override" "codex" "$R_AGENT_CMD"
check "repo MAX_SELECT override" "2" "$R_MAX_SELECT"
check "repo MAX_DISPLAY override" "6" "$R_MAX_DISPLAY"
check "repo PROJECT_NAME override" "Repo Project" "$R_PROJECT_NAME"
check "repo DASHBOARD_VERBOSITY override" "status" "$R_DASHBOARD_VERBOSITY"
check "repo DASHBOARD_LOG_TO_FILE override" "false" "$R_DASHBOARD_LOG_TO_FILE"
check "repo ENTER_LAUNCHES_WAVE override" "false" "$R_ENTER_LAUNCHES_WAVE"
check "legacy enterLaunchesWave=false maps to top-scored" "top-scored" "$R_ENTER_ACTION"

# taskSelection.enterAction: explicit values, precedence over the legacy key,
# and fallback to none for an unknown value.
for case_spec in 'wave|{"enterAction":"wave"}|wave|true' \
                 'precedence|{"enterAction":"none","enterLaunchesWave":true}|none|false' \
                 'legacy-true|{"enterLaunchesWave":true}|wave|true' \
                 'invalid|{"enterAction":"bogus"}|none|false'; do
  IFS='|' read -r case_name case_ts want_action want_wave <<<"$case_spec"
  case_dir="$TMP/enter-action-$case_name"
  mkdir -p "$case_dir"
  printf '{"taskSelection": %s}\n' "$case_ts" > "$case_dir/.wavemill-config.json"
  eval "$(
    export HOME="$FAKE_HOME"
    unset $UNSET_VARS 2>/dev/null || true
    source "$COMMON"
    load_config "$case_dir"
    echo "E_ENTER_ACTION='$ENTER_ACTION'"
    echo "E_ENTER_LAUNCHES_WAVE='$ENTER_LAUNCHES_WAVE'"
  )"
  check "enterAction $case_name -> ENTER_ACTION" "$want_action" "$E_ENTER_ACTION"
  check "enterAction $case_name -> ENTER_LAUNCHES_WAVE" "$want_wave" "$E_ENTER_LAUNCHES_WAVE"
done

write_repo_override_config() {
  cat > "$TMP/.wavemill-config.json" << 'EOF'
{
  "linear": {
    "project": "Repo Project"
  },
  "git": {
    "fetchTtlSeconds": 15
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
  },
  "dashboard": {
    "verbosity": "status",
    "logToFile": false
  },
  "taskSelection": {
    "enterLaunchesWave": false
  }
}
EOF
}

# ============================================================================
# Test 2b: Legacy skip planning mode is coerced to interactive
# ============================================================================
echo ""
echo "=== Legacy Planning Mode Migration ==="

cat > "$TMP/.wavemill-config.json" << 'EOF'
{
  "mill": {
    "planningMode": "skip"
  }
}
EOF

eval "$(
  export HOME="$FAKE_HOME"
  unset $UNSET_VARS 2>/dev/null || true
  source "$COMMON"
  load_config "$TMP"
  echo "LEGACY_PLANNING_MODE='$PLANNING_MODE'"
)"

check "legacy skip planning mode coerced" "interactive" "$LEGACY_PLANNING_MODE"

write_repo_override_config

# ============================================================================
# Test 3: Env vars override repo config
# ============================================================================
echo ""
echo "=== Environment Variable Overrides ==="

eval "$(
  export HOME="$FAKE_HOME"
  export SESSION="env-session"
  export MAX_PARALLEL="7"
  export GIT_FETCH_TTL_SECONDS="0"
  unset _WAVEMILL_CONFIG_LOADED 2>/dev/null || true
  source "$COMMON"
  load_config "$TMP"
  echo "E_SESSION='$SESSION'"
  echo "E_MAX_PARALLEL='$MAX_PARALLEL'"
  echo "E_GIT_FETCH_TTL_SECONDS='$GIT_FETCH_TTL_SECONDS'"
  echo "E_AGENT_CMD='$AGENT_CMD'"
)"

check "env SESSION override" "env-session" "$E_SESSION"
check "env MAX_PARALLEL override" "7" "$E_MAX_PARALLEL"
check "env GIT_FETCH_TTL_SECONDS override" "0" "$E_GIT_FETCH_TTL_SECONDS"
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
check "defaults with no config files (parallel)" "7" "$M_MAX_PARALLEL"

# ============================================================================
# Test 6: wavemill_load_config merges .local.json onto base
# ============================================================================
echo ""
echo "=== Local Overlay (wavemill_load_config) ==="

OVERLAY_TMP=$(mktemp -d)
cat > "$OVERLAY_TMP/.wavemill-config.json" <<'EOF'
{ "integration": { "enabled": false, "useMillSession": true }, "mill": { "maxParallel": 7 } }
EOF
cat > "$OVERLAY_TMP/.wavemill-config.local.json" <<'EOF'
{ "integration": { "enabled": true } }
EOF

eval "$(
  source "$COMMON"
  merged=$(wavemill_load_config "$OVERLAY_TMP")
  echo "OV_ENABLED='$(echo "$merged" | jq -r '.integration.enabled')'"
  echo "OV_USE_MILL_SESSION='$(echo "$merged" | jq -r '.integration.useMillSession')'"
  echo "OV_MAX_PARALLEL='$(echo "$merged" | jq -r '.mill.maxParallel')'"
)"

check "overlay overrides scalar from base" "true" "$OV_ENABLED"
check "overlay preserves siblings via deep merge" "true" "$OV_USE_MILL_SESSION"
check "overlay preserves unrelated branches" "7" "$OV_MAX_PARALLEL"

# Local-only (no base) should still work.
LOCAL_ONLY_TMP=$(mktemp -d)
cat > "$LOCAL_ONLY_TMP/.wavemill-config.local.json" <<'EOF'
{ "integration": { "enabled": true } }
EOF

eval "$(
  source "$COMMON"
  merged=$(wavemill_load_config "$LOCAL_ONLY_TMP")
  echo "LO_ENABLED='$(echo "$merged" | jq -r '.integration.enabled')'"
)"

check "local-only file acts as the whole config" "true" "$LO_ENABLED"

rm -rf "$OVERLAY_TMP" "$LOCAL_ONLY_TMP"

# ============================================================================
# Test 7: load_config applies .wavemill-config.local.json overlay
# (sets BASE_BRANCH, CHALLENGE_AUTO_MERGE, etc. from the merged result)
# ============================================================================
echo ""
echo "=== load_config Overlay Precedence ==="

LCFG_TMP=$(mktemp -d)
cat > "$LCFG_TMP/.wavemill-config.json" <<'EOF'
{
  "linear": { "project": "base-project" },
  "mill": { "baseBranch": "main", "maxParallel": 7 },
  "challenge": { "autoMergeWinner": false }
}
EOF
cat > "$LCFG_TMP/.wavemill-config.local.json" <<'EOF'
{
  "mill": { "baseBranch": "auto/integration" },
  "challenge": { "autoMergeWinner": true }
}
EOF

eval "$(
  export HOME="$FAKE_HOME"
  unset $UNSET_VARS 2>/dev/null || true
  source "$COMMON"
  load_config "$LCFG_TMP"
  echo "LC_BASE_BRANCH='$BASE_BRANCH'"
  echo "LC_AUTO_MERGE='$CHALLENGE_AUTO_MERGE'"
  echo "LC_MAX_PARALLEL='$MAX_PARALLEL'"
  echo "LC_PROJECT='$PROJECT_NAME'"
)"

check "overlay overrides BASE_BRANCH" "auto/integration" "$LC_BASE_BRANCH"
check "overlay overrides CHALLENGE_AUTO_MERGE" "true" "$LC_AUTO_MERGE"
check "overlay preserves base mill.maxParallel" "7" "$LC_MAX_PARALLEL"
check "overlay preserves base linear.project" "base-project" "$LC_PROJECT"

# Env vars must still win over the overlay.
eval "$(
  export HOME="$FAKE_HOME"
  unset $UNSET_VARS 2>/dev/null || true
  export BASE_BRANCH="develop"
  source "$COMMON"
  load_config "$LCFG_TMP"
  echo "LC_ENV_BASE='$BASE_BRANCH'"
)"

check "env BASE_BRANCH wins over overlay" "develop" "$LC_ENV_BASE"

# detect_project_name should also see the overlay (separate code path).
eval "$(
  export HOME="$FAKE_HOME"
  unset $UNSET_VARS PROJECT_NAME LINEAR_PROJECT 2>/dev/null || true
  source "$COMMON"
  cat > "$LCFG_TMP/.wavemill-config.local.json" <<'OVERLAY'
{ "linear": { "project": "overlay-project" } }
OVERLAY
  echo "LC_DETECT='$(detect_project_name "$LCFG_TMP")'"
)"

check "detect_project_name sees overlay" "overlay-project" "$LC_DETECT"

rm -rf "$LCFG_TMP"

# ============================================================================
# Test 8: Derived session names are repo-scoped and tmux-safe
# ============================================================================
echo ""
echo "=== Repo-Scoped Session Names ==="

SESSION_TMP=$(mktemp -d)
SESSION_PARENT_A="$SESSION_TMP/parent a"
SESSION_PARENT_B="$SESSION_TMP/parent-b"
SAME_BASENAME="Same Repo:Name"
SPECIAL_BASENAME="Upper Repo.Name:42"
mkdir -p "$SESSION_PARENT_A/$SAME_BASENAME" "$SESSION_PARENT_B/$SAME_BASENAME" "$SESSION_PARENT_A/$SPECIAL_BASENAME"
git -C "$SESSION_PARENT_A/$SAME_BASENAME" init >/dev/null 2>&1
git -C "$SESSION_PARENT_B/$SAME_BASENAME" init >/dev/null 2>&1
git -C "$SESSION_PARENT_A/$SPECIAL_BASENAME" init >/dev/null 2>&1

eval "$(
  export HOME="$FAKE_HOME"
  unset $UNSET_VARS 2>/dev/null || true
  source "$COMMON"
  echo "SAME_ONE='$(wavemill_default_session_name "$SESSION_PARENT_A/$SAME_BASENAME")'"
  echo "SAME_TWO='$(wavemill_default_session_name "$SESSION_PARENT_A/$SAME_BASENAME")'"
  echo "SAME_THREE='$(wavemill_default_session_name "$SESSION_PARENT_B/$SAME_BASENAME")'"
  echo "SPECIAL_SESSION='$(wavemill_default_session_name "$SESSION_PARENT_A/$SPECIAL_BASENAME")'"
)"

check_matches "derived session format" '^wavemill-[a-z0-9-]+-[a-z0-9]{8}$' "$SAME_ONE"
check "same repo keeps stable session name" "$SAME_ONE" "$SAME_TWO"
if [[ "$SAME_ONE" != "$SAME_THREE" ]]; then
  pass "same basename in different parents gets unique sessions"
else
  fail "same basename in different parents gets unique sessions" "different session names" "$SAME_ONE"
fi
check_matches "special chars slugify to tmux-safe session" '^wavemill-upper-repo-name-42-[a-z0-9]{8}$' "$SPECIAL_SESSION"

EMPTY_SESSION_CFG_TMP=$(mktemp -d)
cat > "$EMPTY_SESSION_CFG_TMP/.wavemill-config.json" <<'EOF'
{
  "mill": {
    "session": ""
  }
}
EOF
git -C "$EMPTY_SESSION_CFG_TMP" init >/dev/null 2>&1

eval "$(
  export HOME="$FAKE_HOME"
  unset $UNSET_VARS 2>/dev/null || true
  source "$COMMON"
  load_config "$EMPTY_SESSION_CFG_TMP"
  echo "EMPTY_CFG_SESSION='$SESSION'"
  echo "EMPTY_CFG_EXPECTED='$(wavemill_default_session_name "$EMPTY_SESSION_CFG_TMP")'"
)"

check "empty configured session uses derived default" "$EMPTY_CFG_EXPECTED" "$EMPTY_CFG_SESSION"

rm -rf "$SESSION_TMP" "$EMPTY_SESSION_CFG_TMP"

# ============================================================================
# Results
# ============================================================================
echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
