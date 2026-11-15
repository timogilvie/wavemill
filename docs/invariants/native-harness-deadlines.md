# Native harness deadlines (HOK-3382)

**Rule.** No native stage has a private deadline for harness time. The
model-time budget (`maxModelTimeMs`, budget kind `model_time`) is the loop's
only clock. A hung harness — a tool that wedges past its per-call timeout, or a
host too overloaded to let the session finish — is reassessed by the recovery
controller from the shared progress clock (`task-progress.ts`). Per-call tool
and process timeouts are allowed: they bound one call, not the stage.

Guard: `tools/check-native-harness-deadlines.ts`.

## Why

Native coding used to be bounded by an elapsed wall clock that also covered
harness tool time. HOK-3381 changed what the clock measures: it now charges
**model-attributable** time and pauses while a harness tool executes
(`shared/lib/native-agent/loop.ts`). That is the right budget for "did the
model use too much time?", but by construction it cannot bound a wedged tool.

The 2026-11-01 incident (HOK-3374) made the difference visible: a coding agent
lost attempts to `run_tests` on a host with load average 40–80, and a
time-based backstop did not exist for the harness side. The old name
(`maxWallClockMs`) also invited exactly the wrong fix — charging that time to
the model, or adding a second elapsed timer.

So the responsibility is split, once:

| Question | Owner |
| --- | --- |
| Did the model use too much time? | `LoopBudget.maxModelTimeMs` (`model_time`, stop reason `model_time_limit`) |
| Is the agent still progressing? | `shared/lib/task-progress.ts` (`stalled`) and the stage-agent disposition |
| Is reassessment due, and whose time was the stall? | `shared/lib/task-recovery-controller.ts` rule 4a |
| What happens after? | `failure-policy.ts` + bounded retry |

Rule 4a reads the transcript for an **open harness tool call**
(`openHarnessToolCall` in `shared/lib/native-agent/stage-time-split.ts`). When
the stall clock has fired and a tool call is still open, the failure classifies
as `harness-fault` and retries through `stage-failure-<stage>`. With no hold,
the model/provider is working and the loop budget owns it — the controller does
nothing.

## What the guard forbids

1. **The misleading budget name**: `maxWallClockMs`, `wall_clock_limit`, or a
   `'wall_clock'` kind literal inside a native stage's source. Only the legacy
   normalizer (`budget-exhaustion.ts`) and the certification artifact boundary
   may spell it: certification artifacts are identity-hashed, and renaming
   their fields would un-certify the fleet; history must keep parsing.
2. **A private elapsed stage deadline**: an elapsed-since-start comparison that
   gates a stage, `AbortSignal.timeout(...)`, or a `setTimeout(...)` that
   aborts a run, in a native stage file. Durations recorded for measurement
   (`LoopResult.wallClockMs`, usage fields) are not deadlines and do not
   match.

## Suppression

Use `// allow-native-harness-deadline: <reason>` on the line or the line above,
and add a reasoned allowlist entry only when the occurrence is genuinely a
per-call timeout or a lock wait. The allowlist ratchets: it only shrinks.
