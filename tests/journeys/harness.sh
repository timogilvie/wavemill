#!/usr/bin/env bash
# Golden-journey harness (HOK-3227).
#
# Runs the REAL mill: the unmodified wavemill-monitor.sh main loop (no
# WAVEMILL_MONITOR_SOURCE_ONLY, no function extraction, no stubbed
# persistence) plus real `tools/tend.ts --once` ticks, against a temp repo and
# the shared fakes in tests/fakes/ (gh, Linear, tmux, agent). A journey then
# asserts the end state the way an operator would see it: PR merged on the
# fake GitHub, Linear issue Done, task reaped from workflow-state, worktree
# gone.
#
# The harness plays only the roles a human or a backstage service plays in
# production:
#   - selects the task from the backlog (`select 1` on the command file),
#   - approves the plan whenever the mill requests approval (touch
#     .plan-approved), recording each request episode and failing the journey
#     once a configured approval budget is spent (journey_set_approval_budget),
#   - runs one tend tick whenever the mill has published a Ready handoff.
# Everything else is the mill's own behaviour.
#
# Time is a tick counter, not the wall clock: the monitor runs with
# POLL_SECONDS=0 and the tick clock seam (shared/lib/mill-clock.sh / .ts) on,
# so deadlines, retry backoff and tend's retry sleeps advance per monitor pass.
# Waits are bounded in monitor ticks; JOURNEY_BUDGET_SECONDS (CI: 120) is the
# wall-clock ceiling for the whole journey.
#
# On failure it prints a compact trace (tick-by-tick phase/marker/label table,
# unhandled fake calls, last 30 monitor log lines) instead of a log flood.

set -euo pipefail

JOURNEY_HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOURNEY_INSTALL_DIR="$(cd "$JOURNEY_HARNESS_DIR/../.." && pwd)"
# shellcheck source=../fakes/lib.sh
source "$JOURNEY_INSTALL_DIR/tests/fakes/lib.sh"

JOURNEY_MAX_PARALLEL=1
JOURNEY_NAME=""
JOURNEY_TMP=""
JOURNEY_MONITOR_PID=""
JOURNEY_STARTED_AT=0
JOURNEY_INTEGRATION_BRANCH="auto/integration"
JOURNEY_TIMELINE=""
JOURNEY_TEND_TICKS=0
# Tick-by-tick table (one row per observed change) and what it has seen.
JOURNEY_TABLE=""
JOURNEY_LAST_ROW=""
JOURNEY_SAW_ATTENTION=0
# Whether the task may raise .needs-attention: 0 = never (default), 1 = it
# must, any = tolerated (a known race the journey is not about).
JOURNEY_EXPECT_ATTENTION=0
# Wall-clock ceiling for the whole journey (0 = none). CI sets 90.
JOURNEY_BUDGET_SECONDS="${JOURNEY_BUDGET_SECONDS:-0}"
# Optional function name a journey sets to inject faults right before the
# first tend tick (e.g. move the integration branch, add gh read lag).
JOURNEY_BEFORE_FIRST_TEND=""
# Plan approvals the operator will give (-1 = unbounded). Every approval
# request (planning awaiting_user without .plan-approved) is one episode in
# $JOURNEY_TMP/approval-episodes.jsonl; a request beyond the budget fails the
# journey instead of being silently approved (HOK-3253).
JOURNEY_APPROVAL_BUDGET=-1
JOURNEY_APPROVALS=0
# Optional function name a journey sets to act right after each approval
# (e.g. change the task packet to prove the HOK-3099 guard still fires).
JOURNEY_AFTER_APPROVAL=""
# Snapshot of the feature dir taken the first time the task is in coding.
JOURNEY_CODING_SNAPSHOT=""

journey_now() { date +%s; }

journey_log() {
  printf '[journey %s +%ss] %s\n' "$JOURNEY_NAME" "$(( $(journey_now) - JOURNEY_STARTED_AT ))" "$*"
}

# Requirements the harness cannot fake: bash >= 4 (the monitor uses
# associative arrays), tmux, jq, git >= 2.38 (merge-tree --write-tree).
journey_skip_reason() {
  if (( BASH_VERSINFO[0] < 4 )); then echo "bash >= 4 required (have $BASH_VERSION)"; return; fi
  command -v jq >/dev/null 2>&1 || { echo "jq not installed"; return; }
  command -v tmux >/dev/null 2>&1 || { echo "tmux not installed"; return; }
  git merge-tree --write-tree HEAD HEAD >/dev/null 2>&1 \
    || git -C "$JOURNEY_INSTALL_DIR" merge-tree --write-tree HEAD HEAD >/dev/null 2>&1 \
    || { echo "git >= 2.38 required for merge-tree --write-tree"; return; }
  echo ""
}

