#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "    unexpected: $needle"
    fail "$name"
  else
    pass "$name"
  fi
}

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

HELPERS_FILE="$TEST_TMP/tmux_helpers.sh"
{
  extract_function "$COMMON_SCRIPT" "_tmux_window_target_exists"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_tmux_target_join"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_tmux_task_window_target"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_cleanup_run"
} > "$HELPERS_FILE"

CLEANUP_FILE="$TEST_TMP/cleanup_completed_task.sh"
{
  printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_DEFAULT=15'
  printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_MIN=1'
  printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_MAX=600'
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_warn"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_git_remote_timeout_seconds"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_kill_process_tree"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_git_remote_with_timeout"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_write_preserved_branch_incident"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "safe_remove_task_worktree_and_branch"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "cleanup_completed_task"
} > "$CLEANUP_FILE"
REMOTE_CLEANUP_FILE="$TEST_TMP/cleanup_remote_task_branch.sh"
extract_function "$COMMON_SCRIPT" "cleanup_remote_task_branch" > "$REMOTE_CLEANUP_FILE"
EXECUTE_FILE="$TEST_TMP/execute.sh"
extract_function "$MILL_SCRIPT" "execute" > "$EXECUTE_FILE"

run_target_resolution_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/target-$test_case"
  mkdir -p "$case_dir/worktrees/task-slug"

  CASE_DIR="$case_dir" HELPERS_FILE="$HELPERS_FILE" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$HELPERS_FILE"

    SESSION="wavemill"
    ISSUE="HOK-2348"
    SLUG="task-slug"
    STATE_FILE="$CASE_DIR/state.json"
    WT_DIR="$CASE_DIR/worktrees/$SLUG"

    cat > "$STATE_FILE" <<EOF
{"tasks":{"$ISSUE":{"windowId":"@31"}}}
EOF

    tmux() {
      case "${1:-}" in
        display-message)
          case "$TEST_CASE:${4:-}:${5:-}" in
            stored-dead:@31:"#{session_name}") printf "%s\n" "wavemill" ;;
            stored-dead:@31:"#{pane_current_path}") printf "\n" ;;
            renamed-title:@31:"#{session_name}") printf "%s\n" "wavemill" ;;
            renamed-title:@31:"#{pane_current_path}") printf "%s\n" "$WT_DIR" ;;
            *) return 1 ;;
          esac
          ;;
        list-panes)
          case "$TEST_CASE:${3:-}:${5:-}" in
            stored-dead:@31:"#{pane_dead}") printf "%s\n" "1" ;;
            *) return 1 ;;
          esac
          ;;
        list-windows)
          if [[ "$TEST_CASE" == "renamed-title" ]]; then
            printf "%s\n" "@31|2348 · task-slug · PR#868 ✓ · review"
          fi
          ;;
        *)
          return 1
          ;;
      esac
    }

    target="$(_tmux_task_window_target "$SESSION" "$ISSUE" "$SLUG" "$STATE_FILE" "$WT_DIR")"
    printf "target=%s\n" "$target"
  ' 2>&1
}

