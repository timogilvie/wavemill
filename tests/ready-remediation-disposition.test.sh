#!/usr/bin/env bash
# HOK-3322 — the one Ready remediation disposition, seen from the monitor.
#
# 1. Agreement: every `shell: true` row of
#    tests/fixtures/ready-remediation-disposition-cases.json is materialised as
#    real state (ready result, ready-remediation bucket, conflict marker,
#    session-ownership row, the agent's own hook file, a schema-validated
#    workflow-state row) and fed to the monitor's ready_remediation_disposition
#    wrapper. It must print the kind and reason the TS decision returns for the
#    same row (shared/lib/ready-remediation-disposition.test.ts), which is the
#    decision the ready-watchdog snapshot calls in process.
# 2. Incident replay (HOK-3316 / PR #1720, 2026-10-26): hand-built from the
#    pre-recovery evidence in
#    .wavemill/incidents/2026-10-26-stuck-delivered-prs/findings.json — Ready
#    running with the remediation launch record (verdict fail) at the launch
#    head, CI green 28/28 after a rerun, the remediation agent idle, no
#    handoff. The HOK-3316/.ready-result.json saved there was copied after the
#    operator's manual completion, so it is NOT used as before-state. The
#    end-to-end merge with zero operator touches is the
#    ready-remediation-same-head golden journey.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
FIXTURE="$REPO_DIR/tests/fixtures/ready-remediation-disposition-cases.json"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
check_eq() {
  if [[ "$2" == "$3" ]]; then pass "$1"; else echo "    expected: $3"; echo "    actual:   $2"; fail "$1"; fi
}

TEST_TMP="$(mktemp -d)"
SESSION="rrd-test-$$"
STATE_FILE="$TEST_TMP/workflow-state.json"
cleanup() {
  rm -rf "$TEST_TMP"
  rm -f /tmp/wavemill-"$SESSION"-*.hook /tmp/wavemill-"$SESSION"-*.progress.json
}
trap cleanup EXIT

# Run the CLI from this checkout, never a TOOLS_DIR inherited from a live mill.
unset TOOLS_DIR
# shellcheck source=/dev/null
source "$REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=/dev/null
source "$REPO_DIR/shared/lib/bounded-retry.sh"
# shellcheck source=/dev/null
source "$REPO_DIR/shared/lib/transient-marker.sh"
# shellcheck source=/dev/null
source "$REPO_DIR/tests/lib/state-fixtures.sh"

extract_function() {
  awk -v name="$2" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$1"
}
FUNC_FILE="$TEST_TMP/monitor-functions.sh"
for fn in read_stage_status conflict_remediation_marker_path ready_remediation_disposition; do
  extract_function "$MONITOR_SCRIPT_FILE" "$fn" >> "$FUNC_FILE"
done
# shellcheck source=/dev/null
source "$FUNC_FILE"

OTHER_HEAD="0badc0de0badc0de0badc0de0badc0de0badc0de"

iso_ago() {
  local epoch=$(( $(date +%s) - $1 ))
  date -u -r "$epoch" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%S.000Z
}

# new_task <dir> <issue> — a git worktree, its ready state dir, a workflow row.
# Prints "<worktree> <state_dir> <head>".
new_task() {
  local dir="$1" issue="$2" wt state head
  wt="$dir/wt"
  mkdir -p "$wt"
  git -C "$wt" init -q
  printf 'fixture\n' > "$wt/journey-output.txt"
  git -C "$wt" add journey-output.txt
  git -C "$wt" -c user.name=t -c user.email=t@example.invalid commit -q -m init
  head="$(git -C "$wt" rev-parse HEAD)"
  state="$wt/features/remediation-task"
  mkdir -p "$state"
  fixture_workflow_state "$STATE_FILE" "$issue" phase=ready slug=remediation-task \
    branch=task/remediation-task "worktree=$wt" pr=1720 >/dev/null
  printf '%s %s %s\n' "$wt" "$state" "$head"
}

write_ready_result() {
  local state="$1" status="$2" artifacts="$3"
  jq -cn --arg status "$status" --arg started "$(iso_ago 3600)" --argjson artifacts "$artifacts" \
    '{stage:"ready", status:$status, startedAt:$started, finishedAt:null, agent:"claude", model:"m", notes:null, artifacts:$artifacts}' \
    > "$state/.ready-result.json"
}

write_ownership_row() {
  local state="$1" kind="$2" ago="$3"
  jq -cn --arg kind "$kind" --arg at "$(iso_ago "$ago")" \
    '{schemaVersion:1, type:"launch", sessionRef:("s-" + $kind), harness:"claude-code", kind:$kind, model:"m", launchedAt:$at, attemptId:($kind + "@nohead#0")}' \
    >> "$state/.session-ownership.jsonl"
}

# The agent's own record, as shared/hooks/claude-status-hook.sh writes it.
write_agent_hook() {
  local issue="$1" state_name="$2" event="$3" ago="$4" ts
  ts=$(( $(date +%s) - ago ))
  jq -cn --arg s "$state_name" --arg e "$event" --argjson ts "$ts" \
    '{state:$s, event:$e, agent:"claude", timestamp:$ts, writer:"agent", agentRecord:{state:$s, event:$e, agent:"claude", timestamp:$ts}}' \
    > "/tmp/wavemill-${SESSION}-${issue}.hook"
}

echo "=== Ready remediation disposition: monitor agrees with the shared table ==="

