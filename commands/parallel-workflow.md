Execute multiple Linear issues in parallel using git worktrees.

This command enables concurrent work on multiple issues by:
1. Creating isolated worktrees for each issue
2. Running plan creation in parallel (background agents)
3. Batching human review checkpoints
4. Tracking progress across all active issues

---

## Context Management Strategy

**Critical**: This workflow uses a "thin coordinator" pattern to prevent context pollution.

### Rules for the Coordinator Session

1. **NEVER read implementation files directly**
   - Don't read `plan.md`, `prd.md`, or source code from worktrees
   - Only read `.parallel-workflow/active-sessions.json` for state

2. **Use background agents for all heavy work**
   - Plan creation: Background Task agent (isolated context)
   - Research: Background Explore agent (isolated context)
   - Agents return 2-3 sentence summaries, not full content

3. **State lives in files, not conversation**
   - All transitions logged to `active-sessions.json`
   - On resume, read JSON - never rely on "remember when we..."

4. **One implementation focus at a time**
   - Clear context before starting each implementation
   - Load only that issue's artifacts
   - Complete or checkpoint before switching

### Context Budget

| Activity | Context Used | Notes |
|----------|--------------|-------|
| Session metadata | ~2% | JSON state tracking |
| Plan summaries | ~5% | 2-3 sentences per issue |
| Active implementation | ~60% | Full focus on one issue |
| Buffer | ~33% | For exploration, errors |

### When to Clear Context

- After batch plan approval (before implementation)
- When switching between implementations
- After PR creation (before next issue)

---

## Prerequisites

Ensure you're in the **main project repository** (not a worktree) before starting.

---

## Phase 1: Multi-Issue Selection

### 1A. Fetch Backlog
Run the Linear backlog tool for each configured project:
```bash
npx tsx ~/.claude/tools/get-backlog.ts "PROJECT_NAME"
```

### 1B. Batch Selection
Present issues and allow user to select **multiple**:
```
Select issues to work on in parallel (comma-separated numbers, max 4):

Hokusai Infrastructure:
  1. [HOK-123] Add caching layer
  2. [HOK-124] Implement retry logic
  3. [HOK-125] Add metrics dashboard

Hokusai Data Pipeline:
  4. [HDP-45] Optimize batch processing
  5. [HDP-46] Add data validation

Enter selections (e.g., 1,3,4):
```

### 1C. Validate Selection
- Maximum 4 concurrent issues recommended (context management)
- Check for dependencies between selected issues
- Warn if issues are from same project (branch conflicts without worktrees)

---

## Phase 2: Worktree Setup

### 2A. Create Worktrees
For each selected issue, create an isolated worktree:

```bash
# Base directory for worktrees (outside main repo)
WORKTREE_BASE="${HOME}/worktrees"
mkdir -p "${WORKTREE_BASE}"

# For each issue:
SANITIZED_NAME="<sanitized-issue-title>"
BRANCH_NAME="feature/${SANITIZED_NAME}"

# Create branch and worktree
git branch "${BRANCH_NAME}" main 2>/dev/null || true
git worktree add "${WORKTREE_BASE}/${SANITIZED_NAME}" "${BRANCH_NAME}"
```

### 2B. Initialize Feature Directories
In each worktree:
```bash
cd "${WORKTREE_BASE}/${SANITIZED_NAME}"
mkdir -p "features/${SANITIZED_NAME}"
# Save selected-task.json
```

### 2C. Create Tracking File
Save parallel session state to main repo:
```json
// .parallel-workflow/active-sessions.json
{
  "startedAt": "2025-01-11T10:00:00Z",
  "sessions": [
    {
      "issueId": "HOK-123",
      "title": "Add caching layer",
      "worktreePath": "/Users/you/worktrees/add-caching-layer",
      "branch": "feature/add-caching-layer",
      "phase": "planning",
      "status": "in_progress"
    },
    {
      "issueId": "HDP-45",
      "title": "Optimize batch processing",
      "worktreePath": "/Users/you/worktrees/optimize-batch-processing",
      "branch": "feature/optimize-batch-processing",
      "phase": "planning",
      "status": "in_progress"
    }
  ]
}
```

---

## Phase 3: Parallel Plan Creation

### 3A. Launch Background Agents
Use the Task tool to launch plan creation for each issue **in parallel**:

```
Launching plan creation for 3 issues in parallel...

[1/3] HOK-123: Add caching layer - Planning...
[2/3] HOK-124: Implement retry logic - Planning...
[3/3] HDP-45: Optimize batch processing - Planning...
```