run_cleanup_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/cleanup-$test_case"
  mkdir -p "$case_dir/repo" "$case_dir/worktrees/task-slug"

  CASE_DIR="$case_dir" HELPERS_FILE="$HELPERS_FILE" CLEANUP_FILE="$CLEANUP_FILE" REMOTE_CLEANUP_FILE="$REMOTE_CLEANUP_FILE" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$HELPERS_FILE"
    source "$REMOTE_CLEANUP_FILE"
    source "$CLEANUP_FILE"
    wavemill_git_remote_with_timeout() { shift; git "$@"; }

    SESSION="wavemill"
    ISSUE="HOK-2348"
    SLUG="task-slug"
    REPO_DIR="$CASE_DIR/repo"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    STATE_FILE="$CASE_DIR/state.json"
    MILL_LOG_FILE="$CASE_DIR/mill.log"
    API_TIMEOUT=5

    state_pr_json=",\"pr\":4242"
    if [[ "$TEST_CASE" == "no-pr" ]]; then
      state_pr_json=""
    fi
    cat > "$STATE_FILE" <<EOF
{"tasks":{"$ISSUE":{"windowId":"@31"$state_pr_json,"lifecycle":{"schemaVersion":1,"workflowOutcome":"merged","resourceDisposition":"reaping","launchContract":{"remoteBranchDeletionPolicy":{"allowed":true,"mode":"merged-pr-task-branch","source":"test"}}}}}}
EOF
    : > "$MILL_LOG_FILE"

    declare -Ag CLEANED=()
    declare -Ag PR_BY_ISSUE=()
    LOG_OUTPUT=""
    WARN_OUTPUT=""
    ATTENTION=""
    REMOVE_STATE_CALLS=0
    RESET_RETRY_CALLS=0
    KILLED=0
    GIT_CALLS=""
    ORDER=""

    archive_stage_artifacts() {
      ORDER+="archive;"
      [[ "$TEST_CASE" != "archive-fails" ]]
    }
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    set_window_attention_state() { ATTENTION="$2"; }
    reset_retry_count() { RESET_RETRY_CALLS=$((RESET_RETRY_CALLS + 1)); ORDER+="reset;"; }
    remove_task_state() { REMOVE_STATE_CALLS=$((REMOVE_STATE_CALLS + 1)); ORDER+="remove-state;"; }
    _with_timeout() { shift; "$@"; }
    pr_state() {
      case "$TEST_CASE" in
        closed-unmerged) printf "%s\n" "CLOSED" ;;
        *) printf "%s\n" "MERGED" ;;
      esac
    }

    git() {
      if [[ "${1:-}" == "-C" ]]; then
        shift 2
      fi
      GIT_CALLS+="$*;"
      case "${1:-} ${2:-}" in
        "status --porcelain")
          return 0
          ;;
        "worktree remove")
          ORDER+="worktree-remove;"
          [[ "$TEST_CASE" != "worktree-fails" ]]
          return $?
          ;;
        "worktree prune")
          ORDER+="prune;"
          return 0
          ;;
        "branch -D"|"branch -d")
          ORDER+="branch-delete;"
          [[ "$TEST_CASE" != "local-branch-fails" ]]
          return $?
          ;;
        "show-ref --verify")
          [[ "$TEST_CASE" != "local-branch-absent" ]]
          return $?
          ;;
        "fetch origin")
          return 0
          ;;
        "rev-parse --verify")
          case "${3:-}" in
            *task-slug*) printf "%s\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ;;
            *auto/integration*) printf "%s\n" "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ;;
            *) printf "%s\n" "cccccccccccccccccccccccccccccccccccccccc" ;;
          esac
          return 0
          ;;
        "merge-base --is-ancestor")
          [[ "$TEST_CASE" != "preserved-local-work" ]]
          return $?
          ;;
        "cat-file -e")
          return 0
          ;;
        "rev-list --count")
          if [[ "$TEST_CASE" == "preserved-local-work" ]]; then
            printf "1\n"
            return 0
          fi
          printf "0\n"
          return 0
          ;;
        "rev-list "*)
          if [[ "$TEST_CASE" == "preserved-local-work" ]]; then
            printf "%s\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          fi
          return 0
          ;;
        "ls-remote --heads")
          return 0
          ;;
        "ls-remote --exit-code")
          ORDER+="ls-remote;"
          [[ "$TEST_CASE" == "merged-remote-absent" ]] && return 2
          [[ "$TEST_CASE" == "ls-remote-fails" ]] && return 128
          return 0
          ;;
        "push origin")
          ORDER+="push-delete;"
          [[ "$TEST_CASE" != "push-fails" ]]
          return $?
          ;;
      esac
      return 0
    }

    tmux() {
      case "${1:-}" in
        display-message)
          case "${5:-}" in
            "#{session_name}")
              if [[ "${4:-}" != "@31" ]]; then
                return 1
              fi
              if [[ "$TEST_CASE" == "kill-persistent" && "$KILLED" -eq 1 ]]; then
                printf "%s\n" "wavemill"
                return 0
              fi
              if [[ "$TEST_CASE" != "kill-persistent" && "$KILLED" -eq 1 ]]; then
                return 1
              fi
              printf "%s\n" "wavemill"
              ;;
            "#{pane_current_path}")
              printf "\n"
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        list-panes)
          if [[ "${2:-}" == "-t" && "${3:-}" == "@31" ]]; then
            printf "%s\n" "1"
            return 0
          fi
          return 1
          ;;
        kill-window)
          ORDER+="tmux-kill;"
          KILLED=1
          return 0
          ;;
        *)
          return 1
          ;;
      esac
    }

    set +e
    cleanup_completed_task "$ISSUE" "$SLUG" "test cleanup"
    rc=$?
    set -e

    printf "rc=%s\n" "$rc"
    printf "remove_state_calls=%s\n" "$REMOVE_STATE_CALLS"
    printf "reset_retry_calls=%s\n" "$RESET_RETRY_CALLS"
    printf "cleaned=%s\n" "${CLEANED[$ISSUE]:-}"
    printf "attention=%s\n" "$ATTENTION"
    printf "git_calls=%s\n" "$GIT_CALLS"
    printf "order=%s\n" "$ORDER"
    printf "logs=%s\n" "$(printf "%s" "$LOG_OUTPUT" | tr "\n" ";")"
    printf "warns=%s\n" "$(printf "%s" "$WARN_OUTPUT" | tr "\n" ";")"
  ' 2>&1
}

