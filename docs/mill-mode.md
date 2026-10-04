---
title: Mill Mode
---

`wavemill mill` is the default way to run Wavemill. It is the factory loop: backlog in, routed agent work out, with evaluation data feeding the next round of model selection.

## What It Does

- Fetches and ranks backlog tasks from Linear.
- Expands issues that are missing implementation detail into task packets.
- Assesses each task and chooses the best planner, coder, and reviewer models.
- Launches parallel worktrees/agents via `tmux`.
- Monitors PR, ready-stage, and merge status.
- Cleans up completed tasks and updates issue state.
- Auto-updates project context after each PR merge with a summary of changes.
- Writes eval data that improves future routing decisions.

## Run It

```bash
cd <your-project>
wavemill mill
```

Common overrides:

```bash
MAX_PARALLEL=5 wavemill mill
AGENT_CMD=codex wavemill mill
SESSION=custom-session wavemill mill
WAVEMILL_DASHBOARD_REFRESH_SECONDS=3 wavemill mill
WAVEMILL_TIP_REFRESH_SECONDS=60 wavemill mill
```

Dry-run launch-plan validation:

```bash
wavemill mill \
  --dry-run \
  --dry-run-backlog ./backlog.json \
  --dry-run-plan-out ./launch-plan.json
```

This mode reuses the real startup planning pipeline, writes the generated launch plan to the requested path, and exits before creating tmux sessions, launching agents, opening PRs, or updating Linear. It is intended for fixture-backed validation, so supply backlog JSON explicitly with `--dry-run-backlog`.

## Model Overrides

`wavemill mill` accepts stage model overrides on the CLI:

```bash
wavemill mill --model opus
wavemill mill --planner-model sonnet --coder-model inherit --reviewer-model claude-haiku-4-5-20251001
```

Accepted selector forms are:

- family aliases such as `opus`, `sonnet`, and `haiku`
- `inherit`
- pinned model IDs such as `claude-opus-4-8`

`--model` applies the same selector to planning, coding, and review. Use the per-stage flags when you only want to override one stage.

`WAVEMILL_DASHBOARD_REFRESH_SECONDS` accepts integer values from `1` through `10`. Invalid values fall back to the default `2` second dashboard refresh cadence.
`WAVEMILL_TIP_REFRESH_SECONDS` accepts integer values from `1` through `3600`. Invalid values fall back to the default `60` second tip refresh cadence. This only controls the usage tip rotation and does not change any other dashboard refresh behavior.
`WAVEMILL_GIT_REMOTE_TIMEOUT_SECONDS` accepts integer values from `1` through `600`. Invalid values fall back to `15`. When a remote `git fetch` or `git ls-remote` probe times out or fails, mill logs the repo/worktree, ref, timeout, and exit code, then continues the monitor tick in degraded mode instead of blocking planning/coding handoffs.

## Startup Progress Table

During task launch, `wavemill mill` shows a live startup table on stderr:

```text
issue | route | worktree | deps | agent | linear
```

Each row is a task. The columns track routing handoff, worktree creation, dependency installation, agent launch, and the Linear state update. Cells move through `.`, `…`, `✓`, `✗`, and `-` for pending, running, done, failed, and skipped.

When a JS lockfile exists and a fresh worktree has no `node_modules`, startup now attempts a safe dependency fast path before install:

- It compares parent checkout and worktree metadata (lockfile hash, `packageManager`, Node signature, workspace signature).
- If compatible, it reuses parent dependencies (`deps: reused (cow)` or `deps: reused (symlink)`).
- If incompatible or unsafe, it logs the fallback reason and runs the normal install (`installing deps: <reason>`).
- `WAVEMILL_WORKTREE_DEPS_FAST_PATH=0` disables reuse checks and always uses the legacy install path.
- Non-JS repos and missing package-manager binary behavior are unchanged (still skip dependency install).

Startup launches tasks concurrently by phase. The default startup worker limit is `4`; override it with:

```bash
WAVEMILL_STARTUP_CONCURRENCY=8 wavemill mill
```

