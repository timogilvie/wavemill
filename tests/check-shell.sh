#!/usr/bin/env bash
set -euo pipefail

# Shell Script Validation Tests
# Checks bash syntax and verifies heredoc function availability
# to prevent the bug class from PRs 48 and 52 (undefined functions
# in the standalone monitor script).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$REPO_DIR/shared/lib"

PASS=0
FAIL=0
SKIP=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP  $1"; SKIP=$((SKIP + 1)); }

# Runs independent fixture scripts concurrently, then reports them in the order
# given so output and counters stay deterministic.
#
# Safe to parallelize because each fixture runs as its own bash process: names
# derived from $$ are unique per fixture, and fixture roots come from mktemp.
# Fixtures that share a fixed resource (the monitor_pr_cache_* pair reuse one
# tmux session name) must NOT be run through this helper.
#
# Results are collected in subshells and reported from the parent, because
# pass/fail/skip mutate counters that would be lost in a subshell.
run_fixtures_parallel() {
  local fixtures=("$@")
  local max_jobs="${WAVEMILL_FIXTURE_JOBS:-4}"
  local work idx=0 launched=0 fixture name rc out

  work="$(mktemp -d "/tmp/wavemill-fixtures.XXXXXX")"

  for fixture in "${fixtures[@]}"; do
    if [[ -f "$fixture" ]]; then
      (
        set +e
        fixture_out="$(bash "$fixture" 2>&1)"
        printf '%s' "$?" > "$work/$idx.rc"
        printf '%s' "$fixture_out" > "$work/$idx.out"
      ) &
      launched=$((launched + 1))
      # Batch rather than `wait -n`, which needs bash 4.3+ (macOS ships 3.2).
      if (( launched % max_jobs == 0 )); then
        wait || true
      fi
    fi
    idx=$((idx + 1))
  done
  wait || true

  idx=0
  for fixture in "${fixtures[@]}"; do
    name="$(basename "$fixture")"
    if [[ ! -f "$fixture" ]]; then
      fail "Missing fixture $name"
    else
      rc="$(cat "$work/$idx.rc" 2>/dev/null || echo 1)"
      out="$(cat "$work/$idx.out" 2>/dev/null || true)"
      if [[ "$out" == SKIP:* ]]; then
        skip "$name: ${out#SKIP: }"
      elif [[ "$rc" == "0" ]]; then
        pass "$name"
      else
        fail "$name: $out"
      fi
    fi
    idx=$((idx + 1))
  done

  rm -rf "$work"
}

# ============================================================================
# TEST 1: Bash syntax check on all shell scripts
# ============================================================================
echo "=== Syntax Check (bash -n) ==="

for f in \
  "$LIB_DIR"/wavemill-*.sh \
  "$LIB_DIR"/bounded-retry.sh \
  "$LIB_DIR"/challenge-arms.sh \
  "$LIB_DIR"/transient-marker.sh \
  "$LIB_DIR"/terminal-reconciler.sh \
  "$LIB_DIR"/startup-terminal-preflight.sh \
  "$LIB_DIR"/startup-progress.sh \
  "$LIB_DIR"/agent-adapters.sh \
  "$REPO_DIR"/shared/hooks/*.sh \
  "$REPO_DIR"/shared/agent-bin/tmux \
  "$REPO_DIR"/tests/dashboard-refresh.test.sh \
  "$REPO_DIR"/tests/state-mutex.test.sh \
  "$REPO_DIR"/tests/task-id-log-prefix.test.sh \
  "$REPO_DIR"/tests/log-hygiene.test.sh \
  "$REPO_DIR"/tests/project-context-suggestion.test.sh \
  "$REPO_DIR"/tests/wavemill-usage-tips.test.sh \
  "$REPO_DIR"/tests/wavemill-dependent-launch.test.sh \
  "$REPO_DIR"/tests/wavemill-guards.test.sh \
  "$REPO_DIR"/tests/dashboard-incidents-section.test.sh \
  "$REPO_DIR"/tests/review-scope-baseline-handoff.test.sh \
  "$REPO_DIR"/tests/wavemill-mill-advance.test.sh \
  "$REPO_DIR"/tests/wavemill-backlog-budget.test.sh \
  "$REPO_DIR"/tests/wavemill-dependency-queue-filter.test.sh \
  "$REPO_DIR"/tests/wavemill-backlog-pane-no-flash.test.sh \
  "$REPO_DIR"/tests/wavemill-mill-model-flags.test.sh \
  "$REPO_DIR"/tests/wavemill-mill-config-preflight.test.sh \
  "$REPO_DIR"/tests/wavemill-mill-router-fallback.test.sh \
  "$REPO_DIR"/tests/backstage-tend-watchdog.test.sh \
  "$REPO_DIR"/tests/backstage-observer-watchdog.test.sh \
  "$REPO_DIR"/tests/backstage-observer-pane-promotion.test.sh \
  "$REPO_DIR"/tests/model-inheritance-chain.test.sh \
  "$REPO_DIR"/tests/wavemill-background-jobs-cleanup.test.sh \
  "$REPO_DIR"/tests/global-model-parity.test.sh \
  "$REPO_DIR"/tests/queue-health.test.sh \
  "$REPO_DIR"/tests/merge-queue-live-ci.test.sh \
  "$REPO_DIR"/tests/merge-lane-progress-artifacts.test.sh \
  "$REPO_DIR"/tests/notification-waiting.test.sh \
  "$REPO_DIR"/tests/hook-osc-emit.test.sh \
  "$REPO_DIR"/tests/hook-write-context-guard.test.sh \
  "$REPO_DIR"/tests/claude-tmux-server-guard.test.sh \
  "$REPO_DIR"/tests/agent-tmux-runtime-guard.test.sh \
  "$REPO_DIR"/tests/terminal-reconciler.test.sh \
  "$REPO_DIR"/tests/startup-terminal-preflight.test.sh \
  "$REPO_DIR"/tests/fresh-launch-terminal-preflight.test.sh \
  "$REPO_DIR"/tests/startup-cleanup-integration.test.sh \
  "$REPO_DIR"/tests/challenge-intent-roundtrip.test.sh \
  "$REPO_DIR"/tests/challenge-varied-model-abort.test.sh \
  "$REPO_DIR"/tests/challenge-record-decisive.test.sh \
  "$REPO_DIR"/tests/native-terminal-failure.test.sh \
  "$REPO_DIR"/tests/native-failure-classification.test.sh \
  "$REPO_DIR"/tests/challenger-transient-retry.test.sh \
  "$REPO_DIR"/tests/challenge-deferred-arm.test.sh \
  "$REPO_DIR"/tests/parent-monitor-function-drift.test.sh \
  "$REPO_DIR"/tests/linear-state-canonicalization.test.sh \
  "$REPO_DIR"/tests/task-phase-canonicalization.test.sh \
  "$REPO_DIR"/tests/pr-state-merge-canonicalization.test.sh \
  "$REPO_DIR"/tests/with-timeout.test.sh \
  "$REPO_DIR"/tests/aborted-challenge-cleanup.test.sh \
  "$REPO_DIR"/tests/safe-branch-cleanup.test.sh \
  "$REPO_DIR"/tests/challenge-primary-merge-cleanup.test.sh \
  "$REPO_DIR"/tests/operator-abort-cleanup.test.sh \
  "$REPO_DIR"/tests/transient-marker.test.sh \
  "$REPO_DIR"/tests/startup-terminal-prune.test.sh \
  "$REPO_DIR"/tests/archive-stage-artifacts.test.sh \
  "$REPO_DIR"/tests/completed-task-cleanup.test.sh \
  "$REPO_DIR"/tests/native-agent-shell-operators.test.sh \
  "$REPO_DIR"/tests/hokusai-test-registration.test.sh \
  "$REPO_DIR"/tests/monitor-script-byte-identical.test.sh \
  "$REPO_DIR"/tests/bounded-retry.test.sh \
  "$REPO_DIR"/tests/handle-phase-launch-result.test.sh \
  "$REPO_DIR"/tests/launch-pane-liveness.test.sh \
  "$REPO_DIR"/tests/launch-failure-log-capture.test.sh \
  "$REPO_DIR"/tests/challenge-eval-soft-retry.test.sh \
  "$REPO_DIR"/tests/challenge-eval-timeout.test.sh \
  "$REPO_DIR"/tests/run-shell-suite.sh \
  "$REPO_DIR"/tests/run-unit-tests.sh \
  "$REPO_DIR"/tests/run-custom-tests.sh \
  "$REPO_DIR"/tests/run-custom-tests-shard.test.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/startup_launches_concurrently.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/startup_serializes_state_writes.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/worktree_collision.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/input_reader_translates_keystrokes.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/input_reader_pane_respawn.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/mill_dry_run_full_pipeline.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/monitor_consumes_command_file.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/parent_pr_triggers_child_launch.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/parent_branch_missing_fails_clearly.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/closed_primary_pr_cleanup.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/closed_primary_sibling_merged_marks_done.sh \
  "$REPO_DIR"/tests/fixtures/lifecycle/coding_agent_exit_interrupted.sh \
  "$REPO_DIR"/tests/incident-fixtures-terminal-panes.test.sh \
  "$REPO_DIR"/tests/incident-fixtures-safety-controls.test.sh \
  "$REPO_DIR"/tests/lib/incident-fixture-harness.sh \
  "$REPO_DIR"/tests/lib/terminal-lifecycle-cert-harness.sh \
  "$REPO_DIR"/tests/terminal-lifecycle-cert-matrix.test.sh \
  "$REPO_DIR"/tests/terminal-lifecycle-cert-restart.test.sh \
  "$REPO_DIR"/tests/terminal-lifecycle-cert-budgets.test.sh \
  "$REPO_DIR"/tests/terminal-lifecycle-flags.test.sh \
  "$REPO_DIR"/tests/fixtures/terminal-lifecycle/merge_commit_delivery.sh \
  "$REPO_DIR"/tests/fixtures/terminal-lifecycle/squash_delivery.sh \
  "$REPO_DIR"/tests/fixtures/terminal-lifecycle/rebase_delivery.sh \
  "$REPO_DIR"/tests/fixtures/terminal-lifecycle/changed_after_review_head.sh \
  "$REPO_DIR"/tests/fixtures/terminal-lifecycle/merged_pr_plain.sh \
  "$REPO_DIR"/tests/fixtures/incidents/hok2595_closed_non_challenge.sh \
  "$REPO_DIR"/tests/fixtures/incidents/hok2913c_superseded_challenger.sh \
  "$REPO_DIR"/tests/fixtures/incidents/squash_delivery_deleted_remote_head.sh \
  "$REPO_DIR"/tests/fixtures/incidents/control_dirty_worktree.sh \
  "$REPO_DIR"/tests/fixtures/incidents/control_local_head_changed.sh \
  "$REPO_DIR"/tests/fixtures/incidents/control_divergent_local_ahead.sh \
  "$REPO_DIR"/tests/fixtures/incidents/control_missing_network.sh \
  "$REPO_DIR"/tests/fixtures/incidents/control_never_pushed.sh \
  "$REPO_DIR/wavemill" \
; do
  if [[ ! -f "$f" ]]; then
    fail "File not found: $f"
    continue
  fi
  if bash -n "$f" 2>/dev/null; then
    pass "$(basename "$f")"
  else
    fail "$(basename "$f") has syntax errors"
  fi
done

# ============================================================================
# TEST 1A: Launcher attach shutdown handling
# ============================================================================
echo ""
echo "=== Launcher Attach Shutdown ==="

if grep -q '_WAVEMILL_MILL_REEXEC' "$LIB_DIR/wavemill-mill.sh" \
  && grep -q 'WAVEMILL_MILL_LIB_DIR' "$LIB_DIR/wavemill-mill.sh"; then
  pass "launcher copies itself to /tmp before execution"
else
  fail "launcher is missing the /tmp self-copy guard"
fi

if grep -q 'mktemp /tmp/wavemill-mill\.XXXXXX' "$LIB_DIR/wavemill-mill.sh" \
  && ! grep -q 'mktemp /tmp/wavemill-mill-XXXXXX\.sh' "$LIB_DIR/wavemill-mill.sh"; then
  pass "launcher self-copy mktemp template is BSD-compatible"
else
  fail "launcher self-copy mktemp template is not BSD-compatible"
fi

ATTACH_BLOCK=$(awk '
  /^sleep 1$/ { in_block=1 }
  in_block { print }
  /Session ended\. Run/ { in_block=0 }
' "$LIB_DIR/wavemill-mill.sh")
if grep -q 'set +e' <<< "$ATTACH_BLOCK" \
  && grep -q 'tmux attach -t "$SESSION"' <<< "$ATTACH_BLOCK" \
  && grep -q 'attach_rc=$?' <<< "$ATTACH_BLOCK" \
  && grep -q 'set -e' <<< "$ATTACH_BLOCK"; then
  pass "launcher handles non-zero tmux attach during normal shutdown"
else
  fail "launcher tmux attach is not guarded against normal shutdown exit codes"
fi

echo ""
echo "=== Remote Git Timeout Guards ==="

if grep -q 'wavemill_git_remote_with_timeout()' "$LIB_DIR/wavemill-common.sh" \
  && grep -q 'wavemill_git_remote_timeout_seconds()' "$LIB_DIR/wavemill-common.sh"; then
  pass "shared remote git timeout helper exists"
else
  fail "shared remote git timeout helper is missing"
fi

if grep -q 'wavemill_git_remote_with_timeout .*fetch origin' "$LIB_DIR/wavemill-common.sh" \
  && ! grep -q 'git -C "\$REPO_DIR" fetch origin "\$base_branch"' "$LIB_DIR/wavemill-common.sh"; then
  pass "base branch fetch uses timeout helper"
else
  fail "base branch fetch is missing the timeout helper"
fi

echo ""
echo "=== Backstage Observer Service Guards ==="

if grep -q 'WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE' "$LIB_DIR/wavemill-common.sh" \
  && grep -q 'wavemill_build_observer_loop_command' "$LIB_DIR/wavemill-common.sh" \
  && grep -q 'WAVEMILL_OBSERVER_SERVICE=1' "$LIB_DIR/wavemill-common.sh"; then
  pass "observer service launch helper exists"
else
  fail "observer service launch helper is missing"
fi

observer_helper="$(awk '/^wavemill_build_observer_loop_command\(\) \{/{capture=1} capture{print} capture && /^}/{exit}' "$LIB_DIR/wavemill-common.sh")"
if [[ "$observer_helper" == *'--dry-run'* && "$observer_helper" != *'--file-linear'* ]]; then
  pass "observer service launch is detection-only"
else
  fail "observer service launch is not detection-only"
fi

health_writer="$(awk '/^wavemill_write_backstage_service_health\(\) \{/{capture=1} capture{print} capture && /^}/{exit}' "$LIB_DIR/wavemill-common.sh")"
if [[ "$health_writer" == *'state_mutate "$path"'* ]]; then
  pass "backstage service health writes use state_mutate"
else
  fail "backstage service health writer does not use state_mutate"
fi

if grep -q 'wavemill_git_remote_with_timeout .*ls-remote origin' "$LIB_DIR/wavemill-monitor.sh" \
  && ! grep -q 'git -C "\$wt_dir" ls-remote origin "refs/heads/\${base_branch}"' "$LIB_DIR/wavemill-monitor.sh"; then
  pass "main head probe uses timeout helper"
else
  fail "main head probe is missing the timeout helper"
fi

if grep -q 'write_shell_assignment "WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS"' "$REPO_DIR/shared/lib/wavemill-startup-runner.sh"; then
  pass "monitor env exports WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS"
else
  fail "monitor env does not export WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS"
fi

# ============================================================================
# TEST 1B: State mutation helper behavior
# ============================================================================
echo ""
echo "=== State Mutation Helper ==="

state_mutex_output="$(bash "$REPO_DIR/tests/state-mutex.test.sh" 2>&1)" || state_mutex_status=$?
state_mutex_status="${state_mutex_status:-0}"
if [[ "$state_mutex_status" -eq 0 ]]; then
  pass "state_mutate serializes JSON state updates"
else
  fail "state_mutate behavior: $state_mutex_output"
fi
unset state_mutex_status

if command -v zsh >/dev/null 2>&1; then
  state_mutate_zsh_output="$(
    REPO_DIR="$REPO_DIR" zsh -f -c '
      state_file="$(mktemp "${TMPDIR:-/tmp}/wavemill-zsh-state.XXXXXX")" || exit 1
      print -r -- "{\"tasks\":{}}" > "$state_file"
      source "$REPO_DIR/shared/lib/wavemill-common.sh"
      state_mutate "$state_file" ".tasks.test.value = 1" >/dev/null || exit 1
      jq -e ".tasks.test.value == 1" "$state_file" >/dev/null
    ' 2>&1
  )" || state_mutate_zsh_status=$?
  state_mutate_zsh_status="${state_mutate_zsh_status:-0}"
  if [[ "$state_mutate_zsh_status" -eq 0 ]]; then
    pass "state_mutate works when sourced from zsh"
  else
    fail "state_mutate zsh compatibility: $state_mutate_zsh_output"
  fi
  unset state_mutate_zsh_status
else
  skip "state_mutate zsh compatibility (zsh unavailable)"
fi

echo ""
echo "=== Backlog Budget ==="

backlog_budget_output="$(bash "$REPO_DIR/tests/wavemill-backlog-budget.test.sh" 2>&1)" || backlog_budget_status=$?
backlog_budget_status="${backlog_budget_status:-0}"
if [[ "$backlog_budget_status" -eq 0 ]]; then
  pass "backlog budget rendering behavior"
else
  fail "backlog budget rendering behavior: $backlog_budget_output"
fi
unset backlog_budget_status

echo ""
echo "=== Dependency Queue Filter ==="

dependency_queue_output="$(bash "$REPO_DIR/tests/wavemill-dependency-queue-filter.test.sh" 2>&1)" || dependency_queue_status=$?
dependency_queue_status="${dependency_queue_status:-0}"
if [[ "$dependency_queue_status" -eq 0 ]]; then
  pass "dependency queue filter behavior"
else
  fail "dependency queue filter behavior: $dependency_queue_output"
fi
unset dependency_queue_status

echo ""
echo "=== Dependent Launch ==="

dependent_launch_output="$(bash "$REPO_DIR/tests/wavemill-dependent-launch.test.sh" 2>&1)" || dependent_launch_status=$?
dependent_launch_status="${dependent_launch_status:-0}"
if [[ "$dependent_launch_status" -eq 0 ]]; then
  pass "dependent task launch lifecycle"
else
  fail "dependent task launch lifecycle: $dependent_launch_output"
fi
unset dependent_launch_status

echo ""
echo "=== Task Log Prefix ==="

task_log_prefix_output="$(bash "$REPO_DIR/tests/task-id-log-prefix.test.sh" 2>&1)" || task_log_prefix_status=$?
task_log_prefix_status="${task_log_prefix_status:-0}"
if [[ "$task_log_prefix_status" -eq 0 ]]; then
  pass "task id log prefix formatter behavior"
else
  fail "task id log prefix formatter behavior: $task_log_prefix_output"
fi
unset task_log_prefix_status

echo ""
echo "=== Project Context Suggestion ==="

project_context_suggestion_output="$(bash "$REPO_DIR/tests/project-context-suggestion.test.sh" 2>&1)" || project_context_suggestion_status=$?
project_context_suggestion_status="${project_context_suggestion_status:-0}"
if [[ "$project_context_suggestion_status" -eq 0 ]]; then
  pass "project context suggestion lifecycle"
else
  fail "project context suggestion lifecycle: $project_context_suggestion_output"
fi
unset project_context_suggestion_status

echo ""
echo "=== Background Jobs Cleanup ==="

background_jobs_cleanup_output="$(bash "$REPO_DIR/tests/wavemill-background-jobs-cleanup.test.sh" 2>&1)" || background_jobs_cleanup_status=$?
background_jobs_cleanup_status="${background_jobs_cleanup_status:-0}"
if [[ "$background_jobs_cleanup_status" -eq 0 ]]; then
  pass "background jobs cleanup lifecycle"
else
  fail "background jobs cleanup lifecycle: $background_jobs_cleanup_output"
fi
unset background_jobs_cleanup_status

echo ""
echo "=== Notification → waiting (Claude hook adapter) ==="

notification_waiting_output="$(bash "$REPO_DIR/tests/notification-waiting.test.sh" 2>&1)" || notification_waiting_status=$?
notification_waiting_status="${notification_waiting_status:-0}"
if [[ "$notification_waiting_status" -eq 0 ]]; then
  pass "Claude Notification events map to waiting state"
else
  fail "Claude Notification → waiting behavior: $notification_waiting_output"
fi
unset notification_waiting_status

echo ""
echo "=== Hook OSC Emission ==="

hook_osc_emit_output="$(bash "$REPO_DIR/tests/hook-osc-emit.test.sh" 2>&1)" || hook_osc_emit_status=$?
hook_osc_emit_status="${hook_osc_emit_status:-0}"
if [[ "$hook_osc_emit_status" -eq 0 ]]; then
  pass "hook OSC emission fan-out behavior"
else
  fail "hook OSC emission behavior: $hook_osc_emit_output"
fi
unset hook_osc_emit_status

echo ""
echo "=== Worktree Dependency Fast Path ==="

worktree_deps_output="$(bash "$REPO_DIR/tests/wavemill-worktree-deps.test.sh" 2>&1)" || worktree_deps_status=$?
worktree_deps_status="${worktree_deps_status:-0}"
if [[ "$worktree_deps_status" -eq 0 ]]; then
  pass "worktree dependency fast-path behavior"
else
  fail "worktree dependency fast-path behavior: $worktree_deps_output"
fi
unset worktree_deps_status

# ============================================================================
# TEST 2: Heredoc function-availability check
# ============================================================================
# The monitor script in wavemill-mill.sh is generated as a standalone bash
# script via heredoc. It does NOT inherit functions from the parent shell.
# Every function it calls must be:
#   (a) defined inline in the heredoc, OR
#   (b) defined in agent-adapters.sh (which is sourced), OR
#   (c) an external command or bash builtin
#
# This test extracts the heredoc, parses function definitions and calls,
# and flags any function called but not defined.

echo ""
echo "=== Heredoc Function Availability (wavemill-mill.sh monitor script) ==="

MILL_SCRIPT="$LIB_DIR/wavemill-mill.sh"
MONITOR_FILE="$LIB_DIR/wavemill-monitor.sh"

if [[ ! -f "$MILL_SCRIPT" || ! -f "$LIB_DIR/wavemill-monitor.sh" ]]; then
  fail "wavemill-mill.sh or wavemill-monitor.sh not found"
else
  # Read the committed monitor script (formerly embedded as a MONITOR_EOF heredoc)
  HEREDOC_CONTENT=$(cat "$LIB_DIR/wavemill-monitor.sh")

  if [[ -z "$HEREDOC_CONTENT" ]]; then
    fail "Could not read monitor content from wavemill-monitor.sh"
  else
    # Use the same bash as the generated script shebang, but fall back for CI/non-macOS systems.
    MONITOR_BASH="/opt/homebrew/bin/bash"
    if [[ ! -x "$MONITOR_BASH" ]]; then
      MONITOR_BASH="bash"
    fi

    MONITOR_TMP=$(mktemp /tmp/wavemill-monitor-check-XXXXXX.sh)
    printf '%s\n' "$HEREDOC_CONTENT" > "$MONITOR_TMP"
    if "$MONITOR_BASH" -n "$MONITOR_TMP" 2>/dev/null; then
      pass "monitor script heredoc has no syntax errors (bash -n)"
    else
      fail "monitor script heredoc has syntax errors: $("$MONITOR_BASH" -n "$MONITOR_TMP" 2>&1 | head -5)"
    fi
    rm -f "$MONITOR_TMP"

    # Extract function definitions from the heredoc (name followed by () with optional space and {)
    HEREDOC_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' <<< "$HEREDOC_CONTENT" | sed 's/()//' | sort -u)

    # Extract function definitions from agent-adapters.sh (sourced by the heredoc)
    ADAPTER_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/agent-adapters.sh" | sed 's/()//' | sort -u)

    # Extract function definitions from wavemill-common.sh (also sourced by monitor)
    COMMON_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/wavemill-common.sh" | sed 's/()//' | sort -u)

    # Extract function definitions from bounded-retry.sh (sourced by wavemill-common.sh)
    BOUNDED_RETRY_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/bounded-retry.sh" | sed 's/()//' | sort -u)

    # Extract function definitions from challenge-arms.sh (also sourced by wavemill-common.sh, HOK-2811)
    CHALLENGE_ARMS_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/challenge-arms.sh" | sed 's/()//' | sort -u)

    # Extract function definitions from the hook protocol sourced by common helpers.
    HOOK_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh" | sed 's/()//' | sort -u)

    # Extract function definitions from queue-health.sh (also sourced by monitor)
    QUEUE_HEALTH_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/queue-health.sh" | sed 's/()//' | sort -u)

    # Extract function definitions from transient-marker.sh (also sourced by monitor)
    MARKER_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/transient-marker.sh" | sed 's/()//' | sort -u)

    # Extract function definitions from terminal-reconciler.sh (also sourced by monitor)
    RECONCILER_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/terminal-reconciler.sh" | sed 's/()//' | sort -u)

    # Extract function definitions from wavemill-worktree-deps.sh (sourced by monitor, HOK-2811)
    WORKTREE_DEPS_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/wavemill-worktree-deps.sh" | sed 's/()//' | sort -u)

    # Combine all available function definitions
    ALL_DEFINED=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s' "$HEREDOC_FUNCS" "$ADAPTER_FUNCS" "$COMMON_FUNCS" "$BOUNDED_RETRY_FUNCS" "$CHALLENGE_ARMS_FUNCS" "$HOOK_FUNCS" "$QUEUE_HEALTH_FUNCS" "$MARKER_FUNCS" "$RECONCILER_FUNCS" "$WORKTREE_DEPS_FUNCS" | sort -u)

    # Known external commands and bash builtins that are NOT custom functions
    # This list covers standard utilities, coreutils, and tools used by wavemill
    KNOWN_EXTERNALS="bash|cat|cd|chmod|column|command|continue|cut|date|declare|diff|dirname|echo|eval|exec|exit|export|false|find|fold|git|grep|gh|head|jq|kill|local|ls|mkdir|mktemp|mv|node|npx|printf|ps|pwd|read|readlink|return|rm|rmdir|sed|set|shift|sleep|sort|source|sqlite3|stat|tail|tee|test|tmux|touch|tr|trap|true|tput|tsx|type|to_entries|uniq|unset|wait|wc|xargs|basename|awk|seq|ascii_downcase"

    # Extract function calls from the heredoc.
    # Restrict matches to actual command positions instead of every bare word;
    # the monitor body is large enough that tokenizing every identifier turns
    # this guard into an accidental quadratic scan.
    # Comment-only lines are never executed, and English prose in them
    # ("; skip planner attempt", "if watchdog fired") otherwise trips the
    # command-position patterns below.
    HEREDOC_CODE=$(grep -vE '^[[:space:]]*#' <<< "$HEREDOC_CONTENT")

    CALLED_FUNCS=$(
      {
        grep -oE '^[[:space:]]*[a-z_][a-z0-9_]*[[:space:]]' <<< "$HEREDOC_CODE"
        grep -oE '(if[[:space:]]+|\$\( *|[;&|][;&|]?[[:space:]]*)[a-z_][a-z0-9_]*([[:space:];)]|$)' <<< "$HEREDOC_CODE"
      } \
      | sed -E 's/^[[:space:]]*//; s/^(if[[:space:]]+|\$\( *|[;&|][;&|]?[[:space:]]*)//; s/[[:space:];)]*$//' \
      | sort -u \
      | grep -vE "^($KNOWN_EXTERNALS)$" \
      | grep -vE '^(done|else|elif|esac|fi|for|function|if|in|then|until|while|do|case)$' \
      | grep -vE '^(err|out|dev|null|tmp|usr|bin|opt|homebrew|lib|etc|var|tmp|home)$' \
      | grep -vE '^(pipefail|euo|noglob|errexit|nounset)$' \
      | grep -vE '^(env|stdin|stdout|stderr|json|txt|csv|pid|utf)$' \
      | grep -vE '^(true|false|yes|string|number|empty|null|undefined)$' \
      | grep -vE '^(try|catch|def|fromjson|add|rollout_path|thread_id|thread_row|updated_at|exits|setting|falling|select|strings|tostring|valid_dismissal_count)$' \
      | grep -vE '^(bad|internal|keeping|marking|monitor|rate|reduce|service|skipping|staying|timed|too|using|wavemill|waiting)$' \
      | grep -vE '^(advance|review)$' \
      | grep -vE '^(not_eligible|routing_error|invalid_challenge)$' \
      | grep -vE '^(a|aborted|already|available|blocked_by_count|break|coding|cp|debug|elapsed|empty_queue|execute|file|fresh|gtimeout|heartbeat_epoch|i|id|launch|length|main|mapfile|missing|next|not|overloaded|plan|ready|required|reservation|slots|staleness|streak|the|they|timeout|todate|todateiso8601|tonumber|tracked|user)$' \
      | grep -vE '^(capabilities|const|import|throw)$')

    # Check which called names look like they could be custom functions
    # and verify they're defined
    MISSING=""
    while IFS= read -r name; do
      [[ -z "$name" ]] && continue
      if ! grep -qx "$name" <<< "$ALL_DEFINED"; then
        MISSING="$MISSING $name"
      fi
    done <<< "$CALLED_FUNCS"

    if [[ -z "$MISSING" ]]; then
      pass "All function calls in monitor heredoc are defined"
    else
      fail "Undefined function(s) called in monitor heredoc:$MISSING"
    fi

    # Also verify that functions used in the main monitoring loop are defined
    # These are the critical functions that caused PRs 48 and 52
    CRITICAL_FUNCTIONS=(
      log log_error log_warn
      save_task_state remove_task_state set_task_phase get_task_phase
      save_migration_reservation
      find_pr_for_branch check_pr_exists pr_state validate_pr_merge
      linear_set_state linear_is_completed
      check_routing_complete
      fetch_candidates filter_active_issues
      launch_task dispatch_task_and_persist mark_task_needs_user_and_defer is_task_packet
      cleanup_dashboard_pane
      save_migration_reservation
      run_linear_retry_drain_tick
    )

    for func in "${CRITICAL_FUNCTIONS[@]}"; do
      if grep -qx "$func" <<< "$ALL_DEFINED"; then
        pass "Critical function '$func' is defined in monitor scope"
      else
        fail "Critical function '$func' is NOT defined in monitor scope"
      fi
    done
  fi