run_protected_helper_case() {
  local branch="$1"
  local case_dir="$TEST_TMP/protected-helper-$branch"
  mkdir -p "$case_dir/repo"

  CASE_DIR="$case_dir" REMOTE_CLEANUP_FILE="$REMOTE_CLEANUP_FILE" BRANCH="$branch" bash -lc '
    set -euo pipefail
    source "$REMOTE_CLEANUP_FILE"
    REPO_DIR="$CASE_DIR/repo"
    API_TIMEOUT=5
    LOG_OUTPUT=""
    WARN_OUTPUT=""
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    pr_state() { printf "%s\n" "MERGED"; }
    _with_timeout() { shift; "$@"; }
    git() { return 0; }

    cleanup_remote_task_branch "HOK-2348" "$BRANCH" "4242" || true
    printf "logs=%s\n" "$(printf "%s" "$LOG_OUTPUT" | tr "\n" ";")"
    printf "warns=%s\n" "$(printf "%s" "$WARN_OUTPUT" | tr "\n" ";")"
  ' 2>&1
}

run_legacy_remote_policy_case() {
  local case_dir="$TEST_TMP/legacy-remote-policy"
  mkdir -p "$case_dir/repo"

  CASE_DIR="$case_dir" REMOTE_CLEANUP_FILE="$REMOTE_CLEANUP_FILE" bash -lc '
    set -euo pipefail
    source "$REMOTE_CLEANUP_FILE"
    REPO_DIR="$CASE_DIR/repo"
    STATE_FILE="$CASE_DIR/state.json"
    API_TIMEOUT=5
    LOG_OUTPUT=""
    GIT_CALLS=""
    cat > "$STATE_FILE" <<EOF
{"tasks":{"HOK-2348":{"branch":"task/task-slug","status":"merged","phase":"done","pr":"4242"}}}
EOF
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { :; }
    pr_state() { printf "%s\n" "MERGED"; }
    _with_timeout() { shift; "$@"; }
    git() { GIT_CALLS+="$*;"; return 0; }

    cleanup_remote_task_branch "HOK-2348" "task/task-slug" "4242" || true
    printf "logs=%s\n" "$(printf "%s" "$LOG_OUTPUT" | tr "\n" ";")"
    printf "git_calls=%s\n" "$GIT_CALLS"
  ' 2>&1
}

