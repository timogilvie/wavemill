#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXPAND_SCRIPT="$REPO_DIR/shared/lib/wavemill-expand.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

make_fake_npx() {
  local bin_dir="$1"
  cat > "$bin_dir/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

log_file="${FAKE_NPX_LOG:?}"
echo "$*" >> "$log_file"

if [[ "${1:-}" != "tsx" ]]; then
  echo "unexpected npx invocation: $*" >&2
  exit 1
fi

tool="${2:-}"
shift 2

case "$(basename "$tool")" in
  list-backlog-json.ts)
    if [[ -n "${FAKE_BACKLOG_FAIL:-}" ]]; then
      echo "backlog should not have been fetched" >&2
      exit 99
    fi
    printf '%s\n' "${FAKE_BACKLOG_JSON:-[]}"
    ;;
  expand-issue.ts)
    issue="${1:-}"
    if [[ "${FAKE_EXPAND_FAIL_ISSUE:-}" == "$issue" ]]; then
      echo "simulated expansion failure for $issue" >&2
      exit 23
    fi
    printf 'expanded %s\n' "$issue"
    ;;
  *)
    echo "unexpected tool: $(basename "$tool")" >&2
    exit 98
    ;;
esac
EOF
  chmod +x "$bin_dir/npx"
}

setup_case() {
  local case_dir="$1"
  mkdir -p "$case_dir/repo/.git" "$case_dir/tools" "$case_dir/bin"
  : > "$case_dir/npx.log"
  touch "$case_dir/tools/expand-issue.ts" "$case_dir/tools/list-backlog-json.ts"
  make_fake_npx "$case_dir/bin"
}

run_expand() {
  local case_dir="$1"
  shift
  local stdout_file="$case_dir/stdout"
  local stderr_file="$case_dir/stderr"
  local status=0
  local env_args=()
  local cli_args=()

  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--" ]]; then
      shift
      cli_args=("$@")
      break
    fi
    env_args+=("$1")
    shift
  done

  set +e
  env \
    PATH="$case_dir/bin:$PATH" \
    REPO_DIR="$case_dir/repo" \
    TOOLS_DIR="$case_dir/tools" \
    PROJECT_NAME="wavemill" \
    MAX_SELECT=3 \
    MAX_DISPLAY=9 \
    FAKE_NPX_LOG="$case_dir/npx.log" \
    "${env_args[@]}" \
    bash "$EXPAND_SCRIPT" "${cli_args[@]}" >"$stdout_file" 2>"$stderr_file"
  status=$?
  set -e

  printf '%s\n' "$status" > "$case_dir/status"
}

test_direct_single_issue_skips_backlog() {
  local case_dir="$TEST_TMP/direct-single"
  setup_case "$case_dir"

  run_expand "$case_dir" FAKE_BACKLOG_FAIL=1 -- HOK-1494

  check_eq "single issue exits 0" "0" "$(cat "$case_dir/status")"
  check_contains "single issue logs direct mode" "$(cat "$case_dir/stdout")" "Direct issue expansion: HOK-1494"
  check_not_contains "single issue skips backlog output" "$(cat "$case_dir/stdout")" "Fetching backlog from Linear..."
  check_eq "single issue expands once" "tsx $case_dir/tools/expand-issue.ts HOK-1494 --output /tmp/issue-expander-HOK-1494.md" "$(cat "$case_dir/npx.log")"
}

test_direct_lowercase_and_url_inputs_canonicalize() {
  local case_dir="$TEST_TMP/direct-canonicalize"
  setup_case "$case_dir"

  run_expand "$case_dir" -- hok-1494 "https://linear.app/hokusai/issue/HOK-1531/fix" ab2-1

  check_eq "canonicalized inputs exit 0" "0" "$(cat "$case_dir/status")"
  check_contains "canonicalized direct calls include first issue" "$(cat "$case_dir/npx.log")" "tsx $case_dir/tools/expand-issue.ts HOK-1494 --output /tmp/issue-expander-HOK-1494.md"
  check_contains "canonicalized direct calls include second issue" "$(cat "$case_dir/npx.log")" "tsx $case_dir/tools/expand-issue.ts HOK-1531 --output /tmp/issue-expander-HOK-1531.md"
  check_contains "canonicalized direct calls include digit-bearing team key" "$(cat "$case_dir/npx.log")" "tsx $case_dir/tools/expand-issue.ts AB2-1 --output /tmp/issue-expander-AB2-1.md"
}