journey_init() {
  JOURNEY_NAME="$1"
  JOURNEY_STARTED_AT="$(journey_now)"
  JOURNEY_TMP="$(mktemp -d "${TMPDIR:-/tmp}/journey-${JOURNEY_NAME}.XXXXXX")"
  JOURNEY_TMP="$(cd "$JOURNEY_TMP" && pwd -P)"
  trap 'journey_cleanup' EXIT

  fakes_setup "$JOURNEY_TMP/world" "acme/journey" main
  fakes_origin_branch "$JOURNEY_INTEGRATION_BRANCH" main

  export SESSION="wmj${$}${RANDOM}"
  export WAVEMILL_SESSION="$SESSION"
  export REPO_DIR="$FAKE_REPO_DIR"
  export STATE_DIR="$REPO_DIR/.wavemill"
  export STATE_FILE="$STATE_DIR/workflow-state.json"
  export WORKTREE_ROOT="$JOURNEY_TMP/worktrees"
  mkdir -p "$STATE_DIR" "$WORKTREE_ROOT" "$JOURNEY_TMP/logs"

  # Capabilities are pinned rather than derived: tend is the merge executor
  # (so the mill publishes Ready handoffs), observer and merge queue are off.
  export WAVEMILL_SESSION_CAPABILITIES_JSON='{"tend":true,"observer":false,"mergeExecutor":"tend","mergeQueue":false}'
  # Run every tool through the same node path production uses, but keep the
  # fakes' NODE_OPTIONS preload (exported by fakes_setup).
  export WAVEMILL_DISABLE_CHALLENGE=1
  export WAVEMILL_UNATTENDED_CLEANUP_ENABLED=0
  export WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD=1
  export WAVEMILL_SKIP_CANARY_AUTO_REFRESH=1
  export WAVEMILL_GH_CALL_COUNTING=0
  export FAKE_AGENT_BASE_BRANCH="$JOURNEY_INTEGRATION_BRANCH"
  # Tick clock seam: the monitor advances this counter once per pass and
  # bounded-retry backoff, condition deadlines and tend's sleeps read it.
  export WAVEMILL_TICK_CLOCK_FILE="$JOURNEY_TMP/tick-clock"
  export WAVEMILL_TICK_CLOCK_EPOCH="$JOURNEY_STARTED_AT"
  export WAVEMILL_TICK_CLOCK_SECONDS=60

  journey_write_config '{}'
  journey_write_monitor_env

  # The tmux server inherits this environment (PATH with the fakes, NODE_OPTIONS,
  # FAKE_*), exactly as the real mill's panes inherit the operator's shell.
  tmux new-session -d -s "$SESSION" -n mill -c "$REPO_DIR" "sleep 86400"
}

# Write the milled repo's committed config; $1 is a jq object merged on top.
journey_write_config() {
  local overlay="${1:-}"
  [[ -n "$overlay" ]] || overlay='{}'
  jq -n --arg ib "$JOURNEY_INTEGRATION_BRANCH" --argjson overlay "$overlay" '
    {
      integration: {enabled: true, integrationBranch: $ib, mergeMethod: "squash", readyPolicy: {enabled: true}},
      router: {enabled: false},
      observer: {enabled: false},
      challenge: {enabled: false},
      ready: {watchdog: {enabled: false}},
      monitor: {readyWatchdog: {enabled: false}}
    } * $overlay' > "$REPO_DIR/.wavemill-config.json"
  (
    cd "$REPO_DIR"
    git checkout -q "$JOURNEY_INTEGRATION_BRANCH" 2>/dev/null || git checkout -q -b "$JOURNEY_INTEGRATION_BRANCH" "origin/$JOURNEY_INTEGRATION_BRANCH"
    git add .wavemill-config.json
    git commit -q -m "journey config" || true
    git push -q origin "$JOURNEY_INTEGRATION_BRANCH"
    git checkout -q main
    git merge -q --ff-only "origin/$JOURNEY_INTEGRATION_BRANCH" 2>/dev/null || true
    git push -q origin main 2>/dev/null || true
  )
}