run_common_dry_run_case() {
  local case_dir="$TEST_TMP/common-dry-run"
  mkdir -p "$case_dir/repo" "$case_dir/worktrees/task-slug"

  CASE_DIR="$case_dir" HELPERS_FILE="$HELPERS_FILE" CLEANUP_FILE="$CLEANUP_FILE" REMOTE_CLEANUP_FILE="$REMOTE_CLEANUP_FILE" EXECUTE_FILE="$EXECUTE_FILE" bash -lc '
    set -euo pipefail
    source "$HELPERS_FILE"
    source "$EXECUTE_FILE"
    source "$REMOTE_CLEANUP_FILE"
    source "$CLEANUP_FILE"
    wavemill_git_remote_with_timeout() { shift; git "$@"; }

    SESSION="wavemill"
    ISSUE="HOK-2348"
    SLUG="task-slug"
    REPO_DIR="$CASE_DIR/repo"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    STATE_FILE="$CASE_DIR/state.json"
    MILL_LOG_FILE="$CASE_DIR/mill.log"
    API_TIMEOUT=5
    DRY_RUN=true

    cat > "$STATE_FILE" <<EOF
{"tasks":{"$ISSUE":{"windowId":"@31","pr":4242,"lifecycle":{"schemaVersion":1,"workflowOutcome":"merged","resourceDisposition":"reaping","launchContract":{"remoteBranchDeletionPolicy":{"allowed":true,"mode":"merged-pr-task-branch","source":"test"}}}}}}
EOF
    : > "$MILL_LOG_FILE"

    declare -Ag CLEANED=()
    declare -Ag PR_BY_ISSUE=()
    REMOVE_STATE_CALLS=0
    LOG_OUTPUT=""
    WARN_OUTPUT=""

    archive_stage_artifacts() { :; }
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    set_window_attention_state() { :; }
    reset_retry_count() { :; }
    remove_task_state() { REMOVE_STATE_CALLS=$((REMOVE_STATE_CALLS + 1)); }
    pr_state() { printf "%s\n" "MERGED"; }
    _with_timeout() { shift; "$@"; }
    git() {
      if [[ "${1:-}" == "-C" ]]; then
        shift 2
      fi
      case "${1:-} ${2:-}" in
        "rev-list --count") printf "0\n" ;;
      esac
      return 0
    }
    tmux() { return 1; }

    cleanup_completed_task "$ISSUE" "$SLUG" "test cleanup" || true
    printf "mill_log=%s\n" "$(tr "\n" ";" < "$MILL_LOG_FILE")"
  ' 2>&1
}

echo "=== Completed Task Cleanup ==="

output="$(run_target_resolution_case stored-dead)"
check_contains "stored dead pane keeps persisted target" "$output" "target=@31"

output="$(run_target_resolution_case renamed-title)"
check_contains "renamed title resolves current window id" "$output" "target=@31"

output="$(run_cleanup_case dead-pane-success)"
check_contains "cleanup success returns zero" "$output" "rc=0"
check_contains "cleanup archives before destructive cleanup" "$output" "order=archive;tmux-kill;worktree-remove;branch-delete;ls-remote;push-delete;prune;reset;remove-state;"
check_contains "cleanup success resets retry state" "$output" "reset_retry_calls=1"
check_contains "cleanup success removes task state" "$output" "remove_state_calls=1"
check_contains "cleanup success marks issue cleaned" "$output" "cleaned=1"
check_contains "cleanup success keeps attention clear" "$output" "attention="
check_not_contains "cleanup success avoids warnings" "$output" "keeping task state"

output="$(run_cleanup_case local-branch-absent)"
check_contains "missing local branch still completes" "$output" "rc=0"
check_contains "missing local branch skips branch deletion" "$output" "order=archive;tmux-kill;worktree-remove;ls-remote;push-delete;prune;reset;remove-state;"

output="$(run_cleanup_case merged-remote-present)"
check_contains "merged PR deletes remote branch" "$output" "push origin --delete task/task-slug"
check_contains "merged PR logs remote deletion" "$output" "Deleted remote branch: task/task-slug"
check_contains "merged PR cleanup removes state" "$output" "remove_state_calls=1"

output="$(run_cleanup_case merged-remote-absent)"
check_not_contains "absent remote avoids delete push" "$output" "push origin --delete task/task-slug"
check_contains "absent remote logs no-op" "$output" "remote branch already absent: task/task-slug"
check_contains "absent remote produces no warning" "$output" "warns="
check_contains "absent remote still completes" "$output" "rc=0"

output="$(run_cleanup_case closed-unmerged)"
check_not_contains "closed unmerged retains remote branch" "$output" "push origin --delete task/task-slug"
check_contains "closed unmerged logs retention" "$output" "retaining remote branch task/task-slug (PR #4242 state=CLOSED"
check_contains "closed unmerged completes" "$output" "rc=0"

