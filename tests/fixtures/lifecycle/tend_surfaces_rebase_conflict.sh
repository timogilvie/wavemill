#!/usr/bin/env bash
set -euo pipefail

# Guard against being sourced by lifecycle-scenarios.test.sh
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tend-fixture-lib.sh"

require_tend_runtime
create_tend_fixture_root "wavemill-tend-conflict"
trap cleanup_tend_fixture_root EXIT

export GH_CALL_LOG="$STATE_DIR/gh-calls.log"
export GH_MERGED_LOG="$STATE_DIR/merged.log"
export GH_CLOSED_LOG="$STATE_DIR/closed.log"
export GH_COMMENT_LOG="$STATE_DIR/comment.log"
export GIT_CALL_LOG="$STATE_DIR/git-calls.log"
touch "$GH_CALL_LOG" "$GH_MERGED_LOG" "$GH_CLOSED_LOG" "$GH_COMMENT_LOG" "$GIT_CALL_LOG"

REMOTE_DIR="$TMP_DIR/remote.git"
WORK_DIR="$TMP_DIR/work"
git init --bare "$REMOTE_DIR" >/dev/null 2>&1
git clone "$REMOTE_DIR" "$WORK_DIR" >/dev/null 2>&1

git -C "$WORK_DIR" config user.name "Wavemill Test"
git -C "$WORK_DIR" config user.email "wavemill@example.com"

printf 'base\n' > "$WORK_DIR/conflict.txt"
git -C "$WORK_DIR" add conflict.txt
git -C "$WORK_DIR" commit -m "base" >/dev/null 2>&1
git -C "$WORK_DIR" branch -M auto/integration
git -C "$WORK_DIR" push -u origin auto/integration >/dev/null 2>&1

git -C "$WORK_DIR" checkout -b task/conflict >/dev/null 2>&1
printf 'task branch\n' > "$WORK_DIR/conflict.txt"
git -C "$WORK_DIR" commit -am "task change" >/dev/null 2>&1
git -C "$WORK_DIR" push -u origin task/conflict >/dev/null 2>&1

git -C "$WORK_DIR" checkout auto/integration >/dev/null 2>&1
printf 'integration branch\n' > "$WORK_DIR/conflict.txt"
git -C "$WORK_DIR" commit -am "integration change" >/dev/null 2>&1
git -C "$WORK_DIR" push >/dev/null 2>&1

cat > "$WORK_DIR/.wavemill-config.json" <<'EOF'
{
  "integration": {
    "enabled": true,
    "integrationBranch": "auto/integration",
    "mergeMethod": "squash"
  }
}
EOF

mkdir -p "$STATE_DIR/pr-view"
export GH_PR_VIEW_DIR="$STATE_DIR/pr-view"

body_file="$STATE_DIR/pr-61-body.txt"
cat > "$body_file" <<'EOF'
<!-- wavemill-meta
task: HOK-1442
-->
EOF

cat > "$STATE_DIR/pr-list.json" <<'EOF'
[
  {
    "number": 61,
    "title": "Conflicting PR",
    "headRefName": "task/conflict",
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

write_pr_view 61 "Conflicting PR" "task/conflict" "auto/integration" '[{"name":"wavemill"},{"name":"wm:ready"}]' "$body_file"
write_fake_gh
real_git="$(command -v git)"
cat > "$FAKE_BIN/git" <<EOF
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "\$*" >> "\$GIT_CALL_LOG"

if [[ "\${1:-}" == "remote" && "\${2:-}" == "get-url" && "\${3:-}" == "origin" ]]; then
  printf '%s\n' "git@github.com:acme/widgets.git"
  exit 0
fi

exec "$real_git" "\$@"
EOF
chmod +x "$FAKE_BIN/git"
write_fake_npx

output="$(cd "$REPO_ROOT" && PATH="$FAKE_BIN:$PATH" node tools/tend.ts --once --repo-dir "$WORK_DIR" 2>&1)"

if [[ "$output" != *"action=blocked-#61"* ]]; then
  echo "expected blocked-#61 action, got: $output"
  exit 1
fi

if [[ -s "$GH_MERGED_LOG" ]]; then
  echo "merge should not have been attempted"
  exit 1
fi

echo "PASS"
