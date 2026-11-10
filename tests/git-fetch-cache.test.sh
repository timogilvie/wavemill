#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STATE_FILE="$TMP/workflow-state.json"
FETCH_COUNT_FILE="$TMP/fetch-count.txt"
FETCH_ARGS_FILE="$TMP/fetch-args.txt"
BIN_DIR="$TMP/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/git" <<'EOF'
#!/bin/bash
set -euo pipefail
if [[ "${GIT_STUB_FAIL:-0}" == "1" ]]; then
  exit 1
fi
count=0
if [[ -f "${FETCH_COUNT_FILE:?}" ]]; then
  count=$(cat "$FETCH_COUNT_FILE")
fi
printf '%s\n' $((count + 1)) > "$FETCH_COUNT_FILE"
printf '%s\n' "$*" >> "${FETCH_ARGS_FILE:?}"
if [[ -n "${GIT_STUB_CHILD_PID_FILE:-}" ]]; then
  sleep "${GIT_STUB_CHILD_SLEEP_SECONDS:-30}" &
  child_pid=$!
  printf '%s\n' "$child_pid" > "$GIT_STUB_CHILD_PID_FILE"
  wait "$child_pid"
  exit 0
fi
if [[ -n "${GIT_STUB_SLEEP_SECONDS:-}" ]]; then
  sleep "$GIT_STUB_SLEEP_SECONDS"
fi
EOF
chmod +x "$BIN_DIR/git"

export PATH="$BIN_DIR:$PATH"
export REPO_DIR="$TMP/repo"
export STATE_FILE
export FETCH_COUNT_FILE
export FETCH_ARGS_FILE
export GIT_FETCH_TTL_SECONDS=60
mkdir -p "$REPO_DIR"

source "$COMMON"

echo '{"session":"test","tasks":{}}' > "$STATE_FILE"

echo "=== Fetch Cache Behavior ==="

wavemill_fetch_base_branch "main"
if [[ "$(cat "$FETCH_COUNT_FILE")" == "1" ]]; then
  pass "initial fetch hits git"
else
  fail "initial fetch did not hit git exactly once"
fi

initial_fetch_at="$(jq -r '.baseBranchFetchCache.main.last_fetch_at // empty' "$STATE_FILE")"
if [[ "$initial_fetch_at" =~ ^[0-9]+$ ]]; then
  pass "initial fetch stores last_fetch_at"
else
  fail "initial fetch did not store last_fetch_at"
fi

wavemill_fetch_base_branch "main"
if [[ "$(cat "$FETCH_COUNT_FILE")" == "1" ]]; then
  pass "second fetch within TTL is skipped"
else
  fail "second fetch within TTL should have been skipped"
fi

wavemill_fetch_base_branch "main" --force
if [[ "$(cat "$FETCH_COUNT_FILE")" == "2" ]]; then
  pass "forced fetch bypasses cache"
else
  fail "forced fetch did not bypass cache"
fi

GIT_FETCH_TTL_SECONDS=0 wavemill_fetch_base_branch "main"
if [[ "$(cat "$FETCH_COUNT_FILE")" == "3" ]]; then
  pass "TTL 0 always fetches"
else
  fail "TTL 0 did not force a fetch"
fi

wavemill_fetch_base_branch "develop"
if [[ "$(cat "$FETCH_COUNT_FILE")" == "4" ]]; then
  pass "cache is tracked per branch"
else
  fail "branch-specific cache key did not trigger a new fetch"
fi

echo '{"session":"test","tasks":{}}' > "$STATE_FILE"
export GIT_STUB_FAIL=1
if wavemill_fetch_base_branch "main"; then
  fail "failed fetch should return non-zero"
else
  pass "failed fetch returns non-zero"
fi
unset GIT_STUB_FAIL

failed_fetch_at="$(jq -r '.baseBranchFetchCache.main.last_fetch_at // empty' "$STATE_FILE")"
if [[ -z "$failed_fetch_at" ]]; then
  pass "failed fetch does not update cache state"
else
  fail "failed fetch updated cache state"
fi

unset GIT_STUB_FAIL
echo '{"session":"test","tasks":{}}' > "$STATE_FILE"
start_time="$(date +%s)"
timeout_rc=0
if GIT_STUB_SLEEP_SECONDS=5 WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS=1 wavemill_fetch_base_branch "timeout-branch"; then
  fail "timed out fetch should return non-zero"
else
  timeout_rc=$?
fi
elapsed_seconds=$(( $(date +%s) - start_time ))
if [[ "$timeout_rc" -eq 124 ]]; then
  pass "timed out fetch returns exit 124"
else
  fail "timed out fetch returned exit $timeout_rc instead of 124"
fi
if (( elapsed_seconds < 5 )); then
  pass "timed out fetch returns promptly"
else
  fail "timed out fetch took too long ($elapsed_seconds seconds)"
fi
timed_out_fetch_at="$(jq -r '.baseBranchFetchCache["timeout-branch"].last_fetch_at // empty' "$STATE_FILE")"
if [[ -z "$timed_out_fetch_at" ]]; then
  pass "timed out fetch does not update cache state"
else
  fail "timed out fetch updated cache state"
fi

child_pid_file="$TMP/child.pid"
child_timeout_rc=0
if GIT_STUB_CHILD_PID_FILE="$child_pid_file" GIT_STUB_CHILD_SLEEP_SECONDS=30 WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS=1 wavemill_fetch_base_branch "child-timeout"; then
  fail "child timeout fetch should return non-zero"
else
  child_timeout_rc=$?
fi
if [[ "$child_timeout_rc" -eq 124 ]]; then
  pass "timed out child fetch returns exit 124"
else
  fail "timed out child fetch returned exit $child_timeout_rc instead of 124"
fi
child_pid="$(cat "$child_pid_file" 2>/dev/null || echo "")"
sleep 1
if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
  fail "timed out fetch left child process running ($child_pid)"
  kill -KILL "$child_pid" 2>/dev/null || true
else
  pass "timed out fetch cleans up child process"
fi

unset WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS
if [[ "$(wavemill_git_remote_timeout_seconds)" == "15" ]]; then
  pass "missing remote timeout env uses default"
else
  fail "missing remote timeout env did not use default"
fi
WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS=bogus
if [[ "$(wavemill_git_remote_timeout_seconds)" == "15" ]]; then
  pass "invalid remote timeout env uses default"
else
  fail "invalid remote timeout env did not use default"
fi
WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS=600
if [[ "$(wavemill_git_remote_timeout_seconds)" == "600" ]]; then
  pass "valid remote timeout env is preserved"
else
  fail "valid remote timeout env was not preserved"
fi
unset WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
