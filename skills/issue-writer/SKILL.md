---
name: issue-writer
description: Expand Linear issues into comprehensive task packets that enable autonomous AI agent execution with minimal oversight. Transforms brief issue summaries into detailed specs with context, constraints, success criteria, and validation steps.
---

# Issue Writer

This skill expands brief Linear issue summaries into comprehensive "task packets" that autonomous AI agents can execute successfully. Claude does the expansion natively using its full codebase context — no subprocess spawning.

## When to Use

Use this skill when:
- Preparing issues for autonomous agent execution (via hokusai-orchestrator)
- Issues have minimal description but need detailed implementation guidance
- Creating task specifications for parallel workflow execution
- Converting feature requests into actionable technical specs

## Instructions

### Step 1: Fetch the Issue

```bash
npx tsx ~/.claude/tools/get-issue.ts HOK-XXX
```

Review the output: title, current description, project, state, priority, labels, parent/child relationships, and comments.

### Step 2: Explore the Codebase

Use Explore agents (Task tool with `subagent_type: "Explore"`) to find:
- Files that will need to be created or modified
- Existing patterns and conventions to follow
- Related implementations to use as reference
- Dependencies and integration points

Run multiple Explore agents in parallel for different aspects (e.g., one for UI patterns, one for service layer, one for tests).

### Step 3: Generate the Task Packet

Write the expanded description following the structure in `~/.claude/tools/prompts/issue-writer.md`:

1. **Objective** — What / Why / Scope In / Scope Out
2. **Technical Context** — Repository, key files, dependencies, architecture notes
3. **Implementation Approach** — Step-by-step plan with concrete actions
4. **Success Criteria** — Functional, non-functional, code quality (specific and measurable)
5. **Implementation Constraints** — Code style, testing, security, performance rules
6. **Validation Steps** — Exact commands to run with expected output
7. **Definition of Done** — Final checklist
8. **Rollback Plan** — How to undo safely

Key principles:
- **Specificity over brevity** — over-specify rather than under-specify
- **Include exact file paths** — not just "the component file"
- **Measurable criteria** — "loads in <2s" not "should be fast"
- **Validation-first** — agent should know how to verify success before starting
- **Reference existing code** — point to similar implementations as patterns to follow

### Step 3.5: Auto-Generate Labels

After generating the task packet, analyze the content and prepare labels for the issue:

1. **Extract Files to Modify**
   - Parse file paths from the Technical Context and Implementation Approach sections
   - Add as metadata: `Files: <path1>, <path2>, ...` (limit to first 3 files)

2. **Assess Risk Level**
   - Check for: breaking changes, migrations, schema changes, infrastructure changes
   - **Risk: High** — Breaking changes, migrations, infrastructure, major refactors
   - **Risk: Medium** — New features, non-trivial refactoring, API changes (default)
   - **Risk: Low** — CSS/styling, text updates, documentation, typo fixes

3. **Identify Architectural Layer**
   - Parse file paths and implementation approach
   - **Layer: UI** — Components, frontend code (`.tsx`, `.jsx`, `components/`)
   - **Layer: API** — API routes, endpoints (`/api/`, `routes/`)
   - **Layer: Service** — Business logic, services (`services/`, `lib/`)
   - **Layer: Database** — Schema, migrations, queries (`schema.prisma`, `migrations/`)
   - **Layer: Infra** — Config, deployment, CI/CD (`Dockerfile`, `.github/`, `deploy/`)

4. **Identify Area**
   - Based on feature/component affected:
   - **Area: Landing** — Landing page, homepage, hero
   - **Area: Navigation** — Nav, menus, routing
   - **Area: Auth** — Authentication, authorization, login
   - **Area: API** — API endpoints, GraphQL, REST
   - **Area: Database** — Database schema, queries
   - **Area: Docs** — Documentation, README
   - **Area: Infrastructure** — Deployment, config, CI/CD
   - **Area: Testing** — Test infrastructure, test utilities

5. **Check Test Requirements**
   - Parse Validation Steps section
   - **Tests: E2E** — End-to-end tests (Playwright, Cypress)
   - **Tests: Integration** — Integration tests
   - **Tests: Unit** — Unit tests (Jest, Vitest)
   - **Tests: None** — No tests required

6. **Extract Dependencies** (if mentioned)
   - Look for references to other issues (HOK-XXX)
   - Add: `Blocked-By: HOK-XXX` or `Related-To: HOK-XXX`

Add these labels as a section at the bottom of your task packet:

```markdown
---
## Proposed Labels
- Risk: Medium
- Layer: UI
- Area: Landing
- Tests: Unit
- Files: src/components/Hero.tsx, src/hooks/useTheme.ts
```

### Step 4: Write to Temp File and Update Linear

Save the expanded description to a temp file, then push it to Linear:

```bash
# Write expanded description to temp file (use Write tool)
# Then update Linear:
npx tsx ~/.claude/tools/update-issue.ts HOK-XXX --file /tmp/hok-xxx-expanded.md
```

### Step 5: Apply Auto-Labels

After updating the issue description, automatically apply the proposed labels:

```bash
npx tsx ~/.claude/tools/auto-label-issue.ts HOK-XXX
```

This will:
- Parse the issue description and title
- Detect risk level, layers, areas, files, and test requirements
- Apply matching labels to the issue in Linear
- Report which labels were applied

If labels don't exist yet, create them first:

```bash
npx tsx ~/.claude/tools/init-labels.ts
```

### Step 6: Report Back

Tell the user:
- The Linear issue URL
- A brief summary of what was expanded
- Which labels were applied
- Any concerns or ambiguities found during exploration

## Task Packet Quality Checklist

Before updating Linear, verify the expanded issue includes:
- [ ] Specific, measurable success criteria (not vague)
- [ ] Exact file paths that will be modified
- [ ] Concrete validation commands with expected output
- [ ] Clear scope boundaries (what's NOT included)
- [ ] Security/performance constraints if applicable
- [ ] Rollback instructions
- [ ] References to existing patterns/implementations

## Examples by Task Type

### Feature Addition
Focus on: User stories, UI/UX requirements, integration points, existing component patterns
Example: "User can upload avatar (JPEG/PNG, max 5MB, 1:1 crop, S3 storage)"

### Bug Fix
Focus on: Root cause, reproduction steps, regression prevention
Example: "Fix race condition in WebSocket reconnect (add mutex, test with 1000 concurrent connections)"

### Refactoring
Focus on: What's changing structurally, what's NOT changing behaviorally
Example: "Extract auth logic into reusable hooks (identical test output before/after)"

### Performance Optimization
Focus on: Measurable metrics (bundle size, render time, API latency)
Example: "Reduce dashboard load time from 2.3s to <1s (lazy load charts, virtualize lists)"

## Environment Setup

Requires:
- `LINEAR_API_KEY` in `.env`

## Batch Usage

To expand multiple issues, invoke the skill repeatedly:
```
/issue-writer HOK-101
/issue-writer HOK-102
/issue-writer HOK-103
```

After expanding, use with hokusai-orchestrator for parallel execution.
