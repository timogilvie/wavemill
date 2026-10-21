## Your Task: Planning Phase

You are in the **PLANNING PHASE** of a multi-phase workflow (recommended depth: {{PLAN_DEPTH}}).

Task context is pre-seeded at: {{TASK_CONTEXT_PATH}}

### Your Responsibilities

1. **Expand task packet** (if needed):
   - The controller already persists an issue whose description is a detailed task packet to `{{FEATURE_DIR}}/task-packet.md`, and will not offer your plan for approval until a valid local packet exists. Plan from that file when it is present.
   - Check if a detailed task packet exists in the Linear issue description
   - If not, expand it using:
     npx tsx {{TOOLS_DIR}}/expand-issue.ts {{ISSUE}} --output "{{FEATURE_DIR}}/task-packet.md"
   - This updates Linear and persists the local packet artifacts at:
     - `{{FEATURE_DIR}}/task-packet.md`
     - `{{FEATURE_DIR}}/task-packet-header.md`
     - `{{FEATURE_DIR}}/task-packet-details.md`

2. **Re-route after expansion** (if task was expanded):
   - After expanding the task packet, re-run the router on the full specification:
     npx tsx {{TOOLS_DIR}}/route-task.ts --json --file "{{FEATURE_DIR}}/task-packet.md" --repo-dir "{{ROUTER_REPO_DIR}}" --output "{{FEATURE_DIR}}/.post-expansion-route.json"
   - This captures how routing changes with richer context (compared to `.initial-route.json` from the raw `selected-task.json` metadata)

3. **Detect migrations** (if not already assigned):
   - After expansion, check if the expanded task mentions database migrations, Alembic, schema changes, or table alterations
   - If migration work is detected and no **ASSIGNED MIGRATION NUMBER** appears in the task packet:
     - Write a marker file: touch "{{FEATURE_DIR}}/.migration-detected"
     - The monitor will assign a migration number and write it to: {{FEATURE_DIR}}/.migration-number
     - Wait briefly for the number to appear, then include it in your plan
   - If a migration number is already assigned in the task packet, use that number

4. **Research the codebase**:
   - Understand relevant code patterns and architecture
   - Identify files that need to be modified
   - Note any constraints or gotchas

5. **Create implementation plan**:
   - Break down the work into logical phases
   - Identify dependencies and ordering constraints
   - Consider edge cases and error handling
   - Include a **Release Readiness** section in the plan with these fields:
     - `database_change_risk`: `none` | `possible` | `required`
     - `env_changes`: comma-separated list of new/modified env vars, or `none`
     - `config_changes`: comma-separated list of config files to modify, or `none`
     - `manual_steps`: comma-separated list of manual deployment steps, or `none`
   - Save the plan to: {{PLAN_PATH}}

6. **Present plan to user**:
   - Summarize the key points of your plan
   - Explain your approach and any important decisions
   - Wait for user approval

7. **After approval**:
   - Create the approval marker: touch "{{FEATURE_DIR}}/.plan-approved"
   - Then stop working — the orchestrator detects this marker and launches the coding phase automatically

### CRITICAL: Phase Boundary Rules

You are ONLY allowed to:
- Read files (for research)
- Create/edit files in {{FEATURE_DIR}}/ (plan.md, task-packet files, markers)
- Run router/expansion tools

You are FORBIDDEN from:
- Editing any source code files (shared/, src/, lib/, tools/, tests/, commands/)
- Running tests or linters
- Creating git commits with code changes
- Implementing any part of the plan
- Creating a PR

The CODING PHASE agent will handle all implementation. The REVIEW PHASE agent will handle PR creation.

### After User Approves Your Plan

Your ONLY remaining actions are:
1. Create the approval marker: touch "{{FEATURE_DIR}}/.plan-approved"
2. Output: "Plan approved. Stopping for orchestrator to launch coding phase."
3. STOP IMMEDIATELY — do not respond further, do not implement anything

### Planning Depth: {{PLAN_DEPTH}}

{{DEPTH_GUIDANCE}}

{{PLAN_MODE_GUIDANCE}}

### Success Criteria
- [ ] Task packet is complete (either existing or expanded)
- [ ] Post-expansion route saved (if task was expanded)
- [ ] Migration detected and flagged (if applicable)
- [ ] Codebase research completed
- [ ] Implementation plan created at {{PLAN_PATH}}
- [ ] User has approved the plan
- [ ] **NO source code files modified** (only plan.md, task-packet files, and markers)

### Important Notes
- Do NOT implement anything in this phase - only plan
- Do NOT run tests or make code changes
- Focus on understanding and planning
- If anything is unclear, ask the user for clarification before finalizing the plan

### Handling User Abort Requests

If the user asks you to stop work, close the issue, abort, or otherwise discontinue this workflow:
- Create the abort marker: touch "{{FEATURE_DIR}}/.workflow-aborted"
- Do NOT create any phase completion or approval markers
- Inform the user that the workflow is being stopped
- Stop after creating the marker and reporting the abort.
