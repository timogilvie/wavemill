#!/usr/bin/env bash
# Golden journey: a coding agent idles on its own background job and is not
# declared dead; the operator then aborts it mid-coding and the mill tears
# the task down without leaving anything behind (HOK-3228).
#
# Protects against two incident classes on one task:
#   - HOK-3137: the monitor stamped a Claude coder "interrupted" (owner lost)
#     while the REPL sat idle waiting on its own run_in_background task. The
#     owner-lost check must see the pane's live background child.
#   - HOK-3210: a task reaped by an operator abort had its tmux window
#     recreated as an empty shell on every monitor pass (and HOK-3125's
#     shape: a reaped task re-materialising as a stub row that holds a slot).
#
# Time: the owner-lost check only considers an agent idle for 30+ minutes
# (wall clock, not the tick clock), so the journey backdates the coding launch
# — the one fault it injects — and proves the oracle is live with a control
# probe: the same progress primitive, on the same pane, with background-work
# detection effectively off, must report the task stalled.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP operator-abort-mid-coding journey: $reason"
  exit 0
fi

ISSUE="JRN-6"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/operator-abort/fake-agent" && pwd)"
# The background child starts seconds after the agent here, not minutes into a
# session; drop the startup-service lag filter so it counts (HOK-3137).
export WAVEMILL_BG_CHILD_LAG_SECONDS=0
journey_init operator-abort-mid-coding
fakes_linear_add_issue "$ISSUE" "Task the operator aborts mid-coding" Todo
# A quiet repo: the integration tip the task branches from was last changed
# two hours ago, so the task branch's HEAD commit predates the (backdated)
# coding launch and is not progress.
quiet_since="$(date -u -r "$(( $(date +%s) - 7200 ))" +%FT%TZ 2>/dev/null || date -u -d @"$(( $(date +%s) - 7200 ))" +%FT%TZ)"
GIT_AUTHOR_DATE="$quiet_since" GIT_COMMITTER_DATE="$quiet_since" \
  fakes_repo_commit "$JOURNEY_INTEGRATION_BRANCH" CHANGELOG.md "quiet since $quiet_since" "last integration change"

journey_start_monitor
journey_wait_until "$ISSUE" 5 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
agent_idle_on_bg_job() { grep -q "phase=coding issue=$ISSUE role=idle-on-background-job" "$FAKE_AGENT_LOG" 2>/dev/null; }
ticks_reached() { (( $(journey_tick) >= $1 )); }
bg_pid() { cat "$FAKE_ROOT/bg-pid-$ISSUE" 2>/dev/null; }
coding_status() { jq -r '.status // empty' "$FEATURE_DIR/.coding-result.json" 2>/dev/null || true; }
task_gone() {
  [[ "$(jq -r --arg id "$ISSUE" '.tasks | has($id)' "$STATE_FILE" 2>/dev/null)" == "false" ]] \
    && [[ ! -d "$WT_DIR" ]] \
    && [[ "$(jq -r '.freeSlots // empty' "$STATE_FILE" 2>/dev/null)" == "1" ]]
}

