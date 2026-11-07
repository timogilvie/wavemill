#!/usr/bin/env bash
# The one operator-escalation decision (HOK-3360).
#
# Operator attention (`.needs-attention`, kind `ready-attention` — the
# dashboard inbox, the journey `!` flag, the tend/observer/watchdog readers and
# state-invariant I5) is raised by exactly one step: the escalation step of the
# existing failure-policy chain. A failure is paged only after the policy has
# decided retrying cannot (or did not) change the outcome:
#
#   * `exhausted <bucket>`      — a bounded-retry bucket terminalized
#                                 (`bounded_retry_mark_exhausted`); the retry
#                                 already happened and the ceiling was reached;
#   * `policy-terminal <json>`  — a `failure_policy_decide` / review-gate
#                                 decision whose `.class` is `terminal` (only
#                                 the TERMINAL_ALLOWLIST reaches this);
#   * `operator-decision <code>`— a code the policy names in OPERATOR_DECISIONS
#                                 (retrying provably cannot change it and no
#                                 bucket owns it).
#
# A retryable first occurrence records its failed stage result and returns; the
# next monitor tick routes it through `ready_failure_classify_and_act` →
# `maybe_retry_failed_stage`, and only the bucket's exhaustion pages. The HOK-3172
# condition reconciler still expires anything escalated.
#
# `_operator_attention_write` is private to this module: the only caller is
# `escalate_operator_attention`. The marker shape (kind `ready-attention`,
# `--head`, condition flags) is unchanged, so every existing reader keeps
# working. Enforced by `tools/check-failure-policy.ts`
# (`attention-write-outside-escalation`): a `write_ready_attention_file` /
# `_operator_attention_write` / `writeReadyAttention` / a raw `marker_write`
# of `.needs-attention` outside this module (and its TS twin
# `operator-escalation.ts`) fails preflight.

# operator_escalation_marker_path <state_dir>
# Print the one `.needs-attention` path. Read-only callers outside this module
# (tend merge gate, monitor stage gates, watchdog) use this instead of
# re-deriving the path (HOK-3424).
operator_escalation_marker_path() {
  printf '%s\n' "$1/.needs-attention"
}

# operator_escalation_has_marker <state_dir>
# Exit 0 when the escalation marker exists, 1 otherwise.
operator_escalation_has_marker() {
  [[ -f "$(operator_escalation_marker_path "$1")" ]]
}

# operator_escalation_marker_reason <state_dir>
# Echo the escalation marker's reason (JSON `reason`, else first legacy line).
# Prints nothing when the marker is absent or unreadable; never fails.
operator_escalation_marker_reason() {
  local marker
  marker="$(operator_escalation_marker_path "$1")"
  [[ -r "$marker" ]] || return 0
  marker_reason "$marker" 2>/dev/null || true
}

# _operator_attention_write <state_dir> <message> [marker condition flags...]
# Private. Writes the `.needs-attention` marker. Never call directly — go
# through escalate_operator_attention so the basis is checked first.
_operator_attention_write() {
  local state_dir="$1" message="$2"
  shift 2
  local -a condition_flags=("$@")
  local repo_dir
  # Read-only rev-parse to resolve the marker's head; moved verbatim from the
  # former write_ready_attention_file (HOK-3360). It mutates no worktree and
  # returns 0 (no marker) if the task path no longer resolves.
  # allow-settled-attempt: read-only rev-parse, no worktree mutation (HOK-3360)
  repo_dir=$(git -C "$state_dir" rev-parse --show-toplevel 2>/dev/null) || return 0
  # allow-settled-attempt: read-only rev-parse on the resolved repo root (HOK-3360)
  local head_sha
  head_sha=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null) || return 0
  marker_write "$state_dir/.needs-attention" --kind ready-attention --head "$head_sha" --reason "$message" "${condition_flags[@]}"
}

# _operator_escalation_warn <message>
# Best-effort warn that works whether or not a logger is sourced.
_operator_escalation_warn() {
  if declare -F log_warn >/dev/null 2>&1; then
    log_warn "$1"
  else
    printf '%s\n' "$1" >&2
  fi
}

# _operator_decision_is_known <code>
# Exit 0 when <code> is a known OPERATOR_DECISIONS entry (HOK-3360), via the
# failure-policy CLI. When the bridge is unavailable the code is treated as
# unknown (refuse), so an escalation never pages on an unverifiable basis.
_operator_decision_is_known() {
  local code="$1"
  [[ -n "$code" ]] || return 1
  if declare -F wavemill_run_tool >/dev/null 2>&1; then
    wavemill_run_tool failure-policy-cli.ts --operator-decision "$code" >/dev/null 2>&1
    return $?
  fi
  return 1
}

# escalate_operator_attention <state_dir> <basis> <basis_arg> <message> [flags...]
#
#   basis = exhausted          basis_arg=<bucket>        bounded_retry_is_exhausted must hold
#         | policy-terminal    basis_arg=<decision json | class word>  .class must be "terminal"
#         | operator-decision  basis_arg=<code>          code in OPERATOR_DECISIONS
#
# Writes `.needs-attention` (kind ready-attention) with the basis recorded in
# the marker detail. Refuses (no write, `[escalation-refused]` warn, rc 3) when
# the basis does not hold, so a caller cannot page on a first occurrence by
# mislabelling it. Trailing flags are marker condition flags (`--head`,
# `--expires-on`, `--review-artifact`, …) passed through unchanged.
escalate_operator_attention() {
  local state_dir="$1" basis="$2" basis_arg="$3" message="$4"
  shift 4
  local -a condition_flags=("$@")
  local basis_label

  case "$basis" in
    exhausted)
      if ! bounded_retry_is_exhausted "$state_dir" "$basis_arg"; then
        _operator_escalation_warn "[escalation-refused] basis=exhausted:${basis_arg} is not terminalized for ${state_dir}; refusing operator attention write"
        return 3
      fi
      basis_label="exhausted:${basis_arg}"
      ;;
    policy-terminal)
      local cls
      # basis_arg is either a full failure_policy_decide JSON (.class) or the
      # bare FailureClass word a review-gate decision prints.
      if ! cls="$(jq -er '.class' <<<"$basis_arg" 2>/dev/null)"; then
        cls="$basis_arg"
      fi
      if [[ "$cls" != "terminal" ]]; then
        _operator_escalation_warn "[escalation-refused] basis=policy-terminal but decision class='${cls}' for ${state_dir}; refusing operator attention write"
        return 3
      fi
      basis_label="policy-terminal:${cls}"
      ;;
    operator-decision)
      if ! _operator_decision_is_known "$basis_arg"; then
        _operator_escalation_warn "[escalation-refused] basis=operator-decision:${basis_arg} is not a known OPERATOR_DECISIONS code for ${state_dir}; refusing operator attention write"
        return 3
      fi
      basis_label="operator-decision:${basis_arg}"
      ;;
    *)
      _operator_escalation_warn "[escalation-refused] unknown escalation basis '${basis}' for ${state_dir}; refusing operator attention write"
      return 3
      ;;
  esac

  _operator_attention_write "$state_dir" "$message" \
    --detail-json "$(jq -cn --arg basis "$basis_label" '{escalationBasis: $basis}')" \
    "${condition_flags[@]}"
}
