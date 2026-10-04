#!/usr/bin/env bash
set -euo pipefail

# Shard-surface contract test for the sharded runners.
#
# Covers tests/run-custom-tests.sh and tests/run-unit-tests.sh (weighted
# partitioning, HOK-2939) plus tests/run-shell-suite.sh (round-robin, HOK-3043),
# all at the shard counts configured in .github/workflows/ci.yml. Asserts:
#   - the union of every shard's --list output is exactly the full registered
#     list (every test exactly once, no duplicates, nothing dropped);
#   - out-of-range and malformed --shard values are rejected;
#   - repeated invocations produce byte-identical output (determinism at the
#     bash surface).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/run-custom-tests-shard.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# Read the configured shard count for a matrix job from ci.yml so this test
# can never disagree with the real matrix.
shard_count_for_job() {
  local job="$1"
  awk -v job="  ${job}:" '
    $0 == job { in_job = 1; next }
    in_job && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_job = 0 }
    in_job && /^[[:space:]]*shard:[[:space:]]*\[/ {
      n = split($0, parts, ",")
      print n
      exit
    }
  ' "$REPO_DIR/.github/workflows/ci.yml"
}

check_runner() {
  local runner="$1" job="$2" shards
  shards="$(shard_count_for_job "$job")"
  if [[ -z "$shards" || "$shards" -lt 2 ]]; then
    fail "$runner: could not read shard count for ci.yml job '$job' (got '${shards:-}')"
    return
  fi

  local full="$WORK/${job}-full.txt" union="$WORK/${job}-union.txt"
  if ! bash "$REPO_DIR/tests/$runner" --list > "$full"; then
    fail "$runner: full --list failed"
    return
  fi

  : > "$union"
  local s
  for s in $(seq 1 "$shards"); do
    if ! bash "$REPO_DIR/tests/$runner" --shard "$s/$shards" --list >> "$union"; then
      fail "$runner: --shard $s/$shards --list failed"
      return
    fi
  done

  if [[ "$(sort "$union" | uniq -d | wc -l | tr -d ' ')" != "0" ]]; then
    fail "$runner: duplicate assignments across $shards shards"
  elif diff <(sort "$full") <(sort "$union") > /dev/null; then
    pass "$runner: union of $shards shard lists equals the full list exactly once"
  else
    fail "$runner: union of shard lists differs from the full list"
  fi

  # Determinism at the bash surface: identical invocations, identical bytes.
  local first="$WORK/${job}-det-1.txt" second="$WORK/${job}-det-2.txt"
  bash "$REPO_DIR/tests/$runner" --shard "2/$shards" --list > "$first"
  bash "$REPO_DIR/tests/$runner" --shard "2/$shards" --list > "$second"
  if cmp -s "$first" "$second"; then
    pass "$runner: --shard 2/$shards --list is deterministic"
  else
    fail "$runner: --shard 2/$shards --list differs between invocations"
  fi

  # Invalid shard specs are rejected with exit 2.
  local spec rc
  for spec in "0/$shards" "$((shards + 6))/$shards" "abc" "1/"; do
    rc=0
    bash "$REPO_DIR/tests/$runner" --shard "$spec" --list > /dev/null 2>&1 || rc=$?
    if [[ "$rc" == "2" ]]; then
      pass "$runner: rejects --shard $spec"
    else
      fail "$runner: --shard $spec exited $rc (expected 2)"
    fi
  done
}

cd "$REPO_DIR"
check_runner run-custom-tests.sh custom
check_runner run-unit-tests.sh unit
check_runner run-shell-suite.sh shell

echo ""
echo "--- run-custom-tests-shard: $PASS passed, $FAIL failed ---"
(( FAIL == 0 )) || exit 1
