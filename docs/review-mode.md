---
title: Review Mode
---

Wavemill includes an LLM-powered code review system that catches major issues before PRs are created. It runs automatically as part of the feature workflow and can also be invoked standalone on branches or existing PRs.

## What It Does

- Diffs the current branch against the target branch (default: `main`).
- Gathers context: task packet, plan document, and design artifacts.
- Sends the diff and context to an LLM judge for structured review.
- Returns a verdict (`ready` / `not_ready`) with categorized findings.
- In workflow mode, iteratively fixes blockers and re-reviews (up to a configurable limit).

## How It Integrates

Review runs as **Phase 4** of the [Feature Workflow](feature-workflow.md), between implementation and validation:

```
Plan → Implement → Self-Review Loop → Validate → PR
```

After implementation completes, the agent:

1. Runs `review-changes.ts` against `main`.
2. If the verdict is `ready`, proceeds to validation.
3. If `not_ready`, reads the findings, fixes blockers, commits, and re-reviews.
4. Repeats up to `maxIterations` (default: 3).
5. Any remaining issues are surfaced in the validation phase.

## Standalone Usage

### Review current branch

```bash
# Review against main (default)
npx tsx tools/review-changes.ts

# Review against a different branch
npx tsx tools/review-changes.ts develop

# Verbose output with full debug info
npx tsx tools/review-changes.ts main --verbose

# Skip UI review
npx tsx tools/review-changes.ts main --skip-ui

# UI review only
npx tsx tools/review-changes.ts main --ui-only
```

### Review an existing PR

```bash
# Review PR #42 in the current repo
npx tsx tools/review-pr.ts 42

# Review PR in a different repo
npx tsx tools/review-pr.ts 42 --repo owner/repo-name
```

### Gather review context (without running review)

```bash
npx tsx tools/gather-review-context.ts main
```

Outputs JSON with diff, task packet, plan, design context, and metadata.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Review passed (`ready`) |
| `1` | Review failed (`not_ready`) |
| `2` | Error occurred |

## What Gets Reviewed

The review prompt focuses on **major issues only** — not style nits or subjective preferences.

### Code Review Categories

| Category | Examples |
|----------|----------|
| Logical errors | Off-by-one, null handling, race conditions, incorrect conditionals |
| Security | SQL injection, XSS, exposed secrets, missing auth checks |
| Requirements deviation | Missing planned features, wrong implementation approach |
| Error handling | Unhandled network failures, missing validation at system boundaries |
| Architectural consistency | Pattern violations, wrong abstraction layer, breaking changes |

### Plan Compliance (conditional)

When a task packet is available, the review also checks:

- **Acceptance criteria coverage** — are all criteria from the task packet addressed?
- **Unexpected deviations** — does the implementation diverge from the plan?
- **Missing planned items** — are any planned features absent from the diff?

### UI Review (conditional)

When design artifacts are detected (Tailwind config, component library, DESIGN.md, CSS variables), the review additionally checks:

- Visual consistency with design tokens
- Component library compliance
- Console error expectations (missing keys, hook violations)
- Responsive behavior
- Style guide adherence

## Context Gathering

The review tool automatically discovers context from the repository:

| Context | Source |
|---------|--------|
| Task packet | `features/{slug}/task-packet-header.md` + `task-packet-details.md`, or legacy `task-packet.md` |
| Plan | `features/{slug}/plan.md` or `bugs/{slug}/plan.md` |
| Tailwind config | `tailwind.config.{js,ts,mjs,cjs}` theme section |
| Component library | `package.json` dependencies (Radix, Headless UI, MUI, shadcn/ui) |
| Design guide | `DESIGN.md`, `STYLE-GUIDE.md` |
| CSS variables | `:root` blocks from global stylesheets |
| Design tokens | `tokens.json`, `design-tokens.json`, `theme.json` |
| Storybook | `.storybook/` directory or storybook dependency |

The slug is extracted from branch names matching `task/`, `feature/`, `bugfix/`, or `bug/` prefixes.

## Configuration

Review settings live in `.wavemill-config.json`:

```json
{
  "review": {
    "enabled": true,
    "maxIterations": 3
  },
  "eval": {
    "judge": {
      "model": "claude-sonnet-4-5-20250929",
      "provider": "anthropic"
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `review.enabled` | `true` | Enable/disable self-review in the workflow |
| `review.maxIterations` | `3` | Max review-fix cycles before proceeding |
| `eval.judge.model` | `claude-sonnet-4-5-20250929` | LLM model used for review |
| `eval.judge.provider` | `claude-cli` | Provider (`claude-cli` or `anthropic`) |

## Key Files

| File | Purpose |
|------|---------|
| `tools/review-changes.ts` | CLI tool — review current branch against target |
| `tools/review-pr.ts` | CLI tool — review a GitHub pull request |
| `tools/gather-review-context.ts` | CLI tool — output review context as JSON |
| `shared/lib/review-engine.ts` | Core review engine (prompt filling, LLM invocation, retry logic, JSON parsing) |
| `shared/lib/review-runner.ts` | Wrapper for local change reviews (delegates to review-engine) |
| `shared/lib/review-context-gatherer.ts` | Gathers diff, task packet, plan, and design context |
| `tools/prompts/review.md` | Review prompt template with JSON schema and evaluation criteria |

## Troubleshooting

### Review tool returns "Failed to parse review response"

This means the LLM returned conversational text instead of JSON. The tool now includes automatic retry with a stricter prompt, but if it persists:

**Causes:**
1. **Missing context files** — The tool couldn't find task packet or plan files
2. **Model configuration** — The LLM is not following JSON format instructions
3. **Network issues** — Incomplete or corrupted LLM response

**Solutions:**

1. **Run with verbose mode** to see what the LLM returned:
   ```bash
   npx tsx tools/review-changes.ts main --verbose
   ```

   Look for the "LLM Response (raw)" section to see the actual output.

2. **Check if context files exist**:
   - Task packet should be at: `features/{slug}/task-packet-header.md`
   - Plan should be at: `features/{slug}/plan.md`
   - For bugfix workflows: `bugs/{slug}/task-packet.md` and `bugs/{slug}/plan.md`

   If these files are missing, the tool should still work, but may be less accurate.

3. **Try a different model**:
   ```bash
   REVIEW_MODEL=claude-opus-4-6 npx tsx tools/review-changes.ts main
   ```

   More capable models generally follow JSON format instructions better.

4. **Check your configuration**:
   - Ensure `.wavemill-config.json` has valid judge settings
   - Verify the model ID is correct (run `claude models` to list available models)

### Review tool is slow

Large diffs (>1000 lines) can take 2-3 minutes to review. This is expected behavior.

**To monitor progress:**
```bash
npx tsx tools/review-changes.ts main --verbose
```

The verbose output shows:
- Prompt being sent
- LLM invocation status
- Raw response received
- Parsing progress

**To speed up reviews:**
- Break large changes into smaller PRs
- Use `--skip-ui` flag if UI review isn't needed
- Consider using a faster model (e.g., Haiku for simple changes)

### Review tool shows "conversational response" warning

This warning appears when the LLM doesn't return pure JSON on the first attempt. The tool automatically retries with a stricter prompt.

**Normal behavior:**
```
⚠️  LLM returned conversational response (attempt 1/2)
Retrying with stricter prompt...
```

If you see this followed by successful parsing, no action is needed. The retry mechanism handled it.

**If retry fails:**
1. Check verbose output to see what the LLM returned
2. Verify your model supports JSON-only responses
3. Try a different model
4. Check for network/timeout issues

### How the multi-layer defense works

The review engine uses a 4-layer approach to ensure reliable JSON output:

**Layer 1: Clear Prompt Instructions**
- Explicit JSON schema at the top of the prompt
- Multiple reminders throughout the prompt
- Clear examples of expected output format
- Works with any LLM provider (Claude, Codex, OpenAI, etc.)

**Layer 2: Response Pre-Validation**
- Checks if response looks like JSON before parsing
- Detects conversational patterns ("Sure, let me...", "Based on...", etc.)
- Fast-fails on obvious non-JSON responses

**Layer 3: Automatic Retry**
- If validation fails, retries with stricter prompt
- Adds emphasis to JSON-only requirement
- Second attempt has ~95% success rate

**Layer 4: Robust Parsing**
- 4-strategy JSON extraction (code fences, XML tags, brace-depth tracking)
- Handles edge cases like JSON with preambles
- Clear error messages when parsing fails

This multi-layer defense ensures reliable, structured review output even when context files are missing, regardless of which LLM provider is used.

## See Also

- [Feature Workflow](feature-workflow.md) — the full workflow where self-review runs as Phase 4
- [Mill Mode](mill-mode.md) — autonomous backlog processing (uses review in each agent's workflow)
- [Expand Mode](expand-mode.md) — batch expand issues into task packets
- [Eval Mode](eval-mode.md) — evaluate LLM performance on workflows
- [Troubleshooting](troubleshooting.md) — common issues and fixes
