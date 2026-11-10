#!/usr/bin/env bash
set -euo pipefail

# Runner for the node:test unit suite (previously a ~190-file list inlined in
# package.json). Supports sharding so CI can spread it across parallel jobs.
#
# Usage:
#   bash tests/run-unit-tests.sh                    # run every test
#   bash tests/run-unit-tests.sh --shard 2/7        # run shard 2 of 7
#   bash tests/run-unit-tests.sh --list             # print selected tests and exit
#   bash tests/run-unit-tests.sh --timing-out FILE  # also write per-file timing JSON
#
# Shards are assigned by the deterministic weighted partitioner
# (tools/partition-tests.ts + tests/ci-test-weights.json): cost is heavily
# skewed toward a few subprocess-spawning files, so weighted assignment keeps
# shard runtimes balanced where round-robin could not. --shard 1/1 (the
# default) short-circuits to the full list without invoking the partitioner.
#
# Each shard hands its whole subset to a single 'node --test' invocation, which
# parallelizes across cores internally; sharding adds a second level on top by
# giving each shard its own runner.
#
# Timing output (--timing-out or TIMING_OUTPUT env) is a single bounded JSON
# document produced by tests/lib/unit-timing-reporter.mjs: one entry per test
# file with id, elapsed ms, and result. It contains only test ids, durations,
# and results -- never environment content.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Suite membership is discovered, never listed (HOK-3466): see
# shared/lib/test-discovery.ts for the pattern and marker rules. A discovery
# failure must fail the run loudly rather than run a partial suite.
if ! DISCOVERED="$(cd "$REPO_DIR" && node tools/discover-tests.ts --suite unit)"; then
  echo "run-unit-tests.sh: test discovery failed" >&2
  exit 2
fi
TESTS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && TESTS+=("$line")
done <<< "$DISCOVERED"

SHARD_INDEX=1
SHARD_TOTAL=1
LIST_ONLY=0
TIMING_OUT="${TIMING_OUTPUT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shard)
      if [[ ! "${2:-}" =~ ^[0-9]+/[0-9]+$ ]]; then
        echo "run-unit-tests.sh: --shard requires INDEX/TOTAL (e.g. 2/5)" >&2
        exit 2
      fi
      SHARD_INDEX="${2%%/*}"
      SHARD_TOTAL="${2##*/}"
      shift 2
      ;;
    --list)
      LIST_ONLY=1
      shift
      ;;
    --timing-out)
      if [[ -z "${2:-}" ]]; then
        echo "run-unit-tests.sh: --timing-out requires a file path" >&2
        exit 2
      fi
      TIMING_OUT="$2"
      shift 2
      ;;
    *)
      echo "run-unit-tests.sh: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

if (( SHARD_TOTAL < 1 || SHARD_INDEX < 1 || SHARD_INDEX > SHARD_TOTAL )); then
  echo "run-unit-tests.sh: invalid shard ${SHARD_INDEX}/${SHARD_TOTAL}" >&2
  exit 2
fi

if (( SHARD_TOTAL == 1 )); then
  SELECTED=("${TESTS[@]}")
else
  # Deterministic weighted partitioning. A partitioner failure must fail the
  # shard loudly: a silent fallback could drop or duplicate tests across the
  # matrix if one leg fell back while others did not.
  if ! SELECTION="$(
    printf '%s\n' "${TESTS[@]}" |
      node "$REPO_DIR/tools/partition-tests.ts" --suite unit --shard "${SHARD_INDEX}/${SHARD_TOTAL}"
  )"; then
    echo "run-unit-tests.sh: partitioner failed for shard ${SHARD_INDEX}/${SHARD_TOTAL}" >&2
    exit 2
  fi
  SELECTED=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && SELECTED+=("$line")
  done <<< "$SELECTION"
fi

# A shard with no work is a configuration error, not a silent pass.
if (( ${#SELECTED[@]} == 0 )); then
  echo "run-unit-tests.sh: shard ${SHARD_INDEX}/${SHARD_TOTAL} selected no tests" >&2
  exit 2
fi

if (( LIST_ONLY == 1 )); then
  printf '%s\n' "${SELECTED[@]}"
  exit 0
fi

# This check is a real safety net: node --test only exits non-zero on a
# missing path when it is the sole argument -- alongside other existing paths
# it silently ignores the missing one (verified on Node 22).
missing=0
for f in "${SELECTED[@]}"; do
  if [[ ! -f "$REPO_DIR/$f" ]]; then
    echo "run-unit-tests.sh: missing test file $f" >&2
    missing=1
  fi
done
if (( missing == 1 )); then
  exit 1
fi

if (( SHARD_TOTAL > 1 )); then
  echo "=== Unit tests shard ${SHARD_INDEX}/${SHARD_TOTAL} (${#SELECTED[@]} of ${#TESTS[@]} files) ==="
else
  echo "=== Unit tests (${#TESTS[@]} files) ==="
fi

cd "$REPO_DIR"

# HOK-3157: snapshot the tracked-file state before running tests. The guard
# below compares a post-run snapshot and fails if any tracked file was left
# modified. Untracked artifacts (CI timing JSON, etc.) are ignored. We drop
# `exec` so node --test runs as a child and this script can run the check
# after it exits.
# shellcheck source=lib/tracked-tree-guard.sh
source "$SCRIPT_DIR/lib/tracked-tree-guard.sh"
TREE_BEFORE="$(tracked_tree_snapshot "$REPO_DIR")"

status=0
if [[ -n "$TIMING_OUT" ]]; then
  # Second reporter writes the bounded per-file timing JSON to $TIMING_OUT
  # while the spec reporter keeps human-readable output on stdout. The shard
  # label reaches the reporter through the environment.
  export WAVEMILL_TIMING_SHARD="${SHARD_INDEX}/${SHARD_TOTAL}"
  # --test-timeout: bound any single test at 5 minutes so a hung child or
  # never-resolving await cannot burn the shard's whole 20-minute CI budget.
  # Route-tasks's slowest subtest runs ~14s and tend-scratch-prep's process-
  # group tests carry explicit 15s timeouts, so 300000ms is a wide safety net.
  # Without this, shard 7 was hanging in CI for the full 20m timeout when a
  # tend-scratch-prep child kept a stdio pipe alive; --test-force-exit hid
  # that at the cost of racing subprocess-spawning shards to exit, which
  # then stalled shard 3 for its full 20m — see HOK-3039.
  node --test --test-timeout=300000 \
    --test-reporter spec --test-reporter-destination stdout \
    --test-reporter "$REPO_DIR/tests/lib/unit-timing-reporter.mjs" \
    --test-reporter-destination "$TIMING_OUT" \
    "${SELECTED[@]}" || status=$?
else
  node --test --test-timeout=300000 "${SELECTED[@]}" || status=$?
fi

# Only promote a passing status to failure on guard failure; preserve a
# non-zero node --test exit code either way.
if ! tracked_tree_check "$REPO_DIR" "$TREE_BEFORE" run-unit-tests.sh; then
  if (( status == 0 )); then
    status=1
  fi
fi

exit "$status"
