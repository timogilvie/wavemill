#!/usr/bin/env bash
# Golden journey (HOK-3457): a review scope stop is recorded as a typed
# marker and routed through the shared primitives back to coding with no
# operator touch.
#
# The journey has two acts:
#
#   Act A — Shell classifier (replays stage_failure_decision's scope-stop
#   early branch against fixture markers). The monitor's body is sourced-
#   at-load (it drops into the main loop), so this journey replays the
#   exact jq pipeline + marker-validity gate from wavemill-monitor.sh's
#   scope-stop branch inline. If the production pipeline changes shape,
#   this journey must change with it.
#
#   Act B — TS decider (drives `decideReviewGateRemediation` against the
#   recorded HOK-3358 scope-stop marker and asserts the agent-delivered
#   code-failure disposition that routes the task back to coding).
#
# Protects against the HOK-3358 / HOK-3231 / HOK-3422 silent-stall class:
# the pre-HOK-3457 outcome had the review scope guard refuse the diff, the
# prompt told the agent to "stop review-fix committing", and the monitor
# never saw the scope stop as a code failure. The task sat idle until an
# operator made the coding correction by hand.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP review-scope-stop journey: $reason"
  exit 0
fi

journey_init review-scope-stop
journey_set_tick_budget 1

# ── Act A: scope-stop classifier (shell) ──────────────────────────────────

# shellcheck source=/dev/null
source "$JOURNEY_INSTALL_DIR/shared/lib/transient-marker.sh"

# Replica of the scope-stop classifier branch in stage_failure_decision
# (shared/lib/wavemill-monitor.sh). Prints the decision JSON (exit 0) when
# a valid, head-matching marker is present; silent exit 1 otherwise.
classify_scope_stop() {
  local feature_dir="$1" current_head="$2"
  local scope_stop_file="$feature_dir/.review-scope-stop.json"
  [[ -f "$scope_stop_file" ]] || return 1
  [[ -n "$current_head" ]] || return 1
  local marker_json
  marker_json="$(marker_read "$scope_stop_file" 2>/dev/null || true)"
  [[ -n "$marker_json" ]] || return 1
  if marker_is_stale "$scope_stop_file" "$current_head"; then
    return 1
  fi
  local head_sha findings offending_paths code_failure_excerpt marker_detail scope_fp
  head_sha="$(jq -r '.headSha // empty' <<<"$marker_json")"
  findings="$(jq -c '.detail.findings // []' <<<"$marker_json")"
  offending_paths="$(jq -c '.detail.offendingPaths // []' <<<"$marker_json")"
  code_failure_excerpt="$(jq -r '[.detail.findings[]? | if (.message // empty) == "" then (.offendingPath // empty) else "\(.offendingPath // ""): \(.message)" end | select(length>0)] | join("; ")' <<<"$marker_json")"
  [[ -n "$code_failure_excerpt" ]] || code_failure_excerpt="review scope violation"
  marker_detail="$(jq -r '.detail.reason // .reason // "review scope violation"' <<<"$marker_json")"
  scope_fp="$(printf '%s|%s|%s' "$head_sha" "$findings" "$offending_paths" | cksum | awk '{print $1}')"
  jq -nc \
    --arg excerpt "$code_failure_excerpt" \
    --arg detail "$marker_detail" \
    --arg fingerprint "$scope_fp" \
    '{class:"code-failure",failureKind:"review-scope-stop",codeFailureExcerpt:$excerpt,rationale:"review scope guard refused staged/committed paths",nextAction:"coding stage must either narrow the diff to the declared scope or widen the plan'\''s Scope In",attribution:"unattributed",detail:$detail,handoffReason:"",envelopeCause:"",envelopeModel:"",fingerprint:$fingerprint}'
}

# Case 1 — marker present, head matches → code-failure/review-scope-stop
feature_dir="$JOURNEY_TMP/classifier-case1"
mkdir -p "$feature_dir"
HEAD_MATCH="0000000000000000000000000000000000003358"
marker_write "$feature_dir/.review-scope-stop.json" \
  --kind review-scope-stop --head "$HEAD_MATCH" \
  --reason "review scope guard refused staged/committed paths" \
  --detail-json '{"findings":[{"category":"scope-violation","offendingPath":"shared/lib/wavemill-monitor.sh","message":"Unexpected review change outside task scope"}],"offendingPaths":["shared/lib/wavemill-monitor.sh"]}' \
  --expires-on head,operator-event
decision="$(classify_scope_stop "$feature_dir" "$HEAD_MATCH" || true)"
journey_assert "case 1: marker + head match → code-failure/review-scope-stop" \
  bash -c '[[ -n "$1" ]] && [[ "$(jq -r .class <<<"$1")" == "code-failure" ]] && [[ "$(jq -r .failureKind <<<"$1")" == "review-scope-stop" ]] && [[ "$(jq -r .codeFailureExcerpt <<<"$1")" == *"shared/lib/wavemill-monitor.sh"* ]]' \
    _ "$decision"

# Case 2 — marker present, head mismatches → fall through
feature_dir="$JOURNEY_TMP/classifier-case2"
mkdir -p "$feature_dir"
marker_write "$feature_dir/.review-scope-stop.json" \
  --kind review-scope-stop --head "1111111111111111111111111111111111111111" \
  --reason r --detail-json '{"findings":[{"category":"scope-violation","offendingPath":"x","message":"y"}],"offendingPaths":["x"]}' \
  --expires-on head,operator-event
decision="$(classify_scope_stop "$feature_dir" "2222222222222222222222222222222222222222" || true)"
journey_assert "case 2: marker + head mismatch → fall through" test -z "$decision"

# Case 3 — no marker file → fall through
feature_dir="$JOURNEY_TMP/classifier-case3"
mkdir -p "$feature_dir"
decision="$(classify_scope_stop "$feature_dir" "$HEAD_MATCH" || true)"
journey_assert "case 3: no marker → fall through" test -z "$decision"

# Case 4 — malformed marker JSON → fall through
feature_dir="$JOURNEY_TMP/classifier-case4"
mkdir -p "$feature_dir"
printf 'this is not valid json\n' > "$feature_dir/.review-scope-stop.json"
decision="$(classify_scope_stop "$feature_dir" "$HEAD_MATCH" || true)"
journey_assert "case 4: malformed marker → fall through" test -z "$decision"

# Case 5 — empty current head → fall through (never compare blank)
feature_dir="$JOURNEY_TMP/classifier-case5"
mkdir -p "$feature_dir"
marker_write "$feature_dir/.review-scope-stop.json" \
  --kind review-scope-stop --head "$HEAD_MATCH" \
  --reason r --detail-json '{"findings":[],"offendingPaths":[]}' \
  --expires-on head,operator-event
decision="$(classify_scope_stop "$feature_dir" "" || true)"
journey_assert "case 5: empty current head → fall through" test -z "$decision"

# Case 6 — JSON escape: reason with embedded quotes stays valid JSON
feature_dir="$JOURNEY_TMP/classifier-case6"
mkdir -p "$feature_dir"
marker_write "$feature_dir/.review-scope-stop.json" \
  --kind review-scope-stop --head "$HEAD_MATCH" \
  --reason 'has "quotes" inside' \
  --detail-json '{"findings":[{"category":"scope-violation","offendingPath":"a\"b.ts","message":"path has a \"quote\""}],"offendingPaths":["a\"b.ts"],"reason":"has \"quotes\" inside"}' \
  --expires-on head,operator-event
decision="$(classify_scope_stop "$feature_dir" "$HEAD_MATCH" || true)"
journey_assert "case 6: embedded quotes in reason → valid JSON" \
  bash -c '[[ -n "$1" ]] && jq -e . <<<"$1" >/dev/null 2>&1 && [[ "$(jq -r .detail <<<"$1")" == '\''has "quotes" inside'\'' ]]' \
    _ "$decision"

