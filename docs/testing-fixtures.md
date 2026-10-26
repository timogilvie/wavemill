# Real-state fixtures (`tests/fixtures/real-state/`)

**HOK-3225 (A5).** The state-reader test corpus is grounded in production
artifacts, not in invented builders. Every file under
`tests/fixtures/real-state/` is a sanitised snapshot of a live
`.wavemill/workflow-state.json`, its matching `/tmp/wavemill-${session}-${taskId}.hook`
files and the per-task stage-result JSON files. A schema-conformance test
re-validates them against `shared/schemas/workflow-task.schema.json` on every
CI run, so any shape drift between the writers and the schema fails before it
hits a reader (the HOK-3220 invariant, extended to real inputs).

## Fixture file format

Each fixture is one self-contained JSON document:

```json
{
  "$fixture": {
    "capturedAt": "2026-10-22T13:09:08Z",
    "phase": "ready",
    "notes": "ready phase, PR open, Ready verdict pass"
  },
  "workflowState": {
    "session": "wavemill-fixture",
    "started": "...",
    "updated": "...",
    "tasks": {
      "FIXTURE-1": { "...": "..." }
    }
  },
  "hooks": {
    "FIXTURE-1": { "state": "waiting", "writer": "agent", "...": "..." }
  },
  "stageResults": {
    "FIXTURE-1": {
      "planning": { "...": "..." },
      "coding":   { "...": "..." },
      "review":   { "...": "..." },
      "ready":    { "...": "..." }
    }
  }
}
```

`workflowState` is the exact shape `validateWorkflowState()` already handles,
so the conformance test is `validateWorkflowState(fixture.workflowState)`.
Hooks and stage results are keyed by the rewritten task id so a shell test can
pull them out with a stable jq path.

### Phases we cover

The capture set covers the eight phases a reader has to handle:

| Phase            | Example row                        |
|------------------|-------------------------------------|
| `planning`       | planning phase, no PR, awaiting user |
| `coding`         | coding phase, hook `working`         |
| `review`         | review complete, PR open             |
| `ready`          | Ready verdict `pass`                 |
| `merge-queued`   | `queueState: 'merge-candidate'`      |
| `merged`         | terminal, `workflowOutcome: merged`  |
| `challenge-pair` | primary + `_c` challenger           |
| `aborted`        | `abortedAt` / `abortedReason` set    |

## Sanitisation

The capture tool runs the whole envelope through one pure sanitiser
(`shared/lib/fixture-capturer.ts`). The sanitiser:

1. **Rewrites every issue/task id** through `task-identity.ts` helpers
   (`parseTaskId` + `challengerTaskId`). Primaries map to `FIXTURE-1`,
   `FIXTURE-2`, …; a challenger `HOK-X_c` becomes `FIXTURE-N_c`. No inline
   `_c` regex ever appears.
2. **Replaces absolute paths** — `process.env.HOME` → `~`, the repo path →
   `/workspace/wavemill-fixture`, any other `/home/<name>` → `~`.
3. **Redacts secrets** using the same regex set the writers' logs scrub:
   `ghp_…`, `gho_…`, `ghs_…`, `sk-ant-api03-…`, `xox[baprs]-…`,
   `sk-or-v1-…`, bare `Bearer …` tokens, `Authorization: token …`.
4. **Normalises the session** — the tmux session suffix becomes
   `wavemill-fixture`.
5. **Leaves timestamps, SHAs and branch names in place** — they're legitimate
   state and the schema doesn't constrain them.

> **Invariant.** Never add a new redactor outside `fixture-capturer.ts`. The
> sanitiser is one pass; adding a parallel one risks forgetting a key or an
> ordering between the two.

## Capturing a fresh fixture

```bash
npx tsx tools/capture-state-fixture.ts \
  --phase planning \
  --task HOK-3225 \
  [--task HOK-3225_c] \
  [--repo-dir .] \
  [--session wavemill] \
  [--out tests/fixtures/real-state/2026-10-22-planning.json] \
  [--notes "fresh planning handoff, no PR yet"]
```

- `--check` prints the sanitised fixture to stdout without writing (use this
  to inspect what you're about to commit).
- `--debug-id-map` adds the original → fixture map under `$fixture.idMap` for
  one-off debugging. Never commit a fixture with `idMap` populated — the
  defensive sweep below catches it.
- Default output path is
  `tests/fixtures/real-state/<YYYY-MM-DD>-<phase>.json`.

### Pre-commit sweep

```bash
grep -E 'HOK-[0-9]+' tests/fixtures/real-state/*.json | grep -v FIXTURE
grep -E 'ghp_|gho_|ghs_|sk-ant-|xox[baprs]-|sk-or-v1-' tests/fixtures/real-state/*.json
grep -F '/Users/' tests/fixtures/real-state/*.json
grep -F '/home/'  tests/fixtures/real-state/*.json
grep -F 'idMap'   tests/fixtures/real-state/*.json
```

Each of these should return nothing. If any of them does, re-run capture or
patch the file by hand before committing.

## Recapture cadence

- **Required**: whenever a PR edits a state writer. "State writer" means
  anything matching `save_task_state`, `state_mutate`,
  `task_state_mutate_existing`, a `mutateWorkflowState` call site, a hook
  writer in `shared/hooks/`, or the schema itself in
  `shared/schemas/workflow-task.schema.json`. The PR author recaptures the
  touched phases in the same PR.
- **Default**: monthly, on or near the first Monday. Tracked as a labelled
  Linear issue so somebody owns it.

## Rotation

- Capture new fixtures with today's date; name is
  `<YYYY-MM-DD>-<phase>.json`.
- If a phase would end up with more than two files, delete the oldest one in
  the same commit — the schema-conformance test enumerates every file in the
  directory, so stale ones add noise without adding coverage.
- Commit the capture tool, the new fixture files and (if a writer changed)
  the writer-related code together. One PR, one capture generation.

## Readers under test

Four readers run against these fixtures:

- `shared/lib/merge-labels.realstate.test.ts` — `deriveMergeLabel()`
- `shared/lib/ready-watchdog.realstate.test.ts` — `classifyReadyTask()`
- `shared/lib/tend-challenge-gate.realstate.test.ts` —
  `isNoPrSiblingStalled()`
- `tests/condition-reconciler-realstate.test.sh` —
  `condition_reconcile_task` under the real-state workflow-state file

Schema conformance is enforced by `tests/real-state-schema.test.ts`.

## Why "additive" schema drift is intentional

`workflow-task.schema.json` keeps `additionalProperties: true`. A fresh
writer field never fails the conformance test — that's deliberate; HOK-3220
documents the rule. What this test catches is **type drift**: a field
switching from `string` to `number`, an enum losing a value, a required field
being removed. Those are the regressions a reader cannot be defended against
without a schema that matches the writers' live output. Tightening the schema
to `additionalProperties: false` is a separate, deliberate ratchet.
