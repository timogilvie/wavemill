#!/usr/bin/env bash
# HOK-2913: the coding→review handoff must materialize the review-scope
# baseline artifact so the guard reviews against the task-owned path set
# instead of falling back to merge-base scope as the normal case.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, opened, closed) {
      opened = gsub(/\{/, "{", line)
      closed = gsub(/\}/, "}", line)
      return opened - closed
    }

    $0 ~ "^" name "\\(\\) \\{" {
      capture=1
      depth=0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) {
        exit
      }
    }
  ' "$source_file"
}

# ── Static contract: review launch materializes the baseline ──
launch_body="$(extract_function "$MONITOR_SCRIPT_FILE" "launch_review_phase")"
if [[ "$launch_body" == *"ensure_review_scope_baseline"* ]]; then
  pass "launch_review_phase calls ensure_review_scope_baseline"
else
  fail "launch_review_phase calls ensure_review_scope_baseline"
fi

# ── Behavior: extract and run ensure_review_scope_baseline for real ──
eval "$(extract_function "$MONITOR_SCRIPT_FILE" "ensure_review_scope_baseline")"

# shellcheck disable=SC2034  # read by the eval'd ensure_review_scope_baseline
TOOLS_DIR="$REPO_DIR/tools"
WARNINGS=""
log_warn() { WARNINGS+="$*"$'\n'; }
# Run tsx from the repo so node module resolution works for the tool.
wavemill_run_tsx_tool() { (cd "$REPO_DIR" && npx tsx "$@"); }

# Build a worktree-shaped repo: integration base, task branch, committed work.
WT="$TEST_TMP/worktree"
mkdir -p "$WT"
git -C "$WT" init -qb auto/integration
git -C "$WT" config user.email test@example.com
git -C "$WT" config user.name "Test User"
echo '{}' > "$WT/.wavemill-config.json"
echo base > "$WT/README.md"
git -C "$WT" add -A
git -C "$WT" commit -qm base
BASE_COMMIT="$(git -C "$WT" rev-parse HEAD)"
git -C "$WT" checkout -qb task/demo
mkdir -p "$WT/shared/lib"
echo checker > "$WT/shared/lib/new-checker.ts"
git -C "$WT" add -A
git -C "$WT" commit -qm "Add checker"

FEATURE_DIR="$WT/features/demo"
mkdir -p "$FEATURE_DIR"
BASELINE="$FEATURE_DIR/.review-scope-baseline.json"
STATE_FILE="$TEST_TMP/workflow-state.json"
cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-TEST":{"lifecycle":{"launchContract":{"baseSha":"$BASE_COMMIT","baseBranch":"auto/integration"}}}}}
JSON

if ensure_review_scope_baseline "HOK-TEST" "$WT" "$FEATURE_DIR"; then
  pass "handoff baseline write succeeds"
else
  fail "handoff baseline write succeeds"
fi

if [[ -f "$BASELINE" ]]; then
  pass "baseline artifact exists after handoff"
else
  fail "baseline artifact exists after handoff"
fi

if jq -e '.paths == ["shared/lib/new-checker.ts"]' "$BASELINE" >/dev/null 2>&1; then
  pass "baseline records the committed coding path set"
else
  echo "    baseline contents: $(cat "$BASELINE" 2>/dev/null)"
  fail "baseline records the committed coding path set"
fi

if jq -e '.provenance == "launch-base" and .sinceCommit == "'"$BASE_COMMIT"'"' "$BASELINE" >/dev/null 2>&1; then
  pass "baseline records immutable launch-base provenance"
else
  fail "baseline records immutable launch-base provenance"
fi

# A review-fix commit after the handoff must not widen the recorded scope.
echo fix > "$WT/tools-review-fix.ts"
git -C "$WT" add -A
git -C "$WT" commit -qm "review fix"
ensure_review_scope_baseline "HOK-TEST" "$WT" "$FEATURE_DIR" || true
if jq -e '.paths == ["shared/lib/new-checker.ts"]' "$BASELINE" >/dev/null 2>&1; then
  pass "existing baseline is preserved on relaunch"
