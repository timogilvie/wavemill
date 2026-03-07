---
title: Expand Mode
---

Use `wavemill expand` to expand descriptions of technical tasks into well structured task packets that are well suited for LLM execution.

## What It Does

- Fetches Linear backlog filtered to issues without detailed task packets.
- Ranks issues by priority score (considers Linear priority, estimates, labels, and dependencies).
- Lets you interactively select up to 3 issues to expand.
- Expands each issue with Claude CLI using the issue-writer prompt template.
- Gathers codebase context (directory structure, recent commits, relevant files, project-context.md).
- Generates comprehensive 9-section task packets with progressive disclosure (header + details).
- Validates output against quality gates (structure, completeness, actionability).
- Auto-extracts and applies suggested labels from the expanded content.
- Updates both description and labels in Linear.

## Run It

```bash
# Interactive expand with project auto-detection
cd <your-project>
wavemill expand
```

Common overrides:

```bash
# Specify project explicitly
LINEAR_PROJECT="My Project" wavemill expand

# Adjust selection limits
MAX_SELECT=5 MAX_DISPLAY=15 wavemill expand
```

## How It Works

### 1) Issue Selection

Wavemill fetches your Linear backlog and filters to issues that need expansion:
- Missing detailed task packet structure
- Short descriptions (< 200 words)
- No implementation-ready content

Issues are ranked by priority score (same algorithm as mill mode) and displayed for selection.

### 2) Context Gathering

For each selected issue, the tool gathers:
- **Issue metadata** — title, description, labels, estimates, parent/child relationships
- **Directory structure** — 3-level tree of the repository
- **Project context** — full content from `.wavemill/project-context.md` if available
- **Recent git activity** — last 20 commits to understand active areas
- **Relevant files** — keyword search based on issue title

### 3) Claude Expansion

The tool invokes Claude CLI with:
- The issue-writer prompt template (`tools/prompts/issue-writer.md`)
- Issue context and codebase context
- Instructions to output pure markdown (no tool calls, no conversational text)

Claude produces a comprehensive task packet following the 9-section structure.

### 4) Quality Validation

The expanded content goes through validation:
- **Structure check** — verifies expected section headers are present
- **Layer 1 gates** — objective clarity, file/dependency coverage, success criteria completeness
- **Layer 2 gates** — implementation guidance, constraint specificity, validation steps

If validation fails, you're prompted whether to proceed or fix issues first.

### 5) Label Extraction & Application

The tool parses section 9 (Proposed Labels) from the expanded content and:
- Extracts label names and categories
- Compares against existing Linear labels
- Creates new labels if needed
- Applies all labels to the issue

### 6) Linear Update

The full expanded description (header + details) is pushed to Linear. The issue now has:
- Implementation-ready task packet
- Appropriate labels for conflict detection and routing
- Structured validation criteria

## Task Packet Structure

Expanded issues use **progressive disclosure** to reduce context overload:

### Header (Brief Overview)
- Objective (2-3 sentences)
- Top 5 key files to modify
- Top 3 critical constraints
- High-level success criteria
- Links to detailed sections

### Details (Complete Specification)
1. **Objective & Scope** — what and why
2. **Technical Context** — files, dependencies, architecture patterns
3. **Implementation Approach** — step-by-step plan
4. **Success Criteria** — requirements with [REQ-FX] tags
5. **Implementation Constraints** — rules and boundaries
6. **Validation Steps** — concrete test scenarios
7. **Definition of Done** — completion checklist
8. **Rollback Plan** — how to revert if needed
9. **Proposed Labels** — for conflict detection and routing

Agents receive the brief header initially and read detail sections on-demand.

## Quality Gates

### Layer 1: Core Requirements
- Objective is clear and actionable (< 100 words)
- All key files and dependencies are identified
- Success criteria are measurable and testable
- Validation steps are concrete and executable

### Layer 2: Implementation Readiness
- Step-by-step implementation guidance provided
- Constraints are specific with examples
- Test scenarios cover happy path and edge cases
- Labels enable proper conflict detection

Configuration lives in `.wavemill-config.json`:

```json
{
  "validation": {
    "layer1": {
      "objectiveMaxWords": 100,
      "minKeyFiles": 1,
      "minSuccessCriteria": 1
    },
    "layer2": {
      "requireImplementationSteps": true,
      "minValidationSteps": 1
    }
  }
}
```

## Environment Variables

- `LINEAR_PROJECT` — Explicit Linear project override
- `PROJECT_NAME` — Legacy project override, only used when no repo project is configured
- `MAX_SELECT` — Maximum issues to select (default: 3)
- `MAX_DISPLAY` — Maximum issues to display (default: 9)
- `CLAUDE_CMD` — Claude CLI command (default: `claude`)

## Key Files

| File | Purpose |
|------|---------|
| `tools/expand-issue.ts` | Core expansion tool — fetches issue, gathers context, invokes Claude |
| `tools/prompts/issue-writer.md` | Task packet generation prompt template |
| `shared/lib/task-packet-validator.js` | Quality gate validation logic |
| `.wavemill/project-context.md` | Living documentation of patterns and conventions |
| `.wavemill-config.json` | Validation thresholds and project settings |

## See Also

- [Mill Mode](mill-mode.md) — autonomous parallel backlog processing (auto-expands issues)
- [Feature Workflow](feature-workflow.md) — guided single-issue execution
- [Plan Mode](plan-mode.md) — decompose epics into well-scoped sub-issues
- [Eval Mode](eval-mode.md) — evaluate LLM performance on workflows
- [Troubleshooting](troubleshooting.md) — common issues and fixes
