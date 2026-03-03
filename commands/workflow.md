Orchestrates the complete feature workflow: Task Selection → Plan Creation → Implementation → Self-Review → Validation → PR

This command provides a continuous flow while clearing context between major phases. After implementation, changes are automatically reviewed and fixed iteratively before final validation.

Self-review is enabled by default and can be configured in `.wavemill-config.json` (review.enabled and review.maxIterations).

---

## Session Tracking

This workflow automatically captures execution metadata for eval. Session management is **non-intrusive** — if any session command fails, continue the workflow normally.

### At Workflow Start (after task selection)
After the task is selected and context is saved, start a session:
```bash
SESSION_ID=$(npx tsx tools/session.ts start \
  --workflow feature \
  --prompt "<task title and description from selected-task.json>" \
  --model "<current model, e.g. claude-opus-4-6>" \
  --issue "<Linear issue ID, e.g. HOK-701>")
```
Save the printed `SESSION_ID` value — you'll need it for updates.

Record the current time as `SESSION_START_TIME` using:
```bash
SESSION_START_MS=$(date +%s%3N)
```

### Before Each User Prompt
Record the pause start time:
```bash
PAUSE_START=$(date +%s%3N)
```

### After Each User Response
Calculate and accumulate user wait time:
```bash
PAUSE_END=$(date +%s%3N)
USER_WAIT_MS=$((${USER_WAIT_MS:-0} + PAUSE_END - PAUSE_START))
```

### On PR Creation
Update the session with the PR URL:
```bash
npx tsx tools/session.ts update "$SESSION_ID" --pr "<PR URL>"
```

### On Workflow Completion
Finalize the session:
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

## Phase 1: Task Selection & Context Setup

### 1A. Select Task from Linear
Use the **linear-task-selector** skill to:
- Fetch tasks from Linear backlog (check CLAUDE.md for project name)
- Display numbered task list to user
- Create feature directory: `features/<feature-name>/`
- Save selected task context to `features/<feature-name>/selected-task.json`

The skill handles directory creation and context saving together, preventing conflicts when multiple Claude sessions run concurrently.

**Context Handoff**: Task details saved to `features/<feature-name>/selected-task.json`

### 1B. Start Session Tracking
After task selection is complete, start a session using the instructions in the **Session Tracking** section above. Use the task title, description, and issue ID from `selected-task.json`.

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
✓ All phases implemented. Clearing context for self-review.

Next: I'll review the implementation to catch any issues.
```

---

## Phase 4: Self-Review Loop
**Goal**: Automatically review and fix code changes before validation

### 4A. Inform User
```
🔍 Starting self-review phase...
I'll review the implementation and fix any major issues automatically.
```

### 4B. Load Configuration and Validate Prerequisites
Read the review configuration from `.wavemill-config.json`:
```bash
# Load review settings (fallback to defaults if not configured)
REVIEW_ENABLED=$(cat .wavemill-config.json 2>/dev/null | jq -r '.review.enabled // true')
MAX_ITERATIONS=$(cat .wavemill-config.json 2>/dev/null | jq -r '.review.maxIterations // 3')

# Skip self-review if disabled
if [ "$REVIEW_ENABLED" != "true" ]; then
  echo "ℹ️  Self-review disabled in config - skipping to validation"
  # Proceed directly to Phase 5 (Validation)
  exit 0
fi

# Verify review tool exists
if [ ! -f "tools/review-changes.ts" ]; then
  echo "⚠️  Self-review tool not found at tools/review-changes.ts"
  echo "Skipping self-review and proceeding to validation"
  # Proceed directly to Phase 5 (Validation)
  exit 0
fi

# Validate maxIterations is a positive integer
if ! [[ "$MAX_ITERATIONS" =~ ^[1-9][0-9]*$ ]]; then
  echo "⚠️  Invalid maxIterations value: $MAX_ITERATIONS (using default: 3)"
  MAX_ITERATIONS=3
fi
```

### 4C. Execute Review Loop
Initialize loop variables:
```bash
ITERATION=1
REVIEW_PASSED=false
```

**For each iteration (up to MAX_ITERATIONS):**

#### 1. Run Self-Review Tool

**IMPORTANT**: Run this command in the **foreground** (do NOT use `run_in_background`).
The Bash tool must capture stdout directly so you can read the review results.
Use a timeout of 300000ms on the Bash tool call.

```bash
npx tsx tools/review-changes.ts main --json | tee features/<feature-name>/review-iteration-$ITERATION.json
REVIEW_EXIT_CODE=${PIPESTATUS[0]}

# Handle timeout (exit code 124)
if [ $REVIEW_EXIT_CODE -eq 124 ]; then
  echo "⚠️  Self-review timed out after 5 minutes (iteration $ITERATION)"
  echo "Treating as error - proceeding to validation"
  REVIEW_EXIT_CODE=2