else
  fail "existing baseline is preserved on relaunch"
fi

# Missing feature dir degrades to a warning, never an error.
if ensure_review_scope_baseline "HOK-TEST" "$WT" "$WT/features/missing"; then
  fail "missing feature dir returns non-zero"
else
  pass "missing feature dir returns non-zero"
fi
if [[ "$WARNINGS" == *"feature dir missing"* ]]; then
  pass "missing feature dir logs a warning"
else
  fail "missing feature dir logs a warning"
fi

# A stale local integration ref must not pull inherited integration commits
# into the task baseline when launch state records the real base.
WT_STALE="$TEST_TMP/stale-local"
mkdir -p "$WT_STALE"
git -C "$WT_STALE" init -qb auto/integration
git -C "$WT_STALE" config user.email test@example.com
git -C "$WT_STALE" config user.name "Test User"
echo '{}' > "$WT_STALE/.wavemill-config.json"
echo base > "$WT_STALE/README.md"
git -C "$WT_STALE" add -A
git -C "$WT_STALE" commit -qm base
STALE_A="$(git -C "$WT_STALE" rev-parse HEAD)"
mkdir -p "$WT_STALE/shared/lib"
echo inherited > "$WT_STALE/shared/lib/inherited.ts"
git -C "$WT_STALE" add -A
git -C "$WT_STALE" commit -qm "integration work"
LAUNCH_B="$(git -C "$WT_STALE" rev-parse HEAD)"
git -C "$WT_STALE" checkout -qb task/stale "$LAUNCH_B"
git -C "$WT_STALE" update-ref refs/heads/auto/integration "$STALE_A"
echo task > "$WT_STALE/shared/lib/task-owned.ts"
git -C "$WT_STALE" add -A
git -C "$WT_STALE" commit -qm "task work"
STALE_FEATURE_DIR="$WT_STALE/features/stale"
mkdir -p "$STALE_FEATURE_DIR"
STALE_BASELINE="$STALE_FEATURE_DIR/.review-scope-baseline.json"
STATE_FILE="$TEST_TMP/stale-workflow-state.json"
cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-STALE":{"lifecycle":{"launchContract":{"baseSha":"$LAUNCH_B","baseBranch":"auto/integration"}}}}}
JSON

if ensure_review_scope_baseline "HOK-STALE" "$WT_STALE" "$STALE_FEATURE_DIR"; then
  pass "stale local integration handoff succeeds from launch base"
else
  fail "stale local integration handoff succeeds from launch base"
fi
if jq -e '.paths == ["shared/lib/task-owned.ts"] and .provenance == "launch-base"' "$STALE_BASELINE" >/dev/null 2>&1; then
  pass "stale local integration excludes inherited paths"
else
  echo "    stale baseline contents: $(cat "$STALE_BASELINE" 2>/dev/null)"
  fail "stale local integration excludes inherited paths"
fi

# A recorded launch base that is not an ancestor must fail closed and leave no
# baseline behind.
WT_BAD="$TEST_TMP/bad-launch-base"
mkdir -p "$WT_BAD"
git -C "$WT_BAD" init -qb auto/integration
git -C "$WT_BAD" config user.email test@example.com
git -C "$WT_BAD" config user.name "Test User"
echo base > "$WT_BAD/README.md"
git -C "$WT_BAD" add -A
git -C "$WT_BAD" commit -qm base
git -C "$WT_BAD" checkout -qb side
echo side > "$WT_BAD/side.txt"
git -C "$WT_BAD" add -A
git -C "$WT_BAD" commit -qm side
BAD_BASE="$(git -C "$WT_BAD" rev-parse HEAD)"
git -C "$WT_BAD" checkout auto/integration
git -C "$WT_BAD" checkout -qb task/bad
echo task > "$WT_BAD/task.txt"
git -C "$WT_BAD" add -A
git -C "$WT_BAD" commit -qm task
BAD_FEATURE_DIR="$WT_BAD/features/bad"
mkdir -p "$BAD_FEATURE_DIR"
BAD_BASELINE="$BAD_FEATURE_DIR/.review-scope-baseline.json"
WARNINGS=""
STATE_FILE="$TEST_TMP/bad-workflow-state.json"
cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-BAD":{"lifecycle":{"launchContract":{"baseSha":"$BAD_BASE","baseBranch":"auto/integration"}}}}}
JSON

