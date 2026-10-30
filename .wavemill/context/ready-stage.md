# Ready Stage Subsystem

The ready subsystem has two cooperating loops:

- `tools/ready.ts` runs the local readiness checks and writes structured results.
- `tools/ready-watchdog.ts` compares local ready state against GitHub truth during monitor ticks.

## Watchdog Classifications

- `fresh`: local ready state has progressed recently enough.
- `waiting-on-ci`: checks are still pending or failing, but the failure is not yet stable enough to act on.
- `stable-failing-safe`: the same safe-to-remediate CI failure persisted across the configured number of polls. The watchdog emits `queue-remediation`.
- `stuck`: GitHub is clean and green, but the local ready state stopped advancing.
- `auto-update`: the PR is mergeable but behind its base branch.
- `waiting-on-eval-comparison`: background eval/comparison work is still running.
- `needs-user`: ambiguous, unsafe, or exhausted conditions that require operator attention.

## Safety Gate

Watchdog-triggered remediation is default-deny:

- Only failures matching `ready.watchdog.safeRemediationCategories` are considered safe.
- Safe failures must remain unchanged for `stableFailureConsecutivePolls`.
- Unsafe failures escalate only after `stableFailureEscalateAfterPolls`.
- Remediation still runs through `launch_ready_phase`, so existing per-PR launch caps and launch-head deduplication stay in force.

## Merge-Lane Dedupe and Rate-Limiting

Merge-lane watchdog findings (`waiting-on-merge-lane` and stalled `needs-user`) include volatile idle/waited minute counts in their detail text. To prevent repeated log spam when only the minute count changes, the watchdog uses a **stable fingerprint** that strips those tokens (`idle Nm` → `idle Xm`, `waited Nm` → `waited Xm`) before comparing against the last logged entry.

All repeated `reported` findings (same classification, action, and stable fingerprint) are **rate-limited**: subsequent emissions within `WAVEMILL_READY_WATCHDOG_REPORT_INTERVAL_SECONDS` (default: 3600s) are suppressed. The state file (`ready-watchdog-state.json`) still receives current idle-minute counts on every tick so the dashboard stays accurate without generating noise.

State entries track four `lastLogged*` fields (`lastLoggedAt`, `lastLoggedFingerprint`, `lastLoggedClassification`, `lastLoggedAction`) to distinguish "current dashboard state" from "last emitted event." Existing state files without these fields are treated as never logged and emit once on the next tick.

## CI Truth Rules

- DO require a complete required check set before recording `verdict: pass`.
- DO treat `checksRun: 0` or `checksRun: 1` against multiple required contexts as `pending`.
- DO pass live CI state into merge-queue selection.
- DO invalidate a stored ready pass when live CI fails for the same PR.
- DON'T promote or log a PR as merge-ready from a stored verdict alone.

Failure mode: ready pass with `checksRun: 1` usually means the policy path evaluated only non-CI guards or GitHub returned a partial check set. The shared CI evaluator fixes this by requiring branch-protection or configured contexts before pass.

## Ready → Tend Handoff Head (HOK-3112)

Ready publishes `.ready-tend-handoff.json` at the head it checked. Tend claims it only at the PR's live GitHub head, so a record at any other head is silently skipped on every poll.

| Artifact | Writer | Meaning |
|---|---|---|
| `<featureDir>/.ready-tend-handoff.json` | monitor (`set_ready_pass_labels`), tend (claim/rebind) | Head-bound ownership record: `checked → ready-published → tend-claimed → terminal` |
| `<featureDir>/.tend-pushed-head.json` | tend (`rebindPushedTendHead`) | Tend pushed `pushedHeadSha` over `previousHeadSha`; the task worktree is stale until the monitor syncs it |
| `<featureDir>/.tend-attempt-result.json` | tend (`recordTendAttemptFailure`, HOK-3316) | Tend's failed merge attempt for (PR head, integration base). `deriveMergeLabel` renders it as `wm:blocked tend-<phase>-failed`; a `rebase` fact also makes Ready's merge-conflict check report CONFLICTED. Expires on a new PR head (`remote`), an operator event, or (readers) a moved base |