fi

# ============================================================================
# TEST 2B: Monitor shell escaping regression guards
# ============================================================================
echo ""
echo "=== Monitor Shell Escaping Guards ==="

if grep -q 'write_shell_assignment()' "$MILL_SCRIPT"; then
  pass "monitor env assignments use write_shell_assignment"
else
  fail "wavemill-mill.sh is missing write_shell_assignment helper"
fi

if grep -q 'printf -v STARTUP_CMD '\''%q %q'\''' "$MILL_SCRIPT"; then
  pass "startup runner tmux launch command uses shell escaping"
else
  fail "startup runner tmux launch command is not shell-escaped"
fi

# ============================================================================
# TEST 2C: Startup progress fixtures
# ============================================================================
echo ""
echo "=== Startup Progress Fixtures ==="

for fixture in "$REPO_DIR"/tests/fixtures/startup/*.sh; do
  if [[ ! -f "$fixture" ]]; then
    fail "Startup fixture not found: $fixture"
    continue
  fi
  if bash -n "$fixture" 2>/dev/null && bash "$fixture" >/dev/null 2>&1; then
    pass "$(basename "$fixture")"
  else
    fail "$(basename "$fixture") failed"
  fi
done

# ============================================================================
# TEST 2D: Base-branch fetch cache guards
# ============================================================================
echo ""
echo "=== Base Branch Fetch Cache Guards ==="

COMMON_SCRIPT="$LIB_DIR/wavemill-common.sh"

if grep -q '^wavemill_fetch_base_branch()' "$COMMON_SCRIPT"; then
  pass "wavemill_fetch_base_branch helper is defined"
else
  fail "wavemill-common.sh is missing wavemill_fetch_base_branch helper"
fi

if grep -q 'baseBranchFetchCache' "$COMMON_SCRIPT" && grep -q 'last_fetch_at' "$COMMON_SCRIPT"; then
  pass "fetch cache stores per-branch last_fetch_at state"
else
  fail "fetch cache state persistence is missing"
fi

if grep -q '"fetchTtlSeconds": 60' "$COMMON_SCRIPT" && grep -q '_CFG_GIT_FETCH_TTL_SECONDS' "$COMMON_SCRIPT"; then
  pass "git fetch TTL config is loaded with default"
else
  fail "git fetch TTL config is not wired through load_config"
fi

if grep -qF 'wavemill_fetch_base_branch "$BASE_BRANCH" --force 2>/dev/null || true' "$MILL_SCRIPT"; then
  pass "startup migration scan uses forced fetch helper"
else
  fail "startup migration scan is not using forced fetch helper"
fi

if grep -qF 'wavemill_fetch_base_branch "$effective_base" 2>/dev/null || true' "$MONITOR_FILE"; then
  pass "dynamic task launch uses cached fetch helper"
else
  fail "dynamic task launch is not using cached fetch helper"
fi

# ============================================================================
# TEST 2E: Config annotation log guards
# ============================================================================
echo ""
echo "=== Config Annotation Log Guards ==="

if helper_output="$(bash -lc 'source "'"$COMMON_SCRIPT"'"; wavemill_config_annotation "mill.requireConfirm" "true"')" \
  && [[ "$helper_output" == ' (mill.requireConfirm=true)' ]]; then
  pass "wavemill_config_annotation formats path/value suffix"
else
  fail "wavemill_config_annotation formatting changed"
fi

if grep -q '^wavemill_config_annotation()' "$COMMON_SCRIPT"; then
  pass "wavemill_config_annotation helper is defined"
else
  fail "wavemill-common.sh is missing wavemill_config_annotation helper"
fi

if grep -qF 'Router: ${ROUTER_ENABLED:-true} (per-task agent+model selection)$(wavemill_config_annotation "router.enabled" "${ROUTER_ENABLED:-true}")' "$MILL_SCRIPT"; then
  pass "router summary logs router.enabled annotation"
else
  fail "router summary is missing router.enabled annotation"
fi

if grep -qF 'Max parallel: $MAX_PARALLEL$(wavemill_config_annotation "mill.maxParallel" "$MAX_PARALLEL")' "$MILL_SCRIPT" \
  && grep -qF 'Max parallel: $EFFECTIVE_MAX_PARALLEL (reduced from $MAX_PARALLEL - all models degraded)$(wavemill_config_annotation "mill.maxParallel" "$MAX_PARALLEL")' "$MILL_SCRIPT"; then
  pass "max parallel summaries log mill.maxParallel annotation"
else
  fail "max parallel summaries are missing mill.maxParallel annotation"
fi

if grep -qF 'Checking every ${POLL_SECONDS}s$(wavemill_config_annotation "mill.pollSeconds" "$POLL_SECONDS")' "$MONITOR_FILE"; then
  pass "poll interval summary logs mill.pollSeconds annotation"
else
  fail "poll interval summary is missing mill.pollSeconds annotation"
fi

if grep -qF 'Window stays open for review - close it when ready$(wavemill_config_annotation "mill.requireConfirm" "$REQUIRE_CONFIRM")' "$MONITOR_FILE"; then
  window_count="$(grep -cF 'Window stays open for review - close it when ready$(wavemill_config_annotation "mill.requireConfirm" "$REQUIRE_CONFIRM")' "$MONITOR_FILE")"
  if [[ "$window_count" -eq 2 ]]; then
    pass "window hold-open logs include mill.requireConfirm at both sites"
  else
    fail "window hold-open annotation expected at 2 sites, found $window_count"
  fi
else
  fail "window hold-open logs are missing mill.requireConfirm annotation"
fi

if grep -qF 'wavemill_base_ref_preflight "$BASE_BRANCH" --force-fetch' "$MILL_SCRIPT"; then
  pass "startup session uses canonical base-ref preflight"
else
  fail "startup session is not using canonical base-ref preflight"
fi

LAUNCH_TASK_BLOCK=$(awk '
  /^launch_task\(\) \{/ { in_fn=1 }
  in_fn { print }
  in_fn && /^\}/ { exit }
' "$MILL_SCRIPT")

if grep -q 'git -C "\$REPO_DIR" fetch origin "\$BASE_BRANCH"' <<< "$LAUNCH_TASK_BLOCK"; then
  fail "launch_task still has raw git fetch"
else
  pass "launch_task no longer performs raw git fetch"
fi

# ============================================================================
# TEST 3: Monitor PR-detection regression guards
# ============================================================================
echo ""
echo "=== Monitor PR Detection Regression Guards ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found for monitor regression checks"
elif [[ -z "${HEREDOC_CONTENT:-}" ]]; then
  fail "Monitor heredoc content unavailable for regression checks"
else
  # NOTE: Use here-strings (<<<) instead of echo pipes for grepping HEREDOC_CONTENT.
  # The heredoc is ~84KB; with `echo ... | grep -q`, grep exits on first match and
  # closes the pipe while echo is still writing, causing SIGPIPE (exit 141).
  # With `set -euo pipefail`, this makes the pipeline fail even though the pattern matched.

  if grep -qF 'wavemill_resolve_pr_attempt "$issue" "$branch"' <<< "$HEREDOC_CONTENT" \
    && grep -qF 'classification" == "current-open"' <<< "$HEREDOC_CONTENT"; then
    pass "monitor find_pr_for_branch uses attempt resolver"
  else
    fail "monitor find_pr_for_branch is not routed through attempt resolver"
  fi

  if grep -qF 'check_pr_exists "$BRANCH"' <<< "$HEREDOC_CONTENT" \
    && grep -qF 'Agent exited without creating PR on branch $BRANCH' <<< "$HEREDOC_CONTENT" \
    && grep -qF 'worktree preserved' <<< "$HEREDOC_CONTENT" \
    && ! grep -qF 'cleanup_completed_task "$ISSUE" "$SLUG" "no PR created"' <<< "$HEREDOC_CONTENT"; then
    pass "monitor preserves worktree when agent exits without PR"
  else
    fail "monitor still risks cleanup when agent exits without PR"
  fi

  if grep -q 'linear_set_state .*"In Review"' <<< "$HEREDOC_CONTENT" && grep -q 'get_linear_issue_id' <<< "$HEREDOC_CONTENT"; then
    pass "monitor sets Linear issue to In Review when PR is detected"
  else
    fail "monitor does not set Linear issue to In Review on PR detection"
  fi

  if grep -q 'linear_set_state .*"Done"' <<< "$HEREDOC_CONTENT" && grep -q 'get_linear_issue_id' <<< "$HEREDOC_CONTENT"; then
    pass "monitor sets Linear issue to Done when work is completed"
  else
    fail "monitor does not set Linear issue to Done on completion"
  fi

  # HOK-2901: linear_set_state is inherited from wavemill-common.sh, so the
  # tool reference lives there rather than in the monitor script.
  if grep -q 'set-issue-state.ts' <<< "$HEREDOC_CONTENT" \
    || grep -q 'set-issue-state.ts' "$LIB_DIR/wavemill-common.sh"; then
    pass "monitor linear_set_state uses set-issue-state.ts"
  else
    fail "monitor linear_set_state is not calling set-issue-state.ts"
  fi

  if grep -Fq '.tasks | to_entries[]' <<< "$HEREDOC_CONTENT"; then
    pass "monitor rehydrates tracked tasks from state file on startup"
  else
    fail "monitor does not rehydrate tracked tasks from state file"
  fi

  if grep -q 'done < \"\$TASKS_FILE\"' <<< "$HEREDOC_CONTENT"; then
    pass "monitor overlays newly selected tasks from TASKS_FILE"
  else
    fail "monitor does not overlay new tasks from TASKS_FILE"
  fi

  if grep -q '^poll_challenge_jobs() {' <<< "$HEREDOC_CONTENT" \
    && grep -q 'job-tracker.ts" poll' <<< "$HEREDOC_CONTENT"; then
    pass "monitor defines tracked challenge job poller"
  else
    fail "monitor is missing tracked challenge job poller"
  fi

  if grep -q 'update-linear-state.ts' <<< "$HEREDOC_CONTENT"; then
    fail "monitor references removed update-linear-state.ts tool"
  else
    pass "monitor does not reference update-linear-state.ts"
  fi

  # HOK-2901: the canonical body lives in wavemill-common.sh; check it there
  # (and any monitor-local override, should one reappear).
  LINEAR_SET_STATE_BLOCK=$(awk '
    /^linear_set_state\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' <<< "$HEREDOC_CONTENT"$'\n'"$(cat "$LIB_DIR/wavemill-common.sh")")
  if [[ -z "$LINEAR_SET_STATE_BLOCK" ]]; then
    fail "linear_set_state definition not found in monitor scope or wavemill-common.sh"
  elif grep -q 'return 1' <<< "$LINEAR_SET_STATE_BLOCK"; then
    fail "monitor linear_set_state must not return 1 (would exit under set -e)"
  else
    pass "monitor linear_set_state failures are non-fatal"
  fi

  MONITOR_LOOP_BLOCK=$(awk '
    /^while :; do$/ { in_loop=1 }
    in_loop { print }
    in_loop && /^done$/ { exit }
  ' <<< "$HEREDOC_CONTENT")
  if grep -qF 'poll_challenge_jobs' <<< "$MONITOR_LOOP_BLOCK"; then
    pass "monitor loop polls challenge jobs before issue processing"
  else
    fail "monitor loop does not poll challenge jobs"
  fi
  if grep -qE '^[[:space:]]*local[[:space:]]' <<< "$MONITOR_LOOP_BLOCK"; then
    fail "monitor loop contains top-level local declarations (invalid outside functions)"
  else
    pass "monitor loop has no top-level local declarations"
  fi

  if grep -q 'monitor_issue_state "$ISSUE"' <<< "$MONITOR_LOOP_BLOCK" \
    && grep -q 'issue_rc=$?' <<< "$MONITOR_LOOP_BLOCK" \
    && grep -q 'set +e' <<< "$MONITOR_LOOP_BLOCK" \
    && grep -q 'set -e' <<< "$MONITOR_LOOP_BLOCK"; then
    pass "monitor loop guards per-issue processing with explicit error handling"
  else
    fail "monitor loop is missing guarded per-issue processing checks"
  fi

  CHALLENGE_EVAL_BLOCK=$(awk '
    /^maybe_run_challenge_eval\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' <<< "$HEREDOC_CONTENT")
  if grep -q 'run-eval-hook.ts' <<< "$CHALLENGE_EVAL_BLOCK" \
    && ! grep -q '_with_timeout 420' <<< "$CHALLENGE_EVAL_BLOCK" \
    && grep -q 'launch_tracked_job "eval"' <<< "$CHALLENGE_EVAL_BLOCK"; then
    pass "challenge eval launches as tracked background job without blocking timeout wrapper"
  else
    fail "challenge eval still looks synchronous or untracked"
  fi
  if grep -q 'evalFailed // false' <<< "$CHALLENGE_EVAL_BLOCK"; then
    pass "challenge eval launch skips tasks already marked evalFailed"
  else
    fail "challenge eval launch may relaunch failed eval jobs"
  fi
  if grep -q '^mark_challenge_eval_running()' <<< "$HEREDOC_CONTENT" \
    && grep -q '^mark_challenge_comparison_running()' <<< "$HEREDOC_CONTENT"; then
    pass "monitor heredoc defines challenge running-state persistence helpers"
  else
    fail "monitor heredoc is missing challenge running-state persistence helpers"
  fi

  CHALLENGE_COMPARE_BLOCK=$(awk '
    /^maybe_run_challenge_comparison\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' <<< "$HEREDOC_CONTENT")
  if grep -q 'compare-prs.ts' <<< "$CHALLENGE_COMPARE_BLOCK" \
    && ! grep -q '_with_timeout' <<< "$CHALLENGE_COMPARE_BLOCK" \
    && grep -q 'launch_tracked_job "comparison"' <<< "$CHALLENGE_COMPARE_BLOCK"; then
    pass "challenge comparison launches as tracked background job without blocking timeout wrapper"
  else
    fail "challenge comparison still looks synchronous or untracked"
  fi

  MONITOR_ISSUE_BLOCK=$(awk '
    /^[[:space:]]*monitor_issue_state\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' <<< "$HEREDOC_CONTENT")
  if grep -qF 'READY_STALE_MERGE_LANE_LOG_KEYS' <<< "$HEREDOC_CONTENT" \
    && grep -qE '^log_ready_stale_merge_lane_once\(\) \{' <<< "$HEREDOC_CONTENT" \
    && grep -qF 'log_ready_stale_merge_lane_once "$ISSUE" "$PR" "$stored_base_sha" "$current_main_sha"' <<< "$MONITOR_ISSUE_BLOCK"; then
    pass "monitor de-duplicates stale ready merge-lane notices"
  else
    fail "monitor can repeatedly log stale ready merge-lane notices"
  fi

  # HOK-1194: Phase resolution refactored to use resolve_phase() with controller-owned state priority
  RESOLVE_PHASE_LINE=$(grep -Fn 'resolved_phase=$(resolve_phase "$FEATURE_DIR")' <<< "$MONITOR_ISSUE_BLOCK" | head -n1 | cut -d: -f1 || true)
  PANE_EARLY_RETURN_LINE=$(grep -n 'Not completed externally - keep controller-owned running stages active' <<< "$MONITOR_ISSUE_BLOCK" | head -n1 | cut -d: -f1 || true)
  if [[ -n "$RESOLVE_PHASE_LINE" && -n "$PANE_EARLY_RETURN_LINE" ]] && (( RESOLVE_PHASE_LINE < PANE_EARLY_RETURN_LINE )); then
    pass "monitor checks planning approval before controller-state keepalive"
  else
    fail "monitor planning approval check runs too late (after controller-state keepalive)"
  fi

  # HOK-1210: Monitor must NOT auto-approve on idle pane. It should log and wait.
  if grep -Fq 'if [[ "$resolved_phase" == "awaiting_user" ]]; then' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq '_pane_is_dead_or_idle "$WIN_TARGET"' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'Plan ready — awaiting user approval' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq '_approval_wait_logged_' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'printf -v "$approval_wait_var"' <<< "$MONITOR_ISSUE_BLOCK"; then
    pass "monitor logs idle pane without auto-approving (HOK-1210)"
  else
    fail "monitor is missing HOK-1210 idle-pane-without-approval guard"
  fi

  if grep -qE '^validate_planning_phase_output\(\) \{' <<< "$HEREDOC_CONTENT" \
    && grep -qE '^handle_planning_overreach_rejection\(\) \{' <<< "$HEREDOC_CONTENT" \
    && grep -qE '^wavemill_owned_dirty_path\(\) \{' <<< "$HEREDOC_CONTENT" \
    && grep -Fq 'prompt-registry.jsonl' <<< "$HEREDOC_CONTENT" \
    && grep -Fq 'validate_planning_phase_output "$WT_DIR"' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'handle_planning_overreach_rejection "$ISSUE" "$FEATURE_DIR" "$WIN" "$current_agent"' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq '.planning-rejected.json' <<< "$HEREDOC_CONTENT" \
    && grep -Fq 'write_stage_result "$feature_dir" "planning" "awaiting_user"' <<< "$HEREDOC_CONTENT"; then
    pass "monitor validates planning output before coding transition"
  else
    fail "monitor is missing planning phase-boundary validation"
  fi

  if grep -qE '^validate_coding_phase_output\(\) \{' <<< "$HEREDOC_CONTENT" \
    && grep -Fq 'validate_coding_phase_output "$BRANCH"' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'WARNING: Coding phase created PR #' <<< "$HEREDOC_CONTENT"; then
    pass "monitor warns when coding creates a PR before review"
  else
    fail "monitor is missing coding phase-boundary validation"
  fi

  # resolve_phase() checks abort first internally, so we verify it's called
  if [[ -n "$RESOLVE_PHASE_LINE" ]]; then
    pass "monitor checks workflow abort before phase completion markers"
  else
    fail "monitor abort check does not take precedence over completion markers"
  fi

  if grep -Fq 'if [[ "$resolved_phase" == "aborted" ]]; then' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'Workflow aborted (controller state)' <<< "$MONITOR_ISSUE_BLOCK"; then
    pass "monitor handles aborted state and controller-state abort fallback"
  else
    fail "monitor is missing aborted-state handling or controller-state abort fallback"
  fi

  if grep -Fq 'phase_should_remain_active_without_pr "$FEATURE_DIR" "$current_phase" "$SLUG"' <<< "$MONITOR_ISSUE_BLOCK" \
    && ! grep -Fq 'Pane died during $current_phase phase, respawning' <<< "$MONITOR_ISSUE_BLOCK"; then
    pass "monitor keepalive and fallback logic uses controller state instead of pane respawn"
  else
    fail "monitor still relies on pane-respawn fallback for phase progression"
  fi

  CLOSED_BLOCK=$(awk '
    index($0, "local closed_pr_recorded=") { in_block=1 }
    in_block { print }
    in_block && /^[[:space:]]*return 0$/ { exit }
  ' <<< "$MONITOR_ISSUE_BLOCK")

  # HOK-2972: the per-poll WARN was replaced with a deduplicated transition -
  # first observation logs at status, already-recorded transitions at debug.
  if grep -Fq 'log "status" "$ISSUE → PR #$PR closed without merge"' <<< "$CLOSED_BLOCK" \
    && grep -Fq 'terminal transition already recorded' <<< "$CLOSED_BLOCK" \
    && ! grep -Fq 'log_warn "$ISSUE → PR #$PR CLOSED without merge"' <<< "$CLOSED_BLOCK"; then
    pass "closed PR path logs a deduplicated transition, not per-poll warnings"
  else
    fail "closed PR path is missing the deduplicated transition log"
  fi

  if grep -Fq 'closed_pr_resource_policy() {' <<< "$HEREDOC_CONTENT" \
    && grep -Fq 'role=$(get_task_meta "$issue" "challengeRole")' <<< "$HEREDOC_CONTENT" \
    && grep -Fq '[[ "$role" == "challenger" && "${CHALLENGE_AUTO_MERGE:-false}" == "true" ]]' <<< "$HEREDOC_CONTENT" \
    && grep -Fq "printf 'pane-release-only\\n'" <<< "$HEREDOC_CONTENT"; then
    pass "monitor defines role-aware closed-PR resource policy (HOK-2952)"
  else
    fail "monitor is missing the role-aware closed-PR resource policy helper"
  fi

  if grep -Fq 'get_challenge_sibling_pr() {' "$COMMON_SCRIPT" \
    && grep -Fq 'check_challenge_sibling_merged() {' "$COMMON_SCRIPT" \
    && grep -Fq 'validate_pr_merge "$sibling_pr"' "$COMMON_SCRIPT" \
    && ! grep -Fq 'get_challenge_sibling_pr() {' <<< "$HEREDOC_CONTENT" \
    && ! grep -Fq 'check_challenge_sibling_merged() {' <<< "$HEREDOC_CONTENT"; then
    pass "common defines challenge sibling helpers for closed-PR resolution"
  else
    fail "challenge sibling helpers are not centralized in wavemill-common.sh"
  fi

  if grep -Fq 'closed_pr_resource_policy "$ISSUE"' <<< "$CLOSED_BLOCK" \
    && grep -Fq 'cleanup_completed_task "$ISSUE" "$SLUG" "closed without merge"' <<< "$HEREDOC_CONTENT" \
    && grep -Fq 'wavemill_release_terminal_pane "$SESSION" "$ISSUE" "$SLUG" "pr_closed_unmerged" "$PR"' <<< "$CLOSED_BLOCK" \
    && grep -Fq 'monitor_cleanup_episode_skip "$ISSUE" "$SLUG" "$PR"' <<< "$HEREDOC_CONTENT" \
    && ! grep -Fq 'should_cleanup_closed_pr' <<< "$CLOSED_BLOCK"; then
    pass "closed PRs route every role through the shared pane-resource policy (HOK-2952)"
  else
    fail "closed PR path is missing the shared pane-resource policy dispatch"
  fi

  if grep -Fq 'local linear_status="Backlog"' <<< "$CLOSED_BLOCK" \
    && grep -Fq 'if is_challenge_task "$ISSUE"; then' <<< "$CLOSED_BLOCK" \
    && grep -Fq 'check_challenge_sibling_merged "$ISSUE"' <<< "$CLOSED_BLOCK" \
    && grep -Fq 'linear_status="Done"' <<< "$CLOSED_BLOCK" \
    && grep -Fq 'Challenge sibling merged → marking Linear as Done' <<< "$CLOSED_BLOCK" \
    && grep -Fq 'linear_set_state "$(get_linear_issue_id "$ISSUE")" "$linear_status"' <<< "$CLOSED_BLOCK"; then
    pass "closed challenge PRs mark Linear Done when the sibling PR was merged"
  else
    fail "closed challenge PRs do not promote Linear to Done when sibling merged"
  fi

  if grep -Fq 'linear_status=""' <<< "$CLOSED_BLOCK" \
    && grep -Fq 'Challenge sibling still active or unknown, deferring Linear state update' <<< "$CLOSED_BLOCK" \
    && grep -Fq 'Challenge sibling PR not found yet, deferring Linear state update' <<< "$CLOSED_BLOCK"; then
    pass "closed challenge PRs defer Linear updates until the sibling outcome is known"
  else
    fail "closed challenge PRs do not defer Linear updates for unresolved sibling outcomes"
  fi

  if grep -Fq 'local feature_dir="$wt_dir/features/$slug"' <<< "$HEREDOC_CONTENT" \
    && ! grep -Fq 'local feature_dir="${feature_dir:-$wt_dir/features/$slug}"' <<< "$HEREDOC_CONTENT"; then
    pass "launch_task derives feature_dir from the current task scope"
  else
    fail "launch_task may inherit feature_dir across recursive challenger launches"
  fi

  if grep -qE '^read_state_value\(\) \{' <<< "$HEREDOC_CONTENT"; then
    pass "monitor defines read_state_value helper for non-fatal state reads"
  else
    fail "monitor is missing read_state_value helper"
  fi

  # The canonical get_task_phase lives in wavemill-common.sh (HOK-2903) with
  # the read_state_value guard inlined; assert the guard survived the move.
  GET_TASK_PHASE_BLOCK=$(awk '
    /^get_task_phase\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' "$LIB_DIR/wavemill-common.sh")
  if grep -q '! -r "\$STATE_FILE" || ! -s "\$STATE_FILE"' <<< "$GET_TASK_PHASE_BLOCK" \
    && grep -Fq "printf 'executing\n'" <<< "$GET_TASK_PHASE_BLOCK"; then
    pass "canonical get_task_phase defaults safely when state reads fail"
  else
    fail "canonical get_task_phase is missing the inlined state-read guard"
  fi

  if grep -Fq 'current_agent=$(read_state_value ""' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'task_status=$(read_state_value ""' <<< "$MONITOR_ISSUE_BLOCK"; then
    pass "monitor_issue_state guards agent and status reads from STATE_FILE"
  else
    fail "monitor_issue_state is missing guarded state-file reads"
  fi

  if grep -qE '^restore_review_task_window\(\) \{' <<< "$HEREDOC_CONTENT"; then
    pass "monitor defines review-window restore helper for PR-backed tasks"
  else
    fail "monitor is missing review-window restore helper for PR-backed tasks"
  fi

  if grep -Fq 'current_phase=$(get_task_phase "$ISSUE")' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'if [[ "$current_phase" == "review" ]]; then' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'restore_review_task_window "$ISSUE" "$SLUG" "$BRANCH" "$PR" "$WT_DIR"' <<< "$MONITOR_ISSUE_BLOCK"; then
    pass "monitor restores missing review windows before PR merge checks"
  else
    fail "monitor does not restore review windows for resumed PR-backed tasks"
  fi

  if grep -Fq 'if [[ "$current_phase" == "review" ]]; then' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'set_task_phase "$ISSUE" "ready"' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"' <<< "$MONITOR_ISSUE_BLOCK"; then
    pass "monitor unconditionally transitions PR-backed review tasks into ready before merge checks"
  else
    fail "monitor does not transition PR-backed review tasks into ready"
  fi

  if grep -Fq 'elif [[ "$current_phase" == "ready" ]]; then' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'ready_state_dir_path="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq '.conflict-detected' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -Fq 'Conflict remediation complete, ready checks rerun' <<< "$MONITOR_ISSUE_BLOCK"; then
    pass "monitor handles PR-backed ready tasks in the PR lifecycle path"
  else
    fail "monitor is missing PR-backed ready-phase handling in the PR lifecycle path"
  fi

  READ_STATE_VALUE_BLOCK=$(awk '
    /^read_state_value\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' <<< "$HEREDOC_CONTENT")
  if grep -q '! -r "\$STATE_FILE" || ! -s "\$STATE_FILE"' <<< "$READ_STATE_VALUE_BLOCK"; then
    pass "read_state_value defaults on missing, unreadable, or zero-byte state files"
  else
    fail "read_state_value is missing a zero-byte state-file guard"
  fi

  if grep -qE '^poll_sleep\(\) \{' <<< "$HEREDOC_CONTENT"; then
    pass "monitor defines interruptible poll_sleep helper"
  else
    fail "monitor is missing interruptible poll_sleep helper"
  fi

  if grep -qF '_active_count_prev=0' <<< "$HEREDOC_CONTENT" \
    && grep -qF '_active_count_prev=$active_count' <<< "$HEREDOC_CONTENT"; then
    pass "monitor tracks previous active count for eager quit handling"
  else
    fail "monitor is missing previous active-count tracking for quit handling"
  fi

  if awk '
    /drain_command_events/ { saw_drain=1; next }
    saw_drain && /while consume_next_command; do/ { found=1; exit }
    saw_drain && /check_control_pane_health/ { exit }
    END { exit !found }
  ' <<< "$MONITOR_LOOP_BLOCK"; then
    pass "monitor eagerly consumes quit commands after draining input"
  else
    fail "monitor does not eagerly handle queued quit commands"
  fi

  if grep -qE '^handle_monitor_quit_command\(\) \{' <<< "$HEREDOC_CONTENT" \
    && grep -qF 'Press q again to force quit.' <<< "$HEREDOC_CONTENT" \
    && grep -qF 'Force quitting (${active_count} task(s) still active).' <<< "$HEREDOC_CONTENT"; then
    pass "monitor restores double-q force quit messaging and handling"
  else
    fail "monitor is missing double-q force quit handling"
  fi

  RAW_POLL_SLEEPS=$(grep -cE '^[[:space:]]*sleep "\$POLL_SECONDS"$' <<< "$MONITOR_LOOP_BLOCK" || true)
  INTERRUPTIBLE_POLL_SLEEPS=$(grep -cE '^[[:space:]]*poll_sleep "\$POLL_SECONDS"$' <<< "$MONITOR_LOOP_BLOCK" || true)
  if [[ "$RAW_POLL_SLEEPS" -eq 0 && "$INTERRUPTIBLE_POLL_SLEEPS" -ge 6 ]]; then
    pass "monitor uses interruptible poll_sleep in every poll branch"
  else
    fail "monitor poll branches are not fully using interruptible poll_sleep"
  fi
fi

# ============================================================================
# TEST 3a: Runtime prompt resolver integration guards
# ============================================================================
echo ""
echo "=== Runtime Prompt Resolver Guards ==="

if grep -q 'resolve-runtime-resource.ts' "$LIB_DIR/agent-adapters.sh" \
  && grep -q -- '--surface planner' "$LIB_DIR/agent-adapters.sh"; then
  pass "planning prompt uses runtime resolver helper"
else
  fail "planning prompt is missing runtime resolver helper"
fi

if grep -q 'resolve-runtime-resource.ts' "$LIB_DIR/agent-adapters.sh" \
  && grep -q -- '--surface reviewer' "$LIB_DIR/agent-adapters.sh"; then
  pass "review prompt uses runtime resolver helper"
else
  fail "review prompt is missing runtime resolver helper"
fi

if grep -q 'falling back to \$template_file' "$LIB_DIR/agent-adapters.sh"; then
  pass "agent adapters preserve static prompt fallback"
else
  fail "agent adapters are missing static prompt fallback warning"
fi

if grep -q 'agent_runtime_resource_repo_dir' "$LIB_DIR/agent-adapters.sh" \
  && grep -q -- '--repo-dir "$resource_repo_dir"' "$LIB_DIR/agent-adapters.sh" \
  && ! grep -q -- '--repo-dir "$wt_dir" --json' "$LIB_DIR/agent-adapters.sh"; then
  pass "runtime prompt resolver uses Wavemill resource root instead of task worktree"
else
  fail "runtime prompt resolver should not resolve prompt resources from task worktrees"
fi

# ============================================================================
# TEST 4: FORCE_MODEL challenge bypass guards
# ============================================================================
echo ""
echo "=== FORCE_MODEL Challenge Bypass Guards ==="

FORCE_SKIP_COUNT=$(( $(grep -c 'Challenge skipped because FORCE_MODEL is set (\$FORCE_MODEL)' "$MILL_SCRIPT" || true) + $(grep -c 'Challenge skipped because FORCE_MODEL is set (\$FORCE_MODEL)' "$MONITOR_FILE" || true) ))
if [[ "$FORCE_SKIP_COUNT" -eq 2 ]]; then
  pass "wavemill-mill.sh logs FORCE_MODEL challenge skips in both launch paths"
else
  fail "wavemill-mill.sh is missing FORCE_MODEL challenge skip logs in one or more launch paths"
fi

FIRST_FORCE_GUARD_LINE=$(grep -n 'if \[\[ -n "\${FORCE_MODEL:-}" \]\]; then' "$MILL_SCRIPT" | sed -n '1p' | cut -d: -f1 || true)
FIRST_RESOLVE_LINE=$(grep -n 'challenge_plan=$(npx tsx "\$TOOLS_DIR/resolve-challenge-task.ts"' "$MILL_SCRIPT" | sed -n '1p' | cut -d: -f1 || true)
if [[ -n "$FIRST_FORCE_GUARD_LINE" && -n "$FIRST_RESOLVE_LINE" ]] && (( FIRST_FORCE_GUARD_LINE < FIRST_RESOLVE_LINE )); then
  pass "initial launch path bypasses resolve-challenge-task.ts when FORCE_MODEL is set"
else
  fail "initial launch path does not guard resolve-challenge-task.ts behind FORCE_MODEL"
fi

SECOND_FORCE_GUARD_LINE=$(grep -n 'if \[\[ -n "\${FORCE_MODEL:-}" \]\]; then' "$MONITOR_FILE" | sed -n '1p' | cut -d: -f1 || true)
SECOND_RESOLVE_LINE=$(grep -nF 'challenge_plan=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/resolve-challenge-task.ts"' "$MONITOR_FILE" | sed -n '1p' | cut -d: -f1 || true)
if [[ -n "$SECOND_FORCE_GUARD_LINE" && -n "$SECOND_RESOLVE_LINE" ]] && (( SECOND_FORCE_GUARD_LINE < SECOND_RESOLVE_LINE )); then
  pass "runtime launch path bypasses resolve-challenge-task.ts when FORCE_MODEL is set"
else
  fail "runtime launch path does not guard resolve-challenge-task.ts behind FORCE_MODEL"
fi

# ============================================================================
# TEST 5: Codex attention-style regression guard
# ============================================================================
echo ""
echo "=== Codex Attention Style Regression Guard ==="

if [[ -f "$LIB_DIR/wavemill-mill.sh" ]] && ! grep -q 'window-status-activity-style bg=red,fg=white,bold' "$LIB_DIR/wavemill-mill.sh" \
  && ! grep -q 'window-status-activity-style bg=red,fg=white,bold' "$LIB_DIR/wavemill-monitor.sh"; then
  pass "mill no longer uses codex activity-style override"
else
  fail "mill still uses codex activity-style override"
fi

if [[ -f "$LIB_DIR/wavemill-orchestrator.sh" ]] && ! grep -q 'window-status-activity-style bg=red,fg=white,bold' "$LIB_DIR/wavemill-orchestrator.sh"; then
  pass "orchestrator no longer uses codex activity-style override"
else
  fail "orchestrator still uses codex activity-style override"
fi

if [[ -f "$LIB_DIR/wavemill-mill.sh" ]] \
  && grep -qE '^detect_inflight_tasks\(\) \{' "$LIB_DIR/wavemill-mill.sh" \
  && grep -q 'SKIP_BACKLOG_SELECTION' "$LIB_DIR/wavemill-mill.sh" \
  && grep -q 'STARTUP_SLOT_LIMIT' "$LIB_DIR/wavemill-mill.sh"; then
  pass "mill detects resumable tasks before backlog selection"
else
  fail "mill is missing early resume detection or startup slot limiting"
fi

if [[ -f "$LIB_DIR/wavemill-mill.sh" ]] && grep -qE '^set_window_attention_state\(\) \{' "$LIB_DIR/wavemill-mill.sh"; then
  pass "mill defines explicit window attention helper"
else
  fail "mill is missing explicit window attention helper"
fi

if [[ -f "$LIB_DIR/wavemill-mill.sh" ]] && grep -q 'tmux refresh-client -S' "$LIB_DIR/wavemill-mill.sh"; then
  pass "mill forces tmux status refresh after attention changes"
else
  fail "mill is missing tmux status refresh after attention changes"
fi

if [[ -f "$LIB_DIR/wavemill-mill.sh" ]] \
  && grep -qE '^codex_has_pending_approval\(\) \{' "$LIB_DIR/wavemill-mill.sh" \
  && grep -q 'sandbox_permissions.*require_escalated' "$LIB_DIR/wavemill-mill.sh" \
  && grep -q 'function_call_output' "$LIB_DIR/wavemill-mill.sh"; then
  pass "mill defines codex pending-approval detection from session call state"
else
  fail "mill is missing codex pending-approval detection"
fi

if [[ -f "$LIB_DIR/wavemill-monitor.sh" ]] \
  && grep -q 'codex_has_pending_approval "\$WT_DIR"' "$LIB_DIR/wavemill-monitor.sh" \
  && grep -q 'set_window_attention_state "\$WIN" "needs-user"' "$LIB_DIR/wavemill-monitor.sh"; then
  pass "monitor drives tab attention from explicit waiting states"
else
  fail "monitor is missing explicit tab attention state wiring"
fi

if [[ -f "$LIB_DIR/wavemill-monitor.sh" ]] \
  && grep -qE '^launch_background_post_merge_eval\(\) \{' "$LIB_DIR/wavemill-monitor.sh"; then
  pass "mill defines detached post-merge eval helper"
else
  fail "mill is missing detached post-merge eval helper"
fi

if [[ -f "$LIB_DIR/wavemill-monitor.sh" ]] \
  && grep -qE '^post_merge_eval_timeout_seconds\(\) \{' "$LIB_DIR/wavemill-monitor.sh" \
  && grep -q '.eval.postMergeTimeoutSeconds // 600' "$LIB_DIR/wavemill-monitor.sh"; then
  pass "mill defines configurable post-merge eval timeout with 600s default"
else
  fail "mill is missing configurable post-merge eval timeout"
fi

MERGED_BLOCK=$(awk '
  /log "status" "\$ISSUE → PR #\$PR MERGED"/ { in_block=1 }
  in_block { print }
  in_block && /elif \[\[ "\$pr_status" == "CLOSED" \]\]; then/ { exit }
' "$LIB_DIR/wavemill-monitor.sh")
if grep -q 'launch_background_post_merge_eval "\$ISSUE" "\$PR"' <<< "$MERGED_BLOCK"; then
  pass "merged PR path launches eval asynchronously"
else
  fail "merged PR path does not launch detached eval"
fi

if ! grep -q '_with_timeout 120 npx tsx "\$TOOLS_DIR/run-eval-hook.ts"' <<< "$MERGED_BLOCK"; then
  pass "merged PR path no longer runs eval inline"
else
  fail "merged PR path still runs eval inline"
fi

POST_MERGE_EVAL_BLOCK=$(awk '
  /^launch_background_post_merge_eval\(\) \{/ { in_block=1 }
  in_block { print }
  in_block && /^}/ { exit }
' "$LIB_DIR/wavemill-monitor.sh")
if grep -q '_with_timeout "\$eval_timeout" npx tsx "\$TOOLS_DIR/run-eval-hook.ts"' <<< "$POST_MERGE_EVAL_BLOCK" \
  && ! grep -q '_with_timeout 120 npx tsx "\$TOOLS_DIR/run-eval-hook.ts"' <<< "$POST_MERGE_EVAL_BLOCK"; then
  pass "detached post-merge eval uses configurable timeout"
else
  fail "detached post-merge eval does not use configurable timeout"
fi

if grep -q -- '--result-file "\$result_path"' <<< "$POST_MERGE_EVAL_BLOCK" \
  && grep -q 'persisted=$(jq -r '\''.persisted // false'\''' <<< "$POST_MERGE_EVAL_BLOCK" \
  && grep -q 'if \[\[ "\$persisted" == "true" \]\]; then' <<< "$POST_MERGE_EVAL_BLOCK"; then
  pass "detached post-merge eval completion is based on persisted result files"
else
  fail "detached post-merge eval is missing persisted result file handling"
fi

if awk '
  /cleanup_completed_task|cleanup_merged_primary_challenge_task/ { saw_cleanup=1 }
  saw_cleanup && /launch_background_post_merge_eval/ { found=1; exit }
  END { exit !found }
' <<< "$MERGED_BLOCK"; then
  pass "post-merge eval is queued after cleanup completes"
else
  fail "post-merge eval is launched before cleanup (ordering regression)"
fi

EXTERNAL_BLOCK=$(awk '
  /log "status" "\$ISSUE → Completed externally \(cross-repo or manual\)"/ { in_block=1 }
  in_block { print }
  in_block && /if \[\[ "\$REQUIRE_CONFIRM" == "true" \]\]; then/ { exit }
' "$LIB_DIR/wavemill-monitor.sh")
if grep -q 'launch_background_post_merge_eval "\$ISSUE" ""' <<< "$EXTERNAL_BLOCK"; then
  pass "external completion path launches eval asynchronously"
else
  fail "external completion path does not launch detached eval"
fi

if ! grep -q '_with_timeout 120 npx tsx "\$TOOLS_DIR/run-eval-hook.ts"' <<< "$EXTERNAL_BLOCK"; then
  pass "external completion path no longer runs eval inline"
else
  fail "external completion path still runs eval inline"
fi

if [[ -f "$LIB_DIR/wavemill-startup-runner.sh" ]] \
  && grep -q 'set-window-option -u -t "\$SESSION:\$win" window-status-style' "$LIB_DIR/wavemill-startup-runner.sh" \
  && grep -q 'set-window-option -u -t "\$SESSION:\$win" window-status-current-style' "$LIB_DIR/wavemill-startup-runner.sh"; then
  pass "startup runner clears per-window attention styling at launch"
else
  fail "startup runner is missing launch-time attention-style reset"
fi

if [[ -f "$LIB_DIR/wavemill-startup-runner.sh" ]] \
  && grep -q 'split-window -t "\$SESSION:\$WAVEMILL_WINDOW_MILL.0" -h -f -p 50' "$LIB_DIR/wavemill-startup-runner.sh" \
  && grep -q 'split-window -t "\$SESSION:\$WAVEMILL_WINDOW_MILL.0" -v -p 65' "$LIB_DIR/wavemill-startup-runner.sh" \
  && grep -q 'respawn-pane -k -t "\$SESSION:\$WAVEMILL_WINDOW_MILL.1" .*\$status_script' "$LIB_DIR/wavemill-startup-runner.sh" \
  && grep -q 'respawn-pane -k -t "\$SESSION:\$WAVEMILL_WINDOW_MILL.2" .*tail -n 200 -f' "$LIB_DIR/wavemill-startup-runner.sh"; then
  pass "startup runner builds task, dashboard, and log mill panes"
else
  fail "startup runner is missing the 3-pane mill layout wiring"
fi

if [[ -f "$LIB_DIR/wavemill-startup-runner.sh" ]] \
  && [[ -f "$LIB_DIR/wavemill-common.sh" ]] \
  && grep -q 'wavemill_build_control_pane_command startup' "$LIB_DIR/wavemill-startup-runner.sh" \
  && grep -q 'WAVEMILL_SESSION=' "$LIB_DIR/wavemill-common.sh" \
  && grep -q 'wavemill-input-reader.sh' "$LIB_DIR/wavemill-common.sh" \
  && grep -q '</dev/null &' "$LIB_DIR/wavemill-common.sh"; then
  pass "mill.0 launches monitor non-interactively plus input reader"
else
  fail "mill.0 does not launch the monitor/input-reader wrapper"
fi

if [[ -f "$LIB_DIR/wavemill-startup-runner.sh" ]] \
  && grep -Fq '^[A-Z]+-[0-9]+(_c)?$|^[a-z0-9-]+$' "$LIB_DIR/wavemill-startup-runner.sh"; then
  pass "startup runner accepts challenge task identifiers"
else
  fail "startup runner rejects challenge task identifiers"
fi

if [[ -f "$LIB_DIR/wavemill-startup-runner.sh" ]] \
  && grep -q 'wavemill_lock_run "git-worktree" ensure_worktree "\$branch" "\$wt_dir"' "$LIB_DIR/wavemill-startup-runner.sh" \
  && grep -q 'wavemill_lock_run "git-worktree" git worktree add "\$wt_dir" -b "\$branch" "\$worktree_base_ref"' "$LIB_DIR/wavemill-startup-runner.sh"; then
  pass "startup runner serializes git worktree creation"
else
  fail "startup runner does not serialize git worktree creation"
fi

# ============================================================================
# TEST 6: Dashboard planning-review status guards
# ============================================================================
echo ""
echo "=== Dashboard Planning Review Guards ==="

STATUS_SCRIPT="$LIB_DIR/wavemill-status.sh"

if [[ ! -f "$STATUS_SCRIPT" ]]; then
  fail "wavemill-status.sh not found for dashboard regression checks"
else
  if grep -qE '^plan_waiting_for_review\(\) \{' "$STATUS_SCRIPT"; then
    pass "dashboard defines plan_waiting_for_review helper"
  else
    fail "dashboard is missing plan_waiting_for_review helper"
  fi

  if grep -q '\[\[ "\$task_phase" == "planning" \]\]' "$STATUS_SCRIPT" \
    && grep -q '\[\[ "\$agent_state" == "exited" \]\]' "$STATUS_SCRIPT" \
    && ! grep -q '\.plan-approved' "$STATUS_SCRIPT"; then
    pass "dashboard review-waiting helper checks planning and exited agent without marker fallback"
  else
    fail "dashboard review-waiting helper has stale or missing gating conditions"
  fi

  if grep -q 'reported="Plan ready — waiting for approval"' "$STATUS_SCRIPT"; then
    pass "dashboard overrides stale status with plan review message"
  else
    fail "dashboard does not override stale status with plan review message"
  fi

  if grep -qE '^is_stale_planning_detail_for_phase\(\) \{' "$STATUS_SCRIPT" \
    && grep -q 'planning_\*|awaiting\\ plan\\ approval|Plan\\ ready\*|Native\\ planning\*' "$STATUS_SCRIPT" \
    && grep -q 'is_stale_planning_detail_for_phase "\$task_phase" "\$reported"' "$STATUS_SCRIPT"; then
    pass "dashboard suppresses planning-only detail outside planning phase"
  else
    fail "dashboard is missing stale planning detail suppression"
  fi

  if grep -q 'running:working' "$STATUS_SCRIPT" \
    && grep -q 'running:waiting' "$STATUS_SCRIPT" \
    && grep -q 'running:done' "$STATUS_SCRIPT" \
    && grep -q 'exited:\*' "$STATUS_SCRIPT"; then
    pass "dashboard combines pane liveness with machine status keywords"
  else
    fail "dashboard is missing pane-plus-status lifecycle mapping"
  fi

  if grep -q 'working|waiting|done' "$STATUS_SCRIPT"; then
    pass "dashboard recognizes machine lifecycle keywords"
  else
    fail "dashboard does not recognize machine lifecycle keywords"
  fi

  if grep -Fq '.freeSlots // empty' "$STATUS_SCRIPT" \
    && grep -Fq 'slot(s) available' "$STATUS_SCRIPT"; then
    pass "dashboard renders free slot count from workflow state"
  else
    fail "dashboard is missing free slot count rendering"
  fi

  if grep -qE '^task_window_target\(\) \{' "$STATUS_SCRIPT" \
    && grep -Fq '.tasks[$issue].windowId // empty' "$STATUS_SCRIPT" \
    && grep -Fq '#{pane_current_path}' "$STATUS_SCRIPT" \
    && grep -qE '^window_index\(\) \{' "$STATUS_SCRIPT" \
    && grep -q "tmux display-message -t \"\\\$target\" -p '#{window_index}'" "$STATUS_SCRIPT"; then
    pass "dashboard resolves worktree-validated tmux window indices for pane column"
  else
    fail "dashboard is missing tmux window index lookup"
  fi

  if grep -q '"ISSUE" "PANE" "TASK" "TIME" "PHASE" "AGENT" "PR"' "$STATUS_SCRIPT"; then
    pass "dashboard header includes pane column"
  else
    fail "dashboard header is missing pane column"
  fi

  STATUS_MAIN_LOOP=$(awk '
    /while true; do/ { in_loop=1 }
    in_loop { print }
    in_loop && /^[[:space:]]*done[[:space:]]*$/ { exit }
  ' "$STATUS_SCRIPT")
  if grep -qE '^[[:space:]]*local[[:space:]]' <<< "$STATUS_MAIN_LOOP"; then
    fail "dashboard main loop contains local declarations"
  else
    pass "dashboard main loop avoids local declarations"
  fi

  if grep -qE '^clear_dashboard_scrollback\(\) \{' "$STATUS_SCRIPT" \
    && grep -q "tput E3 2>/dev/null || printf '\\\\033\\[3J'" "$STATUS_SCRIPT"; then
    pass "dashboard clears scrollback without blanking the visible pane"
  else
    fail "dashboard is missing the scrollback-only clear helper"
  fi

  if grep -qE '^[[:space:]]*clear[[:space:]]*$' <<< "$STATUS_MAIN_LOOP"; then
    fail "dashboard main loop still performs a full clear each refresh"
  else
    pass "dashboard main loop avoids full-screen clears"
  fi

  if grep -qE '^redraw_dashboard_frame\(\) \{' "$STATUS_SCRIPT" \
    && grep -q 'cat "\$frame_file"' "$STATUS_SCRIPT" \
    && grep -q "tput cup 0 0 2>/dev/null || printf '\\\\033\\[H'" "$STATUS_SCRIPT" \
    && grep -q "tput ed 2>/dev/null || printf '\\\\033\\[J'" "$STATUS_SCRIPT"; then
    pass "dashboard redraw helper groups cursor, frame, and clear operations"
  else
    fail "dashboard redraw helper is missing grouped atomic redraw behavior"
  fi
fi

# ============================================================================
# TEST 7: Abort prompt guidance regression guards
# ============================================================================
echo ""
echo "=== Abort Prompt Guidance Guards ==="

if grep -q 'touch "{{FEATURE_DIR}}/.workflow-aborted"' "$REPO_DIR/tools/prompts/planning-phase.md" \
  && grep -q 'Do NOT create any phase completion or approval markers' "$REPO_DIR/tools/prompts/planning-phase.md" \
  && grep -q 'Stop after creating the marker and reporting the abort.' "$REPO_DIR/tools/prompts/planning-phase.md"; then
  pass "planning template documents abort marker flow"
else
  fail "planning template is missing abort marker guidance"
fi

if grep -q 'touch "{{FEATURE_DIR}}/.workflow-aborted"' "$REPO_DIR/tools/prompts/coding-phase.md" \
  && grep -q 'Do NOT create the phase completion marker (.coding-complete)' "$REPO_DIR/tools/prompts/coding-phase.md" \
  && grep -q 'Stop after creating the marker and reporting the abort.' "$REPO_DIR/tools/prompts/coding-phase.md"; then
  pass "coding template documents abort marker flow"
else
  fail "coding template is missing abort marker guidance"
fi

if grep -q 'touch "{{FEATURE_DIR}}/.workflow-aborted"' "$REPO_DIR/tools/prompts/review-phase.md" \
  && grep -q 'Do NOT create additional completion output or a PR' "$REPO_DIR/tools/prompts/review-phase.md" \
  && grep -q 'Stop after creating the marker and reporting the abort.' "$REPO_DIR/tools/prompts/review-phase.md"; then
  pass "review template documents abort marker flow"
else
  fail "review template is missing abort marker guidance"
fi

if ! grep -q '/exit command' "$REPO_DIR/tools/prompts/planning-phase.md" \
  && ! grep -q '/exit command' "$REPO_DIR/tools/prompts/coding-phase.md" \
  && ! grep -q '/exit command' "$REPO_DIR/tools/prompts/review-phase.md"; then
  pass "shared phase templates no longer hardcode /exit"
else
  fail "shared phase templates still hardcode /exit"
fi

PROMPT_RENDER_DIR=$(mktemp -d)
trap 'rm -rf "$PROMPT_RENDER_DIR"' EXIT
ORIGINAL_PATH="$PATH"

source "$LIB_DIR/agent-adapters.sh"

(
  PATH="/usr/bin:/bin" build_planning_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
    "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "codex" \
    > "$PROMPT_RENDER_DIR/planning-no-npx.txt" \
    2> "$PROMPT_RENDER_DIR/planning-no-npx.err"
)
if grep -q 'Failed to resolve planner runtime resource' "$PROMPT_RENDER_DIR/planning-no-npx.err"; then
  fail "baseline planning prompt render should not require npx runtime resolver"
else
  pass "baseline planning prompt render skips runtime resolver when selection is disabled"
fi
PATH="$ORIGINAL_PATH"

build_planning_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "codex" > "$PROMPT_RENDER_DIR/planning-codex.txt"
mkdir -p "$PROMPT_RENDER_DIR/worktree"
build_planning_prompt "Test title" "HOK-1130" "$PROMPT_RENDER_DIR/worktree" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "codex" > "$PROMPT_RENDER_DIR/planning-worktree.txt"
if grep -q -- '--repo-dir "'"$REPO_DIR"'"' "$PROMPT_RENDER_DIR/planning-worktree.txt" \
  && grep -q -- '--output "'"$PROMPT_RENDER_DIR/worktree"'/features/test-slug/.post-expansion-route.json"' "$PROMPT_RENDER_DIR/planning-worktree.txt"; then
  pass "planning reroute uses base repo for router config while writing worktree artifact"
else
  fail "planning reroute should use base repo dir for router config and worktree output path"
fi
build_planning_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "claude" > "$PROMPT_RENDER_DIR/planning-claude.txt"
build_coding_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "codex" > "$PROMPT_RENDER_DIR/coding-codex.txt"
build_coding_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "claude" > "$PROMPT_RENDER_DIR/coding-claude.txt"
build_review_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "claude-sonnet" "static" "codex" > "$PROMPT_RENDER_DIR/review-codex.txt"
build_review_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "claude-sonnet" "static" "claude" > "$PROMPT_RENDER_DIR/review-claude.txt"
build_planning_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "codex" "survival" > "$PROMPT_RENDER_DIR/planning-survival.txt"
build_coding_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "codex" "survival" > "$PROMPT_RENDER_DIR/coding-survival.txt"
build_review_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "claude-sonnet" "static" "codex" "survival" > "$PROMPT_RENDER_DIR/review-survival.txt"
build_review_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "claude-sonnet" "static" "codex" "constrained" > "$PROMPT_RENDER_DIR/review-constrained.txt"
build_coding_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "codex" "constrained" > "$PROMPT_RENDER_DIR/coding-constrained.txt"
build_routing_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" > "$PROMPT_RENDER_DIR/routing.txt"
build_interactive_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" > "$PROMPT_RENDER_DIR/interactive.txt"

if grep -q '/exit' "$PROMPT_RENDER_DIR/planning-codex.txt" \
  || grep -q '/exit' "$PROMPT_RENDER_DIR/coding-codex.txt" \
  || grep -q '/exit' "$PROMPT_RENDER_DIR/review-codex.txt"; then
  fail "codex-facing prompts still mention /exit"
else
  pass "codex-facing prompts omit /exit"
fi

# HOK-1177: agent-agnostic lifecycle — prompts no longer tell agents to run /exit
if grep -q '/exit' "$PROMPT_RENDER_DIR/planning-claude.txt" \
  || grep -q '/exit' "$PROMPT_RENDER_DIR/coding-claude.txt" \
  || grep -q '/exit' "$PROMPT_RENDER_DIR/review-claude.txt"; then
  fail "claude-facing prompts still reference /exit (should be agent-agnostic)"
else
  pass "claude-facing prompts use agent-agnostic lifecycle (no /exit)"
fi

if grep -q 'SURVIVAL MODE' "$PROMPT_RENDER_DIR/planning-survival.txt" \
  && grep -q 'Plan for at most 5 files changed' "$PROMPT_RENDER_DIR/planning-survival.txt"; then
  pass "planning prompt renders survival-mode scoping guidance"
else
  fail "planning prompt is missing survival-mode guidance"
fi

if grep -q 'CONSTRAINED MODE' "$PROMPT_RENDER_DIR/coding-constrained.txt" \
  && grep -q 'Commit after each plan phase' "$PROMPT_RENDER_DIR/coding-constrained.txt"; then
  pass "coding prompt renders constrained-mode checkpoints"
else
  fail "coding prompt is missing constrained-mode checkpoints"
fi

if grep -q 'SURVIVAL MODE' "$PROMPT_RENDER_DIR/coding-survival.txt" \
  && grep -q '"confidence":"low"' "$PROMPT_RENDER_DIR/coding-survival.txt"; then
  pass "coding prompt renders survival-mode confidence marker guidance"
else
  fail "coding prompt is missing survival-mode confidence guidance"
fi

if grep -q '## Grading Rubric' "$PROMPT_RENDER_DIR/planning-codex.txt" \
  && grep -q '## Grading Rubric' "$PROMPT_RENDER_DIR/coding-codex.txt"; then
  pass "planning and coding prompts render grading rubric section"
else
  fail "planning/coding prompt is missing grading rubric section"
fi

for criterion in completeness correctness code_quality intervention_impact autonomy; do
  if grep -q "\`$criterion\`" "$PROMPT_RENDER_DIR/planning-codex.txt" \
    && grep -q "\`$criterion\`" "$PROMPT_RENDER_DIR/coding-codex.txt"; then
    pass "planning/coding prompts include rubric criterion $criterion"
  else
    fail "planning/coding prompts missing rubric criterion $criterion"
  fi
done

if grep -q 'scopeDiscipline' "$PROMPT_RENDER_DIR/planning-codex.txt" \
  || grep -q 'scopeDiscipline' "$PROMPT_RENDER_DIR/coding-codex.txt"; then
  fail "planning/coding prompts contain legacy scopeDiscipline rubric key"
else
  pass "planning/coding prompts exclude legacy scopeDiscipline key"
fi

if grep -q 'Draft PR fallback' "$PROMPT_RENDER_DIR/review-survival.txt" \
  && grep -q -- '--draft' "$PROMPT_RENDER_DIR/review-survival.txt" \
  && grep -q -- '--operating-mode survival' "$PROMPT_RENDER_DIR/review-survival.txt" \
  && grep -q 'syntax, contract violations, obvious regressions, and test-coverage gaps' "$PROMPT_RENDER_DIR/review-survival.txt" \
  && grep -q 'needs_stronger_reviewer' "$PROMPT_RENDER_DIR/review-survival.txt"; then
  pass "review prompt renders survival-mode draft PR fallback"
else
  fail "review prompt is missing survival-mode draft PR fallback"
fi

if grep -q 'Scoped review (constrained quota)' "$PROMPT_RENDER_DIR/review-constrained.txt" \
  && grep -q -- '--operating-mode constrained' "$PROMPT_RENDER_DIR/review-constrained.txt" \
  && grep -q 'syntax, contract violations, obvious regressions, and test-coverage gaps' "$PROMPT_RENDER_DIR/review-constrained.txt" \
  && grep -q 'needs_stronger_reviewer' "$PROMPT_RENDER_DIR/review-constrained.txt"; then
  pass "review prompt renders constrained-mode scoped review guidance"
else
  fail "review prompt is missing constrained-mode scoped review guidance"
fi

if ! grep -q 'Scoped review (' "$PROMPT_RENDER_DIR/review-codex.txt" \
  && ! grep -q 'needs_stronger_reviewer' "$PROMPT_RENDER_DIR/review-codex.txt"; then
  pass "normal review prompt omits scoped-review guidance"
else
  fail "normal review prompt unexpectedly includes scoped-review guidance"
fi

if grep -q -- '--base main' "$PROMPT_RENDER_DIR/review-claude.txt" \
  && grep -q -- '--base main' "$PROMPT_RENDER_DIR/review-codex.txt"; then
  pass "review prompt specifies --base for PR creation"
else
  fail "review prompt is missing --base flag for PR creation"
fi

if grep -q '<!-- wavemill-meta' "$PROMPT_RENDER_DIR/review-claude.txt" \
  && grep -q '<!-- wavemill-meta' "$PROMPT_RENDER_DIR/review-codex.txt"; then
  pass "review prompt includes Wavemill metadata block instruction"
else
  fail "review prompt is missing Wavemill metadata block instruction"
fi

if grep -q 'task: HOK-1130' "$PROMPT_RENDER_DIR/review-claude.txt" \
  && grep -q 'task: HOK-1130' "$PROMPT_RENDER_DIR/review-codex.txt"; then
  pass "review prompt metadata block includes rendered issue ID"
else
  fail "review prompt metadata block does not include issue ID"
fi

if grep -q '## Routing' "$PROMPT_RENDER_DIR/review-claude.txt" \
  && grep -q 'routing.jsonl' "$PROMPT_RENDER_DIR/review-claude.txt" \
  && grep -q "$REPO_DIR/features/test-slug/routing.jsonl" "$PROMPT_RENDER_DIR/review-claude.txt"; then
  pass "review prompt includes routing.jsonl guidance"
else
  fail "review prompt is missing routing.jsonl guidance"
fi

if grep -q 'label "wavemill"' "$PROMPT_RENDER_DIR/review-claude.txt" \
  && grep -q 'label "wavemill"' "$PROMPT_RENDER_DIR/review-codex.txt"; then
  pass "review prompt instructs adding wavemill label"
else
  fail "review prompt is missing wavemill label instruction"
fi

if grep -q 'wm:ready' "$PROMPT_RENDER_DIR/review-claude.txt" \
  && grep -q 'wm:ready' "$PROMPT_RENDER_DIR/review-codex.txt"; then
  pass "review prompt instructs adding wm:ready label after review passes"
else
  fail "review prompt is missing wm:ready label instruction"
fi

if grep -q 'final self-review run errored (exit code 2)' "$PROMPT_RENDER_DIR/review-claude.txt" \
  && grep -q 'final self-review run errored (exit code 2)' "$PROMPT_RENDER_DIR/review-codex.txt" \
  && grep -q 'without readiness certification' "$PROMPT_RENDER_DIR/review-claude.txt" \
  && grep -q 'without readiness certification' "$PROMPT_RENDER_DIR/review-codex.txt"; then
  pass "review prompt forbids wm:ready after non-zero final review"
else
  fail "review prompt does not clearly forbid wm:ready after non-zero final review"
fi

if grep -q 'wm:merging' "$PROMPT_RENDER_DIR/review-claude.txt" \
  && grep -q 'wm:merged' "$PROMPT_RENDER_DIR/review-claude.txt" \
  && grep -q 'wm:merging' "$PROMPT_RENDER_DIR/review-codex.txt" \
  && grep -q 'wm:merged' "$PROMPT_RENDER_DIR/review-codex.txt"; then
  pass "review prompt prohibits wm:merging and wm:merged labels"
else
  fail "review prompt is missing wm:merging/wm:merged prohibition"
fi

EXIT_SEMANTICS_PATTERN='(/exit|remain in session|exit the process|stay running|keep running|close the session|let the session end)'

for template in planning-phase.md coding-phase.md review-phase.md; do
  if grep -qiE "$EXIT_SEMANTICS_PATTERN" "$REPO_DIR/tools/prompts/$template"; then
    fail "$template still contains agent-managed exit semantics"
  else
    pass "$template omits agent-managed exit semantics"
  fi
done

for rendered in \
  "$PROMPT_RENDER_DIR/routing.txt" \
  "$PROMPT_RENDER_DIR/interactive.txt" \
  "$PROMPT_RENDER_DIR/planning-codex.txt" \
  "$PROMPT_RENDER_DIR/planning-claude.txt" \
  "$PROMPT_RENDER_DIR/coding-codex.txt" \
  "$PROMPT_RENDER_DIR/coding-claude.txt" \
  "$PROMPT_RENDER_DIR/review-codex.txt" \
  "$PROMPT_RENDER_DIR/review-claude.txt" \
; do
  if grep -qiE "$EXIT_SEMANTICS_PATTERN" "$rendered"; then
    fail "$(basename "$rendered") still contains agent-managed exit semantics"
  else
    pass "$(basename "$rendered") omits agent-managed exit semantics"
  fi
done

if grep -q "$REPO_DIR/features/test-slug/selected-task.json" "$PROMPT_RENDER_DIR/routing.txt" \
  && grep -q "$REPO_DIR/features/test-slug/.routing-complete" "$PROMPT_RENDER_DIR/routing.txt" \
  && grep -q "$REPO_DIR/features/test-slug/selected-task.json" "$PROMPT_RENDER_DIR/interactive.txt" \
  && grep -q "$REPO_DIR/features/test-slug/plan.md" "$PROMPT_RENDER_DIR/interactive.txt" \
  && grep -q "$REPO_DIR/features/test-slug/plan.md" "$PROMPT_RENDER_DIR/planning-codex.txt" \
  && grep -q "$REPO_DIR/features/test-slug/.plan-approved" "$PROMPT_RENDER_DIR/planning-codex.txt" \
  && grep -q "$REPO_DIR/features/test-slug/.coding-complete" "$PROMPT_RENDER_DIR/coding-codex.txt" \
  && grep -q "$REPO_DIR/features/test-slug/.workflow-aborted" "$PROMPT_RENDER_DIR/review-codex.txt"; then
  pass "rendered prompts use absolute canonical feature paths"
else
  fail "rendered prompts still rely on cwd-relative feature paths"
fi

if grep -q 'Recommended after expansion' "$REPO_DIR/tools/prompts/review-phase.md" \
  && grep -q '\.planning-result.json' "$REPO_DIR/tools/prompts/review-phase.md" \
  && grep -q '\.post-expansion-route.json' "$REPO_DIR/tools/prompts/review-phase.md" \
  && grep -q 'runtime execution telemetry' "$REPO_DIR/tools/prompts/review-phase.md" \
  && grep -q 'Recommended after expansion' "$PROMPT_RENDER_DIR/review-codex.txt" \
  && grep -q '\.planning-result.json' "$PROMPT_RENDER_DIR/review-codex.txt"; then
  pass "review prompt distinguishes executed planning from expanded recommendations"
else
  fail "review prompt is missing route provenance guidance"
fi

# HOK-2265: portable timeout guidance — source files must omit the ambiguous phrase
for src_file in \
  "$REPO_DIR/tools/prompts/review-phase.md" \
  "$REPO_DIR/tools/prompts/self-review-instructions.md" \
  "$REPO_DIR/commands/bugfix.md" \
; do
  src_name="$(basename "$(dirname "$src_file")")/$(basename "$src_file")"
  if grep -q 'set a 600s timeout on your Bash tool call' "$src_file"; then
    fail "$src_name still contains ambiguous 'set a 600s timeout on your Bash tool call'"
  else
    pass "$src_name omits ambiguous 600s timeout phrasing"
  fi
  if grep -q 'timeout 600s' "$src_file"; then
    fail "$src_name still contains 'timeout 600s' command-prefix pattern"
  else
    pass "$src_name omits 'timeout 600s' command-prefix pattern"
  fi
done

# HOK-2265: rendered review prompts must use portable timeout guidance
for rendered in \
  "$PROMPT_RENDER_DIR/review-codex.txt" \
  "$PROMPT_RENDER_DIR/review-claude.txt" \
  "$PROMPT_RENDER_DIR/review-survival.txt" \
  "$PROMPT_RENDER_DIR/review-constrained.txt" \
; do
  rname="$(basename "$rendered")"
  if grep -q 'set a 600s timeout on your Bash tool call' "$rendered"; then
    fail "$rname still contains ambiguous 'set a 600s timeout on your Bash tool call'"
  else
    pass "$rname omits ambiguous 600s timeout phrasing"
  fi
  if grep -q 'timeout 600s' "$rendered"; then
    fail "$rname still contains 'timeout 600s' command-prefix pattern"
  else
    pass "$rname omits 'timeout 600s' command-prefix pattern"
  fi
  if grep -q 'built-in timeout' "$rendered" && grep -q 'timeout: 600000' "$rendered"; then
    pass "$rname contains portable built-in timeout guidance"
  else
    fail "$rname is missing portable built-in timeout guidance"
  fi
  if grep -q 'not installed by default on macOS' "$rendered"; then
    pass "$rname contains macOS portability warning"
  else
    fail "$rname is missing macOS portability warning"
  fi
done

TMUX_CAPTURE=()
tmux() {
  if [[ "${1:-}" == "send-keys" ]]; then
    shift
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -t)
          shift 2
          ;;
        --)
          shift
          ;;
        -l|C-m)
          shift
          ;;
        *)
          TMUX_CAPTURE+=("$1")
          shift
          ;;
      esac
    done
    return 0
  fi
  return 0
}

agent_prepare_pane_for_launch() {
  return 0
}

agent_verify_launch() {
  return 0
}

CODEX_PROMPT_FILE="$PROMPT_RENDER_DIR/interactive-codex-prompt.txt"
printf 'planning prompt\n' > "$CODEX_PROMPT_FILE"
agent_launch_interactive "wavemill-test" "planning" "$CODEX_PROMPT_FILE" "codex" "gpt-5.6-terra"

CODEX_LAUNCHER_PATH=""
for captured in "${TMUX_CAPTURE[@]}"; do
  captured="${captured##* }"
  if [[ "$captured" == */*-launcher.sh ]]; then
    printf -v CODEX_LAUNCHER_PATH '%b' "${captured//\\/\\\\}"
    break
  fi
