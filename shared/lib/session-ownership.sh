#!/usr/bin/env bash
# HOK-3328 — bash twin of shared/lib/session-ownership.ts (the session
# ownership record). Shell launchers record every harness session they start
# in <state_dir>/.session-ownership.jsonl before the child runs; cost, stage
# labels and the executed model read only that record.
#
#   session_ownership_new_ref
#       Prints a fresh lowercase UUID (a Claude Code --session-id / Codex nonce).
#   session_ownership_kind_for_launch <launch_phase>
#       Prints the launch kind: $WAVEMILL_SESSION_KIND when set (remediation
#       launchers set it), else the normalized phase (planning|coding|review).
#   session_ownership_append <state_dir> <session_ref> <harness> <kind> <model> [attempt_id] [cwd]
#       Appends one launch row. The stage is derived from the kind exactly like
#       stageForKind() in the TS module. Fails (rc 1) on an invalid row; never
#       fails a launch on its own — launch sites call it with `|| true`.
#   session_ownership_launch_snippet <state_dir> <harness> <kind> <model>
#       Prints bash for a generated launcher script: it mints the session ref at
#       *run* time (so a relaunch never reuses a Claude --session-id), appends
#       the row, and leaves the ref in $WM_SESSION_REF. For codex the ref is
#       pending:<nonce> and $WM_LAUNCH_NONCE_LINE must prefix the prompt.
#
# Row format is pinned against the TS reader by
# shared/lib/session-ownership.test.ts (shell twin cases).

if [[ -n "${WAVEMILL_SESSION_OWNERSHIP_SH_LOADED:-}" ]]; then
  return 0
fi
WAVEMILL_SESSION_OWNERSHIP_SH_LOADED=1

SESSION_OWNERSHIP_FILE=".session-ownership.jsonl"
SESSION_OWNERSHIP_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/session-ownership.sh"

session_ownership_new_ref() {
  local ref=""
  if command -v uuidgen >/dev/null 2>&1; then
    ref="$(uuidgen 2>/dev/null)"
  elif [[ -r /proc/sys/kernel/random/uuid ]]; then
    ref="$(cat /proc/sys/kernel/random/uuid)"
  fi
  if [[ -z "$ref" ]]; then
    local hex
    hex="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    ref="${hex:0:8}-${hex:8:4}-4${hex:13:3}-a${hex:17:3}-${hex:20:12}"
  fi
  printf '%s\n' "$ref" | tr 'A-Z' 'a-z'
}

_session_ownership_valid_kind() {
  case "${1:-}" in
    planning|coding|review|ready-remediation|conflict-resolution|ci-fix|native-arm) return 0 ;;
  esac
  [[ "${1:-}" =~ ^helper:[a-z0-9][a-z0-9._-]{0,63}$ ]]
}

_session_ownership_stage_for_kind() {
  case "${1:-}" in
    planning|coding|review) printf '%s\n' "$1" ;;
    *) printf '\n' ;;
  esac
}

session_ownership_kind_for_launch() {
  local phase="${1:-}"
  if [[ -n "${WAVEMILL_SESSION_KIND:-}" ]] && _session_ownership_valid_kind "$WAVEMILL_SESSION_KIND"; then
    printf '%s\n' "$WAVEMILL_SESSION_KIND"
    return 0
  fi
  case "$phase" in
    planning|coding|review) printf '%s\n' "$phase" ;;
    *) printf 'coding\n' ;;
  esac
}

# <kind>@<head7>#<epoch-seconds> — the format buildAttemptId() writes.
_session_ownership_attempt_id() {
  local kind="$1" cwd="${2:-}" epoch="$3" head=""
  if [[ -n "$cwd" ]]; then
    head="$(git -C "$cwd" rev-parse HEAD 2>/dev/null || true)"
  fi
  if [[ "$head" =~ ^[0-9a-fA-F]{7,}$ ]]; then
    head="$(printf '%s' "${head:0:7}" | tr 'A-F' 'a-f')"
  else
    head="nohead"
  fi
  printf '%s@%s#%s\n' "$kind" "$head" "$epoch"
}

session_ownership_append() {
  local state_dir="${1:-}" session_ref="${2:-}" harness="${3:-}" kind="${4:-}" model="${5:-}"
  local attempt_id="${6:-}" cwd="${7:-}"
  [[ -n "$state_dir" && -n "$session_ref" ]] || return 1
  case "$harness" in claude-code|codex|native) ;; *) return 1 ;; esac
  _session_ownership_valid_kind "$kind" || return 1
  command -v jq >/dev/null 2>&1 || return 1

  local epoch launched_at stage line
  epoch="$(date -u +%s)"
  launched_at="$(date -u -r "$epoch" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
    || date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null)"
  [[ -n "$launched_at" ]] || return 1
  [[ -n "$attempt_id" ]] || attempt_id="$(_session_ownership_attempt_id "$kind" "$cwd" "$epoch")"
  stage="$(_session_ownership_stage_for_kind "$kind")"

  line="$(jq -nc \
    --arg sessionRef "$session_ref" --arg harness "$harness" --arg kind "$kind" \
    --arg stage "$stage" --arg model "$model" --arg launchedAt "$launched_at" \
    --arg attemptId "$attempt_id" --arg cwd "$cwd" \
    '{schemaVersion: 1, type: "launch", sessionRef: $sessionRef, harness: $harness, kind: $kind}
     + (if $stage == "" then {} else {stage: $stage} end)
     + {model: $model, launchedAt: $launchedAt, attemptId: $attemptId}
     + (if $cwd == "" then {} else {cwd: $cwd} end)')" || return 1

  mkdir -p "$state_dir" 2>/dev/null || return 1
  # A single short append: concurrent launchers never interleave lines.
  printf '%s\n' "$line" >> "$state_dir/$SESSION_OWNERSHIP_FILE"
}

session_ownership_launch_snippet() {
  local state_dir="${1:-}" harness="${2:-}" kind="${3:-}" model="${4:-}"
  local q_lib q_dir q_kind q_model q_harness
  printf -v q_lib '%q' "$SESSION_OWNERSHIP_LIB"
  printf -v q_dir '%q' "$state_dir"
  printf -v q_kind '%q' "$kind"
  printf -v q_model '%q' "$model"
  printf -v q_harness '%q' "$harness"
  cat <<SNIPPET
# HOK-3328: record this session before the harness starts.
source $q_lib
WM_SESSION_REF="\$(session_ownership_new_ref)"
WM_LAUNCH_NONCE_LINE=""
if [[ $q_harness == codex ]]; then
  WM_LAUNCH_NONCE_LINE="<!-- wavemill-launch-nonce: \$WM_SESSION_REF -->"
  WM_SESSION_REF="pending:\$WM_SESSION_REF"
fi
if [[ -n $q_dir ]]; then
  session_ownership_append $q_dir "\$WM_SESSION_REF" $q_harness $q_kind $q_model "" "\$PWD" \\
    || echo "[wavemill] warning: session ownership row not recorded" >&2
fi
SNIPPET
}
