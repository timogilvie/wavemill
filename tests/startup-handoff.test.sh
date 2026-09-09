#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
RUNNER_SCRIPT="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

dump_file_on_failure() {
  local label="$1"
  local path="$2"
  echo "    --- $label: $path ---"
  if [[ -f "$path" ]]; then
    sed 's/^/    /' "$path"
  else
    echo "    (missing)"
  fi
  echo "    --- end $label ---"
}

wait_for_jq_match() {
  local expr="$1"
  local path="$2"
  local attempts="${3:-20}"
  local delay="${4:-0.1}"
  local i

  for ((i = 1; i <= attempts; i++)); do
    if jq -e "$expr" "$path" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done

  return 1
}

make_mock_bin() {
  local dir="$1"
  mkdir -p "$dir"

  cat > "$dir/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'tmux %s\n' "$*" >> "${MOCK_TMUX_LOG:?}"
case "${1:-}" in
  list-panes)
    printf '0\n'
    ;;
  *)
    ;;
esac
EOF
  chmod +x "$dir/tmux"

  cat > "$dir/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >> "${MOCK_GIT_LOG:?}"
if [[ "${1:-}" == "show-ref" ]]; then
  exit 1
fi
if [[ "${1:-}" == "worktree" && "${2:-}" == "add" ]]; then
  wt_dir="${3:-}"
  if [[ -n "${FAIL_WORKTREE_MATCH:-}" && "$wt_dir" == *"$FAIL_WORKTREE_MATCH"* ]]; then
    exit 1
  fi
  mkdir -p "$wt_dir"
  exit 0
fi
exit 0
EOF
  chmod +x "$dir/git"

  cat > "$dir/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >> "${MOCK_GH_LOG:?}"
if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
  printf '[]\n'
  exit 0
fi
exit 1
EOF
  chmod +x "$dir/gh"

  cat > "$dir/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npx %s\n' "$*" >> "${MOCK_NPX_LOG:?}"
if [[ "$*" == *"set-issues-state.ts"* ]]; then
  state="In Progress"
  issues=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --state)
        state="${2:-}"
        shift 2
        ;;
      -*)
        shift
        ;;
      *)
        issues+=("$1")
        shift
        ;;
    esac
  done
  for issue in "${issues[@]}"; do
    printf '%s|%s\n' "$issue" "$state" >> "${MOCK_LINEAR_LOG:?}"
  done
elif [[ "$*" == *"set-issue-state.ts"* ]]; then
  printf '%s|%s\n' "${3:-}" "${4:-}" >> "${MOCK_LINEAR_LOG:?}"
fi
exit 0
EOF
  chmod +x "$dir/npx"

  cat > "$dir/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then
  exit 0
fi
cat >/dev/null || true
exit 0
EOF
  chmod +x "$dir/claude"
}

write_plan() {
  local plan_file="$1"
  local repo_dir="$2"
  local state_dir="$3"
  local state_file="$4"
  local session="$5"
  local monitor_env="$6"
  local monitor_script="$7"
  local status_log="$8"
  local launched_file="$9"
  local tasks_json="${10}"

  jq -n \
    --arg session "$session" \
    --arg repoDir "$repo_dir" \
    --arg baseBranch "main" \
    --arg worktreeRoot "$repo_dir/worktrees" \
    --arg planningMode "interactive" \
    --arg agentCmd "claude" \
    --arg stateDir "$state_dir" \
    --arg stateFile "$state_file" \
    --arg toolsDir "$repo_dir/tools" \
    --arg libDir "$repo_dir/shared/lib" \
    --arg initialPhase "planning" \
    --arg statusLogFile "$status_log" \
    --arg monitorEnv "$monitor_env" \
    --arg monitorScript "$monitor_script" \
    --arg launchedIssuesFile "$launched_file" \
    --argjson tasks "$tasks_json" \
    '{
      session: $session,
      repoDir: $repoDir,
      baseBranch: $baseBranch,
      worktreeRoot: $worktreeRoot,
      planningMode: $planningMode,
      agentCmd: $agentCmd,
      agentCmdExplicit: false,
      forceModel: null,
      routerEnabled: true,
      maxParallel: 2,
      stateDir: $stateDir,
      stateFile: $stateFile,
      toolsDir: $toolsDir,
      libDir: $libDir,
      initialPhase: $initialPhase,
      startupConfig: {
        statusLogFile: $statusLogFile,
        monitorEnv: $monitorEnv,
        monitorScript: $monitorScript,
        launchedIssuesFile: $launchedIssuesFile
      },
      monitorConfig: {
        pollSeconds: 30,
        requireConfirm: true,
        dryRun: false,
        projectName: "Hokusai",
        autoEval: true,
        dashboardVerbosity: "info",
        dashboardLogToFile: true
      },
      tasks: $tasks
    }' > "$plan_file"
}

