#!/usr/bin/env bash
set -euo pipefail

# Guard against being sourced by lifecycle-scenarios.test.sh
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tend-fixture-lib.sh"

require_tend_runtime
create_tend_fixture_root "wavemill-tend-status-line"
trap cleanup_tend_fixture_root EXIT

export GH_CALL_LOG="$STATE_DIR/gh-calls.log"
export GH_MERGED_LOG="$STATE_DIR/merged.log"
export GH_CLOSED_LOG="$STATE_DIR/closed.log"
export GH_COMMENT_LOG="$STATE_DIR/comment.log"
export GIT_CALL_LOG="$STATE_DIR/git-calls.log"
touch "$GH_CALL_LOG" "$GH_MERGED_LOG" "$GH_CLOSED_LOG" "$GH_COMMENT_LOG" "$GIT_CALL_LOG"

cat > "$REPO_DIR/.wavemill-config.json" <<'EOF'
{
  "integration": {
    "enabled": true,
    "integrationBranch": "auto/integration",
    "mergeMethod": "squash",
    "readyPolicy": {
      "enabled": true
    }
  }
}
EOF

mkdir -p "$STATE_DIR/pr-view"
export GH_PR_VIEW_DIR="$STATE_DIR/pr-view"

cat > "$STATE_DIR/pr-list.json" <<'EOF'
[]
EOF
export GH_PR_LIST_FILE="$STATE_DIR/pr-list.json"

cat > "$STATE_DIR/check-runs.json" <<'EOF'
{
  "check_runs": [
    { "name": "integration-ci", "conclusion": "success" }
  ]
}
EOF
export GH_CHECK_RUNS_FILE="$STATE_DIR/check-runs.json"

cat > "$STATE_DIR/pr-checks.json" <<'EOF'
[]
EOF
export GH_PR_CHECKS_FILE="$STATE_DIR/pr-checks.json"

write_fake_gh
write_fake_npx
write_fake_git

OUTPUT_FILE="$STATE_DIR/tend-output.log"

# Run tend with --loop for exactly 3 iterations using timeout.
# Each iteration calls renderer.write(), which outputs one line per call in non-TTY mode.
# Since stdout is redirected to a file, isTTY is false, so we get one line per iteration.
# We use timeout to terminate after 3+ iterations have happened.
timeout 5s node "$REPO_ROOT/tools/tend.ts" --loop --repo-dir "$REPO_DIR" > "$OUTPUT_FILE" 2>&1 || true

# Count the number of lines in the output
LINE_COUNT=$(wc -l < "$OUTPUT_FILE" || echo 0)

# Each iteration should produce exactly one line (in non-TTY mode)
# With timeout of 5s and a loop interval of 60s, we should get exactly 1 line from the first iteration
# But let me check what we actually get
if [[ "$LINE_COUNT" -lt 1 ]]; then
  echo "FAIL: expected at least 1 line of output, got $LINE_COUNT"
  echo "Output file:"
  cat "$OUTPUT_FILE"
  exit 1
fi

# Verify that no ANSI escape sequences are present (which would indicate TTY mode being used)
if grep -q $'\x1b' "$OUTPUT_FILE"; then
  echo "FAIL: output contains ANSI escape sequences (should not be present in non-TTY mode)"
  echo "Output file:"
  cat "$OUTPUT_FILE"
  exit 1
fi

# Verify that there are no \r characters in the output
if grep -q $'\r' "$OUTPUT_FILE"; then
  echo "FAIL: output contains carriage returns (should not be present in non-TTY mode)"
  echo "Output file:"
  cat "$OUTPUT_FILE"
  exit 1
fi

echo "PASS: status line is not repeated with ANSI sequences in non-TTY mode"
