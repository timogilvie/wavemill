#!/usr/bin/env bash
# protects: a DeepSeek-launched Claude Code agent starting under a fresh
# isolated HOME with no first-run record. Claude Code then opens its theme,
# API-key, security and folder-trust screens and waits for a person, so the
# agent never reads its prompt (three coding stages spent their whole retry
# budget on the theme chooser on 2026-11-10).
#
# Drives the real agent_launch_autonomous / agent_launch_interactive, runs the
# launcher script they write with a stub `claude`, and checks the first-run
# state the agent's HOME held at the moment `claude` started.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1: ${2:-}"; FAIL=$((FAIL + 1)); }

TEST_TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TEST_TMP"; rm -f /tmp/wmfrs-*-launcher.sh' EXIT

REAL_HOME="$TEST_TMP/operator-home"
WORK_DIR="$TEST_TMP/repo/worktrees/task"
mkdir -p "$REAL_HOME" "$TEST_TMP/bin" "$WORK_DIR"

# Stub claude: snapshots what the agent's HOME holds when the agent starts.
cat > "$TEST_TMP/bin/claude" <<STUB
#!/bin/bash
echo "\$HOME" > '$TEST_TMP/agent-home'
cp "\$HOME/.claude.json" '$TEST_TMP/seen-claude.json' 2>/dev/null || true
cp "\$HOME/.claude/settings.json" '$TEST_TMP/seen-settings.json' 2>/dev/null || true
STUB
printf '#!/bin/bash\nexit 0\n' > "$TEST_TMP/bin/gh"
chmod +x "$TEST_TMP/bin/claude" "$TEST_TMP/bin/gh"

export REPO_DIR="$TEST_TMP/repo"
export TOOLS_DIR="$REPO_ROOT/tools"
# shellcheck disable=SC1091
source "$REPO_ROOT/shared/lib/agent-adapters.sh"

# Isolate from model routing, provider config and tmux: only the launcher
# script the adapters write is under test.
agent_validate_model() { return 0; }
agent_resolve_model() { printf '%s\n' "$2"; }
agent_model_launch_preflight() { printf '%s\n' "$1"; }
agent_resolve_from_model() { printf 'claude\n'; }
agent_validate_deepseek_launch() { return 0; }
agent_deepseek_config() { printf '{"enabled":true,"baseUrl":"http://127.0.0.1:9","apiKeyEnv":"WMFRS_KEY","effortLevel":"medium","hasApiKey":true}\n'; }
agent_tmux_guard_export_command() { printf 'true\n'; }
agent_send_tmux_guarded_command() { return 0; }
agent_resolve_dashboard_pid() { printf '\n'; }
export WMFRS_KEY="sk-test-0123456789abcdefghijKEYTAIL"
KEY_TAIL="${WMFRS_KEY: -20}"
JQ_BIN_DIR="$(dirname "$(command -v jq)")"
GIT_BIN_DIR="$(dirname "$(command -v git)")"

run_launcher() {
  local launcher="$1"
  rm -f "$TEST_TMP/agent-home" "$TEST_TMP/seen-claude.json" "$TEST_TMP/seen-settings.json"
  ( cd "$WORK_DIR" && env -i PATH="$TEST_TMP/bin:$JQ_BIN_DIR:$GIT_BIN_DIR:/usr/bin:/bin" HOME="$REAL_HOME" \
      WMFRS_KEY="$WMFRS_KEY" bash "$launcher" </dev/null >/dev/null 2>&1 ) || true
}

