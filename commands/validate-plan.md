Systematically verify that an implementation plan was executed correctly before creating a PR.

## Phase 1: Context Discovery
1. Locate the implementation plan (typically `features/<feature-name>/plan.md`)
2. Gather implementation evidence:
```bash
# Get recent commits
git log --oneline -20

# See what changed
git diff main...HEAD --stat

# Check current status
git status
```

## Phase 2: Plan Verification
Read the plan and verify each phase:

### A. Automated Verification
Run all automated checks from the plan:
```bash
# Examples - adjust based on project
npm test
npm run lint
npm run build
npm run type-check
```

Document results:
- ✅ All tests pass
- ❌ 3 tests failing in auth.test.ts
- ⚠️ 2 linting warnings

### B. Success Criteria Check
For each success criterion in the plan:
- [ ] Verify it was completed
- [ ] Run any specified tests
- [ ] Document evidence (file changes, test output, etc.)

### C. Code Review Analysis
Spawn research agents to verify implementation quality:
- Check for TODOs or incomplete code
- Verify error handling exists
- Confirm tests cover edge cases
- Look for potential issues

## Phase 3: Generate Validation Report
Create `features/<feature-name>/validation-report.md`:

```markdown
# Validation Report

## Plan Adherence
- [x] Phase 1: Setup - Complete
- [x] Phase 2: Core Implementation - Complete
- [ ] Phase 3: Error Handling - Partial (missing timeout handling)

## Automated Checks
- Tests: ✅ All 47 tests passing
- Linting: ✅ No errors
- Build: ✅ Successful
- Type Check: ❌ 2 type errors in api.ts:45, utils.ts:12

## Code Review Findings
### Issues
1. Missing error handling for API timeout (plan Phase 3)
2. Type errors in api.ts need fixing

### Recommendations
1. Add timeout handling as specified in plan
2. Fix type errors before PR
3. Consider adding integration test for error path

## Manual Testing Needed
- [ ] Test user authentication flow end-to-end
- [ ] Verify error messages display correctly
- [ ] Check mobile responsive design

## Next Steps
1. Fix identified issues
2. Complete manual testing
3. Update plan checkboxes
4. Ready for PR creation
```

## Phase 4: Present Findings
1. Show validation report to user
2. Highlight any blockers or issues
3. Recommend next steps:
   - If validation passes: Proceed to PR
   - If issues found: Fix them first
   - If uncertain: Get user input

## Key Principles
- **Be thorough** - Check every criterion
- **Run all checks** - Don't skip automated tests
- **Document findings** - Evidence over assumptions
- **Be constructive** - Suggest fixes, not just problems
- **Think long-term** - Consider maintainability

## Output
Validation report saved to: `features/<feature-name>/validation-report.md`

Next step: If validation passes, use `/describe-pr` or create PR directly.