journey_write_monitor_env() {
  export MONITOR_ENV="$JOURNEY_TMP/monitor.env"
  export MONITOR_SCRIPT="$JOURNEY_INSTALL_DIR/shared/lib/wavemill-monitor.sh"
  : > "$JOURNEY_TMP/tasks.txt"
  {
    printf 'SESSION=%q\n' "$SESSION"
    printf 'WAVEMILL_RUN_EPOCH=%q\n' "$(journey_now)"
    printf 'REPO_DIR=%q\n' "$REPO_DIR"
    printf 'WORKTREE_ROOT=%q\n' "$WORKTREE_ROOT"
    printf 'TOOLS_DIR=%q\n' "$JOURNEY_INSTALL_DIR/tools"
    printf 'LIB_DIR=%q\n' "$JOURNEY_INSTALL_DIR/shared/lib"
    printf 'WAVEMILL_LIB_DIR=%q\n' "$JOURNEY_INSTALL_DIR/shared/lib"
    printf 'WAVEMILL_INSTALL_DIR=%q\n' "$JOURNEY_INSTALL_DIR"
    printf 'STATE_DIR=%q\n' "$STATE_DIR"
    printf 'STATE_FILE=%q\n' "$STATE_FILE"
    printf 'WAVEMILL_STATE_FILE=%q\n' "$STATE_FILE"
    printf 'MERGE_QUEUE_SELECTION_FILE=%q\n' "$STATE_DIR/merge-queue-selection.json"
    printf 'POLL_SECONDS=0\n'
    printf 'REQUIRE_CONFIRM=false\n'
    printf 'DRY_RUN=false\n'
    printf 'BASE_BRANCH=%q\n' "$JOURNEY_INTEGRATION_BRANCH"
    printf 'PROJECT_NAME=\n'
    printf 'PLANNING_MODE=interactive\n'
    printf 'AGENT_CMD=claude\n'
    printf 'AGENT_CMD_EXPLICIT=true\n'
    printf 'ROUTER_ENABLED=false\n'
    printf 'MAX_PARALLEL=%s\n' "$JOURNEY_MAX_PARALLEL"
    printf 'AUTO_EVAL=false\n'
    printf 'ENTER_ACTION=none\n'
    printf 'ENTER_LAUNCHES_WAVE=false\n'
    printf 'DASHBOARD_VERBOSITY=normal\n'
    printf 'DASHBOARD_LOG_TO_FILE=false\n'
    printf 'WAVEMILL_DASHBOARD_PID=\n'
    printf 'WAVEMILL_MONITOR_PID=\n'
    printf 'MILL_LOG_FILE=%q\n' "$JOURNEY_TMP/logs/mill.log"
    printf 'STATUS_LOG_FILE=%q\n' "$JOURNEY_TMP/logs/status.log"
    printf 'TASKS_FILE=%q\n' "$JOURNEY_TMP/tasks.txt"
    printf 'CHALLENGE_AUTO_MERGE=false\n'
    printf 'WAVEMILL_WINDOW_MILL=mill\n'
    printf 'WAVEMILL_WINDOW_BACKSTAGE=backstage\n'
    printf 'WAVEMILL_BACKSTAGE_TEND_PANE_TITLE=tend\n'
    printf 'WAVEMILL_BACKSTAGE_JOBS_PANE_TITLE=jobs\n'
    printf 'WAVEMILL_BACKSTAGE_QUEUE_PANE_TITLE=queue\n'
    printf 'WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE=observer\n'
    printf 'MONITOR_SCRIPT=%q\n' "$MONITOR_SCRIPT"
    printf 'MONITOR_ENV=%q\n' "$MONITOR_ENV"
  } > "$MONITOR_ENV"
}

journey_command() {
  printf '%s\n' "$1" >> "/tmp/wavemill-${SESSION}-commands"
}

journey_start_monitor() {
  # Own process group (job control on for this one launch) so cleanup can
  # take down the monitor and every async job it spawned in one signal.
  set -m
  bash "$MONITOR_SCRIPT" "$MONITOR_ENV" </dev/null > "$JOURNEY_TMP/logs/monitor.out" 2>&1 &
  JOURNEY_MONITOR_PID=$!
  set +m
  journey_log "monitor started (pid $JOURNEY_MONITOR_PID)"
}

# ── observation helpers ────────────────────────────────────────────────────

# True once the mill prompt is offering <issue> from the backlog.
journey_backlog_offers() {
  grep -q "[0-9]\. $1 - " "$JOURNEY_TMP/logs/monitor.out" 2>/dev/null
}

