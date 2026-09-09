---
title: Config Files
---

## Overview

Wavemill configuration has two file layers plus environment variables:

- `.wavemill-config.json`: shared repository defaults, usually committed.
- `.wavemill-config.local.json`: developer-specific overrides, should stay gitignored.
- Environment variables: best for secrets and ephemeral environment-specific overrides.

`sync-config` writes `.wavemill-config.json` only. It never modifies `.wavemill-config.local.json`.

## Precedence at Runtime

At runtime, Wavemill loads config in this order:

1. `.wavemill-config.json` (base)
2. `.wavemill-config.local.json` (deep-merged override when present)
3. Environment variables (where a code path supports env overrides)

Merge behavior for local overrides:

- Nested objects are deep-merged.
- Arrays replace the base array.
- Primitive values in local override win.

## Effective Per-Task Configuration

Already-launched tasks use the persisted `lifecycle.launchContract` in
`.wavemill/workflow-state.json` before mutable current config. Legacy entries
fall back through `.wavemill/runtime-env/<issue>.json`, user config, repository
config, and built-in defaults.

Status and Observer output include the winning value and source for base branch
and confirmation policy. When repository config disagrees with the effective
task value, Wavemill reports that as informational drift so intentional
per-session overrides are visible without being treated as corruption.

`WAVEMILL_EFFECTIVE_CONFIG_LEGACY=1` is a rollback adapter that bypasses launch
contract reads while preserving the stored contract and provenance.

### Cross-PR Revert Checker

`tools/check-cross-pr-reverts.ts` resolves the integration branch in this order:

1. `--integration-ref <ref>` when the CLI argument is non-empty.
2. `.wavemill-config.json` / `.wavemill-config.local.json` `integration.integrationBranch`.
3. Default `auto/integration`.

If the resolved integration ref does not exist in the repo, the checker skips gracefully instead of blocking ready on a config lookup failure.

### Pre-PR Verification Drift

`prePrVerification` maps CI job names to locally runnable verification commands. Repositories can use `source: "explicit"` when CI cannot query GitHub branch protection, but the explicit list must still cover every CI test job that has a local equivalent.

`tools/check-ci-verification.ts` scans `.github/workflows/*.yml` and reports `workflow-uncovered` when a workflow job is not listed in `requiredChecks`, `remoteOnlyExceptions`, or `nonEnforcedJobs`. Configure `driftValidation.blockOnUnmapped: true` to hard-fail preflight when CI adds a job without a local recipe, while reserving `nonEnforcedJobs` for aggregators or PR-context gates that are intentionally outside the local contract.

### Backstage Observer Service

The dedicated Backstage Observer pane is opt-in and only runs when both
`integration.enabled` and `integration.useMillSession` are true. Enable it in
`.wavemill-config.json` or `.wavemill-config.local.json`:

```json
{
  "observer": {
    "enabled": true,
    "intervalSeconds": 120,
    "heartbeatStaleSeconds": 300,
    "maxLogLines": 240,
    "retention": {
      "maxSnapshots": 50
    }
  }
}
```

- `enabled` defaults to `false`; when false, Wavemill creates no Observer pane
  or Observer health state.
- `intervalSeconds` controls the `wavemill observer --loop` cadence.
- `heartbeatStaleSeconds` controls when the mill monitor treats the service as
  stale and attempts its single bounded restart.
- `maxLogLines` bounds recent mill log evidence inspected on each pass.
- `retention.maxSnapshots` is reserved for bounded snapshot persistence; the
  current service writes only redacted heartbeat and finding counts to
  `.wavemill/backstage-health.json`.

### Harness Retention Replay

`harness.retention` controls the fixed held-out replay suite used to detect
harness regressions. The tolerance default is `1`, so a candidate may introduce
at most one baseline-pass to candidate-fail regression before enforce mode
blocks.

```json
{
  "harness": {
    "retention": {
      "enabled": true,
      "mode": "shadow",
      "tolerance": 1,
      "suitePath": "shared/fixtures/harness-replay/harness-retention-v1/manifest.json",
      "reportDir": ".wavemill/harness-replay/reports"
    }
  }
}
```

Use `shadow` for the mandatory two-week rollout on `auto/integration`; it
retains reports and blocks nothing. Use `enforce` only after publishing the
shadow rejection rate. Enforce mode fails closed when `D` exceeds tolerance or
when the suite/baseline evidence is invalid.

See `docs/harness-retention-replay.md` for suite ownership, hold-out rules,
probe requirements, and refresh policy.

### Challenge Winner Handling

`challenge.autoMergeWinner` controls what tend does after a decisive challenge
comparison identifies a winner.

- Default: `false`.
- `false`: tend holds the winning PR for manual action. With the current
  TypeScript tend controller, the identified loser can still be closed or
  cleaned up once the comparison is decisive.
- `true`: tend lets the winning PR enter the merge path automatically and
  closes or cleans up the loser.

