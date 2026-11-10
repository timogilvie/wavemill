#!/usr/bin/env bash
# Golden journey: the Observer's phone/desktop push is the second reader of the
# attention projection, never a second decider (HOK-3424).
#
# Protects against: the Observer scanning sentinels and prompts on its own
# (the deleted `detectExhaustedRetries`, the raw `.needs-attention` read in
# `readReadyFailureReason`, `detectInteractivePromptBlockedIncidents`), so one
# condition paged twice, paged for something the inbox never showed, or kept
# paging after the condition expired. The real mill writes the projection, a
# real `escalateOperatorAttention` raises the escalation, and the real Observer
# loop pushes to a fake ntfy sink over loopback.
#
# Oracles:
#   - with no task escalation, and a non-task (openrouter) free item present in
#     the projection, one Observer pass pushes nothing;
#   - after the escalation, the projection holds exactly one task item
#     (kind operator-decision, keyed on the task) and the Observer pushes
#     exactly once, with the item's own title and command in the payload;
#   - moving the head (the coder's ordinary commit) lets the HOK-3172
#     reconciler expire the escalation: the marker and the projection item are
#     gone, an Observer pass after that prunes the journal entry, and the sink
#     stays at one push.
#
# The journal's persist clock is seeded (firstSeenAt 30 minutes ago) so the
# journey does not idle a real minute: `selectAlertsToSend`'s persist/repeat
# behaviour is pinned by observer-alerts.test.ts; this journey pins *where* the
# pushed finding comes from.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP observer-attention-push journey: $reason"
  exit 0
fi

# Reuse the detailed-issue fixture: inputs are materialised without an LLM, so
# planning reaches awaiting_user on the first planner launch.
FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/hok-3220" && pwd)"
ISSUE="$(jq -r '.identifier' "$FIXTURE_DIR/issue.json")"
# Our fixture scripts only the coding phase; planning uses the shared default.
export FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/observer-attention-push" && pwd)/fake-agent"
unset WAVEMILL_PHASE WAVEMILL_ISSUE

journey_init observer-attention-push
journey_set_approval_budget 1
fakes_linear_add_issue_from_file "$FIXTURE_DIR/issue.json"

PUSH_CAPTURE="$JOURNEY_TMP/logs/pushes.jsonl"
PUSH_PORT="$(fakes_start_push_sink "$PUSH_CAPTURE" "$JOURNEY_TMP/logs/push-port")"
journey_log "fake push sink listening on 127.0.0.1:$PUSH_PORT"
journey_write_config "$(jq -n --arg url "http://127.0.0.1:$PUSH_PORT/push" '{
  observer: {alerts: {
    enabled: true,
    desktop: false,
    minSeverity: "high",
    persistMinutes: 1,
    repeatMinutes: 240,
    push: {url: $url, format: "ntfy"}
  }}
}')"

ATTENTION_FILE="$STATE_DIR/attention.json"
JOURNAL="$REPO_DIR/.wavemill/observer/alert-state.json"
OBSERVED_BEFORE="$JOURNEY_TMP/attention-before-escalation.json"
OBSERVED_AT_ESCALATION="$JOURNEY_TMP/attention-at-escalation.json"
# A non-task signal the dashboard header used to read privately: it belongs to
# the inbox only and must never push.
OPENROUTER_WARNING="/tmp/${SESSION}-openrouter-warning.txt"
printf 'OpenRouter balance is low: 9%% remaining\n' > "$OPENROUTER_WARNING"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

sink_count() {
  if [[ -s "$PUSH_CAPTURE" ]]; then wc -l < "$PUSH_CAPTURE" | tr -d ' '; else echo 0; fi
}

projection_ready() {
  [[ -f "$ATTENTION_FILE" ]] \
    && jq -e '.schemaVersion == 1 and (.items | type == "array")' "$ATTENTION_FILE" >/dev/null 2>&1
}

# The escalation item's id, or empty.
escalation_item_id() {
  jq -r --arg id "$ISSUE" \
    '[.items[] | select(.taskId == $id and .kind == "operator-decision")][0].id // empty' \
    "$ATTENTION_FILE" 2>/dev/null || true
}

