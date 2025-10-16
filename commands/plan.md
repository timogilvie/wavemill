Execute the plan decomposition workflow in TWO steps:

## Step 1: Select Epic
Run: `npx tsx ~/.claude/tools/plan-workflow.ts [project-name]`

This will:
- Fetch backlog issues from Linear
- Let you select a large work item (epic) to decompose
- Save the epic details to `/tmp/linear-decomposition-request.json`

## Step 2: Generate & Create Plan
1. Read `/tmp/linear-decomposition-request.json` to see the epic details
2. Generate a decomposition plan following `~/.claude/tools/prompts/plan-workflow-prompt.md`
3. Save your plan JSON to `/tmp/linear-decomposition-plan.json`
4. Run: `npx tsx ~/.claude/tools/plan-workflow.ts [project-name] create`

The tool will then create all sub-issues in Linear with:
- Links to the parent epic
- References to relevant files and master documents
- Proper dependency relationships ("blocks" relations)
- Self-contained context for junior engineers/LLMs

Each sub-issue will be detailed enough to complete independently in a single PR.
