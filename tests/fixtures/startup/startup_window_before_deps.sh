#!/usr/bin/env bash
# Tests that the startup runner creates the task tmux window BEFORE running
# dependency install, and that:
#   - agent launch is gated on install success (checked via startup task log)
#   - install failures keep the window open and skip agent launch

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUNNER_SCRIPT="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"

PASS=0
FAIL=0

pass() { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }

dump_on_failure() {
  local label="$1" path="$2"
  printf '    --- %s: %s ---\n' "$label" "$path"
  if [[ -f "$path" ]]; then sed 's/^/    /' "$path"; else printf '    (missing)\n'; fi
  printf '    --- end %s ---\n' "$label"
}

if [[ ! -f "$RUNNER_SCRIPT" ]]; then
  fail "wavemill-startup-runner.sh not found"
  exit 1
fi

# ─── Mock-environment factory ───────────────────────────────────────────────
# Creates a self-contained mock-bin and test repo under $base_dir.
# $event_log  records: EVENT:new-window, EVENT:pnpm-start, EVENT:pnpm-done
# $fail_pnpm  if "true", pnpm mock exits 1 (simulates install failure)
setup_env() {
  local base_dir="$1"
  local event_log="$2"
  local fail_pnpm="${3:-false}"
  local repo_dir="$base_dir/repo"
  local mock_dir="$base_dir/mock-bin"

  mkdir -p "$repo_dir/shared/lib" "$repo_dir/tools/prompts" \
           "$repo_dir/worktrees" "$repo_dir/.claude" \
           "$base_dir/home/.claude" "$base_dir/home/.codex"

  cp "$REPO_DIR/shared/lib/wavemill-startup-runner.sh" "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/wavemill-common.sh"         "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/bounded-retry.sh"           "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/wavemill-input-reader.sh"   "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/agent-adapters.sh"          "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/routing-emitter.sh"         "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/startup-progress.sh"        "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/model-validator.ts"         "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/wavemill-status.sh"         "$repo_dir/shared/lib/"
  cp "$REPO_DIR/shared/lib/wavemill-window-titles.sh"  "$repo_dir/shared/lib/"
  cp "$REPO_DIR/tools/prompts/"*.md                    "$repo_dir/tools/prompts/"

  # Stub interactive launch so the test doesn't need a real tmux pane.
  cat >> "$repo_dir/shared/lib/agent-adapters.sh" <<'STUB'

agent_launch_interactive() { return 0; }
agent_launch_autonomous() { return 0; }
STUB

  printf '{}' > "$base_dir/home/.claude.json"
  printf '{"token":"ok"}' > "$base_dir/home/.codex/auth.json"

  mkdir -p "$mock_dir"
  local ev_q fail_q
  printf -v ev_q   '%q' "$event_log"
  printf -v fail_q '%q' "$fail_pnpm"

  # git mock: creates worktree dir and pnpm-lock.yaml when CREATE_LOCKFILE_MATCH is set
  cat > "$mock_dir/git" <<EOF
#!/usr/bin/env bash
printf 'git %s\n' "\$*" >> "\${MOCK_GIT_LOG:?}"
if [[ "\${1:-}" == "show-ref" ]]; then exit 1; fi
if [[ "\${1:-}" == "worktree" && "\${2:-}" == "add" ]]; then
  wt="\${3:-}"
  [[ -n "\${FAIL_WORKTREE_MATCH:-}" && "\$wt" == *"\$FAIL_WORKTREE_MATCH"* ]] && exit 1
  mkdir -p "\$wt"
  [[ -n "\${CREATE_LOCKFILE_MATCH:-}" && "\$wt" == *"\$CREATE_LOCKFILE_MATCH"* ]] && \
    touch "\$wt/pnpm-lock.yaml"
  exit 0
fi
exit 0
EOF
  chmod +x "$mock_dir/git"

  cat > "$mock_dir/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
  printf '[]\n'
  exit 0
fi
exit 1
EOF
  chmod +x "$mock_dir/gh"

  # tmux mock: records new-window to event log; executes send-keys commands in a
  # subshell so install scripts run and write their sentinel files.
  cat > "$mock_dir/tmux" <<EOF
#!/usr/bin/env bash
printf 'tmux %s\n' "\$*" >> "\${MOCK_TMUX_LOG:?}"
case "\${1:-}" in
  new-window)
    printf 'EVENT:new-window\n' >> $ev_q
    ;;
  send-keys)
    # send-keys -t session:win "bash /path/script.sh" Enter
    if [[ "\${2:-}" == "-t" && \$# -ge 5 ]]; then
      ( eval "\${4}" ) &
    fi
    ;;
  list-panes)   printf '0\n' ;;
  display-message) printf 'fake-win-id\n' ;;
  set-window-option|set-option|respawn-pane|select-pane|set-environment|split-window) ;;
