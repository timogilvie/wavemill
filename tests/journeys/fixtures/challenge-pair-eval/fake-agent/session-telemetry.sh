# shellcheck shell=bash
# Review telemetry for the challenge-pair journey's fake agent (sourced by review).
#
# A challenge arm only passes Ready once its PR route stamp is complete, which
# needs the same execution evidence a real Claude Code run leaves behind: the
# transcript of the session the launcher recorded (executed-model-resolver.ts
# reads only owned sessions, HOK-3328) — the shared fake writes that, with
# the launched model — and for review the analysis identity
# review-changes.ts records (.review-analysis-identity.json, HOK-3247), which
# the shared fake does not; without it a pair would be retired as
# invalid_challenge:ready-transition-failed.

# The model this launch was started with (`claude --model <id> …`).
fake_launch_model() {
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

# fake_review_analysis_identity <model>: what review-changes.ts records for
# the head it reviewed.
fake_review_analysis_identity() {
  local model="$1"
  jq -n --arg model "$model" --arg head "$(git rev-parse HEAD)" --arg at "$(date -u +%FT%TZ)" '{
    schemaVersion: 1, headSha: $head, recordedAt: $at,
    substantiveAnalysis: {
      role: "substantive_analysis", requestedModel: $model, resolvedModel: $model,
      agent: "claude", source: "artifact", pinned: true
    }
  }' > "$FEATURE_DIR/.review-analysis-identity.json"
}

FAKE_MODEL="$(fake_launch_model "$@" || echo unknown)"