Values are clamped to `1` through `16`. Use `wavemill mill --no-progress` to force the legacy `[N/M] launching ...` status lines. The table is also disabled automatically when stderr is not a TTY, such as in CI logs or redirected output.

## Why Mill Mode Is The Core Workflow

Mill mode combines the pieces that make Wavemill useful as a software factory:

- backlog intake
- task expansion
- model routing
- parallel execution
- review and readiness gates
- eval-driven learning

If you only document one command first, document `mill`.

## Safety Defaults

- conflict checks for overlapping areas/components
- migration conflict avoidance
- review-to-ready-to-merge gating before marking tasks done
- persistent workflow state in `.wavemill/workflow-state.json`

## Tmux Session Names

By default, mill derives a repo-scoped tmux session name in the form `wavemill-<repo-slug>-<hash>`. The slug comes from the repository root basename and the hash makes same-named repos under different parent directories resolve to different sessions.

Use `tmux list-sessions` to discover the active name after launch, then attach with:

```bash
tmux attach -t <session-name>
```

If you want a fixed shared name, set an explicit override with `SESSION=custom-session wavemill mill` or `mill.session` in `.wavemill-config.json`. Existing old tmux sessions are not renamed automatically.

When operating mode drops to `constrained` or `survival`, mill-mode review switches to a scoped checklist: syntax/type failures, contract violations, obvious regressions, and test-coverage gaps. In that mode the review tool may emit `needs_stronger_reviewer`, which the review phase should surface on the PR title/body/labels for human follow-up.

## Ready Phase

By default, `wavemill mill` inserts a merge-readiness phase after PR creation and before merge completion:

```text
review -> ready -> merge
```

In that phase, the monitor is responsible for:

- running the same shared contract exposed by `wavemill ready <pr>`
- recording whether the PR is ready, blocked, or warning-only
- holding merge completion until required ready checks pass
- surfacing manual release steps and merge-conflict remediation needs
- detecting stale ready-stage local state with the ready watchdog

Ready tasks now also move through a small merge-lane queue once many PRs reach ready together:

- `ready`: the PR passed ready checks against its recorded base and is not known stale.
- `ready-stale`: the PR passed before, but the base branch advanced. Mill records the staleness cheaply and does not immediately launch remediation.
- `merge-candidate`: the PR has been promoted into the bounded merge lane and is allowed to refresh against the latest base, remediate conflicts, and attempt merge readiness again.

When the base branch advances after one merge, mill marks the other completed ready tasks as `ready-stale` first. It only promotes a bounded candidate set back into active refresh, which prevents every ready PR from independently rerunning conflict remediation and ready checks on the same tick. Stuck candidates are demoted back to `ready-stale` so unrelated work can continue.

The ready watchdog runs once per monitor tick for `phase=ready` tasks. After `ready.watchdog.thresholdMinutes` of no local progress, it compares controller state with GitHub truth and classifies the task as one of:

- `auto update`
- `stuck`
- `waiting on CI`
- `waiting on eval/comparison`
- `needs user`

When GitHub says the PR is `MERGEABLE` but `BEHIND`, the watchdog treats that as a mechanically recoverable branch-update path. It fetches the latest base, merges it into the PR branch, pushes the branch, and then resets the controller-owned ready result back to a pending rerun. If the auto-update conflicts, the push fails repeatedly, or the local worktree is not safe to mutate, the watchdog escalates to `needs user` with the real failure detail.

When GitHub says the PR is open, mergeable, and green, the watchdog still performs local recovery for stale controller state. That path is limited to clearing stale local ready markers and resetting the ready result. During the later merge-lane step, tend skips its pre-merge rebase when `origin/auto/integration` is already an ancestor of the PR head; otherwise it performs the rebase before merging. If auto-recovery is disabled or unsafe, the watchdog prints an explicit `tools/ready-watchdog.ts --recover <ISSUE>` command instead.

Configuration lives under `ready.watchdog`:

