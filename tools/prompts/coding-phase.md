## Your Task: Coding Phase

You are in the **CODING PHASE** of a multi-phase workflow (recommended depth: {{CODE_DEPTH}}).

The implementation plan is ready at: {{PLAN_PATH}}

### Pre-coding stance

Before writing any code, state in your response:
1. The success criterion for this task in one sentence.
2. The specific test (file + line, or test name) that would fail if your
   change were incorrect. If no existing test covers the criterion, say so
   and either add one or justify why not.

This is a one-shot statement, not a running commentary.

### Your Responsibilities

1. **Read the plan**:
   - Review {{PLAN_PATH}} thoroughly
   - Understand the phases and approach

2. **Execute the plan**:
   - Implement phase by phase as outlined in the plan
   - Make minimal, high-quality changes
   - Follow the architectural decisions from the plan

3. **Verify changes with:** `bash tests/run-related.sh` — selects transitive
   dependents of your diff, under 60 s for a typical change, and prints only
   failing tests. Agents MUST NOT run `npm test` or any unsharded
   `tests/run-*.sh`; CI runs the full suite.
   - Run it between phases, not just at the end.
   - Pause if anything fails; fix before proceeding.

4. **Mark completion**:
   - When implementation is complete and tests pass
   - Create the marker: {{FEATURE_DIR}}/.coding-complete
   - The marker is a JSON object. It must contain `"stage": "coding"` and
     `"confidence": "high" | "medium" | "low"`. Optional: `"commit"`, `"notes"`.
     Example:
     `{"stage":"coding","confidence":"high","commit":"abc1234"}`
     Record your own confidence that the implementation is correct after validation.
     Use `low` if correctness is still uncertain.
   - Write it with, for example:
     `printf '{"stage":"coding","confidence":"high"}\n' > "{{FEATURE_DIR}}/.coding-complete"`
     Native harness: use `create_marker` with that JSON as content.
   - Any other format is rejected with a structured error and you will be asked to rewrite it.
   - Your work is done - the next phase (review) will be launched automatically

### Coding Depth: {{CODE_DEPTH}}

{{DEPTH_GUIDANCE}}

{{MODE_GUIDANCE}}

### Success Criteria
- [ ] Implementation matches the plan
- [ ] `bash tests/run-related.sh` passes
- [ ] Linting passes
- [ ] No regressions in existing functionality
- [ ] Completion marker created at {{FEATURE_DIR}}/.coding-complete, containing valid JSON with `"stage":"coding"` and `"confidence":"high|medium|low"`

### Important Notes
- Follow the plan - don't deviate without good reason
- If you need to change the approach, document why in commit messages
- Do NOT run self-review or create PR - that's the next phase
- Do NOT ask questions - implement your best judgment and document decisions

### CRITICAL: Phase Boundary Rules

You are ONLY allowed to:
- Edit source code files to implement the plan
- Run tests and linters
- Create git commits
- Create/edit files in {{FEATURE_DIR}}/ (markers only)

You are FORBIDDEN from:
- Creating a PR or running gh pr create
- Running the self-review tool (tools/review-changes.ts)
- Modifying plan.md or task-packet files
- Starting work on features not covered by the plan

The REVIEW PHASE agent will handle self-review and PR creation.

### Handling User Abort Requests

If the user asks you to stop work, close the issue, abort, or otherwise discontinue this workflow:
- Create the abort marker: touch "{{FEATURE_DIR}}/.workflow-aborted"
- Do NOT create the phase completion marker (.coding-complete)
- Inform the user that the workflow is being stopped
- Stop after creating the marker and reporting the abort.
