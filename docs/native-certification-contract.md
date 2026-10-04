# Native Agent Certification Contract

This document defines the stable contract for native provider/model phase certification. It is intended as a reference for downstream consumer implementations in the harness, registry, router, and CLI.

## Overview

Before a native agent (provider + model pair) can be used in a given phase, it must hold a current certification artifact. The certification records which phase level was achieved, which suite version was run, per-scenario pass/fail outcomes, and when the artifact was issued.

All certification evaluation is **fail-closed**: missing, malformed, stale, wrong-version, phase-insufficient, and scenario-failed certifications all produce a structured `eligible: false` result. No evaluation path throws an exception.

---

## Storage Path Contract

```
<global-certification-root>/<provider>/<model>/<suite-version>.json
```

**Example:**

```
~/.wavemill/native-agent-certifications/anthropic/claude-sonnet-4-6/v2.json
```

### Path segment rules

- All three segments (`provider`, `model`, `suite-version`) must be non-empty strings.
- No segment may contain `/`, `\`, `.`, or NUL characters.
- Path traversal sequences (`.`, `..`) are rejected, not normalized.
- Model IDs with embedded slashes (e.g. some OpenRouter model IDs) must be re-encoded before use as path segments; this re-encoding is the caller's responsibility.

---

## Artifact Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `schemaVersion` | `2` (integer literal) | yes | Schema version for forward compatibility |
| `provider` | string | yes | Provider identifier (e.g. `anthropic`, `openai`) |
| `model` | string | yes | Model identifier (e.g. `claude-sonnet-4-6`) |
| `phase` | `"read-only"` \| `"patch"` \| `"workflow"` | yes | Certified phase level |
| `suiteVersion` | string | yes | Suite version that was run; matches the path segment |
| `certifiedAt` | ISO 8601 datetime | yes | When certification was completed |
| `expiresAt` | ISO 8601 datetime | no | Explicit expiry; takes precedence over derived TTL |
| `scenarios` | array of `ScenarioResult` | yes | Per-scenario outcomes |
| `knownLimitations` | string[] | no | Human-readable caveats for this certification |
| `totalRetryCount` | integer ≥ 0 | no | Aggregate retry count across all scenarios |

### ScenarioResult fields

| Field | Type | Required | Description |
|---|---|---|---|
| `scenarioId` | string | yes | Stable scenario identifier within the suite |
| `passed` | boolean | yes | Whether the scenario passed |
| `failureMessage` | string | no | Human-readable failure description |
| `retryCount` | integer ≥ 0 | no | Attempts before final result |

---

## Phase Ordering and Eligibility Semantics

Phases are ordered from least to most permissive:

```
read-only  <  patch  <  workflow
```

A higher certification **satisfies** all lower required phases. A lower certification **never** satisfies a higher required phase.

| Certified phase | Satisfies `read-only`? | Satisfies `patch`? | Satisfies `workflow`? |
|---|---|---|---|
| `read-only` | yes | **no** | **no** |
| `patch` | yes | yes | **no** |
| `workflow` | yes | yes | yes |

**Phase semantics:**

- **`read-only`**: The agent may read files, run searches, and inspect repository state. No mutations are permitted.
- **`patch`**: The agent may apply patches and make file mutations, in addition to all read-only operations.
- **`workflow`**: The agent may execute full workflow operations including multi-step state changes, in addition to all patch operations.

As of certification suite `v2`, `phase: 'patch'` artifacts are backed by deterministic patch-path safety scenarios, and `phase: 'workflow'` artifacts are backed by deterministic workflow-phase scenario coverage in the default certification harness.

---

## Suite-Version Invalidation

A certification is only valid for the exact `suiteVersion` it was issued against. If the required suite version changes (e.g. from `v1` to `v2`), all existing `v1` certifications are automatically invalid for new `v2` checks — they do not need to be deleted, they simply do not satisfy a `v2` requirement.

Downstream consumers must supply the current suite version when calling `evaluateEligibility` or `checkCertificationEligibility`. Mismatched suite versions return the `wrong-version` reason code.

## Patch-Coding Relationship

Native coding rollout uses three separate fail-closed gates:

1. Repo opt-in: `nativeAgent.patchCoding.enabled` in `.wavemill-config.json`
2. Runtime smoke gate: `.wavemill/native-agent/patch-coding-certification.json`
3. Provider/model phase gate: global certification artifact under `WAVEMILL_NATIVE_CERTIFICATION_ROOT` or the shared user root

The smoke artifact proves the local patch-coding runtime is enabled safely. The provider/model artifact proves a specific native provider/model pair passed the certification suite for the requested phase. For coder routing, the artifact phase must satisfy `patch`; for planner routing, it must satisfy `workflow`.

## Live Coding Canary (HOK-2943)

Deterministic certification is **necessary but not sufficient** for coding eligibility. A coding launch (any gate evaluation with `launchPhase: 'coding'`, or fail-closed inference from `requiredPhase: 'patch'`) additionally requires a fresh, live, identity-matching **live coding canary pass** embedded in the artifact as the optional `liveCanary` field.

The canary is a bounded live provider run in a disposable git repository that must:

1. Execute at least one **structured** `apply_patch` tool call through the production mutation tool path — assistant text containing `[apply_patch ...]` syntax produces no tool event and fails as `protocol_failure`.
2. Mutate the sentinel file to exact expected bytes (`wrong_mutation` otherwise).
3. Make no out-of-scope repository changes (`extra_repository_change` otherwise).
4. Write a `.coding-complete` completion artifact that passes the production completion normalizer (`missing_completion_artifact` otherwise).

### `liveCanary` Artifact Field

Compact, content-minimized evidence only — hashes, counts, repo-relative paths, and redacted short diagnostics. Never raw prompts, transcripts, credentials, or file contents. Key fields:

| Field | Meaning |
|---|---|
| `status` | `pass` \| `fail` \| `inconclusive` \| `skipped` |
| `isLive` | True only for a real provider run through the production runner. Injected/mocked/dry-run results record `false` and can never satisfy the gate |
| `provider`/`model`/`providerNativeId`/`identityFingerprint`/`catalogHash`/`suiteVersion`/`phase` | Full identity binding; any mismatch with the evaluating subject rejects the canary |
| `ranAt`/`expiresAt` | Freshness anchors. Default TTL is `LIVE_CODING_CANARY_TTL_DAYS` (14 days); the canary is valid strictly before expiry and invalid at or after it |
| `limits`/`usage` | Configured wall-clock/turn/tool-call/token/cost budgets and observed totals. `costUsd` is omitted (never recorded as zero) when pricing is unavailable |
| `reason`/`limitExceeded` | Stable failure reason and, for `budget_exceeded`, which limit fired |
| `evidence` | Structured mutation tool-call counts/names, expected/actual sentinel hashes, changed paths, completion artifact presence/hash |
| `lastInconclusiveAttempt` | Non-authoritative record of the most recent transient attempt that was not allowed to overwrite a valid pass |

Schema parsing is backward compatible: artifacts without `liveCanary` still parse (and keep granting non-coding phases), but coding eligibility fails closed with `missing_live_canary`. A present-but-invalid `liveCanary` makes the whole artifact malformed.

### Coding-Only Gate Reasons

| Gate reason | Meaning |
|---|---|
| `missing_live_canary` | No canary recorded, or the canary was `skipped` |
| `stale_live_canary` | The recorded pass is at/past its freshness boundary |
| `failed_live_canary` | The canary definitively failed (protocol, mutation, scope, artifact, or non-wall-clock budget) |
| `inconclusive_live_canary` | The last authoritative attempt was a transient provider error |
| `non_live_canary` | The recorded evidence was not produced by a live provider run |
| `live_canary_identity_mismatch` | Provider, canonical model, resolved upstream model, fingerprint, catalog hash, suite version, or phase does not match |

### Transient Failures, Retry, and Revocation

- 429/5xx/timeouts classify as `inconclusive` (`provider_transient_error`, or `budget_exceeded`/`wall_clock`) and remain ineligible. The runner retries transient attempts in a fresh disposable repository (bounded, default 2 attempts).
- An inconclusive attempt **never overwrites** a previous fresh identity-matching pass — the pass is preserved and the attempt is recorded as `lastInconclusiveAttempt`.
- A definitive failure (`protocol_failure`, `wrong_mutation`, `extra_repository_change`, `missing_completion_artifact`, non-wall-clock `budget_exceeded`) **revokes** the previous pass for that identity.
- Deterministic-only re-certification carries a still-valid previous pass forward so routine renewal does not silently revoke coding eligibility; stale/non-live/failed/mismatched previous evidence is dropped.

### Write-Side Guards

`validateCertificationForWrite` rejects canaries whose identity diverges from the owning artifact/subject, whose timestamps are implausible or inverted, or whose `detail`/`evidence` fields contain secret-shaped values, local absolute paths, or traversal segments.

### Re-Enable Procedure for Protocol-Failing Models

Models held on an explicit disabled list for live protocol failure (e.g. Scout, PR #1307) are **not** automatically re-enabled by a canary pass. Re-enable requires: (1) a fresh passing live canary for the current suite/identity, then (2) an explicit reviewed code change removing the model from the disabled list. The canary blocks re-enablement; it never performs it.

---

## TTL Policy

Default TTL: **60 days** from `certifiedAt`.

### Rationale for 60 days

- **30 days** was considered too frequent given the overhead of full certification runs and the low API churn rate for established providers.
- **90 days** risks staleness after provider API changes or model updates that may alter behavior within the certified scenario set.
- **60 days** is the chosen default; it balances re-certification cost against freshness risk.

### Precedence rules

1. If `expiresAt` is present on the artifact, it is used as the expiry boundary. The staleness check is `now >= expiresAt`.
2. If `expiresAt` is absent, the derived TTL is used: `certifiedAt + 60 days`. The staleness check is `now >= certifiedAt + 60d`.

Both checks are exclusive at the boundary: a certification is stale at the exact moment it expires.

### Injecting `now` for tests

All TTL evaluation functions accept an optional `now: Date` parameter so unit tests can exercise boundary conditions deterministically without relying on wall clock time.

---

## Automatic Remediation

Mill startup preflight evaluates the global certification store before launching native agents. When coverage reports `identity-drift`, `stale`, `bump-without-publish`, or `empty-store`, preflight attempts one deterministic `workflow` certification publication before blocking startup. It then re-evaluates coverage and launches only if the post-remediation result is healthy. Mill dry-runs set `WAVEMILL_MILL_DRY_RUN=1` and do not mutate the global certification store.

Artifacts that are still fresh but will expire inside the renewal window are renewed proactively. The default window is 7 days and can be configured with:

```json
{
  "nativeAgent": {
    "certification": {
      "renewalWindowDays": 7
    }
  }
}
```

Automatic remediation runs only the deterministic certification harness. Provisional models that require `OPENROUTER_LIVE_SMOKE=1` are excluded from automatic target selection, and the remediation call strips `OPENROUTER_LIVE_SMOKE` from its scoped environment.

The remediation loop guard records one attempt per current catalog hash, required suite version, target set, and process under the global certification root. A second preflight for the same failing identity in that process blocks with the manual certification command instead of repeatedly re-running the matrix. A later process may try again, so an old failure cannot permanently suppress TTL renewal or recovery after artifacts are replaced.

Operators can disable only the automatic repair behavior while keeping the guard active:

```json
{
  "nativeAgent": {
    "certification": {
      "autoRemediate": false
    }
  }
}
```

The equivalent environment override is `WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE=1`. The existing `WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD=1` disables both the guard and remediation and should remain an emergency-only escape hatch.

---

## Live Canary Cohort (HOK-3062)

Deterministic remediation never grants coding eligibility — that requires a live, credentialed mutation canary pass (HOK-2943). The canary cohort turns that gate into an operational supply of coding-ready models: a bounded, reviewed set of 2–4 canonical identities whose live canaries are kept fresh on the machine and certification store the mill actually uses.

### Configuration

```json
{
  "nativeAgent": {
    "certification": {
      "canaryCohort": [
        { "provider": "openrouter", "model": "qwen-3-coder" },
        { "provider": "openrouter", "model": "kimi-k2.7-code" }
      ],
      "minCodingReady": 2,
      "canaryRenewalWindowDays": 3,
      "canaryAutoRefresh": true
    }
  }
}
```

Cohort entries are validated fail-closed against the effective registry: only verified, native-capable, non-disabled, non-coding-excluded canonical identities qualify. Invalid or duplicate entries are reported and skipped, never silently certified. The cohort is capped at 8 entries by schema; keep it at the reviewed 2–4.

### Automatic refresh

During mill certification preflight (when `autoRemediate` and `canaryAutoRefresh` are enabled and `WAVEMILL_SKIP_CANARY_AUTO_REFRESH` is not set), members whose canary is **missing, stale, inside the renewal window, identity-invalidated, or transiently inconclusive** get at most **one** live refresh attempt per remediation episode. An episode is keyed by identity fingerprint, catalog hash, suite version, and the expiry that triggered remediation; a second preflight inside the same episode reports the manual command instead of spending another provider call. Members without resolvable credentials are skipped with the missing env var named (never its value).

A definitive `fail` or `not-live` verdict is **never** auto-retried — it revokes eligibility and requires operator review (see the re-enable procedure above). A transient or skipped refresh never overwrites a still-valid unexpired pass; the existing revocation contract is unchanged. Refresh goes through the standard certify pipeline and atomic store writes, so no credential, raw transcript, or unbounded tool result is ever persisted; attempt records carry only redacted, bounded metadata under `<root>/.canary-refresh-attempts.json`.

### Manual refresh (credentialed mill host)

```bash
npx tsx tools/native-agent-certify.ts --refresh-canary-cohort
```

The command is idempotent, cohort-scoped (it rejects `--all`, `--provider`, `--model`, and `--dry-run`), bypasses the one-attempt episode guard, and exits non-zero when the coding-ready count stays below `minCodingReady`. Ephemeral credentialless CI artifacts are not production certification: run this on the mill host against the durable store (`WAVEMILL_NATIVE_CERTIFICATION_ROOT` or the default `~/.wavemill/native-agent-certifications`).

### Health and alerting

Preflight output and `tools/native-agent-models-report.ts` surface the cohort summary: configured count, coding-ready count, configured minimum, nearest canary expiry, and per-member state/last attempt/failure reason. When the coding-ready count drops below `minCodingReady`, an `ALERT` block with the remediation command is emitted before supply reaches zero. The alert never blocks preflight — HOK-2943's fail-closed eligibility gate remains the enforcement point.

### Rollback

Set `"canaryAutoRefresh": false` (or `WAVEMILL_SKIP_CANARY_AUTO_REFRESH=1`) to disable automatic refresh while retaining the eligibility gate. Existing valid passes remain usable until expiry; nothing synthesizes or bypasses a live pass.

---

## Orphan Pruning

Coverage reports artifacts whose storage identity no longer maps to any native-certifiable registry model as orphan artifacts. Orphans do not count against fleet health.

Use dry-run mode to inspect candidates:

```bash
wavemill native-agent certifications prune
```

Delete candidates explicitly with:

```bash
wavemill native-agent certifications prune --yes
```

Pruning unlinks global artifacts and then best-effort removes empty parent directories. Because artifact reads fail closed, a concurrent launch that races with pruning may see `missing`; run prune during maintenance windows.

---

## Reason Codes

The evaluator returns one of the following stable reason codes when a certification is ineligible:

| Code | Meaning |
|---|---|
| `missing` | No artifact file exists at the expected path |
| `malformed` | The artifact file exists but cannot be parsed or fails structural validation |
| `wrong-version` | The artifact `schemaVersion` or `suiteVersion` does not match what is required |
| `stale` | The artifact has expired (past `expiresAt` or past `certifiedAt + 60d`) |
| `phase-insufficient` | The artifact's `phase` is lower than the required phase |
| `scenario-failure` | One or more scenarios in the artifact did not pass, or the scenarios array is empty |

Reason codes are checked in the following order: `wrong-version` → `stale` → `phase-insufficient` → `scenario-failure`. The first failing check short-circuits further evaluation.

---

## API Reference

All exported symbols are available from `shared/lib/native-agent/certification/index.ts`.

## Registry Mirror

The model registry may carry a checked-in `nativeCapability.certification` snapshot with:

- `maxCertifiedPhase`
- `certifiedAt`
- `certificationSuiteVersion`
- `knownLimitations`

This registry mirror is a derived summary of the on-disk artifact, not a replacement for the
artifact itself. Its purpose is deterministic router and CI eligibility checks from registry data
alone, without live recertification or artifact reads during ordinary routing decisions.

Registry validation is split intentionally:

- Structural consistency is enforced when registry/config data loads.
- Freshness remains a runtime eligibility check derived from `certifiedAt + 60 days`.

### `checkCertificationEligibility(repoDir, provider, model, suiteVersion, requiredPhase, now?)`

Combined load + evaluate. Reads the artifact from disk and evaluates eligibility in one call. All failure paths return `{ eligible: false, reason }` — never throws.

### `evaluateEligibility(artifact, requiredSuiteVersion, requiredPhase, now?)`

Evaluates a pre-loaded artifact against a required suite version and phase. The `now` parameter defaults to `new Date()` if omitted.

### `loadCertification(repoDir, provider, model, suiteVersion)`

Reads and structurally validates an artifact from disk. Returns `{ ok: true, artifact }` or `{ ok: false, reason: 'missing' | 'malformed' }`.

### `buildCertificationPath(repoDir, provider, model, suiteVersion)`

Returns the canonical artifact path. Throws if any segment fails the safety check.

### `parseCertificationPath(path)`

Extracts `{ provider, model, suiteVersion }` from an artifact path. Returns `undefined` when the path does not match the expected layout.

### `phaseSatisfies(actual, required)`

Returns `true` if `actual` phase satisfies `required` phase according to the ordering.

### `isCertificationFresh(artifact, now)`

Returns `true` if the artifact has not expired.

### `allScenariosPassed(artifact)`

Returns `true` if all scenarios passed and the scenarios array is non-empty.

---

## Storage and Validation Helpers

The `shared/lib/native-agent/certification/` module includes storage and validation helpers on top of the core evaluation contract.

### Writing and reading artifacts

```ts
import { writeCertification, readCertification, listCertifications } from './store.ts';

