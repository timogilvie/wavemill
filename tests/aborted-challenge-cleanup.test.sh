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

cleanup_file="$tmp/aborted-cleanup.sh"
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
  extract_function "$COMMON_SCRIPT" "wavemill_load_config"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "cleanup_episode_config_value"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_pr_aware_cleanup_enabled"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_branch_deletion_mode"
  printf '\n'
  printf '%s\n' 'WAVEMILL_CONTROLLER_OBSERVER_ARTIFACT=".wavemill/observer-findings.jsonl"'
  extract_function "$COMMON_SCRIPT" "wavemill_worktree_dirty_status"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_migrate_controller_observer_artifact"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_fetch_pr_terminal_evidence"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_record_pr_delivery_evidence"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_record_cleanup_decision"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "safe_remove_task_worktree_and_branch"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "monitor_deregister_terminal_task"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "remove_task_state"
  printf '\n'
  extract_function "$MONITOR_SCRIPT_FILE" "mark_task_aborted_for_cleanup"
  printf '\n'
  extract_function "$MONITOR_SCRIPT_FILE" "cleanup_aborted_challenge_arm"
  printf '\n'
  extract_function "$MONITOR_SCRIPT_FILE" "task_has_local_commit_evidence"
  printf '\n'
  extract_function "$MONITOR_SCRIPT_FILE" "should_skip_post_completion_eval"
} > "$cleanup_file"

run_cleanup_case() {
  local test_case="$1"
  local case_dir="$tmp/$test_case"
  mkdir -p "$case_dir/repo" "$case_dir/worktrees/demo-challenger"

  CASE_DIR="$case_dir" CLEANUP_FILE="$cleanup_file" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$CLEANUP_FILE"
    wavemill_git_remote_with_timeout() { shift; git "$@"; }

    SESSION="wavemill"
    ISSUE="HOK-2839_c"
    SLUG="demo-challenger"
    REPO_DIR="$CASE_DIR/repo"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    STATE_FILE="$CASE_DIR/state.json"
    MILL_LOG_FILE="$CASE_DIR/mill.log"
    BASE_BRANCH="auto/integration"
    AUTO_EVAL=true
    AGENT_CMD=codex
    mkdir -p "$WORKTREE_ROOT/$SLUG/features/$SLUG"
    printf "%s\n" "{\"cleanup\":{\"branchDeletion\":{\"enabled\":true,\"mode\":\"enforce\"}}}" > "$REPO_DIR/.wavemill-config.json"
    printf "{\"reason\":\"failed\"}\n" > "$WORKTREE_ROOT/$SLUG/features/$SLUG/.challenge-aborted.json"
    printf "{\"transcriptPath\":\"native-session.jsonl\"}\n" > "$WORKTREE_ROOT/$SLUG/features/$SLUG/.coding-failure-handoff.json"
    printf "{}\n" > "$WORKTREE_ROOT/$SLUG/features/$SLUG/native-session.jsonl"
    cat > "$STATE_FILE" <<EOF
{"tasks":{"$ISSUE":{"slug":"$SLUG","branch":"task/$SLUG","worktree":"$WORKTREE_ROOT/$SLUG","status":"active","phase":"coding","pr":"","challengeRole":"challenger","challengeAborted":"terminal_stage_failure"}}}
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
    archive_stage_artifacts() {
      ORDER+="archive;"
      mkdir -p "$REPO_DIR/.wavemill/evals/artifacts/$1"
      cp "$WORKTREE_ROOT/$2/features/$2/.challenge-aborted.json" "$REPO_DIR/.wavemill/evals/artifacts/$1/.challenge-aborted.json"
      cp "$WORKTREE_ROOT/$2/features/$2/.coding-failure-handoff.json" "$REPO_DIR/.wavemill/evals/artifacts/$1/.coding-failure-handoff.json"
    }
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
    _tmux_task_window_target() { printf "%s\n" "@31"; }
    _tmux_target_join() { printf "%s\n" "$2"; }
    _tmux_window_target_exists() {
      [[ "$TEST_CASE" == "persistent-window" && "$KILLED" -eq 1 ]]
    }
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
            *demo-challenger*) printf "%s\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ;;
            *auto/integration*) printf "%s\n" "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ;;
            *) printf "%s\n" "cccccccccccccccccccccccccccccccccccccccc" ;;
          esac
          return 0
          ;;
        "merge-base --is-ancestor")
          [[ "$TEST_CASE" != "preserved-local-work" ]]
          return $?
          ;;
        "rev-list --count")
          if [[ "$TEST_CASE" == "preserved-local-work" ]]; then
            printf "1\n"
          else
            printf "0\n"
          fi
          return 0
          ;;
        "rev-list "*)
          if [[ "$TEST_CASE" == "preserved-local-work" ]]; then
            printf "%s\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          fi
          return 0
          ;;
        "ls-remote --heads") return 0 ;;
        "branch -D"|"branch -d") ORDER+="git-branch;" ; return 0 ;;
        "worktree prune") return 0 ;;
      esac
      return 0
    }

    cleanup_aborted_challenge_arm "$ISSUE" "$SLUG" "test abort" || true
    printf "order=%s\n" "$ORDER"
    printf "present=%s\n" "$(jq -r "has(\"tasks\") and (.tasks | has(\"$ISSUE\"))" "$STATE_FILE")"
    printf "status=%s\n" "$(jq -r ".tasks[\"$ISSUE\"].status" "$STATE_FILE")"
    printf "phase=%s\n" "$(jq -r ".tasks[\"$ISSUE\"].phase" "$STATE_FILE")"
    printf "cleaned=%s\n" "${CLEANED[$ISSUE]:-}"
    printf "git_calls=%s\n" "$GIT_CALLS"
    printf "attention=%s\n" "$ATTENTION"
    printf "skip_eval=%s\n" "$(should_skip_post_completion_eval "$ISSUE" "" "task/$SLUG" "$SLUG" && echo yes || echo no)"
    [[ -f "$REPO_DIR/.wavemill/evals/artifacts/$ISSUE/.challenge-aborted.json" ]] && printf "archived_abort=yes\n"
    [[ -f "$REPO_DIR/.wavemill/evals/artifacts/$ISSUE/.coding-failure-handoff.json" ]] && printf "archived_handoff=yes\n"
  '
}

