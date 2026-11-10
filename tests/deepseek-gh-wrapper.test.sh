#!/usr/bin/env bash
# HOTFIX(HOK-3464): delete with the wrapper when HOK-3463 lands.
#
# protects: a DeepSeek-launched agent (HOME/XDG_CONFIG_HOME redirected into the
# provider dir) running `gh` without the operator's HOME and gh config, which
# made gh "not logged in" and parked HOK-3424 as "Agent exited without creating PR".
#
# Drives the real agent_launch_autonomous / agent_launch_interactive, runs the
# launcher script they write with stub `claude` and `gh` binaries, and checks
# what environment `gh` actually saw.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1: ${2:-}"; FAIL=$((FAIL + 1)); }

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"; rm -f /tmp/wmghw-*-launcher.sh' EXIT

REAL_HOME="$TEST_TMP/operator-home"
mkdir -p "$REAL_HOME/.config/gh" "$TEST_TMP/bin" "$TEST_TMP/repo"

# Stub gh: records the environment it ran with.
GH_RECORD="$TEST_TMP/gh-record"
cat > "$TEST_TMP/bin/gh" <<EOF
#!/bin/bash
{ echo "HOME=\$HOME"; echo "GH_CONFIG_DIR=\${GH_CONFIG_DIR:-}"; echo "ARGS=\$*"; } > '$GH_RECORD'
EOF
# Stub claude: what an agent does — calls gh with the launcher's environment,
# and records the HOME the agent itself sees.
cat > "$TEST_TMP/bin/claude" <<EOF
#!/bin/bash
cat >/dev/null
echo "AGENT_HOME=\$HOME" > '$TEST_TMP/agent-record'
gh auth status
EOF
chmod +x "$TEST_TMP/bin/gh" "$TEST_TMP/bin/claude"

export REPO_DIR="$TEST_TMP/repo"
export TOOLS_DIR="$REPO_ROOT/tools"
# shellcheck disable=SC1091
source "$REPO_ROOT/shared/lib/agent-adapters.sh"

# Isolate from model routing, provider config and tmux: only the launcher
# script text is under test.
agent_validate_model() { return 0; }
agent_resolve_model() { printf '%s\n' "$2"; }
agent_model_launch_preflight() { printf '%s\n' "$1"; }
agent_resolve_from_model() { printf 'claude\n'; }
agent_validate_deepseek_launch() { return 0; }
agent_deepseek_config() { printf '{"enabled":true,"baseUrl":"http://127.0.0.1:9","apiKeyEnv":"WMGHW_KEY","effortLevel":"medium","hasApiKey":true}\n'; }
agent_tmux_guard_export_command() { printf 'true\n'; }
agent_send_tmux_guarded_command() { return 0; }
agent_resolve_dashboard_pid() { printf '\n'; }
export WMGHW_KEY="sk-test"

run_launcher() {
  local launcher="$1"
  rm -f "$GH_RECORD" "$TEST_TMP/agent-record"
  # node's dir is on PATH for the claude-deepseek launcher's runtime env block.
  env -i PATH="$TEST_TMP/bin:$NODE_BIN_DIR:/usr/bin:/bin" HOME="$REAL_HOME" \
    WMGHW_KEY="$WMGHW_KEY" DEEPSEEK_API_KEY="$WMGHW_KEY" NPM_CONFIG_UPDATE_NOTIFIER=false \
    bash "$launcher" </dev/null >/dev/null 2>&1 || true
}
NODE_BIN_DIR="$(dirname "$(command -v node)")"

check_gh_env() {
  local label="$1"
  if [[ ! -f "$GH_RECORD" ]]; then
    fail "$label: gh ran" "stub gh never ran"
    return
  fi
  if grep -qx "HOME=$REAL_HOME" "$GH_RECORD"; then
    pass "$label: gh runs with the operator's HOME"
  else
    fail "$label: gh HOME" "$(grep '^HOME=' "$GH_RECORD")"
  fi
  if grep -qx "GH_CONFIG_DIR=$REAL_HOME/.config/gh" "$GH_RECORD"; then
    pass "$label: gh reads the operator's gh config dir"
  else
    fail "$label: gh config dir" "$(grep '^GH_CONFIG_DIR=' "$GH_RECORD")"
  fi
  if grep -qx "ARGS=auth status" "$GH_RECORD"; then
    pass "$label: gh arguments pass through"
  else
    fail "$label: gh args" "$(grep '^ARGS=' "$GH_RECORD")"
  fi
  if grep -q "^AGENT_HOME=$REAL_HOME\$" "$TEST_TMP/agent-record" 2>/dev/null; then
    fail "$label: agent HOME stays isolated" "agent saw the operator HOME"
  else
    pass "$label: agent HOME stays isolated"
  fi
}

instr="$TEST_TMP/instructions.txt"
printf 'do the review\n' > "$instr"

echo ""
echo "=== autonomous claude + deepseek model ==="
WAVEMILL_RUN_DIR="$TEST_TMP/run-auto" agent_launch_autonomous \
  "wmghw" "review" "$instr" "claude" "deepseek-v4-pro" "AUTO-1" >/dev/null 2>&1 || true
if [[ -f /tmp/wmghw-AUTO-1-autonomous-launcher.sh ]]; then
  run_launcher /tmp/wmghw-AUTO-1-autonomous-launcher.sh
  check_gh_env "autonomous"
else
  fail "autonomous launcher written" "no launcher script"
fi

echo ""
echo "=== interactive claude + deepseek model ==="
WAVEMILL_RUN_DIR="$TEST_TMP/run-inter" agent_launch_interactive \
  "wmghw" "review" "$instr" "claude" "deepseek-v4-pro" "" "" "INTER-1" >/dev/null 2>&1 || true
inter_launcher="/tmp/wmghw-instructions-launcher.sh"
if [[ -f "$inter_launcher" ]]; then
  run_launcher "$inter_launcher"
  check_gh_env "interactive"
else
  fail "interactive launcher written" "no launcher script"
fi

echo ""
echo "=== autonomous claude-deepseek agent command (runtime env block) ==="
DEEPSEEK_API_KEY="$WMGHW_KEY" agent_launch_autonomous \
  "wmghw" "review" "$instr" "claude-deepseek" "" "CDS-1" >/dev/null 2>&1 || true
if [[ -f /tmp/wmghw-CDS-1-autonomous-launcher.sh ]]; then
  run_launcher /tmp/wmghw-CDS-1-autonomous-launcher.sh
  check_gh_env "claude-deepseek"
  rm -f /tmp/wavemill-wmghw-CDS-1.deepseek-state
else
  fail "claude-deepseek launcher written" "no launcher script"
fi

echo ""
echo "=== wrapper snippet with no provider root ==="
if [[ -z "$(agent_deepseek_gh_wrapper_snippet "")" ]]; then
  pass "empty provider root emits no wrapper (never writes /bin/gh)"
else
  fail "empty provider root" "snippet was emitted"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
