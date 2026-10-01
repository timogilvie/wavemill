# Task Dependency Queue Plan

This document closes out the dependency-aware task queue rollout by mapping the full operator-visible workflow to the implemented source, tests, and fallback behavior.

## Overview

The dependency-aware queue lets mill analyze task relationships before launch, start the first available wave immediately, hold blocked children in queue state, and release those children from the parent PR branch once the parent opens a PR. The same rollout also includes PR metadata propagation, cache reuse, partial refresh, and explicit fallback when dependency-aware planning is disabled or unavailable.

## Stage Coverage

### Stage 1: Read-only dependency analysis `[COMPLETE]`

- Purpose: derive dependency edges and blocked/available task groups without mutating runtime queue state.
- Source: `shared/lib/task-dependency-planner.ts`, `shared/lib/dependency-classifier.ts`
- Coverage: `shared/lib/task-dependency-planner.test.ts`, `shared/lib/dependency-classifier.test.ts`, `tests/fixtures/lifecycle/tend_blocked_by_dependency.sh`

### Stage 2: Dependency-aware backlog selection `[COMPLETE]`

- Purpose: startup planning emits `queuePlan` metadata that separates immediately launchable work from queued children.
- Source: `shared/lib/wavemill-startup-runner.sh`
- Coverage: `tests/wavemill-launch-plan-queue-metadata.test.sh`, `tests/fixtures/startup/startup_queue_plan_metadata.sh`, `tests/fixtures/startup/launch-plan-with-queue.json`, `tests/fixtures/startup/launch-plan-no-queue.json`

### Stage 3: First-wave parallel launch `[COMPLETE]`

- Purpose: mill launches only `queuePlan.availableNow` tasks in the initial worker wave and persists blocked children into queue state.
- Source: `shared/lib/wavemill-startup-runner.sh`
- Coverage: `tests/wavemill-queued-tasks-state.test.sh`, `tests/lifecycle-harness.test.sh`

### Stage 4: Queued child launch from parent PR branches `[COMPLETE]`

- Purpose: when a parent task opens a PR, the monitor dispatches queued children from the parent PR head branch instead of the global base branch.
- Source: `shared/lib/wavemill-mill.sh` via `dispatch_queued_children_for_parent` and `monitor_issue_state`
- Coverage: `tests/wavemill-dependent-launch.test.sh`, `tests/fixtures/lifecycle/parent_pr_triggers_child_launch.sh`, `tests/fixtures/lifecycle/dep_queue_monitor_dispatches_child_on_parent_pr.sh`

### Stage 5: PR dependency metadata propagation `[COMPLETE]`

- Purpose: child PRs receive an injected `depends_on:` block recording the parent issue, branch, PR number, and URL.
- Source: `shared/lib/wavemill-mill.sh` via `inject_depends_on_pr_block`
- Coverage: `tests/wavemill-dependent-launch.test.sh`, `tests/fixtures/lifecycle/parent_pr_triggers_child_launch.sh`

### Stage 6: Cache reuse `[COMPLETE]`

- Purpose: reuse previously computed dependency plans when the backlog input is unchanged.
- Source: `shared/lib/task-dependency-plan-cache.ts`
- Coverage: `shared/lib/task-dependency-plan-cache.test.ts`

### Stage 7: Partial cache refresh `[COMPLETE]`

- Purpose: merge incremental backlog updates into the cached dependency graph instead of recomputing the entire plan on every refresh.
- Source: `shared/lib/task-dependency-plan-cache.ts`
- Coverage: `shared/lib/task-dependency-plan-cache.test.ts`, `shared/lib/queue-partial-refresh.test.ts`

### Stage 8: Fallback behavior `[COMPLETE]`

- Purpose: when dependency-aware planning is disabled, missing, or partially unavailable, mill keeps operating in non-dependency-aware mode without silently misrouting queued children.
- Source: `shared/lib/wavemill-startup-runner.sh`, `shared/lib/wavemill-mill.sh`
- Coverage: `tests/fixtures/startup/startup_falls_back_when_field_missing.sh`, `tests/fixtures/lifecycle/parent_branch_missing_fails_clearly.sh`, `tests/fixtures/lifecycle/dep_queue_queued_task_skipped_when_parent_active.sh`

