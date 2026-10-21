#!/usr/bin/env bash
#
# HOK-3242 CI guard: tsc must reject a swapped-argument `readStageResult`
# call, so a regression of the HOK-3242 class of bug (the reconciler
# previously called `readStageResult('ready', featureDir)` with the
# arguments swapped — fixed in #1651) cannot land again.
#
# The `shared/lib/stage-result.ts` module changed its primary signature to
# take an options object, and declares a positional overload for backward
# compatibility; both forms must still reject when `stage` is not a
# `StageName`. The fixtures live under `tests/fixtures/stage-result-args/`
# and keep a byte-for-byte local mirror of the signature so this check
# does not drag in the rest of the repo's typing (which is pre-existing-red
# under `tsconfig.static.json`).
#
# Usage: bash tests/run-typecheck.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

FIXTURE_DIR="tests/fixtures/stage-result-args"

# 1. The correct fixture must type-check clean.
if ! npx tsc --noEmit -p "$FIXTURE_DIR/tsconfig.json" >/tmp/stage-result-correct-tsc.$$.log 2>&1; then
  echo "FAIL: correct-form fixture failed to type-check — the signature regressed." >&2
  cat /tmp/stage-result-correct-tsc.$$.log >&2
  rm -f /tmp/stage-result-correct-tsc.$$.log
  exit 1
fi
rm -f /tmp/stage-result-correct-tsc.$$.log

# 2. The swapped fixture must FAIL to type-check.
if npx tsc --noEmit -p "$FIXTURE_DIR/tsconfig-swapped.json" >/tmp/stage-result-swapped-tsc.$$.log 2>&1; then
  echo "FAIL: swapped-argument fixture type-checked clean. The HOK-3242 CI guard would not catch a regression of PR #1651." >&2
  cat /tmp/stage-result-swapped-tsc.$$.log >&2
  rm -f /tmp/stage-result-swapped-tsc.$$.log
  exit 1
fi

# 3. And the failure must name the swap, not something unrelated.
if ! grep -q "is not assignable to .* 'StageName'" /tmp/stage-result-swapped-tsc.$$.log; then
  echo "FAIL: swapped fixture failed to type-check for the WRONG reason." >&2
  echo "Expected a 'not assignable to .. StageName' error; got:" >&2
  cat /tmp/stage-result-swapped-tsc.$$.log >&2
  rm -f /tmp/stage-result-swapped-tsc.$$.log
  exit 1
fi
rm -f /tmp/stage-result-swapped-tsc.$$.log

echo "OK: readStageResult swap guard is live."
