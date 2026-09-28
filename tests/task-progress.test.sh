#!/usr/bin/env bash
# HOK-3101 — shell parity + integration test for the task-progress primitive.
#
# Verifies:
#   - wavemill_hook_write with writer=agent then writer=monitor preserves
#     .agentRecord (HOK-3089 pt 3);
#   - a subsequent agent write REPLACES agentRecord;
#   - wavemill_hook_read --agent-only skips a monitor top-level;
#   - task_progress_cached_json returns {} for a stale cache and the
#     payload for a fresh one;
#   - CLI output on the same hook fixture agrees with the shell accessor.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$REPO_DIR:$PATH"

pass=0
fail=0
current_test=""
_pass() { echo "  PASS  ${current_test}${1:+ — $1}"; pass=$((pass + 1)); }
_fail() { echo "  FAIL  ${current_test}${1:+ — $1}"; fail=$((fail + 1)); }
_case() { current_test="$1"; }

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"; rm -f "/tmp/wavemill-hok3101test-TP-1.hook" "/tmp/wavemill-hok3101test-TP-1.progress.json"' EXIT

# shellcheck source=../shared/hooks/wavemill-hook-protocol.sh
source "$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"
# shellcheck source=../shared/lib/task-progress.sh
source "$REPO_DIR/shared/lib/task-progress.sh"

export WAVEMILL_SESSION=hok3101test
export WAVEMILL_ISSUE=TP-1

_case "agent write then monitor pr_merged preserves agentRecord"
wavemill_hook_write "idle" "Stop" "" "claude" "" "agent"
sleep 1
wavemill_hook_write "idle" "pr_merged" "PR #123 merged" "claude" "" "monitor"
hook_file="/tmp/wavemill-hok3101test-TP-1.hook"
top_state="$(jq -r '.state' "$hook_file")"
top_event="$(jq -r '.event' "$hook_file")"
top_writer="$(jq -r '.writer' "$hook_file")"
rec_state="$(jq -r '.agentRecord.state' "$hook_file")"
rec_event="$(jq -r '.agentRecord.event' "$hook_file")"
if [[ "$top_writer" == "monitor" && "$top_event" == "pr_merged" \
   && "$rec_state" == "idle" && "$rec_event" == "Stop" ]]; then
  _pass
else
  _fail "top=$top_state:$top_event writer=$top_writer agentRecord=$rec_state:$rec_event"
fi

_case "another agent write REPLACES agentRecord"
sleep 1
wavemill_hook_write "working" "PreToolUse" "Read" "claude" "" "agent"
rec_state="$(jq -r '.agentRecord.state' "$hook_file")"
rec_event="$(jq -r '.agentRecord.event' "$hook_file")"
if [[ "$rec_state" == "working" && "$rec_event" == "PreToolUse" ]]; then
  _pass
else
  _fail "agentRecord=$rec_state:$rec_event"
fi

_case "wavemill_hook_read --agent-only returns the agentRecord fields"
# Set up a monitor top-level with an agent Stop record
rm -f "$hook_file"
wavemill_hook_write "idle" "Stop" "" "claude" "" "agent"
sleep 1
wavemill_hook_write "idle" "pr_merged" "" "claude" "" "monitor"
top_state_read="$(wavemill_hook_read hok3101test TP-1 state 2>/dev/null || true)"
agent_state_read="$(wavemill_hook_read hok3101test TP-1 state --agent-only 2>/dev/null || true)"
agent_event_read="$(wavemill_hook_read hok3101test TP-1 event --agent-only 2>/dev/null || true)"
if [[ "$top_state_read" == "idle" && "$agent_state_read" == "idle" && "$agent_event_read" == "Stop" ]]; then
  _pass
else
  _fail "top=$top_state_read agent=$agent_state_read:$agent_event_read"
fi