done

if [[ -f "$CODEX_LAUNCHER_PATH" ]] \
  && grep -q 'codex --model gpt-5\.6-terra --dangerously-bypass-approvals-and-sandbox --no-alt-screen "\$(cat ' "$CODEX_LAUNCHER_PATH"; then
  pass "interactive Codex launcher uses interactive codex with bypass flag"
else
  fail "interactive Codex launcher is missing interactive codex flags"
fi

if [[ -f "$CODEX_LAUNCHER_PATH" ]] \
  && grep -q 'echo "\[wavemill\] Agent exited (\$?)"' "$CODEX_LAUNCHER_PATH"; then
  pass "interactive Codex launcher reports agent exit status"
else
  fail "interactive Codex launcher is missing exit status echo"
fi

echo ""
echo "=== Interactive Launch Verification ==="

unset -f agent_verify_launch
# shellcheck source=/dev/null
source "$LIB_DIR/agent-adapters.sh"
sleep() { :; }

VERIFY_TMUX_MODE="idle"
VERIFY_TMUX_CHILDREN=0
tmux() {
  case "${1:-}" in
    display-message)
      if [[ "${*: -1}" == '#{pane_current_command}' ]]; then
        case "$VERIFY_TMUX_MODE" in
          idle) echo "zsh" ;;
          running) echo "codex" ;;
          shell-child) echo "zsh" ;;
        esac
      elif [[ "${*: -1}" == '#{pane_pid}' ]]; then
        echo "$$"
      fi
      return 0
      ;;
  esac
  return 0
}
pgrep() {
  if [[ "${1:-}" == "-P" ]]; then
    local count="${VERIFY_TMUX_CHILDREN:-0}"
    local i=0
    while (( i < count )); do
      echo $((1000 + i))
      (( i += 1 ))
    done
    return 0
  fi
  return 1
}

