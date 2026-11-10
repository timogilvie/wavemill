#!/usr/bin/env bash
set -euo pipefail

# Runner for test files that use custom assert/test harnesses.
# These files use process.exit(1) on failure, so we just check exit codes.
#
# Usage:
#   bash tests/run-custom-tests.sh                    # run every test
#   bash tests/run-custom-tests.sh --shard 2/3        # run shard 2 of 3
#   bash tests/run-custom-tests.sh --list             # print selected tests and exit
#   bash tests/run-custom-tests.sh --timing-out FILE  # also write per-test timing JSON
#
# Sharding uses the deterministic weighted partitioner
# (tools/partition-tests.ts + tests/ci-test-weights.json) so shard runtimes
# stay balanced. --shard 1/1 (the default) short-circuits to the full list and
# never invokes the partitioner.
#
# Timing output (--timing-out or TIMING_OUTPUT env) is a single bounded JSON
# document: one entry per executed test with id, elapsed ms, and result. It
# contains only test ids, durations, and results -- never environment content.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Try local tsx first, fall back to global
TSX_LOADER="$(npm root)/tsx/dist/loader.mjs"
if [[ ! -f "$TSX_LOADER" ]]; then
  TSX_LOADER="$(npm root -g)/tsx/dist/loader.mjs"
fi

# Suite membership is discovered, never listed (HOK-3466): see
# shared/lib/test-discovery.ts for the pattern and marker rules. A discovery
# failure must fail the run loudly rather than run a partial suite.
if ! DISCOVERED="$(cd "$REPO_DIR" && node tools/discover-tests.ts --suite custom)"; then
  echo "run-custom-tests.sh: test discovery failed" >&2
  exit 2
fi
ALL_TESTS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && ALL_TESTS+=("$line")
done <<< "$DISCOVERED"

SHARD_INDEX=1
SHARD_TOTAL=1
LIST_ONLY=0
TIMING_OUT="${TIMING_OUTPUT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shard)
      if [[ ! "${2:-}" =~ ^[0-9]+/[0-9]+$ ]]; then
        echo "run-custom-tests.sh: --shard requires INDEX/TOTAL (e.g. 2/3)" >&2
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
        echo "run-custom-tests.sh: --timing-out requires a file path" >&2
        exit 2
      fi
      TIMING_OUT="$2"
      shift 2
      ;;
    *)
      echo "run-custom-tests.sh: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

if (( SHARD_TOTAL < 1 || SHARD_INDEX < 1 || SHARD_INDEX > SHARD_TOTAL )); then
  echo "run-custom-tests.sh: invalid shard ${SHARD_INDEX}/${SHARD_TOTAL}" >&2
  exit 2
fi

if (( SHARD_TOTAL == 1 )); then
  SELECTED=("${ALL_TESTS[@]}")
else
  # Deterministic weighted partitioning. A partitioner failure must fail the
  # shard loudly: a silent fallback could drop or duplicate tests across the
  # matrix if one leg fell back while others did not.
  if ! SELECTION="$(
    printf '%s\n' "${ALL_TESTS[@]}" |
      node "$REPO_DIR/tools/partition-tests.ts" --suite custom --shard "${SHARD_INDEX}/${SHARD_TOTAL}"
  )"; then
    echo "run-custom-tests.sh: partitioner failed for shard ${SHARD_INDEX}/${SHARD_TOTAL}" >&2
    exit 2
  fi
  SELECTED=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && SELECTED+=("$line")
  done <<< "$SELECTION"
fi

# A shard with no work is a configuration error, not a silent pass.
if (( ${#SELECTED[@]} == 0 )); then
  echo "run-custom-tests.sh: shard ${SHARD_INDEX}/${SHARD_TOTAL} selected no tests" >&2
  exit 2
fi

if (( LIST_ONLY == 1 )); then
  printf '%s\n' "${SELECTED[@]}"
  exit 0
fi

if [[ ! -f "$TSX_LOADER" ]]; then
  echo "tsx loader not found at: $TSX_LOADER" >&2
  echo "Install tsx: npm install --save-dev tsx" >&2
  exit 1
fi

# Millisecond wall clock, portable across macOS (bash 3.2, no date +%s%3N) and
# Linux. perl with Time::HiRes ships on both; node is the fallback.
now_ms() {
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf("%d", time()*1000)'
  else
    node -e 'process.stdout.write(String(Date.now()))'
  fi
}

# HOK-3157: snapshot the tracked-file state before running tests. The guard
# below compares a post-run snapshot and fails if any tracked file was left
# modified. Untracked artifacts are ignored.
# shellcheck source=lib/tracked-tree-guard.sh
source "$SCRIPT_DIR/lib/tracked-tree-guard.sh"
TREE_BEFORE="$(tracked_tree_snapshot "$REPO_DIR")"

PASS=0
FAIL=0
TIMING_ENTRIES=()

record_timing() {
  local id="$1" elapsed="$2" result="$3"
  TIMING_ENTRIES+=("{\"id\":\"${id}\",\"elapsedMs\":${elapsed},\"result\":\"${result}\"}")
}

run_one() {
  local f="$1" kind="$2" start end elapsed result
  echo -n "  $f: "
  start="$(now_ms)"
  if [[ "$kind" == "ts" ]]; then
    if node --import "$TSX_LOADER" "$REPO_DIR/$f" > /dev/null 2>&1; then
      result=pass
    else
      result=fail
    fi
  else
    if bash "$REPO_DIR/$f" > /dev/null 2>&1; then
      result=pass
    else
      result=fail
    fi
  fi
  end="$(now_ms)"
  elapsed=$((end - start))
  if [[ "$result" == "pass" ]]; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    FAIL=$((FAIL + 1))
  fi
  record_timing "$f" "$elapsed" "$result"
}

if (( SHARD_TOTAL > 1 )); then
  echo "=== Custom harness shard ${SHARD_INDEX}/${SHARD_TOTAL} (${#SELECTED[@]} of ${#ALL_TESTS[@]} tests) ==="
fi

for f in "${SELECTED[@]}"; do
  case "$f" in
    *.sh) run_one "$f" sh ;;
    *)    run_one "$f" ts ;;
  esac
done

if [[ -n "$TIMING_OUT" ]]; then
  # Bounded machine-readable timing document: one entry per executed test.
  # Written atomically (tmp + mv) so a partial file is never observed.
  generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  run_id="${GITHUB_RUN_ID:-local}"
  sha="${GITHUB_SHA:-local}"
  tmp="${TIMING_OUT}.tmp.$$"
  {
    printf '{"suite":"custom","shard":"%s/%s","runId":"%s","sha":"%s","generatedAt":"%s","tests":[' \
      "$SHARD_INDEX" "$SHARD_TOTAL" "$run_id" "$sha" "$generated_at"
    sep=""
    for entry in "${TIMING_ENTRIES[@]}"; do
      printf '%s%s' "$sep" "$entry"
      sep=","
    done
    printf ']}\n'
  } > "$tmp"
  mv "$tmp" "$TIMING_OUT"
  echo "timing written: $TIMING_OUT"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

GUARD_RC=0
if ! tracked_tree_check "$REPO_DIR" "$TREE_BEFORE" run-custom-tests.sh; then
  GUARD_RC=1
fi

if (( FAIL > 0 || GUARD_RC != 0 )); then
  exit 1
fi