# Monitor passes completed so far (the tick clock).
journey_tick() {
  local tick=0 _epoch
  [[ -f "$WAVEMILL_TICK_CLOCK_FILE" ]] && read -r tick _epoch < "$WAVEMILL_TICK_CLOCK_FILE" 2>/dev/null
  [[ "$tick" =~ ^[0-9]+$ ]] || tick=0
  printf '%s\n' "$tick"
}

journey_elapsed() { printf '%s\n' "$(( $(journey_now) - JOURNEY_STARTED_AT ))"; }

journey_task_field() {
  local issue="$1" field="$2"
  jq -r --arg id "$issue" --arg f "$field" '.tasks[$id][$f] // empty | tostring' "$STATE_FILE" 2>/dev/null || true
}

journey_feature_dir() {
  local issue="$1" slug wt
  slug="$(journey_task_field "$issue" slug)"
  wt="$(journey_task_field "$issue" worktree)"
  [[ -n "$slug" ]] || return 1
  printf '%s/features/%s\n' "${wt:-$WORKTREE_ROOT/$slug}" "$slug"
}

# Compact marker flags for the trace table: plan.md, .plan-approved,
# .coding-complete, review/ready result status, tend handoff state and
# '!' when .needs-attention is present.
journey_markers() {
  local issue="$1" fd flags="" v
  fd="$(journey_feature_dir "$issue" 2>/dev/null)" || { printf -- '-\n'; return 0; }
  [[ -f "$fd/plan.md" ]] && flags+="plan "
  [[ -f "$fd/.plan-approved" ]] && flags+="approved "
  [[ -f "$fd/.coding-complete" ]] && flags+="coded "
  v="$(jq -r '.status // empty' "$fd/.review-result.json" 2>/dev/null || true)"
  [[ -n "$v" ]] && flags+="review:$v "
  v="$(jq -r '.status // empty' "$fd/.ready-result.json" 2>/dev/null || true)"
  [[ -n "$v" ]] && flags+="ready:$v "
  v="$(jq -r '.state // empty' "$fd/.ready-tend-handoff.json" 2>/dev/null || true)"
  [[ -n "$v" ]] && flags+="handoff:$v "
  [[ -f "$fd/.needs-attention" ]] && flags+="! "
  flags="${flags% }"
  printf '%s\n' "${flags:--}"
}

journey_pr_summary() {
  jq -r '.prs["1"] // empty | "\(.state) [\((.labels // []) | join(","))]"' "$FAKE_GH_STATE" 2>/dev/null || true
}

# Append a table row whenever phase/status, markers or the PR changed.
journey_record_timeline() {
  local issue="$1" phase status line markers pr row
  phase="$(journey_task_field "$issue" phase)"
  status="$(journey_task_field "$issue" status)"
  line="${phase:-<none>}/${status:-<none>}"
  if [[ "$JOURNEY_TIMELINE" != *"$line" ]]; then
    JOURNEY_TIMELINE+="${JOURNEY_TIMELINE:+ → }$line"
    journey_log "task $issue: $line (tick $(journey_tick))"
  fi
  markers="$(journey_markers "$issue")"
  [[ "$markers" == *"!"* ]] && JOURNEY_SAW_ATTENTION=1
  pr="$(journey_pr_summary)"
  row="$(printf '%-22s %-48s %s' "$line" "$markers" "${pr:--}")"
  if [[ "$row" != "$JOURNEY_LAST_ROW" ]]; then
    JOURNEY_LAST_ROW="$row"
    JOURNEY_TABLE+="$(printf '%5s %5ss  %s' "$(journey_tick)" "$(journey_elapsed)" "$row")"$'\n'
  fi
}

# ── approval episodes (HOK-3253) ───────────────────────────────────────────

journey_set_approval_budget() { JOURNEY_APPROVAL_BUDGET="$1"; }

