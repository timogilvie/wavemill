# Queue-metrics golden fixtures

These fixtures drive `shared/lib/queue-metrics.test.ts`. Each scenario is:

- `<name>.jsonl` — a line-per-event `.queue-events.jsonl` stream (the same
  shape `shared/lib/queue-events.ts::readQueueEvents` returns after
  deduplication).
- `<name>.expected.json` — the `QueueMetricsResult` the derivation must
  return for that stream.

Fixtures are hand-authored, not recorded — the live event log is still
sparse (HOK-3339 shipped recently and `candidateId` is never populated by
real call sites). Timestamps are deterministic and monotonically increasing
so expected durations are exact.

## Scenarios

| Fixture | Scenario |
|---|---|
| `clean-single-pass.jsonl` | enqueued → candidate_prepared → check_run_completed → merged. One queue-wait cycle, one attempt, no ejections, timeToLand defined. |
| `rebase-and-rerun.jsonl` | mid-attempt rebase_performed + rerun_requested then checks complete and merge. Reruns counted, still one attempt. |
| `one-ejection-then-merge.jsonl` | enqueued → candidate_prepared → ejected → enqueued → candidate_prepared → check_run_completed → merged. One ejection, two attempts, one repair cycle. |
| `abandoned-then-merge.jsonl` | abandoned (checks-failed) → enqueued → merge. One repair cycle driven by `abandoned`, not `ejected` — confirms union semantics. |
| `multiple-reruns.jsonl` | one attempt window with multiple `rerun_requested` events. Reruns summed correctly, attemptsToLand = 1. |
| `never-merged.jsonl` | enqueued → candidate_prepared with no terminal event. timeToLand = `'unknown'`, attempt still open. |
| `empty-log.jsonl` | empty file. Every metric `'unknown'`, counts `'unknown'`, NOT `0`. Direct HOK-2895 regression. |
| `duplicate-replay.jsonl` | the clean-single-pass stream with every line duplicated. After `readQueueEvents` dedup, result is identical to clean-single-pass. |
| `poll-tick-reaffirmations.jsonl` | `tend-controller.ts::selectNextCandidate` re-emits a fresh `enqueued`/`ejected` (distinct eventId) every poll tick a PR stays eligible/blocked. 3 redundant `enqueued` then 2 redundant `ejected` then 2 redundant `enqueued` collapse to one queue-wait cycle each and one repair cycle, not an inflated sum (HOK-2895 class regression inside this module). |
| `ejected-before-candidate-prepared.jsonl` | `enqueued` → `ejected` (no attempt ever started) → `enqueued` → `candidate_prepared` → merge. The first `enqueued` cycle closes `'unknown'` instead of reaching past the ejection to reuse the later `candidate_prepared` that belongs to the second `enqueued` — same inflation/misattribution class, caught by a one-pass sweep instead of an independent scan per start event. |
