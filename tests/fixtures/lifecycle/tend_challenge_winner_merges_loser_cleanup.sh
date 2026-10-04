#!/usr/bin/env bash
# HOK-2814: this fixture drives the tend-side merge-winner cleanup for a fully
# materialised pair with two live PRs. It is not on the pre-fork path — the
# fork lifecycle is covered by deferred_challenger_materialises_after_coding.
set -euo pipefail

# Guard against being sourced by lifecycle-scenarios.test.sh
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tend-fixture-lib.sh"

require_tend_runtime
create_tend_fixture_root "wavemill-tend-challenge"
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
  },
  "challenge": {
    "autoMergeWinner": true
  }
}
EOF

mkdir -p "$REPO_DIR/.wavemill/evals" "$STATE_DIR/pr-view"
export GH_PR_VIEW_DIR="$STATE_DIR/pr-view"

cat > "$REPO_DIR/.wavemill/workflow-state.json" <<'EOF'
{
  "tasks": {
    "HOK-1442": {
      "pr": 71,
      "challengePairId": "pair-1442",
      "challengeRole": "primary"
    },
    "HOK-1442_c": {
      "pr": 72,
      "challengePairId": "pair-1442",
      "challengeRole": "challenger"
    }
  }
}
EOF

cat > "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" <<'EOF'
{"challengePairId":"pair-1442","primaryPrUrl":"https://github.com/acme/widgets/pull/71","challengerPrUrl":"https://github.com/acme/widgets/pull/72","winner":"primary","timestamp":"2026-04-28T12:00:00Z"}
EOF

cat > "$STATE_DIR/pr-list.json" <<'EOF'
[
  {
    "number": 71,
    "title": "Primary candidate",
    "headRefName": "task/primary",
    "createdAt": "2026-04-28T12:00:00Z",
    "isDraft": false,
    "labels": [
      { "name": "wavemill" },
      { "name": "wm:ready" }
    ],
    "body": "<!-- wavemill-meta\ntask: HOK-1442\nchallenge: true\nchallengePairId: pair-1442\n-->"
  },
  {
    "number": 72,
    "title": "Challenger candidate",
    "headRefName": "task/challenger",
    "createdAt": "2026-04-28T12:05:00Z",
    "isDraft": false,
    "labels": [
      { "name": "wavemill" },
      { "name": "wm:ready" }
    ],
    "body": "<!-- wavemill-meta\ntask: HOK-1442_c\nchallenge: true\nchallengePairId: pair-1442\n-->"
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

body_71="$STATE_DIR/pr-71-body.txt"
body_72="$STATE_DIR/pr-72-body.txt"
printf '%s\n' '<!-- wavemill-meta' 'task: HOK-1442' 'challenge: true' 'challengePairId: pair-1442' '-->' > "$body_71"
printf '%s\n' '<!-- wavemill-meta' 'task: HOK-1442_c' 'challenge: true' 'challengePairId: pair-1442' '-->' > "$body_72"

write_pr_view 71 "Primary candidate" "task/primary" "auto/integration" '[{"name":"wavemill"},{"name":"wm:ready"}]' "$body_71"
write_pr_view 72 "Challenger candidate" "task/challenger" "auto/integration" '[{"name":"wavemill"},{"name":"wm:ready"}]' "$body_72"
write_fake_gh
write_fake_git
write_fake_npx

output="$(cd "$REPO_DIR" && npx tsx "$REPO_ROOT/tools/tend.ts" --once --repo-dir "$REPO_DIR" 2>&1)"

if [[ "$output" != *"action=merged-#71"* ]]; then
  echo "expected merged-#71 action, got: $output"
  exit 1
fi

if ! grep -q '^72$' "$GH_CLOSED_LOG"; then
  echo "expected challenger PR 72 to be closed"
  exit 1
fi

echo "PASS"