# Hash of the task packet files in the order the binding hashes them
# (header, details, single). Computed here, not by the mill's helper, so the
# oracle does not share the code under test. Empty when there is no packet.
journey_packet_hash() {
  local fd="$1" f
  local -a files=()
  [[ -f "$fd/task-packet-header.md" && -f "$fd/task-packet-details.md" ]] \
    && files+=("$fd/task-packet-header.md" "$fd/task-packet-details.md")
  [[ -f "$fd/task-packet.md" ]] && files+=("$fd/task-packet.md")
  (( ${#files[@]} > 0 )) || { printf '\n'; return 0; }
  for f in "${files[@]}"; do cat "$f"; done | shasum -a 256 | awk '{print $1}'
}

# The feature dir as the operator sees it at this instant, as one JSON line.
journey_feature_snapshot() {
  local issue="$1" fd="$2"
  local stale_count
  stale_count="$(find "$fd" -maxdepth 1 -name 'plan.stale-*.md' 2>/dev/null | wc -l | tr -d ' ')"
  jq -cn \
    --arg issue "$issue" \
    --argjson tick "$(journey_tick)" \
    --arg packetHash "$(journey_packet_hash "$fd")" \
    --arg planHash "$( [[ -f "$fd/plan.md" ]] && shasum -a 256 < "$fd/plan.md" | awk '{print $1}')" \
    --argjson binding "$(jq -c . "$fd/.plan-packet-hash" 2>/dev/null || echo null)" \
    --argjson planning "$(jq -c '{status, notes}' "$fd/.planning-result.json" 2>/dev/null || echo null)" \
    --argjson stalePlans "${stale_count:-0}" \
    '{issue: $issue, tick: $tick, packetHash: $packetHash, planHash: $planHash,
      binding: $binding, planning: $planning, stalePlans: $stalePlans}'
}

journey_record_approval_request() {
  local issue="$1" fd="$2"
  journey_feature_snapshot "$issue" "$fd" \
    | jq -c --argjson n "$((JOURNEY_APPROVALS + 1))" '{episode: $n} + .' >> "$JOURNEY_TMP/approval-episodes.jsonl"
}

# Approval requests observed so far.
journey_approval_count() {
  [[ -f "$JOURNEY_TMP/approval-episodes.jsonl" ]] || { echo 0; return 0; }
  grep -c . "$JOURNEY_TMP/approval-episodes.jsonl"
}

# jq -e over the approval episodes, slurped into an array.
journey_episodes_jq() {
  jq -e -s "$1" "$JOURNEY_TMP/approval-episodes.jsonl" >/dev/null 2>&1
}

# Phase launches the agent CLI actually received (independent of mill logs).
journey_agent_launch_count() {
  local issue="$1" phase="$2"
  grep -c "phase=$phase issue=$issue wt=" "$FAKE_AGENT_LOG" 2>/dev/null || true
}

# Operator/backstage roles, run on every poll.
journey_operator_tick() {
  local issue="$1" fd
  fd="$(journey_feature_dir "$issue" 2>/dev/null)" || return 0
  if [[ -f "$fd/plan.md" && ! -f "$fd/.plan-approved" ]] \
     && [[ "$(jq -r '.status // empty' "$fd/.planning-result.json" 2>/dev/null)" == "awaiting_user" ]]; then
    journey_record_approval_request "$issue" "$fd"
    if (( JOURNEY_APPROVAL_BUDGET >= 0 && JOURNEY_APPROVALS >= JOURNEY_APPROVAL_BUDGET )); then
      journey_fail "approval budget exceeded: approval request #$((JOURNEY_APPROVALS + 1)) (budget $JOURNEY_APPROVAL_BUDGET; note: $(jq -r '.notes // ""' "$fd/.planning-result.json" 2>/dev/null))"
    fi
    touch "$fd/.plan-approved"
    JOURNEY_APPROVALS=$((JOURNEY_APPROVALS + 1))
    journey_log "operator approved plan (approval #$JOURNEY_APPROVALS)"
    [[ -z "$JOURNEY_AFTER_APPROVAL" ]] || "$JOURNEY_AFTER_APPROVAL" "$fd" "$JOURNEY_APPROVALS"
  fi
  if [[ -z "$JOURNEY_CODING_SNAPSHOT" && "$(journey_task_field "$issue" phase)" == "coding" ]]; then
    JOURNEY_CODING_SNAPSHOT="$(journey_feature_snapshot "$issue" "$fd")"
  fi
  if [[ "$(jq -r '.state // empty' "$fd/.ready-tend-handoff.json" 2>/dev/null)" == "ready-published" ]]; then
    journey_tend_tick
  fi
}

journey_tend_tick() {
  if (( JOURNEY_TEND_TICKS == 0 )) && [[ -n "$JOURNEY_BEFORE_FIRST_TEND" ]]; then
    "$JOURNEY_BEFORE_FIRST_TEND"
  fi
  JOURNEY_TEND_TICKS=$((JOURNEY_TEND_TICKS + 1))
  (cd "$JOURNEY_INSTALL_DIR" && node --import tsx tools/tend.ts --once --repo-dir "$REPO_DIR") \
    >> "$JOURNEY_TMP/logs/tend.log" 2>&1 || true
  journey_log "tend tick #$JOURNEY_TEND_TICKS: $(grep -o 'action=[^ ]*' "$JOURNEY_TMP/logs/tend.log" | tail -1)"
}

# journey_wait_until <issue> <max-ticks> <description> <predicate...>
# Bounded in monitor passes (ticks), plus the journey's wall-clock budget and
# a hard safety cap so a monitor stuck inside one pass cannot hang CI.
journey_wait_until() {
  local issue="$1" max_ticks="$2" description="$3"; shift 3
  local tick_deadline=$(( $(journey_tick) + max_ticks ))
  local safety_deadline=$(( $(journey_now) + ${JOURNEY_WAIT_SAFETY_SECONDS:-300} ))
  while (( $(journey_tick) <= tick_deadline )); do
    if ! kill -0 "$JOURNEY_MONITOR_PID" 2>/dev/null; then
      journey_fail "monitor exited while waiting for: $description"
    fi
    journey_record_timeline "$issue"
    if "$@"; then
      journey_log "reached: $description (tick $(journey_tick))"
      return 0
    fi
    if (( JOURNEY_BUDGET_SECONDS > 0 && $(journey_elapsed) > JOURNEY_BUDGET_SECONDS )); then
      journey_fail "over the ${JOURNEY_BUDGET_SECONDS}s journey budget waiting for: $description"
    fi
    if (( $(journey_now) > safety_deadline )); then
      journey_fail "monitor made no progress for ${JOURNEY_WAIT_SAFETY_SECONDS:-300}s waiting for: $description"
    fi
    journey_operator_tick "$issue"
    sleep 0.2
  done
  journey_fail "not reached within $max_ticks monitor ticks: $description"
}

# ── assertions ────────────────────────────────────────────────────────────

JOURNEY_FAILURES=0
journey_assert() {
  local description="$1"; shift
  if "$@"; then
    printf '  PASS  %s\n' "$description"
  else
    printf '  FAIL  %s\n' "$description"
    JOURNEY_FAILURES=$((JOURNEY_FAILURES + 1))
  fi
}

# jq -e as an assertion predicate, without echoing the result.
journey_jq_true() { jq -e "$@" >/dev/null 2>&1; }

journey_pr_merged() {
  [[ "$(jq -r '.prs["1"].state // empty' "$FAKE_GH_STATE")" == "MERGED" ]]
}

# Reaped: the row is gone (or terminal) and so is the worktree, and the mill
# has released the slot (freeSlots back to JOURNEY_MAX_PARALLEL).
journey_task_reaped() {
  local issue="$1" status slug
  status="$(journey_task_field "$issue" status)"
  slug="$(jq -r --arg id "$issue" '.tasks[$id].slug // "__none__"' "$STATE_FILE" 2>/dev/null)"
  [[ -z "$(journey_task_field "$issue" phase)" || "$status" == "merged" || "$status" == "completed" ]] \
    && [[ ! -d "$WORKTREE_ROOT/$slug" ]] \
    && [[ "$(jq -r '.freeSlots // empty' "$STATE_FILE" 2>/dev/null)" == "$JOURNEY_MAX_PARALLEL" ]]
}

# Shared end-state assertions for a task that should have landed.
journey_assert_landed() {
  local issue="$1"
  journey_assert "PR #1 targeted $JOURNEY_INTEGRATION_BRANCH and merged" \
    test "$(fakes_gh_pr_field 1 baseRefName)/$(fakes_gh_pr_field 1 state)" = "$JOURNEY_INTEGRATION_BRANCH/MERGED"
  journey_assert "the task's change is on $JOURNEY_INTEGRATION_BRANCH" \
    git --git-dir "$FAKE_GH_ORIGIN" cat-file -e "refs/heads/$JOURNEY_INTEGRATION_BRANCH:journey-output.txt"
  journey_assert "wm:ready was applied before the merge" \
    journey_jq_true '.prs["1"].history // [] | (map(.event == "labeled" and .label == "wm:ready") | index(true)) as $r
      | (map(.event == "merged") | index(true)) as $m | $r != null and $m != null and $r < $m' "$FAKE_GH_STATE"
  journey_assert "PR never ended up wm:blocked" \
    bash -c '! jq -e ".prs[\"1\"].labels | index(\"wm:blocked\")" "$1" >/dev/null' _ "$FAKE_GH_STATE"
  journey_assert "Linear issue ended Done" test "$(fakes_linear_state_of "$issue")" = "Done"
  journey_assert "Linear recorded In Progress before Done" \
    bash -c 'jq -e --arg id "$2" "[.transitions[] | select(.identifier==\$id) | .to] | (index(\"In Progress\") // 99) < (index(\"Done\") // -1)" "$1" >/dev/null' _ "$FAKE_LINEAR_STATE" "$issue"
  journey_assert "task row and worktree reaped" journey_task_reaped "$issue"
  journey_assert "slot count back to 0 (freeSlots == MAX_PARALLEL)" \
    test "$(jq -r '.freeSlots // empty' "$STATE_FILE")" = "$JOURNEY_MAX_PARALLEL"
  case "$JOURNEY_EXPECT_ATTENTION" in
    1) journey_assert "task raised .needs-attention (expected)" test "$JOURNEY_SAW_ATTENTION" = "1" ;;
    any) ;;
    *) journey_assert "no .needs-attention at any tick" test "$JOURNEY_SAW_ATTENTION" = "0" ;;
  esac
  journey_assert_no_unhandled_fake_calls
}

