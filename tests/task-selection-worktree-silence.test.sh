#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

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

extract_nth_function() {
  local source_file="$1"
  local function_name="$2"
  local target_count="$3"
  awk -v name="$function_name" -v target="$target_count" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      count++
      if (count == target) {
        capture = 1
        depth = 0
      }
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

LAUNCH_FUNC_FILE="$TEST_TMP/launch_task.sh"
extract_function "$MONITOR_SCRIPT_FILE" "launch_task" > "$LAUNCH_FUNC_FILE"
if [[ ! -s "$LAUNCH_FUNC_FILE" ]]; then
  echo "Could not extract launch_task()"
  exit 1
fi

run_launch_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/$test_case"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$LAUNCH_FUNC_FILE"

    declare -Ag BRANCH_BY_ISSUE=()
    declare -Ag SLUG_BY_ISSUE=()

    SESSION="task-selection-test"
    ISSUE="HOK-1375"
    SLUG="suppress-output-in-task-selection-pane-when-starting-new-tasks"
    TITLE="Suppress output in task selection pane when starting new tasks"
    [[ "$TEST_CASE" == "empty_title" ]] && TITLE=""
    REPO_DIR="$CASE_DIR/repo"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    STATE_FILE="$CASE_DIR/state.json"
    TOOLS_DIR="$CASE_DIR/tools"
    BASE_BRANCH="main"
    AGENT_CMD="codex"
    AGENT_CMD_EXPLICIT="true"
    API_TIMEOUT=1
    PLANNING_MODE="interactive"
    MILL_LOG_FILE="$CASE_DIR/mill.log"

    mkdir -p "$REPO_DIR/.wavemill/logs" "$WORKTREE_ROOT" "$TOOLS_DIR"
    printf "{}\n" > "$STATE_FILE"
    : > "$MILL_LOG_FILE"
    cat > "/tmp/${SESSION}-${ISSUE}-issue.json" <<EOF
{"description":"Investigate pane noise","labels":{"nodes":[]}}
EOF

    LOG_OUTPUT=""
    LOG_ERROR_OUTPUT=""
    WRITE_STAGE_CALLS=""
    LAUNCH_PLANNING_CALLS=0

    get_linear_issue_id() { printf "%s\n" "$1"; }
    get_task_meta() { printf "\n"; }
    log() { LOG_OUTPUT+="$*\n"; }
    log_error() { LOG_ERROR_OUTPUT+="$*\n"; }
    log_warn() { LOG_OUTPUT+="warn $*\n"; }
    state_mutate() { :; }
    persist_task_window_id() { :; }
    _tmux_target_join() { printf "%s:%s\n" "$1" "$2"; }
    write_json_artifact() { :; }
    write_phase_config() { :; }
    record_planning_launch_route_snapshot() { :; }
    write_stage_result_with_history() { :; }
    is_task_packet() { return 1; }
    should_update_linear_state() { return 1; }
    linear_set_state() { :; }
    agent_validate() { return 0; }
    agent_validate_phase_launch() { return 0; }
    agent_is_native_cmd() { return 1; }
    agent_resolve_from_model() { printf "%s\n" "${1:-codex}"; }
    mark_task_needs_user_and_defer() { return 0; }
    SAVE_TITLE=""
    save_task_state() { SAVE_TITLE="${@: -1}"; }
    set_task_phase() { :; }
    set_window_attention_state() { :; }
    get_model_operating_mode() { printf "%s\n" "normal"; }
    read_route_json() { printf "\n"; }
    write_stage_result() { WRITE_STAGE_CALLS+="$*\n"; }
    tmux() { :; }
    launch_planning_phase() {
      LAUNCH_PLANNING_CALLS=$((LAUNCH_PLANNING_CALLS + 1))
      return 0
    }
    handle_phase_launch_result() { return 0; }
    ensure_worktree() {
      local branch="$1" wt="$2" repo="$3"
      mkdir -p "$(dirname "$wt")"
      git -C "$repo" worktree add "$wt" "$branch" >>"$MILL_LOG_FILE" 2>&1 || return $?
      printf "%s\n" "$wt"
    }

    git() {
      if [[ "${1:-}" == "-C" ]]; then
        shift 2
      fi
      case "${1:-}" in
        fetch)
          return 0
          ;;
        show-ref)
          case "$TEST_CASE" in
            resume_success) return 0 ;;
            *) return 1 ;;
          esac
          ;;
        worktree)
          printf "%s\n" "Preparing worktree (new branch '\''task/per-vendor-frontier-quota-telemetry'\'')" 
          printf "%s\n" "branch '\''task/per-vendor-frontier-quota-telemetry'\'' set up to track '\''origin/main'\''." >&2
          printf "%s\n" "HEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349)" >&2
          case "$TEST_CASE" in
            create_failure) return 1 ;;
            *) return 0 ;;
          esac
          ;;
        *)
          return 0
          ;;
      esac
    }

    set +e
    launch_task "$ISSUE" "$SLUG" "$TITLE" 1
    rc=$?
    set -e

    mill_log="$(tr "\n" ";" < "$MILL_LOG_FILE")"
    printf "rc=%s\nlaunch_planning_calls=%s\nsaved_title=%s\nmill_log=%s\nerror_logs=%s\nlogs=%s\n" \
      "$rc" "$LAUNCH_PLANNING_CALLS" "$SAVE_TITLE" "$mill_log" "$LOG_ERROR_OUTPUT" "$LOG_OUTPUT"
  ' 2>&1
}

