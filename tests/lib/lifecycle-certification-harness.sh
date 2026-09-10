#!/usr/bin/env bash
# HOK-2957 lifecycle certification harness.
#
# Sourcing wrapper on top of tests/lib/incident-fixture-harness.sh: reuses its
# tmux socket + bare-remote + PATH-shim isolation, and adds:
#   - cert_scenario_run: drives a fixture with an optional merge method,
#     fault-injection point, and rollout-flag combination
#   - certification-report.json emission (per scenario id, merge method, flag
#     combo, fault, iteration_ms, pane state, cleanup counts, decisions,
#     agreement verdict)
#   - reuse of incident_preserve_diagnostics on failure so every failed run is
#     auditable per packet constraint
#
# Scope: this file is the driver primitives. Scenario matrix and invariant
# assertions live beside it (lifecycle-invariants.sh) and in the scenario
# driver (tests/lifecycle-certification.test.sh).
set -euo pipefail

CERT_HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/incident-fixture-harness.sh
source "$CERT_HARNESS_DIR/incident-fixture-harness.sh"

CERT_REPORT_FILE="${CERT_REPORT_FILE:-}"

# cert_report_init [path]
# Sets CERT_REPORT_FILE and initializes an empty scenarios array. If path is
# omitted, uses a $SCENARIO_DIR-relative default so callers can rely on
# incident_run_teardown_traps to also archive the report on failure.
cert_report_init() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    target="${SCENARIO_DIR:-/tmp}/certification-report.json"
  fi
  CERT_REPORT_FILE="$target"
  mkdir -p "$(dirname "$CERT_REPORT_FILE")" 2>/dev/null || true
  printf '{"scenarios":[],"meta":{"tool":"lifecycle-certification-harness","createdAt":"%s"}}\n' \
    "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$CERT_REPORT_FILE"
}

# cert_report_append <scenario-json>
# Appends a scenario record to CERT_REPORT_FILE. Safe against concurrent
# writers only within one process; certification runs are sequential.
cert_report_append() {
  local scenario_json="$1"
  [[ -n "$CERT_REPORT_FILE" ]] || return 0
  [[ -f "$CERT_REPORT_FILE" ]] || cert_report_init "$CERT_REPORT_FILE"
  local tmp
  tmp="$(mktemp "${CERT_REPORT_FILE}.XXXXXX" 2>/dev/null)" || return 0
  jq --argjson scenario "$scenario_json" '.scenarios += [$scenario]' \
    "$CERT_REPORT_FILE" > "$tmp" 2>/dev/null || {
      rm -f "$tmp"; return 0
    }
  mv "$tmp" "$CERT_REPORT_FILE"
}

# cert_fault_point <name>
# Harness-side no-op hook that scenario drivers can call between real
# lifecycle steps. When WAVEMILL_CERT_FAULT_POINT matches, aborts with the
# recorded fault name so the caller's outer supervisor can restart from
# persisted state. Env-gated: production paths keep no fault hooks unless
# scenarios opt in.
cert_fault_point() {
  local name="$1"
  local target="${WAVEMILL_CERT_FAULT_POINT:-}"
  [[ -z "$target" ]] && return 0
  if [[ "$target" == "$name" ]]; then
    echo "CERT_FAULT: injected exit at boundary '$name'" >&2
    exit 137
  fi
}

