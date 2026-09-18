# CI Test Timing, Weighted Sharding, and the Balance Preflight

HOK-2939 rebalanced the required CI matrix so the `Shell and Unit Tests`
aggregator completes in well under five minutes. This document covers the
moving parts: timing artifacts, the weights manifest, the deterministic
partitioner, and how to refresh or extend any of them.

## How a test gets assigned to a shard

1. Suite membership comes from the runners' registration arrays — `TESTS` in
   `tests/run-unit-tests.sh`, `CUSTOM_TS_TESTS`/`CUSTOM_SH_TESTS` in
   `tests/run-custom-tests.sh`. These arrays remain the single source of truth;
   there is no separate per-shard list to keep in sync.
2. `tools/partition-tests.ts` reads the registered list (stdin), the weights
   manifest (`tests/ci-test-weights.json`), and the shard spec (`--shard N/M`),
   computes the full deterministic partition, and prints shard N's files.
   Every matrix leg computes the identical partition and selects only its own
   shard, so assignment is exactly-once by construction.
3. Partitioning is LPT greedy: files sorted by (weight desc, id asc) are each
   placed on the shard with the smallest running total (ties → lowest shard
   index). Assignment is stable for identical inputs (REQ-F2).
4. A test with no manifest entry gets the conservative `defaultMs` weight and
   is still assigned — **new tests need no manual weighting step**. A
   partitioner failure fails the shard loudly; there is deliberately no silent
   fallback, because one leg falling back to a different assignment than the
   others would drop or duplicate tests across the run.

`--shard 1/1` (the local default) short-circuits to the full list without
invoking the partitioner, so plain `bash tests/run-unit-tests.sh` has no new
dependencies.

## Unit/custom registration coverage

Scoped TypeScript tests (`*.test.ts` under `shared/`, `tools/`, and `src/`) are
covered by the union of the unit runner's `TESTS` array and the custom runner's
`CUSTOM_TS_TESTS` array. Each scoped TypeScript test must appear in exactly one
of those two arrays: unit for normal `node --test` execution, or custom for the
separate-process TSX harness.

`tools/check-test-registration.ts` enforces that union coverage during
preflight. It reports missing registrations, stale paths, within-suite
duplicates, and an explicit cross-suite overlap diagnostic naming any file that
appears in both `TESTS` and `CUSTOM_TS_TESTS`.

Shell tests follow the same exclusivity principle between the shell suite and
custom shell registry. `tests/agent-resolve-from-model.test.sh` belongs to the
shell suite only; `CUSTOM_SH_TESTS` remains checked for duplicate and missing
files when populated.

## Timing artifacts

Both runners accept `--timing-out FILE` (or the `TIMING_OUTPUT` env var) and
write one bounded JSON document per run:

```json
{"suite":"unit","shard":"2/7","runId":"33665710870","sha":"…",
 "generatedAt":"2026-09-02T00:00:00Z",
 "tests":[{"id":"shared/lib/foo.test.ts","elapsedMs":1234,"result":"pass"}]}
```

- The unit runner attaches `tests/lib/unit-timing-reporter.mjs` as a second
  `node --test` reporter; it aggregates per-file durations from the file-level
  `test:complete` events (with a per-case-sum fallback for plain-script files).
- The custom runner times each harness process in bash.
- CI passes `--timing-out` in the `unit`/`custom` jobs and uploads
  `timing-unit-shard-N` / `timing-custom-shard-N` artifacts (7-day retention,
  uploaded `if: always()`).
- Documents contain only test ids, durations, and results — never environment
  content — so they are structurally free of secrets.

## The weights manifest

`tests/ci-test-weights.json` is checked in:

```json
{"version":1,"defaultMs":30000,
 "sources":[{"runId":"…","createdAt":"…"}],
 "suites":{"unit":{"shared/lib/foo.test.ts":1234},"custom":{"…":5678}}}
```

Values are the **median of at least three samples** — never a single run's
wall clock. To refresh it from CI artifacts:

```bash
# Download timing artifacts from >=3 recent successful runs
gh run download <run-id> --dir artifacts/<run-id> --pattern 'timing-*'
# Merge medians into the manifest (deterministic output: sorted keys)
npx tsx tools/ci-test-timings.ts collect artifacts/*/timing-*/*.json
```

`collect` refuses to write when any test has fewer than three samples unless
`--allow-fewer` is passed (bootstrap escape hatch, warned loudly). Weights are
clamped to a minimum of 1ms; zero/negative values are rejected everywhere.

## The balance preflight (`tools/check-shard-balance.ts`)

Runs in `npm run test:preflight`. It reads the shard counts straight from
`.github/workflows/ci.yml` (the matrix and the check cannot drift), the
registered lists from the runners, and the manifest, then fails when:

- any registered test would be missing from or duplicated in the computed
  assignment (REQ-F1);
- the manifest is malformed, has non-positive weights, or references tests
  that no longer exist (stale entries are named);
- any shard's estimated total exceeds **130% of the median** shard estimate,
  unless a single named indivisible test alone exceeds the bound (REQ-F3) —
  that exception is printed and allowed.

`tools/check-test-registration.ts` additionally enforces scoped TypeScript
discovery-completeness across the unit/custom union and custom-harness hygiene
(no duplicate entries, no entries whose files are missing).

## Shard-count decision rule

The matrix uses the smallest shard count whose LPT-estimated maximum shard is
at or below ~240 seconds under the checked-in weights, leaving headroom
against the five-minute aggregator budget. Current counts: **unit 7, custom
3** (shell stays at 4 — its slowest shard was already ~160s). Two caveats the
estimates carry: unit file walls are measured under `node --test`'s internal
parallelism, so a shard's real wall clock is below its estimated sum; and a
single indivisible test can set a shard's wall-clock floor regardless of
balance — the cross-repo parity suite was split into five per-mode files for
exactly that reason. If the estimated max drifts up
(`npx tsx tools/partition-tests.ts --report`), bump the matrix in `ci.yml`;
the balance preflight and `run-custom-tests-shard.test.sh` pick the new count
up automatically.

## Measuring the aggregator (REQ-F6)

```bash
npx tsx tools/ci-test-timings.ts report <run-id> <run-id> …
```

prints per-run workflow-created → `Shell and Unit Tests`-completed durations,
the slowest jobs per run, and median/p90 across the given runs. Requirement:
median ≤ 5:00 and p90 ≤ 7:00 over ten representative successful PR runs.

## Setup caching: evaluated, not added

Measured CI setup cost is 7–9s per job (`setup-node`'s npm cache plus
preinstalled apt tools). A node_modules cache could save at most that while
adding staleness risk, so no new cache layer was added. The existing
`setup-node` cache already has the required fallback semantics (REQ-F7): a
cache miss simply makes `npm install --ignore-scripts` slower, and test
selection never reads cached state, so cache health cannot change selection
or outcomes.

## Rollback

Revert the `ci.yml` matrix and the runners' partitioner blocks to restore the
previous 4-shell/3-unit/single-custom layout. The timing tooling is harmless
on its own and can stay to diagnose the legacy layout; no repository data
needs deleting.