check_seed() {
  local label="$1" seen="$TEST_TMP/seen-claude.json" settings="$TEST_TMP/seen-settings.json"
  if [[ ! -f "$seen" ]]; then
    fail "$label: first-run record exists when the agent starts" "no .claude.json in the agent HOME"
    return
  fi
  if [[ "$(cat "$TEST_TMP/agent-home")" == "$REAL_HOME" ]]; then
    fail "$label: agent HOME stays isolated" "agent saw the operator HOME"
  else
    pass "$label: agent HOME stays isolated"
  fi
  if [[ "$(jq -r '.hasCompletedOnboarding' "$seen")" == "true" ]]; then
    pass "$label: onboarding recorded as complete"
  else
    fail "$label: onboarding" "$(jq -c '.hasCompletedOnboarding' "$seen")"
  fi
  if [[ "$(jq -r --arg p "$WORK_DIR" '.projects[$p].hasTrustDialogAccepted' "$seen")" == "true" ]]; then
    pass "$label: the task worktree is trusted"
  else
    fail "$label: worktree trust" "$(jq -c '.projects' "$seen")"
  fi
  if [[ "$(jq -r --arg k "$KEY_TAIL" '.customApiKeyResponses.approved | index($k) != null' "$seen")" == "true" ]]; then
    pass "$label: the launch key is accepted"
  else
    fail "$label: launch key" "$(jq -c '.customApiKeyResponses' "$seen")"
  fi
  if grep -q "${WMFRS_KEY%"$KEY_TAIL"}" "$seen"; then
    fail "$label: only the key tail is stored" "the full key is in .claude.json"
  else
    pass "$label: only the key tail is stored"
  fi
  if [[ "$(jq -r '.skipDangerousModePermissionPrompt' "$settings" 2>/dev/null)" == "true" ]]; then
    pass "$label: the bypass-permissions notice is acknowledged"
  else
    fail "$label: bypass notice" "$(cat "$settings" 2>/dev/null)"
  fi
  if [[ ! -e "$REAL_HOME/.claude.json" && ! -e "$REAL_HOME/.claude" ]]; then
    pass "$label: the operator HOME is not written"
  else
    fail "$label: operator HOME" "seed wrote into the operator HOME"
  fi
}

instr="$TEST_TMP/instructions.txt"
printf 'do the work\n' > "$instr"

echo ""
echo "=== autonomous claude + deepseek model ==="
WAVEMILL_RUN_DIR="$TEST_TMP/run-auto" agent_launch_autonomous \
  "wmfrs" "coding" "$instr" "claude" "deepseek-v4-flash" "AUTO-1" >/dev/null 2>&1 || true
if [[ -f /tmp/wmfrs-AUTO-1-autonomous-launcher.sh ]]; then
  run_launcher /tmp/wmfrs-AUTO-1-autonomous-launcher.sh
  check_seed "autonomous"
else
  fail "autonomous launcher written" "no launcher script"
fi

echo ""
echo "=== interactive claude + deepseek model ==="
WAVEMILL_RUN_DIR="$TEST_TMP/run-inter" agent_launch_interactive \
  "wmfrs" "coding" "$instr" "claude" "deepseek-v4-flash" "" "" "INTER-1" >/dev/null 2>&1 || true
inter_launcher="/tmp/wmfrs-instructions-launcher.sh"
if [[ -f "$inter_launcher" ]]; then
  run_launcher "$inter_launcher"
  check_seed "interactive"
else
  fail "interactive launcher written" "no launcher script"
fi

echo ""
echo "=== relaunch into a HOME Claude Code already wrote ==="
# A relaunch reuses the HOME: existing settings survive, and a key an earlier
# first-run screen recorded as rejected is accepted.
home="$TEST_TMP/reused-home"
mkdir -p "$home/.claude"
jq -n --arg k "$KEY_TAIL" '{userID: "keep-me", customApiKeyResponses: {approved: [], rejected: [$k]}, projects: {"/other": {hasTrustDialogAccepted: true}}}' > "$home/.claude.json"
printf '{"theme":"light"}\n' > "$home/.claude/settings.json"
( cd "$WORK_DIR" && HOME="$home" ANTHROPIC_API_KEY="$WMFRS_KEY" bash -c "set -euo pipefail; $(agent_claude_isolated_home_seed_snippet)" )
if [[ "$(jq -r '.userID' "$home/.claude.json")" == "keep-me" && "$(jq -r '.projects["/other"].hasTrustDialogAccepted' "$home/.claude.json")" == "true" ]]; then
  pass "existing config is preserved"
else
  fail "existing config" "$(cat "$home/.claude.json")"
fi
if [[ "$(jq -c '.customApiKeyResponses' "$home/.claude.json")" == "{\"approved\":[\"$KEY_TAIL\"],\"rejected\":[]}" ]]; then
  pass "a previously rejected launch key is accepted"
else
  fail "rejected key" "$(jq -c '.customApiKeyResponses' "$home/.claude.json")"
fi
if [[ "$(jq -r '.theme' "$home/.claude/settings.json")" == "light" ]]; then
  pass "an existing theme is kept"
else
  fail "theme" "$(cat "$home/.claude/settings.json")"
fi

echo ""
echo "=== a corrupt first-run record never fails the launch ==="
printf 'not json' > "$home/.claude.json"
if ( cd "$WORK_DIR" && HOME="$home" bash -c "set -euo pipefail; $(agent_claude_isolated_home_seed_snippet)" ) 2>/dev/null; then
  pass "seed lines exit 0 on an unparseable .claude.json"
else
  fail "corrupt record" "seed lines failed the launcher"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
