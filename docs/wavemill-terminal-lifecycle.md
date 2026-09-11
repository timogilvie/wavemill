# Wavemill Terminal Lifecycle And Resources

Wavemill task state separates workflow outcome from resource disposition. Legacy `status` and `phase` remain display and compatibility fields; consumers that decide cleanup, slot accounting, Observer classification, or startup recovery must read the normalized lifecycle view.

## Canonical Fields

Each task may carry `lifecycle` in `.wavemill/workflow-state.json`:

- `workflowOutcome`: `active`, `merged`, `closed`, `aborted`, or `error`.
- `resourceDisposition`: `allocated`, `released`, `retained`, `reaping`, `reaped`, or `verification-required`.
- `launchContract`: immutable effective launch and cleanup contract. It records base branch, base SHA, integration mode, merge method, remote branch deletion policy, challenge role/pair, session/run epoch, and window ID.
- `deliveryEvidence`: mutable evidence learned later, including reviewed/published head SHA, PR head SHA, PR number/state/base, and merge SHA.
- `retention`: required when a terminal outcome still has allocated, retained, or verification-required resources.
- `cleanupEpisode`: durable cleanup scheduler state for terminal cleanup attempts.

The lifecycle schema is `shared/schemas/task-lifecycle-state.schema.json`; TypeScript readers use `shared/lib/task-lifecycle.ts`.

## Cleanup Episodes

Terminal cleanup records one cleanup episode per evidence fingerprint. The episode stores `fingerprint`, `fingerprintInputs`, `firstAttemptAt`, `lastAttemptAt`, `attemptCount`, `nextRetryAt`, `lastOutcome`, `failureClass`, and `requiredOperatorAction`.

Expected preservation, such as dirty worktrees, unpublished commits, divergent local heads, or local head changes during verification, is terminally reconciled as `resourceDisposition=retained` with `cleanupEpisode.disposition=retained`. Unchanged retained fingerprints are not retried automatically and do not consume slots. Cleanup retries only when the local evidence fingerprint changes or an operator records acknowledgement/recovery in state.

Transient external failures, such as remote/base fetch or remote-head lookup failures, record `cleanupEpisode.disposition=transient` and a bounded exponential `nextRetryAt`. When the retry budget is exhausted, the episode moves to `needs-user` and repeated unchanged polls stay quiet until evidence changes or an operator acknowledges recovery.

Disabling `cleanup.episodes.enabled` stops new scheduler gating but does not delete existing episode evidence, authorize deletion, or make retained terminal tasks slot-consuming.

## Slot Accounting

Mill slot consumption follows `resourceDisposition`, not `phase` naming:

- Consumes a slot: `allocated`, `reaping`.
- Does not consume a slot: `released`, `retained`, `reaped`, `verification-required`.

Queue-owned ready tasks are `released` and do not consume a task pane slot. Retained or verification-required terminal tasks stay visible/actionable but do not block new launches merely because their old phase was terminal.

## Allowed Combinations

`active + allocated` is the normal in-flight task state. `active + released` is allowed for queue handoff. `active + reaping` is allowed during durable cleanup.

Terminal outcomes (`merged`, `closed`, `aborted`, `error`) may use `reaping`, `reaped`, or `released` without retention. They may use `allocated`, `retained`, or `verification-required` only with `retention.reason`.

Invalid combinations:

- `active + reaped`.
- Any terminal outcome with `allocated`, `retained`, or `verification-required` and no retention reason.
- Any remote branch deletion decision without `launchContract.remoteBranchDeletionPolicy.allowed` explicitly set by the effective launch/session contract.

## Terminal Postconditions

| Terminal reason | Workflow outcome | Resource postcondition |
| --- | --- | --- |
| `review_complete` | `active` | PR/review evidence may be recorded; resources remain `allocated` unless queue handoff releases the pane. |
| `ready_complete` | `active` | Ready evidence may be recorded; resources remain `allocated` until queue handoff or cleanup. |
| `pr_opened` | `active` | PR evidence is recorded; no pane release is implied. |
| `pr_merged` | `merged` | Pane policy `release` (unless `REQUIRE_CONFIRM` holds the window open): transcript is archived, a terminal record is written, and the pane is killed. Cleanup separately moves git resources through `reaping` to `reaped` or fail-safe retention. |
| `pr_closed_unmerged` | `closed` | Pane policy `release`. No branch deletion authority is implied; cleanup must retain or verify git resources before removal, and the pane is released either way. |
| `challenge_resolved_winner` | `closed` | Pane policy `release`. Losing side may be cleaned by existing challenge cleanup authority; retained state needs an explicit reason. |
| `challenge_invalid` | `closed` | Pane policy `release`. Git resources are retained or verification-required unless cleanup completes. |
| `challenge_no_comparison` | `closed` | Pane policy `release`. Git resources are retained or verification-required unless cleanup completes. |
| `operator_abort` | `aborted` | Cleanup authority is unchanged; remote PR branches are retained. |
| `recovery_failure` | `error` | Resources require manual verification unless cleanup can prove they were reaped. |

