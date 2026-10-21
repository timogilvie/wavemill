#!/usr/bin/env bash
# HOK-3253: task inputs are prepared and bound before plan approval.
#
# Sources the REAL monitor (WAVEMILL_MONITOR_SOURCE_ONLY=1, so every function
# under test is the production definition) and drives ensure_task_inputs_ready
# / approve_plan / enforce_plan_packet_binding through each acceptance
# scenario against real feature-dir artifacts. Only the edges are stubbed:
# logging, tmux attention, the stage-result writer (a jq stand-in for the
# node CLI), the task-phase writer, and the tracked-job launcher (the job
# itself is simulated by writing what recover_missing_expansion_artifact
# writes). The end-to-end replay is tests/journeys/inputs-ready-before-approval.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d -t wavemill-task-inputs-XXXXXX)"
TMP="$(cd "$TMP" && pwd -P)"
SESSION="tig$$"
trap 'rm -rf "$TMP"; rm -f /tmp/wavemill-'"$SESSION"'-* 2>/dev/null || true' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
check_eq() {
  local name="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}
check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"; else echo "    missing: $needle"; echo "    in: ${haystack:0:400}"; fail "$name"; fi
}
check_file() { if [[ -e "$2" ]]; then pass "$1"; else fail "$1 (missing $2)"; fi; }
check_no_file() { if [[ ! -e "$2" ]]; then pass "$1"; else fail "$1 (unexpected $2)"; fi; }

echo "=== task inputs ready before plan approval (HOK-3253) ==="

mkdir -p "$TMP/repo" "$TMP/worktrees"
cat > "$TMP/env.sh" <<ENV
SESSION="$SESSION"
STATE_DIR="$TMP/state"
STATE_FILE="$TMP/state/workflow-state.json"
REPO_DIR="$TMP/repo"
WAVEMILL_INSTALL_DIR="$REPO_DIR"
TOOLS_DIR="$REPO_DIR/tools"
LIB_DIR="$REPO_DIR/shared/lib"
WAVEMILL_LIB_DIR="$REPO_DIR/shared/lib"
WORKTREE_ROOT="$TMP/worktrees"
BASE_BRANCH=main
POLL_SECONDS=10
MAX_PARALLEL=1
API_TIMEOUT=5
DRY_RUN=false
TASKS_FILE="$TMP/tasks.txt"
ENV
mkdir -p "$TMP/state"
: > "$TMP/tasks.txt"
printf '{"tasks":{}}\n' > "$TMP/state/workflow-state.json"

export WAVEMILL_MONITOR_SOURCE_ONLY=1
export WAVEMILL_TICK_CLOCK_FILE="$TMP/tick-clock"
export WAVEMILL_TICK_CLOCK_EPOCH="$(date +%s)"
export WAVEMILL_TICK_CLOCK_SECONDS=600
# shellcheck source=../shared/lib/wavemill-monitor.sh
source "$REPO_DIR/shared/lib/wavemill-monitor.sh" "$TMP/env.sh" >/dev/null 2>&1
set +e +E
trap - ERR
set -uo pipefail
SESSION="$SESSION"

# ── edge stubs ──────────────────────────────────────────────────────────────
LOG_OUT=""
log() { LOG_OUT+="$*"$'\n'; }
log_warn() { LOG_OUT+="WARN $*"$'\n'; }
ATTENTION=""
set_window_attention_state() { ATTENTION="$2"; }
PHASE=""
set_task_phase() { PHASE="$2"; }
write_stage_result() {
  jq -n --arg stage "$2" --arg status "$3" --arg notes "${6:-}" \
    '{stage: $stage, status: $status, notes: $notes}' > "$1/.${2}-result.json"
}
JOB_RUNNING=0
LAUNCHES="$TMP/launches.log"
: > "$LAUNCHES"
monitor_async_job_running() { (( JOB_RUNNING == 1 )); }
monitor_async_job_launch() { printf '%s\n' "$*" >> "$LAUNCHES"; }
launch_count() { grep -c . "$LAUNCHES" 2>/dev/null || true; }

