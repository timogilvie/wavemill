#!/usr/bin/env bash
# Golden journey (HOK-3450): one handoff gate.
#
# Ready passes, records its `checked` handoff, and then the publish is refused.
# The record stays `checked` at the PR head. The mill must:
#   - derive NO wm:ready from that record, however many tend polls run (the
#     label must never offer tend a PR its claim refuses), and
#   - classify the refusal through the one failure policy, retry Ready on the
#     shared stage-failure-ready budget, publish, label, and merge
# with zero operator touches.
#
# Protects against: deriveMergeLabel rule 7 granting wm:ready from the handoff
# head alone, so a `checked` record earned a label that tend's claim refused
# as not-published and stripped, and the next reconcile added back — a label
# flip every poll with no progress.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP handoff-publish-refused journey: $reason"
  exit 0
fi

ISSUE="JRN-3450"
REFUSAL="ready handoff publish refused"

export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/happy-path/fake-agent" && pwd)"
journey_init handoff-publish-refused

# The publish stays refused until the journey releases it (the hold file), so
# the tend polls below provably run against the `checked` record. The first
# stage-failure-ready relaunch is immediate and is refused too; the backoff
# spaces the later ones so the three-attempt budget outlasts the polls.
export WAVEMILL_RETRY_BACKOFF_STAGE_FAILURE_READY_BASE_SECONDS=15