// Write atomically (temp file + rename); returns the final absolute path.
const path = writeCertification(repoDir, artifact);

// Read from an absolute path with fine-grained error codes:
// 'not-found' | 'unreadable' | 'invalid-json' | 'schema-mismatch'
const result = readCertification(path);
if (result.ok) {
  console.log(result.artifact.phase);
} else {
  console.error(result.error.code, result.error.message);
}

// List all .json artifact paths under the global certification root.
const paths = listCertifications(repoDir);
```

### Aggregate validator

`validateCertification` runs all checks without short-circuiting, returning every failure as a `ValidationError` with an actionable message and structured `detail`:

```ts
import { validateCertification } from './validator.ts';

const result = validateCertification(artifact, {
  expectedProvider: 'anthropic',
  expectedModel: 'claude-sonnet-4-6',
  expectedSuiteVersion: 'v2',
  requiredPhase: 'patch',
  requiredCapabilities: ['long-context'], // checked against knownLimitations
  now: new Date(),
});

if (!result.ok) {
  for (const err of result.errors) {
    console.error(err.code, err.message);
  }
}
```

**Validation error codes**: `schema-version-mismatch`, `suite-version-mismatch`, `expired`, `phase-insufficient`, `identity-mismatch`, `limitation-conflict`, `scenario-failure`.

The per-check helpers (`checkSchemaVersion`, `checkSuiteVersion`, `checkNotExpired`, `checkPhaseSatisfies`, `checkIdentity`, `checkLimitations`, `checkScenarios`) are also exported for callers that need narrower checks.

---

## Scope and Non-Goals

This contract covers **only** the certification schema, storage path, phase semantics, TTL policy, and fail-closed evaluation helpers. It does not:

- Change any existing router, harness, registry, or CLI routing behavior.
- Specify which suite scenarios are required for each phase level.

These concerns are addressed in downstream implementation issues that consume this contract.
