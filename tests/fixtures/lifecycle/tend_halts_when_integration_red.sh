#!/usr/bin/env bash
set -euo pipefail

# Guard against being sourced by lifecycle-scenarios.test.sh
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tend-fixture-lib.sh"

require_tend_runtime
create_tend_fixture_root "wavemill-tend-red"
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
    "integrationBranch": "auto/integration"
  }
}
EOF

mkdir -p "$STATE_DIR/pr-view"
export GH_PR_VIEW_DIR="$STATE_DIR/pr-view"

body_file="$STATE_DIR/pr-43-body.txt"
cat > "$body_file" <<'EOF'
<!-- wavemill-meta
task: HOK-1442
-->
EOF

cat > "$STATE_DIR/pr-list.json" <<'EOF'
[
  {
    "number": 43,
    "title": "Would be eligible",
    "headRefName": "task/would-merge",
    "createdAt": "2026-04-28T12:00:00Z",
    "isDraft": false,
    "labels": [
      { "name": "wavemill" },
      { "name": "wm:ready" }
    ],
    "body": "<!-- wavemill-meta\ntask: HOK-1442\n-->"
  }
]
EOF
export GH_PR_LIST_FILE="$STATE_DIR/pr-list.json"

cat > "$STATE_DIR/check-runs.json" <<'EOF'
{
  "check_runs": [
    { "name": "integration-ci", "conclusion": "failure" }
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

write_pr_view 43 "Would be eligible" "task/would-merge" "auto/integration" '[{"name":"wavemill"},{"name":"wm:ready"}]' "$body_file"
write_fake_gh
write_fake_git
write_fake_npx

output="$(cd "$REPO_ROOT" && npx tsx tools/tend.ts --once --dry-run --repo-dir "$REPO_DIR" 2>&1)"

if [[ "$output" != *'health=unhealthy reason="integration-ci: failure"'* ]] || [[ "$output" != *"eligible=0"* ]]; then
  echo "expected health=unhealthy with reason and eligible=0, got: $output"
  exit 1
fi

if [[ "$output" == *"action=merging-"* ]]; then
  echo "expected no candidate selection while integration is unhealthy, got: $output"
  exit 1
fi

if ! grep -q "fetch origin auto/integration" "$GIT_CALL_LOG"; then
  echo "expected tend to fetch integration before health check"
  exit 1
fi

echo "PASS"
