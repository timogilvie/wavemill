# Real incident replay fixtures (HOK-3231)

These fixtures are converted from `.wavemill/incidents/<fingerprint>.evidence.jsonl`
by `tools/incident-to-fixture.ts`. Each one carries the sanitised observation
timeline the detectors recorded for one representative incident per
`rootCauseClass`, with an expectation oracle derived from the timeline alone.

See `shared/lib/incident-fixture-converter.ts` for the schema and the plan
at `features/c3-replay-real-incident-evidence-as-test-fixtures/plan.md` for
the design.

## Provenance

- Issue and task IDs are rewritten to `HOK-FIXTURE-<n>` (keeping `_c`); the
  original ids never land in-tree.
- Operator home / repo paths are redacted to `~` / `/workspace/wavemill`.
- Secrets (API keys, bearer tokens) are stripped via `shared/lib/fixture-capturer.ts`.
- Long worktree slugs are collapsed to `features/<fixture-slug>`.
- The incident's SHA-256 fingerprints are kept as provenance (they are not
  sensitive and let an auditor correlate back to the source corpus).

## Regenerating

Operator CLI (reads the operator's `.wavemill/incidents`, writes here):

```bash
npx tsx tools/incident-to-fixture.ts \
  --cluster --top 15 \
  --incidents-dir /path/to/.wavemill/incidents \
  --force
```

To pin a specific fingerprint (for example, for an incident-fix PR):

```bash
npx tsx tools/incident-to-fixture.ts \
  --input <fingerprint> \
  --expect merged \
  --incidents-dir /path/to/.wavemill/incidents
```

`--check` writes nothing and prints the proposed fixture to stdout.

## Incident-fix rule

A PR that fixes an incident recorded in `.wavemill/incidents/` must include
that incident's evidence as a replay fixture under this directory, and the
fixture must fail on the base and pass with the fix. The process is
documented in `tools/prompts/coding-phase.md` and both review prompts.

## Format

Each fixture is a `schemaVersion: "incident-fixture/1"` object. Fields:

- `chain` — the canonical `rootCauseClass`.
- `incidents` — original SHA-256 fingerprints (provenance only).
- `source` — recorded lifecycle, category, timestamps, A5 state snapshot path.
- `initialState.task` — a sanitised task row for the sandbox.
- `initialState.jobs` — job-backed detectors (eval, cross-pr-guard,
  pr-ci-status) seeded from `job_state` evidence lines.
- `incident.metadata` — the detector's metadata, with store-owned keys
  stripped (`seenEventKeys`, `missedCycles`, `resolution`, `recurrence`,
  `lifecycleSync`, `linear*`).
- `observations[]` — the Observer cycle stream. `absentCyclesBefore` is the
  number of empty cycles between this observation and the previous one.
- `trailingAbsentCycles` — empty cycles after the last observation.
- `failure` — present for stage-failure chains; drives
  `runWithRecoveryLoop` as `{ stage, failureKind?, detail,
  survivesRelaunches: number | "never" }`.
- `convergence` — tick budget and `mustMerge | mustEscalate`.
- `journey` — the golden journey file (under `tests/journeys/`) that
  replays this chain end to end, or `null` with `journeyNullReason`.
- `expected` — the oracle: `occurrenceCount`, `lifecycleWhilePresent`,
  `finalLifecycle`, `resolutionReasonPrefix`, `recurrences`. These are
  derived from the retained observation timeline using the documented
  `IncidentStore` contracts; the harness never calls the production code
  to fill them in.

## Running

The harness runs both the incident-cycle replay and (when a `failure`
block is present) the stage-recovery replay:

```bash
npx tsx shared/lib/incident-replay-harness.test.ts
```

The custom-harness test fails if there are fewer than 15 real fixtures,
if two fixtures share a `chain`, or if a referenced `journey` file is
missing.
