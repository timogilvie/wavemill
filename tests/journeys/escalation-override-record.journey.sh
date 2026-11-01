#!/usr/bin/env bash
# Golden journey: an escalation override of Hokusai's model reaches Hokusai
# (HOK-3363).
#
# Protects against: router escalation replacing Hokusai's coder through a
# local "stronger coder" ranking and recording the change only in the route
# artifact, so Hokusai learned "the executed model failed" without knowing it
# had recommended something else (the HOK-3329 incident). The route goes
# through the real mill: Hokusai (shared fake edge) recommends
# claude-haiku-4-5 with confidence 0.334 < the 0.4 floor, the router re-asks
# Hokusai for highest_reliability without that coder, and the task runs plan →
# code → review → ready → tend merge → post-merge eval with no operator
# reroute. Both the eval record and the queued Hokusai contribution row must
# carry the escalation override and Hokusai's join key.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP escalation-override-record journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/escalation-override-record" && pwd)"
ISSUE="JRN-1"
# A journey launched from inside a mill agent pane inherits that agent's
# WAVEMILL_PHASE / WAVEMILL_ISSUE; the fake CLI would then answer the eval's
# judge call as a phase launch.
unset WAVEMILL_PHASE WAVEMILL_ISSUE
journey_init escalation-override-record
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

# The Hokusai edge: first ask → claude-haiku-4-5 @ 0.334; the
# highest_reliability re-ask → claude-opus-5-5.
export FAKE_HOKUSAI_SCRIPT="$FIXTURE_DIR/hokusai-script.json"
export FAKE_HOKUSAI_LOG="$JOURNEY_TMP/logs/hokusai.jsonl"
: > "$FAKE_HOKUSAI_LOG"

# Routing on, through Hokusai, with the default escalation floors; Hokusai
# submission on with an unconfigured endpoint so the row stays queued.
journey_write_config '{
  "router": {
    "enabled": true,
    "escalation": {"enabled": true, "confidenceFloor": 0.4, "expectedSuccessFloor": 0.5},
    "hokusai": {"endpoint": "https://hokusai.fake/api/v1/models/30/predict", "apiKey": "journey-token", "timeout": 5000}
  },
  "eval": {"judge": {"model": "claude-sonnet-5", "provider": "anthropic"}},
  "hokusai": {"dataSubmission": {"enabled": true, "consentVersion": "1.0"}, "contributions": {"enabled": true}}
}'
# User-level contribution consent lives in the (isolated) HOME.
mkdir -p "$HOME/.wavemill"
printf '%s\n' '{"hokusai":{"enabled":true,"consentedAt":"2026-10-30T00:00:00.000Z","consentVersion":"1.0"}}' \
  > "$HOME/.wavemill/config.json"
# Let the router pick per-task models (the harness pins the agent by default)
# and run the post-merge eval. MONITOR_ENV is sourced: the last assignment wins.
{
  printf 'ROUTER_ENABLED=true\n'
  printf 'AGENT_CMD_EXPLICIT=false\n'
  printf 'AUTO_EVAL=true\n'
} >> "$MONITOR_ENV"

# Judge shim: in front of the shared fake on the monitor's PATH (the eval runs
# as a monitor child); agent panes keep the tmux server's PATH.
export PATH="$FIXTURE_DIR/bin:$PATH"

EVAL_LOG="/tmp/${SESSION}-eval-${ISSUE}.log"
PENDING="$STATE_DIR/hokusai/queue/pending.jsonl"

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
eval_settled() {
  [[ -f "$EVAL_LOG" ]] && cp "$EVAL_LOG" "$JOURNEY_TMP/logs/eval.log"
  grep -q 'Eval process exited with code' "$EVAL_LOG" 2>/dev/null
}
row_queued() { [[ -s "$PENDING" ]]; }