### Cleanup Episodes

Terminal cleanup episodes are enabled by default. They persist cleanup evidence
in `.wavemill/workflow-state.json`, skip unchanged retained cleanup evidence,
and retry transient cleanup failures with bounded backoff:

```json
{
  "cleanup": {
    "episodes": {
      "enabled": true,
      "maxAttempts": 5,
      "backoffBaseSeconds": 30,
      "backoffCapSeconds": 900,
      "jitterRatio": 0.2
    }
  }
}
```

Set `cleanup.episodes.enabled` to `false` only as a rollback for scheduler
gating. Existing cleanup evidence is preserved, and retained terminal tasks
still do not consume active mill slots.

## Recommended Placement by Category

Use `.wavemill-config.json` for:

- Team-wide defaults that should be consistent for everyone.
- Shared relative repo paths that apply across developers.
- Non-model workflow policy such as challenge rates, router exploration knobs,
  budgets, task selection, and max parallelism.

Use `.wavemill-config.local.json` for:

- Developer-specific challenge rate or other non-model workflow preferences.
- Consent/data-submission preferences when they are personal opt-in choices.
- Machine-specific values that should not be committed.

Use environment variables for:

- API keys, credentials, and tokens.
- CI-specific runtime values.
- Temporary shell-session overrides.

Never store secrets in either config file when an environment variable or secret manager is available.

## Model Ownership

Model membership, model-to-agent mapping, provider model pools, and native
certification metadata are owned by Wavemill's global effective-model
projection. Repository config and local overlays must not define a different
model universe.

The following repo-local fields were removed in config version `1.5.0`
(August 5, 2026):

- `modelRegistry`
- `router.defaultModel`, `router.models`, `router.availableModels`, `router.agentMap`
- `challenge.models`, `challenge.comparisonModel`
- `providers.openrouter.models`, `providers.openrouter.stages`
- `providers.deepseek.models`, `providers.deepseek.stages`
- `nativeAgent.providers.*.models`
- runtime lookup under `.wavemill/native-agent-certifications/`

Run this before upgrading an existing repository:

```bash
wavemill config migrate-model-settings
```

The migrator inventories each removed field, explains the affected models or
behavior, validates that the global projection is usable, backs up the config,
and removes only the deprecated model-local settings. It does not move secrets.

### Native Read-Only Opt-In

Use `.wavemill-config.json` for the shared `nativeAgent.enabled`,
`nativeAgent.allowedPhases`, `nativeAgent.patchCoding.enabled`, and non-secret
provider credentials metadata (`enabled`, `apiKeyEnv`, `baseUrl`, `headers`).
Do not configure provider model allowlists in repo config.

Keep native provider secrets such as `OPENAI_API_KEY` and `OPENROUTER_API_KEY` in environment variables only.

`nativeAgent.patchCoding.enabled` is fail-closed and defaults to `false`. Setting it to `true` does not enable native patch coding by itself; Wavemill also requires a current certification artifact at `.wavemill/native-agent/patch-coding-certification.json`.

Coder routing has a third gate after repo opt-in and the smoke artifact: the
chosen provider/model pair must also have a current global phase certification
artifact whose phase satisfies `patch`. `WAVEMILL_NATIVE_CERTIFICATION_ROOT`
can override the global certification store for tests and controlled operator
environments.

See [Native Read-Only Runtime](./native-read-only-runtime.md) for the exact config shape and phase examples.

### Router Exploration Sampling

`router.exploration` converts deterministic argmax model selection (stage-aware
KNN routing and the Layer 3 policy resolver) into stochastic sampling so newer
or undersampled models keep receiving routing traffic:

```json
{
  "router": {
    "exploration": {
      "enabled": true,
      "mode": "epsilon",
      "rate": 0.15,
      "temperature": 0.7,
      "topK": 3,
      "ucbConstant": 0.05,
      "priors": {
        "enabled": true,
        "blendSamples": 10
      }
    }
  }
}
```

- `enabled` (default `false`): when off, sampling is byte-identical to argmax.
- `mode`: `epsilon` picks a non-argmax candidate from the top-K window with
  probability `rate`; `softmax` samples the top-K window weighted by
  `exp(score / temperature)`.
- `topK`: candidates eligible for sampling per stage (minimum 2, default 3).
- `ucbConstant` (default `0` = off): adds a UCB-style uncertainty bonus
  `c * sqrt(ln(totalObservations + 1) / max(support, 1))` to each candidate's
  ranking key, so undersampled models get a temporary boost that decays as
  eval records accumulate. The bonus affects selection order only — reported
  expected success stays bonus-free.
- `priors` (default disabled): seeds every eligible stage model into the
  stage-aware candidate set even with zero eval records, scored by its
  registry quality prior. Empirical KNN scores blend in as evidence
  accumulates: weight `min(support / blendSamples, 1)` — zero records means
  pure prior, `blendSamples` records means pure empirical. This is how a
  brand-new registry model (e.g. a freshly released frontier model) becomes
  routable before any challenge runs produce eval data for it.