# ── shadow TOOLS_DIR ────────────────────────────────────────────────────────
# A shadow install whose tools/ holds the real tools, except the handoff tool,
# which is the refused-publish fixture. Tool files are copied, not symlinked:
# a tool that guards its entry point with
# `process.argv[1] === fileURLToPath(import.meta.url)` silently does nothing
# when run through a symlink, and this journey runs the whole lane through to
# post-merge cleanup. Everything else (shared/, node_modules/, tool
# subdirectories) is a symlink to the real install, so the copies' relative
# imports resolve. The shadow must live at <install>/tools with
# <install>/shared beside it: the lib dir is derived as
# "${TOOLS_DIR%/tools}/shared/lib". Appended after journey_init wrote
# MONITOR_ENV, so the later TOOLS_DIR assignment wins.
FAKE_INSTALL_DIR="$JOURNEY_TMP/install"
FAKE_TOOLS_DIR="$FAKE_INSTALL_DIR/tools"
mkdir -p "$FAKE_TOOLS_DIR"
for entry in "$JOURNEY_INSTALL_DIR"/*; do
  [[ "$(basename "$entry")" == "tools" ]] || ln -s "$entry" "$FAKE_INSTALL_DIR/$(basename "$entry")"
done
for entry in "$JOURNEY_INSTALL_DIR"/tools/*; do
  if [[ -d "$entry" ]]; then
    ln -s "$entry" "$FAKE_TOOLS_DIR/$(basename "$entry")"
  else
    cp -p "$entry" "$FAKE_TOOLS_DIR/$(basename "$entry")"
  fi
done
rm -f "$FAKE_TOOLS_DIR/ready-tend-handoff.ts"
cp "$(dirname "$0")/fixtures/handoff-publish-refused/ready-tend-handoff-fixture.ts" \
  "$FAKE_TOOLS_DIR/ready-tend-handoff.ts"
{
  printf 'TOOLS_DIR=%q\n' "$FAKE_TOOLS_DIR"
} >> "$MONITOR_ENV"
# Exported so the monitor's tool children (process.env) see them.
export FAKE_HANDOFF_REAL_TOOL="$JOURNEY_INSTALL_DIR/tools/ready-tend-handoff.ts"
export FAKE_HANDOFF_CALLS_FILE="$JOURNEY_TMP/handoff-publish-calls.log"
export FAKE_HANDOFF_HOLD_FILE="$JOURNEY_TMP/handoff-publish-refused.hold"
: > "$FAKE_HANDOFF_HOLD_FILE"

fakes_linear_add_issue "$ISSUE" "A change whose first handoff publish is refused" Todo
# CI is green from the start: the failure under test is the publish, not the
# checks.
fakes_gh_state '.checks.byPr["1"] = [{name: "unit-tests", conclusion: "SUCCESS"}]'

# ── observation ────────────────────────────────────────────────────────────
phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
feature_dir() { journey_feature_dir "$ISSUE" 2>/dev/null; }
handoff_field() { jq -r "$1 // empty" "$(feature_dir)/.ready-tend-handoff.json" 2>/dev/null || true; }
pr_labels() { jq -r '.prs["1"].labels // [] | join(",")' "$FAKE_GH_STATE" 2>/dev/null || true; }
publish_calls() { grep -c "$1" "$FAKE_HANDOFF_CALLS_FILE" 2>/dev/null || true; }
# Every wm:ready write (add or remove) the mill made, from its own label-write
# ledger. A label that is added and stripped inside one poll never shows in
# the PR's labels afterwards, so the ledger is the evidence.
ready_label_writes() {
  local ledger="$REPO_DIR/.wavemill/label-writes.jsonl"
  [[ -f "$ledger" ]] || { echo 0; return 0; }
  jq -s '[.[] | select(.label == "wm:ready")] | length' "$ledger"
}
last_tend_action() { grep -o 'action=[^ ]*' "$JOURNEY_TMP/logs/tend.log" 2>/dev/null | tail -1; }
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}
publish_refused() {
  local result
  result="$(feature_dir)/.ready-result.json" || return 1
  (( $(publish_calls refused) >= 1 )) || return 1
  jq -e --arg refusal "$REFUSAL" '.status == "failed"
    and (.artifacts.transitionFailure.stage == "ready-label")
    and ((.artifacts.transitionFailure.detail // "") | contains($refusal))' \
    "$result" >/dev/null 2>&1
}

# While the publish is refused the record sits at `checked` on the PR head.
# Poll tend the way the backstage loop does and prove the label never moves.
REFUSED_HEAD=""
REFUSED_STATE=""
REFUSED_POLLS=0
LABELS_DURING_REFUSAL=""
TEND_ACTIONS_DURING_REFUSAL=""
READY_WRITES_DURING_REFUSAL=""
observe_refused_window() {
  REFUSED_STATE="$(handoff_field .state)"
  REFUSED_HEAD="$(handoff_field .headSha)"
  local poll labels writes
  for poll in 1 2 3; do
    journey_tend_tick
    labels="$(pr_labels)"
    writes="$(ready_label_writes)"
    # Count the poll only if the record was still `checked` once it finished.
    [[ "$(handoff_field .state)" == "checked" ]] || break
    REFUSED_POLLS=$((REFUSED_POLLS + 1))
    LABELS_DURING_REFUSAL+="${LABELS_DURING_REFUSAL:+|}[$labels]"
    TEND_ACTIONS_DURING_REFUSAL+="${TEND_ACTIONS_DURING_REFUSAL:+ }$(last_tend_action)"
    READY_WRITES_DURING_REFUSAL="$writes"
  done
  # Release the publish: the next stage-failure-ready relaunch goes through.
  rm -f "$FAKE_HANDOFF_HOLD_FILE"
  journey_log "publish released after $REFUSED_POLLS tend poll(s) against the checked record"
}

journey_start_monitor
journey_set_tick_budget 90
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"
journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 12 "the handoff publish was refused" publish_refused
observe_refused_window
journey_wait_until "$ISSUE" 25 "PR merged after the publish retry" journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"           journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "the refused publish left the handoff at checked" \
  test "$REFUSED_STATE" = "checked"
journey_assert "the checked record was bound to the PR head" \
  test -n "$REFUSED_HEAD"
journey_assert "three tend polls ran against the checked record" \
  test "$REFUSED_POLLS" = "3"
journey_assert "no tend poll against the checked record showed wm:ready" \
  bash -c '[[ "$1" != *"wm:ready"* ]]' _ "$LABELS_DURING_REFUSAL"
journey_assert "tend was never offered the PR while the publish was refused (no claim to refuse)" \
  test "$TEND_ACTIONS_DURING_REFUSAL" = "action=idle action=idle action=idle"
journey_assert "the mill wrote no wm:ready (add or strip) while the publish was refused" \
  test "$READY_WRITES_DURING_REFUSAL" = "0"
journey_assert "wm:ready was written exactly once over the whole run" \
  bash -c '[[ "$(jq -s '"'"'[.[] | select(.label == "wm:ready" and .action == "labeled")] | length'"'"' "$1")" == "1" ]]' \
  _ "$REPO_DIR/.wavemill/label-writes.jsonl"
journey_assert "the refusal text reached the mill log" \
  bash -c '(( $1 >= 1 ))' _ "$(mill_log_count "$REFUSAL")"
journey_assert "the publish was refused, retried, and then went through" \
  bash -c '(( $1 >= 1 && $2 >= 1 ))' _ "$(publish_calls refused)" "$(publish_calls delegated)"
journey_assert "no ready remediation was launched for a refused publish" \
  test "$(mill_log_count "Launched ready remediation")" = "0"
journey_assert_landed "$ISSUE"
# journey_finish asserts no .needs-attention at any tick (JOURNEY_EXPECT_ATTENTION=0):
# refused publish → retry → publish → label → merge with zero operator touches.
journey_finish