run_cleanup_case() {
  local case_dir="$TEST_TMP/cleanup"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" COMMON_SCRIPT="$COMMON_SCRIPT" bash -lc '
    set -euo pipefail
    source "$COMMON_SCRIPT"

    SESSION="task-selection-test"
    ISSUE="HOK-1447"
    SLUG="stray-text-in-task-selector-pane"
    REPO_DIR="$CASE_DIR/repo"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    STATE_FILE="$CASE_DIR/state.json"
    MILL_LOG_FILE="$CASE_DIR/mill.log"

    mkdir -p "$REPO_DIR" "$WORKTREE_ROOT/$SLUG"
    printf "{\"tasks\":{\"$ISSUE\":{\"pr\":4242}}}\n" > "$STATE_FILE"
    : > "$MILL_LOG_FILE"

    declare -Ag CLEANED=()
    LOG_OUTPUT=""
    archive_stage_artifacts() { :; }
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { LOG_OUTPUT+="warn $*\n"; }
    reset_retry_count() { :; }
    remove_task_state() { :; }
    pr_state() { printf "%s\n" "MERGED"; }
    _with_timeout() { shift; "$@"; }
    tmux() { :; }

    git() {
      if [[ "${1:-}" == "-C" ]]; then
        shift 2
      fi
      case "${1:-}" in
        show-ref)
          return 0
          ;;
        worktree)
          case "${2:-}" in
            remove)
              printf "%s\n" "Removing worktree stray-text-in-task-selector-pane"
              ;;
            prune)
              printf "%s\n" "Pruned worktree administrative files"
              ;;
          esac
          return 0
          ;;
        branch)
          if [[ "${2:-}" == "-D" ]]; then
            printf "%s\n" "Deleted branch task/stray-text-in-task-selector-pane (was abc1234)."
            return 0
          fi
          ;;
        push)
          printf "%s\n" "To github.com:example/wavemill.git"
          printf "%s\n" " - [deleted] task/stray-text-in-task-selector-pane"
          return 0
          ;;
      esac
      return 0
    }

    cleanup_completed_task "$ISSUE" "$SLUG" "test cleanup"

    mill_log="$(tr "\n" ";" < "$MILL_LOG_FILE")"
    printf "mill_log=%s\nlogs=%s\n" "$mill_log" "$LOG_OUTPUT"
  ' 2>&1
}

echo "=== Task Selection Worktree Silence ==="