```json
{
  "ready": {
    "watchdog": {
      "enabled": true,
      "thresholdMinutes": 10,
      "autoRecover": true,
      "timeoutSeconds": 30
    }
  }
}
```

`monitor.readyWatchdog` is also accepted as a backwards-compatible alias, but `ready.watchdog` is canonical.

Runtime artifacts:

- `.wavemill/ready-watchdog-state.json`: retained last actionable per-issue finding for the dashboard and dedupe state
- `.wavemill/ready-watchdog.jsonl`: append-only audit trail of stale-task detections and recovery decisions

For operator details, see [Ready Stage](ready-stage.md).

## Operator Controls

- `Ctrl+B D` detach from `tmux`
- `touch ~/.wavemill/.stop-loop` stop after current cycle

### Recording an Operator Intervention

When an operator recovers a failed attempt without committing a fix, record the recovery so evals do not score the next attempt as a clean first pass:

```bash
wavemill intervention record <target> --stage coding --attempt 1 --severity major --trigger <tag> --summary "<what happened>" --archive-failed-result
wavemill intervention show <target>
```

The command writes `features/<slug>/.operator-intervention.json`. Mill archives that artifact and stage-result failed-attempt sidecars before cleanup so post-merge evals can see them.
- `Ctrl+C` interrupt and reset in-progress tasks

### Project Context Size Warning

When `.wavemill/project-context.md` exceeds `100KB`, `wavemill mill` displays:

```text
⚠ project-context.md is 142KB (>100KB) - press 'c' to compact
```

To compact:

```bash
wavemill context compact
# or
npx tsx tools/compact-project-context.ts
```

This archives the original to `.wavemill/project-context-archive-YYYYMM.md` and rebuilds the file with only the most recent `25` `Recent Work` entries.

Configuration (`.wavemill-config.json`):

```json
{
  "projectContext": {
    "compactionThresholdKb": 100,
    "recentWorkKeep": 25
  }
}
```

## Control Layout And Input

- Mill keeps the same three visible control panes:
- `mill.0` monitor + command input (`1 3`, `advance HOK-1639`, `m`, `d`, `q`)
- `mill.1` dashboard
- `mill.2` status log
- When `observer.enabled` is true and integration mill-session monitoring is active, the Backstage window also includes a dedicated `Wavemill Observer` pane running `wavemill observer --loop`. The legacy `--file-linear` finding path is always rejected here; managed incident-to-Linear filing is gated by a fail-closed service mode (`off`/`shadow`/`live`) resolved from `observer.linear`, and defaults to `off`. Startup and the watchdog restart use the same resolver and command builder, so a restarted pane cannot preserve stale arguments or silently escalate to `live`. The generic `--dry-run` flag is not the incident-sync safety control. See `docs/cli-reference.md` → **Managed Backstage filing (HOK-3036)**.
- On startup and watchdog passes, the Backstage window is reconciled by pane title: tend, jobs, queue, and Observer each keep one pane; duplicate panes are killed; dead panes are respawned in place. `backstage-health.json` records `services.<name>.instanceCount` so a green service status still shows unexpected duplicates.
- Input is decoupled from the monitor loop internally and written as session-scoped command events at `/tmp/wavemill-${SESSION}-commands`.
- Seam artifact formats and validation timing are documented in [Seam Artifacts](seam-artifacts.md).
- When coding writes a valid `features/<slug>/.coding-blocked-completion.json` that recommends review advancement and passes mill guardrails, mill auto-advances the task to review and records `features/<slug>/.coding-auto-advance.json`.
- When a Codex coding pane is idle at the exact terminal capacity prompt for the confirmation dwell, mill writes `features/<slug>/.coding-blocked-completion.json` plus `features/<slug>/.coding-capacity-recovery.json`, keeps the task in coding, and marks it `needs-user` instead of waiting forever for `.coding-complete`.
- The auto-advance dirty-worktree guardrail ignores controller-owned metadata noise including `.wavemill/*`, `features/<slug>/.*`, `features/<slug>/plan.md`, `features/<slug>/task-packet*.md`, `features/<slug>/selected-task.json`, and the root `prompt-registry.jsonl`.
- Root `prompt-registry.jsonl` is intentionally treated as Wavemill-owned generated metadata for this guardrail only. Unknown source changes and unknown non-dotfiles under `features/<slug>/` still block auto-advance and require user review or manual `advance <issue-id>`.
- `advance <issue-id>` remains the manual fallback for tracked coding tasks with a valid blocked-completion artifact. It writes `features/<slug>/.coding-advance-override.json` and a JSON `features/<slug>/.coding-complete` with `confidence: medium` so review launches on the next monitor tick.
- `WAVEMILL_CAPACITY_STALL_SECONDS` controls the confirmation dwell before mill classifies the Codex capacity prompt as terminal. Default: `45`. Values are clamped below the 300 second hook TTL.

