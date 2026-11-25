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
  Production claims validate the authoritative task run and settled outcome
  under the shared workflow-state lock before writing the claim. Dispatch
  carries that run through `WAVEMILL_EXPECTED_RUN_ID`. The executor acknowledges
  its claim token on return; the next distinct obligation may then claim, while
  duplicate evidence and late acknowledgements cannot replace another action.

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
| Is reassessment due, and was a harness tool holding the loop? | `task-progress.ts` (`stalled`) plus `openHarnessToolCall` (`stage-time-split.ts`); rule 4a composes them |
| How many retries are left; backoff? | `bounded-retry.*` (the caller gates; the controller reads the verdict) |
| Which model/agent does a coding retry replay? | `execution-contract.ts` + `resolveModelAgent` (replayed, never re-chosen) |
| Raising operator attention | `operator-escalation.*` (one step) |
| Cost / attribution | SDK-owned; the controller records the action, not a price |

## One refusal outcome (HOK-3512)

"The saved route cannot launch: what now?" has one answer. Every caller that
replays a saved route — the failed-stage path (`_monitor_claim_failed_stage_action`),
the window-lost path and each recovery launch surface
(`_restore_inflight_task_window_if_missing` → `_recovery_contract_refused`) —
puts the validator's full result (`ok`, `reason`, `detail`, `contract`) on
`RecoverySnapshot.contract`. Rule 4b classifies a refusal through
`classifyFailure` as `recovery_contract_unavailable` (terminal allowlist:
recovery replays the route, so retrying cannot change it) and returns a
claimed `escalate` with a `policy-terminal` basis; `_execute_recovery_escalation`
calls `escalate_operator_attention`, naming the stage, model and validator
reason. The item expires on a new head or an operator event —
`reroute-task.ts` records a `reroute` operator event — and the stage then
relaunches under its bounded retry. A refusal is never a `wait`: every wake a
controller wait names must have a producer (`RECOVERY_WAKE_PRODUCERS`), and
no caller writes a private `stopped` state, failed result or hook for it.

A deadline, a missing acknowledgement, or an Observer outage is **not** a
model/provider failure, does not steal ownership, and does not terminate work.
Explicit human holds survive restart and retry.

Saved-route recovery carries the complete `execution-contract.ts` validation
result, including refusal reason and detail. A positive refusal enters the
failure policy's `recovery_contract_unavailable` terminal cause and the existing
operator escalation step; it cannot wait on an `execution-contract-available`
event without a producer or author private stopped state. A failed validator
read retains bounded retry and cannot downgrade an existing terminal failure.
Completion, human holds, stale identity, uncertain effects and live work keep
their precedence. Repaired route evidence and explicit operator releases change
the claim identity. An
applied acknowledgement remains deduplicated after its worker exits; only an
unapplied action may be reclaimed on identical evidence.

Native stages are a consumer (HOK-3382). `RecoverySnapshot.reassessment`
carries the shared stall fact (`due`, `lastProgressAt`) plus the native
transcript's open harness tool call, resolved by the monitor from
`stage-agent-disposition`'s forwarded `progress`. Rule 4a sits before the live
disposition rule: an in-flight stage whose stall clock has fired and whose
transcript ends in an open tool call returns `retry-stage` with the
`stage-failure-<stage>` bucket and the failure kind derived from
`failure-policy` (`coding-exited-without-result` for coding, classified
`harness-fault` from the recorded hold evidence, never a model forfeit). With
no hold the model/provider is working and the action is `no-action` — the
model-time budget owns that case. Per HOK-3277 a due deadline means
"reassess", never automatic termination.

## Live hosting

The controller is hosted through Monitor's existing control loop and tracked
`task-recovery` async jobs; claim locks and execution run in the supervised worker,
not in the hot pass. Unit fixture hosts use the existing inline-check shim;
golden journeys run the actual async adapters. There is no separate stall daemon. The monitor's shell seams —
`maybe_retry_failed_stage`, `_stage_disposition_act`,
`ready_failure_classify_and_act` (and the consolidated
`_monitor_recover_failed_stage` helper) — are the controller's first adapters:
they compose the same authorities and route a failed stage through one seam.
`maybe_retry_failed_stage` routes every failed-stage caller, including Ready,
through the controller before the existing executor. `_stage_disposition_act`
also asks the same controller to consume completed results or respect waits.
They are not a second retry or escalation policy. Tend executes integration
actions and Observer supervises; neither gets a second task-retry or escalation
decider. HOK-3406 completed the migration: Observer is evidence-only — it emits
findings (branch-behind-base, recheck-loop, stuck-arm evidence) and holds no
executors, no `observer.autoFix` configuration and no private retry buckets.
Branch updates, retry resets and challenge-arm retirement run through the
controller and its existing executors (`updateBranchWithBase`,
`bounded-retry`, `recordArmTermination`).

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
3. `observer-auto-fix-import` — re-importing the deleted Observer auto-fix
   engine (Observer is evidence-only).
4. `observer-repair-bucket` — recreating `observer-update-branch`,
   `observer-ready-budget-reset` or `observer-forfeit-arm`.
5. `observer-executor-call` — `tools/observer.ts` calling
   `updateBranchWithBase`, `abortTaskInState`, `recordArmTermination`,
   `createStateDirRetry` or `runObserverAutoFixes` directly.
6. `observer-autofix-surface` — the removed `autoFixDryRun` /
   `getObserverAutoFixConfig` / `ObserverAutoFixConfig` surface returning to
   `tools/observer.ts`.
7. `contract-refusal-private-stop` — a private `stopReason =
   recovery_contract_unavailable` write or raw `blocked` hook for a refused
   saved route (HOK-3512).
8. `recovery-wakeless-wait` (`TASK_RECOVERY_WAKE_GUARD`) — a controller `wait`
   whose wake has no producer named in `RECOVERY_WAKE_PRODUCERS`.

For a justified exception, add the path to
`tools/task-recovery-ownership-allowlist.txt` with a `# reason`, or suppress one
line with `// allow-task-recovery-ownership: <reason>` (`#` in shell).

The supervisor slot includes task run, observed head/result, and known launch
identity. Registration carries the captured run; claims belong to the supervised
worker process. An older worker cannot occupy the replacement run's slot.
Stage completions use the shared stage-result run gate, with launch-stamped
identity preserved by the writer and conservative boundaries for legacy files.

Recovery claims are ownership records, not condition markers or timed leases.
Owner reclamation uses `state-lock.ts:isOwnerReclaimable`: only a matching
local host plus dead PID/start-time identity authorizes replay within a run.
A foreign host cannot be declared dead by inspecting its PID locally or by
waiting out a timer. An explicit host handoff starts a new task run through
the existing attempt identity primitive; that new run supersedes the old
claim and fences its continuations. Fresh current completion still reconciles
an unacknowledged effect independently of host. Tests cover the foreign-host
hold, current completion and replacement-run release. No `--expires-on`
marker can safely substitute for these ownership and run conditions.
