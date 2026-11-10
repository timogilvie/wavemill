#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_DIR/shared/lib/wavemill-common.sh"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

assert_eq() {
  local expected="$1" actual="$2" message="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $message (expected '$expected', got '$actual')" >&2
    exit 1
  fi
}

state_file="$TEST_DIR/state.json"
printf '{"counter":0,"tasks":{"HOK-1":{"phase":"planning"}}}\n' > "$state_file"

state_mutate "$state_file" '.counter = 1 | .tasks["HOK-1"].phase = "coding"'
assert_eq "1" "$(jq -r '.counter' "$state_file")" "single writer updates counter"
assert_eq "coding" "$(jq -r '.tasks["HOK-1"].phase' "$state_file")" "single writer updates nested state"

if state_mutate "$TEST_DIR/missing.json" '.counter = 1' 2>"$TEST_DIR/missing.err"; then
  echo "FAIL: missing state file should fail" >&2
  exit 1
fi
if ! grep -q 'state file not found' "$TEST_DIR/missing.err"; then
  echo "FAIL: missing state file error did not mention missing file" >&2
  exit 1
fi

printf '{"counter":0}\n' > "$state_file"
for _ in $(seq 1 20); do
  state_mutate "$state_file" '.counter += 1' &
done
wait
assert_eq "20" "$(jq -r '.counter' "$state_file")" "concurrent increments are serialized"

mkdir "$state_file.lock"
if STATE_MUTATE_MAX_RETRIES=2 STATE_MUTATE_SLEEP_SECONDS=0.01 \
  state_mutate "$state_file" '.counter += 1' 2>"$TEST_DIR/lock.err"; then
  echo "FAIL: held lock should time out" >&2
  exit 1
fi
rmdir "$state_file.lock"
if ! grep -q 'lock timeout' "$TEST_DIR/lock.err"; then
  echo "FAIL: timeout error did not mention lock timeout" >&2
  exit 1
fi

echo "state-mutex shell tests passed"
