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

# HOK-3272: the caller's phase is the one phase source. A remediation prompt
# filename names no phase, so without it the native preflight refuses the route
# (exit 3: refused before any agent started); with it, a prompt-driven coding
# launch hands the prompt to the native coding launcher. A normal coding launch
# keeps rebuilding its packet (no --prompt-file).
TMUX_LOG="$TMPDIR_TEST/tmux-interactive-native-coding.log"
INTERACTIVE_CODING_PROMPT="/tmp/HOK-3272-coding-prompt.txt"
INTERACTIVE_CODING_LAUNCHER="/tmp/sess-HOK-3272-coding-prompt-launcher.sh"
printf '%s\n' "coding prompt" > "$INTERACTIVE_CODING_PROMPT"
rm -f "$INTERACTIVE_CODING_LAUNCHER"
WAVEMILL_FEATURE_DIR="$TMPDIR_TEST/repo/features/demo" WAVEMILL_FEATURE_SLUG="demo" REPO_DIR="$REPO_DIR" \
agent_launch_interactive "sess" "@97" "$INTERACTIVE_CODING_PROMPT" "native-openrouter" "kimi-k2.7-code" "" "" "HOK-3272"
check_contains "interactive native coding falls back to the prompt-name phase" "$(cat "$INTERACTIVE_CODING_LAUNCHER")" "export WAVEMILL_PHASE='coding'"
check_contains "interactive native coding invokes launch-native-coding tool" "$(cat "$INTERACTIVE_CODING_LAUNCHER")" "tools/launch-native-coding.ts"
check_not_contains "packet-driven native coding passes no --prompt-file" "$(cat "$INTERACTIVE_CODING_LAUNCHER")" "--prompt-file"

REMEDIATION_PROMPT="/tmp/HOK-3272_c-conflict-prompt.txt"
REMEDIATION_LAUNCHER="/tmp/sess-HOK-3272_c-conflict-prompt-launcher.sh"
printf '%s\n' "resolve the conflict" > "$REMEDIATION_PROMPT"
rm -f "$REMEDIATION_LAUNCHER"
remediation_rc=0
WAVEMILL_FEATURE_DIR="$TMPDIR_TEST/repo/features/demo" WAVEMILL_FEATURE_SLUG="demo" REPO_DIR="$REPO_DIR" \
agent_launch_interactive "sess" "@98" "$REMEDIATION_PROMPT" "native-openrouter" "kimi-k2.7-code" "" "" "HOK-3272_c" \
  2>"$TMPDIR_TEST/remediation-nophase.stderr" || remediation_rc=$?
if [[ "$remediation_rc" -eq 3 && ! -f "$REMEDIATION_LAUNCHER" ]] \
  && grep -q "reason=unsupported-native-stage" "$TMPDIR_TEST/remediation-nophase.stderr"; then
  pass "phase-less remediation prompt is refused (rc 3) before any launcher is written"
else
  fail "phase-less remediation prompt is refused (rc 3) before any launcher is written (rc=$remediation_rc)"
fi
WAVEMILL_FEATURE_DIR="$TMPDIR_TEST/repo/features/demo" WAVEMILL_FEATURE_SLUG="demo" REPO_DIR="$REPO_DIR" \
agent_launch_interactive "sess" "@98" "$REMEDIATION_PROMPT" "native-openrouter" "kimi-k2.7-code" "" "" "HOK-3272_c" "coding" "true"
check_contains "explicit phase drives the native remediation launcher" "$(cat "$REMEDIATION_LAUNCHER")" "export WAVEMILL_PHASE='coding'"
check_contains "prompt-driven native coding passes the remediation prompt" "$(cat "$REMEDIATION_LAUNCHER")" "--prompt-file '$REMEDIATION_PROMPT'"
check_contains "prompt-driven native remediation uses the coding launcher" "$(cat "$REMEDIATION_LAUNCHER")" "tools/launch-native-coding.ts"
WAVEMILL_FEATURE_DIR="$TMPDIR_TEST/repo/features/demo" WAVEMILL_FEATURE_SLUG="demo" WAVEMILL_SESSION_KIND="conflict-resolution" REPO_DIR="$REPO_DIR" \
agent_launch_interactive "sess" "@98" "$REMEDIATION_PROMPT" "native-openrouter" "kimi-k2.7-code" "" "" "HOK-3272_c" "coding" "true"
check_contains "native remediation launcher hands its kind to the native ownership row (HOK-3328)" "$(cat "$REMEDIATION_LAUNCHER")" "export WAVEMILL_SESSION_KIND='conflict-resolution'"
rm -f "$INTERACTIVE_CODING_PROMPT" "$INTERACTIVE_CODING_LAUNCHER" "$REMEDIATION_PROMPT" "$REMEDIATION_LAUNCHER"

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

