#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADAPTERS="$REPO_DIR/shared/lib/agent-adapters.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_file() {
  local name="$1" path="$2"
  if [[ -f "$path" ]]; then
    pass "$name"
  else
    echo "    missing: $path"
    fail "$name"
  fi
}

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$name"
  else
    echo "    unexpected: $needle"
    fail "$name"
  fi
}

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

echo "=== Native Planning Fixture ==="
NODE_FIXTURE_LOG="$TMPDIR_TEST/native-planning-node-test.log"
if node --test --test-concurrency=1 shared/lib/native-agent/launch-planning.test.ts >"$NODE_FIXTURE_LOG" 2>&1; then
  pass "unit fixture proves native planning artifacts and mutation denial"
elif node --test --test-concurrency=1 shared/lib/native-agent/launch-planning.test.ts >"$NODE_FIXTURE_LOG" 2>&1; then
  pass "unit fixture proves native planning artifacts and mutation denial"
else
  cat "$NODE_FIXTURE_LOG"
  fail "unit fixture proves native planning artifacts and mutation denial"
fi

echo
echo "=== Shell Dispatch Guard ==="
TMUX_LOG="$TMPDIR_TEST/tmux.log"
NATIVE_LAUNCHER="/tmp/sess-HOK-2313_c-autonomous-launcher.sh"
NATIVE_REVIEW_LAUNCHER="/tmp/sess-HOK-2314-autonomous-launcher.sh"
source "$ADAPTERS"

tmux() {
  printf '%s\n' "$*" >> "$TMUX_LOG"
}
agent_resolve_dashboard_pid() { printf '%s\n' "123"; }
agent_hooks_dir() { printf '%s\n' "$REPO_DIR/shared/hooks"; }
agent_validate_model() { return 0; }
agent_model_launch_preflight() {
  AGENT_MODEL_PREFLIGHT_LAST_JSON='{"ok":true,"requestedModel":"'$1'","resolvedModel":"'$1'","agent":"native-openrouter","phase":"'$2'"}'
  printf '%s\n' "$1"
  return 0
}
agent_resolve_model() { printf '%s\n' "$2"; }
agent_resolve_from_model() {
  if [[ "$1" == "gpt-5.6-terra" ]]; then
    printf '%s\n' "codex"
  else
    printf '%s\n' "native-openrouter"
  fi
}
agent_write_initial_status() { :; }
routing_role_from_window() { printf '%s\n' "planner"; }
routing_emit_phase() { :; }
agent_validate_phase_launch() {
  AGENT_NATIVE_LAUNCH_LAST_JSON='{"ok":true,"model":"scripted-native"}'
  return 0
}

mkdir -p "$TMPDIR_TEST/repo/features/demo"
WAVEMILL_FEATURE_DIR="$TMPDIR_TEST/repo/features/demo" \
WAVEMILL_FEATURE_SLUG="demo" \
WAVEMILL_PLAN_DEPTH="medium" \
WAVEMILL_OPERATING_MODE="normal" \
WAVEMILL_BRANCH="task/demo" \
WAVEMILL_BASE_BRANCH="auto/integration" \
WAVEMILL_TITLE="Demo" \
REPO_DIR="$REPO_DIR" \
agent_launch_autonomous "sess" "planning" "/tmp/instr.txt" "native-openrouter" "kimi-k2.7-code" "HOK-2313_c"

check_contains "native branch dispatches launcher path" "$(cat "$TMUX_LOG")" "$NATIVE_LAUNCHER"
check_contains "native launcher invokes launch-native-planning tool" "$(cat "$NATIVE_LAUNCHER")" "tools/launch-native-planning.ts"
check_contains "native launcher exports canonical challenger linear issue id" "$(cat "$NATIVE_LAUNCHER")" "export WAVEMILL_LINEAR_ISSUE='HOK-2313'"
check_contains "native launcher passes canonical challenger linear issue id" "$(cat "$NATIVE_LAUNCHER")" "--linear-issue 'HOK-2313'"
check_not_contains "native planning launcher does not execute logical provider" "$(cat "$NATIVE_LAUNCHER")" "native-openrouter --model"