echo "=== Startup Handoff Regression Guards ==="

if [[ ! -f "$MILL_SCRIPT" || ! -f "$RUNNER_SCRIPT" || ! -f "$MONITOR_SCRIPT_FILE" ]]; then
  fail "required mill/startup-runner/monitor scripts are missing"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

PRE_TMUX_BLOCK="$(awk '
  /^LAUNCH_ARGS=\(\)$/ { capture=1 }
  /^# Now attach to the session$/ { capture=0 }
  capture { print }
' "$MILL_SCRIPT")"

OUTER_PRE_HANDOFF_BLOCK="$(awk '
  /^LAUNCH_ARGS=\(\)$/ { capture=1 }
  /^cp "\$SCRIPT_DIR\/wavemill-monitor\.sh" "\$MONITOR_SCRIPT"$/ { capture=0 }
  capture { print }
' "$MILL_SCRIPT")"

if [[ "$PRE_TMUX_BLOCK" == *'write_launch_plan "$LAUNCH_PLAN_FILE"'* ]] \
  && [[ "$PRE_TMUX_BLOCK" == *'create_tmux_session'* ]]; then
  pass "mill writes the launch plan and creates tmux before startup handoff"
else
  fail "mill is missing the launch-plan handoff or tmux bootstrap"
fi

if [[ "$OUTER_PRE_HANDOFF_BLOCK" == *'linear_set_state'* ]] \
  || [[ "$OUTER_PRE_HANDOFF_BLOCK" == *'set_task_phase'* ]] \
  || [[ "$OUTER_PRE_HANDOFF_BLOCK" == *'save_task_state'* ]]; then
  fail "mill still mutates workflow state before tmux startup"
else
  pass "mill avoids workflow-state and Linear mutations before tmux startup"
fi

