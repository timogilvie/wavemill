#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

strip_ansi() {
  perl -pe 's/\e\[[0-9;?]*[A-Za-z]//g'
}

iso_at_offset() {
  perl -MPOSIX=strftime -e 'my $offset = shift @ARGV; print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime(time() + $offset)), "\n"' -- "$1"
}

run_render() {
  local state_file="$1"
  local workspace_root="$2"
  local behavior_file="$3"
  local output_file="$4"
  local pane_mode="${5:-}"

  (
    export WAVEMILL_TIP_INDEX=0
    if [[ -n "$pane_mode" ]]; then
      set -- "--pane=$pane_mode" test-session "$workspace_root" "$state_file"
    else
      set -- test-session "$workspace_root" "$state_file"
    fi
    source "$REPO_DIR/shared/lib/wavemill-status.sh"

    refresh_pr_cache() { :; }
    clear_dashboard_scrollback() { :; }
    redraw_dashboard_frame() { :; }

    elapsed() {
      local dir="$1"
      case "$(basename "$dir")" in
        plan-task) echo "12m" ;;
        rejected-plan-task) echo "10m" ;;
        waiting-task) echo "7m" ;;
        active-task) echo "3m" ;;
        stale-task) echo "9m" ;;
        *) echo "1m" ;;
      esac
    }

    is_active() {
      local worktree="$1"
      [[ "$(basename "$worktree")" != "stale-task" ]]
    }

    agent_status() {
      case "$1" in
        HOK-1220) echo "exited" ;;
        HOK-1310) echo "exited" ;;
        HOK-1230) echo "running" ;;
        HOK-1221) echo "waiting" ;;
        HOK-1222) echo "running" ;;
        *) echo "running" ;;
      esac
    }

    window_index() {
      local win="$1-$2"
      jq -r --arg win "$win" '.pane[$win] // "—"' "$behavior_file"
    }

    agent_hook_detail() {
      local issue="$1"
      jq -r --arg issue "$issue" '.hook[$issue] // empty' "$behavior_file"
    }

    agent_reported_status() {
      local issue="$1"
      jq -r --arg issue "$issue" '.reported[$issue] // empty' "$behavior_file"
    }

    get_planning_display_status() {
      local _worktree="$1" slug="$2"
      jq -r --arg slug "$slug" '.planning[$slug] // empty' "$behavior_file"
    }

    pr_for_branch() {
      local branch="$1"
      jq -r --arg branch "$branch" '.pr[$branch] // empty' "$behavior_file"
    }

    pr_checks() {
      local branch="$1"
      jq -r --arg branch "$branch" '.checks[$branch] // empty' "$behavior_file"
    }

    case "$pane_mode" in
      jobs) render_jobs_pane ;;
      queued-pending) render_queued_pending_pane ;;
      *) render_dashboard ;;
    esac
    cp "$FRAME" "${output_file}.raw"
    strip_ansi < "$FRAME" > "$output_file"
  )
}

run_blocked_detail() {
  local workspace_root="$1"
  local issue="$2"
  local slug="$3"

  (
    set -- test-session "$workspace_root"
    source "$REPO_DIR/shared/lib/wavemill-status.sh" >/dev/null 2>&1
    coding_blocked_completion_detail "$workspace_root/$slug" "$slug" "$issue"
  ) | strip_ansi | head -1
}

echo "=== wavemill-status inbox renderer ==="

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

WORKTREES_DIR="$TMP_DIR/worktrees"
mkdir -p \
  "$WORKTREES_DIR/plan-task/features/plan-task" \
  "$WORKTREES_DIR/rejected-plan-task/features/rejected-plan-task" \
  "$WORKTREES_DIR/waiting-task/features/waiting-task" \
  "$WORKTREES_DIR/active-task/features/active-task" \
  "$WORKTREES_DIR/coding-task/features/coding-task" \
  "$WORKTREES_DIR/review-task/features/review-task" \
  "$WORKTREES_DIR/ready-task/features/ready-task" \
  "$WORKTREES_DIR/ready-stale-task/features/ready-stale-task" \
  "$WORKTREES_DIR/merged-done-task/features/merged-done-task" \
  "$WORKTREES_DIR/merge-candidate-task/features/merge-candidate-task" \
  "$WORKTREES_DIR/ready-conflict-task/features/ready-conflict-task" \
  "$WORKTREES_DIR/ready-complete-task/features/ready-complete-task" \
  "$WORKTREES_DIR/ready-failed-task/features/ready-failed-task" \
  "$WORKTREES_DIR/native-failed-task/features/native-failed-task" \
  "$WORKTREES_DIR/stale-task/features/stale-task"

STATE_FILE_ONE="$TMP_DIR/state-one.json"
cat > "$STATE_FILE_ONE" <<EOF
{
  "freeSlots": 2,
  "tasks": {
    "HOK-1220": {
      "slug": "plan-task",
      "branch": "task/plan-task",
      "worktree": "$WORKTREES_DIR/plan-task",
      "status": "",
      "phase": "planning",
      "pr": ""
    },
    "HOK-1221": {
      "slug": "waiting-task",
      "branch": "task/waiting-task",
      "worktree": "$WORKTREES_DIR/waiting-task",
      "status": "",
      "phase": "executing",
      "pr": ""
    },
    "HOK-1222": {
      "slug": "active-task",
      "branch": "task/active-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "executing",
      "pr": "tracked"
    }
  }
}
EOF

BEHAVIOR_ONE="$TMP_DIR/behavior-one.json"
cat > "$BEHAVIOR_ONE" <<'EOF'
{
  "hook": {
    "HOK-1221": "Waiting on tests"
  },
  "pane": {
    "HOK-1220-plan-task": "3",
    "HOK-1221-waiting-task": "7",
    "HOK-1222-active-task": "12"
  },
  "reported": {},
  "planning": {
    "plan-task": "awaiting_approval"
  },
  "pr": {
    "task/active-task": "45|OPEN"
  },
  "checks": {
    "task/active-task": "pass"
  }
}
EOF

OUTPUT_ONE="$TMP_DIR/output-one.txt"
run_render "$STATE_FILE_ONE" "$WORKTREES_DIR" "$BEHAVIOR_ONE" "$OUTPUT_ONE"

if grep -q $'\033\\[K' "${OUTPUT_ONE}.raw"; then
  pass "includes end-of-line clearing in raw dashboard frame"
else
  fail "raw dashboard frame is missing end-of-line clearing"
fi

if grep -q '📥 INBOX (2)' "$OUTPUT_ONE" && grep -q '⚡ ACTIVE (1)' "$OUTPUT_ONE"; then
  pass "renders inbox and active sections with counts"
else
  fail "missing inbox or active section counts"
fi

if grep -q 'ISSUE       PANE  TASK' "$OUTPUT_ONE" \
  && grep -Eq 'HOK-1220 +3 +plan-task' "$OUTPUT_ONE" \
  && grep -Eq 'HOK-1221 +7 +waiting-task' "$OUTPUT_ONE" \
  && grep -Eq 'HOK-1222 +12 +active-task' "$OUTPUT_ONE"; then
  pass "renders pane column and per-task tmux window indices"
else
  fail "pane column or window indices are missing"
fi

if [[ $(grep -n '📥 INBOX' "$OUTPUT_ONE" | cut -d: -f1) -lt $(grep -n '⚡ ACTIVE' "$OUTPUT_ONE" | cut -d: -f1) ]]; then
  pass "renders inbox before active"
else
  fail "section order is incorrect"
fi

if grep -q 'HOK-1220.*plan-task.*⏳ awaiting.*○ exited' "$OUTPUT_ONE" \
  && grep -q 'Plan ready — waiting for approval' "$OUTPUT_ONE" \
  && grep -q 'HOK-1221.*waiting-task.*⏳ waiting' "$OUTPUT_ONE" \
  && grep -q 'Waiting on tests' "$OUTPUT_ONE"; then
  pass "shows actionable tasks and detail lines in inbox"
else
  fail "inbox rows are missing expected state details"
fi

if grep -q 'planning execution: pending' "$OUTPUT_ONE"; then
  pass "awaiting approval renders pending planning execution when artifacts are absent"
else
  fail "missing planning artifacts do not render pending execution detail"
fi

if grep -q 'HOK-1222.*active-task.*🔨 executing.*● running.*#45 ✓' "$OUTPUT_ONE"; then
  pass "shows active task PR and running status"
else
  fail "active row is missing expected PR or status details"
fi

cat > "$WORKTREES_DIR/plan-task/features/plan-task/routing.jsonl" <<'EOF'
{"role":"planner","requested":"opus","resolved":"claude-opus-4-7"}
{"role":"coder","requested":"inherit","resolved":"claude-opus-4-7","inheritedFrom":"planner"}
{"role":"reviewer","requested":"sonnet","resolved":"claude-sonnet-5","fallback":"claude-haiku-4-5","fallbackReason":"quota-exhausted"}
EOF

OUTPUT_ROUTING="$TMP_DIR/output-routing.txt"
run_render "$STATE_FILE_ONE" "$WORKTREES_DIR" "$BEHAVIOR_ONE" "$OUTPUT_ROUTING"

if grep -q 'planner: requested=opus → resolved=claude-opus-4-7' "$OUTPUT_ROUTING" \
  && grep -q 'execution telemetry:' "$OUTPUT_ROUTING" \
  && grep -q 'coder: requested=inherit (from planner) → resolved=claude-opus-4-7' "$OUTPUT_ROUTING" \
  && grep -q 'reviewer: requested=sonnet → resolved=claude-sonnet-5' "$OUTPUT_ROUTING" \
  && grep -q 'fallback=claude-haiku-4-5 (reason: quota-exhausted)' "$OUTPUT_ROUTING"; then
  pass "awaiting approval labels runtime routing as execution telemetry"
else
  fail "routing details are missing from awaiting approval output"
fi

rm -f "$WORKTREES_DIR/plan-task/features/plan-task/routing.jsonl"
cat > "$WORKTREES_DIR/plan-task/features/plan-task/.planning-result.json" <<'EOF'
{
  "stage": "planning",
  "status": "completed",
  "agent": "codex",
  "model": "claude-sonnet-5"
}
EOF

cat > "$WORKTREES_DIR/plan-task/features/plan-task/.initial-route.json" <<'EOF'
{
  "planner": "claude-sonnet-5",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5"
}
EOF

cat > "$WORKTREES_DIR/plan-task/features/plan-task/.post-expansion-route.json" <<'EOF'
{
  "planner": "claude-opus-4-7",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5"
}
EOF

cat > "$WORKTREES_DIR/plan-task/features/plan-task/.routing-complete" <<'EOF'
{
  "planner": "claude-opus-4-7",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5",
  "planDepth": "light",
  "codeDepth": "medium",
  "reviewMode": "static"
}
EOF

cat > "$WORKTREES_DIR/plan-task/features/plan-task/.phase-config.json" <<'EOF'
{
  "planning": {
    "model": "claude-opus-4-7",
    "agent": "claude",
    "depth": "light"
  },
  "coding": {
    "model": "gpt-5.4",
    "agent": "codex",
    "depth": "medium"
  },
  "review": {
    "model": "claude-sonnet-5",
    "agent": "claude",
    "mode": "static"
  }
}
EOF

OUTPUT_ROUTE_ARTIFACT="$TMP_DIR/output-route-artifact.txt"
run_render "$STATE_FILE_ONE" "$WORKTREES_DIR" "$BEHAVIOR_ONE" "$OUTPUT_ROUTE_ARTIFACT"

if grep -q 'executed planning: codex / claude-sonnet-5' "$OUTPUT_ROUTE_ARTIFACT" \
  && grep -q 'bootstrap route: p=claude-sonnet-5, c=gpt-5.4' "$OUTPUT_ROUTE_ARTIFACT" \
  && grep -q 'recommended after expansion: p=claude-opus-4-7' "$OUTPUT_ROUTE_ARTIFACT" \
  && grep -q 'active remaining route: c=gpt-5.4, r=claude-sonnet-5' "$OUTPUT_ROUTE_ARTIFACT"; then
  pass "awaiting approval distinguishes executed planning from expanded route drift"
else
  fail "route lifecycle detail is missing from awaiting approval output"
fi

cat > "$WORKTREES_DIR/plan-task/features/plan-task/.post-expansion-route.json" <<'EOF'
{
  "planner": "claude-sonnet-5",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5"
}
EOF

OUTPUT_ROUTE_NO_DRIFT="$TMP_DIR/output-route-no-drift.txt"
run_render "$STATE_FILE_ONE" "$WORKTREES_DIR" "$BEHAVIOR_ONE" "$OUTPUT_ROUTE_NO_DRIFT"

if grep -q 'executed planning: codex / claude-sonnet-5' "$OUTPUT_ROUTE_NO_DRIFT" \
  && ! grep -q 'recommended after expansion:' "$OUTPUT_ROUTE_NO_DRIFT"; then
  pass "awaiting approval omits expanded planner recommendation when there is no planner drift"
else
  fail "no-drift route display still shows expanded planner recommendation"
fi

cat > "$WORKTREES_DIR/rejected-plan-task/features/rejected-plan-task/.planning-rejected.json" <<'EOF'
{
  "reason": "planning_modified_out_of_scope_files",
  "outOfScopeFiles": ["src/new-feature.ts"],
  "reverted": true
}
EOF