# ── Act B: TS decider against the recorded HOK-3358 marker ────────────────

FIXTURE_DIR="$JOURNEY_INSTALL_DIR/tests/fixtures/incident-replay/real/hok3358-scope-stall"
RESULT="$JOURNEY_TMP/review-scope-stop.json"

(cd "$JOURNEY_INSTALL_DIR" && node --import tsx --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { decideReviewGateRemediation } from './shared/lib/review-gate-remediation.ts';
  const marker = JSON.parse(readFileSync('$FIXTURE_DIR/scope-stop-marker.json', 'utf-8'));
  const decision = decideReviewGateRemediation({
    stage: 'review',
    stateDir: '/tmp/review-scope-stop-journey',
    headSha: marker.headSha,
    findings: marker.detail.findings,
    artifact: { kind: 'review-result', identity: 'hok3358-journey' },
  });
  console.log(JSON.stringify({
    disposition: decision.disposition,
    deliverTo: decision.deliverTo,
    offendingPath: decision.deliveryPayload?.finding.offendingPath,
    operatorTouches: decision.deliverTo === 'operator' ? 1 : 0,
  }));
" > "$RESULT")

journey_assert "scope stop routes back to coding (code-failure, delivered to agent)" \
  jq -e '.disposition == "code-failure" and .deliverTo == "agent"' "$RESULT"
journey_assert "the offending path is carried forward to the coding prompt" \
  jq -e '.offendingPath == "shared/lib/wavemill-monitor.sh"' "$RESULT"
journey_assert "zero operator touches to recover from the scope stop" \
  jq -e '.operatorTouches == 0' "$RESULT"
journey_finish