TMUX_LOG="$TMPDIR_TEST/tmux-interactive-native.log"
INTERACTIVE_NATIVE_PROMPT="/tmp/HOK-2315_c-planning-prompt.txt"
INTERACTIVE_NATIVE_LAUNCHER="/tmp/sess-HOK-2315_c-planning-prompt-launcher.sh"
printf '%s\n' "plan prompt" > "$INTERACTIVE_NATIVE_PROMPT"
rm -f "$INTERACTIVE_NATIVE_LAUNCHER"
tmux() {
  printf '%s\n' "$*" >> "$TMUX_LOG"
}
agent_prepare_pane_for_launch() { return 0; }
WAVEMILL_FEATURE_DIR="$TMPDIR_TEST/repo/features/demo" \
WAVEMILL_FEATURE_SLUG="demo" \
WAVEMILL_PLAN_DEPTH="medium" \
WAVEMILL_OPERATING_MODE="normal" \
WAVEMILL_BRANCH="task/demo" \
WAVEMILL_BASE_BRANCH="auto/integration" \
WAVEMILL_TITLE="Demo" \
REPO_DIR="$REPO_DIR" \
agent_launch_interactive "sess" "planning" "$INTERACTIVE_NATIVE_PROMPT" "native-openrouter" "kimi-k2.7-code" "" "" "HOK-2315_c"

check_contains "interactive native planning dispatches launcher path" "$(cat "$TMUX_LOG")" "$INTERACTIVE_NATIVE_LAUNCHER"
check_contains "interactive native planning invokes launch-native-planning tool" "$(cat "$INTERACTIVE_NATIVE_LAUNCHER")" "tools/launch-native-planning.ts"
check_not_contains "interactive native planning launcher has no bare model command" "$(cat "$INTERACTIVE_NATIVE_LAUNCHER")" $'\n --model'
check_not_contains "interactive native planning launcher does not execute logical provider" "$(cat "$INTERACTIVE_NATIVE_LAUNCHER")" "native-openrouter --model"

TMUX_LOG="$TMPDIR_TEST/tmux-review.log"
tmux() {
  printf '%s\n' "$*" >> "$TMUX_LOG"
}
routing_role_from_window() { printf '%s\n' "reviewer"; }
WAVEMILL_FEATURE_DIR="$TMPDIR_TEST/repo/features/demo" \
WAVEMILL_FEATURE_SLUG="demo" \
WAVEMILL_BRANCH="task/demo" \
WAVEMILL_BASE_BRANCH="auto/integration" \
WAVEMILL_TITLE="Demo" \
REPO_DIR="$REPO_DIR" \
agent_launch_autonomous "sess" "review" "/tmp/instr.txt" "native-openrouter" "qwen-3-coder" "HOK-2314"

check_contains "native review dispatches launcher path" "$(cat "$TMUX_LOG")" "$NATIVE_REVIEW_LAUNCHER"
check_contains "native review launcher invokes review flow tool" "$(cat "$NATIVE_REVIEW_LAUNCHER")" "tools/launch-native-review.ts"
check_not_contains "native review launcher does not execute logical provider" "$(cat "$NATIVE_REVIEW_LAUNCHER")" "native-openrouter --model"

TMUX_LOG="$TMPDIR_TEST/tmux-native-coding.log"
tmux() {
  printf '%s\n' "$*" >> "$TMUX_LOG"
}
NATIVE_CODING_PROMPT="/tmp/wavemill-HOK-2542-coding-prompt.txt"
NATIVE_CODING_LAUNCHER="/tmp/sess-HOK-2542-autonomous-launcher.sh"
rm -f "$NATIVE_CODING_LAUNCHER"
REPO_DIR="$REPO_DIR" \
agent_launch_autonomous "sess" "@95" "$NATIVE_CODING_PROMPT" "native-openrouter" "qwen-3-coder" "HOK-2542"