# HOK-3328: a launcher records its session in the task's ownership record
# before the harness starts. Run the generated launchers against fake CLIs
# and check the row they wrote names the session the CLI was started with.
OWN_DIR="$TMPDIR_TEST/own-repo/features/own"
OWN_BIN="$TMPDIR_TEST/own-bin"
mkdir -p "$OWN_DIR" "$OWN_BIN"
cat > "$OWN_BIN/codex" <<'FAKE'
#!/usr/bin/env bash
cat > "$OWN_PROMPT_LOG"
FAKE
cat > "$OWN_BIN/claude" <<'FAKE'
#!/usr/bin/env bash
cat >/dev/null
printf '%s\n' "$*" > "$OWN_ARGV_LOG"
FAKE
chmod +x "$OWN_BIN/codex" "$OWN_BIN/claude"

TMUX_LOG="$TMPDIR_TEST/tmux-own-codex.log"
OWN_CODEX_LAUNCHER="/tmp/sess-HOK-3328-autonomous-launcher.sh"
printf 'implement it\n' > "$TMPDIR_TEST/own-instr.txt"
rm -f "$OWN_CODEX_LAUNCHER"
WAVEMILL_FEATURE_DIR="$OWN_DIR" REPO_DIR="$REPO_DIR" \
agent_launch_autonomous "sess" "coding" "$TMPDIR_TEST/own-instr.txt" "codex" "gpt-5.6-terra" "HOK-3328"
OWN_PROMPT_LOG="$TMPDIR_TEST/own-codex-prompt.txt" PATH="$OWN_BIN:$PATH" bash "$OWN_CODEX_LAUNCHER" >/dev/null 2>&1 || true
own_codex_ref="$(jq -r 'select(.type == "launch") | .sessionRef' "$OWN_DIR/.session-ownership.jsonl" 2>/dev/null | tail -1)"
own_codex_kind="$(jq -r 'select(.type == "launch") | .kind' "$OWN_DIR/.session-ownership.jsonl" 2>/dev/null | tail -1)"
check_contains "codex launch records a pending ownership row" "$own_codex_ref" "pending:"
check_contains "codex launch row is a coding launch" "$own_codex_kind" "coding"
check_contains "codex prompt carries the row's launch nonce" "$(cat "$TMPDIR_TEST/own-codex-prompt.txt" 2>/dev/null)" "wavemill-launch-nonce: ${own_codex_ref#pending:}"
check_contains "codex prompt still carries the instructions" "$(cat "$TMPDIR_TEST/own-codex-prompt.txt" 2>/dev/null)" "implement it"

TMUX_LOG="$TMPDIR_TEST/tmux-own-claude.log"
OWN_CLAUDE_LAUNCHER="/tmp/sess-HOK-3329-autonomous-launcher.sh"
rm -f "$OWN_CLAUDE_LAUNCHER"
agent_resolve_from_model() { printf '%s\n' "claude"; }
WAVEMILL_FEATURE_DIR="$OWN_DIR" WAVEMILL_SESSION_KIND="ready-remediation" REPO_DIR="$REPO_DIR" \
agent_launch_autonomous "sess" "coding" "$TMPDIR_TEST/own-instr.txt" "claude" "claude-opus-4-7" "HOK-3329"
for _ in 1 2; do
  OWN_ARGV_LOG="$TMPDIR_TEST/own-claude-argv.txt" PATH="$OWN_BIN:$PATH" bash "$OWN_CLAUDE_LAUNCHER" >/dev/null 2>&1 || true
done
own_claude_refs="$(jq -r 'select(.type == "launch" and .harness == "claude-code") | .sessionRef' "$OWN_DIR/.session-ownership.jsonl" 2>/dev/null)"
own_claude_last="$(tail -1 <<<"$own_claude_refs")"
check_contains "claude launch passes the recorded --session-id" "$(cat "$TMPDIR_TEST/own-claude-argv.txt" 2>/dev/null)" "--session-id $own_claude_last"
if [[ "$(wc -l <<<"$own_claude_refs" | tr -d ' ')" == "2" && "$(sort -u <<<"$own_claude_refs" | wc -l | tr -d ' ')" == "2" ]]; then
  pass "each claude relaunch records its own fresh session id"
else
  fail "each claude relaunch records its own fresh session id (refs: $own_claude_refs)"
fi
check_contains "remediation kind reaches the claude launch row" \
  "$(jq -r 'select(.harness == "claude-code") | .kind' "$OWN_DIR/.session-ownership.jsonl" | sort -u)" "ready-remediation"
rm -f "$OWN_CODEX_LAUNCHER" "$OWN_CLAUDE_LAUNCHER"
agent_resolve_from_model() {
  if [[ "$1" == "gpt-5.6-terra" ]]; then
    printf '%s\n' "codex"
  else
    printf '%s\n' "native-openrouter"
  fi
}

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
