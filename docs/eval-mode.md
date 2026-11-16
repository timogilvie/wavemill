---
title: Eval Mode
---

Use `wavemill eval` when you want to inspect or export the data that makes Wavemill self-improving. Mill mode records this automatically; the standalone command is for analysis and reporting.

## What It Does

- Gathers context from completed workflows (Linear issue, PR diff, review comments).
- Detects intervention events (manual fixes, review requests, tool failures, rework).
- Analyzes PR difficulty (lines changed, files touched, architectural complexity).
- Collects outcome metrics (CI status, test coverage, static analysis, review rounds).
- Invokes an LLM judge to score the workflow (0.0 - 1.0 scale).
- Applies weighted penalties for interventions based on severity.
- Generates structured evaluation reports with rationale and score bands.
- Persists eval records to disk for aggregate analysis.

## Run It

```bash
# Auto-detect from most recent wavemill workflow
npx tsx tools/eval-workflow.ts

# Evaluate a specific issue and PR
npx tsx tools/eval-workflow.ts --issue HOK-699 --pr 42

# Override judge model
npx tsx tools/eval-workflow.ts --model claude-opus-4-6

# Specify solution model for tracking
npx tsx tools/eval-workflow.ts --issue HOK-699 --pr 42 --solution-model codex-1
```

## How It Works

### 1) Context Resolution

The tool resolves workflow context in priority order:
1. **Explicit arguments** (`--issue`, `--pr`) if provided
2. **Workflow state file** (`.wavemill/workflow-state.json`) for most recent task with PR
3. **Current branch PR** using `gh pr view`

