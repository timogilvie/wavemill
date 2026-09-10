#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

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
      if (depth == 0) exit
    }
  ' "$source_file"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cleanup_file="$tmp/operator-abort-cleanup.sh"
{
  extract_function "$MILL_SCRIPT" "set_task_phase"
  printf '\n'
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
  extract_function "$COMMON_SCRIPT" "wavemill_cleanup_run"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_write_preserved_branch_incident"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "cleanup_outcome_is_safe"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "cleanup_outcome_is_retain"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "cleanup_outcome_is_failed"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_cleanup_operator_guidance"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_pr_aware_cleanup_enabled"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_fetch_pr_terminal_evidence"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_record_pr_delivery_evidence"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_record_cleanup_decision"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "branch_deletion_mode"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "branch_deletion_ledger_path"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_append_shadow_ledger"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "safe_remove_task_worktree_and_branch"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "remove_task_state"
  printf '\n'
  extract_function "$MONITOR_SCRIPT_FILE" "mark_task_aborted_for_cleanup"
  printf '\n'
  extract_function "$MONITOR_SCRIPT_FILE" "cleanup_aborted_challenge_arm"
} > "$cleanup_file"

run_operator_abort_case() {
  local test_case="$1"
  local pr="${2:-}"
  local case_dir="$tmp/$test_case"
  mkdir -p "$case_dir/repo" "$case_dir/worktrees/operator-abort-demo"

  CASE_DIR="$case_dir" CLEANUP_FILE="$cleanup_file" TEST_CASE="$test_case" TEST_PR="$pr" bash -lc '
    set -euo pipefail
    : "${WAVEMILL_BRANCH_DELETION_MODE:=enforce}"
    export WAVEMILL_BRANCH_DELETION_MODE
    source "$CLEANUP_FILE"
    wavemill_git_remote_with_timeout() { shift; git "$@"; }
    branch_deletion_mode() { printf "enforce\n"; }
    branch_deletion_ledger_path() { printf "%s\n" "$CASE_DIR/ledger.jsonl"; }
    _wavemill_append_shadow_ledger() { :; }

    SESSION="wavemill"
    ISSUE="HOK-2878"
    SLUG="operator-abort-demo"
    REPO_DIR="$CASE_DIR/repo"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    STATE_FILE="$CASE_DIR/state.json"
    MILL_LOG_FILE="$CASE_DIR/mill.log"
    mkdir -p "$WORKTREE_ROOT/$SLUG/features/$SLUG"
    cat > "$STATE_FILE" <<EOF
{"tasks":{"$ISSUE":{"slug":"$SLUG","branch":"task/$SLUG","worktree":"$WORKTREE_ROOT/$SLUG","status":"active","phase":"planning","pr":"$TEST_PR","challengeAborted":""}}}
EOF
    : > "$MILL_LOG_FILE"

    declare -Ag CLEANED=()
    ORDER=""
    WARN_OUTPUT=""
    LOG_OUTPUT=""
    KILLED=0
    GIT_CALLS=""
    ATTENTION=""

    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    set_window_attention_state() { ATTENTION="$2"; }
    reset_retry_count() { :; }
    archive_stage_artifacts() { ORDER+="archive;"; }
    read_state_value() {
      local default="$1"
      shift
      jq -r "$@" "$STATE_FILE" 2>/dev/null || printf "%s\n" "$default"
    }
    state_mutate() {
      local file="$1" filter="$2"
      shift 2
      ORDER+="state;"
      jq "$filter" "$@" "$file" > "$file.tmp"
      mv "$file.tmp" "$file"
    }
    _tmux_task_window_target() { printf "%s\n" "@42"; }
    _tmux_target_join() { printf "%s\n" "$2"; }
    _tmux_window_target_exists() { [[ "$KILLED" -eq 0 ]]; }
    tmux() {
      if [[ "${1:-}" == "kill-window" ]]; then
        ORDER+="tmux;"
        KILLED=1
      fi
      return 0
    }
    git() {
      if [[ "${1:-}" == "-C" ]]; then
        shift 2
      fi
      GIT_CALLS+="$*;"
      case "${1:-} ${2:-}" in
        "status --porcelain") return 0 ;;
        "worktree remove") ORDER+="git-worktree;" ; return 0 ;;
        "fetch origin") return 0 ;;
        "show-ref --verify") return 0 ;;
        "rev-parse --verify")
          case "${3:-}" in
            *operator-abort-demo*) printf "%s\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ;;
            *auto/integration*) printf "%s\n" "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ;;
            *) printf "%s\n" "cccccccccccccccccccccccccccccccccccccccc" ;;
          esac
          return 0
          ;;
        "merge-base --is-ancestor") return 0 ;;
        "rev-list --count") printf "0\n" ; return 0 ;;
        "rev-list "*) return 0 ;;
        "branch -D"|"branch -d") ORDER+="git-branch;" ; return 0 ;;
        "worktree prune") return 0 ;;
      esac
      return 0
    }

    set_task_phase "$ISSUE" "aborted"
    printf "after_set_phase=%s/%s\n" \
      "$(jq -r ".tasks[\"$ISSUE\"].phase" "$STATE_FILE")" \
      "$(jq -r ".tasks[\"$ISSUE\"].status" "$STATE_FILE")"

    task_status=$(read_state_value "" --arg issue "$ISSUE" ".tasks[\$issue].status // empty")
    challenge_aborted=$(read_state_value "" --arg issue "$ISSUE" ".tasks[\$issue].challengeAborted // empty")
    if [[ "$task_status" == "aborted" ]]; then
      cleanup_aborted_challenge_arm "$ISSUE" "$SLUG" "operator abort retry" || true
    fi

    printf "challenge_aborted=%s\n" "${challenge_aborted:-}"
    printf "order=%s\n" "$ORDER"
    printf "present=%s\n" "$(jq -r "has(\"tasks\") and (.tasks | has(\"$ISSUE\"))" "$STATE_FILE")"
    printf "cleaned=%s\n" "${CLEANED[$ISSUE]:-}"
    printf "git_calls=%s\n" "$GIT_CALLS"
    printf "attention=%s\n" "$ATTENTION"
    printf "warn=%s\n" "$WARN_OUTPUT"
    printf "log=%s\n" "$LOG_OUTPUT"
  '
}