_case "wavemill_hook_read --agent-only --fresh skips a stale record"
# Timestamp is now; skip by TTL=0
WAVEMILL_HOOK_TTL_SECONDS=0 result="$(wavemill_hook_read hok3101test TP-1 state --fresh --agent-only 2>/dev/null || true)"
if [[ -z "$result" ]]; then
  _pass
else
  _fail "got '$result'"
fi

_case "wavemill_hook_read on a legacy monitor pr_merged (no writer field) is skipped by --agent-only"
# Build a legacy hook by hand
cat > "$hook_file" <<JSON
{
  "state": "idle",
  "event": "pr_merged",
  "agent": "claude",
  "timestamp": $(date +%s),
  "detail": "PR closed"
}
JSON
agent_state_read="$(wavemill_hook_read hok3101test TP-1 state --agent-only 2>/dev/null || true)"
top_state_read="$(wavemill_hook_read hok3101test TP-1 state 2>/dev/null || true)"
if [[ -z "$agent_state_read" && "$top_state_read" == "idle" ]]; then
  _pass
else
  _fail "agent-only='$agent_state_read' top='$top_state_read'"
fi

_case "task_progress_cached_json returns {} on missing cache"
result="$(task_progress_cached_json hok3101test TP-99 60 2>/dev/null || true)"
if [[ "$result" == "{}" ]]; then
  _pass
else
  _fail "got '$result'"
fi

_case "task_progress_cached_json returns {} when cache is stale"
cache_file="/tmp/wavemill-hok3101test-TP-1.progress.json"
old_iso="$(date -u -v-1H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "1 hour ago" +"%Y-%m-%dT%H:%M:%SZ")"
printf '{"computedAt":"%s","stalled":false}\n' "$old_iso" > "$cache_file"
result="$(task_progress_cached_json hok3101test TP-1 60 2>/dev/null | jq -r '. // empty' 2>/dev/null || true)"
if [[ "$result" == "{}" ]] || [[ "$result" == "" ]]; then
  _pass
else
  _fail "expected {} got '$result'"
fi

_case "task_progress_cached_json returns the payload for a fresh cache"
new_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
printf '{"computedAt":"%s","stalled":true}\n' "$new_iso" > "$cache_file"
result="$(task_progress_cached_json hok3101test TP-1 300 2>/dev/null | jq -r '.stalled' 2>/dev/null || true)"
if [[ "$result" == "true" ]]; then
  _pass
else
  _fail "got '$result'"
fi

_case "shell accessor and TS CLI agree on agent record for a monitor pr_merged fixture"
# Fresh: agent Stop then monitor pr_merged
rm -f "$hook_file"
wavemill_hook_write "idle" "Stop" "" "claude" "" "agent"
sleep 1
wavemill_hook_write "idle" "pr_merged" "" "claude" "" "monitor"
shell_agent_state="$(wavemill_hook_read hok3101test TP-1 state --agent-only 2>/dev/null || true)"
shell_agent_event="$(wavemill_hook_read hok3101test TP-1 event --agent-only 2>/dev/null || true)"
cli_json="$(cd "$REPO_DIR" && npx tsx tools/task-progress.ts --issue TP-1 --session hok3101test 2>&1 || true)"
cli_agent_state="$(printf '%s' "$cli_json" | jq -r '.agentRecord.state // empty' 2>/dev/null || true)"
cli_agent_event="$(printf '%s' "$cli_json" | jq -r '.agentRecord.event // empty' 2>/dev/null || true)"
if [[ "$shell_agent_state" == "$cli_agent_state" && "$shell_agent_event" == "$cli_agent_event" ]]; then
  _pass "shell=$shell_agent_state:$shell_agent_event cli=$cli_agent_state:$cli_agent_event"
else
  _fail "shell=$shell_agent_state:$shell_agent_event cli=$cli_agent_state:$cli_agent_event"
fi

echo ""
echo "task-progress shell tests: $pass passed, $fail failed"
if (( fail > 0 )); then
  exit 1
fi
exit 0
