#!/bin/bash
# Transient marker lifecycle helpers
# Provides write/clear/validate for head-SHA keyed markers

set -euo pipefail

# marker_write <path> --kind <kind> --head <sha> [--reason <msg>] [--detail-json <json>]
#              [--state-dir <dir>] [--expires-on <csv>] [--review-artifact] [--ready-artifact]
#              [--observed k=v] [--waiting-on kind=value[@pr]] [--recheck-after-seconds <N>]
# Writes a versioned JSON marker at <path> keyed on the given head SHA.
# Condition flags build .condition via marker_condition_json.
# --state-dir defaults to dirname(path).
marker_write() {
  local path="$1"
  shift
  local kind=""
  local head=""
  local reason=""
  local detail_json=""
  local -a condition_flags=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --kind)
        kind="$2"
        shift 2
        ;;
      --head)
        head="$2"
        condition_flags+=(--head "$head")
        shift 2
        ;;
      --reason)
        reason="$2"
        shift 2
        ;;
      --detail-json)
        detail_json="$2"
        shift 2
        ;;
      --state-dir|--expires-on|--observed|--waiting-on|--recheck-after-seconds)
        condition_flags+=("$1" "$2")
        shift 2
        ;;
      --review-artifact|--ready-artifact)
        condition_flags+=("$1")
        shift
        ;;
      *)
        echo "marker_write: unknown argument $1" >&2
        return 1
        ;;
    esac
  done

  # --head is required unless the marker carries an explicit condition: a
  # head-less condition (e.g. a terminal retry sentinel that only an operator
  # event may clear) must not be forced to record a placeholder head, which
  # the reconciler would read as "head moved" and clear on the next tick.
  if [[ -z "$kind" ]] || { [[ -z "$head" ]] && (( ${#condition_flags[@]} == 0 )); }; then
    echo "marker_write: --kind and --head are required" >&2
    return 1
  fi

  # Create directory
  mkdir -p "$(dirname "$path")"

  # Build JSON payload
  local now_iso=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  local payload=$(
    jq -n \
      --arg schemaVersion "1" \
      --arg kind "$kind" \
      --arg headSha "$head" \
      --arg writtenAt "$now_iso" \
      --arg reason "$reason" \
      '{schemaVersion: 1, kind: $kind, headSha: $headSha, writtenAt: $writtenAt}
       | if $reason != "" then .reason = $reason else . end'
  )

  # Add detail if provided
  if [[ -n "$detail_json" ]]; then
    payload=$(jq --argjson detail "$detail_json" '. + {detail: $detail}' <<< "$payload")
  fi

  # Build and add condition if flags provided
  if [[ ${#condition_flags[@]} -gt 0 ]]; then
    # Default --state-dir to dirname(path) if not given
    local has_state_dir=false
    for flag in "${condition_flags[@]}"; do
      if [[ "$flag" == "--state-dir" ]]; then
        has_state_dir=true
        break
      fi
    done

    if [[ "$has_state_dir" == "false" ]]; then
      condition_flags+=(--state-dir "$(dirname "$path")")
    fi

    # Default --expires-on if not given
    local has_expires_on=false
    for flag in "${condition_flags[@]}"; do
      if [[ "$flag" == "--expires-on" ]]; then
        has_expires_on=true
        break
      fi
    done

    if [[ "$has_expires_on" == "false" ]]; then
      condition_flags+=(--expires-on "head,operator-event")
    fi

    local condition_json=$(marker_condition_json "${condition_flags[@]}")
    payload=$(jq --argjson condition "$condition_json" '.condition = $condition' <<< "$payload")
  fi

  # Atomic write: tmp file + rename
  local tmp_path="${path}.tmp.$$.$RANDOM"
  jq '.' <<< "$payload" > "$tmp_path"
  mv "$tmp_path" "$path"
}

# marker_clear <path>
# Removes the marker file
marker_clear() {
  local path="$1"
  rm -f "$path"
}

# marker_read <path>
# Reads and outputs JSON payload, or empty string if absent/legacy
marker_read() {
  local path="$1"

  if [[ ! -f "$path" ]]; then
    return 0
  fi

  local body
  body=$(cat "$path" 2>/dev/null || true)

  if [[ -z "$body" ]]; then
    return 0
  fi

  # Try to parse as JSON with schemaVersion: 1
  if jq -e '.schemaVersion == 1' <<< "$body" 2>/dev/null >/dev/null; then
    jq '.' <<< "$body"
  else
    # Legacy format - return empty
    return 0
  fi
}

# marker_head <path>
# Prints headSha from marker, or empty string if absent/legacy
marker_head() {
  local path="$1"
  marker_read "$path" | jq -r '.headSha // empty' 2>/dev/null || true
}

# marker_reason <path>
# Prints marker reason for JSON markers, or first line for legacy markers.
marker_reason() {
  local path="$1"

  [[ -f "$path" ]] || return 0

  local body
  body=$(cat "$path" 2>/dev/null || true)
  [[ -n "$body" ]] || return 0

  if jq -e '.schemaVersion == 1' <<< "$body" 2>/dev/null >/dev/null; then
    jq -r '.reason // empty' <<< "$body" 2>/dev/null || true
    return 0
  fi

  printf '%s\n' "$body" | head -1 | tr -d '\r'
}

# marker_is_stale <path> <current_head>
# Exit 0: stale (SHA mismatch or absent), 1: valid, 2: legacy/unable to read
marker_is_stale() {
  local path="$1"
  local current_head="$2"

  if [[ ! -f "$path" ]]; then
    return 0  # absent counts as stale
  fi

  local body
  body=$(cat "$path" 2>/dev/null || true)

  if [[ -z "$body" ]]; then
    return 0  # absent
  fi

  # Check if it's JSON with schemaVersion
  if ! jq -e '.schemaVersion == 1' <<< "$body" 2>/dev/null >/dev/null; then
    return 2  # legacy
  fi

  # Check if SHA matches
  local marker_sha
  marker_sha=$(jq -r '.headSha' <<< "$body" 2>/dev/null || true)

  if [[ "$marker_sha" != "$current_head" ]]; then
    return 0  # stale - SHA mismatch
  fi

  return 1  # valid - SHA matches
}

# marker_validate <path> <current_head> <condition_cmd>
# Runs condition command; exits:
#   0: valid (SHA matches and condition succeeds)
#   1: stale-sha (SHA mismatch)
#   2: contradicted (SHA matches but condition fails)
#   3: absent
marker_validate() {
  local path="$1"
  local current_head="$2"
  local condition_cmd="$3"

  if [[ ! -f "$path" ]]; then
    return 3  # absent
  fi

  local body
  body=$(cat "$path" 2>/dev/null || true)

  if [[ -z "$body" ]]; then
    return 3  # absent
  fi

  # Check if it's JSON with schemaVersion
  if ! jq -e '.schemaVersion == 1' <<< "$body" 2>/dev/null >/dev/null; then
    return 3  # legacy counts as absent
  fi

  # Check SHA
  local marker_sha
  marker_sha=$(jq -r '.headSha' <<< "$body" 2>/dev/null || true)

  if [[ "$marker_sha" != "$current_head" ]]; then
    return 1  # stale-sha
  fi

  # Run condition command in a subshell to prevent exit
  if (eval "$condition_cmd"); then
    return 0  # valid
  else
    return 2  # contradicted
  fi
}

# marker_emit_finding <path> <reason> <repo> [task_id]
# Appends a JSONL finding line to .wavemill/observer-findings.jsonl.
# HOK-3102 (D7): gated on `wavemill_session_has observer` when the shared
# helper is loaded. If the helper isn't sourced (`declare -F` guard fails),
# this is fail-closed — nothing is written.
marker_emit_finding() {
  local path="$1"
  local reason="$2"
  local repo="$3"
  local task_id="${4:-}"

  # HOK-3102: only observers read this file. With the observer off, or with
  # the resolver unavailable in this process, drop silently.
  if ! declare -F wavemill_session_has >/dev/null 2>&1; then
    return 0
  fi
  if ! wavemill_session_has observer "${REPO_DIR:-$PWD}" 2>/dev/null; then
    return 0
  fi

  local marker_body
  marker_body=$(marker_read "$path" 2>/dev/null || true)

  if [[ -z "$marker_body" ]]; then
    return 0  # No valid marker, nothing to emit
  fi

  local kind
  kind=$(jq -r '.kind // empty' <<< "$marker_body" 2>/dev/null || true)

  if [[ -z "$kind" ]]; then
    return 0  # No kind, can't emit
  fi

  # Build finding JSONL. Prefer the controller repository's state location
  # (HOK-2972) so the artifact never lands inside - and never dirties - a
  # task worktree; standalone callers without REPO_DIR keep the cwd path.
  local findings_root="."
  if [[ -n "${REPO_DIR:-}" && -d "${REPO_DIR:-}" ]]; then
    findings_root="$REPO_DIR"
  fi
  local findings_file="$findings_root/.wavemill/observer-findings.jsonl"
  mkdir -p "$findings_root/.wavemill"

  local context_json
  if [[ -n "$task_id" ]]; then
    context_json=$(jq -n --arg markerPath "$path" --arg markerKind "$kind" --arg repo "$repo" --arg taskId "$task_id" \
      '{markerPath: $markerPath, markerKind: $markerKind, repo: $repo, taskId: $taskId}')
  else
    context_json=$(jq -n --arg markerPath "$path" --arg markerKind "$kind" --arg repo "$repo" \
      '{markerPath: $markerPath, markerKind: $markerKind, repo: $repo}')
  fi

  local finding=$(jq -n \
    --arg subsystem "marker-lifecycle" \
    --arg title "Stale marker: $kind" \
    --arg body "Marker at $path was written for condition '$reason' but may no longer be valid" \
    --arg severity "warning" \
    --argjson context "$context_json" \
    '{subsystem: $subsystem, title: $title, body: $body, severity: $severity, context: $context}')

  echo "$finding" >> "$findings_file"
}

# marker_artifact_identity <state_dir> <stage>
# Prints compact JSON identity from .<stage>-result.json, or null if absent.
# Shape: {stage, status, startedAt, finishedAt, verdict, failureCategory}
# verdict and failureCategory come from artifacts (review) or artifacts.review (ready)
marker_artifact_identity() {
  local state_dir="$1"
  local stage="$2"
  local result_file="$state_dir/.$stage-result.json"

  if [[ ! -f "$result_file" ]]; then
    echo "null"
    return 0
  fi

  local body
  body=$(cat "$result_file" 2>/dev/null || true)
  if [[ -z "$body" ]]; then
    echo "null"
    return 0
  fi

  # Extract identity fields
  jq '{
    stage: .stage,
    status: .status,
    startedAt: .startedAt,
    finishedAt: .finishedAt,
    verdict: (if .stage == "review" then .artifacts.verdict else .artifacts.review.verdict end),
    failureCategory: (if .stage == "review" then .artifacts.failureCategory else .artifacts.review.failureCategory end)
  }' <<< "$body" 2>/dev/null || echo "null"
}

# operator_event_record <state_dir> <command> <issue> [detail]
# Appends {seq, command, issue, at, head, detail} to .operator-events.jsonl
# seq is line count + 1 (append-only, lock-free)
operator_event_record() {
  local state_dir="$1"
  local command="$2"
  local issue="$3"
  local detail="${4:-}"

  mkdir -p "$state_dir"
  local events_file="$state_dir/.operator-events.jsonl"

  # Get current max seq (line count)
  local current_seq=0
  if [[ -f "$events_file" ]]; then
    current_seq=$(wc -l < "$events_file" 2>/dev/null | tr -d ' ' || echo 0)
  fi
  local seq=$((current_seq + 1))

  local now_iso=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  local head=$(git rev-parse HEAD 2>/dev/null || echo "")

  # One compact object per line: operator_event_seq counts lines and
  # operator_event_latest_since parses line by line.
  local event=$(jq -cn \
    --argjson seq "$seq" \
    --arg command "$command" \
    --arg issue "$issue" \
    --arg at "$now_iso" \
    --arg head "$head" \
    --arg detail "$detail" \
    '{seq: $seq, command: $command, issue: $issue, at: $at, head: $head}
     | if $detail != "" then .detail = $detail else . end')

  # Append (lock-free, per CLAUDE.md JSONL rules)
  echo "$event" >> "$events_file"
}

# operator_event_seq <state_dir>
# Returns current max seq (line count), or 0 if file absent
operator_event_seq() {
  local state_dir="$1"
  local events_file="$state_dir/.operator-events.jsonl"

  if [[ ! -f "$events_file" ]]; then
    echo 0
    return 0
  fi

  local count
  count=$(wc -l < "$events_file" 2>/dev/null | tr -d ' ' || true)
  echo "${count:-0}"
}

# operator_event_latest_since <state_dir> <seq> [commands-csv]
# Prints latest applicable event JSON after <seq>, or nothing
operator_event_latest_since() {
  local state_dir="$1"
  local since_seq="$2"
  local commands_csv="${3:-}"
  local events_file="$state_dir/.operator-events.jsonl"

  if [[ ! -f "$events_file" ]]; then
    return 0
  fi

  # Read events after since_seq, filter by commands if given
  local latest=""
  while IFS= read -r line; do
    local event_seq=$(jq -r '.seq // 0' <<< "$line" 2>/dev/null || echo 0)
    if [[ $event_seq -le $since_seq ]]; then
      continue
    fi

    if [[ -n "$commands_csv" ]]; then
      local event_cmd=$(jq -r '.command // empty' <<< "$line" 2>/dev/null || true)
      if [[ -z "$event_cmd" ]]; then
        continue
      fi

      # Check if event_cmd is in CSV list
      local found=false
      IFS=',' read -ra commands <<< "$commands_csv"
      for cmd in "${commands[@]}"; do
        if [[ "$event_cmd" == "$cmd" ]]; then
          found=true
          break
        fi
      done

      if [[ "$found" == "false" ]]; then
        continue
      fi
    fi

    latest="$line"
  done < "$events_file"

  if [[ -n "$latest" ]]; then
    echo "$latest"
  fi
}

# marker_condition_json [flags]
# Builds condition JSON object for marker expiry.
# Flags:
#   --head <sha>
#   --state-dir <dir> (auto-captures operatorEventSeq)
#   --expires-on <csv> (e.g. "head,operator-event,review-artifact")
#   --review-artifact
#   --ready-artifact
#   --observed k=v (repeatable)
#   --waiting-on kind=value[@pr]
#   --recheck-after-seconds <N>
marker_condition_json() {
  local head=""
  local state_dir=""
  local expires_on=""
  local review_artifact=false
  local ready_artifact=false
  local -a observed=()
  local waiting_on=""
  local recheck_after_seconds=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --head)
        head="$2"
        shift 2
        ;;
      --state-dir)
        state_dir="$2"
        shift 2
        ;;
      --expires-on)
        expires_on="$2"
        shift 2
        ;;
      --review-artifact)
        review_artifact=true
        shift
        ;;
      --ready-artifact)
        ready_artifact=true
        shift
        ;;
      --observed)
        observed+=("$2")
        shift 2
        ;;
      --waiting-on)
        waiting_on="$2"
        shift 2
        ;;
      --recheck-after-seconds)
        recheck_after_seconds="$2"
        shift 2
        ;;
      *)
        echo "marker_condition_json: unknown argument $1" >&2
        return 1
        ;;
    esac
  done

  # Build condition object
  local condition=$(jq -n '{}')

  # Add head
  if [[ -n "$head" ]]; then
    condition=$(jq --arg head "$head" '.head = $head' <<< "$condition")
  fi

  # Add expiresOn
  if [[ -n "$expires_on" ]]; then
    IFS=',' read -ra triggers <<< "$expires_on"
    local triggers_json=$(printf '%s\n' "${triggers[@]}" | jq -R '.' | jq -s '.')
    condition=$(jq --argjson triggers "$triggers_json" '.expiresOn = $triggers' <<< "$condition")
  fi

  # Add operatorEventSeq from state_dir
  if [[ -n "$state_dir" ]]; then
    local seq=$(operator_event_seq "$state_dir")
    condition=$(jq --argjson seq "$seq" '.operatorEventSeq = $seq' <<< "$condition")
  fi

  # Add review artifact identity
  if [[ "$review_artifact" == "true" && -n "$state_dir" ]]; then
    local review_id=$(marker_artifact_identity "$state_dir" "review")
    condition=$(jq --argjson review "$review_id" '.reviewArtifact = $review' <<< "$condition")
  fi

  # Add ready artifact identity
  if [[ "$ready_artifact" == "true" && -n "$state_dir" ]]; then
    local ready_id=$(marker_artifact_identity "$state_dir" "ready")
    condition=$(jq --argjson ready "$ready_id" '.readyArtifact = $ready' <<< "$condition")
  fi

  # Add observed values
  if [[ ${#observed[@]} -gt 0 ]]; then
    local observed_obj=$(jq -n '{}')
    for kv in "${observed[@]}"; do
      local key="${kv%%=*}"
      local value="${kv#*=}"
      observed_obj=$(jq --arg k "$key" --arg v "$value" '.[$k] = $v' <<< "$observed_obj")
    done
    condition=$(jq --argjson obs "$observed_obj" '.observed = $obs' <<< "$condition")
  fi

  # Add waiting-on
  if [[ -n "$waiting_on" ]]; then
    # Parse kind=value[@pr]
    local kind_value="${waiting_on%%@*}"
    local kind="${kind_value%%=*}"
    local value="${kind_value#*=}"
    local waiting_obj=$(jq -n --arg kind "$kind" --arg value "$value" '{kind: $kind, value: $value}')

    # Add prNumber if present
    if [[ "$waiting_on" == *@* ]]; then
      local pr="${waiting_on##*@}"
      waiting_obj=$(jq --argjson pr "$pr" '.prNumber = $pr' <<< "$waiting_obj")
    fi

    condition=$(jq --argjson waiting "$waiting_obj" '.waitingOn = $waiting' <<< "$condition")
  fi

  # Add recheckAfter
  if [[ -n "$recheck_after_seconds" ]]; then
    local recheck_at=$(date -u -v+"${recheck_after_seconds}S" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || \
                       date -u -d "+${recheck_after_seconds} seconds" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || \
                       echo "")
    if [[ -n "$recheck_at" ]]; then
      condition=$(jq --arg recheckAfter "$recheck_at" '.recheckAfter = $recheckAfter' <<< "$condition")
    fi
  fi

  echo "$condition"
}

# marker_condition <path>
# Prints .condition from marker, or empty if absent
marker_condition() {
  local path="$1"
  marker_read "$path" | jq -r '.condition // empty' 2>/dev/null || true
}

# marker_written_at <path>
# Prints .writtenAt from marker, or empty if absent
marker_written_at() {
  local path="$1"
  marker_read "$path" | jq -r '.writtenAt // empty' 2>/dev/null || true
}
