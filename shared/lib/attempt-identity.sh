#!/usr/bin/env bash
# HOK-3373 — bash twin of shared/lib/attempt-identity.ts (the one run
# identity of a task row) plus the settled-run reads every shell decision
# site uses instead of private status/phase checks or the retired in-memory
# CLEANED set. Pure bash + jq; never spawns node.
#
#   attempt_identity_mint_run_id <issue> <run_epoch> <launched_at_epoch>
#       Prints "<issue>:<run_epoch>:<launched_at_epoch>" (byte-identical to
#       TS mintRunId; pinned by tests/attempt-identity.test.sh).
#   task_run_id <issue> [state_file]
#       Prints the row's runId (empty for legacy rows / missing rows).
#   task_settled_outcome <issue> [state_file]
#       Prints merged|closed|aborted and returns 0 when the row's run has
#       settled (lifecycle.workflowOutcome); prints nothing, returns 1 else.
#       Mirrors TS task-settlement.ts settledOutcome().
#   task_last_run_delivered <issue> [state_file]
#       Returns 0 when the issue's most recent run delivered its work: its
#       active row settled `merged`, or (no row) its terminal history /
#       tombstone records workflowOutcome `merged`. A delivered issue is never
#       offered or relaunched; Linear renders it Done.
#   delivered_issue_ids [state_file]
#       Prints, one per line, every issue whose most recent run delivered
#       (task_last_run_delivered for all keys at once: one jq pass). The
#       picker excludes these; it replaces the monitor's in-memory CLEANED set,
#       so visibility survives restarts and an aborted run is never hidden.
#   settled_task_ids [state_file]
#       Prints, one per line, every row key whose run has settled (one jq
#       pass). The picker excludes these from the in-flight touch-set payload.
#   linear_state_for_task <issue> [state_file]
#       Prints the Linear state the row's settled outcome renders to (twin of
#       TS linear-state-renderer.ts renderLinearState), or nothing when the
#       row does not decide Linear by itself.
#
# state_file defaults to $STATE_FILE.

if [[ -n "${WAVEMILL_ATTEMPT_IDENTITY_SH_LOADED:-}" ]]; then
  return 0
fi
WAVEMILL_ATTEMPT_IDENTITY_SH_LOADED=1

attempt_identity_mint_run_id() {
  local issue="${1:-}" run_epoch="${2:-}" launched_at="${3:-}"
  [[ -n "$issue" ]] || return 1
  [[ "$launched_at" =~ ^[0-9]+$ ]] || launched_at="$(date +%s)"
  printf '%s:%s:%s\n' "$issue" "$run_epoch" "$launched_at"
}

task_run_id() {
  local issue="${1:-}" state_file="${2:-${STATE_FILE:-}}"
  [[ -n "$issue" && -n "$state_file" && -f "$state_file" ]] || return 0
  jq -r --arg i "$issue" '.tasks[$i].runId // empty' "$state_file" 2>/dev/null || true
}

task_settled_outcome() {
  local issue="${1:-}" state_file="${2:-${STATE_FILE:-}}" outcome
  [[ -n "$issue" && -n "$state_file" && -f "$state_file" ]] || return 1
  outcome="$(jq -r --arg i "$issue" '
    (.tasks[$i].lifecycle.workflowOutcome // "") as $o
    | if ($o | IN("merged","closed","aborted")) then $o else empty end' "$state_file" 2>/dev/null || true)"
  [[ -n "$outcome" ]] || return 1
  printf '%s\n' "$outcome"
}

task_last_run_delivered() {
  local issue="${1:-}" state_file="${2:-${STATE_FILE:-}}"
  [[ -n "$issue" ]] || return 1
  delivered_issue_ids "$state_file" | grep -Fxq -- "$issue"
}

# One jq pass over rows, terminal history and tombstones. A merged arm also
# delivers its challenge pair's issue (the pair id is the primary's key), so a
# merged challenger keeps the shared issue delivered too. An issue with a live
# row is judged by that row alone: a new run that has not settled is not
# "delivered" just because an older run was.
delivered_issue_ids() {
  local state_file="${1:-${STATE_FILE:-}}"
  [[ -n "$state_file" && -f "$state_file" ]] || return 0
  jq -r '
    def delivered_keys: [.key] + [(.value.challengePairId // empty) | select(type == "string" and length > 0)];
    (.tasks // {}) as $tasks
    | ([$tasks | to_entries[] | select((.value | type) == "object") | .key]) as $rows
    | ([$tasks | to_entries[]
          | select((.value | type) == "object"
                   and ((.value.lifecycle.workflowOutcome // "") | IN("merged","closed","aborted") | not))
          | .key]) as $openRows
    | ( [$tasks | to_entries[]
          | select((.value | type) == "object" and (.value.lifecycle.workflowOutcome // "") == "merged")
          | delivered_keys[]]
        + [(.terminalTaskHistory.tasks // {}) | to_entries[]
            | select((.value | type) == "object" and (.value.workflowOutcome // "") == "merged")
            | select(.key as $k | $rows | index($k) | not)
            | delivered_keys[]]
        + [(.terminalTaskTombstones // {}) | to_entries[] | .value
            | select(type == "object" and (.workflowOutcome // "") == "merged" and ((.issue // "") != ""))
            | select(.issue as $k | $rows | index($k) | not)
            | {key: .issue, value: .} | delivered_keys[]] )
    | unique[]
    | select(. as $k | $openRows | index($k) | not)' "$state_file" 2>/dev/null || true
}

settled_task_ids() {
  local state_file="${1:-${STATE_FILE:-}}"
  [[ -n "$state_file" && -f "$state_file" ]] || return 0
  jq -r '(.tasks // {}) | to_entries[]
    | select((.value | type) == "object"
             and ((.value.lifecycle.workflowOutcome // "") | IN("merged","closed","aborted")))
    | .key' "$state_file" 2>/dev/null || true
}

linear_state_for_task() {
  local issue="${1:-}" state_file="${2:-${STATE_FILE:-}}"
  [[ -n "$issue" && -n "$state_file" && -f "$state_file" ]] || return 0
  if declare -F task_identity_is_challenger >/dev/null 2>&1 && task_identity_is_challenger "$issue"; then
    return 0
  fi
  jq -r --arg i "$issue" '
    (.tasks[$i] // {}) as $t
    | ($t.lifecycle.workflowOutcome // "") as $o
    | if ($t.challengeRole // "") == "challenger" then empty
      elif $o == "merged" then "Done"
      elif $o == "closed" and ($t.status // "") == "completed-external" then "Done"
      else empty end' "$state_file" 2>/dev/null || true
}