DETAILED_DESC=$'## 1. Objective\nShip the fixture.\n\n## 4. Success Criteria\n- [REQ-F1] it ships.'
new_feature() {
  local name="$1" description="$2" fd
  fd="$TMP/worktrees/$name/features/$name"
  mkdir -p "$fd"
  jq -n --arg t "Fixture $name" --arg d "$description" '{taskId: "JRN-1", title: $t, description: $d}' > "$fd/selected-task.json"
  printf '%s\n' "$fd"
}
write_plan() { printf '# Plan\n\n%s\n' "${2:-steps}" > "$1/plan.md"; }
# What recover_missing_expansion_artifact leaves behind on success.
simulate_recovery_success() {
  local fd="$1"
  printf '## 1. Objective\nExpanded by the recovery job.\n' > "$fd/task-packet.md"
  expansion_recovery_mark_attempted "$fd" "JRN-1" "missing" >/dev/null
  expansion_recovery_mark_result "$fd" "JRN-1" "succeeded" "expanded-route-recovered" "0" >/dev/null
}
age_file() { touch -t "$(date -v-5M +%Y%m%d%H%M.%S 2>/dev/null || date -d '-5 min' +%Y%m%d%H%M.%S)" "$1"; }
bound_hash() { jq -r '.packetHash // ""' "$1/.plan-packet-hash" 2>/dev/null; }
current_hash() { plan_packet_current_hash "$1" | awk '{print $1}'; }

# ── 1. detailed issue, planner wrote only plan.md (the HOK-3220 shape) ──────
echo "--- detailed issue, missing local packet ---"
fd="$(new_feature detailed "$DETAILED_DESC")"
write_plan "$fd"
rc=0; ensure_task_inputs_ready JRN-1 detailed "$fd" win claude publish || rc=$?
check_eq "publish proceeds (rc 0)" "$rc" "0"
check_file "task-packet.md materialised" "$fd/task-packet.md"
check_eq "packet is '<title>\\n\\n<description>' (native materialiser shape)" \
  "$(cat "$fd/task-packet.md")" "$(printf 'Fixture detailed\n\n%s' "$DETAILED_DESC")"
check_eq "handshake passes" "$(mill_expansion_handshake_reason "$fd")" "already-expanded"
check_eq "binding names the materialised packet" "$(bound_hash "$fd")" "$(current_hash "$fd")"
check_eq "binding source is preparation" "$(plan_packet_recorded_source "$fd")" "preparation"
check_eq "no expansion job launched (no LLM)" "$(launch_count)" "0"
first_hash="$(bound_hash "$fd")"

# Restart / repeated ticks: idempotent, nothing re-materialised or re-launched.
rc=0; ensure_task_inputs_ready JRN-1 detailed "$fd" win claude publish || rc=$?
check_eq "repeat publish still proceeds" "$rc" "0"
check_eq "repeat publish keeps the same binding" "$(bound_hash "$fd")" "$first_hash"
check_eq "repeat publish launches nothing" "$(launch_count)" "0"

# Operator accept annotates; handoff re-assert never touches the binding.
approve_plan "$fd" claude ""
check_eq "approval keeps packetHash" "$(bound_hash "$fd")" "$first_hash"
check_eq "approval keeps source preparation" "$(plan_packet_recorded_source "$fd")" "preparation"
check_eq "approval annotates approvedAt" "$(jq -r '.approvedAt | type' "$fd/.plan-packet-hash")" "string"
before_handoff="$(cat "$fd/.plan-packet-hash")"
approve_plan "$fd" claude "" none
check_eq "handoff approve_plan(none) leaves the binding byte-identical" "$(cat "$fd/.plan-packet-hash")" "$before_handoff"
rc=0; enforce_plan_packet_binding JRN-1 "$fd" win claude || rc=$?
check_eq "handoff guard: match, coding may launch" "$rc" "0"

# Route-only change: packet bytes unchanged -> no re-approval.
printf '{"coder":"other-coder","codeDepth":"deep","reviewer":"r","reviewMode":"static"}\n' > "$fd/.post-expansion-route.json"
rc=0; enforce_plan_packet_binding JRN-1 "$fd" win claude || rc=$?
check_eq "route-only change: still match, no re-plan" "$rc" "0"
check_file "route-only change: approval kept" "$fd/plan.md"