- DO sync the task worktree to GitHub's head before Ready runs (`ready_sync_worktree_to_github_head` in `launch_ready_phase`, via `fetch` + `reset --keep`). Ready's checks and the cross-PR guard read the checkout, so a mismatch means Ready did not check the head it would publish.
- DO publish the handoff only at `ready_current_github_head`, and only when the checkout (and Ready's `headSha`, if reported) still equals it. GitHub unreadable → `ownership-changed`; head moved during Ready → pending `head-changed` (rc 4).
- DON'T write or clear `wm:blocked` from tend (HOK-3316): a failed attempt is a fact for `deriveMergeLabel`; the HOK-3105/3112 self-heal and its `tend-handoff-block.json` sentinel are gone because nothing latches a block the fact does not hold.
- DON'T fall back to `git rev-parse HEAD` of the task worktree for the handoff head.
- DON'T reset a worktree with unpushed local commits: sync only when local HEAD is an ancestor of the PR head, is the head tend recorded replacing, or was already on `origin/<branch>` before the fetch. Otherwise Ready refuses with a needs-attention reason.

| Symptom | Root Cause | Fix |
|---|---|---|
| Tend skips a green `wm:ready` PR every poll with `phase: handoff`; `.ready-tend-handoff.json` head ≠ PR head | Ready re-check ran in a task worktree still at the pre-rebase commit after a tend force-push, and published there (PR #1520, 2026-09-29) | Fixed by the preflight sync + GitHub-only publish head. Manual unstick: sync the worktree, then republish at the live head |
| ~90 s `wm:blocked` ↔ `wm:ready` flip and a "Rebase failed" comment every poll (PR #1697, 158 comments) | Tend's per-commit rebase conflicted while GitHub's 3-way merge was clean; tend labelled `wm:blocked`, the reconciler relabelled `wm:ready` | Fixed by HOK-3316: one `.tend-attempt-result.json` fact per (head, base), one edited-in-place merge-status comment, conflict remediation launched once. Unstick: rebase onto the integration branch, regenerate generated files, force-push |
| Ready refuses with "unpushed local work" | Task worktree has commits not on the PR head (e.g. remediation fix never pushed) | Push or discard the local commits; the next Ready tick syncs |

## Ready Remediation Disposition (HOK-3322)

"Is Ready remediation still in flight?" is one decision: `shared/lib/ready-remediation-disposition.ts`, read by the monitor through `ready_remediation_disposition` (spawns `tools/ready-remediation-disposition.ts`) and by the watchdog snapshot in process (`ReadyTaskSnapshot.remediationDisposition`).

| Kind | When | Monitor | Watchdog |
|---|---|---|---|
| `inactive` | Ready not running, or nothing launched | normal Ready branches | normal classification |
| `advanced` | launch head ≠ HEAD | pending re-check (`pending-ready-recheck` bucket) | verification-artifact gate |
| `in-flight` | agent's own live record after launch, blocking prompt, background work, no evidence yet, probe failed | hold (active slot) | `remediation-in-flight`; `stuck` not auto-recoverable |
| `settled` | agent idle/errored after launch, exited, or stalled | log `Ready remediation settled at <head> (<reason>)`, re-run Ready via the pending re-check | launch path / conflict resume / `stuck` recovery allowed |

- DO read launch identity only through `readReadyRemediationLaunch` (conflict marker, else the `ready-remediation` bucket head; launch time from the session-ownership row, because a pending rewrite restamps `.ready-result.json` `startedAt`).
- DON'T compare a remediation launch head with HEAD, or use pane activity, to hold Ready (guard: `tools/check-ready-remediation-disposition.ts`).
- `settled` never passes Ready: `launch_ready_phase` still requires green current-head checks to publish the handoff; red checks go through the `ready-remediation` bucket (new-head reset, backoff, ceiling, exhaustion sentinel).

| Symptom | Root Cause | Fix |
|---|---|---|
| Green PR stays in Ready; `.ready-result.json` `running` with `remediationLaunchHead` = HEAD; remediation agent idle; tend `ready-failed:head-mismatch` (PR #1720, 2026-10-26) | Remediation reran flaky CI without committing; the monitor's unconditional same-head running hold never consulted liveness | Fixed by HOK-3322 (`settled` → controller re-runs Ready). Journey: `ready-remediation-same-head` |

## Async Ready-Path Checks (HOK-3206)

The cross-PR revert guard (~19 s), the live CI read (~2.5 s per PR), the ready-watchdog sweep (~5 s) and routing (30-60 s) run as tracked jobs (`launch_tracked_job` → `job-tracker.ts`, kinds `cross-pr-guard`, `pr-ci-status`, `ready-watchdog`, `route-task`). Each job writes a condition-keyed result marker; the monitor consumes it on a later pass. Implementation: `shared/lib/monitor-async-jobs.sh`.

| Result | Location | Valid only while | Consumer |
|---|---|---|---|
| `.cross-pr-guard-result.json` | ready state dir | worktree HEAD **and** compare-base tip match | `ready_cross_pr_revert_gate` in `launch_ready_phase` (rc 4 = pending) |
| `.pr-ci-status-result.json` | ready state dir | PR head (per-pass PR cache) matches; refreshed every `WAVEMILL_PR_CI_STATUS_REFRESH_SECONDS` (30) | `ready_ci_json_cached` in `refresh_ready_merge_queue_tick` |
| `async-jobs/ready-watchdog/output.json` | mill state dir | not yet consumed (sequence) and < 2× sweep timeout old | `run_ready_watchdog_tick` |
| `.expanded-reroute-result.json` | feature dir | task packet content hash matches | `expanded_reroute_gate` at the plan→code handoff |
| `/tmp/<session>-<issue>-route.json` (source `route-job:<hash>`) | tmp | packet hash matches | `launch_task` (launch deferred via `deferred-launches.list`) |

- DO treat an absent or other-head result as **pending**, never as pass. The CI pending shape is `conclusion: "unknown"` with `pendingReason: "pr-ci-status-running"`, which the merge-queue planner never selects.
- DO charge job crashes/timeouts to the job's bounded-retry bucket (`cross-pr-guard-job`, `pr-ci-status-job`, `route-task-job`, `launch-route-job`) keyed on the same condition. Exhausted guard → tool-error evidence + attention; exhausted CI read → the inline `readError` shape; exhausted reroute → `handle_expanded_reroute_handoff_failure`; spent launch route → inline route once.
- DO let the condition reconciler expire result markers (`head` for the guard, `remote` for CI, `operator-event` for reroute). Gates only read.
- DON'T consume a guard verdict whose run saw the head move: the job publishes nothing and the next pass relaunches.
- DON'T read GitHub per task in the hot pass: `monitor_refresh_pr_cache` makes one `gh pr list --state all --search 'head:<b1> head:<b2> …'` per pass (`<cache>.meta.json` records which branches were covered and whether the page was complete). `pr_state`, `validate_pr_merge`, `wavemill_pr_candidates_for_branch`, `check_pr_exists`, `pr_live_labels_json` and the TS readers (`probePrLiveState`, `fetchPrCiStatus`, the watchdog's GitHub truth) read it first; `probePrLiveState` and expected-head CI reads use a row only for the matching head. `gh repo view` and branch protection live in the session repo cache (`/tmp/<session>-repo.json`).

The `WAVEMILL_SYNC_READY_CHECKS` / `WAVEMILL_SYNC_ROUTING` / `WAVEMILL_DISABLE_GH_BATCH_CACHE` rollback switches were retired in HOK-3235. Tests that still pin the inline contract source `tests/lib/inline-ready-checks.sh`.

`monitor-timing.json` carries `github: {ghCalls, prCacheHits, prCacheMisses}` (shell `gh` spawns this pass) and `jobs: {<kind>: {launched, consumed, pending}}`.

| Symptom | Root Cause | Fix |
|---|---|---|
| Ready stays `pendingReason: cross-pr-guard-running` | Guard job keeps crashing; backoff between attempts | Read `.wavemill/…/async-jobs/cross-pr-guard-<issue>/job.log`; after `WAVEMILL_ASYNC_CHECK_JOB_RETRY_LIMIT` (3) failures the gate terminalizes with the last stderr |
| Merge queue shows `ci.conclusion: unknown` for one pass after a push | CI result is for the previous PR head; the read for the new head is in flight | Expected; the next pass consumes the new result |

## Migration Checks

When a repo has `alembic/versions/` and no explicit `ready.checks`, ready auto-enables:

- `migration-chain-integrity` as a required universal check.
- `migration-base-refresh` as a non-blocking pre-check that fetches the base branch before migration validation.

Operators can disable this with `ready.migrationChecks.enabled = false`.

## Blast-radius routing (HOK-3238)

`shared/lib/blast-radius.ts` classifies a changed-file set as `high` iff any
file matches a mill-core pattern (monitor, tend, merge-labels, reconciler,
state writers, ready stage, invariant checker). Everything else is `normal`.

Three callers consume it:

- `shared/lib/workflow-router.ts` — `applyBlastRadiusFloor` floors the reviewer
  to `strong_generalist` (or `frontier`) for `high` PRs. The floor runs *before*
  `finalizeDecision`, so the HOK-3142 launchability guard still runs on the
  upgraded reviewer. The decision stamps `blastRadius`; a substituted reviewer
  is captured in `preEscalationRoute`.
- `shared/lib/review-engine.ts` — `fillReviewPromptTemplate` injects the
  `HIGH_BLAST_RADIUS_GUIDANCE` block (fixture provenance, journey check, latch
  check) at the top of both the standard and scoped review prompts. The three
  bullets map directly to the HOK-3212 incident mode. The guidance's journey
  command is `bash tests/journeys/run-journeys.sh happy-path`.
- `shared/lib/state-invariants.ts` — `I8-bake-gate-stall` watches `main` for
  `WAVEMILL_BAKE_GATE_MINUTES` (default 120 min) after a `high`-blast-radius
  commit lands, firing when `services.tend.laneCondition === 'idle-blocked-stall'`
  persists for `WAVEMILL_BAKE_GATE_TEND_STALL_MINUTES` (default 30 min) past
  the commit. The urgent finding carries `evidence.revertCommand = git revert
  <sha>` for a one-command rollback. Signature is `I8:<sha>` so repeat ticks
  never spam past the first OS notification.

**New mill-core paths belong in `MILL_CORE_PATTERNS` in `shared/lib/blast-radius.ts`.**
