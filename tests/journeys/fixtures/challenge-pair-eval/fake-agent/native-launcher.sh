# shellcheck shell=bash
# HOK-3369: emulate the native launcher's on-disk contract so the stage
# result retains the executed-model record a real native run would leave
# (ownership row + session stream + direct provider-response stage result).
# Used by the native-arm-evidence journey (JOURNEY_NATIVE_ARM_EVIDENCE=1):
# the challenger pretends to be a native OpenRouter arm so every stage
# write produces attribution-eligible evidence.

# The model this launch was started with (`claude --model <id> …`).
fake_native_launch_model() {
  local prev=""
  for arg in "$@"; do
    if [[ "$prev" == "--model" ]]; then
      printf '%s\n' "$arg"
      return 0
    fi
    prev="$arg"
  done
  return 1
}

# Append one native-arm ownership row for the given stage.
fake_native_ownership_row() {
  local state_dir="$1" stage="$2" session_ref="$3" model="$4"
  mkdir -p "$state_dir"
  local launched_at epoch head attempt_id
  epoch="$(date -u +%s)"
  launched_at="$(date -u -r "$epoch" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
    || date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null)"
  head="$(git rev-parse HEAD 2>/dev/null | cut -c1-7 || echo nohead)"
  [[ -n "$head" ]] || head="nohead"
  attempt_id="native-arm@${head}#${epoch}"
  jq -nc \
    --arg sessionRef "$session_ref" --arg stage "$stage" \
    --arg model "$model" --arg launchedAt "$launched_at" \
    --arg attemptId "$attempt_id" --arg cwd "$PWD" \
    '{schemaVersion: 1, type: "launch", sessionRef: $sessionRef,
      harness: "native", kind: "native-arm", stage: $stage,
      model: $model, launchedAt: $launchedAt, attemptId: $attemptId, cwd: $cwd}' \
    >> "$state_dir/.session-ownership.jsonl"
}

# Write a session_started + N echoed-responseId assistant_message events, so
# the resolver verdicts the stream as `match` for the non-alias wire id.
fake_native_session_stream() {
  local repo_dir="$1" stage="$2" issue="$3" session_ref="$4" model="$5" turns="${6:-5}"
  local runs_dir="$repo_dir/.wavemill/runs/wavemill/native-sessions"
  mkdir -p "$runs_dir"
  local safe_issue stream_file ts_ms
  safe_issue="${issue//[^A-Za-z0-9._-]/-}"
  stream_file="$runs_dir/${stage}-${safe_issue}.jsonl"
  ts_ms="$(($(date +%s) * 1000))"
  : > "$stream_file"
  jq -nc --arg sessionId "$session_ref" --arg model "$model" --argjson ts "$ts_ms" '{
    seq: 0, sessionId: $sessionId, timestamp: $ts,
    type: "session_started", model: $model,
    provider: "openrouter", api: "openai-completions"
  }' >> "$stream_file"
  local i
  for ((i = 0; i < turns; i++)); do
    local seq="$((i + 1))" turn_ts="$((ts_ms + 1000 * (i + 1)))"
    jq -nc --arg sessionId "$session_ref" --arg model "$model" \
      --argjson seq "$seq" --argjson ts "$turn_ts" \
      --arg rid "gen-${issue}-${i}" '{
      seq: $seq, sessionId: $sessionId, timestamp: $ts,
      type: "assistant_message", model: $model, stopReason: "end_turn",
      rawContent: [], replayContent: [], redacted: true, responseId: $rid
    }' >> "$stream_file"
  done
}

# Write the launcher's direct / provider-response stage result for the given
# stage. Keeps `awaiting_user` for planning (approval), `completed` otherwise.
fake_native_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" model="$4" started_at="$5"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  local finished_at='null'
  [[ "$status" == 'awaiting_user' ]] || finished_at="\"$now\""
  jq -n \
    --arg stage "$stage" --arg status "$status" \
    --arg startedAt "$started_at" --argjson finishedAt "$finished_at" \
    --arg agent "native-openrouter" --arg model "$model" \
    --arg notes "Native ${stage} ready" \
    --arg detail "fake-native-launcher: verified match" \
    --arg recordedAt "$now" '{
      stage: $stage, status: $status, startedAt: $startedAt,
      finishedAt: $finishedAt, agent: $agent, model: $model,
      intendedModel: $model, executedModel: $model,
      executionEvidence: {
        status: "direct", source: "provider-response",
        detail: $detail, recordedAt: $recordedAt,
        identityVerdict: "match", requestedWireId: $model,
        certifiedTarget: $model, transportProvider: "openrouter",
        responseId: ("gen-" + $stage)
      },
      modelAttributionEligible: (if $status == "completed" then true else false end),
      notes: $notes
    } +
    (if $status == "completed" then {}
     else {modelAttributionIneligibleReason: "stage_not_completed"} end)' \
    > "$feature_dir/.${stage}-result.json.tmp"
  mv "$feature_dir/.${stage}-result.json.tmp" "$feature_dir/.${stage}-result.json"
}

# Entry point sourced by each stage script: emits the three artifacts
# before the shared default runs. Called only when the issue is the
# challenger (so the primary stays on the normal claude path).
fake_native_launcher_emit() {
  local stage="$1"
  shift
  local model
  model="$(fake_native_launch_model "$@" || echo "moonshotai/kimi-k2-thinking")"
  local session_ref="wavemill-${stage}-${WAVEMILL_ISSUE}"
  local started_at
  started_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  local repo_dir="${WAVEMILL_MILLED_REPO_DIR:-${REPO_DIR:-$FAKE_AGENT_TOOLS_DIR/..}}"

  fake_native_ownership_row "$FEATURE_DIR" "$stage" "$session_ref" "$model"
  fake_native_session_stream "$repo_dir" "$stage" "$WAVEMILL_ISSUE" "$session_ref" "$model" 5

  case "$stage" in
    planning) fake_native_stage_result "$FEATURE_DIR" planning awaiting_user "$model" "$started_at" ;;
    coding)   fake_native_stage_result "$FEATURE_DIR" coding    running      "$model" "$started_at" ;;
    review)   fake_native_stage_result "$FEATURE_DIR" review    running      "$model" "$started_at" ;;
  esac
}
