Execute the bug investigation workflow using agent skills:

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

## Phase 6: Post-Completion Eval
After PR creation, run the post-completion eval hook. This is automatic and non-blocking — if eval fails, the workflow is still complete.

```bash
npx tsx tools/run-eval-hook.ts --issue <ISSUE_ID> --pr <PR_NUMBER> --pr-url <PR_URL> --workflow-type bugfix
```

Replace `<ISSUE_ID>`, `<PR_NUMBER>`, and `<PR_URL>` with the actual values from the bugfix workflow. If eval succeeds, report the score briefly. If it fails or is skipped, note it and continue.

Guide the user through the entire systematic process until the bug is fixed and PR is ready.