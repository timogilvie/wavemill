---
title: Autonomous Integration
---

# Autonomous Integration

Autonomous integration mode inserts a managed staging branch between task PRs and `main`.

```text
task/* -> auto/integration -> main
```

Use it when you want Wavemill to merge reviewed task PRs into a shared integration branch continuously, then promote that branch to `main` on a separate cadence.

## Quickstart

Three steps to turn this on for an existing repo.

**1. Create the integration branch.** This must exist before you enable the feature; tend will not create it for you.

```bash
git fetch origin main
git branch auto/integration origin/main
git push -u origin auto/integration
```

**2. Add the minimal config to `.wavemill-config.json`:**

```json
{
  "integration": {
    "enabled": true,
    "readyPolicy": {
      "enabled": true
    }
  }
}
```

This is enough to start. Defaults from [`wavemill-config.schema.json`](../wavemill-config.schema.json) cover the rest: `auto/integration` as the staging branch, squash merges, halt-on-red, manual review for high-risk PRs.

If you want to enable this only for yourself without committing the change, put the same block in `.wavemill-config.local.json` (gitignored, deep-merged on load) instead of the base file. See [Per-Developer Config Overrides](getting-started.md#per-developer-config-overrides).

**3. What changes about your workflow.** After enabling:

- New task PRs target `auto/integration` instead of `main`.
- A `wavemill tend` loop starts as a tmux window inside your mill session and merges ready-labeled PRs one at a time.
- A separate `auto/integration -> main` promotion PR is opened and refreshed but not auto-merged. You decide when to release.

If you have in-flight task PRs when you flip this on, set `mill.baseBranch` to `auto/integration` only after they merge. Changing the base branch on a repo with open PRs does not retarget them automatically, but new worktrees will start from the wrong branch until you do.

## Complete Configuration Reference

```json
{
  "mill": {
    "baseBranch": "auto/integration"
  },
  "integration": {
    "enabled": true,
    "integrationBranch": "auto/integration",
    "promotionBranch": "main",
    "mergeMethod": "squash",
    "haltOnRed": true,
    "highRiskPolicy": "manual",
    "useMillSession": true,
    "readyPolicy": {
      "enabled": true,
      "riskPolicy": "require-label",
      "enforceMigrationCoupling": true
    }
  }
}
```

Set `mill.baseBranch` to the same branch as `integration.integrationBranch`. That keeps new task worktrees aligned with the branch tend is merging into. If `mill.baseBranch` stays on `main`, tend can still reconcile each PR against `auto/integration` later in the merge lane, but it now skips the pre-merge rebase whenever the PR head already contains `auto/integration`; otherwise you are still pushing conflict resolution later in the pipeline.

## Pipeline

- `mill` opens task PRs against `auto/integration`.
- `ready` evaluates autonomous-merge policy guards.
- `tend` merges at most one eligible PR into `auto/integration` per pass.
- `promote` opens or refreshes the `auto/integration -> main` promotion PR.

When `integration.useMillSession = true`, the tend loop runs in the `backstage` tmux window inside the existing mill session.

## Resilience

The tend loop treats transient GitHub/network errors as retryable: source `gh` calls use bounded exponential backoff, and a failed loop iteration records `failureCount`, `lastError`, and `lastErrorAt` in `.wavemill/backstage-health.json` before continuing. The backstage watchdog restarts a dead tend loop on a widening backoff from 60s up to 15m and keeps retrying after escalating to `needs-user` for visibility. Manual recovery remains the same command shown in the health detail: restart `npx tsx tools/tend.ts --loop --repo-dir <repo>` in tmux.

The Observer loop uses the same repo/session singleton shape as tend, with its own `.wavemill/locks/observer-<repo>-<session>.lock`, so duplicate `observer.ts --loop` launches exit instead of polling or writing health beside the active loop.

## Branch Protection

Recommended GitHub settings for `auto/integration`:

- Require status checks before merge.
- Require the Wavemill-ready labels and metadata workflow your repo uses before a PR is considered mergeable.
- Block direct pushes.
- Allow merges only through PRs so `tend` remains the only autonomous writer.

Recommended GitHub settings for `main`:

- Require status checks before merge.
- Require linear history if your release process expects a clean promotion trail.
- Restrict who can merge so promotion happens through the managed `auto/integration -> main` PR, not ad hoc task PRs.
- Block direct pushes.

## Required Checks

The exact check set is repo-specific, but autonomous integration should protect two surfaces:

- Task PR checks on PRs targeting `auto/integration`.
- Branch-health checks on the head commit of `auto/integration` itself.

The config surface for these rules lives in:

- [`wavemill-config.schema.json`](../wavemill-config.schema.json) for `integration` and `integration.readyPolicy`
- [`docs/ready-stage.md`](./ready-stage.md) for the ready-policy guard behavior

At minimum, protect:

- CI on every task PR
- CI on `auto/integration`
- required review/label workflows your repo depends on
- migration safety checks if you use database migrations

## High-Risk Policy

High-risk handling is split across two config names:

- `integration.highRiskPolicy` in the top-level integration config uses schema values `block`, `manual`, and `allow`.
- `integration.readyPolicy.riskPolicy` is the ready-engine setting actually enforced by autonomous merge, with values `block`, `require-label`, and `auto`.

The default top-level value is `manual`, which maps to ready-stage behavior equivalent to `require-label`.

High risk is triggered when either of these is true:

- the PR has label `Risk: High`
- the PR metadata block contains `risk: high`

Policy options:

- `block`: the PR never merges autonomously. Operator override means changing policy or merging outside the autonomous path.
- `require-label`: tend holds the PR until a human adds `wm-risk-acknowledged`.
- `auto`: tend allows the merge path to continue and records the situation as a warning instead of a block.

Recommended default:

- Use `require-label` for most repos.
- Reserve `block` for branches that must never self-merge risky changes.
- Use `auto` only when your downstream controls already absorb that risk.

## Integration-Red Halt Behavior

Before tend selects a PR, it checks the current `auto/integration` head commit. If any branch check run reports a failing conclusion, tend returns an idle status with `health=degraded` and no PR is eligible.

After a merge, tend checks `auto/integration` again. If the branch turns red after the merge, tend marks the just-merged PR as the last action, posts a failure comment, and halts the loop so operators can intervene before the next merge.

## Promotion Cadence

Promotion should be treated as a release decision, not a background side effect.

Common patterns:

- Manual cadence: run `wavemill tend promote --repo-dir <repo>` or `wavemill promote --repo-dir <repo>` when the integration branch is green and you are ready to release.
- Scheduled cadence: trigger the promote command from CI on a schedule, but still let `main` branch protection govern whether the PR can merge.

Use manual cadence when:

- deployments are coordinated
- production windows are narrow
- human approval is required for releases

Use automated cadence when:

- `auto/integration` is already your release-quality branch
- promotion PR checks are strong enough to act as the final gate

## Rollback Playbook

If a bad merge lands in `auto/integration`:

1. Revert the offending task PR or commit on `auto/integration`.
2. Re-run the integration branch checks until the branch is green again.
3. Resume `wavemill tend` only after the branch health recovers.

If the branch itself needs a hard reset:

1. Stop the tend loop.
2. Reset `auto/integration` to the last known good commit using your normal protected-branch process.
3. Re-open or recreate any task PRs that should still be considered for merge.
4. Restart tend after the branch checks are green.

## Challenge Mode

Challenge-mode PR pairs are not allowed to race into `auto/integration`. Tend waits for a resolved comparison record first.

- If no comparison exists yet, both sides stay blocked.
- If a winner exists and challenge auto-merge is enabled, tend keeps the winner eligible and closes the loser.
- If auto-merge of winners is disabled, the winner is still held for manual action.

## Session Capabilities (HOK-3102)

Every producer that would create work for a consumer (a tend handoff, a
`wm:ready` label, a pane released to the merge queue, an observer finding,
a merge-lane BEHIND update) now asks a single resolver — `resolveSessionCapabilities`
in `shared/lib/config.ts`, wrapped by `wavemill_session_has` in
`wavemill-common.sh` — whether the matching consumer is active in this
session.

The resolver returns a small object per session:

| Field | Value | Meaning |
|---|---|---|
| `tend` | `boolean` | This mill session runs the backstage tend loop. |
| `observer` | `boolean` | This mill session runs the observer loop. |
| `mergeExecutor` | `tend \| operator \| none` | Who will merge a green PR. |
| `mergeQueue` | `boolean` | Mill-side merge-candidate lifecycle is live. |

The rules:

- `tend` is `integration.enabled && useMillSession !== false`.
- `observer` is `observer.enabled !== false`: on by default in every mill
  session, independent of tend and integration (HOK-3094). An observer-only
  session still gets a backstage window (observer + status panes, no tend pane),
  and the monitor restarts the observer — recreating the window if needed —
  without tend.
- `mergeExecutor` is `tend` when tend is running; `none` when `integration.enabled`
  is true but `useMillSession` is false; `operator` otherwise (integration off —
  the HOK-3093 default).
- `mergeQueue` is on only when `mergeExecutor === 'tend'` and `mergeQueue.enabled`
  is true. The `MERGE_QUEUE_ENABLED` env override is still honoured.

Health data from `.wavemill/backstage-health.json` is exposed under `health.tend`
and `health.observer` for the dashboard and status log, but is **never** used to
gate a producer — a handoff published during a transient tend restart still gets
claimed on recovery.

### What "merge needed" means

When `mergeExecutor` is `operator` or `none` and a PR passes ready:

- `.ready-result.json` records `queueState: "merge-needed"`,
  `readyTendHandoff: "merge-needed"`, `mergeExecutor` and
  `readyLabelsUpdated: false`.
- No `ready-tend-handoff publish` runs, no `wm:ready` label is stamped, no pane
  is released to the (absent) merge queue.
- The task window flips to `needs-user`; the status log records one
  `⏳ HOK-x → PR #N green; merge needed` line per (PR, head); the monitor
  writes an `approval-needed` / `merge_needed` hook so an OSC notification
  fires. The hook is written with `writer=monitor`, so it is never treated as
  agent liveness evidence (HOK-3101).
- The dashboard renders the PR as `⏳ merge needed`.

Turning integration on later reruns ready at the current head, which
publishes a fresh handoff — parked PRs are never stranded.

### `compare-prs` never merges

`compare-prs` used to call `gh pr merge` on the winner directly. It no longer
does; `--auto-merge` is now a deprecated flag that only prints a warning.
Winners reach a merge through the single merge executor:

- `mergeExecutor=tend`: ready pass → handoff + `wm:ready` →
  `tend-challenge-gate` (which sees `challenge.autoMergeWinner` and applies
  `integration.mergeMethod`).
- `mergeExecutor=operator` / `none`: surface as "merge needed" and a human
  merges.

The loser is still closed by `compare-prs` when `challenge.autoMergeWinner` is
on — that's a close, not a merge, and it's idempotent with tend's cleanup and
the monitor's loser close.

### `requireConfirm` is window retention, not a merge gate

`mill.requireConfirm` controls whether tmux windows and panes are retained
after the task terminates. It has never gated merging in this codebase; the
single merge executor decides that.

## Disabling Autonomous Integration

To turn the feature off, set `integration.enabled: false` in `.wavemill-config.json` (or remove the `integration` block entirely). The next `wavemill mill` start will not spawn the tend window, and task PRs will resume targeting whatever `mill.baseBranch` is set to.

If you set `mill.baseBranch` to `auto/integration` while integration mode was on, switch it back to `main` (or your trunk) at the same time. Otherwise new task worktrees will keep branching off the now-frozen integration branch.

The `auto/integration` branch itself is safe to leave in place; nothing reads from it once `integration.enabled` is false. Delete it when you are confident you do not want to re-enable.

## See Also

- [Mill Mode](mill-mode.md)
- [Ready Stage](ready-stage.md)
- [CLI Reference](cli-reference.md)
