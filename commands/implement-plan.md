Execute an implementation plan with phase gates and validation checkpoints.

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
