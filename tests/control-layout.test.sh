#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER_SCRIPT="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"

PASS=0
FAIL=0
TMP_ROOT=""
TEST_SESSION=""
ORIGINAL_PATH="$PATH"

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
skip() {
  echo "  SKIP  $1"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 0
}

cleanup() {
  if [[ -n "${TEST_SESSION:-}" ]]; then
    tmux kill-session -t "$TEST_SESSION" >/dev/null 2>&1 || true
  fi
  if [[ -n "${TMP_ROOT:-}" && -d "$TMP_ROOT" ]]; then
    rm -rf "$TMP_ROOT"
  fi
}

trap 'cleanup' EXIT INT TERM

make_mock_bin() {
  local dir="$1"
  mkdir -p "$dir"

  cat > "$dir/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >> "${MOCK_GIT_LOG:?}"

if [[ "${1:-}" == "-C" ]]; then
  shift 2
fi

case "${1:-}" in
  show-ref)
    if [[ "$*" == *"refs/heads/main"* || "$*" == *"refs/remotes/origin/main"* ]]; then
      exit 0
    fi
    exit 1
    ;;
  rev-parse)
    exit 1
    ;;
  worktree)
    if [[ "${2:-}" == "add" ]]; then
      if [[ "${4:-}" == "-b" ]]; then
        wt_dir="${3:-}"
      else
        wt_dir="${3:-}"
      fi
      mkdir -p "$wt_dir"
      exit 0
    fi
    ;;
esac

exit 0
EOF
  chmod +x "$dir/git"

  cat > "$dir/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npx %s\n' "$*" >> "${MOCK_NPX_LOG:?}"
if [[ "$*" == *"set-issue-state.ts"* ]]; then
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
printf '%s\n' "[mock claude] exited"
exit 0
EOF
  chmod +x "$dir/claude"

  cat > "$dir/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '[]\n'
EOF
  chmod +x "$dir/gh"
}