fi
```

If the Bash tool output is empty or truncated, read the JSON file as a fallback:
```bash
cat features/<feature-name>/review-iteration-$ITERATION.json
```

#### 2. Check Review Result
**Exit code meanings**:
- `0` = Review passed (verdict: ready)
- `1` = Review failed (verdict: not_ready)
- `2` = Error occurred

**If exit code = 0 (passed)**:
```bash
REVIEW_PASSED=true
echo "✅ Self-review passed! No blockers found."
break  # Exit loop
```

**If exit code = 2 (error)**:
```bash
echo "⚠️ Self-review tool encountered an error (iteration $ITERATION)"
echo "Review log saved to: features/<feature-name>/review-iteration-$ITERATION.json"
# Continue to validation phase (treat as passed to avoid blocking)
REVIEW_PASSED=true
break
```

**If exit code = 1 (not_ready)**:
Parse and present findings to the agent.

#### 3. Parse Findings (when not_ready)
The review JSON is already visible from the foreground Bash result above.
If it was truncated, read the full file:
```bash
cat features/<feature-name>/review-iteration-$ITERATION.json
```

The JSON contains:
- `verdict`: `"ready"` or `"not_ready"`
- `codeReviewFindings`: array of findings, each with `severity`, `location`, `category`, `description`
- `uiFindings`: optional array with same structure
- `metadata`: branch info, files changed

Focus on findings where `severity` is `"blocker"` — these must be fixed. Address `"warning"` items if straightforward.

#### 4. Fix Issues
**Agent instructions**:
- Read the review findings carefully
- Address each blocker (severity: blocker)
- Fix warnings if straightforward
- Make targeted fixes - avoid refactoring unrelated code
- Commit fixes with descriptive message:
  ```bash
  git add -A
  git commit -m "fix: Address self-review findings (iteration $ITERATION)

  - [List key fixes made]

  Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
  ```

#### 5. Check Iteration Limit
```bash
ITERATION=$((ITERATION + 1))
if [ $ITERATION -gt $MAX_ITERATIONS ]; then
  echo "⚠️ Reached maximum iterations ($MAX_ITERATIONS)"
  break
fi
```

### 4D. Handle Loop Exit

**If review passed (REVIEW_PASSED=true)**:
```
✅ Self-review complete! Implementation is ready for validation.

Self-review summary:
- Iterations: $ITERATION
- Final verdict: READY
- Review logs: features/<feature-name>/review-iteration-*.log
```

**If max iterations reached without passing**:
```
⚠️ Self-review did not pass after $MAX_ITERATIONS iterations.

Remaining issues found:
[Show latest findings from review log]

These issues will be surfaced in the validation phase.
Proceeding to validation to document all findings...
```

### 4E. Context Handoff
All review logs saved to:
- `features/<feature-name>/review-iteration-1.log`
- `features/<feature-name>/review-iteration-2.log`
- `features/<feature-name>/review-iteration-N.log`

### 4F. Clear Context
```
✓ Self-review phase complete. Clearing context for validation phase.

Next: I'll run comprehensive validation against the plan.
```

---

## Phase 5: Validation
**Goal**: Verify implementation before creating PR

### 5A. Inform User
```
✅ Starting validation phase...
I'll verify the implementation meets all success criteria.
```

### 5B. Execute Validation
Follow the `/validate-plan` workflow:
1. Read plan from `features/<feature-name>/plan.md`
2. Run all automated checks
3. Spawn research agents to verify implementation
4. Generate validation report
5. Save to `features/<feature-name>/validation-report.md`

### 5C. Present Validation Results
```
📊 Validation complete: features/<feature-name>/validation-report.md

[Show summary of results]

Issues found: [X]
Ready for PR? (yes/fix-issues)
```

**Wait for user decision**

**Context Handoff**: Validation report saved

### 5D. Handle Issues
If issues found:
- Return to Phase 3 implementation for fixes
- Re-validate after fixes
- Loop until validation passes

---

## Phase 6: PR Creation
**Goal**: Create PR with comprehensive description

### 6A. Inform User
```
🚀 Creating pull request...
```

### 6B. Create PR
Use the **git-workflow-manager** skill to:
1. Ensure feature branch exists: `feature/<sanitized-title>`
2. Commit any final changes with structured message
3. Push branch to remote
4. Create PR with:
   - Summary from plan
   - Phases completed
   - Validation results
   - Testing checklist

### 6C. Finalize Session
After PR is created, finalize the session using the instructions in the **Session Tracking** section. Use the PR URL and compute execution/wait times.

### 6D. Present PR
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

## Phase 7: Post-Completion Eval
**Goal**: Automatically evaluate workflow quality using the LLM judge

### 7A. Trigger Eval Hook
After PR creation, run the post-completion eval hook. This is automatic and non-blocking — if eval fails, the workflow is still complete.

```bash
npx tsx tools/run-eval-hook.ts --issue <ISSUE_ID> --pr <PR_NUMBER> --pr-url <PR_URL> --workflow-type workflow
```

Replace `<ISSUE_ID>`, `<PR_NUMBER>`, and `<PR_URL>` with the actual values from the workflow.

### 7B. Report Eval Result
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
- Self-review logs → `features/<feature-name>/review-iteration-*.log`
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
- The self-review phase automatically catches common issues before validation
- Review logs are saved for transparency and debugging
- Configure in `.wavemill-config.json`: review.maxIterations (default: 3), review.enabled (default: true)
- Disable self-review by setting `review.enabled: false` in config
