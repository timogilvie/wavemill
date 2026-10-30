#!/usr/bin/env bash
set -euo pipefail

# Guard against being sourced by lifecycle-scenarios.test.sh
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tend-fixture-lib.sh"

require_tend_runtime
create_tend_fixture_root "wavemill-tend-risk"
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
      "enabled": true,
      "riskPolicy": "require-label"
    }
  }
}
EOF

mkdir -p "$STATE_DIR/pr-view"
export GH_PR_VIEW_DIR="$STATE_DIR/pr-view"

body_file="$STATE_DIR/pr-42-body.txt"
cat > "$body_file" <<'EOF'
<!-- wavemill-meta
task: HOK-1442
risk: high
-->
EOF

cat > "$STATE_DIR/pr-list.json" <<'EOF'
[
  {
    "number": 42,
    "title": "High risk change",
    "headRefName": "task/high-risk",
    "createdAt": "2026-04-28T12:00:00Z",
    "isDraft": false,
    "labels": [
      { "name": "wavemill" },
      { "name": "wm:ready" },
      { "name": "Risk: High" }
    ],
    "body": "<!-- wavemill-meta\ntask: HOK-1442\nrisk: high\n-->"
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

write_pr_view 42 "High risk change" "task/high-risk" "auto/integration" '[{"name":"wavemill"},{"name":"wm:ready"},{"name":"Risk: High"}]' "$body_file"
write_fake_gh
write_fake_git
write_fake_npx

output="$(cd "$REPO_ROOT" && node tools/tend.ts --once --repo-dir "$REPO_DIR" 2>&1)"

if [[ "$output" != *"action=blocked-#42"* ]]; then
  echo "expected blocked-#42 action, got: $output"
  exit 1
fi

if grep -q '^42$' "$GH_MERGED_LOG"; then
  echo "PR 42 should not have merged"
  exit 1
fi

echo "PASS"
