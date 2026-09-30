Execute the bug investigation workflow using agent skills:

---

## Session Tracking

This workflow automatically captures execution metadata for eval. Session management is **non-intrusive** — if any session command fails, continue the workflow normally.

### At Workflow Start (after bug selection)
After the bug is selected and context is saved, start a session:
```bash
SESSION_ID=$(npx tsx tools/session.ts start \
  --workflow bugfix \
  --prompt "<bug title and description from selected-task.json>" \
  --model "<current model, e.g. claude-opus-4-7>" \
  --issue "<Linear issue ID, e.g. HOK-701>")
```
Save the printed `SESSION_ID` value — you'll need it for updates.

Record the start time:
```bash
SESSION_START_MS=$(date +%s%3N)
```

### Before/After User Prompts
Track user wait time as described in the workflow command's Session Tracking section:
- Before prompt: `PAUSE_START=$(date +%s%3N)`
- After response: `USER_WAIT_MS=$((${USER_WAIT_MS:-0} + $(date +%s%3N) - PAUSE_START))`

### On PR Creation
```bash
npx tsx tools/session.ts update "$SESSION_ID" --pr "<PR URL>"
```

### On Workflow Completion
```bash
SESSION_END_MS=$(date +%s%3N)
EXEC_TIME_MS=$((SESSION_END_MS - SESSION_START_MS - ${USER_WAIT_MS:-0}))
npx tsx tools/session.ts complete "$SESSION_ID" \
  --status completed \
  --execution-time "$EXEC_TIME_MS" \
  --user-wait-time "${USER_WAIT_MS:-0}" \
  --pr "<PR URL>"
```

### On Workflow Failure
```bash
npx tsx tools/session.ts complete "$SESSION_ID" --status failed --error "<error description>"
```

---

## Phase 1: Bug Selection
Use the **linear-task-selector** skill to:
- Fetch bugs from Linear backlog (check CLAUDE.md for project name)
- Display numbered bug list to user
- Create bug directory: `bugs/<bug-name>/`
- Save selected bug context to `bugs/<bug-name>/selected-task.json`

## Phase 2: Investigation Documentation
Use the **document-orchestrator** skill to:
- Use existing `bugs/<bug-name>/` directory
- Generate `investigation.md` with systematic investigation plan
- Generate `hypotheses.md` with 3-5 initial root cause hypotheses
- Generate `fix-tasks.md` template

## Phase 3: Systematic Testing
- Test each hypothesis in priority order (high likelihood first)
- Document test methods and results in `bugs/<bug-name>/test-results.md`
- Mark hypotheses as confirmed/rejected
- Generate additional hypotheses if all rejected
- Stop when root cause is confirmed

## Phase 4: Root Cause & Fix
- Document confirmed root cause in `bugs/<bug-name>/root-cause.md`
- Update fix-tasks.md with specific fix implementation
- Write failing tests that demonstrate the bug
- Implement fix to make tests pass
- Validate fix against original bug report

## Phase 5: Self-Review
After implementation is complete and tests/lint pass, you MUST run the self-review tool.
This is a REQUIRED step — do not skip it or substitute your own review.

1. Run the self-review tool (up to 3 iterations):
   IMPORTANT: Run from your current directory (the worktree). Do NOT change directories.
   IMPORTANT: This tool calls the Claude API and takes 2-5 minutes. Configure your tool's built-in timeout (for Claude Code's Bash tool: `timeout: 600000` — 600000 ms = 10 minutes) so the call is not killed at the default cap. Do NOT prefix the command with the external `timeout` binary — it is not installed by default on macOS and will fail with `command not found: timeout`.
   `npx tsx tools/review-changes.ts main --json`
   - Exit code 0 = review passed → proceed to step 3
   - Exit code 1 = issues found → fix blockers and re-run (step 2)
   - Exit code 2 = error → log comprehensive diagnostics, record the final verdict as `error`, and proceed to step 3 without readiness certification
   The output is structured JSON with `verdict`, `codeReviewFindings`, and `uiFindings`.

   When exit code 2 occurs, you MUST log the following diagnostics to help debug the failure:
   ```
   ⚠️  Review tool failed with exit code 2

   Diagnostics:
   - Command: npx tsx tools/review-changes.ts main --json
   - Working directory: $(pwd)
   - Tool path: tools/review-changes.ts
   - Tool exists: $(ls -lh tools/review-changes.ts 2>&1 || echo "NOT FOUND")
   - Git root: $(git rev-parse --show-toplevel 2>&1)
   - Current branch: $(git rev-parse --abbrev-ref HEAD 2>&1)
   - Base branch exists: $(git rev-parse --verify main 2>&1 || echo "NOT FOUND")
   - STDERR output: [paste the actual stderr from the failed command]

   Proceeding to PR creation. The mill (Ready → Tend) will run its own Ready gate and, if it publishes a handoff, apply `wm:ready` on your behalf. Do NOT add any `wm:*` label yourself.
   ```
   This diagnostic information is CRITICAL for debugging recurring tool failures.

2. For each iteration where issues are found:
   - Read the review JSON output carefully
   - Fix all blockers (severity: blocker) and straightforward warnings
   - Make targeted fixes only — do not refactor unrelated code
   - Run the review scope guard immediately before committing:
     `npx tsx tools/check-review-scope.ts --repo-dir .`
   - If the guard exits 1, preserve the index, report the violation, and stop review-fix committing/PR progression. No review commit may be created until the guard passes.
   - If the guard exits 2, scope could not be verified (tool/git failure — infrastructure, not a violation): capture the guard's stderr, note "review scope unverified (infrastructure)" in the commit message body and PR body, and proceed with the commit. Do not treat exit 2 as a scope violation.
   - If the guard exits 3, scope passed but no PR exists yet for this branch (the normal pre-PR state, not a violation): proceed exactly as for exit 0.
   - Commit fixes: `git commit -m "fix: Address self-review findings (iteration N)"`
   - Re-run the review tool (step 1)

## Phase 6: Git & PR
Use the **git-workflow-manager** skill to:
- Create bugfix branch: `bugfix/<sanitized-title>`
- Commit with structured message (fix: prefix, root cause, solution)
- Push branch to remote
- Create PR with root cause, solution, validation steps, and self-review outcome
- Provide ready-for-review checklist

After PR is created, finalize the session using the Session Tracking instructions above.

## Phase 7: Post-Completion Eval
After PR creation, run the post-completion eval hook. This is automatic and non-blocking — if eval fails, the workflow is still complete.

```bash
npx tsx tools/run-eval-hook.ts --issue <ISSUE_ID> --pr <PR_NUMBER> --pr-url <PR_URL> --workflow-type bugfix
```

Replace `<ISSUE_ID>`, `<PR_NUMBER>`, and `<PR_URL>` with the actual values from the bugfix workflow. If eval succeeds, report the score briefly. If it fails or is skipped, note it and continue.

Guide the user through the entire systematic process until the bug is fixed and PR is ready.
