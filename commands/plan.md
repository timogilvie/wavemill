Execute the plan decomposition workflow using agent skills:

## Phase 1: Epic Selection
Use the **linear-task-selector** skill to:
- Fetch large work items (epics) from Linear backlog
- Display numbered epic list to user
- Save selected epic context to `/tmp/selected-linear-task.json`

## Phase 2: Research & Documentation
Use the **document-orchestrator** skill to:
- Create `/tmp/plan-decomposition/` directory
- Generate decomposition request JSON from epic context
- Research existing codebase implementation (what exists vs. what's missing)
- Document research findings in `research.md`

## Phase 3: Generate Decomposition Plan
Use the **document-orchestrator** skill to:
- Break epic into 3-10 actionable sub-issues
- Each sub-issue completable in single PR
- Include tests and docs in each task (not separate)
- Define clear dependencies using array indices
- Assign estimates (1-2 simple, 3-5 moderate, 5-8 complex)
- Set priorities (1 urgent, 2 high, 3 normal, 4 low)
- Save plan to `/tmp/linear-decomposition-plan.json`

## Phase 4: Create Sub-Issues in Linear
Run the creation script:
```bash
npx tsx ~/.claude/tools/plan-workflow.ts [project-name] create
```

This creates all sub-issues with:
- Links to parent epic
- References to relevant files and master documents
- Proper dependency relationships
- Self-contained context for junior engineers/LLMs

## Phase 5: Verification
Verify all sub-issues:
- [ ] Created successfully in Linear
- [ ] Descriptions include parent context
- [ ] Dependencies noted correctly
- [ ] Story points assigned
- [ ] Tagged with epic milestone

Each sub-issue will be detailed enough to complete independently in a single PR.