## When to Prefer Mill Mode

Use mill mode when your backlog has many independent tasks and your team is comfortable reviewing multiple agent-generated PRs in parallel.

## Branch Topology (Integration Mode)

Integration mode is opt-in through `.wavemill-config.json` with `integration.enabled: true`. The default is `false`, so existing repositories keep the current direct-to-`main` workflow until you enable the new branch policy.

Recommended branch flow:

- `task/*` branches merge into `auto/integration`
- `auto/integration` is validated as the shared staging branch
- `auto/integration` promotes into `main`

For setup, the minimal config, and the complete configuration reference, see [Autonomous Integration](autonomous-integration.md). The rest of this section describes how the autonomous path interacts with mill's existing pipeline once enabled.

### Autonomous Integration Mode

When `integration.enabled = true`, task PRs stop targeting `main` directly. The autonomous path becomes:

```text
task/* -> auto/integration -> main
```

Recommended operator setting:

- Set `mill.baseBranch = "auto/integration"` so new task worktrees start from the same branch that autonomous merges are landing on.
- If you leave `mill.baseBranch` on `main`, coding still works, but each PR is effectively rebased against `auto/integration` later by `tend`, which increases churn and conflict risk.

The four pipeline stages are:

- `mill`: selects work, creates worktrees, and opens Wavemill PRs against `auto/integration`.
- `ready`: evaluates policy eligibility for autonomous merge, including metadata, dependency, migration, risk, and challenge guards.
- `tend`: runs the integration queue, rebases the selected PR onto `auto/integration`, waits for PR checks, reruns ready-policy enforcement, and merges one candidate at a time.
- `promote`: opens or refreshes the `auto/integration -> main` promotion PR and reports whether that release PR is green.

When `integration.enabled` and `integration.useMillSession` are both `true`, mill starts a dedicated `backstage` tmux window inside the existing mill session and runs the tend loop there with the normal session lifecycle. For tests and manual debugging, `wavemill tend --once --repo-dir <repo>` still runs a single pass without starting mill mode.

The backstage tend loop is resilient to transient GitHub/network failures: it retries `gh` calls, backs off failed loop iterations while publishing `failureCount`/`lastError`, and the mill watchdog keeps restarting a dead tend loop on a 60s-to-15m backoff even after showing `needs-user`.

The Observer loop holds `.wavemill/locks/observer-<repo>-<session>.lock` and exits immediately if another live Observer loop already owns that repo/session lock. This covers manual launches outside tmux; if a manual holder blocks the Backstage pane from staying alive, the watchdog will escalate through its normal missing-service path and the Observer duplicate detector reports the competing loop.

### Dependent Task Auto-Dispatch

When the monitor loop detects that a parent task has opened a PR, mill automatically re-checks queued children whose `depends_on` edge targets that parent issue.

- Trigger: PR creation detection in the monitor loop, including resumed review transitions.
- Base branch: the child worktree branches from the parent PR head ref, not from `main` or the global `mill.baseBranch`.
- PR metadata: the child PR body is updated with a prepended `depends_on:` block that records the parent PR number, issue, branch, and URL.
- Failure mode: if mill cannot resolve the parent PR branch, the child remains queued and gets `waiting_reason: parent_pr_branch_unresolvable: <detail>`. Mill does not silently fall back to `main`.

