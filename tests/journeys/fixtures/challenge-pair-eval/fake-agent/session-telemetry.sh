# shellcheck shell=bash
# Session telemetry for the challenge-pair journey's fake agent.
#
# A challenge arm only passes Ready once its PR route stamp is complete, which
# needs the same execution evidence a real Claude Code run leaves behind: the
# session transcript the mill reads to resolve the executed model
# (executed-model-resolver.ts, under $HOME/.claude/projects/<worktree>/), and
# for review the analysis identity review-changes.ts records
# (.review-analysis-identity.json, HOK-3247). The shared fake writes neither,
# so a pair would be retired as invalid_challenge:ready-transition-failed.

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

# fake_session_turn <model>: append one assistant turn on this branch to the
# worktree's Claude Code session transcript.
fake_session_turn() {
  local model="$1" projects_dir now
  projects_dir="$(cd "$FAKE_AGENT_TOOLS_DIR/.." && node --import tsx -e '
    const { resolveProjectsDir } = await import("./shared/lib/wavemill-session-paths.ts");
    console.log(resolveProjectsDir(process.argv[1]));
  ' "$WT")"
  mkdir -p "$projects_dir"
  now="$(node -e 'console.log(new Date().toISOString())')"
  jq -cn --arg model "$model" --arg branch "$(git rev-parse --abbrev-ref HEAD)" --arg cwd "$WT" \
    --arg ts "$now" --arg session "fake-$WAVEMILL_ISSUE-$WAVEMILL_PHASE" --arg uuid "$WAVEMILL_PHASE-$RANDOM$RANDOM" '{
      type: "assistant", sessionId: $session, uuid: $uuid, isSidechain: false,
      timestamp: $ts, gitBranch: $branch, cwd: $cwd,
      message: {model: $model, usage: {input_tokens: 10, output_tokens: 5}}
    }' >> "$projects_dir/fake-$WAVEMILL_ISSUE-$WAVEMILL_PHASE.jsonl"
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
fake_session_turn "$FAKE_MODEL"
