#!/usr/bin/env bash
# HOK-3359 — unit coverage for the one stage-agent teardown
# (shared/lib/stage-teardown.sh `stage_agent_teardown`).
#
# Background: eight call sites each answered "may I end this stage agent
# now, and what does the record say afterwards?" differently. The 2026-10-30
# incident (HOK-3315) was `quarantine_completed_coding_pane` killing the
# coding pane 3s after `.coding-complete`, mid-write, with no settle and no
# exit record — the dirty-tree-agent-exited relaunch never saw an idle agent
# because nothing ever recorded that the controller, not the agent, ended it.
#
# `stage_agent_teardown` is the one answer: settle (non-blocking, HOK-3206)
# until the agent is idle or a grace elapses, terminate gracefully, record a
# controller-termination exit fact, then kill the window (unless
# --keep-window). These cases pin the settle gate's four branches.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# ── Stub every external dependency stage_agent_teardown degrades to via
# declare -F. These shadow the real implementations (command -v finds shell
# functions too), so the test never needs a real tmux server.
PROGRESS_JSON='{}'
TERMINATE_CALLS=0
KILL_CALLS=0
RECORD_CALLS=""
KILL_SUCCEEDS=1
HAVE_TARGET=1

task_progress_json() { printf '%s\n' "$PROGRESS_JSON"; }
agent_terminate_in_pane() { TERMINATE_CALLS=$((TERMINATE_CALLS + 1)); return 0; }
_tmux_task_window_target() {
  [[ "$HAVE_TARGET" == "1" ]] || return 1
  printf 'win-target\n'
}
_tmux_target_join() { printf '%s:%s\n' "$1" "$2"; }
_tmux_window_target_exists() { [[ "$KILL_SUCCEEDS" == "1" ]] && return 1 || return 0; }
tmux() { KILL_CALLS=$((KILL_CALLS + 1)); return 0; }
wavemill_hook_write_controller_termination() {
  RECORD_CALLS+="$1|$2|$3|$4"$'\n'
  return 0
}

# shellcheck source=../shared/lib/stage-teardown.sh
source "$REPO_DIR/shared/lib/stage-teardown.sh"

reset_state() {
  PROGRESS_JSON='{}'
  TERMINATE_CALLS=0
  KILL_CALLS=0
  RECORD_CALLS=""
  KILL_SUCCEEDS=1
  HAVE_TARGET=1
}

FEATURE_DIR="$TMP_ROOT/features/test-slug"
mkdir -p "$FEATURE_DIR"

# ── Case A: fresh completion marker, agent still working → pending (2) ──────
reset_state
rm -f "$FEATURE_DIR/.coding-complete"
touch "$FEATURE_DIR/.coding-complete"
PROGRESS_JSON='{"agentIdle": false, "terminalIdle": false, "agentProcessLive": true}'
WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS=120
rc=0
stage_agent_teardown "HOK-T1" "$FEATURE_DIR" "completed-coding-pane-quarantine" --phase coding || rc=$?
if [[ "$rc" -eq 2 ]]; then pass "Case A: fresh marker + live agent returns pending (2)"; else fail "Case A: expected rc=2, got $rc"; fi
if [[ "$TERMINATE_CALLS" -eq 0 && "$KILL_CALLS" -eq 0 && -z "$RECORD_CALLS" ]]; then
  pass "Case A: pending does not terminate, kill, or record"
else
  fail "Case A: pending must not touch terminate/kill/record (terminate=$TERMINATE_CALLS kill=$KILL_CALLS record='$RECORD_CALLS')"
fi

# ── Case B: agent already idle → terminate + record + kill immediately ─────
reset_state
PROGRESS_JSON='{"agentIdle": true, "terminalIdle": false, "agentProcessLive": false}'
rc=0
stage_agent_teardown "HOK-T2" "$FEATURE_DIR" "completed-coding-pane-quarantine" --phase coding || rc=$?
if [[ "$rc" -eq 0 ]]; then pass "Case B: already-idle agent returns success (0)"; else fail "Case B: expected rc=0, got $rc"; fi
if [[ "$TERMINATE_CALLS" -eq 1 ]]; then pass "Case B: terminate ran once"; else fail "Case B: expected 1 terminate call, got $TERMINATE_CALLS"; fi
if [[ -n "$RECORD_CALLS" ]]; then pass "Case B: controller-termination recorded"; else fail "Case B: expected a record call"; fi
if [[ "$KILL_CALLS" -eq 1 ]]; then pass "Case B: window killed"; else fail "Case B: expected 1 kill call, got $KILL_CALLS"; fi

# ── Case C: grace elapsed, agent still working → terminate anyway (0) ──────
reset_state
touch -t 202601010000 "$FEATURE_DIR/.coding-complete" 2>/dev/null \
  || touch -d '2026-01-01' "$FEATURE_DIR/.coding-complete" 2>/dev/null \
  || { touch "$FEATURE_DIR/.coding-complete"; }
PROGRESS_JSON='{"agentIdle": false, "terminalIdle": false, "agentProcessLive": true}'
WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS=1
rc=0
stage_agent_teardown "HOK-T3" "$FEATURE_DIR" "completed-coding-pane-quarantine" --phase coding || rc=$?
if [[ "$rc" -eq 0 ]]; then pass "Case C: grace elapsed terminates anyway (0)"; else fail "Case C: expected rc=0, got $rc"; fi
if [[ "$TERMINATE_CALLS" -eq 1 && -n "$RECORD_CALLS" ]]; then
  pass "Case C: terminate + record ran despite a still-live agent"
else
  fail "Case C: expected terminate+record (terminate=$TERMINATE_CALLS record='$RECORD_CALLS')"
fi