journey_wait_until "$ISSUE" 8  "task launched into planning"  phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"              phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"              phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"            journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"      journey_task_reaped "$ISSUE"
journey_wait_until "$ISSUE" 10 "post-merge eval settled"      eval_settled
journey_wait_until "$ISSUE" 5  "contribution row queued"      row_queued

eval_record() { grep -h "$ISSUE" "$STATE_DIR"/evals/*.jsonl 2>/dev/null | tail -1; }
queued_row() { tail -1 "$PENDING"; }
cp "$PENDING" "$JOURNEY_TMP/logs/pending.jsonl" 2>/dev/null || true

echo ""
echo "assertions:"
journey_assert "Hokusai was asked first with its default objective" \
  journey_jq_true -s 'map(select(.objective == null)) | length >= 1' "$FAKE_HOKUSAI_LOG"
journey_assert "the router re-asked Hokusai for highest_reliability without any spelling of claude-haiku-4-5" \
  journey_jq_true -s 'map(select(.objective == "highest_reliability")) | length >= 1 and all(.availableCoderModels | map(select(startswith("claude-haiku-4-5"))) | length == 0)' "$FAKE_HOKUSAI_LOG"
OWNERSHIP="$REPO_DIR/.wavemill/evals/artifacts/$ISSUE/.session-ownership.jsonl"
journey_assert "the coding stage ran the re-ask's coder" \
  journey_jq_true -s 'map(select(.type == "launch" and .kind == "coding")) | length >= 1 and all(.model == "claude-opus-5-5")' "$OWNERSHIP"
journey_assert "eval record: Hokusai recommended claude-haiku-4-5 under join key jrn-first-0001" \
  bash -c 'printf %s "$1" | jq -e ".routeProvenance.stageRoutes.coder.hokusai | .recommended == \"claude-haiku-4-5\" and .requestId == \"jrn-first-0001\"" >/dev/null' _ "$(eval_record)"
journey_assert "eval record: one escalation override to claude-opus-5-5 (confidence 0.334 < 0.4, re-ask jrn-reask-0002)" \
  bash -c 'printf %s "$1" | jq -e "
    .routeProvenance.stageRoutes.coder
    | .executed == \"claude-opus-5-5\"
      and ([.overrides[] | select(.source == \"escalation\" and .reason == \"hokusai_reask_below_floor\")] | length == 1)
      and (.overrides[] | select(.reason == \"hokusai_reask_below_floor\")
           | .to == \"claude-opus-5-5\"
             and .triggers == [{metric: \"confidence\", value: 0.334, threshold: 0.4}]
             and .hokusai.requestId == \"jrn-reask-0002\")" >/dev/null' _ "$(eval_record)"
journey_assert "eval record: Hokusai join key recorded on the route provenance" \
  bash -c 'printf %s "$1" | jq -e ".routeProvenance.hokusaiInferenceLogId == \"jrn-first-0001\"" >/dev/null' _ "$(eval_record)"
journey_assert "queued contribution row carries the join key" \
  bash -c 'printf %s "$1" | jq -e ".row.inputs.inference_log_id == \"jrn-first-0001\"" >/dev/null' _ "$(queued_row)"
journey_assert "queued contribution row carries the escalation override" \
  bash -c 'printf %s "$1" | jq -e "
    .row.inputs
    | .route_overrides_schema == \"route_overrides/v1\"
      and (.route_override_sources | index(\"escalation\")) != null
      and (.route_override_to | index(\"claude-opus-5-5\")) != null" >/dev/null' _ "$(queued_row)"
journey_assert "zero operator touches: no operator override on the record" \
  bash -c 'printf %s "$1" | jq -e "[.routeProvenance.stageRoutes[].overrides[] | select(.source == \"operator\")] | length == 0" >/dev/null' _ "$(eval_record)"
journey_assert "no operator attention was requested" test "$JOURNEY_SAW_ATTENTION" = "0"
journey_assert_landed "$ISSUE"

journey_finish
