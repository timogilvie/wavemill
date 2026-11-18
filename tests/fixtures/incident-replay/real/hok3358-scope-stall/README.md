# HOK-3358 / HOK-3231 / HOK-3422: Review scope stop silent stall

Sanitised evidence for the review-scope silent-stall class HOK-3457 fixes.
No local paths, real session ids, or operator-identifying details are kept.

## Shape

A native `review` stage ran and the reviewer agent reached the point where it
would have committed review fixes. Before committing, it ran the shared
`tools/check-review-scope.ts` guard and the guard refused the diff because the
reviewer's intended edits touched a path outside the declared task scope
(`shared/lib/wavemill-monitor.sh` in the original HOK-3358 incident, not
listed under the plan's Files to Modify).

Before HOK-3457 the guard printed the violation and the prompt told the agent
to "preserve the index, report the violation, and stop review-fix committing".
The reviewer exited, no typed finding was written, and
`decideReviewGateRemediation` never ran — the task sat idle until an operator
intervened.

After HOK-3457, `tools/check-review-scope.ts` writes `.review-scope-stop.json`
through `writeMarker` with `--expires-on head,operator-event`. The monitor
reads the marker in `stage_failure_decision` and synthesises a
`code-failure` decision with `failureKind: review-scope-stop`, which the
shared `stage-failure-review` bucket (HOK-2890) routes back to coding with
the offending paths in the next coding prompt.

## Files

- `scope-stop-marker.json` — the typed finding the producer writes before
  exit 1. Head sha is a stable synthetic id; the offending path and reason
  are copied from the real HOK-3358 incident.
- `expected-decision.json` — the `decideReviewGateRemediation` oracle: the
  agent-delivered disposition that routes the task back to coding.

## Oracle

Both fixtures are consumed by
`shared/lib/review-gate-remediation.hok3358-replay.test.ts`. The disposition
must be `code-failure` delivered to `agent`, carrying the typed
`scope-violation` finding — never `terminal` (the pre-HOK-3457 outcome that
produced the stall).