# ── Case D: --no-settle always skips the settle wait ────────────────────────
reset_state
rm -f "$FEATURE_DIR/.coding-complete"
touch "$FEATURE_DIR/.coding-complete"
PROGRESS_JSON='{"agentIdle": false, "terminalIdle": false, "agentProcessLive": true}'
WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS=120
rc=0
stage_agent_teardown "HOK-T4" "$FEATURE_DIR" "operator-abort" --no-settle || rc=$?
if [[ "$rc" -eq 0 ]]; then pass "Case D: --no-settle returns success (0) immediately"; else fail "Case D: expected rc=0, got $rc"; fi
if [[ "$TERMINATE_CALLS" -eq 1 && -n "$RECORD_CALLS" && "$KILL_CALLS" -eq 1 ]]; then
  pass "Case D: --no-settle still terminates, records, and kills"
else
  fail "Case D: expected full teardown (terminate=$TERMINATE_CALLS kill=$KILL_CALLS record='$RECORD_CALLS')"
fi

# ── --keep-window never kills the window, even when settled ─────────────────
reset_state
PROGRESS_JSON='{"agentIdle": true}'
rc=0
stage_agent_teardown "HOK-T5" "$FEATURE_DIR" "completed-planning-reap" --no-settle --keep-window || rc=$?
if [[ "$rc" -eq 0 && "$KILL_CALLS" -eq 0 ]]; then
  pass "--keep-window skips the kill step"
else
  fail "--keep-window must not kill (rc=$rc kill=$KILL_CALLS)"
fi

# ── --no-record skips the record step ────────────────────────────────────────
reset_state
PROGRESS_JSON='{"agentIdle": true}'
rc=0
stage_agent_teardown "HOK-T6" "$FEATURE_DIR" "pane-release" --no-settle --no-record || rc=$?
if [[ "$rc" -eq 0 && -z "$RECORD_CALLS" ]]; then
  pass "--no-record skips the record step"
else
  fail "--no-record must not record (rc=$rc record='$RECORD_CALLS')"
fi

# ── HOK-3315 incident timeline replay ───────────────────────────────────────
# marker at T, clean tree at T+1 (not modeled here — the guard owns tree
# state; this exercises teardown's hold), a write at T+3 (agent still
# "working"), quarantine due at T+4. Expected: every tick inside the grace
# holds (pending) while the agent is live; once the agent's own idle/Stop
# record lands, the very next tick tears down. No premature kill, no lost
# write — the exact shape the raw, settle-less kill-window got wrong.
reset_state
rm -f "$FEATURE_DIR/.coding-complete"
touch "$FEATURE_DIR/.coding-complete"
WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS=120
PROGRESS_JSON='{"agentIdle": false, "terminalIdle": false, "agentProcessLive": true}'
rc_t4=0
stage_agent_teardown "HOK-3315" "$FEATURE_DIR" "completed-coding-pane-quarantine" --phase coding || rc_t4=$?
rc_t10=0
stage_agent_teardown "HOK-3315" "$FEATURE_DIR" "completed-coding-pane-quarantine" --phase coding || rc_t10=$?
if [[ "$rc_t4" -eq 2 && "$rc_t10" -eq 2 && "$KILL_CALLS" -eq 0 ]]; then
  pass "HOK-3315 replay: every tick inside the grace holds while the agent is still writing"
else
  fail "HOK-3315 replay: expected pending+no-kill across ticks (rc_t4=$rc_t4 rc_t10=$rc_t10 kill=$KILL_CALLS)"
fi
# The agent settles (its own Stop/idle record lands) before the grace runs
# out — the very next tick tears down instead of waiting out the full grace.
PROGRESS_JSON='{"agentIdle": true, "terminalIdle": false, "agentProcessLive": false}'
rc_settled=0
stage_agent_teardown "HOK-3315" "$FEATURE_DIR" "completed-coding-pane-quarantine" --phase coding || rc_settled=$?
if [[ "$rc_settled" -eq 0 && "$KILL_CALLS" -eq 1 && -n "$RECORD_CALLS" ]]; then
  pass "HOK-3315 replay: the agent's own idle record settles the hold and tears down immediately"
else
  fail "HOK-3315 replay: expected settle to resolve to rc=0 with one kill (rc=$rc_settled kill=$KILL_CALLS record='$RECORD_CALLS')"
fi

# ── A window-close failure (kill-window ran, target still present) → 1 ──────
reset_state
PROGRESS_JSON='{"agentIdle": true}'
KILL_SUCCEEDS=0
rc=0
stage_agent_teardown "HOK-T7" "$FEATURE_DIR" "aborted-arm" --no-settle || rc=$?
if [[ "$rc" -eq 1 ]]; then pass "A window still present after kill returns failure (1)"; else fail "expected rc=1, got $rc"; fi
if [[ -n "$RECORD_CALLS" ]]; then pass "the record still ran before the failed kill"; else fail "record should still run even if the kill fails"; fi

# ── Missing window target is idempotent success, still recorded ────────────
reset_state
PROGRESS_JSON='{"agentIdle": true}'
HAVE_TARGET=0
rc=0
stage_agent_teardown "HOK-T8" "$FEATURE_DIR" "challenge-cancel" --no-settle || rc=$?
if [[ "$rc" -eq 0 && "$KILL_CALLS" -eq 0 ]]; then
  pass "a missing window target is idempotent success with no kill attempt"
else
  fail "expected rc=0 with no kill call (rc=$rc kill=$KILL_CALLS)"
fi
if [[ -n "$RECORD_CALLS" ]]; then pass "the exit fact is still recorded with no window"; else fail "record must still run with no window"; fi

echo ""
echo "stage-teardown.test.sh: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