# ── 2. genuine packet change after approval ─────────────────────────────────
echo "--- genuine packet change after approval ---"
touch "$fd/.plan-approved"
printf '\n## 9. Proposed Labels\nscope-change\n' >> "$fd/task-packet.md"
rc=0; enforce_plan_packet_binding JRN-1 "$fd" win claude || rc=$?
check_eq "changed packet blocks coding" "$rc" "1"
check_no_file "changed packet: approval voided" "$fd/.plan-approved"
check_no_file "changed packet: plan moved aside" "$fd/plan.md"
check_eq "changed packet: one stale plan preserved" "$(find "$fd" -maxdepth 1 -name 'plan.stale-*.md' | wc -l | tr -d ' ')" "1"
check_contains "changed packet: re-approval reason states the input change" "$(plan_packet_reapproval_reason "$fd")" "task inputs changed"
check_eq "changed packet: planning relaunched via routing" "$PHASE" "routing"
# The re-plan writes a fresh plan.md; publish binds the NEW packet.
write_plan "$fd" "replanned"
rc=0; ensure_task_inputs_ready JRN-1 detailed "$fd" win claude publish || rc=$?
check_eq "re-plan publish proceeds" "$rc" "0"
check_eq "re-plan binds the changed packet" "$(bound_hash "$fd")" "$(current_hash "$fd")"
approve_plan "$fd" claude ""
check_eq "approval clears the re-approval reason" "$(plan_packet_reapproval_reason "$fd")" ""

# ── 3. raw issue: tracked expansion before approval ─────────────────────────
echo "--- raw issue requiring expansion ---"
fd="$(new_feature raw "please add a thing")"
write_plan "$fd"
age_file "$fd/plan.md"
: > "$LAUNCHES"
rc=0; ensure_task_inputs_ready JRN-1 raw "$fd" win claude publish || rc=$?
check_eq "raw publish holds (rc 1)" "$rc" "1"
check_eq "raw: one prepare-task-inputs job launched" "$(launch_count)" "1"
check_contains "raw: job kind" "$(cat "$LAUNCHES")" "prepare-task-inputs prepare-task-inputs-JRN-1"
check_no_file "raw: nothing bound while preparing" "$fd/.plan-packet-hash"
check_eq "raw: attention clear while preparing (not needs-user)" "$ATTENTION" "clear"
JOB_RUNNING=1
rc=0; ensure_task_inputs_ready JRN-1 raw "$fd" win claude publish || rc=$?
check_eq "raw: still held while the job runs" "$rc" "1"
check_eq "raw: no duplicate launch while running" "$(launch_count)" "1"
JOB_RUNNING=0
simulate_recovery_success "$fd"
PHASE=""
rc=0; ensure_task_inputs_ready JRN-1 raw "$fd" win claude publish || rc=$?
check_eq "raw: packet recovered after plan.md -> re-plan, not an approval request" "$rc" "1"
check_no_file "raw: stale plan moved aside" "$fd/plan.md"
check_eq "raw: re-plan relaunches planning" "$PHASE" "routing"
check_eq "raw: no approval was given, so no re-approval reason" "$(plan_packet_reapproval_reason "$fd")" ""
write_plan "$fd" "planned against the expanded packet"
rc=0; ensure_task_inputs_ready JRN-1 raw "$fd" win claude publish || rc=$?
check_eq "raw: the re-planned plan is offered (rc 0)" "$rc" "0"
check_eq "raw: binding names the recovered packet" "$(bound_hash "$fd")" "$(current_hash "$fd")"
check_eq "raw: exactly one expansion job overall" "$(launch_count)" "1"

# ── 4. expansion failure is bounded and actionable ──────────────────────────
echo "--- expansion failure ---"
fd="$(new_feature failing "raw words only")"
write_plan "$fd"
: > "$LAUNCHES"
for attempt in 1 2 3 4 5 6; do
  ensure_task_inputs_ready JRN-1 failing "$fd" win claude publish >/dev/null 2>&1 || true
  expansion_recovery_mark_result "$fd" "JRN-1" "failed" "expand-issue-exited-non-zero" "1" >/dev/null
  mill_clock_advance_tick