## Dependency-Aware Task Queue

The dependency-aware queue extends startup planning and monitor dispatch into an eight-stage flow that keeps blocked work visible without launching it too early.

In the grouped backlog pane, mill shows queued dependency items by default only when they are on-deck: either immediately unblocked by an active task or unblockable by an item currently in the backlog. Press `d` to expand suppressed dependency rows or collapse them again.

| Stage | What happens | Source files | Observable signals |
| --- | --- | --- | --- |
| 1. Analysis | Backlog dependencies are classified in read-only mode. | `shared/lib/task-dependency-planner.ts`, `shared/lib/dependency-classifier.ts` | Dependency-plan logs and planner/cache tests pass. |
| 2. Selection | Startup emits `queuePlan` metadata with `availableNow` and queued children. | `shared/lib/wavemill-startup-runner.sh` | Dry-run launch plan contains queue metadata. |
| 3. First wave | Mill launches only the first available dependency-safe wave. | `shared/lib/wavemill-startup-runner.sh` | `.wavemill/workflow-state.json` gains `queued_tasks`. |
| 4. Parent PR dispatch | Monitor detects a parent PR and dispatches queued children from the parent PR branch. | `shared/lib/wavemill-mill.sh` | Status log shows child launch after parent PR detection. |
| 5. PR metadata | Child PR gets a `depends_on:` block for the parent PR. | `shared/lib/wavemill-mill.sh` | Child PR body includes issue, branch, PR number, and URL. |
| 6. Cache reuse | Existing dependency plans are reused when backlog inputs match. | `shared/lib/task-dependency-plan-cache.ts` | Cache-hit logs avoid rebuilding the full plan. |
| 7. Partial refresh | Only changed backlog edges are recomputed and merged into cache. | `shared/lib/task-dependency-plan-cache.ts` | Partial refresh tests update only changed nodes. |
| 8. Fallback | Mill falls back safely when dep-queue data is missing or unusable. | `shared/lib/wavemill-startup-runner.sh`, `shared/lib/wavemill-mill.sh` | Missing queue metadata downgrades cleanly; unresolved parent branch leaves child queued. |

See [Task Dependency Queue Plan](task-dependency-queue-plan.md) for the implementation map and test references.

### Diagnosing Dep-Queue Stalls

1. Parent branch missing
   Check `.wavemill/workflow-state.json` for `queued_tasks[].waiting_reason` starting with `parent_pr_branch_unresolvable:`. The parent PR may exist without a fetchable head branch, or the branch lookup may be failing. Confirm the parent PR still exists and that its head ref can be resolved locally.
2. Cache corrupt or unreadable
   Look for log lines beginning with `[task-dep-cache] dropping unreadable cache`. Delete `.wavemill/cache/task-dependency-plans/*.json` and rerun mill to force a full dependency-plan rebuild.
3. Child stays queued indefinitely
   Inspect `queued_tasks[].blocker_pr_number`. If it is `null`, the parent PR has not been created yet. If it is set, verify the monitor reached `dispatch_queued_children_for_parent` and that the child was not left behind by a branch-resolution failure.

### Challenge-Mode Interaction

Challenge mode adds a second PR for the same task and records a comparison result under `.wavemill/evals`. During tend selection, `tend-challenge-gate.ts` classifies each pair into these states:

- not in a challenge pair
- unresolved pair with no comparison yet
- unresolvable pair that needs a terminal forfeit record
- winner
- loser

Challenge post-PR evals and PR comparisons now run as monitored background jobs instead of blocking the main monitor loop.

- Job state is persisted under `.wavemill/workflow-state.json` in `jobs`.
- Mill also writes transient `evalRunning` and `comparisonRunning` markers onto the affected task rows before it launches the long-running eval or comparison command.
- The control pane emits explicit `eval running` / `comparison running` status lines and the dashboard shows an elapsed running detail on the task row while that transient state is present.
- Logs and structured result files live under `.wavemill/jobs/<session>/`.
- Failed or timed-out jobs surface compact excerpts in the dashboard so the monitor can keep draining commands and launching other work.