# HOK-3328: every session the fake agent CLI started has a launch row in the
# task's (archived) .session-ownership.jsonl with the expected kinds, in
# order, and workflow cost is the @hokusai/costs total over exactly those
# owned sessions. $2.. are the expected kinds, e.g. planning coding review.
journey_assert_session_ownership() {
  local issue="$1"; shift
  local expected_kinds="$*"
  local record="$REPO_DIR/.wavemill/evals/artifacts/$issue/.session-ownership.jsonl"
  local launched owned kinds metered
  launched="$(grep "issue=$issue wt=" "$FAKE_AGENT_LOG" 2>/dev/null | sed -n 's/.* session=\([^ ]*\)$/\1/p' | sort | tr '\n' ' ')"
  owned="$(jq -r 'select(.type == "launch") | .sessionRef' "$record" 2>/dev/null | sort | tr '\n' ' ')"
  kinds="$(jq -r 'select(.type == "launch") | .kind' "$record" 2>/dev/null | tr '\n' ' ')"
  journey_assert "session-ownership record archived with the task" test -s "$record"
  journey_assert "every session the agent CLI started has an ownership row (and no other)" \
    test -n "$launched" -a "$launched" = "$owned"
  journey_assert "ownership kinds are [$expected_kinds]" test "${kinds% }" = "$expected_kinds"
  # Each fake session is one claude-opus-4-7 turn: 1000 input + 100 output
  # tokens at $15/$75 per MTok = $0.0225.
  metered="$(cd "$JOURNEY_INSTALL_DIR" && node --import tsx --input-type=module -e "
    const { meterWorkflowCost } = await import('./shared/lib/sdk-task-cost/meter.ts');
    const m = await meterWorkflowCost({ worktreePath: process.argv[1], branchName: 'journey', repoDir: process.argv[1], issueId: process.argv[2],
      pricingTable: { 'claude-opus-4-7': { inputCostPerMTok: 15, outputCostPerMTok: 75 } }, label: 'journey', logger: { log() {}, warn() {} } });
    const o = m.outcome;
    process.stdout.write(o.status === 'success' ? o.sessionCount + ' ' + o.totalCostUsd.toFixed(4) : o.status);
  " "$REPO_DIR" "$issue" 2>/dev/null)"
  local count
  count="$(wc -w <<<"$owned" | tr -d ' ')"
  journey_assert "workflow cost is the SDK total over the $count owned session(s)" \
    test "$metered" = "$count $(awk -v n="$count" 'BEGIN { printf "%.4f", n * 0.0225 }')"
}