check_contains "native coding dispatches launcher path" "$(cat "$TMUX_LOG")" "$NATIVE_CODING_LAUNCHER"
check_contains "native coding launcher invokes coding flow tool" "$(cat "$NATIVE_CODING_LAUNCHER")" "tools/launch-native-coding.ts"
check_contains "native coding launcher normalizes phase from prompt" "$(cat "$NATIVE_CODING_LAUNCHER")" "export WAVEMILL_PHASE='coding'"
check_not_contains "native coding launcher does not execute logical provider" "$(cat "$NATIVE_CODING_LAUNCHER")" "native-openrouter --model"

TMUX_LOG="$TMPDIR_TEST/tmux-coding.log"
tmux() {
  printf '%s\n' "$*" >> "$TMUX_LOG"
}
CODING_PROMPT="/tmp/wavemill-HOK-2516-coding-prompt.txt"
CODING_LAUNCHER="/tmp/sess-HOK-2516-autonomous-launcher.sh"
rm -f "$CODING_LAUNCHER"
REPO_DIR="$REPO_DIR" \
agent_launch_autonomous "sess" "@95" "$CODING_PROMPT" "codex" "gpt-5.6-terra" "HOK-2516"

check_contains "tmux id coding prompt dispatches codex launcher" "$(cat "$TMUX_LOG")" "$CODING_LAUNCHER"
check_contains "coding launcher normalizes phase from prompt" "$(cat "$CODING_LAUNCHER")" "export WAVEMILL_PHASE='coding'"
check_contains "coding launcher uses effective coder route" "$(cat "$CODING_LAUNCHER")" "codex exec --model gpt-5.6-terra"
check_not_contains "coding launcher does not execute native provider" "$(cat "$CODING_LAUNCHER")" "native-openrouter --model"

BAD_NATIVE_LAUNCHER="/tmp/sess-HOK-2517-autonomous-launcher.sh"
rm -f "$BAD_NATIVE_LAUNCHER"
if REPO_DIR="$REPO_DIR" agent_launch_autonomous "sess" "@96" "/tmp/instr.txt" "native-openrouter" "qwen-3-coder" "HOK-2517" 2>"$TMPDIR_TEST/bad-native.err"; then
  fail "native launch fails closed when phase cannot be normalized"
else
  pass "native launch fails closed when phase cannot be normalized"
fi
if [[ -f "$BAD_NATIVE_LAUNCHER" ]]; then
  fail "invalid native phase does not write launcher"
else
  pass "invalid native phase does not write launcher"
fi

PREFLIGHT_AUTONOMOUS_LAUNCHER="/tmp/sess-HOK-2545-autonomous-launcher.sh"
rm -f "$PREFLIGHT_AUTONOMOUS_LAUNCHER"
TMUX_LOG="$TMPDIR_TEST/tmux-preflight-autonomous.log"
rm -f "$TMUX_LOG"
tmux() {
  printf '%s\n' "$*" >> "$TMUX_LOG"
}
agent_validate_phase_launch() {
  AGENT_NATIVE_LAUNCH_LAST_JSON='{"ok":false,"reason":"TEST_OPENROUTER_KEY is not set","code":"missing-provider-env","surface":"nativeAgent.providers.openrouter.apiKeyEnv","remediation":"Set TEST_OPENROUTER_KEY before launch.","wavemillAlias":"glm-5.2","openrouterId":"z-ai/glm-5.2"}'
  AGENT_NATIVE_LAUNCH_LAST_REASON="TEST_OPENROUTER_KEY is not set"
  return 1
}
if REPO_DIR="$REPO_DIR" agent_launch_autonomous "sess" "planning" "/tmp/instr.txt" "native-openrouter" "glm-5.2" "HOK-2545" \
  >"$TMPDIR_TEST/preflight-autonomous.stdout" 2>"$TMPDIR_TEST/preflight-autonomous.stderr"; then
  fail "autonomous native preflight rejects missing provider env"