If the pair is unresolved, tend blocks both sides from autonomous merge. If a winner is recorded and challenge auto-merge is enabled, the winner remains eligible, the loser is marked superseded, and tend closes the loser PR with a cleanup comment. If auto-merge is disabled for winners, the winning PR is still held for manual action.

`pair-unresolvable` covers terminal states where a normal comparison will not arrive, including an orphaned sibling, a challenge arm that aborted before opening a PR, or exhausted eval hard-failure retries. The watchdog recovery command `tools/resolve-orphan-challenge-pair.ts` and the mill's automatic resolver write a terminal comparison/forfeit record so the surviving PR can leave the blocked state.

Challenge eval retry budgets are separate: `challenge.eval.retryMaxAttempts` controls soft eval relaunches and defaults to `1`, while `challenge.eval.hardFailureRetryMaxAttempts` controls hard-failure recovery and defaults to `2`. `WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES` overrides the hard-failure config value.

Remote task branches are cleaned up after local post-review cleanup only when GitHub reports the task PR as `MERGED`; merged-ness is not inferred from ancestry because promotion uses squash history. Non-merged, unknown, or missing-PR refs are retained with a logged reason. `tools/cleanup-stale-branches.ts` audits remote `task/*` refs and can delete merged leftovers with `--execute` after a dry run.

## Promotion

Promotion mode reuses the tend controller's branch-health and PR-check helpers to manage the shared `integration -> main` release PR without auto-merging it.

Use either command form:

```bash
wavemill tend promote --repo-dir <repo>
wavemill promote --repo-dir <repo>
```

Behavior:

- opens or updates a PR from `integration.integrationBranch` to `integration.promotionBranch`
- refreshes a managed `Promotion Summary` section in the PR body with recent merged Wavemill PRs and recent integration commits
- reuses the shared check waiter to report whether the promotion PR is passing, pending, or failing
- leaves merge policy separate from task PR merge policy by never calling auto-merge here

### Protected Integration Branches

If `wavemill promote` detects that `main` already contains an earlier squash-merged snapshot of the integration branch, it may need to reconcile branch history before refreshing the promotion PR. Wavemill checks GitHub branch protection before attempting that rewrite and will not open or update a known-conflicted direct `integration -> promotion` PR once that squash-recovery state is detected.

The top-level `promotion` config controls the fallback:

- `protectedIntegrationStrategy: "skip-reconciliation"` is the default. Wavemill leaves the protected integration branch untouched and blocks with explicit remediation instead of opening or updating a known-conflicted direct `integration -> promotion` PR.
- `protectedIntegrationStrategy: "block"` returns a blocked result with manual/admin reconciliation guidance instead of attempting an unsafe rewrite.
- `protectedIntegrationStrategy: "use-promotion-head"` pushes a dedicated unprotected branch such as `auto/promotion` and opens the PR from that branch instead.

Promotion output and the managed PR summary note when squash reconciliation was applied in place, moved to a dedicated promotion head, or blocked by branch protection policy.

If Wavemill cannot verify branch protection status, it blocks rather than risk rewriting the branch blindly.