output="$(run_cleanup_case success)"
[[ "$output" == *"order=archive;state;tmux;git-worktree;git-branch;state;"* ]] || { echo "$output"; echo "cleanup order wrong" >&2; exit 1; }
[[ "$output" == *"present=false"* ]] || { echo "$output"; echo "task state was not removed" >&2; exit 1; }
[[ "$output" == *"cleaned=1"* ]] || { echo "$output"; echo "task not marked cleaned" >&2; exit 1; }
[[ "$output" == *"skip_eval=yes"* ]] || { echo "$output"; echo "eval guard did not skip" >&2; exit 1; }
[[ "$output" == *"archived_abort=yes"* && "$output" == *"archived_handoff=yes"* ]] || { echo "$output"; echo "failure artifacts missing" >&2; exit 1; }

output="$(run_cleanup_case persistent-window)"
[[ "$output" == *"present=true"* ]] || { echo "$output"; echo "persistent window should keep task state" >&2; exit 1; }
[[ "$output" == *"status=aborted"* ]] || { echo "$output"; echo "persistent window did not terminalize" >&2; exit 1; }
[[ "$output" == *"phase=aborted"* ]] || { echo "$output"; echo "persistent window phase not terminal" >&2; exit 1; }
[[ "$output" == *"attention=needs-user"* ]] || { echo "$output"; echo "persistent window did not request attention" >&2; exit 1; }
[[ "$output" != *"git-worktree"* ]] || { echo "$output"; echo "persistent window should not remove worktree" >&2; exit 1; }

output="$(run_cleanup_case preserved-local-work)"
[[ "$output" == *"present=true"* ]] || { echo "$output"; echo "preserved local work should keep task state" >&2; exit 1; }
[[ "$output" == *"status=aborted"* ]] || { echo "$output"; echo "preserved local work did not terminalize" >&2; exit 1; }
[[ "$output" == *"phase=aborted"* ]] || { echo "$output"; echo "preserved local work phase not terminal" >&2; exit 1; }
[[ "$output" == *"attention=needs-user"* ]] || { echo "$output"; echo "preserved local work did not request attention" >&2; exit 1; }
[[ "$output" != *"cleaned=1"* ]] || { echo "$output"; echo "preserved local work should not be marked cleaned" >&2; exit 1; }

echo "aborted-challenge-cleanup test passed"
