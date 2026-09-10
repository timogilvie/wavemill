#!/bin/bash
# Transient marker lifecycle helpers
# Provides write/clear/validate for head-SHA keyed markers

set -euo pipefail

# marker_write <path> --kind <kind> --head <sha> [--reason <msg>] [--detail-json <json>]
# Writes a versioned JSON marker at <path> keyed on the given head SHA
marker_write() {
  local path="$1"
  shift
  local kind=""
  local head=""
  local reason=""
  local detail_json=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --kind)
        kind="$2"
        shift 2
        ;;
      --head)
        head="$2"
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
      *)
        echo "marker_write: unknown argument $1" >&2
        return 1
        ;;
    esac
  done

  if [[ -z "$kind" || -z "$head" ]]; then
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
# Appends a JSONL finding line to .wavemill/observer-findings.jsonl
marker_emit_finding() {
  local path="$1"
  local reason="$2"
  local repo="$3"
  local task_id="${4:-}"

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