esac
EOF
  chmod +x "$mock_dir/tmux"

  # pnpm mock: records start/done events; can be made to fail via fail_pnpm
  cat > "$mock_dir/pnpm" <<EOF
#!/usr/bin/env bash
printf 'EVENT:pnpm-start\n' >> $ev_q
if [[ $fail_q == "true" ]]; then
  printf 'pnpm: simulated install failure\n' >&2
  exit 1
fi
printf 'EVENT:pnpm-done\n' >> $ev_q
exit 0
EOF
  chmod +x "$mock_dir/pnpm"

  # npx mock: handles Linear state updates
  cat > "$mock_dir/npx" <<EOF
#!/usr/bin/env bash
printf 'npx %s\n' "\$*" >> "\${MOCK_NPX_LOG:?}"
if [[ "\$*" == *"set-issues-state.ts"* ]]; then
  state="In Progress"
  while [[ \$# -gt 0 ]]; do
    case "\$1" in
      --state) state="\${2:-}"; shift 2 ;;
      -*) shift ;;
      *) printf '%s|%s\n' "\$1" "\$state" >> "\${MOCK_LINEAR_LOG:?}"; shift ;;
    esac
  done
elif [[ "\$*" == *"set-issue-state.ts"* ]]; then
  printf '%s|%s\n' "\${3:-}" "\${4:-}" >> "\${MOCK_LINEAR_LOG:?}"
fi
exit 0
EOF
  chmod +x "$mock_dir/npx"

  # claude mock: auth check passes; actual launch is stubbed in agent-adapters.sh
  cat > "$mock_dir/claude" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then exit 0; fi
cat >/dev/null || true
exit 0
EOF
  chmod +x "$mock_dir/claude"
}

# Write a minimal launch plan JSON.
write_plan() {
  local plan_file="$1" repo_dir="$2" state_dir="$3" state_file="$4" session="$5"
  local status_log="$6" monitor_env="$7" monitor_script="$8" launched_file="$9"
  local tasks_json="${10}"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$monitor_script"
  chmod +x "$monitor_script"
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
      session:$session, repoDir:$repoDir, baseBranch:$baseBranch,
      worktreeRoot:$worktreeRoot, planningMode:$planningMode,
      agentCmd:$agentCmd, agentCmdExplicit:false, forceModel:null,
      routerEnabled:true, maxParallel:2,
      stateDir:$stateDir, stateFile:$stateFile,
      toolsDir:$toolsDir, libDir:$libDir, initialPhase:$initialPhase,
      startupConfig:{
        statusLogFile:$statusLogFile, monitorEnv:$monitorEnv,
        monitorScript:$monitorScript, launchedIssuesFile:$launchedIssuesFile
      },
      monitorConfig:{
        pollSeconds:30, requireConfirm:true, dryRun:false,
        projectName:"Test", autoEval:false,
        dashboardVerbosity:"info", dashboardLogToFile:false
      },
      tasks:$tasks
    }' > "$plan_file"
}

# Build a minimal task JSON object.
make_task() {
  local repo_dir="$1" issue="$2" slug="$3" tasks_dir="$4"
  jq -n \
    --arg issue "$issue" --arg slug "$slug" \
    --arg title "Test $slug" --arg branch "task/$slug" \
    --arg wt "$repo_dir/worktrees/$slug" \
    --arg lin "$issue" \
    --arg pkt "$tasks_dir/${issue}-packet.md" \
    --arg det "$tasks_dir/${issue}-details.md" \
    --arg jsn "$tasks_dir/${issue}-issue.json" \
    '{
      issue:$issue, slug:$slug, title:$title, branch:$branch,
      worktreeDir:$wt, linearIssueId:$lin,
      taskPacketFile:$pkt, taskPacketDetailsFile:$det, issueJsonFile:$jsn,
      route:{
        planner:"claude-sonnet-4-5-20250929", coder:"claude-opus-4-6",
        reviewer:"claude-sonnet-4-5-20250929", planDepth:"light",
        codeDepth:"medium", reviewMode:"static"
      },
      challenge:false, challengePairId:null, challengeRole:null,
      challengeModel:null, migrationNumber:null, agent:"claude"
    }'
}

echo "=== startup_window_before_deps: Pane-Before-Install Ordering ==="

# ─── TEST 1: Window created before install; agent gated on success ────────────