### Stage 9: Grounded wave planning `[OPT-IN]` (HOK-3131)

- Purpose: stop putting tasks that edit the same code in one wave. Each task's *touch set* (files it will modify) is predicted from the repo — explicit paths, `git`-resolved filenames and identifiers, and a batched LLM prediction only for vague tasks. Pairs are scored deterministically (file / hot-file / region overlap, co-change history, `n/m` series, cross-references, sweeps), and only scored pairs go to an evidence-required LLM ordering judge (`must_precede | should_precede | conflict | independent`). Ordering verdicts become `depends_on` edges, conflicts become `shared_surface` edges, and the rest of this pipeline is unchanged.
- Enable: `"queuePlanner": { "mode": "grounded" }` in `.wavemill-config.json` (default `legacy`). Rollback: remove the block or set `legacy`.
- Source: `shared/lib/touch-set-predictor.ts`, `shared/lib/conflict-scorer.ts`, `shared/lib/grounded-planner.ts`, `tools/prompts/grounded-queue-ordering.md`, `tools/prompts/touch-set-prediction.md`; wired in `tools/plan-queue.ts`.
- Cache: `touchSets` and `groundedVerdicts` blocks in the task-dependency cache, keyed by task fingerprint (touch sets also expire after 7 days). Grounded runs do not advance legacy `fingerprints`, so switching back to `legacy` re-classifies every task.
- Failure policy: never fails the plan. A failed or malformed judge answer leaves unjudged pairs `independent`, is not cached, and is reported as an inference failure (with the usual cooldown); during cooldown only cached verdicts are used.
- Latency: the judge is one batched `classify` call (≤40 pairs) with `--tools ''`; warm runs (cached touch sets and verdicts) make no LLM call. A cold judge call can exceed the monitor's 25 s per-attempt budget — unjudged pairs are `independent` for that poll (explicit and cached edges still apply), enters the inference cooldown, and retries; verdicts are cached once a call succeeds.
- Preview: `npx tsx tools/plan-queue.ts --project "<name>" --preview` adds **Grounded Waves** and **Grounded Deferrals** (why each task waits) sections.
- Backtest: `npx tsx tools/backtest-planner.ts` replays recent merged PRs and writes [backtest-grounded-planner.md](backtest-grounded-planner.md).
- Coverage: `shared/lib/touch-set-predictor.test.ts`, `shared/lib/conflict-scorer.test.ts`, `shared/lib/grounded-planner.test.ts`, `shared/lib/planner-backtest.test.ts`, `tools/plan-queue.test.ts`

## End-to-End Flow

1. Startup analyzes the backlog and computes a dependency plan.
2. The launch plan records `availableNow` tasks plus `queued_tasks` metadata for blocked children.
3. Mill launches the first wave immediately and persists queued children in `.wavemill/workflow-state.json`.
4. When a parent task opens a PR, the monitor resolves the parent PR branch and dispatches queued children from that branch.
5. Mill stores `dependsOnPr` metadata in state and injects the same dependency block into the child PR body.
6. Subsequent startup passes reuse the dependency-plan cache when inputs are unchanged.
7. Partial backlog changes refresh only the affected cache segments.
8. If dependency-aware planning cannot proceed, mill falls back to standard launch behavior while leaving blocked children explicitly queued or explicitly waiting.

## Operator Notes

- Queue state lives in `.wavemill/workflow-state.json` under `queued_tasks`.
- A queued child with `blocker_pr_number: null` is still waiting for the parent PR to exist.
- A queued child with `waiting_reason: parent_pr_branch_unresolvable:...` was intentionally not launched because mill could not safely resolve the parent PR branch.
- For operating guidance and stall diagnosis, see [Mill Mode](mill-mode.md).