- `newModelBoost` (default off, `multiplier: 1`): models whose registry
  `releasedAt` falls within `windowDays` (default 45) get their exploration
  sampling weight multiplied by `multiplier`, decaying linearly to 1.0 at the
  window edge — a temporary thumb on the scale while a new model accumulates
  data, never a permanent one. The same window also makes the challenge
  scheduler prioritize recently released under-covered models over older
  deliberately-unused ones. Set `releasedAt` per model in the registry
  defaults in the global model registry.
  Boosted picks are marked `[recency-boosted]` in decision reasoning.

Sampling, the UCB bonus, and prior seeding all operate inside the
already-filtered candidate set (global effective model projection, capability
constraints, disabled models, DeepSeek opt-in), and a sampled stage-aware combination that would
exceed `maxCostUsd` reverts to the exploit selection. Decisions record
explore-vs-exploit attribution in `reasoning` and an `exploration` field that
is persisted to route artifacts. Zero-record candidates get cost estimates
from the pricing table instead of reporting zero cost.

### Router Coverage Targets and Diversity Report

`router.coverage` configures the diversity report
(`npx tsx tools/router-diversity-report.ts`):

```json
{
  "router": {
    "coverage": {
      "minRecordsPerModelStage": 15,
      "maxStageShare": 0.7,
      "window": 50
    }
  }
}
```

- `minRecordsPerModelStage`: eval records each model should accumulate per
  workflow stage; cells below the target are starred in the report.
- `maxStageShare`: dominance threshold — the report warns when one model
  exceeds this share of any stage over the window.
- `window`: most recent eval records used for stage-share and routing-mode
  breakdowns (coverage counts are cumulative).

The challenge scheduler also consumes per-model-per-stage counts: `new-model`
recommendations target the least-covered (model, stage) cell, and
`low-data-stage` recommendations pick the least-tested model for the starved
stage specifically.

## Challenge Selection Health

`challenge.selectionHealth` defaults on and keeps temporary state in
`.wavemill/challenge-selection-health.json`. It reserves selected challenger
models before eval records exist and temporarily opens provider/model circuits
after typed transient upstream failures. It does not edit the permanent disabled
model registry.

```json
{
  "challenge": {
    "selectionHealth": {
      "enabled": true,
      "reservation": {
        "selectionTtlSeconds": 900,
        "inflightTtlSeconds": 7200
      },
      "circuit": {
        "transientFailureThreshold": 3,
        "windowSeconds": 1800,
        "cooldownSeconds": 900
      }
    }
  }
}
```

Set `challenge.selectionHealth.enabled` to `false` to restore legacy challenge
selection behavior. Inspect current temporary state with
`npx tsx tools/challenge-selection-health.ts status --repo-dir . --json`; clear a
demonstrably stale entry with `clear --provider openrouter --model MODEL` or
clear all temporary health state with `clear --all`.

## Local Paths Guidance

- Relative paths shared by the team can live in `.wavemill-config.json`.
- Absolute machine paths (for example `/Users/...` or `C:\\Users\\...`) should stay local-only or env-backed.

## Ready Stage Settings

`ready.watchdog` controls how mill reacts to stale or failing ready states:

- `thresholdMinutes`: stale-local-state threshold before the watchdog intervenes.
- `autoRecover`: allows local stale-state cleanup when GitHub is clean and green.
- `timeoutSeconds`: watchdog subprocess timeout per monitor tick.
- `stableFailureConsecutivePolls`: identical safe failures required before queueing remediation.
- `stableFailureEscalateAfterPolls`: identical unsafe failures required before escalating to operator attention.
- `safeRemediationCategories`: allowlist for watchdog-driven remediation, defaulting to `lint`, `type`, `test`, `build`, `migration-chain`, and `alembic`.

`ready.migrationChecks` controls automatic migration validation:

- `enabled`: master switch for automatic migration integrity checks.
- `autoDetectAlembic`: auto-enables `migration-chain-integrity` when `alembic/versions/` exists and `ready.checks` is otherwise empty.
- `baseRefresh.enabled`: fetches the PR base branch before local migration validation.
- `baseRefresh.timeoutSeconds`: timeout for that fetch.

These settings are additive and optional. Repositories that do nothing keep the defaults.

## How sync-config Interacts with Config Files

`npx tsx tools/sync-config.ts` syncs canonical fields into `.wavemill-config.json`.

- It may add missing canonical fields with canonical default values.
- It does not copy values from `.wavemill-config.local.json` into shared config.
- In `--dry-run`, it reports local-only missing fields to help you decide if a shared default should be added manually.
- If a local-only missing path appears secret-like or host-specific and overlaps a pending canonical addition, write mode aborts so you can make an explicit decision.