## Ownership

- Panes: task-owned while `allocated`; queue-owned when `released`; cleanup-owned while `reaping`; manually owned when `retained` or `verification-required`.
- Worktrees and local branches: cleanup may remove them only after existing dirty/unpushed-work guards pass.
- Remote branches: deletion requires an explicit lifecycle launch contract and existing PR-merged evidence. Legacy state never grants this authority by default. `cleanup.branchDeletion.mode=shadow` records would-delete evidence and retains branches until an operator enables `enforce`.
- Hooks: terminal reconciliation may terminalize hook state, but that is not proof of pane release.
- Retries and incidents: cleanup failures retain task state and write retry/incident evidence rather than deleting uncertain resources.
- Task-state entries: removed only after cleanup has reached `reaped`, or by pre-existing explicit state-removal paths whose safety contracts already own that decision.

## Pane Release vs Git Retention (HOK-2952)

Terminal pane release is deterministic, truthful, idempotent, and independent of git worktree/branch cleanup. Killing the tmux window never deletes or modifies git work, and preserving git work never keeps a dead pane allocated.

### Policy table

`wavemill_terminal_pane_policy_for_reason` (shared/lib/terminal-reconciler.sh) maps every terminal reason to one pane action:

| Terminal reason | Pane policy |
| --- | --- |
| `pr_merged`, `pr_closed_unmerged`, `challenge_resolved_winner`, `challenge_invalid`, `challenge_no_comparison` | `release` |
| `review_complete`, `ready_complete`, `pr_opened` | `metadata-only` (workflow still active; HOK-2937 queue handoff owns any release) |
| `operator_abort`, `recovery_failure` | `retain` (the pane is the operator's diagnostic surface) |

Overrides, applied in order: the feature gate off downgrades `release` to `metadata-only`; `REQUIRE_CONFIRM=true` on `pr_merged` downgrades to `metadata-only` (the "window stays open for review" operator hold).

For a closed, unmerged PR, `closed_pr_resource_policy` (shared/lib/wavemill-monitor.sh) decides the git side: a challenger whose challenge comparison is still pending under auto-merge gets `pane-release-only` (git work must survive for the comparison; the challenge loser-cleanup path keeps deletion authority), and every other role — non-challenge tasks, tasks with missing/drifted `challengeRole`, and manual-review challengers — gets `full-cleanup` through `cleanup_completed_task`, whose fail-safe guards retain unproven git work while the pane is still released.

### Release sequence and fault boundaries

`wavemill_release_terminal_pane` runs a fault-ordered sequence: ownership guard → archive diagnostics → durable terminal record → verified `kill-window` → truthful state write. Each step is idempotent, so an interruption at any boundary converges on the next monitor pass with no duplicate errors:

1. **Ownership guard**: a live agent process in the pane (`mill_pane_has_live_blocking_process`), indeterminate liveness, or a fresh hook in `working`/`waiting`/`approval-needed`/`blocked` blocks release. A missing or already-dead window with ownership proven is treated as success and still completes the remaining steps.
2. **Archive**: full pane scrollback is captured to `.wavemill/evals/artifacts/<issue>/pane-transcript-<reason>.txt` and the current hook snapshot is appended to the feature dir's `.terminal-history.jsonl`. Archive failures never block release.
3. **Terminal record**: `.wavemill/evals/artifacts/<issue>/terminal-record.json` (atomic tmp+mv, survives worktree deletion) records issue, reason, PR, branch, worktree, head SHA, window target, whether the transcript was archived, and a `recovery` block telling an operator how to recover retained work without a live pane.
4. **Kill**: `tmux kill-window` is verified; the hook file is removed only after the window is gone.
5. **State**: `paneState=released`, `paneReleased=true`, `paneReleasedAt`, `terminalRecordWritten=true`. `resourceDisposition` stays owned by git truth — it becomes `released` only for an `active`+`allocated` task; `retained`/`verification-required`/`reaping`/`reaped` from cleanup are never overwritten, so fields describe the real state of tmux and git, not an attempted action.

`cleanup_completed_task` uses the same primitive before its git steps, so a worktree-removal failure, preserved unpushed work, or unverified remote-branch cleanup keeps the git-side retention *without* re-allocating the pane. Retained and verification-required tasks do not consume a mill slot (see Slot Accounting), so a retained dirty worktree never blocks new launches.

### Feature gate and rollback

`terminal.paneRelease.enabled` (default **true**; user → repo → local config layering) and the `WAVEMILL_TERMINAL_PANE_RELEASE=0` env kill-switch disable automated release. Rollback keeps the truthful state fields, archived transcripts, and terminal records — only the kill step stops happening.

### Recovering retained work after pane release

1. Read `.wavemill/evals/artifacts/<issue>/terminal-record.json` — its `recovery.howToRecover` names the branch and (if it still existed at release time) the worktree.
2. `pane-transcript-<reason>.txt` beside it holds the final pane scrollback; the feature dir's `.terminal-history.jsonl` holds hook-state history.
3. If the worktree was retained, it is still on disk at the recorded path; otherwise re-create one with `git worktree add <dir> <branch>`.

## Startup Terminal Preflight (HOK-2954)

Startup runs `startup_terminal_preflight` before resume menus, launch-plan writing, tmux session creation, task panes, or agent launches. The preflight reads persisted `.tasks`, checks authoritative PR/challenge terminal state where available, and stamps each retained entry with a `rehydration` contract:

```json
{
  "eligibility": "eligible | deferred | verification-required | terminal",
  "reason": "pr_merged | pr_closed_unmerged | challenge_resolved_winner | pr_state_unverifiable | ...",
  "checkedAt": "2026-09-08T00:00:00Z",
  "runEpoch": "20260908T000000Z.12345",
  "actor": "startup-terminal-preflight"
}
```

Eligibility meanings:

- `terminal`: the task is already merged, closed, superseded, aborted, errored, or otherwise terminal. Startup routes it through `wavemill_reconcile_terminal` and existing cleanup/resource-disposition primitives instead of launching an agent.
- `eligible`: the task has active lifecycle state and enough provenance for normal recovery.
- `deferred`: live PR state could not be verified, usually because GitHub was unavailable. Startup preserves active state and emits one warning episode for the run; it does not terminalize or delete.
- `verification-required`: legacy or malformed state is too ambiguous to recover safely. Startup stamps retention state, skips launch, takes no destructive action, and continues restoring unrelated valid tasks.

Decision order is intentionally conservative:

| Persisted state | Live PR state | Challenge sibling | Startup result |
| --- | --- | --- | --- |
| Terminal lifecycle/status/phase, including `superseded` | Any | Any | `terminal:<mapped reason>` |
| Active with recorded PR | `MERGED` | Any | `terminal:pr_merged` |
| Active with recorded PR | `CLOSED` without merge | Any | `terminal:pr_closed_unmerged` |
| Active challenger | Open, missing, or no own PR | Sibling merged | `terminal:challenge_resolved_winner` |
| Active with recorded PR | Unreadable or network failed | Worktree exists | `deferred:pr_state_unverifiable` |
| Missing phase, slug, or recoverable worktree provenance | Any | Any | `verification-required:<why>` |
| Active and recoverable | Open or no recorded PR needed | No terminal sibling | `eligible` |

Run identity is recorded separately from historical task state. The mill creates `WAVEMILL_RUN_EPOCH` at startup, stamps top-level `.runEpoch`, includes it in the launch plan and monitor env, and `save_task_state` persists it into `lifecycle.launchContract.runEpoch`. This lets state readers distinguish current-session validation/launch activity from retained terminal history.

Restart behavior is idempotent: each preflight step is either a read, a `state_mutate` stamp, or a call into the idempotent terminal reconciler and cleanup disposition machine. Re-running startup after a crash converges to the same eligibility, terminal markers, and resource disposition as an uninterrupted run.

Rollback: `startup.terminalPreflight.enabled=false` or `WAVEMILL_STARTUP_TERMINAL_PREFLIGHT=0` skips classification. The epoch and `rehydration` fields are retained as harmless historical fields; disabled startup never rewrites terminal entries back to active.

## Certification And Rollout

End-to-end certification, shadow-mode audit, soak gates, and rollback steps are
documented in [Terminal Lifecycle Certification](terminal-lifecycle-certification.md).

## Legacy Migration

Readers normalize old or malformed task records on read. Missing launch contracts, missing remote branch deletion policy, terminal status with active pane metadata, or malformed lifecycle values become `resourceDisposition=verification-required` and `branchDeletionAuthorized=false`.

Startup does not mass-rewrite legacy state. Normal state mutations backfill lifecycle fields when enough effective session data is available, while preserving unknown fields for rollback compatibility.