For the broader controller design, see the [Autonomous Integration Merge Controller Plan](https://linear.app/hokusai/document/autonomous-integration-merge-controller-plan-79e27e27d690).

## Project Context Integration

Mill mode automatically maintains a `.wavemill/project-context.md` file that helps agents learn from previous work.

### Setup

**Option 1: Use `wavemill init` (Recommended)**
```bash
cd ~/your-repo
wavemill init
# Answer 'Y' when prompted to initialize project context
```

**Option 2: Auto-initialization**

When you first run `wavemill mill` or `wavemill expand`, you'll be prompted:
```bash
wavemill mill
# Will prompt: "Initialize project context? [Y/n]"
```

Skip the prompt with: `SKIP_CONTEXT_CHECK=true wavemill mill`

**Option 3: Manual initialization**
```bash
npx tsx tools/init-project-context.ts
```

### How It Works

After initialization, the file is **automatically updated** after each PR merge with:
- What changed in the implementation
- New patterns or conventions established
- Known gotchas or constraints discovered

This ensures that agent #5 knows what agents #1-4 built, leading to more consistent implementations and fewer repeated mistakes.

### Maintenance

- The "Recent Work" section is auto-updated (append-only)
- Other sections (Architecture, Conventions) can be manually edited
- Agents receive this context when expanding Linear issues

### Post-Eval Update Controls

The eval result is persisted before project-context and subsystem maintenance runs. Those follow-up updates are best-effort: failures or timeouts do not make the eval fail.

Detached post-merge eval hooks have a separate wall-clock timeout. The default is 600 seconds:

```json
{
  "eval": {
    "postMergeTimeoutSeconds": 600
  }
}
```

Configure the optional post-eval update phase in `.wavemill-config.json`:

```json
{
  "evalContextUpdates": {
    "enabled": true,
    "timeoutSeconds": 60,
    "maxRetries": 0
  }
}
```

Skip the optional phase entirely with `WAVEMILL_SKIP_POST_EVAL_CONTEXT_UPDATES=1`.

When operating mode is `constrained` or `survival`, wavemill skips these updates automatically to keep mill sessions bounded.

Skipped or failed optional updates are appended to `.wavemill/evals/eval-context-update-warnings.jsonl`.

## Routing And Learning

At startup, `wavemill mill` runs routing for each task so different task types can use different models and execution depths. Routing decisions are based on historical eval records and fallback heuristics.

The loop is:

1. route a task
2. execute it
3. evaluate the result
4. store the outcome
5. improve the next routing decision

Challenge mode can also run head-to-head comparisons to generate stronger routing data over time. For the broader model-selection story and Hokusai opt-in, see [Routing & Hokusai](routing-and-hokusai.md).

When quota pressure changes a routing decision, the control pane replays a single transparency line from the router or fallback path:

```text
11:31:02 [router] constrained mode: claude-opus-4-8 quota is degrading; reserving it for high-complexity steps
11:31:44 [coder] claude-opus-4-8 unavailable (quota); falling back to claude-sonnet-5
```

Healthy runs do not emit extra routing noise.

## Routing Artifact Contract

At startup, `wavemill mill` runs `route-task.ts --json` per task and persists the result
as `/tmp/{SESSION}-{ISSUE}-route.json`. This is the canonical **bootstrap** routing artifact
used during launch before feature-local execution state exists.

After planning expands the task packet, the controller looks for
`features/<slug>/.post-expansion-route.json` first and `features/<slug>/.expanded-route.json`
second. A valid expanded route is promoted into `features/<slug>/.routing-complete`,
`features/<slug>/.phase-config.json`, and `.wavemill/workflow-state.json` before coding
launches. `.initial-route.json` remains the preserved bootstrap snapshot for provenance.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `planner` | string | Model ID for the planning phase |
| `coder` | string | Model ID for the coding phase |
| `reviewer` | string | Model ID for the review phase |
| `planDepth` | `"light"` \| `"deep"` | Planning depth recommendation |
| `codeDepth` | `"light"` \| `"medium"` \| `"deep"` | Coding depth recommendation |
| `reviewRecommended` | `"none"` \| `"static"` \| `"llm"` \| `"static+llm"` | Review mode recommendation (stored as `reviewMode` in state) |
| `routingMode` | string | How the route was determined (e.g. `"stage-aware"`, `"heuristic-fallback"`) |
| `provenance` | object | Input/source metadata for the route artifact |
| `neighborCount` | number | Number of similar eval records used for routing |
| `expectedSuccess` | number | Estimated success probability (0-1) |
| `expectedCost` | number | Estimated total cost in USD |
| `signals` | object | Prompt analysis signals (taskType, riskScore, etc.) |
| `challengeRecommendation` | object? | Optional challenge-mode recommendation |

`provenance` fields:

| Field | Type | Description |
|-------|------|-------------|
| `source` | `"bootstrap"` \| `"expanded"` \| `"startup-cache"` \| `"batch-cache"` \| `"live"` \| `"heuristic-fallback"` | Route origin |
| `inputKind` | `"issue"` \| `"task-packet"` \| `"cache"` \| `"heuristic"` | Type of routed input |
| `inputPath` | string | Input file path when available |
| `inputHash` | string | SHA-256 of exact routed UTF-8 input bytes |
| `routedAt` | string | ISO-8601 UTC timestamp |
| `routerMode` | `"normal"` \| `"constrained"` \| `"survival"` | Operating mode at route time |

`routingMode` and `provenance.routerMode` are different: `routingMode` is route strategy, while `provenance.routerMode` is the quota operating mode.

### Consumers

| Consumer | File | Fields Used |
|----------|------|-------------|
| Phase 5 challenge planning | `wavemill-mill.sh` | coder, planner, reviewer, planDepth, codeDepth, reviewRecommended |
| Orchestrator compatibility wrapper | `wavemill-orchestrator.sh` | planner, coder, reviewer, planDepth, codeDepth, reviewRecommended, routingMode |
| Orchestrator (interactive) | `wavemill-orchestrator.sh` | Full route (runs router inline) |
| Monitor launch_task() | `wavemill-mill.sh` | Full route (re-routes or reads cached) |
| Expanded-route promotion | `wavemill-common.sh::apply_expanded_route_if_present` | coder, codeDepth, reviewer, reviewMode/reviewRecommended plus any optional route metadata |

### Fallback Chain

`read_route_json()` implements: `route.json` (top-level, then `.provenance.<field>`) → `model-suggestion.json` (coder only) → default value.

`model-suggestion.json` is a **deprecated** compatibility shim that only carries the `coder`
model (as `recommendedModel`). It will be removed in a future PR once all consumers have
been confirmed to work with `route.json`.

If the expanded-route artifact is malformed or missing required execution fields, promotion
fails closed with an `expanded route invalid` warning and the existing bootstrap execution
state remains in place.

## Expansion Handshake

Before coding starts, mill now checks for a mandatory expansion handshake:

- Expanded packet input (`task-packet.md` has task-packet markers): pass.
- Raw issue text input: first attempts to recover a missing expanded route artifact automatically.

Default behavior (`policy: "recover"`):

- If the expanded route artifact is missing, mill attempts recovery once by re-expanding the issue into the feature-local task packet, rerouting that packet, and promoting the recovered expanded route before coding starts.
- If that recovery fails, mill records the failed attempt, logs a clear fallback warning, and continues coding with the existing bootstrap route.
- If the artifact exists but is malformed or missing required execution fields, mill still blocks because that indicates corrupted routing state.

If the handshake blocks, transition logs one of:

- `[expansion-handshake] BLOCKED issue=<ISSUE> reason=missing`
- `[expansion-handshake] BLOCKED issue=<ISSUE> reason=invalid-json`
- `[expansion-handshake] BLOCKED issue=<ISSUE> reason=missing-required-field`

Strict and permissive overrides:

```json
{
  "mill": {
    "expansionHandshake": {
      "policy": "block"
    }
  }
}
```

- `policy: "block"` restores the original fail-closed behavior for missing artifacts.
- `policy: "warn"` logs `[expansion-handshake] WARN ...` and proceeds immediately without recovery.

## See Also

- [Routing & Hokusai](routing-and-hokusai.md) — self-improving routing and collective intelligence
- [CLI Reference](cli-reference.md) — all commands and when to use them
- [Plan Mode](plan-mode.md) — decompose epics into mill-ready sub-issues
- [Review Mode](review-mode.md) — LLM-powered code review (runs automatically in each agent's workflow)
- [Ready Stage](ready-stage.md) — merge-readiness checks and operator policy
- [Expand Mode](expand-mode.md) — batch expand issues into task packets
- [Eval Mode](eval-mode.md) — evaluate LLM performance on workflows
- [Troubleshooting](troubleshooting.md) — common issues and fixes