STATE_FILE_PLANNING_REJECTED="$TMP_DIR/state-planning-rejected.json"
cat > "$STATE_FILE_PLANNING_REJECTED" <<EOF
{
  "freeSlots": 2,
  "tasks": {
    "HOK-1230": {
      "slug": "rejected-plan-task",
      "branch": "task/rejected-plan-task",
      "worktree": "$WORKTREES_DIR/rejected-plan-task",
      "status": "",
      "phase": "planning",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_PLANNING_REJECTED="$TMP_DIR/behavior-planning-rejected.json"
cat > "$BEHAVIOR_PLANNING_REJECTED" <<'EOF'
{
  "hook": {},
  "pane": {
    "HOK-1230-rejected-plan-task": "9"
  },
  "reported": {},
  "planning": {
    "rejected-plan-task": "awaiting_approval"
  },
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_PLANNING_REJECTED="$TMP_DIR/output-planning-rejected.txt"
run_render "$STATE_FILE_PLANNING_REJECTED" "$WORKTREES_DIR" "$BEHAVIOR_PLANNING_REJECTED" "$OUTPUT_PLANNING_REJECTED"

if grep -q '📥 INBOX (1)' "$OUTPUT_PLANNING_REJECTED" \
  && grep -q 'HOK-1230.*rejected-plan-task.*⚠ planning' "$OUTPUT_PLANNING_REJECTED" \
  && grep -q 'Planning needs attention: edited src/new-feature.ts' "$OUTPUT_PLANNING_REJECTED"; then
  pass "surfaces planning rejection artifact as actionable needs-attention row"
else
  fail "planning rejection artifact is not surfaced as actionable dashboard detail"
fi

cat > "$WORKTREES_DIR/coding-task/features/coding-task/.coding-blocked-completion.json" <<'EOF'
{
  "summary": "coding done; full verification blocked by Docker and baseline tests",
  "reason": "The task is ready for review, but local verification cannot finish in this environment."
}
EOF

CODING_DETAIL_OUTPUT="$(run_blocked_detail "$WORKTREES_DIR" "HOK-1642" "coding-task")"
if [[ "$CODING_DETAIL_OUTPUT" == 'HOK-1642 needs attention: coding done; full verification blocked by Docker and baseline tests. Type "advance HOK-1642" to launch review.' ]]; then
  pass "formats coding blocked-completion detail with advance guidance"
else
  fail "coding blocked-completion detail formatting is incorrect"
fi

cat > "$WORKTREES_DIR/coding-task/features/coding-task/.coding-blocked-completion.json" <<'EOF'
{
  "summary": "coding blocked: Codex model at capacity",
  "reason": "model_at_capacity"
}
EOF

CAPACITY_CODING_DETAIL_OUTPUT="$(run_blocked_detail "$WORKTREES_DIR" "HOK-1642" "coding-task")"
if [[ "$CAPACITY_CODING_DETAIL_OUTPUT" == 'HOK-1642 needs attention: coding blocked: Codex model at capacity. Type "advance HOK-1642" to launch review.' ]]; then
  pass "formats coding capacity blocked-completion detail"
else
  fail "coding capacity blocked-completion detail formatting is incorrect"
fi

cat > "$WORKTREES_DIR/coding-task/features/coding-task/.coding-blocked-completion.json" <<'EOF'
{
  "summary": "coding done; full verification blocked by Docker and baseline tests",
  "reason": "The task is ready for review, but local verification cannot finish in this environment."
}
EOF

STATE_FILE_CODING_BLOCKED="$TMP_DIR/state-coding-blocked.json"
cat > "$STATE_FILE_CODING_BLOCKED" <<EOF
{
  "tasks": {
    "HOK-1642": {
      "slug": "coding-task",
      "branch": "task/coding-task",
      "worktree": "$WORKTREES_DIR/coding-task",
      "status": "",
      "phase": "coding",
      "pr": ""
    },
    "HOK-1222": {
      "slug": "active-task",
      "branch": "task/active-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "executing",
      "pr": "tracked"
    }
  }
}
EOF

BEHAVIOR_CODING_BLOCKED="$TMP_DIR/behavior-coding-blocked.json"
cat > "$BEHAVIOR_CODING_BLOCKED" <<'EOF'
{
  "hook": {},
  "pane": {
    "HOK-1642-coding-task": "5",
    "HOK-1222-active-task": "12"
  },
  "reported": {
    "HOK-1642": "still running tests"
  },
  "planning": {},
  "pr": {
    "task/active-task": "45|OPEN"
  },
  "checks": {
    "task/active-task": "pass"
  }
}
EOF

OUTPUT_CODING_BLOCKED="$TMP_DIR/output-coding-blocked.txt"
run_render "$STATE_FILE_CODING_BLOCKED" "$WORKTREES_DIR" "$BEHAVIOR_CODING_BLOCKED" "$OUTPUT_CODING_BLOCKED"

if grep -q '📥 INBOX (1)' "$OUTPUT_CODING_BLOCKED" \
  && grep -q '⚡ ACTIVE (1)' "$OUTPUT_CODING_BLOCKED" \
  && grep -q 'HOK-1642.*coding-task.*⚠ coding.*● running' "$OUTPUT_CODING_BLOCKED" \
  && grep -q 'HOK-1642 needs attention: coding done; full verifica' "$OUTPUT_CODING_BLOCKED"; then
  pass "coding blocked-completion renders as actionable coding row with detail precedence"
else
  fail "coding blocked-completion row did not move to inbox or show attention detail"
fi

printf '{"summary":"%s"}\n' "$(perl -e 'print "x" x 120')" > "$WORKTREES_DIR/coding-task/features/coding-task/.coding-blocked-completion.json"

LONG_CODING_DETAIL_OUTPUT="$(run_blocked_detail "$WORKTREES_DIR" "HOK-1642" "coding-task")"
if [[ "$LONG_CODING_DETAIL_OUTPUT" == *'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...'* ]]; then
  pass "coding blocked-completion summary truncates in detail helper"
else
  fail "coding blocked-completion summary was not truncated"
fi

cat > "$WORKTREES_DIR/coding-task/features/coding-task/.coding-blocked-completion.json" <<'EOF'
{
  "reason": "No summary was written."
}
EOF

FALLBACK_CODING_DETAIL_OUTPUT="$(run_blocked_detail "$WORKTREES_DIR" "HOK-1642" "coding-task")"
if [[ "$FALLBACK_CODING_DETAIL_OUTPUT" == 'HOK-1642 needs attention: coding done; verification blocked. Type "advance HOK-1642" to launch review.' ]]; then
  pass "coding blocked-completion falls back when summary is missing"
else
  fail "coding blocked-completion did not use the generic fallback summary"
fi

cat > "$WORKTREES_DIR/coding-task/features/coding-task/.coding-uncommitted-output.json" <<'EOF'
{
  "summary": "coding completed marker detected, but branch has no commits beyond auto/integration and worktree still contains uncommitted coding output",
  "action": "Commit the coding output, then retry review."
}
EOF

UNCOMMITTED_CODING_DETAIL_OUTPUT="$(run_blocked_detail "$WORKTREES_DIR" "HOK-1642" "coding-task")"
if [[ "$UNCOMMITTED_CODING_DETAIL_OUTPUT" == *'branch has no commits beyond auto/integ'* ]] \
  && [[ "$UNCOMMITTED_CODING_DETAIL_OUTPUT" == *'Commit the coding output, then retry review.'* ]] \
  && [[ "$UNCOMMITTED_CODING_DETAIL_OUTPUT" != *'advance HOK-1642'* ]]; then
  pass "formats uncommitted coding-output detail distinctly from review failures"
else
  fail "uncommitted coding-output detail formatting is incorrect"
fi

OUTPUT_CODING_UNCOMMITTED="$TMP_DIR/output-coding-uncommitted.txt"
run_render "$STATE_FILE_CODING_BLOCKED" "$WORKTREES_DIR" "$BEHAVIOR_CODING_BLOCKED" "$OUTPUT_CODING_UNCOMMITTED"

if grep -q '📥 INBOX (1)' "$OUTPUT_CODING_UNCOMMITTED" \
  && grep -q 'HOK-1642.*coding-task.*⚠ coding.*● running' "$OUTPUT_CODING_UNCOMMITTED" \
  && grep -q 'coding completed marker detected' "$OUTPUT_CODING_UNCOMMITTED" \
  && ! grep -q 'full verification blocked by Docker' "$OUTPUT_CODING_UNCOMMITTED"; then
  pass "uncommitted coding-output artifact takes dashboard precedence"
else
  fail "uncommitted coding-output artifact did not render as the actionable coding detail"
fi

rm -f "$WORKTREES_DIR/coding-task/features/coding-task/.coding-uncommitted-output.json"

cat > "$WORKTREES_DIR/coding-task/features/coding-task/.coding-auto-advance.json" <<'EOF'
{
  "reason": "automatic advance from valid blocked-completion artifact"
}
EOF

AUTO_CODING_DETAIL_OUTPUT="$(run_blocked_detail "$WORKTREES_DIR" "HOK-1642" "coding-task")"
if [[ -z "$AUTO_CODING_DETAIL_OUTPUT" ]]; then
  pass "coding blocked-completion detail suppresses manual prompt after auto-advance"
else
  fail "coding blocked-completion detail still prompted after auto-advance"
fi

OUTPUT_CODING_AUTO="$TMP_DIR/output-coding-auto.txt"
run_render "$STATE_FILE_CODING_BLOCKED" "$WORKTREES_DIR" "$BEHAVIOR_CODING_BLOCKED" "$OUTPUT_CODING_AUTO"

if grep -q '⚡ ACTIVE (2)' "$OUTPUT_CODING_AUTO" \
  && ! grep -q '📥 INBOX (1)' "$OUTPUT_CODING_AUTO" \
  && grep -q 'HOK-1642.*coding-task.*auto review.*● running' "$OUTPUT_CODING_AUTO" \
  && grep -q 'HOK-1642 auto-advanced coding to review from blocked completion.' "$OUTPUT_CODING_AUTO"; then
  pass "coding auto-advance renders as active review handoff detail"
else
  fail "coding auto-advance row did not render with active auto-review detail"
fi

rm -f "$WORKTREES_DIR/coding-task/features/coding-task/.coding-auto-advance.json"

rm -f "$WORKTREES_DIR/coding-task/features/coding-task/.coding-blocked-completion.json"

OUTPUT_CODING_NORMAL="$TMP_DIR/output-coding-normal.txt"
run_render "$STATE_FILE_CODING_BLOCKED" "$WORKTREES_DIR" "$BEHAVIOR_CODING_BLOCKED" "$OUTPUT_CODING_NORMAL"

if grep -q 'HOK-1642.*coding-task.*💻 coding.*● running' "$OUTPUT_CODING_NORMAL" \
  && ! grep -q 'needs attention:' "$OUTPUT_CODING_NORMAL"; then
  pass "coding row stays unchanged when blocked-completion artifact is absent"
else
  fail "coding row changed without a blocked-completion artifact"
fi

STATE_FILE_SKIPPED="$TMP_DIR/state-skipped.json"
cat > "$STATE_FILE_SKIPPED" <<EOF
{
  "tasks": {
    "HOK-1224": {
      "slug": "skipped-check-task",
      "branch": "task/skipped-check-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "executing",
      "pr": "tracked"
    }
  }
}
EOF

BEHAVIOR_SKIPPED="$TMP_DIR/behavior-skipped.json"
cat > "$BEHAVIOR_SKIPPED" <<'EOF'
{
  "pane": {
    "HOK-1224-skipped-check-task": "14"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {
    "task/skipped-check-task": "348|OPEN"
  },
  "checks": {
    "task/skipped-check-task": "pass"
  }
}
EOF

OUTPUT_SKIPPED="$TMP_DIR/output-skipped.txt"
run_render "$STATE_FILE_SKIPPED" "$WORKTREES_DIR" "$BEHAVIOR_SKIPPED" "$OUTPUT_SKIPPED"

if grep -q 'HOK-1224.*skipped-check-task.*🔨 executing.*● running.*#348 ✓' "$OUTPUT_SKIPPED"; then
  pass "treats skipped or neutral PR checks as passing in dashboard output"
else
  fail "dashboard did not render skipped-check PR as passing"
fi

STATE_FILE_CLEANUP_EPISODE="$TMP_DIR/state-cleanup-episode.json"
cat > "$STATE_FILE_CLEANUP_EPISODE" <<EOF
{
  "tasks": {
    "HOK-2955": {
      "slug": "cleanup-episode-task",
      "branch": "task/cleanup-episode-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "merged",
      "phase": "done",
      "pr": "tracked",
      "lifecycle": {
        "schemaVersion": 1,
        "workflowOutcome": "merged",
        "resourceDisposition": "retained",
        "retention": {
          "reason": "local-work-preserved"
        },
        "cleanupEpisode": {
          "schemaVersion": 1,
          "episodeId": "HOK-2955:cleanup:abc123def456",
          "fingerprint": "abc123def4567890",
          "disposition": "retained",
          "failureClass": "expected-preservation",
          "attemptCount": 1,
          "nextRetryAt": null,
          "requiredOperatorAction": "Push task/cleanup-episode-task to origin or explicitly abandon it.",
          "lastOutcome": "local-work-preserved",
          "updatedAt": "2026-09-08T12:00:00Z"
        }
      }
    }
  }
}
EOF

OUTPUT_CLEANUP_EPISODE="$TMP_DIR/output-cleanup-episode.txt"
run_render "$STATE_FILE_CLEANUP_EPISODE" "$WORKTREES_DIR" "$BEHAVIOR_SKIPPED" "$OUTPUT_CLEANUP_EPISODE"

if grep -q 'cleanup: retained attempts=1 outcome=local-work-preserved fp=abc1' "$OUTPUT_CLEANUP_EPISODE" \
  && grep -q 'lifecycle: outcome=merged disposition=retained reason=local-work-' "$OUTPUT_CLEANUP_EPISODE"; then
  pass "dashboard renders retained cleanup episode detail"
else
  fail "dashboard cleanup episode detail is missing"
fi

STATE_FILE_MONITOR_QUEUE="$TMP_DIR/state-monitor-queue.json"
cat > "$STATE_FILE_MONITOR_QUEUE" <<EOF
{
  "monitorDeferredCommands": [
    {
      "event": "select 1 2",
      "reason": "no_slots_available",
      "queued_at": "2026-05-05T12:00:00Z"
    }
  ],
  "tasks": {}
}
EOF

BEHAVIOR_MONITOR_QUEUE="$TMP_DIR/behavior-monitor-queue.json"
cat > "$BEHAVIOR_MONITOR_QUEUE" <<'EOF'
{
  "pane": {},
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_MONITOR_QUEUE="$TMP_DIR/output-monitor-queue.txt"
run_render "$STATE_FILE_MONITOR_QUEUE" "$WORKTREES_DIR" "$BEHAVIOR_MONITOR_QUEUE" "$OUTPUT_MONITOR_QUEUE"

if ! grep -q '⌛ QUEUED COMMANDS' "$OUTPUT_MONITOR_QUEUE" \
  && ! grep -q '🛠 JOBS' "$OUTPUT_MONITOR_QUEUE" \
  && grep -q '⚡ ACTIVE' "$OUTPUT_MONITOR_QUEUE" \
  && grep -q 'No active tasks' "$OUTPUT_MONITOR_QUEUE"; then
  pass "dashboard omits queued and jobs informational sections"
else
  fail "dashboard still renders queued or jobs sections"
fi

OUTPUT_QUEUED_PANE="$TMP_DIR/output-queued-pane.txt"
run_render "$STATE_FILE_MONITOR_QUEUE" "$WORKTREES_DIR" "$BEHAVIOR_MONITOR_QUEUE" "$OUTPUT_QUEUED_PANE" "queued-pending"

if grep -q '⌛ QUEUED COMMANDS (1)' "$OUTPUT_QUEUED_PANE" \
  && grep -q 'select 1 2' "$OUTPUT_QUEUED_PANE" \
  && grep -q 'no slots available' "$OUTPUT_QUEUED_PANE"; then
  pass "queued/pending pane renders queued monitor commands"
else
  fail "queued/pending pane is missing queued monitor commands"
fi

if grep -q 'Refreshes every 2s │ wavemill expand HOK-1234: build a task packet from Linear' "$OUTPUT_ONE"; then
  pass "footer renders stable refresh prefix with selected usage tip"
else
  fail "footer is missing expected selected usage tip"
fi

# Test truncation of long detail strings
STATE_FILE_LONG="$TMP_DIR/state-long.json"
cat > "$STATE_FILE_LONG" <<EOF
{
  "tasks": {
    "HOK-1223": {
      "slug": "long-detail-task",
      "branch": "task/long-detail-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "executing",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_LONG="$TMP_DIR/behavior-long.json"
cat > "$BEHAVIOR_LONG" <<'EOF'
{
  "pane": {
    "HOK-1223-long-detail-task": "8"
  },
  "hook": {
    "HOK-1223": "This is a very long detail string that should be truncated to prevent overflow beyond the terminal width and causing text bleeding into adjacent cells"
  },
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_LONG="$TMP_DIR/output-long.txt"
run_render "$STATE_FILE_LONG" "$WORKTREES_DIR" "$BEHAVIOR_LONG" "$OUTPUT_LONG"

# Check that truncated detail string is present and doesn't exceed reasonable length
if grep -q '└─.*\.\.\.' "$OUTPUT_LONG"; then
  # Find the detail line and check its length
  detail_line=$(grep '└─' "$OUTPUT_LONG" | head -1)
  line_len=${#detail_line}
  if (( line_len <= 98 )); then
    pass "truncates very long detail strings to prevent overflow"
  else
    fail "truncated detail line is still too long ($line_len chars)"
  fi
else
  fail "very long detail string was not truncated"
fi

STATE_FILE_TWO="$TMP_DIR/state-two.json"
cat > "$STATE_FILE_TWO" <<EOF
{
  "tasks": {
    "HOK-1222": {
      "slug": "active-task",
      "branch": "task/active-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "executing",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_TWO="$TMP_DIR/behavior-two.json"
cat > "$BEHAVIOR_TWO" <<'EOF'
{
  "pane": {
    "HOK-1222-active-task": "12"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_TWO="$TMP_DIR/output-two.txt"
run_render "$STATE_FILE_TWO" "$WORKTREES_DIR" "$BEHAVIOR_TWO" "$OUTPUT_TWO"

if ! grep -q '📥 INBOX' "$OUTPUT_TWO" && grep -q '⚡ ACTIVE (1)' "$OUTPUT_TWO"; then
  pass "omits inbox section when no actionable tasks exist"
else
  fail "active-only dashboard still rendered an inbox section"
fi

STATE_FILE_THREE="$TMP_DIR/state-three.json"
cat > "$STATE_FILE_THREE" <<EOF
{
  "tasks": {
    "HOK-1999": {
      "slug": "stale-task",
      "branch": "task/stale-task",
      "worktree": "$WORKTREES_DIR/stale-task",
      "status": "",
      "phase": "executing",
      "pr": ""
    }
  }
}
EOF

OUTPUT_THREE="$TMP_DIR/output-three.txt"
run_render "$STATE_FILE_THREE" "$WORKTREES_DIR" "$BEHAVIOR_TWO" "$OUTPUT_THREE"

if grep -q '⚡ ACTIVE (0)' "$OUTPUT_THREE" && grep -q 'No active tasks' "$OUTPUT_THREE"; then
  pass "shows empty active section after filtering stale tasks"
else
  fail "empty active state after stale filtering is wrong"
fi

STATE_FILE_PHASES="$TMP_DIR/state-phases.json"
cat > "$STATE_FILE_PHASES" <<EOF
{
  "jobs": {
    "eval-HOK-1564-primary-101": {
      "id": "eval-HOK-1564-primary-101",
      "kind": "eval",
      "session": "test-session",
      "issueId": "HOK-1564",
      "side": "primary",
      "pairId": "HOK-1564",
      "prNumbers": [101],
      "pid": 123,
      "startedAt": "2026-05-05T12:00:00Z",
      "timeoutSeconds": 420,
      "logPath": "/tmp/eval-HOK-1564-primary-101.log",
      "resultPath": "/tmp/eval-HOK-1564-primary-101.result.json",
      "status": "running",
      "exitCode": null,
      "finishedAt": null,
      "reason": null,
      "excerpt": null,
      "settled": false
    },
    "comparison-HOK-1564-101-102": {
      "id": "comparison-HOK-1564-101-102",
      "kind": "comparison",
      "session": "test-session",
      "pairId": "HOK-1564",
      "prNumbers": [101, 102],
      "pid": 124,
      "startedAt": "2026-05-05T12:00:00Z",
      "timeoutSeconds": 240,
      "logPath": "/tmp/comparison-HOK-1564-101-102.log",
      "resultPath": "/tmp/comparison-HOK-1564-101-102.result.json",
      "status": "failed",
      "exitCode": 1,
      "finishedAt": "2026-05-05T12:05:00Z",
      "reason": "missing_eval_records",
      "excerpt": "Missing eval records for challenge pair HOK-1564",
      "settled": false
    }
  },
  "tasks": {
    "HOK-1300": {
      "slug": "coding-task",
      "branch": "task/coding-task",
      "worktree": "$WORKTREES_DIR/coding-task",
      "status": "",
      "phase": "coding",
      "pr": ""
    },
    "HOK-1301": {
      "slug": "review-task",
      "branch": "task/review-task",
      "worktree": "$WORKTREES_DIR/review-task",
      "status": "",
      "phase": "review",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_PHASES="$TMP_DIR/behavior-phases.json"
cat > "$BEHAVIOR_PHASES" <<'EOF'
{
  "pane": {
    "HOK-1300-coding-task": "4",
    "HOK-1301-review-task": "5"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_PHASES="$TMP_DIR/output-phases.txt"
run_render "$STATE_FILE_PHASES" "$WORKTREES_DIR" "$BEHAVIOR_PHASES" "$OUTPUT_PHASES"

if grep -q 'HOK-1300.*coding-task.*💻 coding.*● running' "$OUTPUT_PHASES"; then
  pass "shows coding phase with emoji"
else
  fail "coding phase row is missing emoji"
fi

if grep -q 'HOK-1301.*review-task.*🔍 review.*● running' "$OUTPUT_PHASES"; then
  pass "shows review phase with emoji"
else
  fail "review phase row is missing emoji"
fi

if ! grep -q '🛠 JOBS' "$OUTPUT_PHASES" \
  && ! grep -q '⌛ QUEUED COMMANDS' "$OUTPUT_PHASES"; then
  pass "default dashboard excludes background jobs/queue sections"
else
  fail "default dashboard still includes background sections"
fi

OUTPUT_JOBS_PANE="$TMP_DIR/output-jobs-pane.txt"
run_render "$STATE_FILE_PHASES" "$WORKTREES_DIR" "$BEHAVIOR_PHASES" "$OUTPUT_JOBS_PANE" "jobs"

if grep -q '🛠 JOBS' "$OUTPUT_JOBS_PANE" \
  && grep -q 'Tracked background jobs (2)' "$OUTPUT_JOBS_PANE" \
  && grep -q 'Missing eval records for challenge pair HOK-1564' "$OUTPUT_JOBS_PANE"; then
  pass "jobs pane renders jobs details"
else
  fail "jobs pane is missing expected job details"
fi

STATE_FILE_RUNNING="$TMP_DIR/state-running.json"
eval_started_at="$(iso_at_offset -12)"
comparison_started_at="$(iso_at_offset 300)"
cat > "$STATE_FILE_RUNNING" <<EOF
{
  "tasks": {
    "HOK-1563": {
      "slug": "active-task",
      "branch": "task/active-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked",
      "evalRunning": {
        "issue": "HOK-1563",
        "side": "primary",
        "pr": 101,
        "phase": "eval",
        "startedAt": "$eval_started_at"
      }
    },
    "HOK-1563_c": {
      "slug": "review-task",
      "branch": "task/review-task",
      "worktree": "$WORKTREES_DIR/review-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked",
      "comparisonRunning": {
        "pairId": "HOK-1563",
        "primaryPr": 101,
        "challengerPr": 102,
        "startedAt": "$comparison_started_at"
      }
    }
  }
}
EOF

BEHAVIOR_RUNNING="$TMP_DIR/behavior-running.json"
cat > "$BEHAVIOR_RUNNING" <<'EOF'
{
  "pane": {
    "HOK-1563-active-task": "15",
    "HOK-1563_c-review-task": "16"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {
    "task/active-task": "101|OPEN",
    "task/review-task": "102|OPEN"
  },
  "checks": {
    "task/active-task": "pass",
    "task/review-task": "pass"
  }
}
EOF

OUTPUT_RUNNING="$TMP_DIR/output-running.txt"
run_render "$STATE_FILE_RUNNING" "$WORKTREES_DIR" "$BEHAVIOR_RUNNING" "$OUTPUT_RUNNING"

if grep -Eq 'eval running \([0-9]+s\): side=primary pr=#101 phase=eval' "$OUTPUT_RUNNING"; then
  pass "renders eval running detail with seconds elapsed"
else
  fail "eval running detail is missing or malformed"
fi

if grep -q 'comparison running (0s): pair=HOK-1563 prs=#101/#102' "$OUTPUT_RUNNING"; then
  pass "clamps future comparison startedAt to 0s"
else
  fail "future comparison startedAt did not clamp to 0s"
fi

STATE_FILE_READY="$TMP_DIR/state-ready.json"
cat > "$STATE_FILE_READY" <<EOF
{
  "tasks": {
    "HOK-1302": {
      "slug": "ready-task",
      "branch": "task/ready-task",
      "worktree": "$WORKTREES_DIR/ready-task",
      "status": "",
      "phase": "ready",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_READY="$TMP_DIR/behavior-ready.json"
cat > "$BEHAVIOR_READY" <<'EOF'
{
  "pane": {
    "HOK-1302-ready-task": "6"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_READY="$TMP_DIR/output-ready.txt"
run_render "$STATE_FILE_READY" "$WORKTREES_DIR" "$BEHAVIOR_READY" "$OUTPUT_READY"

if grep -q 'HOK-1302.*ready-task.*🚦 ready.*● running' "$OUTPUT_READY"; then
  pass "shows ready phase with emoji"
else
  fail "ready phase row is missing emoji"
fi

STATE_FILE_READY_CONFLICT="$TMP_DIR/state-ready-conflict.json"
cat > "$STATE_FILE_READY_CONFLICT" <<EOF
{
  "tasks": {
    "HOK-1305": {
      "slug": "ready-conflict-task",
      "branch": "task/ready-conflict-task",
      "worktree": "$WORKTREES_DIR/ready-conflict-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    }
  }
}
EOF

BEHAVIOR_READY_CONFLICT="$TMP_DIR/behavior-ready-conflict.json"
cat > "$BEHAVIOR_READY_CONFLICT" <<'EOF'
{
  "pane": {
    "HOK-1305-ready-conflict-task": "11"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {
    "task/ready-conflict-task": "413|OPEN"
  },
  "checks": {
    "task/ready-conflict-task": "pass"
  }
}
EOF

touch "$WORKTREES_DIR/ready-conflict-task/features/ready-conflict-task/.conflict-detected"

OUTPUT_READY_CONFLICT="$TMP_DIR/output-ready-conflict.txt"
run_render "$STATE_FILE_READY_CONFLICT" "$WORKTREES_DIR" "$BEHAVIOR_READY_CONFLICT" "$OUTPUT_READY_CONFLICT"

if grep -q 'HOK-1305.*ready-conflict-task.*⚠ ready.*● running.*#413 ⚠' "$OUTPUT_READY_CONFLICT" \
  && ! grep -q 'HOK-1305.*ready-conflict-task.*🚦 ready.*● running.*#413 ✓' "$OUTPUT_READY_CONFLICT"; then
  pass "shows conflicted ready tasks with warning indicators"
else
  fail "conflicted ready task still looks mergeable"
fi

rm -f "$WORKTREES_DIR/ready-conflict-task/features/ready-conflict-task/.conflict-detected"
OUTPUT_READY_RECOVERED="$TMP_DIR/output-ready-recovered.txt"
run_render "$STATE_FILE_READY_CONFLICT" "$WORKTREES_DIR" "$BEHAVIOR_READY_CONFLICT" "$OUTPUT_READY_RECOVERED"

if grep -q 'HOK-1305.*ready-conflict-task.*🚦 ready.*● running.*#413 ✓' "$OUTPUT_READY_RECOVERED" \
  && ! grep -q 'HOK-1305.*ready-conflict-task.*⚠ ready.*● running.*#413 ⚠' "$OUTPUT_READY_RECOVERED"; then
  pass "restores mergeable ready styling after conflict clears"
else
  fail "ready styling did not recover after conflict cleared"
fi

cat > "$WORKTREES_DIR/ready-complete-task/features/ready-complete-task/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "queueState": "ready"
  }
}
EOF

cat > "$WORKTREES_DIR/ready-stale-task/features/ready-stale-task/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "queueState": "ready-stale"
  }
}
EOF

cat > "$WORKTREES_DIR/merged-done-task/features/merged-done-task/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "queueState": "ready-stale"
  }
}
EOF

cat > "$WORKTREES_DIR/merge-candidate-task/features/merge-candidate-task/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "queueState": "merge-candidate"
  }
}
EOF

cat > "$WORKTREES_DIR/ready-failed-task/features/ready-failed-task/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "failed"
}
EOF

cat > "$WORKTREES_DIR/ready-failed-task/features/ready-failed-task/.needs-attention" <<'EOF'
Remediation exhausted after 3 attempt(s) for PR #378.
EOF

STATE_FILE_READY_CLASSIFY="$TMP_DIR/state-ready-classify.json"
cat > "$STATE_FILE_READY_CLASSIFY" <<EOF
{
  "tasks": {
    "HOK-1303": {
      "slug": "ready-complete-task",
      "branch": "task/ready-complete-task",
      "worktree": "$WORKTREES_DIR/ready-complete-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    },
    "HOK-1304": {
      "slug": "ready-failed-task",
      "branch": "task/ready-failed-task",
      "worktree": "$WORKTREES_DIR/ready-failed-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    }
  }
}
EOF

BEHAVIOR_READY_CLASSIFY="$TMP_DIR/behavior-ready-classify.json"
cat > "$BEHAVIOR_READY_CLASSIFY" <<'EOF'
{
  "pane": {
    "HOK-1303-ready-complete-task": "9",
    "HOK-1304-ready-failed-task": "10"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {
    "task/ready-complete-task": "411|OPEN",
    "task/ready-failed-task": "412|OPEN"
  },
  "checks": {
    "task/ready-complete-task": "pass",
    "task/ready-failed-task": "fail"
  }
}
EOF

OUTPUT_READY_CLASSIFY="$TMP_DIR/output-ready-classify.txt"
run_render "$STATE_FILE_READY_CLASSIFY" "$WORKTREES_DIR" "$BEHAVIOR_READY_CLASSIFY" "$OUTPUT_READY_CLASSIFY"

if grep -q '📥 INBOX (2)' "$OUTPUT_READY_CLASSIFY" && ! grep -q '⚡ ACTIVE (2)' "$OUTPUT_READY_CLASSIFY"; then
  pass "classifies completed or attention-needed ready tasks as inbox items"
else
  fail "ready-task controller state did not move actionable tasks into inbox"
fi

if grep -q 'HOK-1304.*ready-failed-task.*🚦 ready.*● running.*#412 ✗' "$OUTPUT_READY_CLASSIFY" \
  && grep -q 'Remediation exhausted after 3 attempt(s) for PR #378.' "$OUTPUT_READY_CLASSIFY"; then
  pass "shows ready attention detail for failed ready tasks"
else
  fail "failed ready task detail or status is missing"
fi

STATE_FILE_READY_QUEUE="$TMP_DIR/state-ready-queue.txt"
cat > "$STATE_FILE_READY_QUEUE" <<EOF
{
  "tasks": {
    "HOK-1310": {
      "slug": "ready-complete-task",
      "branch": "task/ready-complete-task",
      "worktree": "$WORKTREES_DIR/ready-complete-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    },
    "HOK-1311": {
      "slug": "ready-stale-task",
      "branch": "task/ready-stale-task",
      "worktree": "$WORKTREES_DIR/ready-stale-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    },
    "HOK-1312": {
      "slug": "merge-candidate-task",
      "branch": "task/merge-candidate-task",
      "worktree": "$WORKTREES_DIR/merge-candidate-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    },
    "HOK-1313": {
      "slug": "merged-done-task",
      "branch": "task/merged-done-task",
      "worktree": "$WORKTREES_DIR/merged-done-task",
      "status": "merged",
      "phase": "ready",
      "pr": "tracked"
    }
  }
}
EOF

BEHAVIOR_READY_QUEUE="$TMP_DIR/behavior-ready-queue.json"
cat > "$BEHAVIOR_READY_QUEUE" <<'EOF'
{
  "pane": {
    "HOK-1310-ready-complete-task": "15",
    "HOK-1311-ready-stale-task": "16",
    "HOK-1312-merge-candidate-task": "17",
    "HOK-1313-merged-done-task": "18"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {
    "task/ready-complete-task": "421|OPEN",
    "task/ready-stale-task": "422|OPEN",
    "task/merge-candidate-task": "423|OPEN",
    "task/merged-done-task": "424|MERGED"
  },
  "checks": {
    "task/ready-complete-task": "pass",
    "task/ready-stale-task": "pass",
    "task/merge-candidate-task": "pass",
    "task/merged-done-task": "pass"
  }
}
EOF

OUTPUT_READY_QUEUE="$TMP_DIR/output-ready-queue.txt"
run_render "$STATE_FILE_READY_QUEUE" "$WORKTREES_DIR" "$BEHAVIOR_READY_QUEUE" "$OUTPUT_READY_QUEUE"

if grep -q 'HOK-1310.*🚦 ready' "$OUTPUT_READY_QUEUE" \
  && grep -q 'HOK-1311.*ready-stale' "$OUTPUT_READY_QUEUE" \
  && grep -q 'HOK-1312.*merge-candidate' "$OUTPUT_READY_QUEUE"; then
  pass "renders ready queue states distinctly"
else
  fail "ready queue state labels are missing"
fi

if grep -q 'HOK-1313.*✓ done.*✓ merged.*#424 MERGED' "$OUTPUT_READY_QUEUE" \
  && ! grep -q 'HOK-1313.*ready-stale' "$OUTPUT_READY_QUEUE"; then
  pass "merged tasks override stale ready queue labels"
else
  fail "merged task should not display stale ready queue label"
fi

STATE_FILE_READY_WATCHDOG="$TMP_DIR/state-ready-watchdog.json"
rm -f "$WORKTREES_DIR/ready-failed-task/features/ready-failed-task/.needs-attention"
cat > "$STATE_FILE_READY_WATCHDOG" <<EOF
{
  "tasks": {
    "HOK-1306": {
      "slug": "ready-task",
      "branch": "task/ready-task",
      "worktree": "$WORKTREES_DIR/ready-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    },
    "HOK-1307": {
      "slug": "active-task",
      "branch": "task/active-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    },
    "HOK-1308": {
      "slug": "ready-complete-task",
      "branch": "task/ready-complete-task",
      "worktree": "$WORKTREES_DIR/ready-complete-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    },
    "HOK-1309": {
      "slug": "ready-failed-task",
      "branch": "task/ready-failed-task",
      "worktree": "$WORKTREES_DIR/ready-failed-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    }
  }
}
EOF

cat > "$TMP_DIR/ready-watchdog-state.json" <<'EOF'
{
  "updatedAt": "2026-05-05T12:30:00.000Z",
  "tasks": {
    "HOK-1306": {
      "issueId": "HOK-1306",
      "slug": "ready-task",
      "prNumber": 414,
      "classification": "waiting-on-ci",
      "displayLabel": "waiting on CI",
      "detail": "Checks still pending: build (PENDING).",
      "action": "reported",
      "updatedAt": "2026-05-05T12:30:00.000Z",
      "idleMinutes": 12,
      "lastProgressAt": "2026-05-05T12:18:00.000Z"
    },
    "HOK-1307": {
      "issueId": "HOK-1307",
      "slug": "active-task",
      "prNumber": 415,
      "classification": "waiting-on-eval-comparison",
      "displayLabel": "waiting on eval/comparison",
      "detail": "Background jobs still running: eval:eval-HOK-1307-primary-415.",
      "action": "reported",
      "updatedAt": "2026-05-05T12:30:00.000Z",
      "idleMinutes": 14,
      "lastProgressAt": "2026-05-05T12:16:00.000Z"
    },
    "HOK-1308": {
      "issueId": "HOK-1308",
      "slug": "ready-complete-task",
      "prNumber": 411,
      "classification": "stuck",
      "displayLabel": "stuck",
      "detail": "Local ready state has been idle for 30m while PR #411 is clean and green.",
      "action": "auto-recovered",
      "updatedAt": "2026-05-05T12:30:00.000Z",
      "idleMinutes": 30,
      "lastProgressAt": "2026-05-05T12:00:00.000Z"
    },
    "HOK-1309": {
      "issueId": "HOK-1309",
      "slug": "ready-failed-task",
      "prNumber": 412,
      "classification": "needs-user",
      "displayLabel": "needs user",
      "detail": "PR #412 has real merge conflicts on GitHub.",
      "action": "reported",
      "updatedAt": "2026-05-05T12:30:00.000Z",
      "idleMinutes": 18,
      "lastProgressAt": "2026-05-05T12:12:00.000Z"
    }
  }
}
EOF

BEHAVIOR_READY_WATCHDOG="$TMP_DIR/behavior-ready-watchdog.json"
cat > "$BEHAVIOR_READY_WATCHDOG" <<'EOF'
{
  "pane": {
    "HOK-1306-ready-task": "8",
    "HOK-1307-stale-task": "13",
    "HOK-1307-active-task": "13",
    "HOK-1308-ready-complete-task": "9",
    "HOK-1309-ready-failed-task": "10"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {
    "task/ready-task": "414|OPEN",
    "task/active-task": "415|OPEN",
    "task/ready-complete-task": "411|OPEN",
    "task/ready-failed-task": "412|OPEN"
  },
  "checks": {
    "task/ready-task": "pending",
    "task/active-task": "pass",
    "task/ready-complete-task": "pass",
    "task/ready-failed-task": "fail"
  }
}
EOF

OUTPUT_READY_WATCHDOG="$TMP_DIR/output-ready-watchdog.txt"
run_render "$STATE_FILE_READY_WATCHDOG" "$WORKTREES_DIR" "$BEHAVIOR_READY_WATCHDOG" "$OUTPUT_READY_WATCHDOG"

if grep -q '📥 INBOX (2)' "$OUTPUT_READY_WATCHDOG" && grep -q '⚡ ACTIVE (2)' "$OUTPUT_READY_WATCHDOG"; then
  pass "watchdog puts stuck and needs-user ready tasks in inbox while CI/eval waits stay active"
else
  fail "watchdog classification did not split ready tasks into inbox and active sections"
fi

if grep -q 'Checks still pending: build (PENDING).' "$OUTPUT_READY_WATCHDOG" \
  && grep -q 'Background jobs still running:' "$OUTPUT_READY_WATCHDOG" \
  && grep -q 'Local ready state has been idle for 30m' "$OUTPUT_READY_WATCHDOG" \
  && grep -q 'PR #412 has real merge conflicts' "$OUTPUT_READY_WATCHDOG"; then
  pass "watchdog detail lines render all ready classifications"
else
  fail "watchdog detail lines are missing one or more ready classifications"
fi

STATE_FILE_READY_EXITED="$TMP_DIR/state-ready-exited.json"
cat > "$STATE_FILE_READY_EXITED" <<EOF
{
  "tasks": {
    "HOK-1310": {
      "slug": "ready-task",
      "branch": "task/ready-task",
      "worktree": "$WORKTREES_DIR/ready-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    }
  }
}
EOF

cat > "$TMP_DIR/ready-watchdog-state.json" <<'EOF'
{
  "updatedAt": "2026-05-05T12:30:00.000Z",
  "tasks": {
    "HOK-1310": {
      "issueId": "HOK-1310",
      "slug": "ready-task",
      "prNumber": 414,
      "classification": "needs-user",
      "displayLabel": "needs user",
      "detail": "Conflict remediation worker is inactive and the worktree is unsafe to mutate automatically for PR #414: MERGE_HEAD=base-sha; unmerged=package.json. Next command: cd /tmp/worktree && git status --short && git diff --check",
      "action": "needs-user",
      "updatedAt": "2026-05-05T12:30:00.000Z",
      "idleMinutes": 20,
      "lastProgressAt": "2026-05-05T12:10:00.000Z"
    }
  }
}
EOF

BEHAVIOR_READY_EXITED="$TMP_DIR/behavior-ready-exited.json"
cat > "$BEHAVIOR_READY_EXITED" <<'EOF'
{
  "pane": {
    "HOK-1310-ready-task": "14"
  },
  "hook": {},
  "reported": {
    "HOK-1310": "staging and lint passed"
  },
  "planning": {},
  "pr": {
    "task/ready-task": "414|OPEN"
  },
  "checks": {
    "task/ready-task": "pending"
  }
}
EOF

OUTPUT_READY_EXITED="$TMP_DIR/output-ready-exited.txt"
run_render "$STATE_FILE_READY_EXITED" "$WORKTREES_DIR" "$BEHAVIOR_READY_EXITED" "$OUTPUT_READY_EXITED"

if grep -q 'Conflict remediation worker is inactive' "$OUTPUT_READY_EXITED" \
  && ! grep -q 'staging and lint passed' "$OUTPUT_READY_EXITED"; then
  pass "exited ready pane prefers watchdog git truth over stale status text"
else
  fail "exited ready pane did not override stale status text"
fi

STATE_FILE_READY_PLANNING_STALE="$TMP_DIR/state-ready-planning-stale.json"
cat > "$STATE_FILE_READY_PLANNING_STALE" <<EOF
{
  "tasks": {
    "HOK-1311": {
      "slug": "ready-task",
      "branch": "task/ready-task",
      "worktree": "$WORKTREES_DIR/ready-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    },
    "HOK-1312": {
      "slug": "active-task",
      "branch": "task/active-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "ready",
      "pr": "tracked"
    }
  }
}
EOF

cat > "$TMP_DIR/ready-watchdog-state.json" <<'EOF'
{
  "updatedAt": "2026-05-05T12:30:00.000Z",
  "tasks": {}
}
EOF

BEHAVIOR_READY_PLANNING_STALE="$TMP_DIR/behavior-ready-planning-stale.json"
cat > "$BEHAVIOR_READY_PLANNING_STALE" <<'EOF'
{
  "pane": {
    "HOK-1311-ready-task": "15",
    "HOK-1312-active-task": "16"
  },
  "hook": {
    "HOK-1311": "planning_awaiting_user"
  },
  "reported": {
    "HOK-1312": "awaiting plan approval"
  },
  "planning": {},
  "pr": {
    "task/ready-task": "414|OPEN",
    "task/active-task": "415|OPEN"
  },
  "checks": {
    "task/ready-task": "pass",
    "task/active-task": "pass"
  }
}
EOF

OUTPUT_READY_PLANNING_STALE="$TMP_DIR/output-ready-planning-stale.txt"
run_render "$STATE_FILE_READY_PLANNING_STALE" "$WORKTREES_DIR" "$BEHAVIOR_READY_PLANNING_STALE" "$OUTPUT_READY_PLANNING_STALE"

if grep -q 'HOK-1311.*ready' "$OUTPUT_READY_PLANNING_STALE" \
  && grep -q 'HOK-1312.*ready' "$OUTPUT_READY_PLANNING_STALE" \
  && ! grep -q 'planning_awaiting_user' "$OUTPUT_READY_PLANNING_STALE" \
  && ! grep -q 'awaiting plan approval' "$OUTPUT_READY_PLANNING_STALE"; then
  pass "ready rows suppress stale planning approval detail"
else
  fail "ready rows still render stale planning approval detail"
fi

printf '%s\n' 'Review verdict does not pass readiness gate for PR #414 (status=completed, exitCode=missing).' \
  > "$WORKTREES_DIR/ready-task/features/ready-task/.needs-attention"
BEHAVIOR_READY_REVIEW_STALE="$TMP_DIR/behavior-ready-review-stale.json"
cat > "$BEHAVIOR_READY_REVIEW_STALE" <<'EOF'
{
  "pane": {
    "HOK-1311-ready-task": "15",
    "HOK-1312-active-task": "16"
  },
  "reported": {
    "HOK-1312": "blocked by scope guard"
  },
  "planning": {},
  "pr": {
    "task/ready-task": "414|OPEN",
    "task/active-task": "415|OPEN"
  },
  "checks": {
    "task/ready-task": "pass",
    "task/active-task": "pass"
  }
}
EOF

OUTPUT_READY_REVIEW_STALE="$TMP_DIR/output-ready-review-stale.txt"
run_render "$STATE_FILE_READY_PLANNING_STALE" "$WORKTREES_DIR" "$BEHAVIOR_READY_REVIEW_STALE" "$OUTPUT_READY_REVIEW_STALE"
rm -f "$WORKTREES_DIR/ready-task/features/ready-task/.needs-attention"

if grep -q '⚡ ACTIVE (2)' "$OUTPUT_READY_REVIEW_STALE" \
  && ! grep -q 'Review verdict does not pass readiness gate' "$OUTPUT_READY_REVIEW_STALE" \
  && ! grep -q 'blocked by scope guard' "$OUTPUT_READY_REVIEW_STALE"; then
  pass "ready rows suppress stale review-gate detail"
else
  fail "ready rows still render stale review-gate detail"
fi

echo ""
echo "=== wavemill-status pr_checks rollup handling ==="

run_pr_checks() {
  local cache="$1"
  local branch="$2"
  (
    SESSION_NAME="pr-checks-$RANDOM"
    cache_path="/tmp/${SESSION_NAME}-pr-cache.json"
    cp "$cache" "$cache_path"
    set -- "$SESSION_NAME" "$TMP_DIR" ""
    # Preserve stdout on fd 3; silence everything else so tput cursor codes
    # (civis/cnorm) emitted by the sourced script don't pollute captured output.
    exec 3>&1
    exec >/dev/null 2>&1
    source "$REPO_DIR/shared/lib/wavemill-status.sh"
    trap - EXIT
    pr_checks "$branch" >&3
    rm -f "$cache_path"
  )
}

assert_pr_check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label (got '$actual')"
  else
    fail "$label (expected '$expected', got '$actual')"
  fi
}

ROLLUP_FIXTURE="$TMP_DIR/rollup.json"
cat > "$ROLLUP_FIXTURE" <<'EOF'
[
  {
    "headRefName": "task/status-context-success",
    "statusCheckRollup": [
      {"__typename":"StatusContext","context":"Vercel","state":"SUCCESS","conclusion":null},
      {"__typename":"CheckRun","name":"build","state":null,"conclusion":"SUCCESS"}
    ]
  },
  {
    "headRefName": "task/status-context-pending",
    "statusCheckRollup": [
      {"__typename":"StatusContext","context":"Vercel","state":"PENDING","conclusion":null},
      {"__typename":"CheckRun","name":"build","state":null,"conclusion":"SUCCESS"}
    ]
  },
  {
    "headRefName": "task/status-context-failure",
    "statusCheckRollup": [
      {"__typename":"StatusContext","context":"Vercel","state":"FAILURE","conclusion":null},
      {"__typename":"CheckRun","name":"build","state":null,"conclusion":"SUCCESS"}
    ]
  },
  {
    "headRefName": "task/check-run-skipped",
    "statusCheckRollup": [
      {"__typename":"CheckRun","name":"optional","conclusion":"SKIPPED"}
    ]
  },
  {
    "headRefName": "task/check-run-timed-out",
    "statusCheckRollup": [
      {"__typename":"CheckRun","name":"build","conclusion":"TIMED_OUT"}
    ]
  },
  {
    "headRefName": "task/empty-rollup",
    "statusCheckRollup": []
  }
]
EOF

assert_pr_check "StatusContext SUCCESS + CheckRun SUCCESS -> pass" \
  "pass" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/status-context-success")"
assert_pr_check "StatusContext PENDING -> pending" \
  "pending" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/status-context-pending")"
assert_pr_check "StatusContext FAILURE -> fail" \
  "fail" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/status-context-failure")"
assert_pr_check "CheckRun SKIPPED -> pass" \
  "pass" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/check-run-skipped")"
assert_pr_check "CheckRun TIMED_OUT -> fail" \
  "fail" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/check-run-timed-out")"
assert_pr_check "Empty rollup -> none" \
  "none" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/empty-rollup")"

# Regression guard: verify save_migration_reservation exists in the monitor script.
# This guards against regressions where the function gets moved out of the monitor
# script and becomes unavailable to the generated monitor script at runtime.
echo ""
echo "=== Monitor Script Regression Guards ==="
HEREDOC_CONTENT=$(cat "$REPO_DIR/shared/lib/wavemill-monitor.sh")
MATCH_COUNT=$(echo "$HEREDOC_CONTENT" | grep -c "^save_migration_reservation()" || true)
if [ "$MATCH_COUNT" -gt 0 ]; then
  pass "save_migration_reservation is defined in the monitor script"
else
  fail "save_migration_reservation missing from monitor script (will cause 'command not found' at runtime)"
fi

echo ""
echo "=== Artifact Status Segment (HOK-2261) ==="

# Helper: call render_artifact_status_segment in an isolated subshell.
run_artifact_segment() {
  local feature_dir="$1"
  (
    set -- test-session "$TMP_DIR"
    # Silence startup side-effects (tput civis, etc.)
    exec 3>&1
    exec >/dev/null 2>&1
    source "$REPO_DIR/shared/lib/wavemill-status.sh"
    trap - EXIT
    render_artifact_status_segment "$feature_dir" >&3
  )
}

# Helper: call render_artifact_status_segment and capture only stderr.
run_artifact_segment_stderr() {
  local feature_dir="$1"
  (
    set -- test-session "$TMP_DIR"
    exec >/dev/null
    source "$REPO_DIR/shared/lib/wavemill-status.sh" 2>/dev/null
    trap - EXIT
    render_artifact_status_segment "$feature_dir" >/dev/null
  ) 2>&1
}

# ── Test 1: All artifacts present ──────────────────────────────────────────
ART_DIR_ALL="$TMP_DIR/artifact-all"
mkdir -p "$ART_DIR_ALL"

printf 'plan content' > "$ART_DIR_ALL/plan.md"
PLAN_HASH=$(shasum -a 256 "$ART_DIR_ALL/plan.md" 2>/dev/null | cut -d' ' -f1 \
  || sha256sum "$ART_DIR_ALL/plan.md" 2>/dev/null | cut -d' ' -f1)

cat > "$ART_DIR_ALL/task-contract.json" <<EOF
{
  "schemaVersion": "1.0.0",
  "sources": [
    {"path": "plan.md", "exists": true, "sha256": "$PLAN_HASH"}
  ]
}
EOF

cat > "$ART_DIR_ALL/feature-state.json" <<'EOF'
{
  "normalizedState": "done",
  "currentPhase": "done",
  "failureReason": null,
  "evidence": [
    {"kind": "review_passed", "status": "pass"},
    {"kind": "ci_passed", "status": "pass"},
    {"kind": "merged", "status": "pass"}
  ]
}
EOF

cat > "$ART_DIR_ALL/.trace-context.json" <<'EOF'
{"traceId": "abc123def456"}
EOF

cat > "$ART_DIR_ALL/trace.jsonl" <<'EOF'
{"traceId": "abc123def456", "phase": "coding", "event": "phase_started"}
{"traceId": "abc123def456", "phase": "review", "event": "phase_started"}
EOF

SEG_ALL=$(run_artifact_segment "$ART_DIR_ALL")
if [[ "$SEG_ALL" == *"C✓"* ]] \
  && [[ "$SEG_ALL" == *"O:done"* ]] \
  && [[ "$SEG_ALL" == *"E:3"* ]] \
  && [[ "$SEG_ALL" == *"T:review"* ]]; then
  pass "all artifacts present: segment shows C✓, outcome, evidence count, trace phase"
else
  fail "all artifacts present: unexpected segment '$SEG_ALL'"
fi

# ── Test 2: Contract missing, other artifacts present ──────────────────────
ART_DIR_NO_CONTRACT="$TMP_DIR/artifact-no-contract"
mkdir -p "$ART_DIR_NO_CONTRACT"

cat > "$ART_DIR_NO_CONTRACT/feature-state.json" <<'EOF'
{
  "normalizedState": "running",
  "currentPhase": "coding",
  "failureReason": null,
  "evidence": [{"kind": "planning_passed", "status": "pass"}]
}
EOF

cat > "$ART_DIR_NO_CONTRACT/.trace-context.json" <<'EOF'
{"traceId": "xyz789"}
EOF

SEG_NO_CONTRACT=$(run_artifact_segment "$ART_DIR_NO_CONTRACT")
if [[ "$SEG_NO_CONTRACT" == *"C-"* ]] && [[ "$SEG_NO_CONTRACT" == *"O:running"* ]]; then
  pass "contract missing: segment shows C- with other fields populated"
else
  fail "contract missing: unexpected segment '$SEG_NO_CONTRACT'"
fi

# ── Test 3: Stale contract (source hash drift) ─────────────────────────────
ART_DIR_STALE="$TMP_DIR/artifact-stale"
mkdir -p "$ART_DIR_STALE"

printf 'original content' > "$ART_DIR_STALE/plan.md"

cat > "$ART_DIR_STALE/task-contract.json" <<'EOF'
{
  "schemaVersion": "1.0.0",
  "sources": [
    {"path": "plan.md", "exists": true, "sha256": "0000000000000000000000000000000000000000000000000000000000000000"}
  ]
}
EOF

SEG_STALE=$(run_artifact_segment "$ART_DIR_STALE")
if [[ "$SEG_STALE" == *"C⚠"* ]]; then
  pass "stale contract (hash mismatch): segment shows C⚠ marker"
else
  fail "stale contract: unexpected segment '$SEG_STALE'"
fi

# ── Test 4: Legacy task (no artifacts at all) ──────────────────────────────
ART_DIR_LEGACY="$TMP_DIR/artifact-legacy"
mkdir -p "$ART_DIR_LEGACY"

SEG_LEGACY=$(run_artifact_segment "$ART_DIR_LEGACY")
if [[ "$SEG_LEGACY" == "C- O:- E:- T:-" ]]; then
  pass "legacy task (no artifacts): segment shows all dashes"
else
  fail "legacy task: unexpected segment '$SEG_LEGACY'"
fi

# ── Test 5: Malformed JSON contract treated as missing ─────────────────────
ART_DIR_MALFORMED="$TMP_DIR/artifact-malformed"
mkdir -p "$ART_DIR_MALFORMED"
printf 'not valid json {' > "$ART_DIR_MALFORMED/task-contract.json"

SEG_MALFORMED=$(run_artifact_segment "$ART_DIR_MALFORMED" 2>/dev/null)
if [[ "$SEG_MALFORMED" == *"C-"* ]]; then
  pass "malformed contract JSON: treated as missing (C-)"
else
  fail "malformed contract JSON: unexpected segment '$SEG_MALFORMED'"
fi

# ── Test 6: Segment width fits 80-column pane ─────────────────────────────
SEG_LEN=${#SEG_ALL}
# Dashboard detail line prefix is ~21 chars ("          └─ artifacts: ")
# leaving ~59 chars. Segment target is ≤40 chars per plan.
if [[ $SEG_LEN -le 40 ]]; then
  pass "artifact segment width ($SEG_LEN chars) fits 80-column pane (≤40)"
else
  fail "artifact segment width ($SEG_LEN chars) exceeds 40-char target"
fi

# ── Test 7: No stderr noise for missing artifacts (announce-once) ──────────
STDERR_LEGACY=$(run_artifact_segment_stderr "$ART_DIR_LEGACY")
STDERR_LEGACY2=$(run_artifact_segment_stderr "$ART_DIR_LEGACY")
if [[ -z "$STDERR_LEGACY" && -z "$STDERR_LEGACY2" ]]; then
  pass "no stderr warnings for legacy task (two consecutive render calls)"
else
  fail "unexpected stderr output for legacy task: '$STDERR_LEGACY'"
fi

# ── Test 8: Segment appears in full dashboard output ──────────────────────
ART_WT="$TMP_DIR/artifact-worktree"
mkdir -p "$ART_WT/features/artifact-task"
cp "$ART_DIR_ALL/task-contract.json" "$ART_WT/features/artifact-task/"
cp "$ART_DIR_ALL/plan.md"            "$ART_WT/features/artifact-task/"
cp "$ART_DIR_ALL/feature-state.json" "$ART_WT/features/artifact-task/"
cp "$ART_DIR_ALL/.trace-context.json" "$ART_WT/features/artifact-task/"
cp "$ART_DIR_ALL/trace.jsonl"         "$ART_WT/features/artifact-task/"

STATE_ARTIFACT="$TMP_DIR/state-artifact.json"
cat > "$STATE_ARTIFACT" <<EOF
{
  "tasks": {
    "HOK-9001": {
      "slug": "artifact-task",
      "branch": "task/artifact-task",
      "worktree": "$ART_WT",
      "status": "",
      "phase": "coding",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_ARTIFACT="$TMP_DIR/behavior-artifact.json"
cat > "$BEHAVIOR_ARTIFACT" <<'EOF'
{
  "pane": {"HOK-9001-artifact-task": "7"},
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_ARTIFACT="$TMP_DIR/output-artifact.txt"
run_render "$STATE_ARTIFACT" "$TMP_DIR" "$BEHAVIOR_ARTIFACT" "$OUTPUT_ARTIFACT"

if grep -q 'artifacts:' "$OUTPUT_ARTIFACT" && grep -q 'C✓' "$OUTPUT_ARTIFACT"; then
  pass "artifact segment appears in rendered dashboard output"
else
  fail "artifact segment missing from dashboard output"
fi

# ── Test 9: Legacy task shows all-dashes segment in dashboard ─────────────
ART_LEGACY_WT="$TMP_DIR/legacy-artifact-worktree"
mkdir -p "$ART_LEGACY_WT/features/legacy-art-task"

STATE_LEGACY_ART="$TMP_DIR/state-legacy-art.json"
cat > "$STATE_LEGACY_ART" <<EOF
{
  "tasks": {
    "HOK-9002": {
      "slug": "legacy-art-task",
      "branch": "task/legacy-art-task",
      "worktree": "$ART_LEGACY_WT",
      "status": "",
      "phase": "coding",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_LEGACY_ART="$TMP_DIR/behavior-legacy-art.json"
cat > "$BEHAVIOR_LEGACY_ART" <<'EOF'
{
  "pane": {"HOK-9002-legacy-art-task": "8"},
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_LEGACY_ART="$TMP_DIR/output-legacy-art.txt"
run_render "$STATE_LEGACY_ART" "$TMP_DIR" "$BEHAVIOR_LEGACY_ART" "$OUTPUT_LEGACY_ART"

if grep -q 'artifacts: C- O:- E:- T:-' "$OUTPUT_LEGACY_ART"; then
  pass "legacy task shows all-dashes artifact segment in dashboard"
else
  fail "legacy task artifact segment missing or malformed in dashboard output"
fi

# ── Test 10: REQ-F3 — wavemill-status.sh has no native-specific liveness branch
# Native phases must reuse the existing hook/pane liveness path; no native-only
# fallback or branch should be introduced.
WAVEMILL_STATUS_SH="$REPO_DIR/shared/lib/wavemill-status.sh"
if ! grep -Eq '(agent[ _-]?type|provider|adapter)[^\n]{0,40}=[^\n]{0,40}native|case[^\n]{0,40}native\)|(^|[[:space:]])if[[:space:]][^\n]{0,40}native' "$WAVEMILL_STATUS_SH"; then
  pass "wavemill-status.sh has no native-specific liveness branch (REQ-F3)"
else
  fail "wavemill-status.sh contains a native-specific branch — native phases must reuse existing hook states"
fi

echo ""
echo "=== New hook states: blocked, approval-needed, policy-denied (HOK-2370) ==="

mkdir -p \
  "$WORKTREES_DIR/waiting-hook-task/features/waiting-hook-task" \
  "$WORKTREES_DIR/blocked-task/features/blocked-task" \
  "$WORKTREES_DIR/approval-task/features/approval-task" \
  "$WORKTREES_DIR/denied-task/features/denied-task"

# ── Blocked state renders distinctly and goes to inbox ─────────────────────

STATE_FILE_BLOCKED_STATE="$TMP_DIR/state-blocked-state.json"
cat > "$STATE_FILE_BLOCKED_STATE" <<EOF
{
  "tasks": {
    "HOK-2370-A": {
      "slug": "blocked-task",
      "branch": "task/blocked-task",
      "worktree": "$WORKTREES_DIR/blocked-task",
      "status": "",
      "phase": "coding",
      "pr": ""
    },
    "HOK-2370-B": {
      "slug": "active-task",
      "branch": "task/active-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "coding",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_BLOCKED_STATE="$TMP_DIR/behavior-blocked-state.json"
cat > "$BEHAVIOR_BLOCKED_STATE" <<'EOF'
{
  "pane": {
    "HOK-2370-A-blocked-task": "4",
    "HOK-2370-B-active-task": "5"
  },
  "hook": {
    "HOK-2370-A": "cannot proceed: merge conflict"
  },
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

run_render_with_agent_states() {
  local state_file="$1" workspace_root="$2" behavior_file="$3" output_file="$4"
  local blocked_issue="$5" approval_issue="$6" denied_issue="$7"
  (
    export WAVEMILL_TIP_INDEX=0
    set -- test-session "$workspace_root" "$state_file"
    source "$REPO_DIR/shared/lib/wavemill-status.sh"

    refresh_pr_cache() { :; }
    clear_dashboard_scrollback() { :; }
    redraw_dashboard_frame() { :; }

    elapsed() {
      echo "1m"
    }

    is_active() { return 0; }

    agent_status() {
      case "$1" in
        "$blocked_issue")  echo "blocked" ;;
        "$approval_issue") echo "approval-needed" ;;
        "$denied_issue")   echo "policy-denied" ;;
        HOK-2370-W)        echo "waiting" ;;
        *) echo "running" ;;
      esac
    }

    window_index() {
      local win="$1-$2"
      jq -r --arg win "$win" '.pane[$win] // "—"' "$behavior_file"
    }

    agent_hook_detail() {
      local issue="$1"
      jq -r --arg issue "$issue" '.hook[$issue] // empty' "$behavior_file"
    }

    agent_hook_next_action() {
      local issue="$1"
      jq -r --arg issue "$issue" '.next_action[$issue] // empty' "$behavior_file"
    }

    agent_reported_status() { return 0; }
    get_planning_display_status() { return 0; }
    pr_for_branch() { return 0; }
    pr_checks() { return 0; }

    render_dashboard
    strip_ansi < "$FRAME" > "$output_file"
  )
}

# ── Waiting state stays distinct from approval-needed ──────────────────────

STATE_FILE_WAITING_STATE="$TMP_DIR/state-waiting-state.json"
cat > "$STATE_FILE_WAITING_STATE" <<EOF
{
  "tasks": {
    "HOK-2370-W": {
      "slug": "waiting-hook-task",
      "branch": "task/waiting-hook-task",
      "worktree": "$WORKTREES_DIR/waiting-hook-task",
      "status": "",
      "phase": "coding",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_WAITING_STATE="$TMP_DIR/behavior-waiting-state.json"
cat > "$BEHAVIOR_WAITING_STATE" <<'EOF'
{
  "pane": {
    "HOK-2370-W-waiting-hook-task": "3"
  },
  "hook": {
    "HOK-2370-W": "waiting on CI shard 3/5"
  },
  "next_action": {
    "HOK-2370-W": "this line should not render for generic waiting"
  },
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_WAITING_STATE="$TMP_DIR/output-waiting-state.txt"
run_render_with_agent_states "$STATE_FILE_WAITING_STATE" "$WORKTREES_DIR" "$BEHAVIOR_WAITING_STATE" "$OUTPUT_WAITING_STATE" \
  "" "" ""

if grep -q '📥 INBOX (1)' "$OUTPUT_WAITING_STATE" \
  && grep -q 'HOK-2370-W.*waiting-hook-task.*⏳ waiting' "$OUTPUT_WAITING_STATE" \
  && ! grep -q '⏳ approval' "$OUTPUT_WAITING_STATE"; then
  pass "waiting state renders distinctly from approval-needed"
else
  fail "waiting state did not render distinctly from approval-needed"
fi

if grep -q 'waiting on CI shard 3/5' "$OUTPUT_WAITING_STATE" \
  && ! grep -q 'this line should not render for generic waiting' "$OUTPUT_WAITING_STATE"; then
  pass "waiting state renders detail without actionable next_action follow-up"
else
  fail "waiting state detail or next_action behavior is incorrect"
fi

OUTPUT_BLOCKED_STATE="$TMP_DIR/output-blocked-state.txt"
run_render_with_agent_states "$STATE_FILE_BLOCKED_STATE" "$WORKTREES_DIR" "$BEHAVIOR_BLOCKED_STATE" "$OUTPUT_BLOCKED_STATE" \
  "HOK-2370-A" "" ""

if grep -q '📥 INBOX (1)' "$OUTPUT_BLOCKED_STATE" \
  && grep -q '⚡ ACTIVE (1)' "$OUTPUT_BLOCKED_STATE" \
  && grep -q 'HOK-2370-A.*blocked-task.*⊘ blocked' "$OUTPUT_BLOCKED_STATE"; then
  pass "blocked state renders ⊘ blocked and moves task to inbox"
else
  fail "blocked state did not render correctly or did not move to inbox"
fi

if grep -q 'cannot proceed: merge conflict' "$OUTPUT_BLOCKED_STATE"; then
  pass "blocked state surfaces hook detail line"
else
  fail "blocked state detail line missing"
fi

# ── Approval-needed state renders distinctly and goes to inbox ─────────────

STATE_FILE_APPROVAL_STATE="$TMP_DIR/state-approval-state.json"
cat > "$STATE_FILE_APPROVAL_STATE" <<EOF
{
  "tasks": {
    "HOK-2370-C": {
      "slug": "approval-task",
      "branch": "task/approval-task",
      "worktree": "$WORKTREES_DIR/approval-task",
      "status": "",
      "phase": "coding",
      "pr": ""
    },
    "HOK-2370-D": {
      "slug": "active-task",
      "branch": "task/active-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "coding",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_APPROVAL_STATE="$TMP_DIR/behavior-approval-state.json"
cat > "$BEHAVIOR_APPROVAL_STATE" <<'EOF'
{
  "pane": {
    "HOK-2370-C-approval-task": "6",
    "HOK-2370-D-active-task": "7"
  },
  "hook": {
    "HOK-2370-C": "waiting for human approval"
  },
  "next_action": {
    "HOK-2370-C": "approve HOK-2370-C to continue"
  },
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_APPROVAL_STATE="$TMP_DIR/output-approval-state.txt"
run_render_with_agent_states "$STATE_FILE_APPROVAL_STATE" "$WORKTREES_DIR" "$BEHAVIOR_APPROVAL_STATE" "$OUTPUT_APPROVAL_STATE" \
  "" "HOK-2370-C" ""

if grep -q '📥 INBOX (1)' "$OUTPUT_APPROVAL_STATE" \
  && grep -q '⚡ ACTIVE (1)' "$OUTPUT_APPROVAL_STATE" \
  && grep -q 'HOK-2370-C.*approval-task.*⏳ approval' "$OUTPUT_APPROVAL_STATE"; then
  pass "approval-needed state renders ⏳ approval and moves task to inbox"
else
  fail "approval-needed state did not render correctly or did not move to inbox"
fi

if grep -q 'waiting for human approval' "$OUTPUT_APPROVAL_STATE" \
  && grep -q 'approve HOK-2370-C to continue' "$OUTPUT_APPROVAL_STATE"; then
  pass "approval-needed surfaces detail and next_action lines"
else
  fail "approval-needed detail or next_action lines missing"
fi

if ! grep -q '! error' "$OUTPUT_APPROVAL_STATE"; then
  pass "approval-needed does not use error styling"
else
  fail "approval-needed incorrectly uses error styling"
fi

# ── Policy-denied state renders distinctly and goes to inbox ───────────────

STATE_FILE_DENIED_STATE="$TMP_DIR/state-denied-state.json"
cat > "$STATE_FILE_DENIED_STATE" <<EOF
{
  "tasks": {
    "HOK-2370-E": {
      "slug": "denied-task",
      "branch": "task/denied-task",
      "worktree": "$WORKTREES_DIR/denied-task",
      "status": "",
      "phase": "coding",
      "pr": ""
    },
    "HOK-2370-F": {
      "slug": "blocked-task",
      "branch": "task/blocked-task",
      "worktree": "$WORKTREES_DIR/blocked-task",
      "status": "",
      "phase": "coding",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_DENIED_STATE="$TMP_DIR/behavior-denied-state.json"
cat > "$BEHAVIOR_DENIED_STATE" <<'EOF'
{
  "pane": {
    "HOK-2370-E-denied-task": "8",
    "HOK-2370-F-blocked-task": "9"
  },
  "hook": {
    "HOK-2370-E": "network policy rejected outbound request",
    "HOK-2370-F": "unable to reach api.example.com"
  },
  "next_action": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_DENIED_STATE="$TMP_DIR/output-denied-state.txt"
run_render_with_agent_states "$STATE_FILE_DENIED_STATE" "$WORKTREES_DIR" "$BEHAVIOR_DENIED_STATE" "$OUTPUT_DENIED_STATE" \
  "HOK-2370-F" "" "HOK-2370-E"

if grep -q '📥 INBOX (2)' "$OUTPUT_DENIED_STATE" \
  && grep -q 'HOK-2370-E.*denied-task.*⛔ denied' "$OUTPUT_DENIED_STATE" \
  && grep -q 'HOK-2370-F.*blocked-task.*⊘ blocked' "$OUTPUT_DENIED_STATE"; then
  pass "policy-denied and blocked both render as actionable inbox items"
else
  fail "policy-denied or blocked did not render correctly in inbox"
fi

if grep -q 'network policy rejected outbound request' "$OUTPUT_DENIED_STATE"; then
  pass "policy-denied surfaces detail line"
else
  fail "policy-denied detail line missing"
fi

if ! grep -q 'approve HOK-2370-C to continue' "$OUTPUT_DENIED_STATE"; then
  pass "policy-denied stays distinct from approval-needed follow-up guidance"
else
  fail "policy-denied incorrectly reused approval-needed next_action guidance"
fi

# Verify denied ≠ blocked label
if grep -q '⛔ denied' "$OUTPUT_DENIED_STATE" && grep -q '⊘ blocked' "$OUTPUT_DENIED_STATE"; then
  if ! grep -q '⛔ blocked' "$OUTPUT_DENIED_STATE" && ! grep -q '⊘ denied' "$OUTPUT_DENIED_STATE"; then
    pass "policy-denied and blocked produce different primary labels"
  else
    fail "policy-denied and blocked labels are mixed up"
  fi
else
  fail "policy-denied and blocked labels are not both present"
fi

# ── Native launch failures surface recovery detail ─────────────────────────

cat > "$WORKTREES_DIR/native-failed-task/features/native-failed-task/.native-launch-failure.json" <<'EOF'
{
  "type": "native-launch-failure",
  "issue": "HOK-2539",
  "stage": "planning",
  "agent": "native-openrouter",
  "model": "qwen-3-coder",
  "paneTarget": "@96",
  "failureKind": "bare-model-command",
  "exitCode": 127,
  "detectedAt": "2026-07-18T13:00:00Z",
  "recommendedAction": "Inspect the pane transcript and route config, then relaunch after fixing native provider/model eligibility."
}
EOF

STATE_FILE_NATIVE_FAILURE="$TMP_DIR/state-native-failure.json"
cat > "$STATE_FILE_NATIVE_FAILURE" <<EOF
{
  "tasks": {
    "HOK-2539": {
      "slug": "native-failed-task",
      "branch": "task/native-failed-task",
      "worktree": "$WORKTREES_DIR/native-failed-task",
      "status": "",
      "phase": "planning",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_NATIVE_FAILURE="$TMP_DIR/behavior-native-failure.json"
cat > "$BEHAVIOR_NATIVE_FAILURE" <<'EOF'
{
  "pane": {
    "HOK-2539-native-failed-task": "96"
  },
  "hook": {},
  "next_action": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_NATIVE_FAILURE="$TMP_DIR/output-native-failure.txt"
run_render_with_agent_states "$STATE_FILE_NATIVE_FAILURE" "$WORKTREES_DIR" "$BEHAVIOR_NATIVE_FAILURE" "$OUTPUT_NATIVE_FAILURE" \
  "" "" ""

if grep -q '📥 INBOX (1)' "$OUTPUT_NATIVE_FAILURE" \
  && grep -q 'HOK-2539.*native-failed-task.*⚠ planning' "$OUTPUT_NATIVE_FAILURE" \
  && grep -q 'Native planning launch failed: bare-model-command exit=127' "$OUTPUT_NATIVE_FAILURE" \
  && grep -q 'model=qwen-3-coder pane=@96' "$OUTPUT_NATIVE_FAILURE" \
  && grep -q 'Inspect the pane transcript and route config' "$OUTPUT_NATIVE_FAILURE"; then
  pass "native launch failure renders actionable recovery detail"
else
  fail "native launch failure detail missing from dashboard"
fi

# ── Baseline states unchanged ───────────────────────────────────────────────

BEHAVIOR_BASELINE="$TMP_DIR/behavior-baseline.json"
cat > "$BEHAVIOR_BASELINE" <<'EOF'
{
  "pane": {
    "HOK-2370-G-active-task": "10"
  },
  "hook": {},
  "next_action": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

STATE_FILE_BASELINE="$TMP_DIR/state-baseline.json"
cat > "$STATE_FILE_BASELINE" <<EOF
{
  "tasks": {
    "HOK-2370-G": {
      "slug": "active-task",
      "branch": "task/active-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "coding",
      "pr": ""
    }
  }
}
EOF

run_render_with_agent_states "$STATE_FILE_BASELINE" "$WORKTREES_DIR" "$BEHAVIOR_BASELINE" "$TMP_DIR/output-baseline-running.txt" \
  "" "" ""

if grep -q '⚡ ACTIVE (1)' "$TMP_DIR/output-baseline-running.txt" \
  && grep -q 'HOK-2370-G.*● running' "$TMP_DIR/output-baseline-running.txt" \
  && ! grep -q '📥 INBOX' "$TMP_DIR/output-baseline-running.txt"; then
  pass "running state baseline unchanged — stays in active, not inbox"
else
  fail "running state baseline regressed"
fi

# ── Stale approval-needed falls back to pane liveness ─────────────────────
# The stale-hook fallback is already validated by the TTL in agent_status().
# We verify the contract via a static check: stale hook state → pane liveness.
# Confirm that is_actionable_state still routes stale-hook states correctly:
# agent_status returns "running" when hook is stale → task stays active.
stale_result_file="$TMP_DIR/stale-classification.txt"
(
  set -- test-session "$WORKTREES_DIR"
  exec 3>"$stale_result_file"
  exec >/dev/null 2>&1
  source "$REPO_DIR/shared/lib/wavemill-status.sh"
  trap - EXIT
  is_actionable_state "running" "coding" "$WORKTREES_DIR/active-task" "active-task" "HOK-9999" >&3
) 2>/dev/null || true
stale_classification="$(cat "$stale_result_file" 2>/dev/null || true)"
if [[ "$stale_classification" == "active" ]]; then
  pass "stale hook fallback (running) stays active — does not freeze in actionable state"
else
  fail "stale hook fallback classification unexpected: '$stale_classification'"
fi

# ── Terminal durable state overrides fresh stale hook semantics ────────────
terminal_override_state="$TMP_DIR/terminal-override-state.json"
cat > "$terminal_override_state" <<JSON
{
  "tasks": {
    "HOK-2599": {
      "slug": "terminal-task",
      "branch": "task/terminal-task",
      "worktree": "$WORKTREES_DIR/terminal-task",
      "pr": "101",
      "status": "closed",
      "phase": "closed"
    }
  }
}
JSON
terminal_override_result="$TMP_DIR/terminal-override-result.txt"
(
  set -- test-session "$WORKTREES_DIR" "$terminal_override_state"
  exec 3>"$terminal_override_result"
  exec >/dev/null 2>&1
  source "$REPO_DIR/shared/lib/wavemill-status.sh"
  trap - EXIT
  pr_for_branch() { printf '101|CLOSED\n'; }
  agent_terminal_override "HOK-2599" >&3
) 2>/dev/null || true
terminal_override="$(cat "$terminal_override_result" 2>/dev/null || true)"
if [[ "$terminal_override" == "exited" ]]; then
  pass "terminal workflow state overrides stale live hook display"
else
  fail "terminal override expected exited, got '$terminal_override'"
fi

# ── Unknown state in hook file falls back gracefully ───────────────────────
# The protocol silently drops unknown states, so an old hook file with an
# unknown state would have a stale timestamp and fall back to pane liveness.
# Validate via the protocol's state allowlist check.
unknown_result_file="$TMP_DIR/unknown-state-result.txt"
(
  export WAVEMILL_SESSION="hok2370-unknown-test-$$"
  export WAVEMILL_ISSUE="HOK-UNKNOWN"
  export WAVEMILL_DASHBOARD_PID=""
  source "$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"
  hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
  rm -f "$hook_file"
  wavemill_hook_write "future-unknown-state" "test" "detail" "test-agent"
  if [[ ! -e "$hook_file" ]]; then
    printf 'no-file\n'
  else
    printf 'wrote-file\n'
    rm -f "$hook_file"
  fi
) > "$unknown_result_file" 2>/dev/null || true
unknown_result="$(cat "$unknown_result_file" 2>/dev/null || true)"
if [[ "$unknown_result" == "no-file" ]]; then
  pass "unknown/future state is a no-op — hook file not written"
else
  fail "unknown state should not write hook file (got: $unknown_result)"
fi

# ── Backstage health renders Tend and Observer independently ───────────────
backstage_state="$TMP_DIR/backstage-state.json"
backstage_behavior="$TMP_DIR/backstage-behavior.json"
backstage_output="$TMP_DIR/backstage-output.txt"
cat > "$backstage_state" <<'JSON'
{"tasks":{}}
JSON
cat > "$backstage_behavior" <<'JSON'
{"pane":{}}
JSON
cat > "$TMP_DIR/backstage-health.json" <<JSON
{
  "status": "healthy",
  "services": {
    "tend": {
      "status": "healthy",
      "heartbeatAt": "$(iso_at_offset -10)"
    },
    "observer": {
      "status": "needs-user",
      "heartbeatAt": "$(iso_at_offset -20)"
    }
  }
}
JSON
run_render "$backstage_state" "$WORKTREES_DIR" "$backstage_behavior" "$backstage_output"
backstage_render="$(cat "$backstage_output")"
if [[ "$backstage_render" == *"Tend: healthy"* && "$backstage_render" == *"Tend: healthy ("* && "$backstage_render" == *"Observer: needs-user"* ]]; then
  pass "backstage health renders tend and observer separately"
else
  fail "backstage health did not render independent tend/observer status"
fi

cat > "$TMP_DIR/backstage-health.json" <<JSON
{
  "status": "healthy",
  "services": {
    "tend": {
      "status": "healthy",
      "heartbeatAt": "$(iso_at_offset -10)"
    },
    "observer": {
      "status": "healthy",
      "heartbeatAt": "$(iso_at_offset -20)",
      "instanceCount": 3
    }
  }
}
JSON
run_render "$backstage_state" "$WORKTREES_DIR" "$backstage_behavior" "$backstage_output"
backstage_multi_observer_render="$(cat "$backstage_output")"
if [[ "$backstage_multi_observer_render" == *"Observer: healthy x3"* ]]; then
  pass "backstage health renders duplicate observer instance count"
else
  fail "backstage health did not render observer instance count"
fi

cat > "$TMP_DIR/backstage-health.json" <<JSON
{
  "status": "healthy",
  "services": {
    "tend": {
      "status": "healthy",
      "heartbeatAt": "$(iso_at_offset -10)",
      "failureCount": 2
    }
  }
}
JSON
run_render "$backstage_state" "$WORKTREES_DIR" "$backstage_behavior" "$backstage_output"
backstage_disabled_render="$(cat "$backstage_output")"
if [[ "$backstage_disabled_render" == *"Tend: healthy"* && "$backstage_disabled_render" == *"retrying:2"* && "$backstage_disabled_render" == *"Observer: disabled"* ]]; then
  pass "backstage health renders disabled observer and tend retry count"
else
  fail "backstage health did not render disabled observer status and retry count"
fi

cat > "$TMP_DIR/queue-health.json" <<'JSON'
{
  "status": "degraded",
  "degradationReason": "external_cancellation",
  "failureStep": "plan_queue_failed",
  "retryBackoffSeconds": 60,
  "nextAction": "retry"
}
JSON
run_render "$backstage_state" "$WORKTREES_DIR" "$backstage_behavior" "$backstage_output"
queue_backstage_render="$(cat "$backstage_output")"
if [[ "$queue_backstage_render" == *"Queue: degraded"* && "$queue_backstage_render" == *"external_cancellation"* ]]; then
  pass "backstage health summary renders degraded queue health"
else
  fail "backstage health summary did not render degraded queue health"
fi

# ── Malformed challenge-pair state stubs (HOK-2926) ──────────────────────
# A primary whose ledger write was rejected ends up as a bare object with
# challenge metadata but no slug. gather_tasks filters it out, so without an
# explicit warning the arm is invisible while its agent keeps running.
# These fixtures live in their own directory so the backstage/queue health
# files written above do not add unrelated warning rows.

echo ""
echo "=== Malformed challenge-pair state warning (HOK-2926) ==="

MALFORMED_DIR="$TMP_DIR/malformed-challenge"
mkdir -p "$MALFORMED_DIR" \
  "$WORKTREES_DIR/malformed-pair-challenger/features/malformed-pair-challenger" \
  "$WORKTREES_DIR/healthy-solo-task/features/healthy-solo-task"

MALFORMED_STATE="$MALFORMED_DIR/state.json"
MALFORMED_BEHAVIOR="$MALFORMED_DIR/behavior.json"
MALFORMED_OUTPUT="$MALFORMED_DIR/output.txt"
cat > "$MALFORMED_BEHAVIOR" <<'EOF'
{
  "pane": {
    "HOK-2918_c-malformed-pair-challenger": "5",
    "HOK-2919-healthy-solo-task": "6"
  }
}
EOF

# One stub: the exact shape observed on HOK-2918 — challenge metadata only.
cat > "$MALFORMED_STATE" <<EOF
{
  "tasks": {
    "HOK-2918": {
      "phase": "planning",
      "windowId": "@69",
      "challengerLaunched": true,
      "challengePairId": "HOK-2918",
      "challengeStage": "implementation",
      "challengeExecutionIntent": { "pairId": "HOK-2918", "decisionSource": "bootstrap" }
    },
    "HOK-2918_c": {
      "slug": "malformed-pair-challenger",
      "branch": "task/malformed-pair-challenger",
      "worktree": "$WORKTREES_DIR/malformed-pair-challenger",
      "status": "active",
      "phase": "coding",
      "pr": "",
      "challenge": true,
      "challengePairId": "HOK-2918",
      "challengeRole": "challenger"
    },
    "HOK-2919": {
      "slug": "healthy-solo-task",
      "branch": "task/healthy-solo-task",
      "worktree": "$WORKTREES_DIR/healthy-solo-task",
      "status": "active",
      "phase": "coding",
      "pr": ""
    },
    "HOK-2920": {
      "phase": "planning"
    }
  }
}
EOF

run_render "$MALFORMED_STATE" "$WORKTREES_DIR" "$MALFORMED_BEHAVIOR" "$MALFORMED_OUTPUT"
malformed_render="$(cat "$MALFORMED_OUTPUT")"

if [[ "$malformed_render" == *"WARN: challenge pair entry HOK-2918 has no slug"* ]]; then
  pass "slug-less challenge pair entry surfaces as a dashboard warning"
else
  echo "    render: $malformed_render"
  fail "slug-less challenge pair entry did not surface as a dashboard warning"
fi

if [[ "$malformed_render" == *"HOK-2926"* ]]; then
  pass "malformed challenge warning cites the repair issue"
else
  fail "malformed challenge warning does not cite the repair issue"
fi

if [[ "$malformed_render" == *"HOK-2918_c"* && "$malformed_render" == *"HOK-2919"* ]]; then
  pass "valid challenger and solo task rows still render beside the warning"
else
  echo "    render: $malformed_render"
  fail "valid task rows were lost when a malformed challenge entry was present"
fi

if [[ "$malformed_render" != *"HOK-2920"* ]]; then
  pass "slug-less non-challenge entry stays silently filtered (no warning, no row)"
else
  echo "    render: $malformed_render"
  fail "slug-less non-challenge entry leaked into the dashboard"
fi

# The warning must be a header row, not a task row: the stub has no worktree
# to act on, so it must never be classified as an inbox/active task.
malformed_warning_line_count="$(grep -c 'WARN: challenge pair entry' "$MALFORMED_OUTPUT" || true)"
malformed_task_row_count="$(grep -cE '^[^├]*HOK-2918[^_]' "$MALFORMED_OUTPUT" || true)"
if [[ "$malformed_warning_line_count" == "1" && "$malformed_task_row_count" == "0" ]]; then
  pass "malformed challenge entry renders exactly one warning row and no task row"
else
  echo "    warning rows: $malformed_warning_line_count, task rows: $malformed_task_row_count"
  echo "    render: $malformed_render"
  fail "malformed challenge entry rendered as a task row or duplicated its warning"
fi

# Several stubs are reported together on one row.
jq '.tasks["HOK-2921"] = {phase: "planning", challengePairId: "HOK-2921", challengerLaunched: true}' \
  "$MALFORMED_STATE" > "$MALFORMED_DIR/state.multi.json"
run_render "$MALFORMED_DIR/state.multi.json" "$WORKTREES_DIR" "$MALFORMED_BEHAVIOR" "$MALFORMED_OUTPUT"
malformed_multi_render="$(cat "$MALFORMED_OUTPUT")"
if [[ "$malformed_multi_render" == *"WARN: 2 challenge pair entries have no slug (HOK-2918, HOK-2921)"* ]]; then
  pass "multiple slug-less challenge pair entries are reported together"
else
  echo "    render: $malformed_multi_render"
  fail "multiple slug-less challenge pair entries were not reported together"
fi

# Healthy state: no warning row at all.
jq 'del(.tasks["HOK-2918"]) | del(.tasks["HOK-2920"])' "$MALFORMED_STATE" > "$MALFORMED_DIR/state.healthy.json"
run_render "$MALFORMED_DIR/state.healthy.json" "$WORKTREES_DIR" "$MALFORMED_BEHAVIOR" "$MALFORMED_OUTPUT"
malformed_healthy_render="$(cat "$MALFORMED_OUTPUT")"
if [[ "$malformed_healthy_render" != *"challenge pair entr"* ]]; then
  pass "healthy challenge pair state renders no malformed-entry warning"
else
  echo "    render: $malformed_healthy_render"
  fail "healthy challenge pair state produced a spurious malformed-entry warning"
fi

# Direct helper contract: unreadable/missing state and non-object task values
# fail closed (return 1, print nothing) instead of erroring the render loop.
malformed_helper_probe="$(
  set -- test-session "$WORKTREES_DIR" "$MALFORMED_STATE"
  source "$REPO_DIR/shared/lib/wavemill-status.sh" >/dev/null 2>&1
  printf '%s\n' '{"tasks":{"HOK-1":"not-an-object","HOK-2":null,"HOK-3":{"challengePairId":"HOK-3"}}}' > "$MALFORMED_DIR/state.odd.json"
  if out="$(malformed_challenge_state_warning "$MALFORMED_DIR/state.odd.json")"; then
    echo "odd:0:$out"
  else
    echo "odd:1:$out"
  fi
  if out="$(malformed_challenge_state_warning "$MALFORMED_DIR/does-not-exist.json")"; then
    echo "missing:0:$out"
  else
    echo "missing:1:$out"
  fi
  if out="$(malformed_challenge_state_warning "")"; then
    echo "empty:0:$out"
  else
    echo "empty:1:$out"
  fi
)"
if [[ "$malformed_helper_probe" == *"odd:0:challenge pair entry HOK-3 has no slug"* \
  && "$malformed_helper_probe" == *"missing:1:"* \
  && "$malformed_helper_probe" == *"empty:1:"* ]]; then
  pass "malformed challenge helper tolerates non-object task values and fails closed on missing state"
else
  echo "    probe: $malformed_helper_probe"
  fail "malformed challenge helper contract violated"
fi

# --- Backstage progress-vs-liveness rendering (HOK-2919) ---
# A current heartbeat with a stalled progress state must render as alive but
# not progressing, showing both the tick age and the last-progress age; a
# health file without progress fields renders unchanged (backwards compatible).
BACKSTAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR" "$BACKSTAGE_DIR"' EXIT
BACKSTAGE_STATE_FILE="$BACKSTAGE_DIR/workflow-state.json"
printf '{"tasks":{}}\n' > "$BACKSTAGE_STATE_FILE"
recent_tick="$(iso_at_offset -48)"
old_progress="$(iso_at_offset -57600)"
cat > "$BACKSTAGE_DIR/backstage-health.json" <<JSON
{
  "status": "healthy",
  "services": {
    "tend": {
      "status": "healthy",
      "heartbeatAt": "$recent_tick",
      "progressState": "stalled",
      "lastProgressAt": "$old_progress",
      "failureCount": 0
    },
    "observer": {
      "status": "healthy",
      "heartbeatAt": "$recent_tick"
    }
  }
}
JSON

backstage_probe="$(
  set -- test-session "$WORKTREES_DIR" "$BACKSTAGE_STATE_FILE"
  source "$REPO_DIR/shared/lib/wavemill-status.sh" >/dev/null 2>&1
  backstage_health_dashboard_line "$BACKSTAGE_STATE_FILE" 2>/dev/null || echo "RENDER_FAILED"
)"
backstage_probe_plain="$(printf '%s' "$backstage_probe" | strip_ansi)"
if [[ "$backstage_probe_plain" == *"Tend: alive-not-progressing"* \
  && "$backstage_probe_plain" == *"tick "* \
  && "$backstage_probe_plain" == *"progress "* ]]; then
  pass "stalled tend renders as alive-not-progressing with tick and progress ages"
else
  echo "    probe: $backstage_probe_plain"
  fail "stalled tend did not render tick-vs-progress distinction"
fi
if [[ "$backstage_probe_plain" == *"Observer: healthy"* ]]; then
  pass "service without progress fields still renders its plain status"
else
  echo "    probe: $backstage_probe_plain"
  fail "observer without progress fields lost its plain rendering"
fi

# Same file with tend progressing: header must say healthy, no progress suffix.
cat > "$BACKSTAGE_DIR/backstage-health.json" <<JSON
{
  "status": "healthy",
  "services": {
    "tend": {
      "status": "healthy",
      "heartbeatAt": "$recent_tick",
      "progressState": "progressing",
      "lastProgressAt": "$recent_tick",
      "failureCount": 0
    }
  }
}
JSON
backstage_probe_plain="$(
  set -- test-session "$WORKTREES_DIR" "$BACKSTAGE_STATE_FILE"
  source "$REPO_DIR/shared/lib/wavemill-status.sh" >/dev/null 2>&1
  backstage_health_dashboard_line "$BACKSTAGE_STATE_FILE" 2>/dev/null | strip_ansi || echo "RENDER_FAILED"
)"
if [[ "$backstage_probe_plain" == *"Tend: healthy"* && "$backstage_probe_plain" != *"alive-not-progressing"* \
  && "$backstage_probe_plain" != *"progress "* ]]; then
  pass "progressing tend renders as healthy without a progress suffix"
else
  echo "    probe: $backstage_probe_plain"
  fail "progressing tend rendering regressed"
fi

# --- Pending deferred challenger arm annotation (HOK-2813) ---
# A primary carrying an awaiting_fork challengeArms[] entry renders an
# "awaiting fork" detail line from state alone — no pane lookup, and the arm
# never appears as a task row. Cancelled/materialized arms render nothing.
PENDING_ARM_DIR="$(mktemp -d)"
pending_arm_probe="$(
  set -- test-session "$WORKTREES_DIR" "$PENDING_ARM_DIR/state.json"
  source "$REPO_DIR/shared/lib/wavemill-status.sh" >/dev/null 2>&1
  printf '%s\n' '{"tasks":{"HOK-2813":{"slug":"deferred-primary","challenge":true,"challengeRole":"primary","challengePairId":"HOK-2813","challengeArms":[{"key":"HOK-2813_c","slug":"deferred-primary-challenger","role":"challenger","variedStage":"review","challengeArmState":"awaiting_fork"}]}}}' > "$PENDING_ARM_DIR/state.json"
  STATE_FILE="$PENDING_ARM_DIR/state.json"
  echo "pending:$(render_pending_challenge_arms "HOK-2813")"
  printf '%s\n' '{"tasks":{"HOK-2813":{"slug":"deferred-primary","challengeArms":[{"key":"HOK-2813_c","challengeArmState":"cancelled","cancelReason":"pre_fork_primary_failure"}]}}}' > "$PENDING_ARM_DIR/state.json"
  echo "cancelled:$(render_pending_challenge_arms "HOK-2813")"
  echo "absent:$(render_pending_challenge_arms "HOK-9999")"
)"
if [[ "$pending_arm_probe" == *"pending:⏳ challenger HOK-2813_c awaiting fork · review stage · challenger"* \
  && "$pending_arm_probe" == *$'cancelled:\n'* \
  && "$pending_arm_probe" == *"absent:"* ]]; then
  pass "pending deferred arm renders an awaiting-fork annotation from state only"
else
  echo "    probe: $pending_arm_probe"
  fail "pending deferred arm annotation contract violated"
fi
rm -rf "$PENDING_ARM_DIR"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
