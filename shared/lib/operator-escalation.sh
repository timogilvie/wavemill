#!/usr/bin/env bash
# Operator escalation step (HOK-3360): the one place .needs-attention is written.
#
# escalate_operator_attention <state_dir> <basis> <basis-arg> <message> [marker condition flags...]
#   basis = exhausted          <bucket>         bounded_retry_is_exhausted <state_dir> <bucket> must hold
#         | policy-terminal    <decision-json>  failure_policy_decide output; .class must be "terminal"
#         | operator-decision  <code>           code must be in failure-policy.ts OPERATOR_DECISIONS
# Writes .needs-attention (kind ready-attention) with the basis recorded in the marker detail.
# Refuses (no write, `[escalation-refused]` log_warn, rc 3) when the basis does not hold,
# so a caller cannot page on a first occurrence by mislabelling it.

set -euo pipefail

# shellcheck source=transient-marker.sh
source "$(dirname "${BASH_SOURCE[0]}")/transient-marker.sh"

# Private helper: writes .needs-attention marker
_operator_attention_write() {
  local state_dir="$1" message="$2"
  shift 2
  local -a condition_flags=("$@")
  local repo_dir
  repo_dir=$(git -C "$state_dir" rev-parse --show-toplevel 2>/dev/null) || return 0
  local head_sha
  head_sha=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null) || return 0
  marker_write "$state_dir/.needs-attention" --kind ready-attention --head "$head_sha" --reason "$message" "${condition_flags[@]}"
}

# Main escalation function
escalate_operator_attention() {
  local state_dir="$1" basis="$2" basis_arg="$3" message="$4"
  shift 4
  local -a condition_flags=("$@")
  
  case "$basis" in
    exhausted)
      if ! bounded_retry_is_exhausted "$state_dir" "$basis_arg"; then
        log_warn "[escalation-refused] bucket '$basis_arg' not exhausted for $state_dir"
        return 3
      fi
      ;;
    policy-terminal)
      # Validate that the decision JSON has class=terminal
      if ! jq -e '.class == "terminal"' <<< "$basis_arg" >/dev/null 2>&1; then
        log_warn "[escalation-refused] policy decision is not terminal: $basis_arg"
        return 3
      fi
      ;;
    operator-decision)
      # Validate against OPERATOR_DECISIONS by calling the CLI
      if ! failure_policy_cli --operator-decision "$basis_arg" >/dev/null 2>&1; then
        log_warn "[escalation-refused] invalid operator decision code: $basis_arg"
        return 3
      fi
      ;;
    *)
      log_warn "[escalation-refused] invalid basis: $basis"
      return 3
      ;;
  esac
  
  # Add basis to condition flags for the marker
  condition_flags+=(--detail-json "{\"basis\":\"$basis:$basis_arg\"}")
  
  # Write the attention marker
  _operator_attention_write "$state_dir" "$message" "${condition_flags[@]}"
  return 0
}