WINDOW_RESOLUTION_BLOCK="$(awk '
  /^_tmux_window_target_exists\(\) \{/ { capture=1 }
  /^_ensure_task_window_exists\(\) \{/ { capture=0 }
  capture { print }
' "$MONITOR_SCRIPT_FILE")"

ENSURE_WINDOW_BLOCK="$(awk '
  /^_ensure_task_window_exists\(\) \{/ { capture=1 }
  /^# Relaunch an in-flight task/ { capture=0 }
  capture { print }
' "$MONITOR_SCRIPT_FILE")"

RESTORE_WINDOW_BLOCK="$(awk '
  /^_restore_inflight_task_window_if_missing\(\) \{/ { capture=1 }
  /^# Launch an agent in a tmux window/ { capture=0 }
  capture { print }
' "$MONITOR_SCRIPT_FILE")"

REROUTE_EXPANDED_BLOCK="$(awk '
  /^reroute_expanded_packets_for_coding_handoff\(\) \{/ { capture=1 }
  /^recover_missing_expansion_artifact\(\) \{/ { capture=0 }
  capture { print }
' "$MONITOR_SCRIPT_FILE")"

LAUNCH_PLANNING_BLOCK="$(awk '
  /^launch_planning_phase\(\) \{/ { capture=1 }
  /^# Launch the coding phase/ { capture=0 }
  capture { print }
' "$MONITOR_SCRIPT_FILE")"

LAUNCH_CODING_BLOCK="$(awk '
  /^launch_coding_phase\(\) \{/ { capture=1 }
  /^# Launch the review phase/ { capture=0 }
  capture { print }
' "$MONITOR_SCRIPT_FILE")"

LAUNCH_REVIEW_BLOCK="$(awk '
  /^launch_review_phase\(\) \{/ { capture=1 }
  /^# Restore the operator-facing review window/ { capture=0 }
  capture { print }
' "$MONITOR_SCRIPT_FILE")"

LAUNCH_READY_BLOCK="$(awk '
  /^launch_ready_phase\(\) \{/ { capture=1 }
  /^cleanup_task\(\) \{/ { capture=0 }
  capture { print }
' "$MONITOR_SCRIPT_FILE")"

if [[ "$WINDOW_RESOLUTION_BLOCK" == *'.tasks[$issue].windowId'* ]] \
  && [[ "$WINDOW_RESOLUTION_BLOCK" == *'_tmux_window_target_exists "$session" "$stored_target" "$wt_dir"'* ]] \
  && [[ "$WINDOW_RESOLUTION_BLOCK" == *'pane_current_path'* ]]; then
  pass "task window resolution checks persisted windowId and worktree before canonical name"
else
  fail "task window resolution does not prefer a worktree-validated persisted windowId"
fi

if [[ "$WINDOW_RESOLUTION_BLOCK" == *'issue_number="${issue##*-}"'* ]] \
  && [[ "$WINDOW_RESOLUTION_BLOCK" == *'issue_number " · " slug'* ]] \
  && [[ "$WINDOW_RESOLUTION_BLOCK" == *'canonical="${issue}-${slug}"'* ]]; then
  pass "task window resolution falls back from persisted id to renamed titles before canonical names"
else
  fail "task window resolution is missing renamed title fallback ordering"
fi

if [[ "$RESTORE_WINDOW_BLOCK" == *'_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir"'* ]] \
  && [[ "$RESTORE_WINDOW_BLOCK" == *'-f "$feature_dir/.coding-complete"'* ]] \
  && [[ "$RESTORE_WINDOW_BLOCK" == *'launch_review_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH"'* ]] \
  && [[ "$RESTORE_WINDOW_BLOCK" != *'grep -qxF "$win"'* ]]; then
  pass "resume restore treats renamed task windows as existing via stable windowId"
else
  fail "resume restore still relies on canonical tmux window names"
fi

if [[ "$ENSURE_WINDOW_BLOCK" == *'coding_pane_replacement_intent_matches "$issue" "$slug" "$feature_dir" "$lifecycle_phase"'* ]] \
  && [[ "$ENSURE_WINDOW_BLOCK" == *'log "status" "  Window $canonical intentionally quarantined after coding, creating fresh review window"'* ]] \
  && [[ "$ENSURE_WINDOW_BLOCK" == *'clear_coding_pane_replacement_intent "$feature_dir"'* ]] \
  && [[ "$ENSURE_WINDOW_BLOCK" == *'log_warn "  Window $canonical missing, recreating..." >&2'* ]]; then
  pass "expected coding-pane replacement is informational while missing-window recovery still warns"
else
  fail "task window creation does not distinguish expected coding-pane replacement from recovery"
fi

if [[ "$RESTORE_WINDOW_BLOCK" == *'read_state_value "" --arg i "$issue" '\''.tasks[$i].worktree // ""'\'''* ]] \
  && [[ "$RESTORE_WINDOW_BLOCK" == *'[[ -z "$wt_dir" ]] && wt_dir="${WORKTREE_ROOT}/${slug}"'* ]]; then
  pass "resume restore prefers persisted task worktree over WORKTREE_ROOT fallback"
else
  fail "resume restore ignores persisted task worktree"
fi

if [[ "$ENSURE_WINDOW_BLOCK" == *'log_warn "  Window $canonical missing, recreating..." >&2'* ]]; then
  pass "missing-window recovery keeps warning logs out of captured tmux targets"
else
  fail "missing-window recovery can leak warning logs into captured tmux targets"
fi

if [[ "$ENSURE_WINDOW_BLOCK" == *'consume_coding_pane_expected_replacement "$issue" "$slug" "$wt_dir"'* ]] \
  && [[ "$ENSURE_WINDOW_BLOCK" == *'intentionally quarantined after coding'* ]] \
  && [[ "$ENSURE_WINDOW_BLOCK" == *'else'*'log_warn "  Window $canonical missing, recreating..." >&2'* ]]; then
  pass "intentional coding-pane quarantine uses informational replacement logging"
else
  fail "intentional coding-pane quarantine is not distinguished from missing-window recovery"
fi

if [[ "$ENSURE_WINDOW_BLOCK" == *'tmux new-window -d -t "$session" -n "$canonical" -c "$wt_dir"'* ]] \
  && [[ "$ENSURE_WINDOW_BLOCK" == *'tmux set-option -t "$(_tmux_target_join "$session" "$target")" remain-on-exit on'* ]] \
  && [[ "$ENSURE_WINDOW_BLOCK" == *'printf '\''%s\n'\'' "$target"'* ]]; then
  pass "missing-window recovery still recreates a usable task window"
else
  fail "missing-window recovery no longer preserves window recreation behavior"
fi

if [[ "$REROUTE_EXPANDED_BLOCK" == *'sibling_issue sibling_slug sibling_worktree'* ]] \
  && [[ "$REROUTE_EXPANDED_BLOCK" != *'read -r issue slug worktree'* ]]; then
  pass "expanded reroute scan avoids clobbering restore issue variables"
else
  fail "expanded reroute scan can clobber restore issue variables"
fi

if [[ "$LAUNCH_PLANNING_BLOCK" == *'_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")'* ]] \
  && [[ "$LAUNCH_PLANNING_BLOCK" == *'persist_task_window_id "$issue" "$win"'* ]] \
  && [[ "$LAUNCH_PLANNING_BLOCK" == *'_launch_agent_in_pane "$win"'* ]] \
  && [[ "$LAUNCH_PLANNING_BLOCK" != *'_launch_agent_in_pane "$SESSION:$win"'* ]]; then
  pass "planning launch targets stable task window selector"
else
  fail "planning launch does not use stable task window selector"
fi

if [[ "$LAUNCH_CODING_BLOCK" == *'_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")'* ]] \
  && [[ "$LAUNCH_CODING_BLOCK" == *'persist_task_window_id "$issue" "$win"'* ]] \
  && [[ "$LAUNCH_CODING_BLOCK" == *'_launch_agent_in_pane "$win"'* ]] \
  && [[ "$LAUNCH_CODING_BLOCK" != *'_launch_agent_in_pane "$SESSION:$win"'* ]] \
  && [[ "$LAUNCH_REVIEW_BLOCK" == *'_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir" "review")'* ]] \
  && [[ "$LAUNCH_REVIEW_BLOCK" == *'persist_task_window_id "$issue" "$win"'* ]] \
  && [[ "$LAUNCH_REVIEW_BLOCK" == *'_launch_agent_in_pane "$win"'* ]] \
  && [[ "$LAUNCH_REVIEW_BLOCK" != *'_launch_agent_in_pane "$SESSION:$win"'* ]] \
  && [[ "$LAUNCH_READY_BLOCK" == *'persist_task_window_id "$issue" "$win"'* ]] \
  && [[ "$LAUNCH_READY_BLOCK" == *'_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")'* ]]; then
  pass "coding/review/ready launches target stable task window selector"
else
  fail "coding/review/ready launches do not all use stable task window selector"
fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

INTENT_FUNCS="$TMP_ROOT/intent-funcs.sh"
: > "$INTENT_FUNCS"
for fn in \
  coding_pane_replacement_intent_path \
  record_coding_pane_replacement_intent \
  coding_pane_replacement_intent_matches \
  clear_coding_pane_replacement_intent \
  _tmux_window_target_exists \
  _tmux_target_join \
  _tmux_task_window_target \
  _ensure_task_window_exists
do
  extract_function() {
    local source_file="$1"
    local function_name="$2"
    awk -v name="$function_name" '
      function brace_delta(line, stripped, opens, closes) {
        stripped = line
        gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
        gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
        opens = gsub(/\{/, "{", stripped)
        closes = gsub(/\}/, "}", stripped)
        return opens - closes
      }
      $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
        capture = 1
        depth = 0
      }
      capture {
        print
        depth += brace_delta($0)
        if (depth == 0) {
          exit
        }
      }
    ' "$source_file"
  }
  extracted="$(extract_function "$MONITOR_SCRIPT_FILE" "$fn")"
  if [[ -z "$extracted" ]]; then
    fail "missing extracted helper for expected replacement test: $fn"
  fi
  printf '%s\n\n' "$extracted" >> "$INTENT_FUNCS"
done

if (
  set -euo pipefail
  source "$INTENT_FUNCS"
  SESSION="intent-session"
  STATE_FILE="$TMP_ROOT/intent-state.json"
  printf '{"tasks":{}}\n' > "$STATE_FILE"
  log_file="$TMP_ROOT/intent-status.log"
  warn_file="$TMP_ROOT/intent-warn.log"
  : > "$log_file"
  : > "$warn_file"
  tmux_calls=()
  log() { printf '%s:%s\n' "$1" "$2" >> "$log_file"; }
  log_warn() { printf '%s\n' "$*" >> "$warn_file"; }
  sleep() { :; }
  tmux() {
    tmux_calls+=("$*")
    case "${1:-}" in
      list-windows)
        return 0
        ;;
      new-window)
        return 0
        ;;
      display-message)
        if [[ "$*" == *"#{window_id}"* ]]; then
          printf '@42\n'
          return 0
        fi
        return 1
        ;;
      set-option)
        return 0
        ;;
    esac
    return 1
  }

  wt_dir="$TMP_ROOT/intent-worktree"
  feature_dir="$wt_dir/features/intent-slug"
  mkdir -p "$feature_dir"
  record_coding_pane_replacement_intent "HOK-2571" "$feature_dir" "$wt_dir"
  expected_target="$(_ensure_task_window_exists "$SESSION" "HOK-2571" "intent-slug" "$wt_dir" "review")"
  [[ "$expected_target" == "@42" ]]
  grep -q "intentionally quarantined after coding" "$log_file"
  ! grep -q "missing, recreating" "$warn_file"
  [[ ! -e "$feature_dir/.coding-pane-replacement-intent.json" ]]

  : > "$log_file"
  : > "$warn_file"
  second_target="$(_ensure_task_window_exists "$SESSION" "HOK-2571" "intent-slug" "$wt_dir" "review")"
  [[ "$second_target" == "@42" ]]
  grep -q "Window HOK-2571-intent-slug missing, recreating" "$warn_file"
); then
  pass "expected coding-pane replacement is consumed once before recovery warnings resume"
else
  fail "expected coding-pane replacement consumption behavior regressed"
fi

TEST_REPO="$TMP_ROOT/repo"
mkdir -p "$TEST_REPO/shared/lib" "$TEST_REPO/tools/prompts" "$TEST_REPO/worktrees" "$TEST_REPO/.claude"
mkdir -p "$TMP_ROOT/home/.claude" "$TMP_ROOT/home/.codex"
cp "$REPO_DIR/shared/lib/wavemill-startup-runner.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/wavemill-common.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/bounded-retry.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/challenge-arms.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/wavemill-input-reader.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/agent-adapters.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/routing-emitter.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/startup-progress.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/model-validator.ts" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/wavemill-status.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/wavemill-window-titles.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/tools/prompts/"*.md "$TEST_REPO/tools/prompts/"

# Stub agent_launch_interactive so it doesn't exercise real tmux pane readiness
# checks against the mock tmux. Appended functions override the original at
# source time.
cat >> "$TEST_REPO/shared/lib/agent-adapters.sh" <<'STUB_EOF'

agent_launch_interactive() { return 0; }
agent_launch_autonomous() { return 0; }
STUB_EOF
printf '{}' > "$TMP_ROOT/home/.claude.json"
printf '{"token":"ok"}' > "$TMP_ROOT/home/.codex/auth.json"

MOCK_BIN="$TMP_ROOT/mock-bin"
make_mock_bin "$MOCK_BIN"

export HOME="$TMP_ROOT/home"
export PATH="$MOCK_BIN:$PATH"
export MOCK_TMUX_LOG="$TMP_ROOT/tmux.log"
export MOCK_GIT_LOG="$TMP_ROOT/git.log"
export MOCK_GH_LOG="$TMP_ROOT/gh.log"
export MOCK_NPX_LOG="$TMP_ROOT/npx.log"
export MOCK_LINEAR_LOG="$TMP_ROOT/linear.log"
touch "$MOCK_TMUX_LOG" "$MOCK_GIT_LOG" "$MOCK_GH_LOG" "$MOCK_NPX_LOG" "$MOCK_LINEAR_LOG"

STATE_DIR="$TEST_REPO/.wavemill"
STATE_FILE="$STATE_DIR/workflow-state.json"
mkdir -p "$STATE_DIR"
printf '{"session":"startup-test","started":"2026-04-12T00:00:00Z","tasks":{}}\n' > "$STATE_FILE"

TASK_ONE_JSON="$(jq -n \
  --arg issue "HOK-1001" \
  --arg slug "alpha-task" \
  --arg title "Alpha Task" \
  --arg branch "task/alpha-task" \
  --arg worktreeDir "$TEST_REPO/worktrees/alpha-task" \
  --arg linearIssueId "HOK-1001" \
  --arg taskPacketFile "$TMP_ROOT/HOK-1001-taskpacket.md" \
  --arg taskPacketDetailsFile "$TMP_ROOT/HOK-1001-taskpacket-details.md" \
  --arg issueJsonFile "$TMP_ROOT/HOK-1001-issue.json" \
  '{
    issue: $issue,
    slug: $slug,
    title: $title,
    branch: $branch,
    worktreeDir: $worktreeDir,
    linearIssueId: $linearIssueId,
    taskPacketFile: $taskPacketFile,
    taskPacketDetailsFile: $taskPacketDetailsFile,
    issueJsonFile: $issueJsonFile,
    route: {
      planner: "claude-sonnet-4-5-20250929",
      coder: "claude-opus-4-6",
      reviewer: "claude-sonnet-4-5-20250929",
      planDepth: "deep",
      codeDepth: "medium",
      reviewMode: "static",
      maxCostUsd: 12.5
    },
    challenge: false,
    challengePairId: null,
    challengeRole: null,
    challengeModel: null,
    migrationNumber: null,
    agent: "claude"
  }')"

TASK_TWO_JSON="$(jq -n \
  --arg issue "HOK-1002" \
  --arg slug "broken-task" \
  --arg title "Broken Task" \
  --arg branch "task/broken-task" \
  --arg worktreeDir "$TEST_REPO/worktrees/broken-task" \
  --arg linearIssueId "HOK-1002" \
  --arg taskPacketFile "$TMP_ROOT/HOK-1002-taskpacket.md" \
  --arg taskPacketDetailsFile "$TMP_ROOT/HOK-1002-taskpacket-details.md" \
  --arg issueJsonFile "$TMP_ROOT/HOK-1002-issue.json" \
  '{
    issue: $issue,
    slug: $slug,
    title: $title,
    branch: $branch,
    worktreeDir: $worktreeDir,
    linearIssueId: $linearIssueId,
    taskPacketFile: $taskPacketFile,
    taskPacketDetailsFile: $taskPacketDetailsFile,
    issueJsonFile: $issueJsonFile,
    route: {
      planner: "claude-sonnet-4-5-20250929",
      coder: "claude-opus-4-6",
      reviewer: "claude-sonnet-4-5-20250929",
      planDepth: "deep",
      codeDepth: "medium",
      reviewMode: "static"
    },
    challenge: false,
    challengePairId: null,
    challengeRole: null,
    challengeModel: null,
    migrationNumber: null,
    agent: "claude"
  }')"

for issue in HOK-1001 HOK-1002; do
  printf 'Task packet for %s\n' "$issue" > "$TMP_ROOT/${issue}-taskpacket.md"
  printf 'Detailed packet for %s\n' "$issue" > "$TMP_ROOT/${issue}-taskpacket-details.md"
  jq -n --arg desc "Description for $issue" '{description: $desc, labels: {nodes: []}}' > "$TMP_ROOT/${issue}-issue.json"
done

SUCCESS_PLAN="$TMP_ROOT/success-plan.json"
SUCCESS_MONITOR_ENV="$TMP_ROOT/success-monitor.env"
SUCCESS_MONITOR_SCRIPT="$TMP_ROOT/success-monitor.sh"
SUCCESS_STATUS_LOG="$TMP_ROOT/success-status.log"
SUCCESS_LAUNCHED="$TMP_ROOT/success-launched.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SUCCESS_MONITOR_SCRIPT"
chmod +x "$SUCCESS_MONITOR_SCRIPT"
write_plan "$SUCCESS_PLAN" "$TEST_REPO" "$STATE_DIR" "$STATE_FILE" "startup-success" "$SUCCESS_MONITOR_ENV" "$SUCCESS_MONITOR_SCRIPT" "$SUCCESS_STATUS_LOG" "$SUCCESS_LAUNCHED" "[$TASK_ONE_JSON]"
STALE_FEATURE_DIR="$TEST_REPO/worktrees/alpha-task/features/alpha-task"
mkdir -p "$STALE_FEATURE_DIR"
printf '{"stage":"coding","status":"running"}\n' > "$STALE_FEATURE_DIR/.coding-result.json"
printf '{"stage":"review","status":"running"}\n' > "$STALE_FEATURE_DIR/.review-result.json"
printf 'stale plan\n' > "$STALE_FEATURE_DIR/plan.md"
touch "$STALE_FEATURE_DIR/.plan-approved"
printf '{"stage":"coding","confidence":"high"}\n' > "$STALE_FEATURE_DIR/.coding-complete"

SUCCESS_OUTPUT="$TMP_ROOT/success-output.txt"
bash "$RUNNER_SCRIPT" "$SUCCESS_PLAN" > "$SUCCESS_OUTPUT" 2>&1

if wait_for_jq_match '.tasks["HOK-1001"].phase == "planning"' "$STATE_FILE"; then
  pass "startup runner writes workflow state only after in-tmux startup succeeds"
else
  fail "startup runner did not persist workflow state for the launched task"
  dump_file_on_failure "workflow-state" "$STATE_FILE"
  dump_file_on_failure "startup-output" "$SUCCESS_OUTPUT"
  dump_file_on_failure "tmux-log" "$MOCK_TMUX_LOG"
fi

SUCCESS_FEATURE_DIR="$TEST_REPO/worktrees/alpha-task/features/alpha-task"
if jq -e '.stage == "planning" and .status == "running"' "$SUCCESS_FEATURE_DIR/.planning-result.json" >/dev/null 2>&1 \
  && [[ ! -f "$SUCCESS_FEATURE_DIR/.coding-result.json" ]] \
  && [[ ! -f "$SUCCESS_FEATURE_DIR/.review-result.json" ]] \
  && [[ ! -f "$SUCCESS_FEATURE_DIR/.plan-approved" ]] \
  && [[ ! -f "$SUCCESS_FEATURE_DIR/.coding-complete" ]] \
  && [[ ! -f "$SUCCESS_FEATURE_DIR/plan.md" ]]; then
  pass "startup runner launches planning before coding and clears stale phase artifacts"
else
  fail "startup runner did not enforce planning-first launch"
  dump_file_on_failure "planning-result" "$SUCCESS_FEATURE_DIR/.planning-result.json"
  dump_file_on_failure "coding-result" "$SUCCESS_FEATURE_DIR/.coding-result.json"
  dump_file_on_failure "review-result" "$SUCCESS_FEATURE_DIR/.review-result.json"
  dump_file_on_failure "plan" "$SUCCESS_FEATURE_DIR/plan.md"
fi

if grep -q 'HOK-1001|In Progress' "$MOCK_LINEAR_LOG"; then
  pass "startup runner updates Linear after a successful launch"
else
  fail "startup runner did not update Linear for the successful task"
fi

if [[ -f "$SUCCESS_MONITOR_ENV" ]] && grep -q '^TASKS_FILE=' "$SUCCESS_MONITOR_ENV"; then
  pass "startup runner writes the monitor env inside tmux startup"
else
  fail "startup runner did not write the monitor env"
fi

if grep -q "respawn-pane -k -t startup-success:mill.0" "$MOCK_TMUX_LOG"; then
  pass "startup runner hands control-pane startup off to the monitor"
else
  fail "startup runner did not launch the monitor in the mill pane"
fi

printf '{"session":"startup-test","started":"2026-04-12T00:00:00Z","tasks":{}}\n' > "$STATE_FILE"
: > "$MOCK_TMUX_LOG"
INTERACTIVE_PLAN="$TMP_ROOT/interactive-plan.json"
INTERACTIVE_MONITOR_ENV="$TMP_ROOT/interactive-monitor.env"
INTERACTIVE_MONITOR_SCRIPT="$TMP_ROOT/interactive-monitor.sh"
INTERACTIVE_STATUS_LOG="$TMP_ROOT/interactive-status.log"
INTERACTIVE_LAUNCHED="$TMP_ROOT/interactive-launched.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "$INTERACTIVE_MONITOR_SCRIPT"
chmod +x "$INTERACTIVE_MONITOR_SCRIPT"
write_plan "$INTERACTIVE_PLAN" "$TEST_REPO" "$STATE_DIR" "$STATE_FILE" "startup-interactive" "$INTERACTIVE_MONITOR_ENV" "$INTERACTIVE_MONITOR_SCRIPT" "$INTERACTIVE_STATUS_LOG" "$INTERACTIVE_LAUNCHED" "[$TASK_ONE_JSON]"
jq '.planningMode = "interactive"' "$INTERACTIVE_PLAN" > "$INTERACTIVE_PLAN.tmp"
mv "$INTERACTIVE_PLAN.tmp" "$INTERACTIVE_PLAN"

INTERACTIVE_OUTPUT="$TMP_ROOT/interactive-output.txt"
bash "$RUNNER_SCRIPT" "$INTERACTIVE_PLAN" > "$INTERACTIVE_OUTPUT" 2>&1

INTERACTIVE_ROUTING_FILE="$TEST_REPO/worktrees/alpha-task/features/alpha-task/.routing-complete"
if jq -e '.maxCostUsd == 12.5' "$INTERACTIVE_ROUTING_FILE" >/dev/null 2>&1; then
  pass "startup runner preserves route.maxCostUsd in interactive .routing-complete"
else
  fail "startup runner did not persist route.maxCostUsd in interactive .routing-complete"
fi

printf '{"session":"startup-test","started":"2026-04-12T00:00:00Z","tasks":{"HOK-1999":{"slug":"resumed-task","branch":"task/resumed-task","phase":"executing"}}}\n' > "$STATE_FILE"
: > "$MOCK_TMUX_LOG"
EMPTY_PLAN="$TMP_ROOT/empty-plan.json"
EMPTY_MONITOR_ENV="$TMP_ROOT/empty-monitor.env"
EMPTY_MONITOR_SCRIPT="$TMP_ROOT/empty-monitor.sh"
EMPTY_STATUS_LOG="$TMP_ROOT/empty-status.log"
EMPTY_LAUNCHED="$TMP_ROOT/empty-launched.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "$EMPTY_MONITOR_SCRIPT"
chmod +x "$EMPTY_MONITOR_SCRIPT"
write_plan "$EMPTY_PLAN" "$TEST_REPO" "$STATE_DIR" "$STATE_FILE" "startup-empty" "$EMPTY_MONITOR_ENV" "$EMPTY_MONITOR_SCRIPT" "$EMPTY_STATUS_LOG" "$EMPTY_LAUNCHED" "[]"

EMPTY_OUTPUT="$TMP_ROOT/empty-output.txt"
bash "$RUNNER_SCRIPT" "$EMPTY_PLAN" > "$EMPTY_OUTPUT" 2>&1

if [[ -f "$EMPTY_MONITOR_ENV" ]] && grep -q '^TASKS_FILE=' "$EMPTY_MONITOR_ENV"; then
  pass "startup runner writes the monitor env when there are no new tasks"
else
  fail "startup runner did not write the monitor env for resume-only startup"
fi

if grep -q 'No new tasks selected. Resuming 1 in-flight task(s) from previous session.' "$EMPTY_STATUS_LOG"; then
  pass "startup runner logs resume-only startup when launch plan is empty"
else
  fail "startup runner did not report resume-only startup"
fi

if grep -q "respawn-pane -k -t startup-empty:mill.0" "$MOCK_TMUX_LOG"; then
  pass "startup runner still launches the monitor for resume-only startup"
else
  fail "startup runner did not launch the monitor for resume-only startup"
fi

printf '{"session":"startup-test","started":"2026-04-12T00:00:00Z","tasks":{}}\n' > "$STATE_FILE"
: > "$MOCK_LINEAR_LOG"
: > "$MOCK_TMUX_LOG"
FAIL_PLAN="$TMP_ROOT/failure-plan.json"
FAIL_MONITOR_ENV="$TMP_ROOT/failure-monitor.env"
FAIL_MONITOR_SCRIPT="$TMP_ROOT/failure-monitor.sh"
FAIL_STATUS_LOG="$TMP_ROOT/failure-status.log"
FAIL_LAUNCHED="$TMP_ROOT/failure-launched.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAIL_MONITOR_SCRIPT"
chmod +x "$FAIL_MONITOR_SCRIPT"
write_plan "$FAIL_PLAN" "$TEST_REPO" "$STATE_DIR" "$STATE_FILE" "startup-failure" "$FAIL_MONITOR_ENV" "$FAIL_MONITOR_SCRIPT" "$FAIL_STATUS_LOG" "$FAIL_LAUNCHED" "[$TASK_ONE_JSON,$TASK_TWO_JSON]"

FAIL_OUTPUT="$TMP_ROOT/failure-output.txt"
export FAIL_WORKTREE_MATCH="broken-task"
WAVEMILL_NO_PROGRESS=0 bash "$RUNNER_SCRIPT" "$FAIL_PLAN" > "$FAIL_OUTPUT" 2>&1
unset FAIL_WORKTREE_MATCH

if jq -e '.tasks["HOK-1001"]' "$STATE_FILE" >/dev/null 2>&1 \
  && ! jq -e '.tasks["HOK-1002"]' "$STATE_FILE" >/dev/null 2>&1; then
  pass "startup runner isolates per-task startup failures without orphaned state"
else
  fail "startup runner left orphaned workflow state after a task startup failure"
fi

if grep -q 'HOK-1001|In Progress' "$MOCK_LINEAR_LOG" && ! grep -q 'HOK-1002|In Progress' "$MOCK_LINEAR_LOG"; then
  pass "startup runner only updates Linear for tasks that fully launched"
else
  fail "startup runner updated Linear for a failed task launch"
fi

if grep -q 'FAILED at worktree: worktree creation' "$FAIL_STATUS_LOG" && grep -q '── Task 2/2: HOK-1002' "$FAIL_STATUS_LOG"; then
  pass "startup failures stay visible in the tmux startup log output"
else
  fail "startup failure logging is missing from the control-pane output"
fi

if grep -q "respawn-pane -k -t startup-failure:mill.0" "$MOCK_TMUX_LOG"; then
  pass "startup runner still launches the monitor after partial startup failure"
else
  fail "startup runner did not hand off to the monitor after partial startup failure"
fi

# Queue Plan Backward/Forward Tolerance (HOK-1532)
# Verify backward compatibility: no queue plan fields when not present
BACKWARD_PLAN="$TMP_ROOT/backward-plan.json"
write_plan "$BACKWARD_PLAN" "$TEST_REPO" "$STATE_DIR" "$STATE_FILE" "startup-backward" "$TMP_ROOT/bw-monitor.env" "$TMP_ROOT/bw-monitor.sh" "$TMP_ROOT/bw-status.log" "$TMP_ROOT/bw-launched.txt" "[$TASK_ONE_JSON]"

# Verify the backward plan has no queuePlan field
if ! jq -e '.queuePlan' "$BACKWARD_PLAN" >/dev/null 2>&1; then
  pass "launch plan without queue data has no queuePlan field (backward compatible)"
else
  fail "launch plan should not have queuePlan field when queue data is not present"
fi

# Verify tasks in backward plan have no queue fields
if ! jq -e '.tasks[0].dependsOn' "$BACKWARD_PLAN" >/dev/null 2>&1 && \
   ! jq -e '.tasks[0].baseFromTask' "$BACKWARD_PLAN" >/dev/null 2>&1; then
  pass "launch plan tasks without queue data have no dependsOn/baseFromTask fields (backward compatible)"
else
  fail "launch plan tasks should not have queue fields when queue data is not present"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