done
check_eq "failure: launches capped at the retry limit" "$(launch_count)" "$ASYNC_CHECK_JOB_RETRY_LIMIT"
LOG_OUT=""
rc=0; ensure_task_inputs_ready JRN-1 failing "$fd" win claude publish || rc=$?
check_eq "failure: holds (never offers approval)" "$rc" "1"
check_eq "failure: needs-user attention" "$ATTENTION" "needs-user"
check_file "failure: evidence marker written" "$fd/.task-inputs-failure.json"
check_contains "failure: evidence names the recovery detail" "$(jq -r '.detail' "$fd/.task-inputs-failure.json")" "expand-issue-exited-non-zero"
check_contains "failure: next action is actionable" "$(jq -r '.nextAction' "$fd/.task-inputs-failure.json")" "wavemill expand JRN-1"
check_file "failure: exhausted sentinel recorded" "$fd/.retry-expansion-recovery-job-exhausted"
check_eq "failure: warning not repeated on later passes" "$(grep -c 'task-input preparation failed' <<<"$LOG_OUT" || true)" "0"
check_no_file "failure: no binding recorded" "$fd/.plan-packet-hash"
# The operator's fix (wavemill expand) lands a packet: the plan is offered.
printf '## 1. Objective\nExpanded by the operator.\n' > "$fd/task-packet.md"
rc=0; ensure_task_inputs_ready JRN-1 failing "$fd" win claude publish || rc=$?
check_eq "failure recovered by operator expand: proceeds" "$rc" "0"
check_no_file "failure recovered: evidence marker cleared" "$fd/.task-inputs-failure.json"

# ── 5. agent-published request (native) and the handoff entry point ─────────
echo "--- accept and handoff modes ---"
fd="$(new_feature native "$DETAILED_DESC")"
printf '## 1. Objective\nNative packet.\n' > "$fd/task-packet.md"
age_file "$fd/task-packet.md"
write_plan "$fd"
rc=0; ensure_task_inputs_ready JRN-1 native "$fd" win claude accept || rc=$?
check_eq "accept: packet ready, proceeds" "$rc" "0"
check_eq "accept: binds when nothing is bound" "$(bound_hash "$fd")" "$(current_hash "$fd")"
native_hash="$(bound_hash "$fd")"
printf 'edited while awaiting approval\n' >> "$fd/task-packet.md"
rc=0; ensure_task_inputs_ready JRN-1 native "$fd" win claude accept || rc=$?
check_eq "accept: never re-binds a changed packet" "$(bound_hash "$fd")" "$native_hash"

fd="$(new_feature legacy "raw legacy input")"
write_plan "$fd"
touch "$fd/.plan-approved"
: > "$LAUNCHES"
rc=0; ensure_task_inputs_ready JRN-1 legacy "$fd" win claude handoff || rc=$?
check_eq "handoff without inputs: coding held" "$rc" "1"
check_no_file "handoff without inputs: pre-preparation approval discarded" "$fd/.plan-approved"
check_eq "handoff without inputs: planning back to running" "$(jq -r '.status' "$fd/.planning-result.json")" "running"
check_contains "handoff without inputs: note explains" "$(jq -r '.notes' "$fd/.planning-result.json")" "Preparing task inputs before approval"
check_eq "handoff without inputs: phase planning" "$PHASE" "planning"
check_eq "handoff without inputs: expansion runs as a tracked job" "$(launch_count)" "1"

fd="$(new_feature legacy-detailed "$DETAILED_DESC")"
write_plan "$fd"
rc=0; ensure_task_inputs_ready JRN-1 legacy-detailed "$fd" win claude handoff || rc=$?
check_eq "handoff, detailed issue: materialised and proceeds" "$rc" "0"
check_eq "handoff, detailed issue: binds the materialised packet" "$(bound_hash "$fd")" "$(current_hash "$fd")"
rc=0; enforce_plan_packet_binding JRN-1 "$fd" win claude || rc=$?
check_eq "handoff, detailed issue: guard matches (no needless re-plan)" "$rc" "0"

echo ""
echo "Results: $PASS passed, $FAIL failed"
(( FAIL == 0 ))