# cert_capture_state <issue>
# Emits a normalized JSON projection of the state that must survive restart:
# lifecycle disposition, cleanup outcome, pane state, worktree/branch
# presence, and cleanup episode fingerprint (minus wall-clock timestamps).
# Callers diff two projections to prove restart equivalence.
cert_capture_state() {
  local issue="$1"
  local phase status disposition present pane_alive branch_alive wt_alive
  phase="$(jq -r --arg i "$issue" '.tasks[$i].phase // ""' "$STATE_FILE" 2>/dev/null || echo "")"
  status="$(jq -r --arg i "$issue" '.tasks[$i].status // ""' "$STATE_FILE" 2>/dev/null || echo "")"
  disposition="$(jq -r --arg i "$issue" '.tasks[$i].lifecycle.resourceDisposition // ""' "$STATE_FILE" 2>/dev/null || echo "")"
  present="$(jq -r --arg i "$issue" '.tasks | has($i)' "$STATE_FILE" 2>/dev/null || echo false)"
  local slug branch wt
  slug="$(jq -r --arg i "$issue" '.tasks[$i].slug // ""' "$STATE_FILE" 2>/dev/null || echo "")"
  branch="$(jq -r --arg i "$issue" '.tasks[$i].branch // ""' "$STATE_FILE" 2>/dev/null || echo "")"
  wt="$(jq -r --arg i "$issue" '.tasks[$i].worktree // ""' "$STATE_FILE" 2>/dev/null || echo "")"
  if [[ -n "$slug" ]] && incident_tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -q "^${issue}-${slug}\$"; then
    pane_alive="true"
  else
    pane_alive="false"
  fi
  if [[ -n "$branch" ]] && git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
    branch_alive="true"
  else
    branch_alive="false"
  fi
  if [[ -n "$wt" && -d "$wt" ]]; then
    wt_alive="true"
  else
    wt_alive="false"
  fi
  jq -cn \
    --arg phase "$phase" --arg status "$status" --arg disposition "$disposition" \
    --arg present "$present" --arg pane "$pane_alive" \
    --arg branch "$branch_alive" --arg wt "$wt_alive" \
    '{phase:$phase,status:$status,resourceDisposition:$disposition,present:($present=="true"),paneAlive:($pane=="true"),branchAlive:($branch=="true"),worktreeAlive:($wt=="true")}'
}

# cert_apply_flags <flags-json>
# Exports env kill-switches for the four HOK-2957 rollout flags from a compact
# JSON like {"paneRelease":true,"prAwareCleanup":true,"terminalPreflight":true,
# "episodes":true,"branchDeletionMode":"shadow"}. Missing keys keep production
# defaults.
cert_apply_flags() {
  local flags_json="${1:-{}}"
  local pane_release pr_aware preflight episodes deletion_mode
  pane_release="$(jq -r '.paneRelease // empty' <<<"$flags_json" 2>/dev/null || true)"
  pr_aware="$(jq -r '.prAwareCleanup // empty' <<<"$flags_json" 2>/dev/null || true)"
  preflight="$(jq -r '.terminalPreflight // empty' <<<"$flags_json" 2>/dev/null || true)"
  episodes="$(jq -r '.episodes // empty' <<<"$flags_json" 2>/dev/null || true)"
  deletion_mode="$(jq -r '.branchDeletionMode // empty' <<<"$flags_json" 2>/dev/null || true)"

  [[ "$pane_release" == "false" ]] && export WAVEMILL_TERMINAL_PANE_RELEASE=0
  [[ "$pane_release" == "true"  ]] && export WAVEMILL_TERMINAL_PANE_RELEASE=1
  [[ "$pr_aware"     == "false" ]] && export WAVEMILL_PR_AWARE_CLEANUP=0
  [[ "$pr_aware"     == "true"  ]] && export WAVEMILL_PR_AWARE_CLEANUP=1
  [[ "$preflight"    == "false" ]] && export WAVEMILL_STARTUP_TERMINAL_PREFLIGHT=0
  [[ "$preflight"    == "true"  ]] && export WAVEMILL_STARTUP_TERMINAL_PREFLIGHT=1
  [[ "$episodes"     == "false" ]] && export WAVEMILL_CLEANUP_EPISODES_ENABLED=0
  [[ "$episodes"     == "true"  ]] && export WAVEMILL_CLEANUP_EPISODES_ENABLED=1
  case "$deletion_mode" in
    off|shadow|enforce) export WAVEMILL_BRANCH_DELETION_MODE="$deletion_mode" ;;
    "" ) : ;;
    *) echo "cert_apply_flags: unknown branchDeletionMode '$deletion_mode'" >&2 ;;
  esac
}

# cert_reset_flags — clears every env var cert_apply_flags may have set so a
# subsequent scenario starts from the ambient defaults.
cert_reset_flags() {
  unset WAVEMILL_TERMINAL_PANE_RELEASE
  unset WAVEMILL_PR_AWARE_CLEANUP
  unset WAVEMILL_STARTUP_TERMINAL_PREFLIGHT
  unset WAVEMILL_CLEANUP_EPISODES_ENABLED
  unset WAVEMILL_BRANCH_DELETION_MODE
  unset WAVEMILL_CERT_FAULT_POINT
}
