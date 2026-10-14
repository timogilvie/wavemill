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
#   - approves the plan once plan.md exists (touch .plan-approved),
#   - runs one tend tick whenever the mill has published a Ready handoff.
# Everything else is the mill's own behaviour.
#
# On failure it prints a compact trace (phase timeline, unhandled fake calls,
# tail of the monitor log) instead of a log flood.

set -euo pipefail

JOURNEY_HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOURNEY_INSTALL_DIR="$(cd "$JOURNEY_HARNESS_DIR/../.." && pwd)"
# shellcheck source=../fakes/lib.sh
source "$JOURNEY_INSTALL_DIR/tests/fakes/lib.sh"

JOURNEY_NAME=""
JOURNEY_TMP=""
JOURNEY_MONITOR_PID=""
JOURNEY_STARTED_AT=0
JOURNEY_INTEGRATION_BRANCH="auto/integration"
JOURNEY_TIMELINE=""
JOURNEY_TEND_TICKS=0
# Optional function name a journey sets to inject faults right before the
# first tend tick (e.g. move the integration branch, add gh read lag).
JOURNEY_BEFORE_FIRST_TEND=""

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
      challenge: {enabled: false, gate: {coolOffSeconds: 0}},
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
    printf 'POLL_SECONDS=1\n'
    printf 'REQUIRE_CONFIRM=false\n'
    printf 'DRY_RUN=false\n'
    printf 'BASE_BRANCH=%q\n' "$JOURNEY_INTEGRATION_BRANCH"
    printf 'PROJECT_NAME=\n'
    printf 'PLANNING_MODE=interactive\n'
    printf 'AGENT_CMD=claude\n'
    printf 'AGENT_CMD_EXPLICIT=true\n'
    printf 'ROUTER_ENABLED=false\n'
    printf 'MAX_PARALLEL=1\n'
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

journey_record_timeline() {
  local issue="$1" phase status line
  phase="$(journey_task_field "$issue" phase)"
  status="$(journey_task_field "$issue" status)"
  line="${phase:-<none>}/${status:-<none>}"
  if [[ "$JOURNEY_TIMELINE" != *"$line" ]]; then
    JOURNEY_TIMELINE+="${JOURNEY_TIMELINE:+ → }$line"
    journey_log "task $issue: $line"
  fi
}

# Operator/backstage roles, run on every poll.
journey_operator_tick() {
  local issue="$1" fd
  fd="$(journey_feature_dir "$issue" 2>/dev/null)" || return 0
  if [[ -f "$fd/plan.md" && ! -f "$fd/.plan-approved" ]] \
     && [[ "$(jq -r '.status // empty' "$fd/.planning-result.json" 2>/dev/null)" == "awaiting_user" ]]; then
    touch "$fd/.plan-approved"
    journey_log "operator approved plan"
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

# journey_wait_until <issue> <timeout-seconds> <description> <predicate...>
journey_wait_until() {
  local issue="$1" timeout="$2" description="$3"; shift 3
  local deadline=$(( $(journey_now) + timeout ))
  while (( $(journey_now) < deadline )); do
    if ! kill -0 "$JOURNEY_MONITOR_PID" 2>/dev/null; then
      journey_fail "monitor exited while waiting for: $description"
    fi
    journey_record_timeline "$issue"
    if "$@"; then
      journey_log "reached: $description"
      return 0
    fi
    journey_operator_tick "$issue"
    sleep 0.5
  done
  journey_fail "timed out after ${timeout}s waiting for: $description"
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

journey_assert_no_unhandled_fake_calls() {
  journey_assert "no unmodelled gh calls" test ! -s "$FAKE_GH_UNHANDLED"
  journey_assert "no unmodelled Linear queries" test ! -s "$FAKE_LINEAR_UNHANDLED"
  journey_assert "no unmodelled agent CLI calls" test ! -s "$FAKE_AGENT_UNHANDLED"
}

journey_trace() {
  echo ""
  echo "── journey trace: $JOURNEY_NAME ──────────────────────────────"
  echo "timeline: ${JOURNEY_TIMELINE:-<no task observed>}"
  if [[ -s "${FAKE_GH_UNHANDLED:-/dev/null}" ]]; then
    echo "unhandled gh calls:"; sed 's/^/  /' "$FAKE_GH_UNHANDLED" | head -10
  fi
  if [[ -s "${FAKE_LINEAR_UNHANDLED:-/dev/null}" ]]; then
    echo "unhandled Linear queries:"; sed 's/^/  /' "$FAKE_LINEAR_UNHANDLED" | head -5
  fi
  if [[ -s "${FAKE_AGENT_UNHANDLED:-/dev/null}" ]]; then
    echo "unhandled agent CLI calls:"; sed 's/^/  /' "$FAKE_AGENT_UNHANDLED" | head -5
  fi
  if [[ -s "${FAKE_AGENT_LOG:-/dev/null}" ]]; then
    echo "agent log:"; sed 's/^/  /' "$FAKE_AGENT_LOG" | tail -8
  fi
  if [[ -s "$JOURNEY_TMP/logs/tend.log" ]]; then
    echo "tend (last 15 lines):"; tail -15 "$JOURNEY_TMP/logs/tend.log" | sed 's/^/  /'
  fi
  if [[ -s "$JOURNEY_TMP/logs/status.log" ]]; then
    echo "mill status log (last 40 lines):"; tail -40 "$JOURNEY_TMP/logs/status.log" | cut -c1-240 | sed 's/^/  /'
  fi
  echo "monitor (last 40 lines):"
  tail -40 "$JOURNEY_TMP/logs/monitor.out" 2>/dev/null | sed 's/\x1b\[[0-9;]*[A-Za-z]//g; s/^/  /'
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
  local elapsed=$(( $(journey_now) - JOURNEY_STARTED_AT ))
  if (( JOURNEY_FAILURES > 0 )); then
    journey_trace
    JOURNEY_KEEP_TMP=1
    echo "--- journey $JOURNEY_NAME: $JOURNEY_FAILURES failure(s) in ${elapsed}s ---"
    exit 1
  fi
  echo "--- journey $JOURNEY_NAME: passed in ${elapsed}s (timeline: $JOURNEY_TIMELINE) ---"
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
