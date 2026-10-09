#!/usr/bin/env bash
# HOK-3114 — bash twin of shared/lib/task-identity.ts (task identity invariant,
# HOK-3113). Pure bash plus jq for state reads; never spawns node/npx.
#
#   task_identity_parse <task_id>
#       Prints "<taskId>\t<linearId>\t<role>" (role: primary|challenger).
#       Returns 1 for anything that is not <ID>, <ID>_c or a linear.app URL.
#   task_identity_linear_id <task_id> [state_file]
#       Prints the Linear issue ID. A valid recorded .tasks[id].linearIssueId
#       wins; if it disagrees with the parsed base ID, prints nothing and
#       returns 2. Returns 1 for an invalid task ID (even with metadata).
#   task_identity_is_challenger <task_id>
#       Returns 0 iff the task ID is <ID>_c. Metadata is never consulted.
#   task_identity_challenger_id <task_id>
#       Prints the challenger task ID (<ID>_c) for a task ID. Idempotent on
#       challenger IDs. Returns 1 for an invalid task ID (fail closed, like the
#       TS challengerTaskId's throw).
#   task_identity_challenger_key <pair_id>
#       Prints the challenger state key for a recorded challenge pair ID. Equal
#       to task_identity_challenger_id for every valid pair ID; never fails and
#       never collapses, so opaque or drifted (<ID>_c) pair IDs get the suffix
#       appended verbatim (twin of TS challengerTaskKey). Use on read paths.
#   task_identity_is_linear_writer <task_id> [state_file]
#       Returns 0 iff the task is primary, its metadata does not record
#       challengeRole=challenger, and its Linear ID resolves without conflict.
#
# state_file defaults to $STATE_FILE; a missing/unreadable file means "no
# metadata". Both implementations are pinned by
# tests/fixtures/task-identity-cases.json — change them together.

# Guard against double-sourcing.
if [[ -n "${WAVEMILL_TASK_IDENTITY_SH_LOADED:-}" ]]; then
  return 0
fi
WAVEMILL_TASK_IDENTITY_SH_LOADED=1

# Matches ISSUE_ID_RE in task-identity.ts. Explicit letter lists keep the match
# ASCII-uppercase-only regardless of the regex engine's locale collation.
_TASK_IDENTITY_UPPER='ABCDEFGHIJKLMNOPQRSTUVWXYZ'
readonly TASK_IDENTITY_ISSUE_ID_RE="[${_TASK_IDENTITY_UPPER}][${_TASK_IDENTITY_UPPER}0123456789]*-[0123456789]+"
readonly TASK_IDENTITY_TASK_ID_RE="${TASK_IDENTITY_ISSUE_ID_RE}(_c)?"
readonly TASK_IDENTITY_WINDOW_PREFIX_RE="^(${TASK_IDENTITY_TASK_ID_RE})-(.+)$"
readonly TASK_IDENTITY_CHALLENGER_SUFFIX="_c"

# Normalize a Linear issue ID or linear.app issue URL to a bare ID.
_task_identity_normalize() {
  local value="$1"
  local id_re="^(${TASK_IDENTITY_ISSUE_ID_RE})$"
  local url_re="^https?://linear\\.app/[^/]+/issue/(${TASK_IDENTITY_ISSUE_ID_RE})([/?#].*)?$"
  if [[ "$value" =~ $id_re || "$value" =~ $url_re ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

# Print "<linearIssueId>\t<challengeRole>" for a task from the state file.
_task_identity_meta() {
  local task_id="$1" state_file="${2:-${STATE_FILE:-}}"
  [[ -n "$state_file" && -r "$state_file" ]] || { printf '\t\n'; return 0; }
  jq -r --arg id "$task_id" '
    (.tasks[$id] // {}) as $t
    | [ ($t.linearIssueId | if type == "string" then . else "" end),
        ($t.challengeRole | if type == "string" then . else "" end) ]
    | @tsv
  ' "$state_file" 2>/dev/null || printf '\t\n'
}

task_identity_parse() {
  local task_id="$1" linear_id
  local challenger_re="^(${TASK_IDENTITY_ISSUE_ID_RE})${TASK_IDENTITY_CHALLENGER_SUFFIX}$"
  if [[ "$task_id" =~ $challenger_re ]]; then
    printf '%s\t%s\t%s\n' "$task_id" "${BASH_REMATCH[1]}" "challenger"
    return 0
  fi
  linear_id="$(_task_identity_normalize "$task_id")" || return 1
  printf '%s\t%s\t%s\n' "$linear_id" "$linear_id" "primary"
}

task_identity_linear_id() {
  local task_id="$1" state_file="${2:-${STATE_FILE:-}}"
  local parsed parsed_linear meta recorded recorded_id=""
  parsed="$(task_identity_parse "$task_id")" || return 1
  IFS=$'\t' read -r _ parsed_linear _ <<< "$parsed"

  meta="$(_task_identity_meta "$task_id" "$state_file")"
  recorded="${meta%%$'\t'*}"
  recorded="${recorded#"${recorded%%[![:space:]]*}"}"
  recorded="${recorded%"${recorded##*[![:space:]]}"}"
  recorded_id="$(_task_identity_normalize "$recorded")" || recorded_id=""

  if [[ -n "$recorded_id" && "$recorded_id" != "$parsed_linear" ]]; then
    printf 'task_identity: task %s records linearIssueId %s but its ID resolves to %s\n' \
      "$task_id" "$recorded_id" "$parsed_linear" >&2
    return 2
  fi
  printf '%s\n' "${recorded_id:-$parsed_linear}"
}

task_identity_is_challenger() {
  local parsed role
  parsed="$(task_identity_parse "$1")" || return 1
  IFS=$'\t' read -r _ _ role <<< "$parsed"
  [[ "$role" == "challenger" ]]
}

task_identity_challenger_id() {
  local parsed linear_id
  parsed="$(task_identity_parse "$1")" || return 1
  IFS=$'\t' read -r _ linear_id _ <<< "$parsed"
  printf '%s%s\n' "$linear_id" "$TASK_IDENTITY_CHALLENGER_SUFFIX"
}

task_identity_challenger_key() {
  printf '%s%s\n' "$1" "$TASK_IDENTITY_CHALLENGER_SUFFIX"
}

task_identity_is_linear_writer() {
  local task_id="$1" state_file="${2:-${STATE_FILE:-}}"
  local parsed role meta
  parsed="$(task_identity_parse "$task_id")" || return 1
  IFS=$'\t' read -r _ _ role <<< "$parsed"
  [[ "$role" == "primary" ]] || return 1
  meta="$(_task_identity_meta "$task_id" "$state_file")"
  [[ "${meta#*$'\t'}" != "challenger" ]] || return 1
  task_identity_linear_id "$task_id" "$state_file" >/dev/null 2>&1
}
