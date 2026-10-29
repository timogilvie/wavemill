#!/usr/bin/env bash
# Bounded-retry invariant helpers (HOK-2924).
#
# One shared implementation for every relaunch path in the mill: a per-bucket
# attempt counter with exponential backoff, a hard ceiling, a head-keyed reset,
# and a one-shot terminal ("exhausted") state with a greppable recorded reason.
#
# State is file-based, keyed by a <state_dir, bucket> pair. Buckets are stable
# kebab-case slugs (e.g. phase-launch-coding, ready-remediation,
# pending-ready-recheck, failed-ready-recheck, challenge-eval-hard-<pair>-<side>;
# HOK-3255 retired the challenge-eval-soft bucket). Bucket names must not be
# prefixes of one another within a state dir: clear removes every file under
# the bucket's prefix.
#
# Storage per bucket, under $state_dir:
#   .retry-<bucket>-count               attempt counter (positive integer)
#   .retry-<bucket>-head                head SHA the counter is keyed to; a two-line
#                                       file (head\nbase) when a base SHA is provided,
#                                       a single line otherwise (HOK-3092)
#   .retry-<bucket>-last-at             epoch seconds of the last increment
#   .retry-<bucket>-exhausted           terminal sentinel; contents = terminal reason
#   .retry-<bucket>-exhausted-condition.json  condition companion (HOK-3172); JSON marker
#                                       with expiry triggers for the reconciler
#
# The failed-ready-recheck bucket keeps its pre-HOK-2924 file names
# (.failed-ready-recheck-*) so an in-flight session upgrading to this code
# sees no state loss.
#
# set -e safety: every helper that is invoked bare or via command substitution
# returns 0 on all paths. Only bounded_retry_due, bounded_retry_is_exhausted,
# and bounded_retry_mark_exhausted use their exit status as a signal, and all
# are documented to be called behind `if`.

# HOK-3227: backoff and deadlines read the tick clock seam (wall clock unless
# a golden journey sets WAVEMILL_TICK_CLOCK_FILE).
# Tests that inline this file elsewhere fall back to the wall clock.
if [[ -f "$(dirname "${BASH_SOURCE[0]}")/mill-clock.sh" ]]; then
  # shellcheck source=mill-clock.sh
  source "$(dirname "${BASH_SOURCE[0]}")/mill-clock.sh"
fi
declare -F mill_clock_now >/dev/null 2>&1 || mill_clock_now() { date +%s; }

# Resolve the per-bucket file prefix. Legacy buckets that shipped their own
# file names before the helper existed keep them (upgrade compatibility).
_bounded_retry_prefix() {
  local bucket="$1"
  case "$bucket" in
    failed-ready-recheck) printf '.failed-ready-recheck-' ;;
    *) printf '.retry-%s-' "$bucket" ;;
  esac
}

# HOK-3184: optional per-bucket shadow step id. The id is written by the
# launch sites after a successful ledger step-upsert via
# bounded_retry_bind_shadow. When absent, the ledger shadow writes are
# skipped silently.
_bounded_retry_shadow_step_id() {
  local state_dir="$1" bucket="$2"
  local shadow_file
  shadow_file="$state_dir/$(_bounded_retry_prefix "$bucket")step-id"
  [[ -f "$shadow_file" ]] || { echo ""; return 0; }
  cat "$shadow_file" 2>/dev/null || echo ""
  return 0
}