else
  pass "autonomous native preflight rejects missing provider env"
fi
if [[ -f "$PREFLIGHT_AUTONOMOUS_LAUNCHER" ]]; then
  fail "autonomous native preflight does not write launcher"
else
  pass "autonomous native preflight does not write launcher"
fi
if [[ ! -s "$TMUX_LOG" ]]; then
  pass "autonomous native preflight does not touch tmux"
else
  fail "autonomous native preflight does not touch tmux"
fi
if grep -q "route=HOK-2545" "$TMPDIR_TEST/preflight-autonomous.stderr" \
  && grep -q "stage=planning" "$TMPDIR_TEST/preflight-autonomous.stderr" \
  && grep -q "provider=openrouter" "$TMPDIR_TEST/preflight-autonomous.stderr" \
  && grep -q "model=glm-5.2" "$TMPDIR_TEST/preflight-autonomous.stderr" \
  && grep -q "surface=nativeAgent.providers.openrouter.apiKeyEnv" "$TMPDIR_TEST/preflight-autonomous.stderr"; then
  pass "autonomous native preflight emits route diagnostics"
else
  fail "autonomous native preflight emits route diagnostics" "$(cat "$TMPDIR_TEST/preflight-autonomous.stderr")"
fi

PREFLIGHT_INTERACTIVE_PROMPT="/tmp/HOK-2545-planning-prompt.txt"
PREFLIGHT_INTERACTIVE_LAUNCHER="/tmp/sess-HOK-2545-planning-prompt-launcher.sh"
printf '%s\n' "preflight plan prompt" > "$PREFLIGHT_INTERACTIVE_PROMPT"
rm -f "$PREFLIGHT_INTERACTIVE_LAUNCHER"
PREPARE_CALLED=0
TMUX_LOG="$TMPDIR_TEST/tmux-preflight-interactive.log"
rm -f "$TMUX_LOG"
tmux() {
  printf '%s\n' "$*" >> "$TMUX_LOG"
}
agent_prepare_pane_for_launch() {
  PREPARE_CALLED=1
  return 0
}
if REPO_DIR="$REPO_DIR" \
  WAVEMILL_FEATURE_DIR="$TMPDIR_TEST/repo/features/demo" \
  WAVEMILL_FEATURE_SLUG="demo" \
  agent_launch_interactive "sess" "planning" "$PREFLIGHT_INTERACTIVE_PROMPT" "native-openrouter" "glm-5.2" "" "" "HOK-2545" \
    >"$TMPDIR_TEST/preflight-interactive.stdout" 2>"$TMPDIR_TEST/preflight-interactive.stderr"; then
  fail "interactive native preflight rejects missing provider env"
else
  pass "interactive native preflight rejects missing provider env"
fi
if [[ "$PREPARE_CALLED" -eq 0 ]]; then
  pass "interactive native preflight does not prepare pane"
else
  fail "interactive native preflight does not prepare pane"
fi
if [[ -f "$PREFLIGHT_INTERACTIVE_LAUNCHER" ]]; then
  fail "interactive native preflight does not write launcher"
else
  pass "interactive native preflight does not write launcher"
fi
if grep -q "route=HOK-2545" "$TMPDIR_TEST/preflight-interactive.stderr" \
  && grep -q "stage=planning" "$TMPDIR_TEST/preflight-interactive.stderr" \
  && grep -q "provider=openrouter" "$TMPDIR_TEST/preflight-interactive.stderr" \
  && grep -q "model=glm-5.2" "$TMPDIR_TEST/preflight-interactive.stderr"; then
  pass "interactive native preflight emits route diagnostics"
