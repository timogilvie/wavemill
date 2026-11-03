#!/usr/bin/env bash
# One cross-runtime state lock. Directories are stamped before their atomic rename.
# shellcheck source=process-identity.sh
# Lock ownership must use the process identity twin from this install, never
# from REPO_DIR (the separate repository currently being milled).
if [[ -n "${ZSH_VERSION:-}" ]]; then
  state_lock_source="${(%):-%N}"
else
  state_lock_source="${BASH_SOURCE[0]}"
fi
state_lock_lib_dir="$(cd "$(dirname "$state_lock_source")" && pwd)"
source "$state_lock_lib_dir/process-identity.sh"

state_lock_owner_reclaimable() {
  local owner_json="$1" this_host="$2" pid start host
  pid="$(jq -r '.pid // empty' <<<"$owner_json" 2>/dev/null)"; start="$(jq -r '.processStartTime // empty' <<<"$owner_json" 2>/dev/null)"; host="$(jq -r '.host // empty' <<<"$owner_json" 2>/dev/null)"
  [[ "$host" == "$this_host" && "$pid" =~ ^[0-9]+$ && -n "$start" ]] && ! process_identity_alive "$pid" "$start"
}

_state_lock_claim() {
  local lock_path="$1" purpose="$2" temp owner pid start host
  [[ ! -e "$lock_path" ]] || return 1
  mkdir -p "$(dirname "$lock_path")"
  temp="$(mktemp -d "${lock_path}.tmp.${BASHPID:-$$}.XXXXXX")" || return 1
  pid="${BASHPID:-$$}"; start="$(process_identity_start_time "$pid")"; host="$(process_identity_host)"
  owner="$(jq -cn --argjson pid "$pid" --arg start "$start" --arg host "$host" --arg acquired "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg purpose "$purpose" '{pid:$pid,processStartTime:$start,host:$host,acquiredAt:$acquired,purpose:$purpose}')" || { rm -rf "$temp"; return 1; }
  printf '%s\n' "$owner" > "$temp/owner.json" || { rm -rf "$temp"; return 1; }
  # perl rename is the syscall, unlike mv which may move into an existing dir.
  perl -e 'rename $ARGV[0], $ARGV[1] or exit 1' "$temp" "$lock_path" && return 0
  rm -rf "$temp"; return 1
}

state_lock_acquire() {
  local lock_path="$1" max_retries="${2:-50}" sleep_seconds="${3:-0.1}" purpose="${4:-state-mutation}" attempt=0 owner current host
  while true; do
    _state_lock_claim "$lock_path" "$purpose" && return 0
    if [[ -d "$lock_path" && -f "$lock_path/owner.json" ]]; then
      owner="$(cat "$lock_path/owner.json" 2>/dev/null || true)"; host="$(process_identity_host)"
      if state_lock_owner_reclaimable "$owner" "$host" && mkdir "$lock_path/.reclaim" 2>/dev/null; then
        current="$(cat "$lock_path/owner.json" 2>/dev/null || true)"
        if [[ "$current" == "$owner" ]] && state_lock_owner_reclaimable "$current" "$host"; then
          rm -rf "$lock_path" 2>/dev/null || true
          continue
        fi
        rmdir "$lock_path/.reclaim" 2>/dev/null || true
      fi
    fi
    attempt=$((attempt + 1)); (( attempt >= max_retries )) && return 1
    sleep "$sleep_seconds"
  done
}

state_lock_release() {
  local lock_path="$1" owner pid start self_pid self_start
  [[ -f "$lock_path/owner.json" ]] || return 0
  self_pid="${BASHPID:-$$}"
  self_start="$(process_identity_start_time "$self_pid")"
  owner="$(cat "$lock_path/owner.json" 2>/dev/null || true)"; pid="$(jq -r '.pid // empty' <<<"$owner" 2>/dev/null)"; start="$(jq -r '.processStartTime // empty' <<<"$owner" 2>/dev/null)"
  [[ "$pid" == "$self_pid" && "$start" == "$self_start" ]] || return 0
  rm -rf "$lock_path"
}

state_lock_reclaim_legacy() {
  local lock_path="$1"
  [[ -e "$lock_path" ]] || return 1
  if [[ -f "$lock_path" && ! -s "$lock_path" ]] || [[ -d "$lock_path" && ! -e "$lock_path/owner.json" ]]; then rm -rf "$lock_path"; return 0; fi
  return 1
}