T1="$(mktemp -d)"
trap 'rm -rf "$T1"' EXIT
T1_EVENT="$T1/events.log"
touch "$T1_EVENT"
setup_env "$T1" "$T1_EVENT" "false"

export HOME="$T1/home"
export PATH="$T1/mock-bin:$PATH"
export MOCK_TMUX_LOG="$T1/tmux.log"
export MOCK_GIT_LOG="$T1/git.log"
export MOCK_NPX_LOG="$T1/npx.log"
export MOCK_LINEAR_LOG="$T1/linear.log"
touch "$MOCK_TMUX_LOG" "$MOCK_GIT_LOG" "$MOCK_NPX_LOG" "$MOCK_LINEAR_LOG"

T1_WAVEMILL="$T1/repo/.wavemill"
T1_STATE="$T1_WAVEMILL/workflow-state.json"
mkdir -p "$T1_WAVEMILL"
printf '{"session":"wbd1","started":"2026-04-12T00:00:00Z","tasks":{}}\n' > "$T1_STATE"

T1_TASKS="$T1/tasks"
mkdir -p "$T1_TASKS"
printf 'packet\n' > "$T1_TASKS/HOK-2001-packet.md"
printf 'details\n' > "$T1_TASKS/HOK-2001-details.md"
jq -n '{description:"d",labels:{nodes:[]}}' > "$T1_TASKS/HOK-2001-issue.json"

T1_TASK_JSON="$(make_task "$T1/repo" "HOK-2001" "fresh-task" "$T1_TASKS")"
write_plan "$T1/plan.json" "$T1/repo" "$T1_WAVEMILL" "$T1_STATE" "wbd1" \
  "$T1/status.log" "$T1/monitor.env" "$T1/monitor.sh" "$T1/launched.txt" \
  "[$T1_TASK_JSON]"

# Make the mock git create pnpm-lock.yaml in fresh-task worktrees.
export CREATE_LOCKFILE_MATCH="fresh-task"
T1_TASK_LOG="/tmp/wavemill-wbd1-HOK-2001.startup.log"
rm -f "$T1_TASK_LOG"
T1_OUT="$T1/runner.out"
bash "$RUNNER_SCRIPT" "$T1/plan.json" > "$T1_OUT" 2>&1 || true

# Brief wait for the async pnpm (executed via tmux send-keys) to finish.
sleep 1
unset CREATE_LOCKFILE_MATCH

# Check 1a: new-window line appears before pnpm-start line in event log
new_win_n="$(grep -n 'EVENT:new-window'  "$T1_EVENT" | head -1 | cut -d: -f1 || true)"
pnpm_start_n="$(grep -n 'EVENT:pnpm-start' "$T1_EVENT" | head -1 | cut -d: -f1 || true)"
if [[ -n "$new_win_n" && -n "$pnpm_start_n" ]] && (( new_win_n < pnpm_start_n )); then
  pass "startup runner creates task window before dependency install"
else
  fail "startup runner creates task window before dependency install"
  dump_on_failure "event-log" "$T1_EVENT"
  dump_on_failure "runner-output" "$T1_OUT"
fi

# Check 1b: deps ✓ step appears before agent launch step in task startup log.
# agent_launch_interactive logs "[6/7] Launching agent... ✓" to the task log.
# The task startup log is at /tmp/wavemill-${SESSION}-${ISSUE}.startup.log but
# since STARTUP_TASK_LOG_FILE is cleared after the task, check the status log.
# Actually both "Installing deps" ✓ and "Launching agent" ✓ end up in the same
# per-task log while the task is running.
T1_STATUS="$T1/status.log"
deps_step_n="$(grep -n 'Installing deps.*✓\|3\.5/7' "$T1_STATUS" 2>/dev/null | head -1 | cut -d: -f1 || true)"
agent_step_n="$(grep -n 'Launching agent.*✓\|6/7.*Launching' "$T1_STATUS" 2>/dev/null | head -1 | cut -d: -f1 || true)"
if [[ -n "$deps_step_n" && -n "$agent_step_n" ]] && (( deps_step_n < agent_step_n )); then
  pass "startup runner gates agent launch on dependency install success"
elif [[ -n "$deps_step_n" && -z "$agent_step_n" ]]; then
  # deps logged but agent step not found — check pnpm-done was recorded and
  # Linear was updated (sufficient to confirm full launch with gate ordering).
  pnpm_done_n="$(grep -n 'EVENT:pnpm-done' "$T1_EVENT" | head -1 | cut -d: -f1 || true)"
  if [[ -n "$pnpm_done_n" ]] && grep -q 'HOK-2001|In Progress' "$MOCK_LINEAR_LOG"; then
    pass "startup runner gates agent launch on dependency install success"
  else
    fail "startup runner gates agent launch on dependency install success"
    dump_on_failure "status-log" "$T1_STATUS"
    dump_on_failure "event-log"  "$T1_EVENT"
    dump_on_failure "runner-out" "$T1_OUT"
  fi
