#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_ROOT/tests/fixtures/lifecycle/tend-fixture-lib.sh"

create_tend_fixture_root "wavemill-mill-base-ref"
trap cleanup_tend_fixture_root EXIT

GH_CALL_LOG="$TMP_DIR/gh-calls.log"
GIT_CALL_LOG="$TMP_DIR/git-calls.log"
TMUX_CALL_LOG="$TMP_DIR/tmux-calls.log"
STDOUT_FILE="$TMP_DIR/stdout.log"
STDERR_FILE="$TMP_DIR/stderr.log"
LAUNCH_PLAN_FILE="$TMP_DIR/launch-plan.json"
BACKLOG_FILE="$TMP_DIR/backlog.json"
export GH_CALL_LOG GIT_CALL_LOG TMUX_CALL_LOG
: > "$GH_CALL_LOG"
: > "$GIT_CALL_LOG"
: > "$TMUX_CALL_LOG"

mkdir -p "$REPO_DIR/.wavemill" "$TMP_DIR/worktrees" "$TMP_DIR/home"

cat > "$REPO_DIR/.wavemill-config.json" <<EOF
{
  "version": 1,
  "linear": { "project": "Fixture Project" },
  "mill": {
    "agentCmd": "codex",
    "baseBranch": "auto/integration",
    "worktreeRoot": "$TMP_DIR/worktrees",
    "requireConfirm": false
  },
  "taskSelection": { "enterLaunchesWave": true }
}
EOF

cat > "$BACKLOG_FILE" <<'EOF'
[
  {
    "id": "issue-1",
    "identifier": "HOK-2583",
    "title": "Missing base branch preflight",
    "description": "Task packet fixture.",
    "priority": 2,
    "estimate": 1,
    "state": { "name": "Backlog" },
    "labels": { "nodes": [] },
    "relations": { "nodes": [] },
    "inverseRelations": { "nodes": [] }
  }
]
EOF

write_fake_git
write_fake_gh
write_fake_tmux
write_fake_npx
export GIT_COMMON_DIR="$GIT_DIR"
export GIT_STUB_BASE_REF_AVAILABLE=0
export HOME="$TMP_DIR/home"
export STATE_DIR="$TMP_DIR/state"
export SESSION="mill-base-ref-$$"
export SKIP_CONFIG_CHECK=true
export SKIP_CONTEXT_CHECK=true
export WAVEMILL_NO_PROGRESS=1
export REQUIRE_CONFIRM=false
export WAVEMILL_DRY_RUN_BACKLOG_FILE="$BACKLOG_FILE"
export WAVEMILL_DRY_RUN_PLAN_OUT="$LAUNCH_PLAN_FILE"
export GH_REPO="acme/wavemill"

set +e
(
  cd "$REPO_DIR"
  unset WAVEMILL_MILL_ACTIVE
  printf '\n' | "$REPO_ROOT/wavemill" mill \
    --dry-run \
    --dry-run-plan-out "$LAUNCH_PLAN_FILE" \
    --dry-run-backlog "$BACKLOG_FILE" \
    >"$STDOUT_FILE" 2>"$STDERR_FILE"
)
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "FAIL: wavemill mill succeeded with missing base branch"
  exit 1
fi

if [[ -f "$LAUNCH_PLAN_FILE" ]]; then
  echo "FAIL: launch plan was written despite missing base branch"
  exit 1
fi

if grep -Eq '(^| )(new-session|respawn-pane|kill-session)( |$)' "$TMUX_CALL_LOG"; then
  echo "FAIL: tmux session was created or mutated despite missing base branch"
  cat "$TMUX_CALL_LOG"
  exit 1
fi

if ! grep -q 'configured base branch "auto/integration" is unavailable' "$STDERR_FILE"; then
  echo "FAIL: missing-base diagnostic was not printed"
  cat "$STDERR_FILE"
  exit 1
fi

if ! grep -q 'Checked: refs/heads/auto/integration and refs/remotes/origin/auto/integration.' "$STDERR_FILE"; then
  echo "FAIL: checked refs were not reported"
  cat "$STDERR_FILE"
  exit 1
fi

if ! grep -q 'No worktrees or agents were started.' "$STDERR_FILE"; then
  echo "FAIL: no-worktrees/no-agents assurance was not reported"
  cat "$STDERR_FILE"
  exit 1
fi

if ! grep -q '"reason":"base_ref_unavailable"' "$REPO_DIR/.wavemill/logs/startup-terminal.jsonl"; then
  echo "FAIL: machine-readable terminal reason was not recorded"
  cat "$REPO_DIR/.wavemill/logs/startup-terminal.jsonl" 2>/dev/null || true
  exit 1
fi

echo "PASS: mill missing base branch fails before launch"