VERIFY_TMUX_MODE="running"
VERIFY_TMUX_CHILDREN=0
if agent_verify_launch "wavemill-test" "planning" 0.1 0.05; then
  pass "agent_verify_launch succeeds when pane command leaves the shell"
else
  fail "agent_verify_launch did not detect a non-shell pane command"
fi

VERIFY_TMUX_MODE="shell-child"
VERIFY_TMUX_CHILDREN=2
if agent_verify_launch "wavemill-test" "planning" 0.1 0.05; then
  pass "agent_verify_launch succeeds when the shell has child processes"
else
  fail "agent_verify_launch did not detect shell child processes"
fi

VERIFY_TMUX_MODE="idle"
VERIFY_TMUX_CHILDREN=0
if agent_verify_launch "wavemill-test" "planning" 0.1 0.05; then
  fail "agent_verify_launch reported success for an idle shell"
else
  pass "agent_verify_launch fails when the pane stays idle"
fi

PANE_CHILD_CHECK=$(bash -lc '
  set -euo pipefail
  source "'"$LIB_DIR/agent-adapters.sh"'"
  tmux() {
    if [[ "${1:-}" == "display-message" && "${*: -1}" == "#{pane_pid}" ]]; then
      printf "%s\n" "$$"
      return 0
    fi
    return 1
  }
  pgrep() {
    if [[ "${1:-}" == "-P" ]]; then
      return 1
    fi
    return 2
  }
  printf "children=%s\n" "$(_pane_child_count wavemill-test:planning)"
' 2>/dev/null || true)
if [[ "$PANE_CHILD_CHECK" == "children=0" ]]; then
  pass "_pane_child_count treats missing child processes as zero"
else
  fail "_pane_child_count still fails when pgrep reports no child processes"
fi

VERIFY_TMUX_MODE="running"
VERIFY_TMUX_CHILDREN=1
if agent_verify_launch "wavemill-test" "planning" 0.1 0.05 "codex" "1"; then
  fail "agent_verify_launch mistook a pre-existing busy pane for a fresh launch"
else
  pass "agent_verify_launch ignores a pre-existing busy pane state"
fi

VERIFY_TMUX_MODE="running"
VERIFY_TMUX_CHILDREN=2
if agent_verify_launch "wavemill-test" "planning" 0.1 0.05 "codex" "1"; then
  pass "agent_verify_launch succeeds once pane state changes after dispatch"
else
  fail "agent_verify_launch did not detect a post-dispatch pane state change"
fi

LAUNCH_VERIFY_RESULTS=(1 0)
LAUNCH_VERIFY_INDEX=0
LAUNCH_SEND_KEYS=0
tmux() {
  if [[ "${1:-}" == "send-keys" ]]; then
    LAUNCH_SEND_KEYS=$((LAUNCH_SEND_KEYS + 1))
  fi
  return 0
}
agent_prepare_pane_for_launch() {
  return 0
}
agent_verify_launch() {
  local result="${LAUNCH_VERIFY_RESULTS[$LAUNCH_VERIFY_INDEX]:-1}"
  LAUNCH_VERIFY_INDEX=$((LAUNCH_VERIFY_INDEX + 1))
  return "$result"
}
AGENT_LAUNCH_MAX_RETRIES=2
AGENT_LAUNCH_SETTLE_DELAY=0
AGENT_LAUNCH_ENTER_DELAY=0
AGENT_LAUNCH_RETRY_DELAY=0
printf 'retry prompt\n' > "$CODEX_PROMPT_FILE"
if agent_launch_interactive "wavemill-test" "planning" "$CODEX_PROMPT_FILE" "codex" "gpt-5.6-terra" ""; then
  if [[ "$LAUNCH_VERIFY_INDEX" -eq 2 ]] && [[ "$LAUNCH_SEND_KEYS" -ge 5 ]]; then
    pass "agent_launch_interactive retries dispatch after a failed verification"
  else
    fail "agent_launch_interactive did not perform the expected retry sequence"
  fi
else
  fail "agent_launch_interactive should have succeeded after a retry"
fi

if [[ "$(agent_tmux_target "wavemill-test" "@42")" == "@42" ]] \
  && [[ "$(agent_tmux_target "wavemill-test" "planning")" == "wavemill-test:planning" ]]; then
  pass "agent_tmux_target preserves stable tmux window ids"
else
  fail "agent_tmux_target does not preserve stable tmux window ids"
fi

LAUNCH_VERIFY_RESULTS=(0)
LAUNCH_VERIFY_INDEX=0
LAUNCH_SEND_TARGETS=()
tmux() {
  if [[ "${1:-}" == "send-keys" ]]; then
    local i target_arg=""
    for ((i = 1; i <= $#; i++)); do
      if [[ "${!i}" == "-t" ]]; then
        local j=$((i + 1))
        target_arg="${!j}"
        break
      fi
    done
    LAUNCH_SEND_TARGETS+=("$target_arg")
  fi
  return 0
}
agent_prepare_pane_for_launch() {
  return 0
}
agent_verify_launch() {
  LAUNCH_VERIFY_INDEX=$((LAUNCH_VERIFY_INDEX + 1))
  return 0
}
AGENT_LAUNCH_MAX_RETRIES=1
if agent_launch_interactive "wavemill-test" "@42" "$CODEX_PROMPT_FILE" "codex" "gpt-5.6-terra" ""; then
  if printf '%s\n' "${LAUNCH_SEND_TARGETS[@]}" | grep -qx '@42' \
    && ! printf '%s\n' "${LAUNCH_SEND_TARGETS[@]}" | grep -qx 'wavemill-test:@42'; then
    pass "agent_launch_interactive dispatches directly to stable tmux window ids"
  else
    fail "agent_launch_interactive rebuilt a stable tmux window id as a session:name target"
  fi
else
  fail "agent_launch_interactive failed for stable tmux window id target"
fi

LAUNCH_VERIFY_RESULTS=(1)
LAUNCH_VERIFY_INDEX=0
LAUNCH_SEND_KEYS=0
tmux() {
  if [[ "${1:-}" == "send-keys" ]]; then
    LAUNCH_SEND_KEYS=$((LAUNCH_SEND_KEYS + 1))
  fi
  return 0
}
agent_verify_launch() {
  local result="${LAUNCH_VERIFY_RESULTS[$LAUNCH_VERIFY_INDEX]:-1}"
  LAUNCH_VERIFY_INDEX=$((LAUNCH_VERIFY_INDEX + 1))
  return "$result"
}
AGENT_LAUNCH_MAX_RETRIES=1
if agent_launch_interactive "wavemill-test" "planning" "$CODEX_PROMPT_FILE" "codex" "gpt-5.6-terra" ""; then
  fail "agent_launch_interactive succeeded even though verification never passed"
else
  if [[ "$LAUNCH_VERIFY_INDEX" -eq 1 ]] && [[ "$LAUNCH_SEND_KEYS" -ge 3 ]]; then
    pass "agent_launch_interactive returns failure when launch verification never passes"
  else
    fail "agent_launch_interactive failure path did not execute the expected send-keys sequence"
  fi
fi

LAUNCH_VERIFY_INDEX=0
LAUNCH_SEND_KEYS=0
LAUNCH_RESPAWNS=0
LAUNCH_READY_INDEX=0
tmux() {
  case "${1:-}" in
    send-keys)
      LAUNCH_SEND_KEYS=$((LAUNCH_SEND_KEYS + 1))
      return 0
      ;;
    respawn-pane)
      LAUNCH_RESPAWNS=$((LAUNCH_RESPAWNS + 1))
      return 0
      ;;
    display-message)
      if [[ "${*: -1}" == '#{pane_current_path}' ]]; then
        printf '%s\n' "$PWD"
      elif [[ "${*: -1}" == '#{pane_current_command}' ]]; then
        printf '%s\n' "zsh"
      elif [[ "${*: -1}" == '#{pane_pid}' ]]; then
        printf '%s\n' "$$"
      fi
      return 0
      ;;
  esac
  return 0
}
agent_prepare_pane_for_launch() {
  return 1
}
agent_pane_is_ready() {
  local ready_states=(1 0)
  local result="${ready_states[$LAUNCH_READY_INDEX]:-0}"
  LAUNCH_READY_INDEX=$((LAUNCH_READY_INDEX + 1))
  return "$result"
}
agent_verify_launch() {
  LAUNCH_VERIFY_INDEX=$((LAUNCH_VERIFY_INDEX + 1))
  return 0
}
AGENT_LAUNCH_MAX_RETRIES=1
if agent_launch_interactive "wavemill-test" "planning" "$CODEX_PROMPT_FILE" "codex" "gpt-5.6-terra" ""; then
  if [[ "$LAUNCH_RESPAWNS" -ge 2 ]] && [[ "$LAUNCH_SEND_KEYS" -ge 2 ]] && [[ "$LAUNCH_VERIFY_INDEX" -eq 1 ]]; then
    pass "agent_launch_interactive respawns before dispatch when pane prep or readiness fails"
  else
    fail "agent_launch_interactive did not use the respawn fallback before dispatch"
  fi