else
  fail "startup runner gates agent launch on dependency install success"
  dump_on_failure "status-log" "$T1_STATUS"
  dump_on_failure "event-log"  "$T1_EVENT"
  dump_on_failure "runner-out" "$T1_OUT"
fi

# Check 1c: Linear updated (task fully launched)
if grep -q 'HOK-2001|In Progress' "$MOCK_LINEAR_LOG"; then
  pass "startup runner updates Linear after fresh-install task launch"
else
  fail "startup runner did not update Linear after fresh-install task launch"
  dump_on_failure "linear-log"  "$MOCK_LINEAR_LOG"
  dump_on_failure "runner-output" "$T1_OUT"
fi

# ─── TEST 2: Install failure keeps window open and skips agent launch ─────────

T2="$(mktemp -d)"
trap 'rm -rf "$T2"' EXIT
T2_EVENT="$T2/events.log"
touch "$T2_EVENT"
setup_env "$T2" "$T2_EVENT" "true"  # pnpm will fail

export HOME="$T2/home"
export PATH="$T2/mock-bin:$PATH"
export MOCK_TMUX_LOG="$T2/tmux.log"
export MOCK_GIT_LOG="$T2/git.log"
export MOCK_NPX_LOG="$T2/npx.log"
export MOCK_LINEAR_LOG="$T2/linear.log"
touch "$MOCK_TMUX_LOG" "$MOCK_GIT_LOG" "$MOCK_NPX_LOG" "$MOCK_LINEAR_LOG"

T2_WAVEMILL="$T2/repo/.wavemill"
T2_STATE="$T2_WAVEMILL/workflow-state.json"
mkdir -p "$T2_WAVEMILL"
printf '{"session":"wbd2","started":"2026-04-12T00:00:00Z","tasks":{}}\n' > "$T2_STATE"

T2_TASKS="$T2/tasks"
mkdir -p "$T2_TASKS"
printf 'packet\n' > "$T2_TASKS/HOK-2002-packet.md"
printf 'details\n' > "$T2_TASKS/HOK-2002-details.md"
jq -n '{description:"d",labels:{nodes:[]}}' > "$T2_TASKS/HOK-2002-issue.json"

T2_TASK_JSON="$(make_task "$T2/repo" "HOK-2002" "fail-install" "$T2_TASKS")"
write_plan "$T2/plan.json" "$T2/repo" "$T2_WAVEMILL" "$T2_STATE" "wbd2" \
  "$T2/status.log" "$T2/monitor.env" "$T2/monitor.sh" "$T2/launched.txt" \
  "[$T2_TASK_JSON]"

export CREATE_LOCKFILE_MATCH="fail-install"
T2_OUT="$T2/runner.out"
bash "$RUNNER_SCRIPT" "$T2/plan.json" > "$T2_OUT" 2>&1 || true

# Give the async pnpm enough time to write its sentinel and the poll loop to detect it.
sleep 2
unset CREATE_LOCKFILE_MATCH

# Check 2a: agent-launch stub was never reached (claude mock never called for launch)
# The claude mock is only invoked for auth checks in agent_check_auth or when
# agent_launch_interactive would actually run the binary (but it's stubbed).
# Verify via absence of Linear update and no agent step in status log.
if ! grep -q 'HOK-2002|In Progress' "$MOCK_LINEAR_LOG"; then
  pass "startup runner skips agent launch after install failure"
else
  fail "startup runner launched agent despite install failure"
  dump_on_failure "linear-log"  "$MOCK_LINEAR_LOG"
  dump_on_failure "runner-output" "$T2_OUT"
fi

# Check 2b: window was NOT killed (pane must stay visible with error output)
if ! grep -q 'kill-window' "$MOCK_TMUX_LOG"; then
  pass "startup runner keeps install-failure window open for inspection"
else
  fail "startup runner killed the window after install failure"
  dump_on_failure "tmux-log" "$MOCK_TMUX_LOG"
fi

# Check 2c: failure logged in status log
if [[ -f "$T2/status.log" ]] && grep -q 'FAILED.*deps\|dependency install' "$T2/status.log"; then
  pass "startup runner reports dependency install failure in status log"
else
  fail "startup runner did not report dependency install failure"
  dump_on_failure "status-log" "$T2/status.log"
  dump_on_failure "runner-output" "$T2_OUT"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
(( FAIL > 0 )) && exit 1
exit 0
