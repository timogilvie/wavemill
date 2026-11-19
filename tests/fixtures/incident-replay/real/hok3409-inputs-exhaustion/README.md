# HOK-3409 / HOK-3231 / HOK-3505: task-input exhaustion silent park

Sanitised evidence for the task-input preparation silent park HOK-3505 fixes.
Issue ids are rewritten to `HOK-FIXTURE-1`; operator paths are `~`.

## Shape

HOK-3409 reached planning with only the raw issue text. The monitor's
`prepare-task-inputs` tracked job ran expansion recovery three times on
2026-11-16; each `expand-issue.ts` run was killed by the handshake timeout
(the recovery log ends `Terminated: 15`, recorded as `expand-issue-timed-out`).
The Observer recorded the failed jobs (`job_failed`, `no_result_file`).

Before HOK-3505 the exhausted `expansion-recovery-job` bucket wrote a private
`.task-inputs-failure.json` marker and a raw `blocked inputs_preparation_failed`
hook. Neither is an inbox item, so planning sat at `running` with no operator
signal until the state-invariants I1-progress detector fired over an hour later.

After HOK-3505 the exhaustion branch calls `escalate_operator_attention
<feature_dir> exhausted expansion-recovery-job`, which writes one
`.needs-attention` marker with basis `exhausted:expansion-recovery-job`.

## Files

- `incident.json` — `tools/incident-to-fixture.ts --input 33485219c636…
  --expect escalated` output for the recorded failed-job incident (journey
  pinned to `inputs-exhaustion`). Kept in this subdirectory because the
  top-level replay harness allows one fixture per `rootCauseClass`.
- `expansion-outcomes.json` — the three recorded expansion outcomes and the
  oracle. The third job's finish time comes from the job result file's mtime.

## Oracle

`tests/task-inputs-gate.test.sh` (section 4b) replays the three outcomes
through the real `ensure_task_inputs_ready` / `prepare_task_inputs_gate` and
the real `escalate_operator_attention`: exactly three job launches, one
`.needs-attention` marker with the `exhausted:expansion-recovery-job` basis,
no `.task-inputs-failure.json`, and no raw `blocked` hook. On the base the
marker is never written.