case_count=$(jq '[.cases[] | select(.shell)] | length' "$FIXTURE")
for (( i = 0; i < case_count; i++ )); do
  row="$(jq -c "[.cases[] | select(.shell)][$i]" "$FIXTURE")"
  name="$(jq -r '.name' <<< "$row")"
  issue="RRD-$((i + 1))"
  dir="$TEST_TMP/case-$i"
  read -r wt state head < <(new_task "$dir" "$issue")

  remediation="$(jq -r '.launch.remediation // empty' <<< "$row")"
  artifacts='{"type":"ready","verdict":"fail","prNumber":1720}'
  [[ "$remediation" == "conflict" ]] && artifacts='{"type":"ready","verdict":"pending","prNumber":1720,"mergeConflict":"CONFLICTED"}'
  write_ready_result "$state" "$(jq -r '.readyStatus' <<< "$row")" "$artifacts"

  if [[ -n "$remediation" ]]; then
    launch_head="$head"
    [[ "$(jq -r '.launch.head' <<< "$row")" == "other" ]] && launch_head="$OTHER_HEAD"
    if [[ "$remediation" == "conflict" ]]; then
      marker_write "$state/.conflict-remediation.json" --kind conflict-remediation --head "$launch_head" \
        --expires-on "head,remote,operator-event" \
        --detail-json "$(jq -cn --arg h "$launch_head" '{head:$h, base:"main", launchHead:$h, prNumber:1720}')"
      write_ownership_row "$state" conflict-resolution "$(jq -r '.launch.launchedAgoSec' <<< "$row")"
    else
      bounded_retry_increment "$state" "ready-remediation" "$launch_head" >/dev/null
      write_ownership_row "$state" ready-remediation "$(jq -r '.launch.launchedAgoSec' <<< "$row")"
    fi
  fi
  if [[ "$(jq -r '.agentRecord != null' <<< "$row")" == "true" ]]; then
    write_agent_hook "$issue" "$(jq -r '.agentRecord.state' <<< "$row")" \
      "$(jq -r '.agentRecord.event' <<< "$row")" "$(jq -r '.agentRecord.agoSec' <<< "$row")"
  fi

  actual="$(ready_remediation_disposition "$issue" "$state" "$wt" "$head")"
  check_eq "agreement: $name" "$actual" "$(jq -r '"\(.expected.kind) \(.expected.reason)"' <<< "$row")"
done

echo ""
echo "=== Incident replay: HOK-3316 remediation reran flaky CI without a commit ==="

# protects: HOK-3322 — the same-head running hold kept PR #1720 in Ready after
# the remediation agent settled; the monitor must hand the head back to Ready.
replay_case() {
  local label="$1" agent_state="$2" agent_event="$3" expected="$4" issue="$5"
  local dir="$TEST_TMP/replay-$issue" wt state head
  read -r wt state head < <(new_task "$dir" "$issue")
  # The record _launch_ready_remediation_attempt wrote: running, verdict fail.
  write_ready_result "$state" running "$(jq -cn --arg h "$head" \
    '{type:"ready", verdict:"fail", checksRun:28, checksPassed:27, mergeConflict:"MERGEABLE", prNumber:1720,
      remediationAttempts:1, remediationLaunchHead:$h, remediationFailures:["unit-tests"]}')"
  bounded_retry_increment "$state" "ready-remediation" "$head" >/dev/null
  write_ownership_row "$state" ready-remediation 1500
  write_agent_hook "$issue" "$agent_state" "$agent_event" 420
  check_eq "$label" "$(ready_remediation_disposition "$issue" "$state" "$wt" "$head")" "$expected"
  [[ ! -e "$state/.ready-tend-handoff.json" ]] || fail "$label: replay must start with no handoff"
}

replay_case "idle remediation agent at the launch head hands Ready back to the controller" \
  idle Stop "settled agent-idle-after-launch" RRD-3316
replay_case "live sibling: a working remediation agent still holds the head" \
  working PreToolUse "in-flight agent-working" RRD-3316L

echo ""
echo "=== Fail-safe and hot-pass pre-filters ==="

# protects: a broken probe relaunching work — the wrapper holds this tick instead.
dir="$TEST_TMP/failsafe"
read -r wt state head < <(new_task "$dir" "RRD-FS")
write_ready_result "$state" running '{"type":"ready","verdict":"fail"}'
bounded_retry_increment "$state" "ready-remediation" "$head" >/dev/null
check_eq "a failed CLI spawn holds (in-flight progress-unavailable)" \
  "$(_with_timeout() { return 1; }; ready_remediation_disposition "RRD-FS" "$state" "$wt" "$head")" \
  "in-flight progress-unavailable"

# protects: the monitor hot pass spawning tsx for every Ready task.
: > "$TEST_TMP/spawns"
wavemill_run_tool() { printf 'spawn\n' >> "$TEST_TMP/spawns"; }
dir="$TEST_TMP/prefilter"
read -r wt state head < <(new_task "$dir" "RRD-PF")
write_ready_result "$state" running '{"type":"ready","verdict":"pending"}'
check_eq "running Ready with nothing launched is inactive without a spawn" \
  "$(ready_remediation_disposition "RRD-PF" "$state" "$wt" "$head")" "inactive no-launch"
write_ready_result "$state" completed '{"type":"ready","verdict":"pass"}'
bounded_retry_increment "$state" "ready-remediation" "$head" >/dev/null
check_eq "completed Ready is inactive without a spawn" \
  "$(ready_remediation_disposition "RRD-PF" "$state" "$wt" "$head")" "inactive not-running"
check_eq "pre-filtered calls spawn nothing" "$(wc -l < "$TEST_TMP/spawns" | tr -d ' ')" "0"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
(( FAIL == 0 ))
