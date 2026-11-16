---
title: Queue-state vocabulary
---

# Queue-state vocabulary

`shared/lib/merge-queue.ts` `MERGE_QUEUE_STATES` / `mergeLanePosition()` /
`tools/check-queue-state.ts` (HOK-3453).

A Ready result's `artifacts.queueState` answers "where is this PR in the merge
queue?". The monitor (`shared/lib/wavemill-monitor.sh`) is its only writer.
Its values are declared once, in `MERGE_QUEUE_STATES`:

| Value | Meaning |
| -- | -- |
| `ready` | Ready passed against the current base; tend may select it. |
| `ready-stale` | Ready passed, then main or the PR head moved before selection. |
| `merge-candidate` | Tend selected the PR as the next one to merge. |
| `merge-needed` | Ready passed but the session has no tend merge consumer (HOK-3102). |

`shared/schemas/stage-result.schema.json` declares the same enum for
`artifacts.queueState`, so a stage-result write carrying any other value fails
validation. `stage-result.ts` `ReadyArtifacts.queueState` imports the type.

**Readers decide by name.** "Is this PR in the merge lane?" is
`mergeLanePosition(queueState, readyStatus)`: `tend-lane`, `merge-needed` or
`not-in-lane`. The Ready watchdog treats `tend-lane` as expected waiting and
`merge-needed` as an operator item (never lane-waiting, never auto-recovered).
The observer raises behind-base severity for both when labels are unknown.

**Absent is one rule.** No recorded value means `ready` on a completed
pass/warn result and nothing otherwise. Shell readers get that from
`ready_result_queue_state` in `shared/lib/wavemill-common.sh`.

**Never write a `queueState` literal outside `MERGE_QUEUE_STATES`.** Remove a
value with `queueState: null`. A new value is added to the list and the schema
enum in the same PR, with an explicit `mergeLanePosition` branch.
`tools/check-queue-state.ts` (preflight) fails on a shell or jq literal write
of an undeclared value.
