#!/usr/bin/env bash
set -euo pipefail

# Runner for the bash test suite (previously an inline && chain in package.json).
# Supports sharding so CI can run the suite across parallel jobs.
#
# Usage:
#   bash tests/run-shell-suite.sh                 # run every test
#   bash tests/run-shell-suite.sh --shard 2/3     # run shard 2 of 3
#   bash tests/run-shell-suite.sh --list          # print selected tests and exit
#   bash tests/run-shell-suite.sh --timing-out FILE  # also write per-test timing JSON
#
# Sharding uses the deterministic weighted partitioner
# (tools/partition-tests.ts + tests/ci-test-weights.json, suite "shell") so
# shard runtimes stay balanced; round-robin left one shard at ~2.5x the
# others (HOK-3233). An unsharded run (the default) never invokes the
# partitioner.
#
# Timing output (--timing-out or TIMING_OUTPUT env) is a single bounded JSON
# document: one entry per executed test with id, elapsed ms, and result. It
# contains only test ids, durations, and results -- never environment content.
#
# Fails fast on the first failing test, matching the previous && chain.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Note: tests/check-shell.sh is not part of this suite. It is a lint/syntax pass
# over every shell script, not a per-shard test, and runs once via `npm run lint`.
# Suite membership is discovered, never listed (HOK-3466): see
# shared/lib/test-discovery.ts for the pattern and marker rules. A discovery
# failure must fail the run loudly rather than run a partial suite.
if ! DISCOVERED="$(cd "$REPO_DIR" && node tools/discover-tests.ts --suite shell)"; then
  echo "run-shell-suite.sh: test discovery failed" >&2
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
        echo "run-shell-suite.sh: --shard requires INDEX/TOTAL (e.g. 2/3)" >&2
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
        echo "run-shell-suite.sh: --timing-out requires a file path" >&2
        exit 2
      fi
      TIMING_OUT="$2"
      shift 2
      ;;
    *)
      echo "run-shell-suite.sh: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

if (( SHARD_TOTAL < 1 || SHARD_INDEX < 1 || SHARD_INDEX > SHARD_TOTAL )); then
  echo "run-shell-suite.sh: invalid shard ${SHARD_INDEX}/${SHARD_TOTAL}" >&2
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
      (cd "$SCRIPT_DIR/.." && node tools/partition-tests.ts --suite shell --shard "${SHARD_INDEX}/${SHARD_TOTAL}")
  )"; then
    echo "run-shell-suite.sh: partitioner failed for shard ${SHARD_INDEX}/${SHARD_TOTAL}" >&2
    exit 2
  fi
  SELECTED=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && SELECTED+=("$line")
  done <<< "$SELECTION"
fi

# A shard with no work is a configuration error, not a silent pass.
if (( ${#SELECTED[@]} == 0 )); then
  echo "run-shell-suite.sh: shard ${SHARD_INDEX}/${SHARD_TOTAL} selected no tests" >&2
  exit 2
fi

if (( LIST_ONLY == 1 )); then
  printf '%s\n' "${SELECTED[@]}"
  exit 0
fi

if (( SHARD_TOTAL > 1 )); then
  echo "=== Shell suite shard ${SHARD_INDEX}/${SHARD_TOTAL} (${#SELECTED[@]} of ${#TESTS[@]} tests) ==="
else
  echo "=== Shell suite (${#TESTS[@]} tests) ==="
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

TIMING_ENTRIES=()
record_timing() {
  local id="$1" elapsed="$2" result="$3"
  TIMING_ENTRIES+=("{\"id\":\"${id}\",\"elapsedMs\":${elapsed},\"result\":\"${result}\"}")
}

write_timing_doc() {
  # Bounded machine-readable timing document: one entry per executed test.
  # Written atomically (tmp + mv) so a partial file is never observed.
  [[ -z "$TIMING_OUT" ]] && return 0
  local generated_at run_id sha tmp sep entry
  generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  run_id="${GITHUB_RUN_ID:-local}"
  sha="${GITHUB_SHA:-local}"
  tmp="${TIMING_OUT}.tmp.$$"
  {
    printf '{"suite":"shell","shard":"%s/%s","runId":"%s","sha":"%s","generatedAt":"%s","tests":[' \
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
}

# Always emit whatever timing data was collected, even on early failure --
# a truncated shard is more useful for diagnosis than no data at all.
trap 'write_timing_doc' EXIT

for f in "${SELECTED[@]}"; do
  path="$SCRIPT_DIR/$f"
  if [[ ! -f "$path" ]]; then
    echo "run-shell-suite.sh: missing test file $path" >&2
    exit 1
  fi
  echo ""
  echo ">>> $f"
  start="$(now_ms)"
  # Preserve fail-fast without letting set -e skip the timing record. Any
  # non-zero exit from the child is captured, recorded, then re-emitted.
  set +e
  bash "$path"
  rc=$?
  set -e
  end="$(now_ms)"
  elapsed=$((end - start))
  if (( rc == 0 )); then
    record_timing "$f" "$elapsed" "pass"
  else
    record_timing "$f" "$elapsed" "fail"
    exit "$rc"
  fi
done

echo ""
echo "--- Shell suite shard ${SHARD_INDEX}/${SHARD_TOTAL}: ${#SELECTED[@]} test files passed ---"