create_test_repo() {
  local repo_dir="$1"
  mkdir -p "$repo_dir/shared/lib" "$repo_dir/shared/agent-bin" "$repo_dir/tools/prompts" "$repo_dir/worktrees" "$repo_dir/.claude"
  cp "$REPO_DIR/shared/lib/wavemill-startup-runner.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/startup-progress.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/wavemill-common.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/bounded-retry.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/challenge-arms.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/wavemill-worktree-deps.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/wavemill-input-reader.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/agent-adapters.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/terminal-reconciler.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/routing-emitter.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/model-validator.ts" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/wavemill-status.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/wavemill-window-titles.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/agent-bin/tmux" "$repo_dir/shared/agent-bin/"
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
        pollSeconds: 10,
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

write_monitor_script() {
  local path="$1"
  local heading="$2"
  local details="$3"

  cat > "$path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source "\${1:?monitor env path required}"
clear
printf '%s\n\n' "$heading"
printf '%s\n' "$details"
if [[ -s "\$TASKS_FILE" ]]; then
  printf '\nMonitoring tasks\n'
  cat "\$TASKS_FILE"
fi
tail -f /dev/null
EOF
  chmod +x "$path"
}

wait_for_success() {
  local description="$1"
  local attempts="$2"
  local delay="$3"
  shift 3
  local output=""
  local i

  for ((i = 1; i <= attempts; i++)); do
    if output="$("$@" 2>/dev/null)"; then
      printf '%s' "$output"
      return 0
    fi
    sleep "$delay"
  done

  echo "Timed out waiting for $description" >&2
  return 1
}

list_control_panes() {
  tmux list-panes -t "$TEST_SESSION:mill" \
    -F '#{pane_index}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{pane_current_command}'
}

wait_for_pane_layout() {
  local attempts="${1:-30}"
  local delay="${2:-0.2}"
  local output=""
  local i
  local line_count

  for ((i = 1; i <= attempts; i++)); do
    output="$(list_control_panes 2>/dev/null || true)"
    line_count="$(printf '%s\n' "$output" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [[ "$line_count" -eq 3 ]]; then
      printf '%s' "$output"
      return 0
    fi
    sleep "$delay"
  done

  return 1
}

capture_pane() {
  local pane_index="$1"
  tmux capture-pane -pt "$TEST_SESSION:mill.$pane_index" -S -120
}

wait_for_pane_content() {
  local pane_index="$1"
  local needle="$2"
  local attempts="${3:-30}"
  local delay="${4:-0.2}"
  local output=""
  local i

  for ((i = 1; i <= attempts; i++)); do
    output="$(capture_pane "$pane_index" 2>/dev/null || true)"
    if [[ "$output" == *"$needle"* ]]; then
      printf '%s' "$output"
      return 0
    fi
    sleep "$delay"
  done

  return 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local description="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$description"
  else
    fail "$description"
  fi
}

run_layout_case() {
  local case_name="$1"
  local tasks_json="$2"
  local state_json="$3"
  local monitor_heading="$4"
  local monitor_details="$5"
  local control_marker="$6"
  local dashboard_marker="$7"

  local case_dir="$TMP_ROOT/$case_name"
  local repo_dir="$case_dir/repo"
  local home_dir="$case_dir/home"
  local mock_bin="$case_dir/mock-bin"
  local state_dir="$repo_dir/.wavemill"
  local state_file="$state_dir/workflow-state.json"
  local monitor_env="$case_dir/monitor.env"
  local monitor_script="$case_dir/monitor.sh"
  local status_log="$case_dir/status.log"
  local launched_file="$case_dir/launched.txt"
  local plan_file="$case_dir/plan.json"
  local output_file="$case_dir/output.txt"
  local panes_output
  local top_left=""
  local bottom_left=""
  local right_pane=""
  local left_zero_count=0
  local left_positive_count=0
  local line pane_index pane_left pane_top pane_width pane_height pane_command
  local dashboard_capture log_capture control_capture

  mkdir -p "$case_dir" "$home_dir/.claude" "$home_dir/.codex" "$state_dir"
  create_test_repo "$repo_dir"
  make_mock_bin "$mock_bin"
  printf '{}' > "$home_dir/.claude.json"
  printf '{"token":"ok"}' > "$home_dir/.codex/auth.json"
  printf '%s\n' "$state_json" > "$state_file"
  write_monitor_script "$monitor_script" "$monitor_heading" "$monitor_details"
  write_plan "$plan_file" "$repo_dir" "$state_dir" "$state_file" "$TEST_SESSION" "$monitor_env" "$monitor_script" "$status_log" "$launched_file" "$tasks_json"

  export HOME="$home_dir"
  export PATH="$mock_bin:$ORIGINAL_PATH"
  export MOCK_GIT_LOG="$case_dir/git.log"
  export MOCK_NPX_LOG="$case_dir/npx.log"
  export MOCK_LINEAR_LOG="$case_dir/linear.log"
  touch "$MOCK_GIT_LOG" "$MOCK_NPX_LOG" "$MOCK_LINEAR_LOG"

  tmux new-session -d -s "$TEST_SESSION" -x 200 -y 50
  tmux rename-window -t "$TEST_SESSION:0" mill

  bash "$RUNNER_SCRIPT" "$plan_file" > "$output_file" 2>&1

  if ! panes_output="$(wait_for_pane_layout 30 0.2)"; then
    fail "$case_name: timed out waiting for three mill panes"
    [[ -f "$output_file" ]] && sed 's/^/    /' "$output_file"
    tmux kill-session -t "$TEST_SESSION" >/dev/null 2>&1 || true
    TEST_SESSION=""
    return
  fi

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r pane_index pane_left pane_top pane_width pane_height pane_command <<<"$line"
    if [[ "$pane_left" -eq 0 ]]; then
      left_zero_count=$((left_zero_count + 1))
      if [[ "$pane_top" -eq 0 ]]; then
        top_left="$pane_index|$pane_command"
      else
        bottom_left="$pane_index|$pane_command"
      fi
    elif [[ "$pane_left" -gt 0 ]]; then
      left_positive_count=$((left_positive_count + 1))
      if [[ "$pane_top" -eq 0 ]]; then
        right_pane="$pane_index|$pane_command"
      fi
    fi
  done <<< "$panes_output"

  if [[ "$(printf '%s\n' "$panes_output" | wc -l | tr -d ' ')" -eq 3 ]]; then
    pass "$case_name: mill window has exactly 3 panes"
  else
    fail "$case_name: mill window does not have exactly 3 panes"
  fi

  if [[ "$left_zero_count" -eq 2 ]]; then
    pass "$case_name: two panes occupy the left column"
  else
    fail "$case_name: left-column pane count is wrong"
  fi

  if [[ "$left_positive_count" -eq 1 ]]; then
    pass "$case_name: one pane occupies the right column"
  else
    fail "$case_name: right-column pane count is wrong"
  fi

  if [[ -n "$top_left" ]]; then
    pass "$case_name: mill pane is at left=0 top=0"
  else
    fail "$case_name: missing top-left mill pane"
  fi

  if [[ -n "$bottom_left" ]]; then
    pass "$case_name: dashboard pane is at left=0 top>0"
  else
    fail "$case_name: missing bottom-left dashboard pane"
  fi

  if [[ -n "$right_pane" ]]; then
    pass "$case_name: log pane is at left>0 top=0"
  else
    fail "$case_name: missing right log pane"
  fi

  if [[ "${bottom_left##*|}" == "bash" ]]; then
    pass "$case_name: dashboard pane command is bash"
  else
    fail "$case_name: dashboard pane command is not bash"
  fi

  if [[ "${right_pane##*|}" == "tail" ]]; then
    pass "$case_name: log pane command is tail"
  else
    fail "$case_name: log pane command is not tail"
  fi

  dashboard_capture="$(wait_for_pane_content "${bottom_left%%|*}" "Wavemill Dashboard" 30 0.2 || capture_pane "${bottom_left%%|*}" || true)"
  log_capture="$(wait_for_pane_content "${right_pane%%|*}" "Wavemill Status Log" 30 0.2 || capture_pane "${right_pane%%|*}" || true)"
  control_capture="$(wait_for_pane_content "${top_left%%|*}" "$control_marker" 30 0.2 || capture_pane "${top_left%%|*}" || true)"

  assert_contains "$dashboard_capture" "Wavemill Dashboard" "$case_name: dashboard pane renders the dashboard header"
  assert_contains "$dashboard_capture" "$dashboard_marker" "$case_name: dashboard pane shows task table content"
  assert_contains "$log_capture" "Wavemill Status Log" "$case_name: log pane shows the status log header"
  if [[ "$control_capture" == *"$control_marker"* || "$control_capture" == *"mill>"* ]]; then
    pass "$case_name: mill pane shows startup text"
  else
    fail "$case_name: mill pane shows startup text"
  fi

  tmux kill-session -t "$TEST_SESSION"
  TEST_SESSION=""
}

echo "=== Control Layout Integration Test ==="

if [[ ! -f "$RUNNER_SCRIPT" ]]; then
  fail "startup runner script is missing"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

# Skip in CI environments - tmux session creation fails in containers
if [[ -n "${CI:-}" ]]; then
  skip "tmux layout test requires interactive terminal (not available in CI)"
fi

for required_cmd in bash jq tmux; do
  command -v "$required_cmd" >/dev/null 2>&1 || skip "$required_cmd is required for the tmux layout integration test"
done

if ! tmux start-server >/dev/null 2>&1; then
  skip "tmux server could not be started in this environment"
fi

TMP_ROOT="$(mktemp -d)"

TASK_JSON="$(jq -n \
  --arg issue "HOK-1001" \
  --arg slug "alpha-task" \
  --arg title "Alpha Task" \
  --arg branch "task/alpha-task" \
  --arg worktreeDir "$TMP_ROOT/fresh-startup/repo/worktrees/alpha-task" \
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
      reviewMode: "static"
    },
    challenge: false,
    challengePairId: null,
    challengeRole: null,
    challengeModel: null,
    migrationNumber: null,
    agent: "claude"
  }')"