# HOK-3184: launch-site shadow helper. One function the three stage
# launchers (review, Ready, eval) call to upsert a step row and bind it to
# a retry bucket. Returns the step id on stdout (empty on failure); always
# returns 0 so a shadow failure never crashes the launcher.
#
# Usage: wavemill_ledger_step_upsert <issue> <kind> <state_dir> <bucket>
#          [--head <sha>] [--base <sha>] [--pr <n>] [--pair <id>]
#          [--side primary|challenger] [--prompt <identity>]
#          [--owner <s>] [--next-action <s>] [--deadline <iso>]
#          [--max-attempts <n>]
wavemill_ledger_step_upsert() {
  local issue="$1" kind="$2" state_dir="$3" bucket="$4"
  shift 4 2>/dev/null || return 0
  [[ "${WAVEMILL_LEDGER_SHADOW_DISABLED:-0}" == "1" ]] && return 0
  [[ -n "$issue" && -n "$kind" ]] || return 0
  declare -F wavemill_run_tool >/dev/null 2>&1 || return 0
  local -a cli=(ledger.ts step-upsert --issue "$issue" --kind "$kind")
  while (( $# > 0 )); do
    cli+=("$1")
    shift
  done
  local raw step_id
  raw="$(wavemill_run_tool "${cli[@]}" --json 2>/dev/null || echo '')"
  [[ -n "$raw" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  step_id="$(printf '%s' "$raw" | jq -r '.id // empty' 2>/dev/null || echo '')"
  [[ -n "$step_id" ]] || return 0
  if [[ -n "$state_dir" && -n "$bucket" ]]; then
    bounded_retry_bind_shadow "$state_dir" "$bucket" "$step_id" || true
  fi
  printf '%s' "$step_id"
  return 0
}

# Settle a shadow step row (best-effort). Called from stage-completion sites
# in launch_review_phase / launch_ready_phase / the eval settler.
wavemill_ledger_step_settle() {
  local step_id="$1" settled_as="$2" reason="${3:-}"
  [[ "${WAVEMILL_LEDGER_SHADOW_DISABLED:-0}" == "1" ]] && return 0
  [[ -n "$step_id" && -n "$settled_as" ]] || return 0
  declare -F wavemill_run_tool >/dev/null 2>&1 || return 0
  local -a cli=(ledger.ts step-settle --id "$step_id" --as "$settled_as")
  [[ -n "$reason" ]] && cli+=(--reason "$reason")
  wavemill_run_tool "${cli[@]}" >/dev/null 2>&1 || true
  return 0
}

# Bind a bucket to its mirror step row. Called by launch_review_phase /
# launch_ready_phase / the challenge eval launcher immediately after a
# successful `ledger.ts step-upsert`.
bounded_retry_bind_shadow() {
  local state_dir="$1" bucket="$2" step_id="$3"
  [[ -n "$state_dir" && -n "$bucket" && -n "$step_id" ]] || return 0
  mkdir -p "$state_dir" 2>/dev/null || return 0
  local shadow_file
  shadow_file="$state_dir/$(_bounded_retry_prefix "$bucket")step-id"
  printf '%s\n' "$step_id" > "$shadow_file" 2>/dev/null || true
  return 0
}

# Mirror an attempt increment onto the step row's attempt counter.
# Always returns 0 (best-effort).
_bounded_retry_shadow_attempt() {
  local state_dir="$1" bucket="$2"
  [[ "${WAVEMILL_LEDGER_SHADOW_DISABLED:-0}" == "1" ]] && return 0
  local step_id
  step_id=$(_bounded_retry_shadow_step_id "$state_dir" "$bucket")
  [[ -n "$step_id" ]] || return 0
  declare -F wavemill_run_tool >/dev/null 2>&1 || return 0
  wavemill_run_tool ledger.ts retry-attempt --id "$step_id" >/dev/null 2>&1 || true
  return 0
}

# Mirror a terminal exhaustion onto the step row (settled=aborted with reason).
# Always returns 0.
_bounded_retry_shadow_exhaust() {
  local state_dir="$1" bucket="$2" reason="$3"
  [[ "${WAVEMILL_LEDGER_SHADOW_DISABLED:-0}" == "1" ]] && return 0
  local step_id
  step_id=$(_bounded_retry_shadow_step_id "$state_dir" "$bucket")
  [[ -n "$step_id" ]] || return 0
  declare -F wavemill_run_tool >/dev/null 2>&1 || return 0
  local -a cli=(ledger.ts retry-exhaust --id "$step_id" --bucket "$bucket")
  [[ -n "$reason" ]] && cli+=(--reason "$reason")
  wavemill_run_tool "${cli[@]}" >/dev/null 2>&1 || true
  return 0
}

_bounded_retry_file() {
  local state_dir="$1" bucket="$2" kind="$3"
  printf '%s/%s%s' "$state_dir" "$(_bounded_retry_prefix "$bucket")" "$kind"
}

# Env-var fragment for a bucket: upper-cased, dashes to underscores.
_bounded_retry_env_bucket() {
  local bucket="$1"
  printf '%s' "$bucket" | tr 'a-z-' 'A-Z_'
}

# Backoff base/cap resolution precedence: explicit argument > per-bucket env
# (WAVEMILL_RETRY_BACKOFF_<BUCKET>_{BASE,CAP}_SECONDS) > global env
# (WAVEMILL_RETRY_BACKOFF_{BASE,CAP}_SECONDS) > shipped default (120 / 1800,
# matching the failed-ready re-check path's shipped defaults).
_bounded_retry_resolve_base() {
  local bucket="$1" explicit="${2:-}"
  local env_name value
  if [[ "$explicit" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  if [[ -n "$bucket" ]]; then
    env_name="WAVEMILL_RETRY_BACKOFF_$(_bounded_retry_env_bucket "$bucket")_BASE_SECONDS"
    value="${!env_name:-}"
    if [[ "$value" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  fi
  value="${WAVEMILL_RETRY_BACKOFF_BASE_SECONDS:-}"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  printf '120\n'
}

_bounded_retry_resolve_cap() {
  local bucket="$1" explicit="${2:-}"
  local env_name value
  if [[ "$explicit" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  if [[ -n "$bucket" ]]; then
    env_name="WAVEMILL_RETRY_BACKOFF_$(_bounded_retry_env_bucket "$bucket")_CAP_SECONDS"
    value="${!env_name:-}"
    if [[ "$value" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  fi
  value="${WAVEMILL_RETRY_BACKOFF_CAP_SECONDS:-}"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  printf '1800\n'
}

# Current attempt count for a bucket (0 when unset or unreadable).
bounded_retry_count() {
  local state_dir="$1" bucket="$2"
  local count_file count
  count_file="$(_bounded_retry_file "$state_dir" "$bucket" "count")"
  if [[ ! -f "$count_file" ]]; then
    echo "0"
    return 0
  fi
  count=$(cat "$count_file" 2>/dev/null || echo "0")
  if [[ ! "$count" =~ ^[0-9]+$ ]]; then
    echo "0"
    return 0
  fi
  echo "$count"
}

# Head SHA the bucket's counter is keyed to (empty when unset). Reads the
# first line of the key file, which stores head on line 1 and (optionally)
# base on line 2.
bounded_retry_head() {
  local state_dir="$1" bucket="$2"
  local head_file
  head_file="$(_bounded_retry_file "$state_dir" "$bucket" "head")"
  [[ -f "$head_file" ]] || { echo ""; return 0; }
  head -n 1 "$head_file" 2>/dev/null || echo ""
  return 0
}

# Base SHA the bucket's counter is keyed to (empty when unset or when only a
# head was stored). Reads the second line of the two-line key file (HOK-3092).
bounded_retry_base() {
  local state_dir="$1" bucket="$2"
  local head_file
  head_file="$(_bounded_retry_file "$state_dir" "$bucket" "head")"
  [[ -f "$head_file" ]] || { echo ""; return 0; }
  awk 'NR == 2 { print; exit }' "$head_file" 2>/dev/null || echo ""
  return 0
}

# Epoch seconds of the last increment (empty when unset or unreadable).
bounded_retry_last_at() {
  local state_dir="$1" bucket="$2"
  local last_at_file last_at
  last_at_file="$(_bounded_retry_file "$state_dir" "$bucket" "last-at")"
  [[ -f "$last_at_file" ]] || { echo ""; return 0; }
  last_at=$(cat "$last_at_file" 2>/dev/null || echo "")
  if [[ ! "$last_at" =~ ^[0-9]+$ ]]; then
    echo ""
    return 0
  fi
  echo "$last_at"
}

# Remove every file under the bucket's prefix — counter, head key, timestamp,
# exhausted sentinel, and any path-specific companions sharing the prefix
# (e.g. .failed-ready-recheck-reason.json). Called on successful launch.
bounded_retry_clear() {
  local state_dir="$1" bucket="$2"
  local prefix
  prefix="$(_bounded_retry_prefix "$bucket")"
  [[ -n "$state_dir" && -n "$bucket" ]] || return 0
  rm -f "$state_dir/$prefix"* 2>/dev/null || true
  return 0
}

# A new commit — or a new base SHA — is genuine new information: wipe the
# budget (and any exhausted terminal state) so the fresh key gets a full set
# of attempts. A new head means new work; a new base means a new merge
# parent, so the last outcome no longer predicts the next one (HOK-3092).
# An empty current head means git failed — never reset on that. An empty
# current base is treated as "no base component" (comparison ignores it),
# which preserves backward compatibility for callers that only key on head.
bounded_retry_reset_if_new_key() {
  local state_dir="$1" bucket="$2" current_head="$3" current_base="${4:-}"
  local head_file stored_head stored_base
  head_file="$(_bounded_retry_file "$state_dir" "$bucket" "head")"

  [[ -n "$current_head" ]] || return 0
  [[ -f "$head_file" ]] || return 0
  stored_head=$(bounded_retry_head "$state_dir" "$bucket")
  [[ -n "$stored_head" ]] || return 0

  if [[ "$stored_head" != "$current_head" ]]; then
    bounded_retry_clear "$state_dir" "$bucket"
    return 0
  fi

  # Base component: reset when a base is provided (by caller or previously
  # recorded) and it differs from the current one. When only the caller provides
  # a base (stored is empty but current is non-empty), or vice versa, or both are
  # present but differ, this represents a new merge parent and should reset.
  # If both are empty or both match, no reset is needed (head-only key or
  # unchanged base).
  if [[ -n "$current_base" ]]; then
    stored_base=$(bounded_retry_base "$state_dir" "$bucket")
    if [[ "$stored_base" != "$current_base" ]]; then
      bounded_retry_clear "$state_dir" "$bucket"
    fi
  fi
  return 0
}

# Backwards-compatible head-only reset. Prefer bounded_retry_reset_if_new_key
# in new callers so a rebase onto a fresh base can wipe the budget too.
bounded_retry_reset_if_new_head() {
  bounded_retry_reset_if_new_key "$1" "$2" "$3" ""
}

# Increment the attempt counter, key it to the current head (and optionally
# base — HOK-3092), and stamp the attempt time. Echoes the new count.
bounded_retry_increment() {
  local state_dir="$1" bucket="$2" current_head="$3" current_base="${4:-}"
  local count key_file existing_base
  count=$(bounded_retry_count "$state_dir" "$bucket")
  count=$((count + 1))
  mkdir -p "$state_dir"
  printf '%s\n' "$count" > "$(_bounded_retry_file "$state_dir" "$bucket" "count")"
  # An empty head means git failed; keep any previously recorded head so a
  # later real commit still triggers the budget reset.
  if [[ -n "$current_head" ]]; then
    key_file="$(_bounded_retry_file "$state_dir" "$bucket" "head")"
    if [[ -n "$current_base" ]]; then
      printf '%s\n%s\n' "$current_head" "$current_base" > "$key_file"
    else
      # Preserve any previously recorded base so an empty base_sha this tick
      # (e.g. transient ls-remote failure) does not silently downgrade the
      # composite key to head-only.
      existing_base=$(bounded_retry_base "$state_dir" "$bucket")
      if [[ -n "$existing_base" ]]; then
        printf '%s\n%s\n' "$current_head" "$existing_base" > "$key_file"
      else
        printf '%s\n' "$current_head" > "$key_file"
      fi
    fi
  fi
  printf '%s\n' "$(mill_clock_now)" > "$(_bounded_retry_file "$state_dir" "$bucket" "last-at")"
  # HOK-3184: mirror the new attempt onto the shadow step row (if bound).
  _bounded_retry_shadow_attempt "$state_dir" "$bucket" || true
  echo "$count"
}

# Delay before attempt (count+1): min(base * 2^(count-1), cap).
bounded_retry_backoff_seconds() {
  local count="$1" base="${2:-}" cap="${3:-}"
  base="$(_bounded_retry_resolve_base "" "$base")"
  cap="$(_bounded_retry_resolve_cap "" "$cap")"
  [[ "$count" =~ ^[0-9]+$ ]] || count=1
  (( count >= 1 )) || count=1

  local delay="$base" i
  for (( i = 1; i < count; i++ )); do
    delay=$((delay * 2))
    if (( delay >= cap )); then
      delay="$cap"
      break
    fi
  done
  (( delay > cap )) && delay="$cap"
  echo "$delay"
}

# Exit 0 when the backoff window for the next attempt has elapsed (or no
# attempt has been recorded yet). Call behind `if`.
bounded_retry_due() {
  local state_dir="$1" bucket="$2" base="${3:-}" cap="${4:-}"
  local last_at now delay

  last_at=$(bounded_retry_last_at "$state_dir" "$bucket")
  [[ -n "$last_at" ]] || return 0

  base="$(_bounded_retry_resolve_base "$bucket" "$base")"
  cap="$(_bounded_retry_resolve_cap "$bucket" "$cap")"
  delay=$(bounded_retry_backoff_seconds "$(bounded_retry_count "$state_dir" "$bucket")" "$base" "$cap")
  now=$(mill_clock_now)
  (( now - last_at >= delay ))
}

# One-shot terminalization with a recorded, greppable reason. Does not touch
# the attempt counter, so a terminal cause detected before any attempt leaves
# the count at 0 (REQ-F4). Returns 0 on the first-time transition (caller
# emits the status line / attention file) and 1 when the sentinel already
# exists. Call behind `if`.
#
# HOK-3172: on first-time transition, also writes a condition companion via
# marker_write. Extra flags (--head, --expires-on, etc.) are forwarded. When
# marker_write is unavailable (declare -F guard fails, such as in the TS
# bridge's bash -c), behaves exactly as before (plain-text sentinel only).
bounded_retry_mark_exhausted() {
  local state_dir="$1" bucket="$2" reason="${3:-}"
  # Callers may omit the reason; a bare `shift 3` would fail under set -e.
  shift "$(( $# < 3 ? $# : 3 ))"
  local -a condition_flags=("$@")
  local sentinel
  sentinel="$(_bounded_retry_file "$state_dir" "$bucket" "exhausted")"

  if [[ -f "$sentinel" ]]; then
    return 1
  fi
  mkdir -p "$state_dir"
  printf '%s\n' "$reason" > "$sentinel"

  # Write condition companion if marker_write is available
  if declare -F marker_write >/dev/null 2>&1; then
    local companion
    companion="$state_dir/$(_bounded_retry_prefix "$bucket")exhausted-condition.json"

    # Build condition flags: use explicit flags if given, else derive from key.
    # A head trigger is only recorded when the key holds a real SHA. Without
    # one (terminal short-circuits, the pending-ready lockstep halt) the
    # sentinel must hold until an operator acts; a placeholder head would never
    # match HEAD and the reconciler would clear the terminal state next tick.
    local stored_head=""
    if [[ ${#condition_flags[@]} -eq 0 ]]; then
      local head_file
      head_file="$(_bounded_retry_file "$state_dir" "$bucket" "head")"
      if [[ -f "$head_file" ]]; then
        stored_head=$(head -n 1 "$head_file" 2>/dev/null | cut -d: -f1 || true)
      fi
      if [[ "$stored_head" =~ ^[0-9a-f]{40}$ ]]; then
        condition_flags+=(--expires-on "head,operator-event")
      else
        stored_head=""
        condition_flags+=(--expires-on "operator-event")
      fi
    fi

    # Auto-add state-dir if not present
    local has_state_dir=false
    for flag in "${condition_flags[@]}"; do
      if [[ "$flag" == "--state-dir" ]]; then
        has_state_dir=true
        break
      fi
    done
    if [[ "$has_state_dir" == "false" ]]; then
      condition_flags+=(--state-dir "$state_dir")
    fi

    # Write companion marker
    local -a head_args=()
    [[ -n "$stored_head" ]] && head_args=(--head "$stored_head")
    marker_write "$companion" --kind retry-exhausted "${head_args[@]}" --reason "$reason" "${condition_flags[@]}" 2>/dev/null || true
  fi

  # HOK-3184: mirror the exhaustion onto the shadow step row (if bound).
  _bounded_retry_shadow_exhaust "$state_dir" "$bucket" "$reason" || true

  return 0
}

# Exit 0 when the bucket has been terminalized. Call behind `if`.
bounded_retry_is_exhausted() {
  local state_dir="$1" bucket="$2"
  [[ -f "$(_bounded_retry_file "$state_dir" "$bucket" "exhausted")" ]]
}

# Recorded terminal reason (empty when not exhausted).
bounded_retry_exhaustion_reason() {
  local state_dir="$1" bucket="$2"
  local sentinel
  sentinel="$(_bounded_retry_file "$state_dir" "$bucket" "exhausted")"
  [[ -f "$sentinel" ]] || { echo ""; return 0; }
  cat "$sentinel" 2>/dev/null || echo ""
  return 0
}

# Path to the condition companion for an exhausted sentinel (HOK-3172).
# Returns the path whether or not the file exists; caller checks existence.
bounded_retry_condition_path() {
  local state_dir="$1" bucket="$2"
  printf '%s/%sexhausted-condition.json' "$state_dir" "$(_bounded_retry_prefix "$bucket")"
}

# The composed relaunch decision. Echoes exactly one of:
#   proceed         — launch now (caller increments the counter first)
#   backoff         — a retry is scheduled but its delay has not elapsed
#   exhausted       — budget spent; caller terminalizes via
#                     bounded_retry_mark_exhausted with a recorded reason
#   exhausted-quiet — already terminalized; hold silently until a new commit
#
# Usage: bounded_retry_gate <state_dir> <bucket> <current_head> <limit>
#                           [<base_backoff>] [<cap_backoff>] [<current_base>]
#
# The trailing <current_base> is optional (HOK-3092): when supplied it feeds
# the composite-key reset so a rebase onto a new base wipes the budget along
# with the exhaustion sentinel. Empty or non-SHA base_sha is treated as
# absent (safe default; behaves like the pre-HOK-3092 head-only key).
bounded_retry_gate() {
  local state_dir="$1" bucket="$2" current_head="$3" limit="$4"
  local base="${5:-}" cap="${6:-}" current_base="${7:-}"
  local count

  # Non-SHA-shaped base is treated as absent (transient ls-remote failure,
  # etc.): keep the existing single-key semantics rather than silently
  # forcing a reset from a bogus value.
  if [[ -n "$current_base" ]] && ! [[ "$current_base" =~ ^[0-9a-fA-F]{7,64}$ ]]; then
    current_base=""
  fi
  bounded_retry_reset_if_new_key "$state_dir" "$bucket" "$current_head" "$current_base"

  if bounded_retry_is_exhausted "$state_dir" "$bucket"; then
    echo "exhausted-quiet"
    return 0
  fi

  [[ "$limit" =~ ^[0-9]+$ ]] || limit=4
  count=$(bounded_retry_count "$state_dir" "$bucket")
  if (( count >= limit )); then
    echo "exhausted"
    return 0
  fi

  if ! bounded_retry_due "$state_dir" "$bucket" "$base" "$cap"; then
    echo "backoff"
    return 0
  fi

  echo "proceed"
}
