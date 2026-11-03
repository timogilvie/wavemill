# Queue metrics derivation (HOK-3340 / MQ-1.4)

**Module:** [`shared/lib/queue-metrics.ts`](../shared/lib/queue-metrics.ts)
**Event log:** [`shared/lib/queue-events.ts`](../shared/lib/queue-events.ts)
**Schema:** [`shared/schemas/queue-lifecycle-event.schema.json`](../shared/schemas/queue-lifecycle-event.schema.json)
**Version string:** `queue-metrics/v1` — stamped on every derived result.

## Why

HOK-2895 shipped `wall_clock` including queue idle, inflating a merged
task's measured latency by ~96×. The root cause was that boundaries
(where did the queue end, where did CI start?) were redefined per site.
This module consolidates those boundaries so every reader — MQ-0.1
baseline re-run, MQ-T6 certification metrics, dashboards — agrees on
what "queue wait" means.

## One contract, two surfaces

- **Pure derivation.** `deriveQueueMetrics(events, options?)` takes an
  array of validated queue events (as returned by
  `readQueueEvents`) and returns one `QueueMetricsResult`. No I/O, no
  clock reads, no environment access. Recomputable at any time.
- **I/O wrapper.** `deriveQueueMetricsForPr(prNumber, repoDir, options?)`
  resolves the PR's merge-lane state dir and calls the pure function.

This mirrors `nativeStageTimeSplit` / `resolveNativeStageTimeSplit`
(HOK-3380) — pure core testable in isolation, I/O isolated at the edge.

## Metric → event boundaries

Every boundary is defined in one place: the module-level JSDoc of
`queue-metrics.ts`. The contract table is reproduced here for reviewers
who land on the docs first.

| Metric | Start event | End event |
| --- | --- | --- |
| `queueWait` (per cycle) | `enqueued` | next `candidate_prepared` |
| `ciRun` (per attempt window) | `candidate_prepared` | last `check_run_completed` before the window closes |
| `repairLoop` (per cycle) | `ejected` or `abandoned` | next `enqueued` |
| `timeToLand` | first `enqueued` | `merged` |
| `attemptsToLand` | count of `candidate_prepared` events | — |
| `ejections` | count of `ejected` + `abandoned` events | — |
| `reruns` | count of `rerun_requested` events | — |

An attempt window closes at the next `candidate_prepared`, `merged`,
`ejected`, or `abandoned` — whichever comes first. The attempt's
`seconds` is the time from its `candidate_prepared` to the last
`check_run_completed` inside the window; if no `check_run_completed`
occurred, `seconds` is `'unknown'`.

## Modeling decisions (documented once, not per-site)

1. **No explicit `check_started` event.** `candidate_prepared` is emitted
   at the top of `executeMerge()` immediately before rebase/checks, so
   it is the nearest real proxy for "first candidate check start".
2. **`candidateId` is unpopulated.** No real wavemill call site sets it,
   so attempts are segmented by consecutive `candidate_prepared` events
   rather than grouped by candidate id.
3. **Two "left without landing" event types.** `ejected` (tend/mill
   eligibility disagreement) and `abandoned` (merge attempt failed
   during rebase/checks/ready/merge) are modeled as a **union** for the
   repair-cycle boundary. The schema does not distinguish them for this
   purpose, and both represent the same observable fact.
4. **Missing vs. zero.** An **empty / absent** event log makes every
   metric `'unknown'`, never `0` (HOK-2895 regression). A **populated**
   log that reports zero ejections reports `ejections: 0` — a real fact,
   not a missing measurement.

## Cost / duration join (optional)

The event schema carries no durations or tokens. The one cost engine is
`session-ownership.ts` + `sdk-task-cost/meter.ts` (CLAUDE.md: "Never add
a second cost engine"). Callers supply the join data they already have:

```ts
deriveQueueMetrics(events, {
  ciCheckDurations?: { name, startedAt, completedAt, durationSeconds }[],
  repairCostEntries?: { sessionRef, kind, startedAt, endedAt, costUsd, tokens }[],
});
```

`ciComputeMinutes` is the sum of each `durationSeconds` clipped to any
CI-run window, converted to minutes. `repairTokens` and `repairCostUsd`
attribute the full row to any repair cycle it overlaps (sessions are
indivisible units of work for the cost engine; this module does not
slice them). Omitting the option leaves each scalar `'unknown'`.

## Ad-hoc calculations earmarked for follow-up migration (HOK-3337)

All in `shared/lib/cost-baseline/`. They read label-ledger intervals and
lane `progress.json`, which both predate the event log (ledger from
2026-10-13; event log only from HOK-3339 onward). Swapping them
wholesale today would lose coverage of every historical baseline task.

- `cost-baseline/dimensions.ts::computeQueueWait` — `wm:ready` label-ledger intervals.
- `cost-baseline/dimensions.ts::computeCi` — eval-record `ciChecks` durations.
- `cost-baseline/dimensions.ts::computeTaskDimensions` — session spans + `mergeAt()`.
- `cost-baseline/integration-failures.ts` — `wm:merging` label applications; lane `progress.json` counters.

MQ-0.1 re-run (a separate issue) is the natural place to migrate these
once there is enough live event-log data to compare against the existing
baseline. This issue deliberately lists them rather than swapping, per
its acceptance criterion ("replaces… or lists them for follow-up
migration").

## Validation

- `shared/lib/queue-metrics.test.ts` — one `test()` per golden fixture
  in `shared/lib/fixtures/queue-metrics/`, plus edge cases for the pure
  function (out-of-order timestamps, negative durations, join present
  vs. absent).
- `npx tsx tools/check-queue-event-writers.ts` — confirms this module
  does not locally redefine `QueueLifecycleEvent` or `QueueEventType`
  (the one-writer guard, HOK-3339).
