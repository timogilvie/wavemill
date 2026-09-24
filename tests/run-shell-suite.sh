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
# Shards are assigned round-robin rather than in contiguous blocks: the slow
# suites (lifecycle-*, challenge-*) are clustered in the list, and contiguous
# blocks would pile them into one shard.
#
# Timing output (--timing-out or TIMING_OUTPUT env) is a single bounded JSON
# document: one entry per executed test with id, elapsed ms, and result. It
# contains only test ids, durations, and results -- never environment content.
#
# Fails fast on the first failing test, matching the previous && chain.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Note: tests/check-shell.sh is deliberately absent. It is a lint/syntax pass
# over every shell script, not a per-shard test, and runs once via `npm run lint`.
TESTS=(
  aborted-challenge-cleanup.test.sh
  safe-branch-cleanup.test.sh
  challenge-primary-merge-cleanup.test.sh
  operator-abort-cleanup.test.sh
  agent-resolve-from-model.test.sh
  terminal-reconciler.test.sh
  startup-terminal-preflight.test.sh
  fresh-launch-terminal-preflight.test.sh
  startup-cleanup-integration.test.sh
  startup-terminal-ownership.test.sh
  monitor-env-completeness.test.sh
  wavemill-expand-direct.test.sh
  routing-complete-writes.test.sh
  wavemill-monitor-executed-model.test.sh
  apply-expanded-route.test.sh
  challenge-intent-roundtrip.test.sh
  challenge-varied-model-abort.test.sh
  challenge-record-decisive.test.sh
  native-terminal-failure.test.sh
  native-failure-classification.test.sh
  challenger-transient-retry.test.sh
  parent-monitor-function-drift.test.sh
  save-task-state-canonicalization.test.sh
  linear-state-canonicalization.test.sh
  task-phase-canonicalization.test.sh
  pr-state-merge-canonicalization.test.sh
  review-recovery.test.sh
  recovery-contract-replay.test.sh
  with-timeout.test.sh
  native-agent-shell-operators.test.sh
  native-coding-commit.test.sh
  hook-write-context-guard.test.sh
  claude-tmux-server-guard.test.sh
  agent-tmux-runtime-guard.test.sh
  expansion-handshake.test.sh
  config-version-prompt.test.sh
  monitor-ready-transition.test.sh
  launch-ready-phase.test.sh
  bounded-retry.test.sh
  handle-phase-launch-result.test.sh
  launch-pane-liveness.test.sh
  launch-failure-log-capture.test.sh
  challenge-eval-soft-retry.test.sh
  challenge-deferred-arm.test.sh
  review-scope-baseline-handoff.test.sh
  launch-native-planning-phase.test.sh
  log-hygiene.test.sh
  lifecycle-scenarios.test.sh
  lifecycle-harness.test.sh
  archive-stage-artifacts.test.sh
  cleanup-branch.test.sh
  cleanup-episodes.test.sh
  completed-task-cleanup.test.sh
  error-recovery.test.sh
  startup-terminal-prune.test.sh
  planning-validation.test.sh
  wavemill-guards.test.sh
  wavemill-status.test.sh
  dashboard-incidents-section.test.sh
  backstage-tend-watchdog.test.sh
  backstage-observer-watchdog.test.sh
  observer-managed-filing.test.sh
  backstage-observer-pane-promotion.test.sh
  control-layout.test.sh
  control-pane-recovery.test.sh
  challenge-comparison-state.test.sh
  challenge-running-state.test.sh
  challenge-eval-hard-failure.test.sh
  challenge-eval-invalid-challenge.test.sh
  challenge-eval-timeout.test.sh
  challenge-job-monitor-loop.test.sh
  task-selection-renderer.test.sh
  wavemill-backlog-pane-no-flash.test.sh
  wavemill-expand-selection.test.sh
  wavemill-mill-challenge.test.sh
  wavemill-mill-model-flags.test.sh
  wavemill-mill-config-preflight.test.sh
  wavemill-mill-router-fallback.test.sh
  model-inheritance-chain.test.sh
  wavemill-monitor-command-draining.test.sh
  wavemill-mill-session.test.sh
  wavemill-input-reader.test.sh
  merge-retry-marker.test.sh
  queue-health.test.sh
  merge-queue-live-ci.test.sh
  merge-lane-progress-artifacts.test.sh
  queue-planner-stdin-policy.test.sh
  openrouter-warning-surfaces.test.sh
  hokusai-test-registration.test.sh
  global-model-parity.test.sh
  stage-state.test.sh
  startup-handoff.test.sh
  monitor-script-byte-identical.test.sh
  transient-marker.test.sh
  run-custom-tests-shard.test.sh
  incident-fixtures-terminal-panes.test.sh
  incident-fixtures-safety-controls.test.sh
  terminal-lifecycle-flags.test.sh
  challenge-provenance.test.sh
  quarantine-legacy-reviewer-forfeits.test.sh
  reviewer-stage-hok2939-shaped.test.sh
  reviewer-stage-hok2954-shaped.test.sh
  challenge-fork-materialisation.test.sh
  challenge-fork-restart.test.sh
  challenge-fork-pre-fork-collapse.test.sh
  challenge-fork-inherited-provenance.test.sh
  challenge-fork-non-forked-regression.test.sh
  challenge-fork-review-launch-refusal.test.sh
)

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

SELECTED=()
for i in "${!TESTS[@]}"; do
  if (( i % SHARD_TOTAL == SHARD_INDEX - 1 )); then
    SELECTED+=("${TESTS[$i]}")
  fi
done

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