# The tmux pane hosting the agent: walk up from the background child to the
# first ancestor that is a pane root.
agent_pane_pid() {
  local pid panes
  pid="$(bg_pid)"
  panes=" $(tmux list-panes -a -F '#{pane_pid}' 2>/dev/null | tr '\n' ' ') "
  while [[ -n "$pid" && "$pid" != "1" && "$pid" != "0" ]]; do
    [[ "$panes" == *" $pid "* ]] && { printf '%s\n' "$pid"; return 0; }
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

# The progress primitive exactly as coding_stage_owner_lost runs it (minus the
# cache), plus any env override for the control probe.
progress_probe() {
  (cd "$JOURNEY_INSTALL_DIR" && env "$@" node --import tsx tools/task-progress.ts \
    --issue "$ISSUE" --session "$SESSION" --state-file "$STATE_FILE" --phase coding --pane-pid "$PANE_PID")
}

# Fault: "the coder was launched 45 minutes ago". Backdates the launch anchor
# (coding startedAt, which also clears the 300s owner-lost grace) and every
# other progress source the agent produced (the base commit is already two
# hours old), so the only thing standing between
# the task and an owner-lost stamp is the background-work probe.
age_coding_launch() {
  local past_iso past_touch
  past_iso="$(date -u -r "$(( $(date +%s) - 2700 ))" +%FT%TZ 2>/dev/null || date -u -d @"$(( $(date +%s) - 2700 ))" +%FT%TZ)"
  past_touch="$(date -r "$(( $(date +%s) - 2700 ))" +%Y%m%d%H%M.%S 2>/dev/null || date -d @"$(( $(date +%s) - 2700 ))" +%Y%m%d%H%M.%S)"
  jq --arg t "$past_iso" '.startedAt = $t | if has("updated") then .updated = $t else . end' \
    "$FEATURE_DIR/.coding-result.json" > "$FEATURE_DIR/.coding-result.json.tmp" \
    && mv "$FEATURE_DIR/.coding-result.json.tmp" "$FEATURE_DIR/.coding-result.json"
  bash -c 'source "$1/shared/lib/wavemill-common.sh"; state_mutate "$STATE_FILE" ".tasks[\$i].updated = \$t" --arg i "$2" --arg t "$3"' \
    _ "$JOURNEY_INSTALL_DIR" "$ISSUE" "$past_iso"
  [[ -f "/tmp/$SESSION-$ISSUE-status.txt" ]] && touch -t "$past_touch" "/tmp/$SESSION-$ISSUE-status.txt"
  # Progress derived before the fault is stale derived data, not evidence.
  rm -f "/tmp/wavemill-$SESSION-$ISSUE.progress.json"
  journey_log "fault: coding launch backdated to $past_iso"
}

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"               phase_is planning
journey_wait_until "$ISSUE" 10 "coding launched"                           phase_is coding
journey_wait_until "$ISSUE" 5  "coder idle on its own background job"      agent_idle_on_bg_job

FEATURE_DIR="$(journey_feature_dir "$ISSUE")"
WT_DIR="$(journey_task_field "$ISSUE" worktree)"
[[ -n "$WT_DIR" ]] || WT_DIR="$WORKTREE_ROOT/$(journey_task_field "$ISSUE" slug)"
PANE_PID="$(agent_pane_pid)" || journey_fail "no tmux pane hosts the coder's background job (pid $(bg_pid))"
age_coding_launch

# Oracle liveness: without the background-work signal this task IS owner-lost.
control="$(progress_probe WAVEMILL_BG_CHILD_LAG_SECONDS=999999)"
jq -e '.agentIdle == true and .stalled == true' <<<"$control" >/dev/null \
  || journey_fail "control probe: task not idle+stalled without background work, the oracle would be vacuous: $(jq -c '{agentIdle,stalled,progressAgeMinutes,sources:[.sources[]? | {kind,at,detail}]}' <<<"$control")"
journey_log "control probe: idle+stalled without background work (age $(jq -r .progressAgeMinutes <<<"$control")m)"

# HOK-3137: several monitor passes run the owner-lost check on this task.
watch_from="$(journey_tick)"
journey_wait_until "$ISSUE" 6 "3 monitor passes with the agent idle on its job" ticks_reached $(( watch_from + 3 ))
probe="$(progress_probe)"
control_after="$(progress_probe WAVEMILL_BG_CHILD_LAG_SECONDS=999999)"
STATUS_AFTER_WATCH="$(coding_status)"
WINDOWS_BEFORE_ABORT="$(tmux list-windows -a -F '#{session_name}:#{window_name}' 2>/dev/null | sort)"

# The operator aborts the task, as `wavemill abort` does.
(cd "$JOURNEY_INSTALL_DIR" && node --import tsx tools/abort-task.ts "$ISSUE" \
  --repo-dir "$REPO_DIR" --reason "operator stop (journey)") >> "$JOURNEY_TMP/logs/abort.log" 2>&1 \
  || journey_fail "abort-task.ts failed: $(tail -3 "$JOURNEY_TMP/logs/abort.log")"
journey_log "operator aborted $ISSUE"

journey_wait_until "$ISSUE" 8 "task torn down (row, worktree, slot)" task_gone
reaped_at="$(journey_tick)"
WINDOWS_AFTER_REAP="$(tmux list-windows -a -F '#{session_name}:#{window_name}' 2>/dev/null | sort)"
# HOK-3210 / HOK-3125: nothing comes back on later passes.
journey_wait_until "$ISSUE" 6 "3 monitor passes after the teardown"        ticks_reached $(( reaped_at + 3 ))
WINDOWS_LATER="$(tmux list-windows -a -F '#{session_name}:#{window_name}' 2>/dev/null | sort)"

echo ""
echo "assertions:"
journey_assert "the agent's own Stop hook reads idle (the REPL idles on its job)" \
  journey_jq_true '.agentIdle == true' <<<"$probe"
journey_assert "the pane's background child is live background work" \
  journey_jq_true '.agentBackgroundLive == true and (.backgroundProcesses | length) >= 1' <<<"$probe"
journey_assert "and so the idle agent is not stalled" journey_jq_true '.stalled == false' <<<"$probe"
journey_assert "the oracle stayed live: without background work the task was still stalled after the watch" \
  journey_jq_true '.agentIdle == true and .stalled == true' <<<"$control_after"
journey_assert "coding stayed running through the watched passes (never stamped)" \
  test "$STATUS_AFTER_WATCH" = "running"
journey_assert "no owner-lost interrupted stamp in the mill log" \
  test "$(journey_mill_log_count "coding agent exited without recording a result")" = "0"
journey_assert "the agent CLI got exactly one coding launch (no owner-lost relaunch)" \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = "1"
journey_assert "the task row stayed gone for 3 passes (no stub recreated)" \
  journey_jq_true --arg id "$ISSUE" '(.tasks | has($id) | not) and .freeSlots == 1' "$STATE_FILE"
journey_assert "the task's window closed on teardown" \
  test "$(comm -13 <(echo "$WINDOWS_AFTER_REAP") <(echo "$WINDOWS_BEFORE_ABORT") | grep -c .)" -ge 1
journey_assert "no window was recreated on later passes" test "$WINDOWS_LATER" = "$WINDOWS_AFTER_REAP"
journey_assert "no window-recreate retries were spent" \
  test "$(journey_mill_log_count "Window.*recreating\|window recreated")" = "0"
journey_assert "the agent's background job was torn down with its pane" \
  bash -c '! kill -0 "$1" 2>/dev/null' _ "$(bg_pid)"
journey_assert "no PR was opened" test "$(jq '.prs | length' "$FAKE_GH_STATE")" = "0"
journey_assert "Linear issue left Done/In Progress untouched by a merge (not Done)" \
  test "$(fakes_linear_state_of "$ISSUE")" != "Done"
journey_assert "no .needs-attention at any tick" test "$JOURNEY_SAW_ATTENTION" = "0"
journey_assert_no_unhandled_fake_calls

journey_finish
