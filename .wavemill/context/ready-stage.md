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
| `<featureDir>/.ready-tend-handoff.json` | monitor (`set_ready_pass_labels`), tend (claim/rebind/self-heal) | Head-bound ownership record: `checked → ready-published → tend-claimed → terminal` |
| `<featureDir>/.tend-pushed-head.json` | tend (`rebindPushedTendHead`, self-heal) | Tend pushed `pushedHeadSha` over `previousHeadSha`; the task worktree is stale until the monitor syncs it |
| `.wavemill/merge-lane/<pr>/tend-handoff-block.json` | tend (refused rebind) | Tend's own `wm:blocked`, with the pushed head, previous head, and featureDir for the self-heal |

- DO sync the task worktree to GitHub's head before Ready runs (`ready_sync_worktree_to_github_head` in `launch_ready_phase`, via `fetch` + `reset --keep`). Ready's checks and the cross-PR guard read the checkout, so a mismatch means Ready did not check the head it would publish.
- DO publish the handoff only at `ready_current_github_head`, and only when the checkout (and Ready's `headSha`, if reported) still equals it. GitHub unreadable → `ownership-changed`; head moved during Ready → pending `head-changed` (rc 4).
- DO move the handoff record to the live head (`rebindTendHandoff`, else `publishReadyHandoff`) before a tend self-heal restores `wm:ready`, and only when the live head is tend's own push (sentinel head and `.tend-pushed-head.json` agree).
- DON'T fall back to `git rev-parse HEAD` of the task worktree for the handoff head.
- DON'T reset a worktree with unpushed local commits: sync only when local HEAD is an ancestor of the PR head, is the head tend recorded replacing, or was already on `origin/<branch>` before the fetch. Otherwise Ready refuses with a needs-attention reason.

| Symptom | Root Cause | Fix |
|---|---|---|
| Tend skips a green `wm:ready` PR every poll with `phase: handoff`; `.ready-tend-handoff.json` head ≠ PR head | Ready re-check ran in a task worktree still at the pre-rebase commit after a tend force-push, and published there (PR #1520, 2026-09-29) | Fixed by the preflight sync + GitHub-only publish head. Manual unstick: sync the worktree, then republish at the live head |
| Healed PR (HOK-3105) still skipped by tend | Self-heal cleared `wm:blocked` but left the record at the pre-push head | Self-heal now rebinds/republishes at the live head first |
| Ready refuses with "unpushed local work" | Task worktree has commits not on the PR head (e.g. remediation fix never pushed) | Push or discard the local commits; the next Ready tick syncs |

## Migration Checks

When a repo has `alembic/versions/` and no explicit `ready.checks`, ready auto-enables:

- `migration-chain-integrity` as a required universal check.
- `migration-base-refresh` as a non-blocking pre-check that fetches the base branch before migration validation.

Operators can disable this with `ready.migrationChecks.enabled = false`.
