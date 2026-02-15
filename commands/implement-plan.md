Execute an implementation plan with phase gates and validation checkpoints.

---

## Session Tracking

This workflow automatically captures execution metadata for eval. Session management is **non-intrusive** — if any session command fails, continue the workflow normally.

### At Workflow Start
When starting plan execution, create a session:
```bash
SESSION_ID=$(npx tsx tools/session.ts start \
  --workflow implement-plan \
  --prompt "<plan title or feature description>" \
  --model "<current model, e.g. claude-opus-4-6>" \
  --issue "<Linear issue ID if available>")
SESSION_START_MS=$(date +%s%3N)
```

### Before/After User Prompts (Phase Gates)
Track user wait time at each phase gate checkpoint:
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

## Prerequisites
- Implementation plan exists at `features/<feature-name>/plan.md`
- Plan has been reviewed and approved by user

## Phase 1: Plan Review
1. Read the entire plan thoroughly
2. Create todo list from plan phases
3. Confirm understanding of success criteria
4. Ask user to confirm ready to begin

## Phase 2: Phased Implementation
For each phase in the plan:

### A. Pre-Phase Check
- Mark phase as in_progress in todos
- Review phase requirements and dependencies
- Confirm previous phases are complete

### B. Implementation
- Follow the plan's intent while maintaining flexibility
- Think deeply about how pieces fit together
- Write tests first when possible
- Make incremental commits with clear messages

### C. Automated Verification
Run automated checks defined in plan:
```bash
# Example - adjust based on project
npm test
npm run lint
npm run build
```
- Fix any failures before proceeding
- Update plan checkboxes as tests pass

### D. Phase Gate: Human Verification
**STOP and pause for user verification:**
1. Present what was completed in this phase
2. Show test results and any output
3. Highlight any deviations from plan
4. Ask user to verify before proceeding

⚠️ **Do not proceed to next phase without user confirmation**

### E. Handle Blockers
If plan cannot be followed exactly:
1. Stop implementation
2. Clearly explain the mismatch or blocker
3. Present options:
   - Adjust plan and continue
   - Investigate further
   - Seek user guidance
4. Wait for user decision

## Phase 3: Final Validation
After all phases complete:
1. Run full test suite
2. Check all success criteria from plan
3. Review manual verification steps with user
4. Document any outstanding items

## Phase 4: PR Preparation
Use the **git-workflow-manager** skill to:
- Create feature branch if not already on one
- Commit all changes with descriptive message
- Push branch to remote
- Create PR with plan summary
- Include completion status of all phases

After PR is created, finalize the session using the Session Tracking instructions above.

## Key Principles
- **One phase at a time** - Don't rush ahead
- **Stop at gates** - Wait for user verification between phases
- **Communicate clearly** - Explain any issues immediately
- **Stay flexible** - Plans are guides, not rigid contracts
- **Test continuously** - Don't accumulate untested changes

## Handling Complications
- If tests fail: Fix them before proceeding
- If requirements unclear: Ask before implementing
- If plan seems wrong: Discuss with user, don't just follow blindly
- If stuck: Explain the blocker and ask for help

Next step: After PR created, use `/validate-plan` (if available) to verify implementation.
