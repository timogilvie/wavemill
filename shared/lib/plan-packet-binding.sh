#!/usr/bin/env bash
# Plan-to-packet binding helpers (HOK-3099).
#
# When an expanded task packet is regenerated at the plan->code handoff (e.g.
# by recover_missing_expansion_artifact), the approved plan.md is written from
# the pre-expansion description and contradicts the new packet. The coder
# follows the plan; the reviewer grades against the packet; the review loop
# cannot converge (see HOK-2820, PR #94).
#
# This module records the packet bytes each plan was approved against and
# gates the plan->code handoff on that binding. A packet regenerated between
# approval and coding launch invalidates the plan; the stale plan is preserved
# for diagnosis and planning is relaunched through the bounded-retry gate.
#
# Storage per feature dir:
#   .plan-packet-hash   JSON: {"packetHash", "packetKind", "planHash",
#                              "recordedAt", "source"} — source is "approval"
#                       or "recovery". Absent = legacy plan (not yet bound).
#   plan.stale-<epoch>.md   preserved copies of superseded plans.

# Returns 0 iff a sha-256 implementation is available on PATH.
plan_packet_hash_available() {
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1
}

# Hash bytes on stdin; prints the hex digest.
_plan_packet_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

# Hash the task packet in a feature dir. Concatenates every packet file that
# exists in a fixed order (header, details, single) so a regeneration that
# only writes one shape still shifts the hash. Prints "<hash>\t<kind>" where
# kind describes which files contributed ("split", "single", or "mixed").
# Returns 1 when no packet is available or when hashing tools are missing.
plan_packet_current_hash() {
  local feature_dir="$1"
  local header="$feature_dir/task-packet-header.md"
  local details="$feature_dir/task-packet-details.md"
  local single="$feature_dir/task-packet.md"
  local -a files=()
  local has_split=0 has_single=0 hash="" kind=""

  plan_packet_hash_available || return 1

  if [[ -f "$header" && -f "$details" ]]; then
    files+=("$header" "$details")
    has_split=1
  fi
  if [[ -f "$single" ]]; then
    files+=("$single")
    has_single=1
  fi

  (( ${#files[@]} > 0 )) || return 1

  hash="$(cat "${files[@]}" 2>/dev/null | _plan_packet_sha256)"
  [[ -n "$hash" && "$hash" != *[!0-9a-f]* ]] || return 1

  if (( has_split && has_single )); then
    kind="mixed"
  elif (( has_split )); then
    kind="split"
  else
    kind="single"
  fi
  printf '%s\t%s\n' "$hash" "$kind"
  return 0
}

# Hash plan.md (empty when missing or hashing is unavailable).
plan_packet_plan_hash() {
  local feature_dir="$1"
  local plan="$feature_dir/plan.md"

  plan_packet_hash_available || { echo ""; return 0; }
  [[ -f "$plan" ]] || { echo ""; return 0; }
  local hash
  hash="$(cat "$plan" 2>/dev/null | _plan_packet_sha256)"
  [[ -n "$hash" && "$hash" != *[!0-9a-f]* ]] || { echo ""; return 0; }
  echo "$hash"
}

# Record the plan<->packet binding for the current plan.md and packet.
# Best-effort: absent plan/packet, missing hashing tools, or write failures
# never fail the caller. source: "approval" (planning approved) or
# "recovery" (packet regenerated in-band).
# Usage: plan_packet_record_binding <feature_dir> [source]
plan_packet_record_binding() {
  local feature_dir="$1" source="${2:-approval}"
  local marker="$feature_dir/.plan-packet-hash"
  local packet_line packet_hash packet_kind plan_hash tmp

  [[ -d "$feature_dir" ]] || return 0
  plan_packet_hash_available || return 0

  packet_line="$(plan_packet_current_hash "$feature_dir" 2>/dev/null)" || return 0
  packet_hash="${packet_line%%$'\t'*}"
  packet_kind="${packet_line#*$'\t'}"
  [[ -n "$packet_hash" ]] || return 0

  plan_hash="$(plan_packet_plan_hash "$feature_dir")"

  local recorded_at
  recorded_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")"

  tmp="$(mktemp "$feature_dir/.plan-packet-hash.tmp.XXXXXX" 2>/dev/null)" || return 0
  if command -v jq >/dev/null 2>&1; then
    jq -cn \
      --arg packetHash "$packet_hash" \
      --arg packetKind "$packet_kind" \
      --arg planHash "$plan_hash" \
      --arg recordedAt "$recorded_at" \
      --arg source "$source" \
      '{packetHash: $packetHash, packetKind: $packetKind, planHash: $planHash, recordedAt: $recordedAt, source: $source}' \
      > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  else
    printf '{"packetHash":"%s","packetKind":"%s","planHash":"%s","recordedAt":"%s","source":"%s"}\n' \
      "$packet_hash" "$packet_kind" "$plan_hash" "$recorded_at" "$source" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  fi
  mv "$tmp" "$marker" 2>/dev/null || rm -f "$tmp"
  return 0
}

# Read the recorded packet hash (empty when marker is missing or malformed).
plan_packet_recorded_packet_hash() {
  local feature_dir="$1"
  local marker="$feature_dir/.plan-packet-hash"

  [[ -f "$marker" ]] || { echo ""; return 0; }
  if command -v jq >/dev/null 2>&1; then
    jq -r '.packetHash // ""' "$marker" 2>/dev/null || echo ""
    return 0
  fi
  grep -oE '"packetHash"[[:space:]]*:[[:space:]]*"[0-9a-f]+"' "$marker" 2>/dev/null \
    | sed -E 's/.*"([0-9a-f]+)".*/\1/' | head -1
}

# Read the recorded plan hash (empty when marker is missing or malformed).
plan_packet_recorded_plan_hash() {
  local feature_dir="$1"
  local marker="$feature_dir/.plan-packet-hash"

  [[ -f "$marker" ]] || { echo ""; return 0; }
  if command -v jq >/dev/null 2>&1; then
    jq -r '.planHash // ""' "$marker" 2>/dev/null || echo ""
    return 0
  fi
  grep -oE '"planHash"[[:space:]]*:[[:space:]]*"[0-9a-f]*"' "$marker" 2>/dev/null \
    | sed -E 's/.*"([0-9a-f]*)".*/\1/' | head -1
}

# Compare the recorded binding against the current packet. Prints exactly one
# of:
#   match          - recorded hash matches the current packet
#   mismatch       - a binding was recorded and the packet has since changed
#   legacy         - no binding was recorded (plan predates this gate);
#                    conservatively treat as safe when no in-band regeneration
#                    happened in this handoff
#   legacy_stale   - no binding was recorded AND the packet is newer than
#                    plan.md (mtime fallback), so the plan is likely stale
#   no_packet      - no packet exists to compare against
#   unavailable    - hashing tools are missing
# Returns 0 in all cases; the caller inspects the printed disposition.
plan_packet_check_binding() {
  local feature_dir="$1"
  local marker="$feature_dir/.plan-packet-hash"
  local plan="$feature_dir/plan.md"
  local packet_line current_hash recorded_hash

  if ! plan_packet_hash_available; then
    echo "unavailable"
    return 0
  fi

  packet_line="$(plan_packet_current_hash "$feature_dir" 2>/dev/null)" || {
    echo "no_packet"
    return 0
  }
  current_hash="${packet_line%%$'\t'*}"
  [[ -n "$current_hash" ]] || { echo "no_packet"; return 0; }

  recorded_hash="$(plan_packet_recorded_packet_hash "$feature_dir")"

  if [[ -z "$recorded_hash" ]]; then
    # Legacy plan: no binding was ever recorded. Fall back to mtime: if the
    # packet is meaningfully newer than plan.md, treat as stale.
    if [[ -f "$plan" ]]; then
      local plan_mtime packet_mtime
      plan_mtime="$(_plan_packet_mtime "$plan")"
      packet_mtime="$(_plan_packet_packet_mtime "$feature_dir")"
      if [[ -n "$plan_mtime" && -n "$packet_mtime" ]] && (( packet_mtime > plan_mtime )); then
        echo "legacy_stale"
        return 0
      fi
    fi
    echo "legacy"
    return 0
  fi

  if [[ "$recorded_hash" == "$current_hash" ]]; then
    echo "match"
    return 0
  fi

  echo "mismatch"
  return 0
}

_plan_packet_mtime() {
  local path="$1"
  [[ -f "$path" ]] || { echo ""; return 0; }
  if stat -f '%m' "$path" >/dev/null 2>&1; then
    stat -f '%m' "$path" 2>/dev/null || echo ""
  else
    stat -c '%Y' "$path" 2>/dev/null || echo ""
  fi
}

_plan_packet_packet_mtime() {
  local feature_dir="$1"
  local -a candidates=(
    "$feature_dir/task-packet-header.md"
    "$feature_dir/task-packet-details.md"
    "$feature_dir/task-packet.md"
  )
  local path m best=""

  for path in "${candidates[@]}"; do
    [[ -f "$path" ]] || continue
    m="$(_plan_packet_mtime "$path")"
    [[ -n "$m" ]] || continue
    if [[ -z "$best" ]] || (( m > best )); then
      best="$m"
    fi
  done
  echo "$best"
  return 0
}

# Preserve a stale plan for diagnosis. Renames plan.md to
# plan.stale-<epoch>.md so a re-planned handoff writes a fresh plan.md.
# Best-effort: absent plan is a no-op; rename failures are silent.
plan_packet_preserve_stale_plan() {
  local feature_dir="$1"
  local plan="$feature_dir/plan.md"
  local epoch stale

  [[ -f "$plan" ]] || return 0
  epoch="$(date +%s 2>/dev/null || echo "unknown")"
  stale="$feature_dir/plan.stale-${epoch}.md"
  # If the target already exists (same-second collision) append a suffix.
  if [[ -e "$stale" ]]; then
    stale="$feature_dir/plan.stale-${epoch}-$$.md"
  fi
  mv "$plan" "$stale" 2>/dev/null || return 0
  return 0
}