test_direct_invalid_input_fails_before_expansion() {
  local case_dir="$TEST_TMP/direct-invalid"
  setup_case "$case_dir"

  run_expand "$case_dir" FAKE_BACKLOG_FAIL=1 -- HOK-1494 FOOBAR

  check_eq "invalid input exits non-zero" "1" "$(cat "$case_dir/status")"
  check_contains "invalid input names token" "$(cat "$case_dir/stderr")" "FOOBAR"
  check_contains "invalid input shows format hint" "$(cat "$case_dir/stderr")" "TEAM-123 or a Linear issue URL"
  check_eq "invalid input never invokes npx" "" "$(cat "$case_dir/npx.log")"
}

test_direct_failure_returns_nonzero_after_processing_batch() {
  local case_dir="$TEST_TMP/direct-failure"
  setup_case "$case_dir"

  run_expand "$case_dir" FAKE_EXPAND_FAIL_ISSUE=HOK-1531 -- HOK-1494 HOK-1531

  check_eq "batch failure exits non-zero" "1" "$(cat "$case_dir/status")"
  check_contains "batch failure still processes first issue" "$(cat "$case_dir/npx.log")" "tsx $case_dir/tools/expand-issue.ts HOK-1494 --output /tmp/issue-expander-HOK-1494.md"
  check_contains "batch failure still processes second issue" "$(cat "$case_dir/npx.log")" "tsx $case_dir/tools/expand-issue.ts HOK-1531 --output /tmp/issue-expander-HOK-1531.md"
  check_contains "batch failure mentions failed issue" "$(cat "$case_dir/stderr")" "HOK-1531"
  check_contains "batch failure reports summary" "$(cat "$case_dir/stdout")" "Failed: 1"
}

test_no_arg_mode_still_fetches_backlog_and_prompts() {
  local case_dir="$TEST_TMP/no-arg"
  setup_case "$case_dir"
  local status=0

  set +e
  printf '\n' | env \
    PATH="$case_dir/bin:$PATH" \
    REPO_DIR="$case_dir/repo" \
    TOOLS_DIR="$case_dir/tools" \
    PROJECT_NAME="wavemill" \
    MAX_SELECT=3 \
    MAX_DISPLAY=9 \
    FAKE_NPX_LOG="$case_dir/npx.log" \
    FAKE_BACKLOG_JSON='[{"identifier":"HOK-1494","title":"Fix direct expand","url":"https://linear.app/hokusai/issue/HOK-1494/fix-direct-expand","priority":2,"estimate":3,"state":{"name":"Todo"},"description":"Short description","labels":{"nodes":[]},"relations":{"nodes":[]},"inverseRelations":{"nodes":[]},"labels":{"nodes":[]},"project":{"name":"wavemill"},"team":{"name":"Hokusai","key":"HOK"},"parent":null,"children":{"nodes":[]}}]' \
    bash "$EXPAND_SCRIPT" >"$case_dir/stdout" 2>"$case_dir/stderr"
  status=$?
  set -e

  printf '%s\n' "$status" > "$case_dir/status"

  check_contains "no-arg mode fetches backlog" "$(cat "$case_dir/stdout")" "Fetching backlog from Linear..."
  check_contains "no-arg mode analyzes backlog" "$(cat "$case_dir/stdout")" "Analyzing issues and ranking by priority..."
  check_contains "no-arg mode prompts for selection" "$(cat "$case_dir/stdout")" "Enter up to 3 numbers to expand"
  check_contains "no-arg mode invokes backlog tool" "$(cat "$case_dir/npx.log")" "list-backlog-json.ts"
  check_not_contains "no-arg mode does not expand on empty selection" "$(cat "$case_dir/npx.log")" "expand-issue.ts"
}

echo "=== wavemill expand direct mode ==="
test_direct_single_issue_skips_backlog
test_direct_lowercase_and_url_inputs_canonicalize
test_direct_invalid_input_fails_before_expansion
test_direct_failure_returns_nonzero_after_processing_batch
test_no_arg_mode_still_fetches_backlog_and_prompts

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
