# Wavemill Terminal Lifecycle And Resources

Wavemill task state separates workflow outcome from resource disposition. Legacy `status` and `phase` remain display and compatibility fields; consumers that decide cleanup, slot accounting, Observer classification, or startup recovery must read the normalized lifecycle view.

## Canonical Fields

Each task may carry `lifecycle` in `.wavemill/workflow-state.json`:

- `workflowOutcome`: `active`, `merged`, `closed`, `aborted`, or `error`.
- `resourceDisposition`: `allocated`, `released`, `retained`, `reaping`, `reaped`, or `verification-required`.
- `launchContract`: immutable effective launch and cleanup contract. It records base branch, base SHA, integration mode, merge method, remote branch deletion policy, challenge role/pair, session/run epoch, and window ID.
- `deliveryEvidence`: mutable evidence learned later, including reviewed/published head SHA, PR head SHA, PR number/state/base, and merge SHA.
- `retention`: required when a terminal outcome still has allocated, retained, or verification-required resources.

The lifecycle schema is `shared/schemas/task-lifecycle-state.schema.json`; TypeScript readers use `shared/lib/task-lifecycle.ts`.

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
| `pr_merged` | `merged` | Reconciler records outcome/evidence only. Cleanup moves resources through `reaping` to `reaped` or fail-safe retention. |
| `pr_closed_unmerged` | `closed` | No branch deletion authority is implied. Cleanup must retain or verify resources before removal. |
| `challenge_resolved_winner` | `closed` | Losing side may be cleaned by existing challenge cleanup authority; retained state needs an explicit reason. |
| `challenge_invalid` | `closed` | Resources are retained or verification-required unless cleanup completes. |
| `challenge_no_comparison` | `closed` | Resources are retained or verification-required unless cleanup completes. |
| `operator_abort` | `aborted` | Cleanup authority is unchanged; remote PR branches are retained. |
| `recovery_failure` | `error` | Resources require manual verification unless cleanup can prove they were reaped. |

## Ownership

- Panes: task-owned while `allocated`; queue-owned when `released`; cleanup-owned while `reaping`; manually owned when `retained` or `verification-required`.
- Worktrees and local branches: cleanup may remove them only after existing dirty/unpushed-work guards pass.
- Remote branches: deletion requires an explicit lifecycle launch contract and existing PR-merged evidence. Legacy state never grants this authority by default.
- Hooks: terminal reconciliation may terminalize hook state, but that is not proof of pane release.
- Retries and incidents: cleanup failures retain task state and write retry/incident evidence rather than deleting uncertain resources.
- Task-state entries: removed only after cleanup has reached `reaped`, or by pre-existing explicit state-removal paths whose safety contracts already own that decision.

## Legacy Migration

Readers normalize old or malformed task records on read. Missing launch contracts, missing remote branch deletion policy, terminal status with active pane metadata, or malformed lifecycle values become `resourceDisposition=verification-required` and `branchDeletionAuthorized=false`.

Startup does not mass-rewrite legacy state. Normal state mutations backfill lifecycle fields when enough effective session data is available, while preserving unknown fields for rollback compatibility.