else
  fail "interactive native preflight emits route diagnostics" "$(cat "$TMPDIR_TEST/preflight-interactive.stderr")"
fi

unset -f agent_validate_phase_launch
source "$ADAPTERS"

if WAVEMILL_PHASE="coding" agent_native_planning_eligible "$REPO_DIR" "coding"; then
  fail "coding phase isolation"
else
  pass "coding phase isolation"
fi

CODING_GUARD_REPO="$TMPDIR_TEST/coding-guard-repo"
mkdir -p "$CODING_GUARD_REPO"
cat > "$CODING_GUARD_REPO/.wavemill-config.json" <<'EOF'
{
  "nativeAgent": {
    "enabled": true,
    "allowedPhases": ["task-expansion", "planning", "review"]
  }
}
EOF

if npx tsx "$REPO_DIR/tools/check-native-eligibility.ts" "$CODING_GUARD_REPO" "coding" >/dev/null 2>&1; then
  fail "native opt-in still excludes coding"
else
  pass "native opt-in still excludes coding"
fi

CODING_DISPATCH_REPO="$TMPDIR_TEST/coding-dispatch-repo"
mkdir -p "$CODING_DISPATCH_REPO"
cat > "$CODING_DISPATCH_REPO/.wavemill-config.json" <<'EOF'
{
  "nativeAgent": {
    "enabled": true,
    "allowedPhases": ["planning", "coding", "review"],
    "patchCoding": {
      "enabled": true
    },
    "providers": {
      "openrouter": {
        "models": ["qwen-3-coder"]
      }
    }
  }
}
EOF

if npx tsx "$REPO_DIR/tools/check-native-agent-launch.ts" \
  --repo-dir "$CODING_DISPATCH_REPO" \
  --phase coding \
  --agent native-openrouter \
  --model qwen-3-coder >/dev/null 2>&1; then
  fail "native coding dispatch stays fail-closed without patch certification"
else
  pass "native coding dispatch stays fail-closed without patch certification"
fi

ROLE_REPO="$TMPDIR_TEST/role-guard-repo"
ROLE_CERT_ROOT="$TMPDIR_TEST/role-guard-global-certs"
mkdir -p "$ROLE_CERT_ROOT/google/gemini-2.5-flash" "$ROLE_REPO"
cat > "$ROLE_REPO/.wavemill-config.json" <<'EOF'
{
  "nativeAgent": {
    "enabled": true,
    "allowedPhases": ["planning", "review"],
    "providers": {
      "openrouter": {
        "enabled": true,
        "apiKeyEnv": "TEST_OPENROUTER_KEY",
        "models": ["google/gemini-2.5-flash"]
      }
    }
  }
}
EOF
cat > "$ROLE_CERT_ROOT/google/gemini-2.5-flash/v2.json" <<'EOF'
{
  "schemaVersion": 2,
  "provider": "google",
  "model": "gemini-2.5-flash",
  "phase": "workflow",
  "suiteVersion": "v2",
  "certifiedAt": "2099-01-01T00:00:00.000Z",
  "scenarios": [{ "scenarioId": "s1", "passed": true }]
}
EOF

if TEST_OPENROUTER_KEY="sk-test" WAVEMILL_NATIVE_CERTIFICATION_ROOT="$ROLE_CERT_ROOT" npx tsx "$REPO_DIR/tools/check-native-eligibility.ts" "$ROLE_REPO" "planning" >/dev/null 2>&1; then
  fail "role-ineligible native planner is not selected"
else
  pass "role-ineligible native planner is not selected"
fi

probe_stdout="$TMPDIR_TEST/role-probe.stdout"
probe_stderr="$TMPDIR_TEST/role-probe.stderr"
agent_run_tsx_tool() {
  printf '%s\n' '{"ok":false,"reason":"native provider openrouter/gemini-2.5-flash is not eligible for planning (eligible roles: coding, review)"}'
  return 1
}
if TEST_OPENROUTER_KEY="sk-test" TOOLS_DIR="$REPO_DIR/tools" agent_native_launch_probe "native-openrouter" "planning" "gemini-2.5-flash" "$ROLE_REPO" >"$probe_stdout" 2>"$probe_stderr"; then
  fail "role-ineligible native launch probe rejects planner route"
