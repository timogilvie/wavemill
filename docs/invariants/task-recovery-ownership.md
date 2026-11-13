# Task-recovery ownership (HOK-3277)

**Rule:** task recovery is one control path. The decision about what happens to
a stuck or exited attempt — and the claim that dispatches it — is made only by
`shared/lib/task-recovery-controller.ts`:

- `decideTaskRecovery(snapshot)` is the single, pure, named-and-versioned
  policy (`task-recovery-controller@1`). It ranks the snapshot and returns one
  action from a closed vocabulary: `no-action`, `wait`, `consume-advance`,
  `verify-effect`, `retry-stage`, `remediate`, `escalate`,
  `reject-stale-control`.
- `claimRecoveryAction(...)` is the one atomic claim. Concurrent Monitor /
  Tend / Observer notifications that compute the same decision collapse to
  exactly one dispatch; a non-control-bearing action is never claimed.

No file may author a second recovery decider or write the `.recovery-claim.json`
seam directly.

## What the controller owns, and what it delegates

The controller owns only snapshot ordering, deterministic action selection, and
the atomic claim. Everything the decision is *made of* stays with its existing
owner — the controller composes them, never re-derives them:

| Concern | Owner |
| --- | --- |
| Is this attempt the current one? Is late evidence stale control? | `attempt-identity.ts`, `task-settlement.ts` |
| Is the stage agent in-flight, settled, or advanced? | `stage-agent-disposition.ts` |
| Is this failure terminal / code-failure / retryable? | `failure-policy.ts` (`classifyFailure`) |
| How many retries are left; backoff? | `bounded-retry.*` (the caller gates; the controller reads the verdict) |
| Which model/agent does a coding retry replay? | `execution-contract.ts` + `resolveModelAgent` (replayed, never re-chosen) |
| Raising operator attention | `operator-escalation.*` (one step) |
| Cost / attribution | SDK-owned; the controller records the action, not a price |

A deadline, a missing acknowledgement, or an Observer outage is **not** a
model/provider failure, does not steal ownership, and does not terminate work.
Explicit human holds survive restart and retry.

## Live hosting

The controller is hosted through Monitor's existing control loop and tracked
async jobs; there is no separate stall daemon. The monitor's shell seams —
`maybe_retry_failed_stage`, `_stage_disposition_act`,
`ready_failure_classify_and_act` (and the consolidated
`_monitor_recover_failed_stage` helper) — are the controller's first adapters:
they compose the same authorities and route a failed stage through one seam.
They are not a second retry or escalation policy. Tend executes integration
actions and Observer supervises; neither gets a second task-retry or escalation
decider. HOK-3406 migrates Observer's existing auto-fixes onto this interface.

The incident-replay harness (`incident-replay-harness.ts`) drives every
recorded incident fixture through `decideTaskRecovery`, so the live decision
path is exercised by CI with assertions independent of the policy internals.

## Guard

`tools/check-task-recovery-ownership.ts` (spec:
`shared/lib/task-recovery-ownership-guard.ts`), wired into `test:preflight`.
It fails on:

1. `recovery-decider` — a TypeScript `decide<...>Recovery` declared outside the
   controller.
2. `recovery-claim-writer` — a `.recovery-claim.json` write outside the
   controller.

For a justified exception, add the path to
`tools/task-recovery-ownership-allowlist.txt` with a `# reason`, or suppress one
line with `// allow-task-recovery-ownership: <reason>` (`#` in shell).