no_escalation_item() { projection_ready && [[ -z "$(escalation_item_id)" ]]; }

has_escalation_item() { [[ -n "$(escalation_item_id)" ]]; }

marker_gone() { [[ ! -f "$(journey_feature_dir "$ISSUE")/.needs-attention" ]]; }

# The Observer's own pass, foreground: run it while the projection has no task
# item and prove it pushes nothing.
run_observer_once() {
  (cd "$JOURNEY_INSTALL_DIR" \
    && node --import tsx tools/observer.ts --once --repo-dir "$REPO_DIR" \
         --session "$SESSION" --no-incident-detector) \
    >> "$JOURNEY_TMP/logs/observer.log" 2>&1
}

# The Observer loop the mill would run backstage: its own tracked job, so
# fakes_teardown_world reaches it like any other long-lived child.
start_observer_loop() {
  fakes_spawn bash -c 'cd "$1" && exec node --import tsx tools/observer.ts --loop --interval 1 \
      --repo-dir "$2" --session "$3" --no-incident-detector' \
    _ "$JOURNEY_INSTALL_DIR" "$REPO_DIR" "$SESSION" \
    </dev/null >> "$JOURNEY_TMP/logs/observer.log" 2>&1
}

# Raise the real escalation, exactly as a live failure path would: basis
# operator-decision (an OPERATOR_DECISIONS code), condition on the head.
escalate_now() {
  local fd="$1" head="$2"
  (cd "$JOURNEY_INSTALL_DIR" && node --import tsx --input-type=module -e '
    const { escalateOperatorAttention } = await import("./shared/lib/operator-escalation.ts");
    const [stateDir, head, message] = process.argv.slice(1);
    const ok = escalateOperatorAttention({
      stateDir,
      headSha: head,
      basis: { kind: "operator-decision", code: "review-session-interrupted-pre-pr" },
      message,
      condition: { head, expiresOn: ["head", "operator-event"] },
    });
    if (!ok) process.exit(3);
  ' "$fd" "$head" "$ISSUE was interrupted before a PR existed; run /re-review")
}

# Persist clock seed: the projection item already outlived persistMinutes, so
# the Observer loop's first pass is due instead of waiting a real minute.
seed_journal() {
  local id="$1" first
  first="$(node -e 'process.stdout.write(new Date(Date.now() - 30 * 60_000).toISOString())')"
  mkdir -p "$(dirname "$JOURNAL")"
  local current='{"findings":{}}'
  [[ -f "$JOURNAL" ]] && current="$(cat "$JOURNAL")"
  printf '%s' "$current" \
    | jq --arg id "$id" --arg first "$first" \
        '.findings = ((.findings // {}) + {($id): {firstSeenAt: $first, severity: "high"}})' \
    > "$JOURNAL.tmp"
  mv "$JOURNAL.tmp" "$JOURNAL"
}

journal_notified() { [[ -n "$1" ]] && jq -e --arg id "$1" '.findings[$id].lastNotifiedAt // empty | length > 0' "$JOURNAL" >/dev/null 2>&1; }
journal_pruned() { [[ -n "$1" ]] && jq -e --arg id "$1" '(.findings // {}) | has($id) | not' "$JOURNAL" >/dev/null 2>&1; }

journey_start_monitor
# Sum of the bounded waits below (5 + 8 + 6 + 6 + 6 + 10 + 10 + 8 + 10 + 10 + 8).
journey_set_tick_budget 87
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

journey_wait_until "$ISSUE" 8  "coding launched" phase_is coding
journey_wait_until "$ISSUE" 6  "fake coder is parked before its commit" \
  test -f "$FAKE_ROOT/attention-coding-waiting"
journey_wait_until "$ISSUE" 6  "the mill wrote the attention projection" projection_ready
journey_wait_until "$ISSUE" 6  "the projection holds no task escalation yet" no_escalation_item

# An Observer pass with only the free (non-task) signal: no push.
cp "$ATTENTION_FILE" "$OBSERVED_BEFORE"
run_observer_once
SINK_AFTER_ONCE="$(sink_count)"

FD="$(journey_feature_dir "$ISSUE")"
HEAD_AT_ESCALATION="$(git -C "$FD" rev-parse HEAD)"
escalate_now "$FD" "$HEAD_AT_ESCALATION"
journey_log "escalated $ISSUE at $HEAD_AT_ESCALATION (operator-decision:review-session-interrupted-pre-pr)"

journey_wait_until "$ISSUE" 10 "the projection shows the escalation" has_escalation_item
cp "$ATTENTION_FILE" "$OBSERVED_AT_ESCALATION"
ITEM_ID="$(escalation_item_id)"
seed_journal "$ITEM_ID"
start_observer_loop
journey_wait_until "$ISSUE" 10 "the Observer pushed the task escalation" \
  bash -c '[[ "$(wc -l < "$1" 2>/dev/null | tr -d " ")" -ge 1 ]]' _ "$PUSH_CAPTURE"
journey_wait_until "$ISSUE" 8  "the alert journal recorded the push for $ITEM_ID" journal_notified "$ITEM_ID"

# The coder's ordinary commit moves the head: the HOK-3172 reconciler expires
# the escalation condition and the projection stops carrying the item.
touch "$FAKE_ROOT/attention-coding-release"
journey_wait_until "$ISSUE" 10 "the escalation marker expired on the new head" marker_gone
journey_wait_until "$ISSUE" 10 "a newer projection no longer holds the item" \
  bash -c '! jq -e --arg id "$3" "[.items[] | select(.id == \$id)] | length > 0" "$1" >/dev/null' \
  _ "$ATTENTION_FILE" "$ITEM_ID"
journey_wait_until "$ISSUE" 8  "an Observer pass after expiry pruned the journal entry" journal_pruned "$ITEM_ID"

echo ""
echo "assertions:"
journey_assert "with no task escalation the projection still carried the openrouter free item" \
  journey_jq_true '.items | map(select(.kind == "openrouter")) | length == 1' "$OBSERVED_BEFORE"
journey_assert "the free item is non-task (no taskId) and is never pushed" \
  journey_jq_true '.items | map(select(.kind == "openrouter") | has("taskId") | not) | all' "$OBSERVED_BEFORE"
journey_assert "one Observer pass with no task item pushed nothing" test "$SINK_AFTER_ONCE" = "0"
journey_assert "exactly one task item was projected: operator-decision for $ISSUE" \
  journey_jq_true --arg id "$ISSUE" \
    '[.items[] | select(.taskId == $id) | .kind] == ["operator-decision"]' "$OBSERVED_AT_ESCALATION"
journey_assert "the projected item carries \`.needs-attention\` as its evidence" \
  journey_jq_true --arg id "$ISSUE" \
    '[.items[] | select(.taskId == $id) | .evidence[].source] | index(".needs-attention") != null' \
    "$OBSERVED_AT_ESCALATION"
journey_assert "exactly one push reached the sink" test "$(sink_count)" = "1"
journey_assert "the push carried the item's title (task-scoped)" \
  bash -c 'jq -r ".headers.title // .headers.Title" "$1" | grep -q "^\[high\] .*$2"' _ "$PUSH_CAPTURE" "$ISSUE"
journey_assert "the push carried the item's own operator command" \
  bash -c 'jq -r ".body" "$1" | grep -q "abort $2"' _ "$PUSH_CAPTURE" "$ISSUE"
journey_assert "the escalation marker is gone after the head moved" marker_gone
journey_assert "the item is gone from a newer projection" \
  bash -c '! jq -e --arg id "$2" "[.items[] | select(.id == \$id)] | length > 0" "$1" >/dev/null' _ "$ATTENTION_FILE" "$ITEM_ID"
journey_assert "the journal pruned the item (an Observer pass ran after expiry)" journal_pruned "$ITEM_ID"
journey_assert "no further push fired after expiry" test "$(sink_count)" = "1"

journey_finish