journey_assert_no_unhandled_fake_calls() {
  journey_assert "no unmodelled gh calls" test ! -s "$FAKE_GH_UNHANDLED"
  journey_assert "no unmodelled Linear queries" test ! -s "$FAKE_LINEAR_UNHANDLED"
  journey_assert "no unmodelled agent CLI calls" test ! -s "$FAKE_AGENT_UNHANDLED"
}

journey_trace() {
  echo ""
  echo "── journey trace: $JOURNEY_NAME ──────────────────────────────"
  printf ' tick  wall   %-22s %-48s %s\n' "phase/status" "markers" "PR #1"
  if [[ -n "$JOURNEY_TABLE" ]]; then printf '%s' "$JOURNEY_TABLE"; else echo "  <no task observed>"; fi
  if [[ -s "${FAKE_GH_UNHANDLED:-/dev/null}" ]]; then
    echo "unhandled gh calls:"; sed 's/^/  /' "$FAKE_GH_UNHANDLED" | head -10
  fi
  if [[ -s "${FAKE_LINEAR_UNHANDLED:-/dev/null}" ]]; then
    echo "unhandled Linear queries:"; sed 's/^/  /' "$FAKE_LINEAR_UNHANDLED" | head -5
  fi
  if [[ -s "${FAKE_AGENT_UNHANDLED:-/dev/null}" ]]; then
    echo "unhandled agent CLI calls:"; sed 's/^/  /' "$FAKE_AGENT_UNHANDLED" | head -5
  fi
  if [[ -s "$JOURNEY_TMP/approval-episodes.jsonl" ]]; then
    echo "approval requests:"; cut -c1-300 "$JOURNEY_TMP/approval-episodes.jsonl" | sed 's/^/  /'
  fi
  if [[ -s "$JOURNEY_TMP/logs/tend.log" ]]; then
    echo "tend: $JOURNEY_TEND_TICKS tick(s), last action $(grep -o 'action=[^ ]*' "$JOURNEY_TMP/logs/tend.log" | tail -1)"
  fi
  # The mill's own log (status.log); monitor.out is the raw dashboard frame.
  local monitor_log="$JOURNEY_TMP/logs/status.log"
  [[ -s "$monitor_log" ]] || monitor_log="$JOURNEY_TMP/logs/monitor.out"
  echo "monitor log (last 30 lines):"
  tail -30 "$monitor_log" 2>/dev/null | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | cut -c1-200 | sed 's/^/  /'
  echo "artifacts kept in: $JOURNEY_TMP"
  if [[ -n "${JOURNEY_ARTIFACT_DIR:-}" ]]; then
    mkdir -p "$JOURNEY_ARTIFACT_DIR"
    tar -C "$(dirname "$JOURNEY_TMP")" -czf "$JOURNEY_ARTIFACT_DIR/journey-$JOURNEY_NAME.tgz" \
      --exclude='*/origin.git/objects' --exclude='*/.git/objects' "$(basename "$JOURNEY_TMP")" 2>/dev/null || true
  fi
  echo "──────────────────────────────────────────────────────────────"
}