else
  pass "role-ineligible native launch probe rejects planner route"
fi
unset -f agent_run_tsx_tool
source "$ADAPTERS"
if grep -q '{"ok":false' "$probe_stderr"; then
  fail "native launch probe does not echo raw JSON rejection"
else
  pass "native launch probe does not echo raw JSON rejection"
fi
if grep -q "not eligible for planning" "$probe_stderr"; then
  pass "native launch probe emits parsed rejection reason"
else
  fail "native launch probe emits parsed rejection reason" "$(cat "$probe_stderr")"
fi

BAD_INTERACTIVE_PROMPT="/tmp/HOK-2319_c-planning-prompt.txt"
BAD_INTERACTIVE_LAUNCHER="/tmp/sess-HOK-2319_c-planning-prompt-launcher.sh"
printf '%s\n' "bad plan prompt" > "$BAD_INTERACTIVE_PROMPT"
rm -f "$BAD_INTERACTIVE_LAUNCHER"
agent_prepare_pane_for_launch() { return 0; }
tmux() { :; }
if TEST_OPENROUTER_KEY="sk-test" \
  TOOLS_DIR="$REPO_DIR/tools" \
  REPO_DIR="$ROLE_REPO" \
  WAVEMILL_FEATURE_DIR="$ROLE_REPO/features/demo" \
  WAVEMILL_FEATURE_SLUG="demo" \
  agent_launch_interactive "sess" "planning" "$BAD_INTERACTIVE_PROMPT" "native-openrouter" "gemini-2.5-flash" "" "" "HOK-2319_c" \
    >"$TMPDIR_TEST/bad-interactive.stdout" 2>"$TMPDIR_TEST/bad-interactive.stderr"; then
  fail "interactive native planner rejects role-ineligible qwen route"
else
  pass "interactive native planner rejects role-ineligible qwen route"
fi
if [[ -f "$BAD_INTERACTIVE_LAUNCHER" ]]; then
  fail "role-ineligible interactive native planner does not write launcher"
else
  pass "role-ineligible interactive native planner does not write launcher"
fi
if grep -Eq "not eligible for planning|Failed to resolve model selector 'gemini-2.5-flash'|Rejecting invalid model 'gemini-2.5-flash'|native launch probe failed for native-openrouter/planning|model=gemini-2.5-flash.*reason=role-ineligible" "$TMPDIR_TEST/bad-interactive.stderr"; then
  pass "interactive native planner emits role rejection"
else
  fail "interactive native planner emits role rejection" "$(cat "$TMPDIR_TEST/bad-interactive.stderr")"
fi

DISABLED_REPO="$TMPDIR_TEST/disabled-native-repo"
mkdir -p "$DISABLED_REPO"
cat > "$DISABLED_REPO/.wavemill-config.json" <<'EOF'
{
  "nativeAgent": {
    "enabled": false,
    "allowedPhases": ["planning"],
    "providers": {
      "openrouter": {
        "enabled": true,
        "apiKeyEnv": "TEST_OPENROUTER_KEY",
        "models": ["z-ai/glm-5.2"]
      }
    }
  }
}
EOF

if TEST_OPENROUTER_KEY="sk-test" agent_native_planning_eligible "$DISABLED_REPO" "planning"; then
  fail "disabled config stays ineligible"
else
  pass "disabled config stays ineligible"
fi

echo
if [[ "$FAIL" -ne 0 ]]; then
  echo "FAIL: $FAIL checks failed ($PASS passed)"
  exit 1
fi
echo "PASS: $PASS checks passed"
