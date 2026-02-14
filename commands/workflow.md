Orchestrates the complete feature workflow: Task Selection → Plan Creation → Implementation → Validation → PR

This command provides a continuous flow while clearing context between major phases.

---

## Phase 1: Task Selection & Context Setup

### 1A. Select Task from Linear
Use the **linear-task-selector** skill to:
- Fetch tasks from Linear backlog (check CLAUDE.md for project name)
- Display numbered task list to user
- Create feature directory: `features/<feature-name>/`
- Save selected task context to `features/<feature-name>/selected-task.json`

The skill handles directory creation and context saving together, preventing conflicts when multiple Claude sessions run concurrently.

**Context Handoff**: Task details saved to `features/<feature-name>/selected-task.json`

---

## Phase 2: Plan Creation
**Goal**: Research codebase and create detailed implementation plan

### 2A. Inform User
```
📋 Starting plan creation phase...
I'll research the codebase and create an implementation plan.
This may take a few minutes.
```

### 2B. Execute Plan Creation
Follow the `/create-plan` workflow:
1. Read task context from `features/<feature-name>/selected-task.json`
2. Use **research-orchestrator** agent for parallel research
3. Generate structured plan with phases
4. Save to `features/<feature-name>/plan.md`

### 2C. Present Plan & Get Approval
```
✅ Plan created: features/<feature-name>/plan.md

[Show plan summary]

Ready to proceed with implementation? (yes/no)
```

**Wait for user approval before proceeding**

**Context Handoff**: Plan saved to `features/<feature-name>/plan.md`

### 2D. Clear Context
After user approves, inform them:
```
✓ Plan approved. Clearing context for implementation phase.

Next: I'll execute the plan with validation gates.
```

---

## Phase 3: Phased Implementation
**Goal**: Execute plan with human checkpoints between phases

### 3A. Inform User
```
🔨 Starting implementation phase...
I'll execute the plan phase-by-phase with checkpoints.
```

### 3B. Execute Implementation
Follow the `/implement-plan` workflow:
1. Read plan from `features/<feature-name>/plan.md`
2. Create todo list from plan phases
3. For each phase:
   - Implement changes
   - Run automated tests
   - **STOP and present results**
   - Get user verification
   - Proceed to next phase

### 3C. Track Progress
Update todos as phases complete:
- [x] Phase 1: Setup
- [ ] Phase 2: Core implementation
- [ ] Phase 3: Error handling
- [ ] Phase 4: Tests

**Context Focus**: Only load current phase requirements, not entire conversation history

**Context Handoff**: Implementation committed to git

### 3D. Clear Context
After all phases complete:
```
✓ All phases implemented. Clearing context for validation.

Next: I'll validate the implementation against the plan.
```

---

## Phase 4: Validation
**Goal**: Verify implementation before creating PR

### 4A. Inform User
```
✅ Starting validation phase...
I'll verify the implementation meets all success criteria.
```

### 4B. Execute Validation
Follow the `/validate-plan` workflow:
1. Read plan from `features/<feature-name>/plan.md`
2. Run all automated checks
3. Spawn research agents to verify implementation
4. Generate validation report
5. Save to `features/<feature-name>/validation-report.md`

### 4C. Present Validation Results
```
📊 Validation complete: features/<feature-name>/validation-report.md

[Show summary of results]

Issues found: [X]
Ready for PR? (yes/fix-issues)
```

**Wait for user decision**

**Context Handoff**: Validation report saved

### 4D. Handle Issues
If issues found:
- Return to Phase 3 implementation for fixes
- Re-validate after fixes
- Loop until validation passes

---

## Phase 5: PR Creation
**Goal**: Create PR with comprehensive description

### 5A. Inform User
```
🚀 Creating pull request...
```

### 5B. Create PR
Use the **git-workflow-manager** skill to:
1. Ensure feature branch exists: `feature/<sanitized-title>`
2. Commit any final changes with structured message
3. Push branch to remote
4. Create PR with:
   - Summary from plan
   - Phases completed
   - Validation results
   - Testing checklist

### 5C. Present PR
```
✅ Pull Request Created!

URL: [PR link]

Ready for Review Checklist:
- [x] All plan phases completed
- [x] Tests pass (see validation report)
- [x] Validation checks passed
- [ ] Code review requested
- [ ] Manual QA completed

Next Steps:
1. Request code review
2. Complete manual QA
3. Address review feedback
```

---

## Phase 6: Post-Completion Eval
**Goal**: Automatically evaluate workflow quality using the LLM judge

### 6A. Trigger Eval Hook
After PR creation, run the post-completion eval hook. This is automatic and non-blocking — if eval fails, the workflow is still complete.

```bash
npx tsx tools/run-eval-hook.ts --issue <ISSUE_ID> --pr <PR_NUMBER> --pr-url <PR_URL> --workflow-type workflow
```

Replace `<ISSUE_ID>`, `<PR_NUMBER>`, and `<PR_URL>` with the actual values from the workflow.

### 6B. Report Eval Result
If eval succeeds, report the score:
```
📊 Workflow Eval: <score_band> (<score>) — saved to eval store
```

If eval fails or is skipped (autoEval disabled), note it briefly and continue — the workflow is complete either way.

---

## Context Management Strategy

### Between Phases:
1. **Save state** to files (plan, validation report, etc.)
2. **Clear conversation context** (inform user)
3. **Load only needed context** for next phase
4. **Focus on current phase** goals only

### What Gets Saved:
- Task details → `features/<feature-name>/selected-task.json`
- Plan → `features/<feature-name>/plan.md`
- Validation → `features/<feature-name>/validation-report.md`
- Code → Git commits

### Context Cleared:
- Previous phase conversation history
- Intermediate research findings
- Exploratory code reads

### Benefits:
- ✅ Stays focused on current phase
- ✅ Reduces token usage
- ✅ Faster responses
- ✅ Clear mental model for user

---

## Error Handling

### If Plan Creation Fails:
- Save partial research findings
- Ask user if they want to continue manually or retry

### If Implementation Blocks:
- Stop at current phase
- Document blocker in validation report
- Ask user for guidance

### If Validation Fails:
- Present issues clearly
- Return to implementation phase
- Fix and re-validate

---

## Usage Tips

- Run `/workflow` to start the full cycle
- You'll be prompted at key decision points
- Each phase saves progress to disk
- Safe to interrupt and resume between phases