printf 'Task packet for HOK-1001\n' > "$TMP_ROOT/HOK-1001-taskpacket.md"
printf 'Detailed packet for HOK-1001\n' > "$TMP_ROOT/HOK-1001-taskpacket-details.md"
jq -n --arg desc "Description for HOK-1001" '{description: $desc, labels: {nodes: []}}' > "$TMP_ROOT/HOK-1001-issue.json"

TEST_SESSION="wm-layout-fresh-$$"
run_layout_case \
  "fresh-startup" \
  "[$TASK_JSON]" \
  "{\"session\":\"wm-layout-fresh-$$\",\"started\":\"2026-04-13T00:00:00Z\",\"tasks\":{}}" \
  "Available tasks" \
  "startup ready" \
  "Available tasks" \
  "HOK-1001"

mkdir -p "$TMP_ROOT/resume-only/repo/worktrees/in-flight"

TEST_SESSION="wm-layout-resume-$$"
run_layout_case \
  "resume-only" \
  "[]" \
  "{\"session\":\"wm-layout-resume-$$\",\"started\":\"2026-04-13T00:00:00Z\",\"tasks\":{\"HOK-999\":{\"slug\":\"in-flight\",\"branch\":\"task/in-flight\",\"worktree\":\"$TMP_ROOT/resume-only/repo/worktrees/in-flight\",\"phase\":\"executing\",\"status\":\"\",\"linearIssueId\":\"HOK-999\"}}}" \
  "No new tasks selected" \
  "resuming in-flight tasks" \
  "No new tasks selected" \
  "HOK-999"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
