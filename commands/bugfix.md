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
  --model "<current model, e.g. claude-opus-4-6>" \
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

## Phase 5: Git & PR
Use the **git-workflow-manager** skill to:
- Create bugfix branch: `bugfix/<sanitized-title>`
- Commit with structured message (fix: prefix, root cause, solution)
- Push branch to remote
- Create PR with root cause, solution, and validation steps
- Provide ready-for-review checklist

After PR is created, finalize the session using the Session Tracking instructions above.

## Phase 6: Post-Completion Eval
After PR creation, run the post-completion eval hook. This is automatic and non-blocking — if eval fails, the workflow is still complete.

```bash
npx tsx tools/run-eval-hook.ts --issue <ISSUE_ID> --pr <PR_NUMBER> --pr-url <PR_URL> --workflow-type bugfix
```

Replace `<ISSUE_ID>`, `<PR_NUMBER>`, and `<PR_URL>` with the actual values from the bugfix workflow. If eval succeeds, report the score briefly. If it fails or is skipped, note it and continue.

Guide the user through the entire systematic process until the bug is fixed and PR is ready.