For each issue, run `/create-plan` workflow in its worktree:
1. Read task context from `features/<name>/selected-task.json`
2. Use research-orchestrator for codebase analysis
3. Generate structured plan with phases
4. Save to `features/<name>/plan.md`

### 3B. Monitor Progress
Check agent status periodically:
```
Planning Progress:
✅ HOK-123: Plan ready for review
⏳ HOK-124: Researching codebase (2 min)
✅ HDP-45: Plan ready for review

2 plans ready for batch review.
```

---

## Phase 4: Batched Plan Review

### 4A. Present Plans for Review
When plans are ready, present them in batch:

```
📋 Plans Ready for Review

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1] HOK-123: Add caching layer
    Path: ~/worktrees/add-caching-layer/features/add-caching-layer/plan.md
    Phases: 4
    Estimated complexity: Moderate

    Summary: Implement Redis caching for API responses...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[2] HDP-45: Optimize batch processing
    Path: ~/worktrees/optimize-batch-processing/features/optimize-batch-processing/plan.md
    Phases: 3
    Estimated complexity: Simple

    Summary: Add parallel processing to batch jobs...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Actions:
- approve <number>: Approve plan, move to implementation
- approve all: Approve all plans
- review <number>: Show full plan details
- revise <number>: Request plan revision
- skip <number>: Skip this issue for now

Enter action:
```

### 4B. Handle Approvals
For each approved plan, update tracking:
```json
{
  "issueId": "HOK-123",
  "phase": "implementation",
  "status": "ready"
}
```

---

## Phase 5: Staggered Implementation

### 5A. Implementation Strategy
Implement issues one at a time (to maintain focus), but with pre-planned context:

```
Implementation Queue:
1. HOK-123: Add caching layer (approved, starting now)
2. HDP-45: Optimize batch processing (approved, queued)
3. HOK-124: Implement retry logic (planning complete, awaiting approval)

Starting implementation of HOK-123...
```

### 5B. Switch Between Issues
When blocked on one issue (waiting for tests, review, etc.), switch to next:

```
HOK-123 implementation paused at Phase 2 (waiting for API rate limit).
Switching to HDP-45...

cd ~/worktrees/optimize-batch-processing
```

### 5C. Track Implementation Progress
Update tracking file as phases complete:
```json
{
  "issueId": "HOK-123",
  "phase": "implementation",
  "implementationPhase": 2,
  "totalPhases": 4,
  "status": "blocked",
  "blockedReason": "Waiting for external API"
}
```

---

## Phase 6: Parallel Validation & PR

### 6A. Batch Validation
When implementations complete, run validation in parallel:

```bash
# For each completed implementation:
cd "${WORKTREE_PATH}"
npm test && npm run lint && npm run build && npm run typecheck
```

### 6B. Batch PR Creation
Create PRs for all validated implementations:

```
Creating PRs for validated implementations...

✅ HOK-123: PR #142 created
   https://github.com/org/hokusai-infra/pull/142

✅ HDP-45: PR #89 created
   https://github.com/org/hokusai-pipeline/pull/89

All PRs created. Ready for review.
```

---

## Worktree Management

### List Active Worktrees
```bash
git worktree list
```

### Clean Up After Merge
```bash
# Remove worktree after PR merged
git worktree remove ~/worktrees/add-caching-layer
git branch -d feature/add-caching-layer
```

### Prune Stale Worktrees
```bash
git worktree prune
```

---

## Session Recovery

If interrupted, resume with:
```
/parallel-workflow resume
```

This reads `.parallel-workflow/active-sessions.json` and continues from last checkpoint.

---

## Recommended Limits

| Resource | Limit | Reason |
|----------|-------|--------|
| Concurrent issues | 4 | Context management |
| Issues per project | 2 | Avoid merge conflicts |
| Background agents | 3 | API rate limits |
| Implementation queue | 2 | Focus quality |

---

## Example Session

```
User: /parallel-workflow

Claude: Fetching backlog from configured projects...

[Shows numbered list from both projects]

User: 1, 3, 5

Claude: Selected 3 issues:
- HOK-123: Add caching layer
- HOK-125: Add metrics dashboard
- HDP-45: Optimize batch processing

Creating worktrees...
✅ ~/worktrees/add-caching-layer
✅ ~/worktrees/add-metrics-dashboard
✅ ~/worktrees/optimize-batch-processing

Launching parallel plan creation (3 background agents)...
[Progress updates]

Plans ready. [Presents batch review]

User: approve all

Claude: Starting implementation queue...
[Implements one at a time, tracking progress]
[Creates PRs when complete]
```