else
  fail "agent_launch_interactive failed to recover with respawn fallback"
fi

unset -f agent_pane_is_ready
unset AGENT_LAUNCH_MAX_RETRIES AGENT_LAUNCH_SETTLE_DELAY AGENT_LAUNCH_ENTER_DELAY AGENT_LAUNCH_RETRY_DELAY
unset -f sleep pgrep

# ============================================================================
# TEST 8: Dashboard log filtering behavior
# ============================================================================
echo ""
echo "=== Dashboard Log Filtering ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found for log filtering checks"
else
  selection_prompt_uses_echo=1
  if grep -Fq 'log "status" "Next tasks:"' "$MILL_SCRIPT" || grep -Fq 'log "status" "Next tasks:"' "$MONITOR_FILE"; then
    selection_prompt_uses_echo=0
  fi
  if ! grep -Fq 'echo "Next tasks:"' "$MONITOR_FILE" && ! grep -Fq '_task_frame="Next tasks:"' "$MONITOR_FILE"; then
    selection_prompt_uses_echo=0
  fi
  if ! grep -Fq 'log "info" "All tasks:"' "$MONITOR_FILE"; then
    selection_prompt_uses_echo=0
  fi
  if grep -Fq 'slot(s) available. Next tasks:' "$MILL_SCRIPT" || grep -Fq 'slot(s) available. All tasks:' "$MILL_SCRIPT" \
    || grep -Fq 'slot(s) available. Next tasks:' "$MONITOR_FILE" || grep -Fq 'slot(s) available. All tasks:' "$MONITOR_FILE"; then
    selection_prompt_uses_echo=0
  fi

  if [[ "$selection_prompt_uses_echo" -eq 1 ]]; then
    pass "monitor uses echo for interactive prompts, not log"
  else
    fail "monitor should use echo (not log) for task selection prompt"
  fi

  LOG_FUNCTION_BLOCK=$(awk '
    /^_log_level_num\(\) \{/ && !captured { capture=1; captured=1 }
    capture && /^render_prompt_template\(\) \{/ { exit }
    capture { print }
  ' "$MILL_SCRIPT")

  if [[ -z "$LOG_FUNCTION_BLOCK" ]]; then
    fail "Could not extract log function block"
  else
    LOG_TEST_DIR=$(mktemp -d)
    LOG_TEST_SCRIPT="$LOG_TEST_DIR/log-functions.sh"
    printf '%s\n' "$LOG_FUNCTION_BLOCK" > "$LOG_TEST_SCRIPT"

    SINGLE_OUTPUT=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      DASHBOARD_VERBOSITY=info
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=false
      unset STATUS_LOG_FILE MILL_LOG_FILE
      log "plain message"
    ' 2>/dev/null || true)
    if [[ "$SINGLE_OUTPUT" == *"plain message"* ]]; then
      pass "single-arg log defaults to info output"
    else
      fail "single-arg log does not default to info output"
    fi

    ERROR_OUTPUT=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      DASHBOARD_VERBOSITY=error
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=false
      unset STATUS_LOG_FILE MILL_LOG_FILE
      log "error" "always visible"
    ' 2>/dev/null || true)
    if [[ "$ERROR_OUTPUT" == *"always visible"* ]]; then
      pass "error-level log shows at error verbosity"
    else
      fail "error-level log is hidden at error verbosity"
    fi

    DEBUG_OUTPUT=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      DASHBOARD_VERBOSITY=info
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=false
      unset STATUS_LOG_FILE MILL_LOG_FILE
      log "debug" "hidden debug"
    ' 2>/dev/null || true)
    if [[ -z "$DEBUG_OUTPUT" ]]; then
      pass "debug-level log is suppressed at info verbosity"
    else
      fail "debug-level log is not suppressed at info verbosity"
    fi

    STATUS_OUTPUT=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      DASHBOARD_VERBOSITY=status
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=false
      unset STATUS_LOG_FILE MILL_LOG_FILE
      log "info" "hidden info"
    ' 2>/dev/null || true)
    if [[ -z "$STATUS_OUTPUT" ]]; then
      pass "info-level log is suppressed at status verbosity"
    else
      fail "info-level log is not suppressed at status verbosity"
    fi

    LOG_FILE_CHECK=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      TMP_LOG=$(mktemp)
      DASHBOARD_VERBOSITY=error
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=true
      MILL_LOG_FILE="$TMP_LOG"
      log "debug" "persisted debug"
      cat "$TMP_LOG"
    ' 2>/dev/null || true)
    if [[ "$LOG_FILE_CHECK" == *"[debug] persisted debug"* ]]; then
      pass "suppressed logs still write to session log file"
    else
      fail "suppressed logs do not write to session log file"
    fi

    STATUS_PANE_CHECK=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      TMP_STATUS=$(mktemp)
      DASHBOARD_VERBOSITY=info
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=false
      STATUS_LOG_FILE="$TMP_STATUS"
      log "status" "pane line"
      cat "$TMP_STATUS"
    ' 2>/dev/null || true)
    if [[ "$STATUS_PANE_CHECK" == *"pane line"* ]]; then
      pass "visible logs write to dedicated control status log"
    else
      fail "visible logs do not write to dedicated control status log"
    fi

    STATUS_PANE_STDOUT=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      TMP_STATUS=$(mktemp)
      DASHBOARD_VERBOSITY=info
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=false
      STATUS_LOG_FILE="$TMP_STATUS"
      log "status" "pane only"
    ' 2>/dev/null || true)
    if [[ -z "$STATUS_PANE_STDOUT" ]]; then
      pass "status pane logging stays out of the task list pane"
    else
      fail "status pane logging still writes to stdout"
    fi

    rm -rf "$LOG_TEST_DIR"
  fi
fi

# ============================================================================
# TEST 9: Mill drift refresh prompt wiring
# ============================================================================
echo ""
echo "=== Mill Drift Refresh Wiring ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found for drift refresh checks"
else
  if grep -q 'check_subsystem_drift() {' "$MILL_SCRIPT" \
    && grep -q 'npx tsx tools/check-drift.ts "\$REPO_DIR"' "$MILL_SCRIPT"; then
    pass "mill script defines subsystem drift wrapper"
  else
    fail "mill script is missing subsystem drift wrapper"
  fi

  if grep -q "Warning: Subsystem docs stale" "$MILL_SCRIPT" \
    && grep -q "press d to refresh" "$MILL_SCRIPT"; then
    pass "mill script shows stale docs advisory"
  else
    fail "mill script is missing stale docs advisory"
  fi

  if grep -q "d to refresh docs" "$MILL_SCRIPT" \
    && grep -q '\[\[ "\$SELECTED" =~ ^\[dD\](ocs)?\$ \]\]' "$MILL_SCRIPT"; then
    pass "mill script supports docs refresh hotkey"
  else
    fail "mill script is missing docs refresh hotkey support"
  fi

  if grep -q 'npx tsx tools/init-project-context.ts --refresh "\$REPO_DIR"' "$MILL_SCRIPT" \
    && grep -q 'Subsystem docs are up to date' "$MILL_SCRIPT"; then
    pass "mill script refreshes docs and handles clean state"
  else
    fail "mill script is missing docs refresh command or clean-state message"
  fi
fi

# ============================================================================
# TEST 10: route.json fallback helper behavior
# ============================================================================
echo ""
echo "=== route.json Fallback Helper ==="

COMMON_LIB="$LIB_DIR/wavemill-common.sh"

if [[ ! -f "$COMMON_LIB" ]]; then
  fail "wavemill-common.sh not found"
else
  source "$COMMON_LIB"

  _test_route_helper() {
    local session="$1" issue="$2" field="$3" default_value="${4:-}"
    SESSION="$session" read_route_json "$session" "$issue" "$field" "$default_value"
  }

  route_session="check-shell-$$"
  route_issue="HOK-1198"
  route_file="/tmp/${route_session}-${route_issue}-route.json"
  suggestion_file="/tmp/${route_session}-${route_issue}-model-suggestion.json"
  rm -f "$route_file" "$suggestion_file"
  trap 'rm -f "$route_file" "$suggestion_file"' EXIT

  cat > "$route_file" <<'EOF'
{"planner":"planner-a","coder":"coder-a","reviewer":"reviewer-a","planDepth":"deep","codeDepth":"medium","reviewRecommended":"dynamic","provenance":{"inputHash":"abc123","source":"expanded"}}
EOF
  if [[ "$(_test_route_helper "$route_session" "$route_issue" "coder")" == "coder-a" ]] \
    && [[ "$(_test_route_helper "$route_session" "$route_issue" "planner")" == "planner-a" ]] \
    && [[ "$(_test_route_helper "$route_session" "$route_issue" "reviewRecommended" "static")" == "dynamic" ]] \
    && [[ "$(_test_route_helper "$route_session" "$route_issue" "inputHash" "none")" == "abc123" ]]; then
    pass "read_route_json returns values from canonical route.json"
  else
    fail "read_route_json does not read route.json fields correctly"
  fi

  rm -f "$route_file"
  cat > "$suggestion_file" <<'EOF'
{"recommendedModel":"coder-compat","recommendedAgent":"codex"}
EOF
  if [[ "$(_test_route_helper "$route_session" "$route_issue" "coder")" == "coder-compat" ]]; then
    pass "read_route_json falls back to model-suggestion.json for coder"
  else
    fail "read_route_json did not use compat coder fallback"
  fi

  if [[ "$(_test_route_helper "$route_session" "$route_issue" "planner" "planner-default")" == "planner-default" ]]; then
    pass "read_route_json does not invent non-coder compat fields"
  else
    fail "read_route_json returned unexpected compat data for planner"
  fi

  rm -f "$suggestion_file"
  if [[ "$(_test_route_helper "$route_session" "$route_issue" "coder" "coder-default")" == "coder-default" ]]; then
    pass "read_route_json returns the supplied default when artifacts are missing"
  else
    fail "read_route_json did not return default when artifacts were missing"
  fi

  cat > "$route_file" <<'EOF'
{"coder":"coder-b"}
EOF
  if [[ "$(_test_route_helper "$route_session" "$route_issue" "reviewRecommended" "static")" == "static" ]]; then
    pass "read_route_json returns defaults for missing route.json fields"
  else
    fail "read_route_json did not return default for missing route.json field"
  fi

  if [[ "$(_test_route_helper "$route_session" "$route_issue" "source" "live")" == "live" ]]; then
    pass "read_route_json returns defaults for missing provenance fields"
  else
    fail "read_route_json did not return default for missing provenance field"
  fi

  cat > "$route_file" <<'EOF'
{"coder":
EOF
  cat > "$suggestion_file" <<'EOF'
{"recommendedModel":"coder-from-shim"}
EOF
  if [[ "$(_test_route_helper "$route_session" "$route_issue" "coder" "coder-default")" == "coder-from-shim" ]]; then
    pass "read_route_json falls back to compat shim when route.json is malformed"
  else
    fail "read_route_json did not recover from malformed route.json"
  fi

  rm -f "$route_file" "$suggestion_file"
fi

# ============================================================================
# TEST 11: Interactive launcher model validation
# ============================================================================
echo ""
echo "=== Interactive Launcher Model Validation ==="

ADAPTER_LIB="$LIB_DIR/agent-adapters.sh"

if [[ ! -f "$ADAPTER_LIB" ]]; then
  fail "agent-adapters.sh not found"
else
  TOOLS_DIR="$REPO_DIR/tools"
  REPO_DIR_ORIG="$REPO_DIR"
  export TOOLS_DIR REPO_DIR
  # shellcheck source=/dev/null
  source "$ADAPTER_LIB"

  # agent_launch_interactive paces tmux dispatch with real sleeps: two
  # hardcoded 0.5s waits plus the settle/enter/retry delays. Setting the
  # AGENT_LAUNCH_*_DELAY knobs to 0 would only cover the latter three, so stub
  # sleep outright -- as the launch-verification section above already does.
  # That stub is unset at the end of that section, so it must be redone here.
  # These assertions check validation and dispatch behaviour, never timing.
  sleep() { :; }

  agent_prepare_pane_for_launch() { return 0; }
  agent_verify_launch() { return 0; }
  tmux() { :; }

  launch_session="check-shell-$$"
  prompt_file="/tmp/${launch_session}-prompt.txt"
  launcher_file="/tmp/${launch_session}-$(basename "$prompt_file" .txt)-launcher.sh"
  trap 'rm -f "$prompt_file" "$launcher_file"' EXIT
  printf 'test prompt\n' > "$prompt_file"
  rm -f "$launcher_file"

  if agent_launch_interactive "$launch_session" "window" "$prompt_file" "codex" "deep" "" ""; then
    if [[ -f "$launcher_file" ]] \
      && grep -q 'codex --model gpt-5.6-terra' "$launcher_file" \
      && grep -q "export WAVEMILL_SESSION='$launch_session'" "$launcher_file" \
      && ! grep -q -- '--model deep' "$launcher_file"; then
      pass "interactive launcher replaces depth tags with a valid codex model and exports status env"
    else
      fail "interactive launcher did not sanitize invalid codex model or export status env"
    fi
  else
    fail "interactive launcher failed for invalid model fallback test"
  fi

  rm -f "$launcher_file"
  if agent_launch_interactive "$launch_session" "window" "$prompt_file" "codex" "gpt-5.6-terra" "" "" "HOK-1221"; then
    if [[ -f "$launcher_file" ]] \
      && grep -q 'codex --model gpt-5.6-terra' "$launcher_file" \
      && grep -q "export WAVEMILL_ISSUE='HOK-1221'" "$launcher_file" \
      && grep -q '/tmp/check-shell-.*-status.txt' "$launcher_file"; then
      pass "interactive launcher preserves valid codex models and writes initial status"
    else
      fail "interactive launcher did not preserve valid codex model or initial status wiring"
    fi
  else
    fail "interactive launcher failed for valid model test"
  fi

  deepseek_repo="$(mktemp -d)"
  cat > "$deepseek_repo/.wavemill-config.json" <<'EOF'
{
  "providers": {
    "deepseek": {
      "enabled": true,
      "apiKeyEnv": "TEST_DEEPSEEK_KEY",
      "effortLevel": "high"
    }
  }
}
EOF
  export TEST_DEEPSEEK_KEY="deepseek-test-secret"
  REPO_DIR="$deepseek_repo"

  rm -f "$launcher_file"
  if agent_launch_interactive "$launch_session" "window" "$prompt_file" "claude" "deepseek-v4-pro" "" "" "HOK-1485"; then
    if [[ -f "$launcher_file" ]] \
      && grep -q "ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic'" "$launcher_file" \
      && grep -q "api_key_env='TEST_DEEPSEEK_KEY'" "$launcher_file" \
      && grep -q "CLAUDE_CODE_EFFORT_LEVEL='high'" "$launcher_file" \
      && grep -q "/.wavemill/runs/HOK-1485/providers/deepseek/home" "$launcher_file" \
      && ! grep -q 'deepseek-test-secret' "$launcher_file"; then
      pass "interactive launcher isolates DeepSeek Claude runs without persisting the API key"
    else
      fail "interactive launcher did not configure the DeepSeek Claude provider correctly"
    fi
  else
    fail "interactive launcher failed for DeepSeek provider test"
  fi

  unset TEST_DEEPSEEK_KEY
  rm -f "$launcher_file"
  if agent_launch_interactive "$launch_session" "window" "$prompt_file" "claude" "deepseek-v4-pro" "" "" "HOK-1485"; then
    fail "interactive launcher succeeded without the DeepSeek API key"
  else
    pass "interactive launcher fails fast when the DeepSeek API key is missing"
  fi

  rm -rf "$deepseek_repo"
  REPO_DIR="$REPO_DIR_ORIG"
  export REPO_DIR

  unset -f sleep

  rm -f "$prompt_file" "$launcher_file"
fi

# ============================================================================
# TEST 12A: Hook adapter files
# ============================================================================
echo ""
echo "=== Hook Adapter Files ==="

if [[ -f "$REPO_DIR/shared/hooks/wavemill-status-writer.sh" ]] \
  && [[ -f "$REPO_DIR/shared/hooks/claude-status-hook.sh" ]] \
  && [[ -f "$REPO_DIR/shared/hooks/codex-status-monitor.sh" ]] \
  && [[ -f "$REPO_DIR/shared/hooks/process-status-monitor.sh" ]]; then
  pass "all legacy and current hook adapter scripts exist"
elif [[ -f "$REPO_DIR/shared/hooks/claude-status-hook.sh" ]] \
  && [[ -f "$REPO_DIR/shared/hooks/codex-status-monitor.sh" ]] \
  && [[ -f "$REPO_DIR/shared/hooks/process-status-monitor.sh" ]]; then
  pass "current hook adapter scripts exist"
else
  fail "one or more hook adapter scripts are missing"
fi

if [[ -f "$REPO_DIR/shared/lib/wavemill-common.sh" ]] \
  && grep -q '\.claude/settings.local.json' "$REPO_DIR/shared/lib/wavemill-common.sh" \
  && grep -q 'claude-status-hook\.sh' "$REPO_DIR/shared/lib/wavemill-common.sh" \
  && grep -q 'UserPromptSubmit' "$REPO_DIR/shared/lib/wavemill-common.sh" \
  && grep -q 'PreToolUse' "$REPO_DIR/shared/lib/wavemill-common.sh" \
  && grep -q 'Notification' "$REPO_DIR/shared/lib/wavemill-common.sh"; then
  pass "claude worktree-local hooks are configured for status tracking"
else
  fail "claude hook configuration is missing worktree-local status tracking"
fi

# ============================================================================
# TEST 12: Review window restoration helper
# ============================================================================
echo ""
echo "=== Review Window Restoration ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found for review restoration checks"
else
  RESTORE_BLOCK=$(awk '
    /^restore_review_task_window\(\) \{/ { capture=1 }
    capture { print }
    capture && /^\}/ { exit }
  ' "$MONITOR_FILE")

  if [[ -z "$RESTORE_BLOCK" ]]; then
    fail "Could not extract review restoration helper"
  else
    RESTORE_DIR=$(mktemp -d)
    RESTORE_SCRIPT="$RESTORE_DIR/review-restore.sh"
    printf '%s\n' "$RESTORE_BLOCK" > "$RESTORE_SCRIPT"

    RESTORE_CHECK=$(bash -lc '
      set -euo pipefail
      source "'"$RESTORE_SCRIPT"'"
      TEST_DIR=$(mktemp -d)
      trap "rm -rf \"$TEST_DIR\"" EXIT
      SESSION="restore-test"
      REPO_DIR="$TEST_DIR/repo"
      WORKTREE_ROOT="$TEST_DIR/worktrees"
      API_TIMEOUT=5
      TOOLS_DIR="$TEST_DIR/tools"
      mkdir -p "$REPO_DIR/.git" "$WORKTREE_ROOT" "$TOOLS_DIR"
      WT_DIR="$WORKTREE_ROOT/resumed-task"
      mkdir -p "$WT_DIR"
      mkdir -p "/tmp"
      cat > "/tmp/${SESSION}-HOK-1226-issue.json" <<EOF
{"title":"Restore review window","description":"Bring back the task window after resume."}
EOF
      TMUX_LOG="$TEST_DIR/tmux.log"
      log() { :; }
      log_warn() { :; }
      get_linear_issue_id() { echo "HOK-1226"; }
      read_state_value() { printf "%s\n" "$1"; }
      _with_timeout() { printf "%s\n" "{}"; }
      _pane_is_dead_or_idle() { return 0; }
      tmux() {
        case "${1:-}" in
          list-windows)
            return 1
            ;;
          new-window)
            printf "new-window %s\n" "$*" >> "$TMUX_LOG"
            return 0
            ;;
          set-option)
            printf "set-option %s\n" "$*" >> "$TMUX_LOG"
            return 0
            ;;
          send-keys)
            printf "send-keys %s\n" "$*" >> "$TMUX_LOG"
            return 0
            ;;
        esac
        return 0
      }
      restore_review_task_window "HOK-1226" "resumed-task" "task/resumed-task" "267" "$WT_DIR"
      printf "header=%s details=%s tmux=%s\n" \
        "$([[ -f "$WT_DIR/features/resumed-task/task-packet-header.md" ]] && echo yes || echo no)" \
        "$([[ -f "$WT_DIR/features/resumed-task/task-packet-details.md" ]] && echo yes || echo no)" \
        "$([[ -s "$TMUX_LOG" ]] && echo yes || echo no)"
    ' 2>/dev/null || true)

    if [[ "$RESTORE_CHECK" == *"header=yes"* ]] \
      && [[ "$RESTORE_CHECK" == *"details=yes"* ]] \
      && [[ "$RESTORE_CHECK" == *"tmux=yes"* ]]; then
      pass "restore_review_task_window rebuilds task context files and tmux window"
    else
      fail "restore_review_task_window did not rebuild review context correctly"
    fi

    rm -rf "$RESTORE_DIR"
  fi
fi

# ============================================================================
# TEST 13: Phase launch failure recovery helper
# ============================================================================
echo ""
echo "=== Phase Launch Recovery ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found for launch recovery checks"
else
  RECOVERY_BLOCK=$(awk '
    /^clear_stage_result\(\) \{/ && !captured { capture=1; captured=1 }
    capture && /^# Resolve the current workflow phase from controller-owned stage state\./ { exit }
    capture { print }
  ' "$MONITOR_FILE")

  if [[ -z "$RECOVERY_BLOCK" ]]; then
    fail "Could not extract phase launch recovery helper"
  else
    RECOVERY_DIR=$(mktemp -d)
    RECOVERY_SCRIPT="$RECOVERY_DIR/recovery.sh"
    printf '%s\n' "$RECOVERY_BLOCK" > "$RECOVERY_SCRIPT"

    FAILURE_CHECK=$(bash -lc '
      set -euo pipefail
      source "'"$RECOVERY_SCRIPT"'"
      TEST_DIR=$(mktemp -d)
      trap "rm -rf \"$TEST_DIR\"" EXIT
      touch "$TEST_DIR/.coding-result.json"
      PHASE_SET=""
      ATTN_SET=""
      LOG_LINE=""
      set_task_phase() { PHASE_SET="$2"; }
      set_window_attention_state() { ATTN_SET="$2"; }
      check_stage_aborted() { return 1; }
      write_stage_result() { :; }
      log() { LOG_LINE="$*"; }
      set +e
      handle_phase_launch_result "HOK-1212" "$TEST_DIR" "coding" "planning" 1 "win-1" "codex" "gpt-5.6-terra"
      rc=$?
      set -e
      printf "rc=%s phase=%s attn=%s exists=%s log=%s\n" "$rc" "$PHASE_SET" "$ATTN_SET" "$([[ -f "$TEST_DIR/.coding-result.json" ]] && echo yes || echo no)" "$LOG_LINE"
    ' 2>/dev/null || true)
    if [[ "$FAILURE_CHECK" == *"rc=1"* ]] \
      && [[ "$FAILURE_CHECK" == *"phase=planning"* ]] \
      && [[ "$FAILURE_CHECK" == *"attn=needs-user"* ]] \
      && [[ "$FAILURE_CHECK" == *"exists=no"* ]]; then
      pass "handle_phase_launch_result clears running state and reverts phase after launch failure"
    else
      fail "handle_phase_launch_result did not revert failed launches correctly"
    fi

    ABORT_CHECK=$(bash -lc '
      set -euo pipefail
      source "'"$RECOVERY_SCRIPT"'"
      TEST_DIR=$(mktemp -d)
      trap "rm -rf \"$TEST_DIR\"" EXIT
      PHASE_SET=""
      ATTN_SET=""
      WRITES=""
      set_task_phase() { PHASE_SET="$2"; }
      set_window_attention_state() { ATTN_SET="$2"; }
      check_stage_aborted() { return 0; }
      write_stage_result() { WRITES="$1|$2|$3|$4|$5"; }
      log() { :; }
      set +e
      handle_phase_launch_result "HOK-1212" "$TEST_DIR" "review" "coding" 2 "win-1" "claude" "sonnet"
      rc=$?
      set -e
      printf "rc=%s phase=%s attn=%s write=%s\n" "$rc" "$PHASE_SET" "$ATTN_SET" "$WRITES"
    ' 2>/dev/null || true)
    if [[ "$ABORT_CHECK" == *"rc=1"* ]] \
      && [[ "$ABORT_CHECK" == *"phase=aborted"* ]] \
      && [[ "$ABORT_CHECK" == *"attn=needs-user"* ]] \
      && [[ "$ABORT_CHECK" == *"|review|aborted|claude|sonnet"* ]]; then
      pass "handle_phase_launch_result records an aborted stage when launch aborts"
    else
      fail "handle_phase_launch_result did not preserve abort semantics"
    fi

    rm -rf "$RECOVERY_DIR"
  fi
fi

# ============================================================================
# TEST 14: Pane handoff regression guards
# ============================================================================
echo ""
echo "=== Pane Handoff Guards ==="

if [[ ! -f "$ADAPTER_LIB" ]]; then
  fail "agent-adapters.sh not found for pane handoff checks"
else
  PREPARE_CHECK=$(bash -lc '
    set -euo pipefail
    source "'"$ADAPTER_LIB"'"
    sleep() { :; }
    agent_terminate_in_pane() { return 1; }
    agent_wait_for_pane_ready() { return 1; }
    tmux() {
      if [[ "${1:-}" == "display-message" && "${*: -1}" == "#{pane_pid}" ]]; then
        printf "%s\n" "$$"
      fi
      return 0
    }
    pkill() { return 0; }
    set +e
    agent_prepare_pane_for_launch "wavemill-test" "coding" 0 0 ""
    rc=$?
    set -e
    printf "rc=%s\n" "$rc"
  ' 2>/dev/null || true)
  if [[ "$PREPARE_CHECK" == *"rc=1"* ]]; then
    pass "agent_prepare_pane_for_launch returns failure when respawn cannot clear the pane"
  else
    fail "agent_prepare_pane_for_launch still falls through as success after respawn failure"
  fi
fi

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found for pane handoff checks"
else
  CODING_LAUNCH_BLOCK=$(awk '
    /^launch_coding_phase\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' "$MONITOR_FILE")
  if grep -q '_launch_agent_in_pane' <<< "$CODING_LAUNCH_BLOCK"; then
    pass "launch_coding_phase uses protected pane launcher"
  else
    fail "launch_coding_phase does not call protected pane launcher"
  fi

  REVIEW_LAUNCH_BLOCK=$(awk '
    /^launch_review_phase\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' "$MONITOR_FILE")
  if grep -q '_launch_agent_in_pane' <<< "$REVIEW_LAUNCH_BLOCK"; then
    pass "launch_review_phase uses protected pane launcher"
  else
    fail "launch_review_phase does not call protected pane launcher"
  fi

  LAUNCH_AGENT_BLOCK=$(awk '
    /^_launch_agent_in_pane\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' "$MONITOR_FILE")
  if grep -q 'local esc_session esc_issue esc_slug esc_linear_issue linear_issue=""' <<< "$LAUNCH_AGENT_BLOCK"; then
    pass "protected pane launcher initializes linear_issue for strict-mode watchdog launches"
  else
    fail "protected pane launcher can read unbound linear_issue under set -u"
  fi
fi

# ============================================================================
# TEST 15: Next done cycling keybinding
# ============================================================================
echo ""
echo "=== Next Done Cycling ==="

NEXT_DONE_SCRIPT="$LIB_DIR/wavemill-next-done.sh"

if [[ ! -f "$NEXT_DONE_SCRIPT" ]]; then
  fail "wavemill-next-done.sh not found"
else
  EMPTY_SESSION_RUN=$(bash "$NEXT_DONE_SCRIPT" 2>/dev/null; printf 'rc=%s' "$?")
  if [[ "$EMPTY_SESSION_RUN" == "rc=0" ]]; then
    pass "next done script exits cleanly outside wavemill"
  else
    fail "next done script does not no-op cleanly without a session"
  fi

  NEXT_DONE_CHECK=$(bash -lc '
    set -euo pipefail
    SCRIPT="'"$NEXT_DONE_SCRIPT"'"
    TEST_SESSION="next-done-check-$$"
    TEST_BIN=$(mktemp -d)
    TEST_HOME=$(mktemp -d)
    IDX_FILE="/tmp/wavemill-${TEST_SESSION}-next-done-idx"
    LOG_FILE="$TEST_HOME/tmux.log"
    trap '\''rm -rf "$TEST_BIN" "$TEST_HOME"; rm -f /tmp/wavemill-"${TEST_SESSION}"-*.hook "$IDX_FILE"'\'' EXIT

    cat > "$TEST_BIN/tmux" <<'\''EOF'\''
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  list-windows)
    printf "%s\n" "control" "HOK-1-first-task" "HOK-2-busy-task" "HOK-3-stale-task" "HOK-4-bad-json" "HOK-5-second-task"
    ;;
  select-window)
    printf "%s\n" "${*: -1}" >> "${NEXT_DONE_TMUX_LOG:?}"
    ;;
esac
EOF
    chmod +x "$TEST_BIN/tmux"

    now=$(date +%s)
    cat > "/tmp/wavemill-${TEST_SESSION}-HOK-1.hook" <<EOF
{"state":"idle","timestamp":$now}
EOF
    cat > "/tmp/wavemill-${TEST_SESSION}-HOK-2.hook" <<EOF
{"state":"working","timestamp":$now}
EOF
    cat > "/tmp/wavemill-${TEST_SESSION}-HOK-3.hook" <<EOF
{"state":"idle","timestamp":$((now - 301))}
EOF
    cat > "/tmp/wavemill-${TEST_SESSION}-HOK-4.hook" <<'\''EOF'\''
{"state":
EOF
    cat > "/tmp/wavemill-${TEST_SESSION}-HOK-5.hook" <<EOF
{"state":"idle","timestamp":$now}
EOF

    export PATH="$TEST_BIN:$PATH"
    export NEXT_DONE_TMUX_LOG="$LOG_FILE"

    printf "garbage\n" > "$IDX_FILE"
    WAVEMILL_SESSION="$TEST_SESSION" bash "$SCRIPT"
    WAVEMILL_SESSION="$TEST_SESSION" bash "$SCRIPT"

    printf "selects=%s|" "$(paste -sd, "$LOG_FILE")"
    printf "idx=%s" "$(cat "$IDX_FILE")"
  ' 2>/dev/null || true)

  if [[ "$NEXT_DONE_CHECK" == *"selects=next-done-check-"*":HOK-1-first-task,next-done-check-"*":HOK-5-second-task|"* ]] \
    && [[ "$NEXT_DONE_CHECK" == *"idx=1"* ]]; then
    pass "next done script cycles fresh idle windows in tmux order"
  else
    fail "next done script did not cycle the expected idle windows"
  fi

  NEXT_DONE_BINDING_BLOCK=$(awk '
    /^create_tmux_session\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' "$MILL_SCRIPT")
  if grep -q "bind-key -T prefix N run-shell" <<< "$NEXT_DONE_BINDING_BLOCK" \
    && grep -q "WAVEMILL_SESSION='#{session_name}'" <<< "$NEXT_DONE_BINDING_BLOCK" \
    && grep -q "wavemill-next-done.sh" <<< "$NEXT_DONE_BINDING_BLOCK"; then
    pass "mill session setup binds prefix+N to next done helper"
  else
    fail "mill session setup is missing the next done keybinding"
  fi

  if grep -q '^declare -a WAVEMILL_USAGE_TIPS=' "$REPO_DIR/shared/lib/wavemill-common.sh"; then
    pass "wavemill-common.sh defines shared usage tip array"
  else
    fail "wavemill-common.sh is missing shared usage tip array"
  fi

  if grep -q '^wavemill_pick_usage_tip()' "$REPO_DIR/shared/lib/wavemill-common.sh"; then
    pass "wavemill-common.sh defines usage tip picker"
  else
    fail "wavemill-common.sh is missing usage tip picker"
  fi

  if grep -q 'wavemill_pick_usage_tip' "$REPO_DIR/shared/lib/wavemill-status.sh"; then
    pass "dashboard footer uses shared usage tip picker"
  else
    fail "dashboard footer is missing shared usage tip picker call"
  fi

  if grep -q 'Ctrl+B N: next done' "$REPO_DIR/shared/lib/wavemill-common.sh"; then
    pass "usage tip source preserves next done discoverability"
  else
    fail "usage tip source is missing next done discoverability"
  fi
fi

# ============================================================================
# TEST 15: Verify sourced libraries exist
# ============================================================================
echo ""
echo "=== Sourced Library Verification ==="

# Check that all source statements in shell scripts reference existing files
for script in "$LIB_DIR"/wavemill-*.sh; do
  [[ -f "$script" ]] || continue
  while IFS= read -r line; do
    # Extract the sourced file path (handle both $SCRIPT_DIR and $LIB_DIR variables)
    sourced=$(echo "$line" | sed -E 's/^source "//;s/"$//' \
      | sed "s|\\\$SCRIPT_DIR|$LIB_DIR|g" \
      | sed "s|\\\$LIB_DIR|$LIB_DIR|g" \
      | sed "s|\\\${BASH_SOURCE\[0\]}|$script|g")
    # Skip variable-only paths we can't resolve statically
    if echo "$sourced" | grep -q '\$'; then
      continue
    fi
    if [[ -f "$sourced" ]]; then
      pass "$(basename "$script") sources $(basename "$sourced") (exists)"
    else
      fail "$(basename "$script") sources $sourced (NOT FOUND)"
    fi
  done < <(grep -E '^\s*source\s+"' "$script" 2>/dev/null || true)
done

# ============================================================================
# TEST 16: Optional ShellCheck
# ============================================================================
if command -v shellcheck >/dev/null 2>&1; then
  echo ""
  echo "=== ShellCheck (error severity) ==="
  for f in "$LIB_DIR"/wavemill-common.sh "$LIB_DIR"/agent-adapters.sh "$NEXT_DONE_SCRIPT"; do
    [[ -f "$f" ]] || continue
    if shellcheck --severity=error "$f" 2>/dev/null; then
      pass "shellcheck $(basename "$f")"
    else
      fail "shellcheck $(basename "$f")"
    fi
  done
fi

# ============================================================================
# TEST 16: Signal-driven hook refresh guards
# ============================================================================
echo ""
echo "=== Signal-Driven Hook Refresh Guards ==="

HOOK_PROTOCOL_LIB="$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"
if [[ ! -f "$HOOK_PROTOCOL_LIB" ]]; then
  fail "wavemill-hook-protocol.sh not found for signal refresh checks"
else
  if bash -lc '
    set -euo pipefail
    source "'"$HOOK_PROTOCOL_LIB"'"

    marker=$(mktemp "/tmp/wavemill-signal-marker.XXXXXX")
    rm -f "$marker"
    cleanup() {
      kill "$listener_pid" 2>/dev/null || true
      wait "$listener_pid" 2>/dev/null || true
      rm -f "$marker" "$hook_file"
    }

    (trap "touch \"$marker\"; exit 0" USR1; while :; do :; done) &
    listener_pid=$!
    sleep 0.05

    export WAVEMILL_SESSION="signal-valid-$$"
    export WAVEMILL_ISSUE="TEST-VALID"
    export WAVEMILL_DASHBOARD_PID="$listener_pid"
    hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"

    wavemill_hook_write "working" "PreToolUse" "Read" "claude"

    for _ in {1..20}; do
      [[ -f "$marker" ]] && break
      sleep 0.05
    done

    [[ -f "$marker" ]] || { cleanup; exit 1; }
    [[ -s "$hook_file" ]] || { cleanup; exit 1; }
    cleanup
  ' >/dev/null 2>&1; then
    pass "hook notify delivers USR1 for valid dashboard PID"
  else
    fail "hook notify did not deliver USR1 for valid dashboard PID"
  fi

  if bash -lc '
    set -euo pipefail
    source "'"$HOOK_PROTOCOL_LIB"'"

    export WAVEMILL_SESSION="signal-invalid-$$"
    for bad_pid in "" "notanumber" "0" "99999999"; do
      export WAVEMILL_ISSUE="TEST-${bad_pid:-empty}"
      export WAVEMILL_DASHBOARD_PID="$bad_pid"
      hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
      wavemill_hook_write "working" "UserPromptSubmit" "noop" "claude"
      [[ -s "$hook_file" ]] || exit 1
      rm -f "$hook_file"
    done
  ' >/dev/null 2>&1; then
    pass "hook write remains successful with invalid dashboard PID values"
  else
    fail "hook write failed for one or more invalid dashboard PID values"
  fi

  if bash -lc '
    set -euo pipefail
    WAVEMILL_REDRAW=0
    trap "WAVEMILL_REDRAW=1" USR1
    kill -USR1 $$
    for _ in {1..10}; do
      [[ "$WAVEMILL_REDRAW" -eq 1 ]] && exit 0
      sleep 0.02
    done
    exit 1
  ' >/dev/null 2>&1; then
    pass "dashboard USR1 trap flips redraw flag"
  else
    fail "dashboard USR1 trap did not flip redraw flag"
  fi
fi

# ============================================================================
# TEST 17: Dashboard refresh interval guards
# ============================================================================
echo ""
echo "=== Dashboard Refresh Guards ==="

STATUS_SCRIPT="$LIB_DIR/wavemill-status.sh"
if [[ ! -f "$STATUS_SCRIPT" ]]; then
  fail "wavemill-status.sh not found for dashboard refresh checks"
else
  if grep -q '^DEFAULT_REFRESH=2$' "$STATUS_SCRIPT"; then
    pass "dashboard default refresh is 2 seconds"
  else
    fail "dashboard default refresh is not 2 seconds"
  fi

  if grep -q '^MAX_REFRESH=10$' "$STATUS_SCRIPT"; then
    pass "dashboard refresh upper bound is 10 seconds"
  else
    fail "dashboard refresh upper bound is not 10 seconds"
  fi

  if grep -q 'WAVEMILL_DASHBOARD_REFRESH_SECONDS' "$STATUS_SCRIPT"; then
    pass "dashboard refresh interval is configurable via environment"
  else
    fail "dashboard refresh interval is missing env override support"
  fi

  if grep -q 'sleep "\$REFRESH" &' "$STATUS_SCRIPT" && grep -q 'wait "\$SLEEP_PID"' "$STATUS_SCRIPT"; then
    pass "dashboard loop keeps interruptible sleep/wait pattern"
  else
    fail "dashboard loop is missing interruptible sleep/wait pattern"
  fi

  if grep -q 'Refreshes every \${REFRESH}s' "$STATUS_SCRIPT"; then
    pass "dashboard footer reports resolved refresh interval"
  else
    fail "dashboard footer does not report resolved refresh interval"
  fi

  if grep -q '^REFRESH=10$' "$STATUS_SCRIPT"; then
    fail "stale 10 second dashboard refresh constant is still present"
  else
    pass "stale 10 second dashboard refresh constant removed"
  fi
fi

echo ""
echo "=== Dashboard Refresh Test ==="

dashboard_refresh_output="$(bash "$REPO_DIR/tests/dashboard-refresh.test.sh" 2>&1)" || dashboard_refresh_status=$?
dashboard_refresh_status="${dashboard_refresh_status:-0}"
if [[ "$dashboard_refresh_status" -eq 0 ]]; then
  pass "dashboard refresh integration test"
else
  fail "dashboard refresh integration test: $dashboard_refresh_output"
fi
unset dashboard_refresh_status

window_titles_output="$(bash "$REPO_DIR/tests/wavemill-window-titles.test.sh" 2>&1)" || window_titles_status=$?
window_titles_status="${window_titles_status:-0}"
if [[ "$window_titles_status" -eq 0 ]]; then
  pass "window title helper tests"
else
  fail "window title helper tests: $window_titles_output"
fi
unset window_titles_status

# ============================================================================
# TEST 6: Routing resilience regression guards
# ============================================================================
echo ""
echo "=== Routing Resilience Guards ==="

if grep -q 'WAVEMILL_ROUTING_DEBUG' "$MONITOR_FILE"; then
  pass "routing debug flag is wired into mill launch"
else
  fail "routing debug flag is missing from wavemill-mill.sh"
fi

if grep -q '\.routing-failure' "$MONITOR_FILE"; then
  pass "routing failure marker is persisted"
else
  fail "routing failure marker is missing"
fi

if grep -q 'selected-task.json' "$MONITOR_FILE" && grep -q 'Created minimal routing packet from selected-task.json' "$MONITOR_FILE"; then
  pass "routing can rebuild a packet from selected-task metadata"
else
  fail "routing packet fallback from selected-task.json is missing"
fi

if grep -q 'route-tasks.ts' "$MONITOR_FILE" && grep -q 'route-task.ts' "$MONITOR_FILE"; then
  pass "mill script uses batch routing with single-task fallback"
else
  fail "batch routing or single-task fallback is missing"
fi

if grep -q 'prepare_route_input_for_issue()' "$MONITOR_FILE" \
  && grep -q 'apply_route_json_for_issue()' "$MONITOR_FILE" \
  && grep -q 'batch_route_selected_tasks()' "$MONITOR_FILE"; then
  pass "interactive routing batch helpers are defined"
else
  fail "interactive routing batch helper definitions are missing"
fi

if grep -q -- '--mode heuristic' "$MONITOR_FILE"; then
  pass "routing retries fall back to heuristic mode"
else
  fail "heuristic routing fallback is missing"
fi

if grep -q 'Workflow routing attempt \$route_attempt failed' "$MONITOR_FILE"; then
  pass "routing attempts are logged with retry context"
else
  fail "routing retry logging is missing"
fi

if grep -q 'source \"\$script_dir/routing-emitter.sh\"' "$REPO_DIR/shared/lib/agent-adapters.sh" \
  && grep -q 'routing_emit_phase' "$REPO_DIR/shared/lib/agent-adapters.sh"; then
  pass "agent adapter wires routing emission helper"
else
  fail "agent adapter routing emission wiring is missing"
fi

if grep -q 'wavemill_hook_write_routing' "$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"; then
  pass "hook protocol exposes routing writer"
else
  fail "hook protocol routing writer is missing"
fi

if grep -q 'windowId' "$REPO_DIR/shared/lib/wavemill-startup-runner.sh" \
  && grep -q "display-message -p -t \"\\\$SESSION:\\\$win\" '#{window_id}'" "$REPO_DIR/shared/lib/wavemill-startup-runner.sh"; then
  pass "startup persists stable tmux windowId"
else
  fail "startup stable windowId persistence is missing"
fi

if grep -q 'wavemill_apply_window_metadata' "$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"; then
  pass "hook notify triggers best-effort metadata refresh"
else
  fail "hook metadata refresh wiring is missing"
fi

# ============================================================================
# TEST 13: Integration window lifecycle fixtures
# ============================================================================
echo ""
echo "=== Integration Window Lifecycle Fixtures ==="

for fixture in \
  "$REPO_DIR/tests/fixtures/lifecycle/integration_window_created.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/integration_window_observer_enabled.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/integration_window_clean_shutdown.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/integration_window_disabled.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/integration_window_recovers_missing_tend.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/integration_window_recovers_missing_observer.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/integration_window_idempotent_setup.sh" \
; do
  if [[ ! -f "$fixture" ]]; then
    fail "Missing lifecycle fixture $(basename "$fixture")"
    continue
  fi

  fixture_output="$(bash "$fixture" 2>&1)" || fixture_status=$?
  fixture_status="${fixture_status:-0}"

  if [[ "$fixture_output" == SKIP:* ]]; then
    skip "$(basename "$fixture"): ${fixture_output#SKIP: }"
  elif [[ "$fixture_status" -eq 0 ]]; then
    pass "$(basename "$fixture")"
  else
    fail "$(basename "$fixture"): $fixture_output"
  fi

  unset fixture_status
done

# ============================================================================
# TEST 14: Tend lifecycle fixtures
# ============================================================================
echo ""
echo "=== Tend Lifecycle Fixtures ==="

run_fixtures_parallel \
  "$REPO_DIR/tests/fixtures/lifecycle/tend_blocked_by_dependency.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/tend_holds_high_risk_without_approval.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/tend_halts_when_integration_red.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/tend_merges_one_at_a_time.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/tend_surfaces_rebase_conflict.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/tend_challenge_winner_merges_loser_cleanup.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/tend_status_line_not_repeated.sh"

# ============================================================================
# TEST 15: Startup lifecycle fixtures
# ============================================================================
echo ""
echo "=== Startup Lifecycle Fixtures ==="

run_fixtures_parallel \
  "$REPO_DIR/tests/fixtures/lifecycle/mill_dry_run_full_pipeline.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/startup_launches_concurrently.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/startup_serializes_state_writes.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/worktree_collision.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/worktree_overlay_propagation.sh"

# ============================================================================
# TEST 16: Monitor PR cache fixture
# ============================================================================
echo ""
echo "=== Monitor PR Cache Fixtures ==="

for fixture in \
  "$REPO_DIR/tests/fixtures/lifecycle/monitor_pr_cache_single_fetch.sh" \
  "$REPO_DIR/tests/fixtures/lifecycle/monitor_pr_cache_no_stderr_in_pane.sh" \
; do
  if [[ ! -f "$fixture" ]]; then
    fail "Missing PR cache fixture $(basename "$fixture")"
    continue
  fi

  fixture_output="$(bash "$fixture" 2>&1)" || fixture_status=$?
  fixture_status="${fixture_status:-0}"

  if [[ "$fixture_output" == SKIP:* ]]; then
    skip "$(basename "$fixture"): ${fixture_output#SKIP: }"
  elif [[ "$fixture_status" -eq 0 ]]; then
    pass "$(basename "$fixture")"
  else
    fail "$(basename "$fixture"): $fixture_output"
  fi

  unset fixture_status
done

# ============================================================================
# TEST 16: claude-deepseek agent adapter functions
# ============================================================================
echo ""
echo "=== claude-deepseek agent adapter functions ==="

if [[ -f "$LIB_DIR/agent-adapters.sh" ]]; then
  # Test agent_binary_for_cmd and agent_default_model_for_cmd in a subshell
  result="$(bash -c '
    source "'"$LIB_DIR/agent-adapters.sh"'" 2>/dev/null
    agent_binary_for_cmd "claude-deepseek"
  ' 2>/dev/null)" || true
  if [[ "$result" == "claude" ]]; then
    pass "agent_binary_for_cmd maps claude-deepseek to claude"
  else
    fail "agent_binary_for_cmd claude-deepseek" "expected claude, got $result"
  fi

  result="$(bash -c '
    source "'"$LIB_DIR/agent-adapters.sh"'" 2>/dev/null
    agent_default_model_for_cmd "claude-deepseek"
  ' 2>/dev/null)" || true
  if [[ "$result" == "deepseek-v4-flash" ]]; then
    pass "agent_default_model_for_cmd claude-deepseek returns deepseek-v4-flash"
  else
    fail "agent_default_model_for_cmd claude-deepseek" "expected deepseek-v4-flash, got $result"
  fi

  # Verify existing paths unchanged
  result="$(bash -c '
    source "'"$LIB_DIR/agent-adapters.sh"'" 2>/dev/null
    agent_binary_for_cmd "claude"
  ' 2>/dev/null)" || true
  if [[ "$result" == "claude" ]]; then
    pass "agent_binary_for_cmd preserves claude unchanged"
  else
    fail "agent_binary_for_cmd claude unchanged" "got $result"
  fi

  result="$(bash -c '
    source "'"$LIB_DIR/agent-adapters.sh"'" 2>/dev/null
    agent_resolve_from_model "deepseek-v4-pro" "coding"
  ' 2>/dev/null)" || true
  if [[ "$result" == "claude" ]]; then
    pass "agent_resolve_from_model deepseek-v4-pro still maps to claude (backward compat)"
  else
    fail "backward compat agent_resolve_from_model" "expected claude, got $result"
  fi

  if bash "$SCRIPT_DIR/agent-resolve-from-model.test.sh"; then
    pass "agent_resolve_from_model shell regression coverage"
  else
    fail "agent_resolve_from_model shell regression coverage"
  fi
else
  fail "agent-adapters.sh not found"
fi

# ============================================================================
# TEST 17: HOK-1565 – command draining independence guards
# ============================================================================
echo ""
echo "=== HOK-1565: Command Draining Independence Guards ==="

if [[ -n "$HEREDOC_CONTENT" ]]; then
  CHALLENGE_EVAL_FN=$(awk '
    /^maybe_run_challenge_eval\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' <<< "$HEREDOC_CONTENT")

  if grep -Fq 'launch_tracked_job "eval"' <<< "$CHALLENGE_EVAL_FN" \
    && grep -Fq 'pid=$!' <<< "$CHALLENGE_EVAL_FN"; then
    pass "maybe_run_challenge_eval launches long eval as background lifecycle job"
  else
    fail "maybe_run_challenge_eval may block the monitor loop (missing background job tracking)"
  fi

  CHALLENGE_COMPARE_FN=$(awk '
    /^maybe_run_challenge_comparison\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' <<< "$HEREDOC_CONTENT")

  if grep -Fq 'launch_tracked_job "comparison"' <<< "$CHALLENGE_COMPARE_FN" \
    && grep -Fq 'pid=$!' <<< "$CHALLENGE_COMPARE_FN"; then
    pass "maybe_run_challenge_comparison launches long comparison as background lifecycle job"
  else
    fail "maybe_run_challenge_comparison may block the monitor loop (missing background job tracking)"
  fi

  if grep -Fq 'MONITOR_PHASE_C_REPLY_OFFSET="${REPLY_OFFSET:-}"' <<< "$HEREDOC_CONTENT" \
    && grep -Fq 'acknowledge_command_offset "$MONITOR_PHASE_C_REPLY_OFFSET"' <<< "$HEREDOC_CONTENT"; then
    pass "phase-c command consumption acknowledges durable command offsets"
  else
    fail "phase-c command consumption may replay selected tasks"
  fi
else
  skip "HOK-1565 command draining guards (HEREDOC_CONTENT not available)"
fi

if grep -qE '^render_monitor_command_queue_section\(\) \{' "$STATUS_SCRIPT" 2>/dev/null; then
  pass "wavemill-status.sh renders queued monitor commands section"
else
  fail "wavemill-status.sh is missing render_monitor_command_queue_section"
fi

echo ""
echo "=== Advance Command ==="

advance_command_output="$(bash "$REPO_DIR/tests/wavemill-mill-advance.test.sh" 2>&1)" || advance_command_status=$?
advance_command_status="${advance_command_status:-0}"
if [[ "$advance_command_status" -eq 0 ]]; then
  pass "advance command lifecycle"
else
  fail "advance command lifecycle: $advance_command_output"
fi
unset advance_command_status

# ============================================================================
# HOK-2289: Pi vendor adapter seam guard
# Ensure Pi package imports are confined to messages.ts and provider.ts.
# ============================================================================
echo ""
echo "=== HOK-2289: Pi Vendor Adapter Seam Guard ==="

PI_ALLOWED_FILES=(
  "shared/lib/native-agent/compaction.test.ts"
  "shared/lib/native-agent/compaction.ts"
  "shared/lib/native-agent/loop.test.ts"
  "shared/lib/native-agent/loop.ts"
  "shared/lib/native-agent/messages.ts"
  "shared/lib/native-agent/provider.ts"
  "shared/lib/native-agent/tool-compat-fixtures.test.ts"
  "shared/lib/native-agent/transcript.ts"
  "shared/lib/native-agent/fixtures/blocked-session.ts"
  "shared/lib/native-agent/fixtures/malformed-tool-call-session.ts"
  "shared/lib/native-agent/fixtures/success-session.ts"
  "shared/lib/native-agent/tools/pi-adapter.ts"
  "shared/lib/native-agent/tools/registry.test.ts"
)

PI_PACKAGES=(
  "@earendil-works/pi-ai"
  "@earendil-works/pi-agent-core"
)

pi_seam_ok=true
for pkg in "${PI_PACKAGES[@]}"; do
  # Search all TS/JS files for static, dynamic, and CommonJS imports,
  # excluding allowed seam files, spike/, and node_modules/.
  leaks=$(grep -rnE --include="*.ts" --include="*.js" \
    -e "from[[:space:]]+['\"]${pkg}(['\"/]|$)" \
    -e "import[[:space:]]*\\([[:space:]]*['\"]${pkg}(['\"/]|$)" \
    -e "require[[:space:]]*\\([[:space:]]*['\"]${pkg}(['\"/]|$)" \
    --exclude-dir=node_modules \
    --exclude-dir=spike \
    "$REPO_DIR" 2>/dev/null \
    | grep -v "spike/" \
    | grep -v "/spike/" \
    || true)
  for allowed_file in "${PI_ALLOWED_FILES[@]}"; do
    leaks=$(printf '%s\n' "$leaks" | grep -vF "$allowed_file" || true)
  done
  if [[ -n "$leaks" ]]; then
    pi_seam_ok=false
    fail "Pi vendor import '${pkg}' found outside seam:"$'\n'"${leaks}"
  fi
done

if [[ "$pi_seam_ok" == "true" ]]; then
  pass "Pi vendor imports confined to native-agent adapter/transcript seam"
fi

# ============================================================================
# RESULTS
# ============================================================================
echo ""
if [[ $SKIP -gt 0 ]]; then
  echo "--- Results: $PASS passed, $FAIL failed, $SKIP skipped ---"
else
  echo "--- Results: $PASS passed, $FAIL failed ---"
fi

if (( FAIL > 0 )); then
  exit 1
fi