if ensure_review_scope_baseline "HOK-BAD" "$WT_BAD" "$BAD_FEATURE_DIR"; then
  fail "non-ancestor launch base returns non-zero"
else
  pass "non-ancestor launch base returns non-zero"
fi
if [[ ! -f "$BAD_BASELINE" ]]; then
  pass "non-ancestor launch base does not write baseline"
else
  fail "non-ancestor launch base does not write baseline"
fi
if [[ "$WARNINGS" == *"recorded launch base"* && "$WARNINGS" == *"not an ancestor"* ]]; then
  pass "non-ancestor launch base diagnostic is actionable"
else
  fail "non-ancestor launch base diagnostic is actionable"
fi

# Compatibility fallback: when old state has no launch SHA, resolve the remote
# integration ref passed by the monitor instead of the stale local branch.
WT_REMOTE="$TEST_TMP/remote-fallback"
mkdir -p "$WT_REMOTE"
git -C "$WT_REMOTE" init -qb auto/integration
git -C "$WT_REMOTE" config user.email test@example.com
git -C "$WT_REMOTE" config user.name "Test User"
echo base > "$WT_REMOTE/README.md"
git -C "$WT_REMOTE" add -A
git -C "$WT_REMOTE" commit -qm base
REMOTE_A="$(git -C "$WT_REMOTE" rev-parse HEAD)"
mkdir -p "$WT_REMOTE/shared/lib"
echo inherited > "$WT_REMOTE/shared/lib/inherited.ts"
git -C "$WT_REMOTE" add -A
git -C "$WT_REMOTE" commit -qm "remote integration"
REMOTE_B="$(git -C "$WT_REMOTE" rev-parse HEAD)"
git -C "$WT_REMOTE" update-ref refs/remotes/origin/auto/integration "$REMOTE_B"
git -C "$WT_REMOTE" checkout -qb task/remote "$REMOTE_B"
git -C "$WT_REMOTE" update-ref refs/heads/auto/integration "$REMOTE_A"
echo task > "$WT_REMOTE/shared/lib/task-owned.ts"
git -C "$WT_REMOTE" add -A
git -C "$WT_REMOTE" commit -qm "task work"
REMOTE_FEATURE_DIR="$WT_REMOTE/features/remote"
mkdir -p "$REMOTE_FEATURE_DIR"
REMOTE_BASELINE="$REMOTE_FEATURE_DIR/.review-scope-baseline.json"
STATE_FILE="$TEST_TMP/remote-workflow-state.json"
cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-REMOTE":{"lifecycle":{"launchContract":{"baseBranch":"auto/integration"}}}}}
JSON

if ensure_review_scope_baseline "HOK-REMOTE" "$WT_REMOTE" "$REMOTE_FEATURE_DIR"; then
  pass "fallback baseline resolves remote integration"
else
  fail "fallback baseline resolves remote integration"
fi
if jq -e '.paths == ["shared/lib/task-owned.ts"] and .provenance == "remote-merge-base" and .baseRef == "origin/auto/integration"' "$REMOTE_BASELINE" >/dev/null 2>&1; then
  pass "fallback baseline records remote provenance"
else
  echo "    remote fallback contents: $(cat "$REMOTE_BASELINE" 2>/dev/null)"
  fail "fallback baseline records remote provenance"
fi

echo ""
echo "review-scope-baseline-handoff: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
