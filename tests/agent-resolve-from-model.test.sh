#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$REPO_DIR/shared/lib"
TOOLS_DIR="$REPO_DIR/tools"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1: ${2:-}"; FAIL=$((FAIL + 1)); }

run_resolve() {
  local stdout_file="$1"
  local stderr_file="$2"
  shift 2

  (
    export REPO_DIR
    export TOOLS_DIR
    # shellcheck disable=SC1090
    source "$LIB_DIR/agent-adapters.sh"
    "$@"
  ) >"$stdout_file" 2>"$stderr_file"
}

run_snippet() {
  local stdout_file="$1"
  local stderr_file="$2"
  local snippet="$3"

  (
    export REPO_DIR
    export TOOLS_DIR
    # shellcheck disable=SC1090
    source "$LIB_DIR/agent-adapters.sh"
    eval "$snippet"
  ) >"$stdout_file" 2>"$stderr_file"
}

echo ""
echo "=== agent_resolve_from_model ==="

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "gpt-5.6-sol" "planning"; then
  fail "gpt-5.6-sol planning should fail closed" "expected non-zero exit"
else
  if [[ ! -s "$stdout_file" ]]; then
    pass "gpt-5.6-sol planning leaves stdout empty"
  else
    fail "gpt-5.6-sol planning leaves stdout empty" "got: $(cat "$stdout_file")"
  fi
  if grep -q '\[agent-resolution\].*gpt-5.6-sol.*phase=planning' "$stderr_file" && grep -q 'surface=codex-chatgpt.*codex-chatgpt-ineligible' "$stderr_file"; then
    pass "gpt-5.6-sol planning emits actionable diagnostic"
  else
    fail "gpt-5.6-sol planning emits actionable diagnostic" "$(cat "$stderr_file")"
  fi
fi
rm -f "$stdout_file" "$stderr_file"

for unsupported_model in gpt-5 gpt-5-mini gpt-5.4; do
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"
  if run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "$unsupported_model" "planning"; then
    fail "$unsupported_model must not resolve for Codex/ChatGPT" "expected non-zero exit"
  elif [[ ! -s "$stdout_file" ]] \
    && grep -q "model=$unsupported_model" "$stderr_file" \
    && grep -q 'surface=codex-chatgpt' "$stderr_file"; then
    pass "$unsupported_model fails closed with Codex/ChatGPT diagnostic"
  else
    fail "$unsupported_model fails closed with Codex/ChatGPT diagnostic" "stdout=$(cat "$stdout_file"), stderr=$(cat "$stderr_file")"
  fi
  rm -f "$stdout_file" "$stderr_file"
done

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "claude-sonnet-5" "coding"; then
  if [[ "$(tr -d '\n' < "$stdout_file")" == "claude" ]]; then
    pass "claude-sonnet-5 coding resolves to claude"
  else
    fail "claude-sonnet-5 coding resolves to claude" "got: $(cat "$stdout_file")"
  fi
else
  fail "claude-sonnet-5 coding resolves to claude" "$(cat "$stderr_file")"
fi
rm -f "$stdout_file" "$stderr_file"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "gpt-5.6-terra" "review"; then
  if [[ "$(tr -d '\n' < "$stdout_file")" == "codex" ]]; then
    pass "gpt-5.6-terra review resolves to codex"
  else
    fail "gpt-5.6-terra review resolves to codex" "got: $(cat "$stdout_file")"
  fi
else
  fail "gpt-5.6-terra review resolves to codex" "$(cat "$stderr_file")"
fi
rm -f "$stdout_file" "$stderr_file"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if (
  export AGENT_CMD="codex"
  run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "gpt-5.6-sol" "planning"
); then
  fail "AGENT_CMD does not override native-openai failure" "expected non-zero exit"
else
  if [[ ! -s "$stdout_file" ]]; then
    pass "AGENT_CMD does not override native-openai failure"
  else
    fail "AGENT_CMD does not override native-openai failure" "got: $(cat "$stdout_file")"
  fi
fi
rm -f "$stdout_file" "$stderr_file"

stub_dir="$(mktemp -d)"
cat > "$stub_dir/jq" <<'EOF'
#!/usr/bin/env bash
exit 127
EOF
chmod +x "$stub_dir/jq"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if (
  export PATH="$stub_dir:$PATH"
  run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "claude-sonnet-5" "coding"
); then
  fail "jq failure should fail closed" "expected non-zero exit"
else
  if [[ ! -s "$stdout_file" ]]; then
    pass "jq failure keeps stdout empty"
  else
    fail "jq failure keeps stdout empty" "got: $(cat "$stdout_file")"
  fi
fi
rm -f "$stdout_file" "$stderr_file"
rm -rf "$stub_dir"

stub_dir="$(mktemp -d)"
cat > "$stub_dir/node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "--import" && "${2:-}" == "tsx" && "${3:-}" == "-e" ]]; then
  exit 0
fi
printf 'not-json\n'
exit 0
EOF
chmod +x "$stub_dir/node"
cat > "$stub_dir/tsx" <<'EOF'
#!/usr/bin/env bash
printf 'not-json\n'
exit 0
EOF
chmod +x "$stub_dir/tsx"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if (
  export PATH="$stub_dir:$PATH"
  run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "claude-sonnet-5" "coding"
); then
  fail "malformed resolver JSON should fail closed" "expected non-zero exit"
else
  if [[ ! -s "$stdout_file" ]]; then
    pass "malformed resolver JSON keeps stdout empty"
  else
    fail "malformed resolver JSON keeps stdout empty" "got: $(cat "$stdout_file")"
  fi
fi
rm -f "$stdout_file" "$stderr_file"
rm -rf "$stub_dir"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if run_snippet "$stdout_file" "$stderr_file" '
  agent_resolve_models_for_roles "claude-sonnet-5" "gpt-5.6-terra" "gpt-5.6-sol"
  rc=$?
  printf "planner=%s\n" "$(agent_resolve_batch_agent_for_role planner)"
  printf "coder=%s\n" "$(agent_resolve_batch_agent_for_role coder)"
  printf "reviewer=%s\n" "$(agent_resolve_batch_agent_for_role reviewer)"
  exit "$rc"
'; then
  fail "batch resolution should fail when one role is unroutable" "expected non-zero exit"
else
  if grep -q '^planner=claude$' "$stdout_file" && grep -q '^coder=codex$' "$stdout_file" && grep -q '^reviewer=$' "$stdout_file"; then
    pass "batch resolution preserves successful role agents"
  else
    fail "batch resolution preserves successful role agents" "got: $(cat "$stdout_file")"
  fi
  if grep -q '\[agent-resolution\].*gpt-5.6-sol.*phase=review' "$stderr_file"; then
    pass "batch resolution emits per-role diagnostic"
  else
    fail "batch resolution emits per-role diagnostic" "$(cat "$stderr_file")"
  fi
fi
rm -f "$stdout_file" "$stderr_file"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