output="$(run_cleanup_case no-pr)"
check_not_contains "missing PR avoids remote delete" "$output" "push origin --delete task/task-slug"
check_contains "missing PR logs retention" "$output" "retaining remote branch task/task-slug (no PR recorded)"
check_contains "missing PR completes" "$output" "rc=0"

output="$(run_legacy_remote_policy_case)"
check_not_contains "legacy state lacks branch deletion authority" "$output" "push origin --delete task/task-slug"
check_contains "legacy state logs lifecycle deletion-policy retention" "$output" "no authoritative lifecycle deletion policy"

output="$(run_cleanup_case preserved-local-work)"
check_contains "preserved local work returns non-zero" "$output" "rc=1"
check_contains "preserved local work keeps state" "$output" "remove_state_calls=0"
check_contains "preserved local work preserves retry state" "$output" "reset_retry_calls=0"
check_contains "preserved local work requests attention" "$output" "attention=needs-user"
check_contains "preserved local work logs retention" "$output" "cleanup preserved local work"
check_not_contains "preserved local work skips remote cleanup" "$output" "push origin --delete"

output="$(run_cleanup_case archive-fails)"
check_contains "archive failure returns non-zero" "$output" "rc=1"
check_contains "archive failure stops before tmux/git" "$output" "order=archive;"
check_contains "archive failure preserves state" "$output" "remove_state_calls=0"
check_contains "archive failure warns" "$output" "could not archive stage artifacts"

output="$(run_cleanup_case worktree-fails)"
check_contains "worktree failure returns non-zero" "$output" "rc=1"
check_contains "worktree failure preserves state" "$output" "remove_state_calls=0"
check_contains "worktree failure preserves retry state" "$output" "reset_retry_calls=0"
check_not_contains "worktree failure skips branch deletion" "$output" "branch -D"
check_not_contains "worktree failure skips dynamic branch deletion" "$output" "branch -d"

output="$(run_cleanup_case local-branch-fails)"
check_contains "local branch failure returns non-zero" "$output" "rc=1"
check_contains "local branch failure preserves state" "$output" "remove_state_calls=0"
check_contains "local branch failure warns" "$output" "Local branch cleanup failed after worktree removal: task/task-slug"
check_not_contains "local branch failure skips remote cleanup" "$output" "push origin --delete"

output="$(run_cleanup_case push-fails)"
check_contains "push failure returns non-zero" "$output" "rc=1"
check_contains "push failure warns" "$output" "Remote branch cleanup failed (retained): task/task-slug"
check_contains "push failure preserves state" "$output" "remove_state_calls=0"
check_contains "push failure preserves retry state" "$output" "reset_retry_calls=0"

output="$(run_cleanup_case ls-remote-fails)"
check_contains "ls-remote failure returns non-zero" "$output" "rc=1"
check_contains "ls-remote failure warns" "$output" "Remote branch cleanup could not verify branch (retained): task/task-slug"
check_contains "ls-remote failure preserves state" "$output" "remove_state_calls=0"

output="$(run_protected_helper_case main)"
check_contains "helper refuses protected branch" "$output" "Refusing to delete protected branch: main"

output="$(run_protected_helper_case feature/demo)"
check_contains "helper retains non-task branch" "$output" "retaining non-task remote branch feature/demo"

output="$(run_common_dry_run_case)"
check_contains "common dry run reports worktree remove" "$output" "[DRY-RUN] git -C"
check_contains "common dry run reports remote delete" "$output" "[DRY-RUN] _with_timeout 5 git -C"
check_contains "common dry run includes push delete" "$output" "push origin --delete task/task-slug"

output="$(run_cleanup_case kill-persistent)"
check_contains "cleanup failure returns non-zero" "$output" "rc=1"
check_contains "cleanup failure preserves task state" "$output" "remove_state_calls=0"
check_contains "cleanup failure does not mark issue cleaned" "$output" "cleaned="
check_contains "cleanup failure requests attention" "$output" "attention=needs-user"
check_contains "cleanup failure warns about persistent window" "$output" "keeping task state"

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS assertions passed."
else
  echo "$FAIL assertion(s) failed; $PASS passed."
  exit 1
fi