It then fetches:
- Linear issue details (identifier, title, description)
- PR diff via a local `git diff` against the PR head (which honours `.gitattributes -diff`, so generated files arrive as git's binary line), falling back to `gh pr diff` only when the local objects cannot be fetched
- Review comments from GitHub API

### 2) Intervention Detection

The tool analyzes git history, GitHub activity, Claude transcripts, and Wavemill artifacts to detect intervention events:

| Intervention Type | Detection Method | Severity |
|------------------|------------------|----------|
| `review_comment` | PR review activity | Low |
| `post_pr_commit` | Commits after PR creation | Medium |
| `manual_edit` | Commit not attributed to the agent | Medium |
| `test_fix` | Test-fix commit message patterns | Low |
| `session_redirect` | Claude session transcript user redirections | Medium |
| `self_review_warning` | Self-review warning findings | Low |
| `self_review_blocker` | Self-review blocker findings | High |
| `operator_recovery` | `features/<slug>/.operator-intervention.json` or eval archive | High |
| `prior_failed_attempt` | Stage-result `history[]` or failed-attempt sidecars | Medium |

Each intervention has a weighted penalty (configured in `.wavemill-config.json`).
New operator recovery keys are `eval.interventionPenalties.operatorRecovery` and `eval.interventionPenalties.priorFailedAttempt`.

### 3) Difficulty Analysis

PR difficulty is assessed across multiple dimensions:

**Stratum classification:**
- **Trivial** — < 50 LOC, 1-2 files, config/docs only
- **Simple** — < 200 LOC, 3-5 files, single-layer changes
- **Moderate** — < 500 LOC, 6-10 files, cross-layer changes
- **Complex** — 500+ LOC, 10+ files, architectural changes

**Signals analyzed:**
- Lines of code touched
- Number of files modified
- Cyclomatic complexity delta
- Architectural layer changes (UI, API, data)
- Test coverage changes

### 4) Outcome Collection

The tool gathers measurable outcomes:

**CI/CD:**
- All checks passed/failed
- Check names and conclusions

**Tests:**
- Tests added (yes/no)
- Pass rate if tests exist
- Coverage delta

**Static Analysis:**
- Typecheck pass/fail
- Lint error delta
- Security warnings

**Review:**
- Approvals count
- Change requests count
- Review rounds
- Human review required (yes/no)

**Rework:**
- Agent iterations
- Self-review cycles
- Tool failures

**Delivery:**
- PR created (yes/no)
- Merged (yes/no)
- Time to merge

### 5) LLM Judge Invocation

Context is sent to the LLM judge (default: `claude-sonnet-5`):

**Judge inputs:**
- Task prompt (issue description)
- PR review output (diff + comments)
- Intervention summary with weighted penalties
- Outcome metrics

**Judge outputs:**
- Score (0.0 - 1.0)
- Score band (Excellent / Good / Acceptable / Poor / Failed)
- Rationale (why this score)
- Intervention flags (additional issues detected)

If a PR number is present but the PR diff cannot be retrieved, Wavemill does not invoke the judge. It emits an unscored fast-fail eval record with `failureReason: "pr_diff_unavailable"`, `score: 0`, `scoreBand: "Failure"`, and `trainingEligible: false`. Challenge comparisons also refuse to judge a pair when either side has an unavailable diff or an unscored eval; they persist `comparisonOutcome: "inconclusive"` with `noComparisonReason: "diff_unavailable"` or `"eval_unscored"`.

The PR diff read has a 64 MiB stdout bound. Override it with `WAVEMILL_PR_DIFF_MAX_BYTES` when operating on unusually large repositories; it bounds the read, not the prompt.

The diff then enters the judge prompt through the shared change-input builder (`shared/lib/review-input-budget.ts`), sized to the judge adapter's context window: source and tests stay verbatim, and docs/data/generated files that do not fit are summarised. Each eval logs one `[eval] change_input {"files":…,"summarised":…,"withinBudget":…,"promptTokens":…,"maxTokens":…}` line. If source and tests alone cannot fit, the eval is refused with the adapter's typed `context-window-exceeded` — a terminal failure, never an identical retry.

### 6) Scoring Formula

```
base_score = judge_raw_score
intervention_penalty = sum(intervention_weights)
final_score = max(0.0, base_score - intervention_penalty)
```

### 7) Persistence

Eval records are appended to `.wavemill/eval-records.jsonl` with:
- Timestamp
- Issue ID and PR URL
- Score and band
- Agent type and model
- Intervention count and details
- Outcome metrics
- Difficulty signals
- Task and repo context

## Evaluation Criteria

The LLM judge focuses on **major issues only** — not style or subjective preferences.

### Core Quality Dimensions

| Dimension | Examples |
|-----------|----------|
| **Correctness** | Logic errors, off-by-one bugs, null handling, race conditions |
| **Security** | SQL injection, XSS, exposed secrets, missing auth checks |
| **Requirements** | Missing planned features, wrong approach, scope creep |
| **Error Handling** | Unhandled network failures, missing validation at boundaries |
| **Architecture** | Pattern violations, wrong abstraction layer, breaking changes |
| **Testing** | Missing tests, inadequate coverage, brittle test design |

### Intervention Impact

Interventions reduce the score based on severity:
- **High severity** (manual fixes, force pushes) — 0.2-0.3 penalty each
- **Medium severity** (review comments, CI failures) — 0.1-0.15 penalty each
- **Low severity** (tool failures, retries) — 0.05 penalty each

### Score Bands

| Score | Band | Description |
|-------|------|-------------|
| 0.9 - 1.0 | **Excellent** | Production-ready, minimal review needed |
| 0.7 - 0.89 | **Good** | Solid work, minor improvements possible |
| 0.5 - 0.69 | **Acceptable** | Functional but needs polish |
| 0.3 - 0.49 | **Poor** | Significant issues, major rework needed |
| 0.0 - 0.29 | **Failed** | Does not meet basic requirements |

## Output Format

### Terminal Output (Human-Readable)

```
═══════════════════════════════════════════════════════════════
  WORKFLOW EVALUATION
═══════════════════════════════════════════════════════════════

  Issue:  HOK-699
  PR:     https://github.com/org/repo/pull/42
  Agent:  claude
  Model:  claude-sonnet-5
  Time:   127s

  Score:  0.82  ████████░░  Good
          Solid work, minor improvements possible

  Rationale:
  Implementation correctly handles the requirements with proper
  error handling and test coverage. One minor issue with edge
  case handling in the validation logic.

  Interventions: 1
    [MED] review_comment @ 14:23:45
      Manual review comment about error message clarity

  Outcomes:
    Success:   ✓
    CI:        passed (3 checks)
    Tests:     added (95% pass)
    Review:    1 approvals, 0 change requests, 1 rounds
    Rework:    2 iterations
    Delivery:  merged (4h)

═══════════════════════════════════════════════════════════════
```

### JSON Output (Machine-Readable)

When piped to a file or non-TTY, outputs complete JSON record:

```json
{
  "timestamp": "2026-02-27T21:45:00Z",
  "issueId": "HOK-699",
  "prUrl": "https://github.com/org/repo/pull/42",
  "score": 0.82,
  "scoreBand": "Good",
  "rationale": "...",
  "interventionRequired": true,
  "interventionCount": 1,
  "interventions": [...],
  "outcomes": {...},
  "difficultyBand": "moderate",
  "taskContext": {...},
  "repoContext": {...},
  "modelId": "claude-sonnet-5",
  "agentType": "claude",
  "timeSeconds": 127
}
```

## Configuration

Eval settings live in `.wavemill-config.json`:

```json
{
  "eval": {
    "judge": {
      "model": "claude-sonnet-5",
      "provider": "claude-cli"
    },
    "interventions": {
      "penalties": {
        "manual_commit": 0.25,
        "review_comment": 0.10,
        "force_push": 0.30,
        "ci_failure": 0.15,
        "tool_failure": 0.05,
        "branch_reset": 0.30
      }
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `eval.judge.model` | `claude-sonnet-5` | LLM model for evaluation |
| `eval.judge.provider` | `claude-cli` | Provider (`claude-cli` or `anthropic`) |
| `eval.interventions.penalties.*` | See above | Penalty weights per intervention type |

## Command-Line Options

```bash
npx tsx tools/eval-workflow.ts [options]

Options:
  --issue ID              Linear issue identifier (e.g., HOK-123)
  --pr NUMBER             GitHub PR number
  --model ID              Override eval model
  --solution-model ID     Model that produced the solution (for tracking)
  --agent TYPE            Agent type: claude or codex (default: claude)
  --repo-dir DIR          Repository directory (default: current)
  --routing-decision JSON Routing decision metadata (JSON string)
  --help, -h              Show help message
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Evaluation completed successfully |
| `1` | Error occurred during evaluation |

## Key Files

| File | Purpose |
|------|---------|
| `tools/eval-workflow.ts` | CLI tool — orchestrates evaluation workflow |
| `shared/lib/eval.js` | Core judge invocation logic |
| `shared/lib/eval-schema.ts` | Score bands, validation schemas |
| `shared/lib/intervention-detector.ts` | Detects and weights intervention events |
| `shared/lib/difficulty-analyzer.ts` | Analyzes PR complexity and difficulty |
| `shared/lib/outcome-collectors.ts` | Collects CI, test, review, delivery metrics |
| `.wavemill/eval-records.jsonl` | Persisted evaluation records |
| `.wavemill-config.json` | Evaluation configuration and penalties |

## Multi-Repo Aggregation

## Challenge current-head evidence

Challenge comparisons and append-only recovery select an eval only when its
`challengePairId`, `challengeSide`, canonical PR identity, and
`evaluatedPrHeadSha` exactly match the arm's current GitHub PR head. When a
head is re-evaluated, the newest timestamp wins; equal timestamps use a stable
eval-ID tie-breaker. The resulting comparison provenance records both selected
eval IDs and evaluated head SHAs.

Historical JSONL rows are never rewritten. A legacy row can be used only when
its immutable `verificationTelemetry.checked_shas.head` proves the evaluated
head. Rows without either head field are provisional evidence and recovery or
comparison refuses them rather than treating today’s PR head as historical
fact. Refusals expose pair, arm, current head, candidate eval IDs/heads, and a
stable reason without logging prompts or diffs.

### Overview
Combine eval records from multiple repositories into a single JSONL file for cross-repo analysis and ML training using `wavemill eval aggregate`.

### Quick Start
```bash
# Auto-discover all wavemill repos in /path/to/repos
npx tsx tools/aggregate-evals.ts --discover /path/to/repos

# Aggregate specific repos
npx tsx tools/aggregate-evals.ts --repos ~/proj1 ~/proj2 ~/proj3

# Use configured repos from .wavemill-config.json
npx tsx tools/aggregate-evals.ts
```

### Features
- **Auto-Discovery**: Recursively finds all `.wavemill/evals/evals.jsonl` files
- **Hash-Based Deduplication**: Removes duplicate evaluations (same issue + PR + model)
- **Cost Aggregation**: Summarizes workflow costs across all repos
- **Sorting**: Orders records by timestamp for reproducibility
- **Flexible Output**: JSONL format, one record per line

### Configuration
Add to `.wavemill-config.json`:
```json
{
  "eval": {
    "aggregation": {
      "repos": ["/path/to/repo1", "/path/to/repo2"],
      "outputPath": ".wavemill/evals/aggregated-evals.jsonl"
    }
  }
}
```

### Use Cases
1. **Cross-Repo Metrics** — Analyze success rates, score distributions across multiple projects
2. **Cost Attribution** — Track total spend by project, model, and time period
3. **ML Training** — Aggregated data for DSPy evaluation model training
4. **Quality Trends** — Identify patterns in task difficulty and agent performance

See [eval-aggregate](../commands/eval-aggregate.md) for detailed documentation.

## See Also

- [Mill Mode](mill-mode.md) — autonomous parallel backlog processing (includes eval in post-completion hooks)
- [Review Mode](review-mode.md) — LLM-powered code review (runs before eval)
- [Feature Workflow](feature-workflow.md) — guided single-issue execution
- [Expand Mode](expand-mode.md) — batch expand issues into task packets
- [Eval Aggregation](../commands/eval-aggregate.md) — multi-repo eval log aggregation
- [Troubleshooting](troubleshooting.md) — common issues and fixes