output="$(run_operator_abort_case no-pr)"
[[ "$output" == *"after_set_phase=aborted/aborted"* ]] || { echo "$output"; echo "set_task_phase did not terminalize status" >&2; exit 1; }
[[ "$output" == *"challenge_aborted="* ]] || { echo "$output"; echo "challengeAborted should be empty in regression case" >&2; exit 1; }
[[ "$output" == *"present=false"* ]] || { echo "$output"; echo "operator-aborted no-PR task state was not removed" >&2; exit 1; }
[[ "$output" == *"cleaned=1"* ]] || { echo "$output"; echo "operator-aborted no-PR task not marked cleaned" >&2; exit 1; }
[[ "$output" == *"tmux;git-worktree;git-branch;"* ]] || { echo "$output"; echo "operator-aborted no-PR resources were not fully cleaned" >&2; exit 1; }

output="$(run_operator_abort_case with-pr 1234)"
[[ "$output" == *"after_set_phase=aborted/aborted"* ]] || { echo "$output"; echo "set_task_phase did not terminalize PR task status" >&2; exit 1; }
[[ "$output" == *"present=false"* ]] || { echo "$output"; echo "operator-aborted PR task state was not removed" >&2; exit 1; }
[[ "$output" == *"cleaned=1"* ]] || { echo "$output"; echo "operator-aborted PR task not marked cleaned" >&2; exit 1; }
[[ "$output" == *"tmux;"* ]] || { echo "$output"; echo "operator-aborted PR task window was not closed" >&2; exit 1; }
[[ "$output" != *"git-worktree"* && "$output" != *"git-branch"* ]] || { echo "$output"; echo "operator-aborted PR task should preserve worktree and local branch" >&2; exit 1; }
[[ "$output" == *"PR #1234 exists - preserving worktree and local branch"* ]] || { echo "$output"; echo "operator-aborted PR task did not explain preservation" >&2; exit 1; }

echo "operator-abort-cleanup test passed"