journey_fail() {
  printf '  FAIL  %s\n' "$*"
  JOURNEY_FAILURES=$((JOURNEY_FAILURES + 1))
  journey_trace
  JOURNEY_KEEP_TMP=1
  exit 1
}

journey_finish() {
  local elapsed
  elapsed="$(journey_elapsed)"
  if (( JOURNEY_BUDGET_SECONDS > 0 && elapsed > JOURNEY_BUDGET_SECONDS )); then
    printf '  FAIL  journey took %ss, over the %ss budget\n' "$elapsed" "$JOURNEY_BUDGET_SECONDS"
    JOURNEY_FAILURES=$((JOURNEY_FAILURES + 1))
  fi
  if (( JOURNEY_FAILURES > 0 )); then
    journey_trace
    JOURNEY_KEEP_TMP=1
    echo "--- journey $JOURNEY_NAME: $JOURNEY_FAILURES failure(s) in ${elapsed}s ---"
    exit 1
  fi
  echo "--- journey $JOURNEY_NAME: passed in ${elapsed}s / $(journey_tick) ticks (timeline: $JOURNEY_TIMELINE) ---"
}

journey_stop_monitor() {
  [[ -n "$JOURNEY_MONITOR_PID" ]] || return 0
  if kill -0 "$JOURNEY_MONITOR_PID" 2>/dev/null; then
    journey_command "q"
    local i
    for i in $(seq 1 20); do
      kill -0 "$JOURNEY_MONITOR_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -TERM -- "-$JOURNEY_MONITOR_PID" 2>/dev/null || true
    sleep 0.5
    kill -KILL -- "-$JOURNEY_MONITOR_PID" 2>/dev/null || true
  fi
  wait "$JOURNEY_MONITOR_PID" 2>/dev/null || true
  JOURNEY_MONITOR_PID=""
}

journey_cleanup() {
  journey_stop_monitor || true
  fakes_teardown || true
  if [[ -n "${SESSION:-}" ]]; then
    rm -f /tmp/wavemill-"$SESSION"-* /tmp/"$SESSION"-* 2>/dev/null || true
  fi
  if [[ "${JOURNEY_KEEP_TMP:-0}" != "1" && -n "$JOURNEY_TMP" ]]; then
    rm -rf "$JOURNEY_TMP"
  fi
}