output="$(run_launch_case create_success)"
check_contains "create success returns 0" "$output" "rc=0"
check_contains "create success launches planning once" "$output" "launch_planning_calls=1"
check_contains "create success logs worktree noise to mill log" "$output" "mill_log=Preparing worktree (new branch 'task/per-vendor-frontier-quota-telemetry');branch 'task/per-vendor-frontier-quota-telemetry' set up to track 'origin/main'.;HEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349);"
# Needles use a leading \n to match standalone pane output. mill_log= uses ; separators,
# so noise stored there is never preceded by \n and won't trigger these checks.
check_not_contains "create success does not leak preparing line to pane" "$output" $'\nPreparing worktree (new branch '\''task/per-vendor-frontier-quota-telemetry'\'')'
check_not_contains "create success does not leak tracking line to pane" "$output" $'\nbranch '\''task/per-vendor-frontier-quota-telemetry'\'' set up to track '\''origin/main'\''.'
check_not_contains "create success does not leak head line to pane" "$output" $'\nHEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349)'

output="$(run_launch_case empty_title)"
check_contains "empty launch title persists an explicit fallback" "$output" "saved_title=Task"

output="$(run_launch_case resume_success)"
check_contains "resume success returns 0" "$output" "rc=0"
check_contains "resume success launches planning once" "$output" "launch_planning_calls=1"
check_contains "resume success logs worktree noise to mill log" "$output" "mill_log=Preparing worktree (new branch 'task/per-vendor-frontier-quota-telemetry');branch 'task/per-vendor-frontier-quota-telemetry' set up to track 'origin/main'.;HEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349);"
check_not_contains "resume success does not leak preparing line to pane" "$output" $'\nPreparing worktree (new branch '\''task/per-vendor-frontier-quota-telemetry'\'')'
check_not_contains "resume success does not leak tracking line to pane" "$output" $'\nbranch '\''task/per-vendor-frontier-quota-telemetry'\'' set up to track '\''origin/main'\''.'
check_not_contains "resume success does not leak head line to pane" "$output" $'\nHEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349)'

output="$(run_launch_case create_failure)"
check_contains "create failure returns 1" "$output" "rc=1"
check_contains "create failure does not launch planning" "$output" "launch_planning_calls=0"
check_contains "create failure logs worktree noise to mill log" "$output" "mill_log=Preparing worktree (new branch 'task/per-vendor-frontier-quota-telemetry');branch 'task/per-vendor-frontier-quota-telemetry' set up to track 'origin/main'.;HEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349);"
check_contains "create failure surfaces concise error" "$output" "error_logs=HOK-1375: worktree add failed (log: "
check_not_contains "create failure does not leak preparing line to pane" "$output" $'\nPreparing worktree (new branch '\''task/per-vendor-frontier-quota-telemetry'\'')'
check_not_contains "create failure does not leak tracking line to pane" "$output" $'\nbranch '\''task/per-vendor-frontier-quota-telemetry'\'' set up to track '\''origin/main'\''.'
check_not_contains "create failure does not leak head line to pane" "$output" $'\nHEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349)'

output="$(run_cleanup_case)"
check_contains "cleanup logs branch deletion noise to mill log" "$output" "mill_log=Removing worktree stray-text-in-task-selector-pane;Deleted branch task/stray-text-in-task-selector-pane (was abc1234).;To github.com:example/wavemill.git; - [deleted] task/stray-text-in-task-selector-pane;Pruned worktree administrative files;"
check_not_contains "cleanup does not leak branch deletion to pane" "$output" $'\nDeleted branch task/stray-text-in-task-selector-pane (was abc1234).'
check_not_contains "cleanup does not leak worktree remove to pane" "$output" $'\nRemoving worktree stray-text-in-task-selector-pane'
check_not_contains "cleanup does not leak remote deletion to pane" "$output" $'\n - [deleted] task/stray-text-in-task-selector-pane'
check_not_contains "cleanup does not leak worktree prune to pane" "$output" $'\nPruned worktree administrative files'

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS assertions passed."
  exit 0
else
  echo "$FAIL assertion(s) failed; $PASS passed."
  exit 1
fi
