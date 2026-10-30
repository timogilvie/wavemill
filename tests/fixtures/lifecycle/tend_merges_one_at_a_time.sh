#!/usr/bin/env bash
set -euo pipefail

# Guard against being sourced by lifecycle-scenarios.test.sh
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tend-fixture-lib.sh"

require_tend_runtime
create_tend_fixture_root "wavemill-tend-serial"
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
[
  {
    "number": 51,
    "title": "First ready PR",
    "headRefName": "task/first-ready",
    "createdAt": "2026-04-28T12:00:00Z",
    "isDraft": false,
    "labels": [
      { "name": "wavemill" },
      { "name": "wm:ready" }
    ],
    "body": "<!-- wavemill-meta\ntask: HOK-1442-A\n-->"
  },
  {
    "number": 52,
    "title": "Second ready PR",
    "headRefName": "task/second-ready",
    "createdAt": "2026-04-28T12:05:00Z",
    "isDraft": false,
    "labels": [
      { "name": "wavemill" },
      { "name": "wm:ready" }
    ],
    "body": "<!-- wavemill-meta\ntask: HOK-1442-B\n-->"
  }
]
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
[
  { "name": "task-ci", "state": "COMPLETED", "conclusion": "success" }
]
EOF
export GH_PR_CHECKS_FILE="$STATE_DIR/pr-checks.json"

body_51="$STATE_DIR/pr-51-body.txt"
body_52="$STATE_DIR/pr-52-body.txt"
printf '%s\n' '<!-- wavemill-meta' 'task: HOK-1442-A' '-->' > "$body_51"
printf '%s\n' '<!-- wavemill-meta' 'task: HOK-1442-B' '-->' > "$body_52"

write_pr_view 51 "First ready PR" "task/first-ready" "auto/integration" '[{"name":"wavemill"},{"name":"wm:ready"}]' "$body_51"
write_pr_view 52 "Second ready PR" "task/second-ready" "auto/integration" '[{"name":"wavemill"},{"name":"wm:ready"}]' "$body_52"
write_fake_gh
write_fake_git
write_fake_npx

output_one="$(cd "$REPO_ROOT" && node tools/tend.ts --once --repo-dir "$REPO_DIR" 2>&1)"
output_two="$(cd "$REPO_ROOT" && node tools/tend.ts --once --repo-dir "$REPO_DIR" 2>&1)"

if [[ "$output_one" != *"action=merged-#51"* ]]; then
  echo "expected first run to merge PR 51, got: $output_one"
  exit 1
fi

if [[ "$output_two" != *"action=merged-#52"* ]]; then
  echo "expected second run to merge PR 52, got: $output_two"
  exit 1
fi

if [[ "$(wc -l < "$GH_MERGED_LOG")" -ne 2 ]]; then
  echo "expected exactly two merges across two runs"
  exit 1
fi

echo "PASS"
