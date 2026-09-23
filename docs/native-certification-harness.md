# Native Certification Scenario Harness

This document describes the deterministic certification scenario harness that ships on top of the native certification contract (HOK-2392, `docs/native-certification-contract.md`). The harness provides:

- A typed scenario catalog with per-scenario executable assertions.
- A runner that walks the catalog, dispatches assertions, and aggregates results.
- A loud-unsupported guarantee for missing compat fixtures and failed capability checks.
- A dry-run guarantee that prevents accidental live certification from offline runs.

---

## Relationship to the Certification Contract

The harness is a **downstream consumer** of the contract defined in HOK-2392. It keeps the persisted contract additive and compatible while extending `ScenarioResult` with retry-accounting fields for live-certification reporting. The harness also introduces richer in-memory types (`HarnessScenarioResult`, `HarnessReport`) and projects them to the persisted shape via `toArtifactScenario()` when a live cert is written.

---

## Scenario Model

### Classification

```
ScenarioClassification = 'deterministic' | 'live-judged'
```

- **`deterministic`** — assertion runs offline against scripted providers, compat fixtures, and pure helper functions. Produces `pass`, `fail`, or `unsupported`. All scenarios in `getDefaultScenarios()` that can be certifying are deterministic.
- **`live-judged`** — assertion requires a paid LLM call. The runner returns `not-run` for these without invoking any network call.

### Category

```
ScenarioCategory = 'tool' | 'usage' | 'transcript' | 'phase'
```

| Category | Tests |
|---|---|
| `tool` | Compat fixture lookup, `validateToolCompat` capability check |
| `usage` | Token mapping from scripted provider turns |
| `transcript` | `TranscriptWriter` JSONL correctness |
| `phase` | `phaseSatisfies` ordering, `writeCertification` / `checkCertificationEligibility` roundtrip |

### CertificationScenario

```ts
interface CertificationScenario {
  id: string;                     // stable, kebab-case
  phase: CertificationPhase;      // from PHASE_ORDER ('read-only' | 'patch' | 'workflow')
  category: ScenarioCategory;
  classification: ScenarioClassification;
  description: string;
  assertion?: ScenarioAssertion;  // required iff classification === 'deterministic'
  knownLimitation?: string;       // surfaced into HarnessReport.knownLimitations
}
```

---

## Default Catalog

`getDefaultScenarios()` returns the shipped catalog. All entries are deterministic except the live-judged placeholder that exercises the `not-run` runner path.

| Scenario ID | Category | What it certifies |
|---|---|---|
| `tool.compat.git_status.openai-completions` | `tool` | `git_status` fixture exists for `openai-completions`; `validateToolCompat` returns ok for (provider, model, transport) |
| `usage.scripted.records-input-output-tokens` | `usage` | Scripted provider turn with `usage: { input: 100, output: 25 }` maps to `inputTokens: 100, outputTokens: 25` |
| `transcript.scripted.session_started_then_ended` | `transcript` | `TranscriptWriter` produces JSONL with `session_started` first, `session_ended` last, matching `sessionId`/`provider`/`model` |
| `phase.read-only.satisfies-read-only` | `phase` | `phaseSatisfies('read-only', 'read-only')` and `phaseSatisfies('patch', 'read-only')` are true; `phaseSatisfies('read-only', 'patch')` is false |
| `phase.fixture.persistence-roundtrip` | `phase` | `writeCertification` + `checkCertificationEligibility` round-trip returns `eligible: true` |
| `live.judge.tool-output-summary-quality` | `tool` | Live-judged placeholder — always returns `not-run` |
| `workflow.tools.contract-shape-stable` | `tool` | Canonical workflow tool names, workflow phases, and mutation actions are still present |
| `workflow.tools.mutation-policy-allows-in-phase` | `tool` | Planning-phase reads and `write_stage_result` are explicitly allowed by the workflow mutation matrix |
| `workflow.tools.mutation-policy-denies-out-of-phase` | `tool` | Merge and out-of-phase workflow mutations are denied fail-closed, including unknown combinations |
| `workflow.transcript.approval-lifecycle-jsonl-shape` | `transcript` | `TranscriptWriter` serializes `approval_lifecycle` and `cleanup_report` events between session bookends with stable JSONL shape |
| `workflow.provenance.untrusted-input-detects-phase-override` | `transcript` | Untrusted workflow inputs that try to override phase policy are flagged by provenance metadata |
| `workflow.usage.multi-turn-token-accounting` | `usage` | Multi-turn scripted provider usage stays per-turn, which preserves workflow budget accounting |
| `workflow.cleanup.tracker-roundtrip-and-summary-event` | `phase` | Cleanup tracker round-trip yields a `cleanup_report` summary with `finalTreeState` and `cleanupDecision` fields |
| `workflow.phase.workflow-persistence-roundtrip` | `phase` | A persisted `phase: 'workflow'` artifact satisfies workflow, patch, and read-only eligibility checks |

## What Workflow-Phase Certification Proves And Does Not Prove

### Proves

- Workflow tool contract shape is intact: 8 canonical tools, 4 workflow phases, and the explicit `merge` denial action are still encoded.
- The workflow mutation matrix allows the in-phase reads and stage-result writes planner runs depend on, and denies out-of-phase mutations fail-closed.
- Transcript serialization includes stable `approval_lifecycle` and `cleanup_report` JSONL events alongside ordinary session bookends.
- Provenance trust metadata flags common override attempts from untrusted workflow inputs, including phase-policy bypass language.
- Multi-turn usage accounting remains per-turn, which is required for budget tracking in longer planner sessions.
- Cleanup tracking emits a well-formed summary event with `finalTreeState` and `cleanupDecision`.
- A passing `phase: 'workflow'` artifact satisfies the router's workflow requirement for planner routing and still satisfies lower `patch` and `read-only` requirements.

### Does not prove

- Live structured mutation-tool use against the real provider. Coding eligibility therefore requires the separate live coding canary pass (HOK-2943) in addition to a `patch`/`workflow` deterministic artifact — a deterministic artifact alone never admits a model to coder routing or native coding launches.
- Live workflow orchestration quality, such as whether a model actually produces strong plans or approval flows against real tasks.
- Real Linear or GitHub API compatibility, because the workflow certification scenarios are deterministic and offline.
- Production cost or latency behavior under real multi-turn budgets.
- Human operator approval-flow correctness with real approvers.
- Real-task reasoning quality on expanded task packets; that remains the live judge's domain.

### Catalog integrity rules

Enforced by `scenarios.test.ts` and checked at CI:

- Every `id` is a non-empty string.
- No duplicate `id`s (case-sensitive).
- Every `deterministic` scenario has an `assertion` function.
- No `live-judged` scenario has an `assertion` function.
- Every `phase` value is in `PHASE_ORDER`.
- Every category (`tool`, `usage`, `transcript`, `phase`) has ≥1 deterministic scenario.
- The default catalog includes deterministic workflow-phase coverage, so `native-agent-certify --phase workflow` can be live-certifiable when the scenarios pass.

### Adding a scenario

1. Write an `async function assertMySomething(ctx: ScenarioContext): Promise<ScenarioAssertionOutcome>` in `scenarios.ts`.
2. Add a `CertificationScenario` entry to `DEFAULT_SCENARIOS` with `assertion: assertMySomething`.
3. If the scenario can never pass offline (requires an LLM call), set `classification: 'live-judged'` and omit `assertion`.
4. `scenarios.test.ts` will catch any catalog integrity violations at test time.

---

## Runner

### Input

```ts
interface RunScenariosOptions {
  provider: NativeProviderName;   // 'openai' | 'openrouter'
  model: string;
  transport: PiTransportKind;     // 'openai-responses' | 'openai-completions'
  scenarios: CertificationScenario[];
  registry?: ModelRegistry;       // forwarded to validateToolCompat
  dryRun?: boolean;               // default false
  retryPolicy?: { maxAttempts?: number }; // default 3 total attempts
}
```

### Output

```ts
interface HarnessReport {
  provider: string;
  model: string;
  transport: PiTransportKind;
  results: HarnessScenarioResult[];
  countsByStatus: Record<HarnessScenarioStatus, number>;
  countsByCategory: Record<ScenarioCategory, number>;
  knownLimitations: string[];
  harnessPassed: boolean;       // zero fail + zero unsupported
  liveCertifiable: boolean;     // harnessPassed && !dryRun
  dryRun: boolean;
}
```

### Status semantics

| Status | Meaning |
|---|---|
| `pass` | Assertion returned `{ kind: 'pass' }` |
| `fail` | Assertion returned `{ kind: 'fail' }` or threw; never re-thrown |
| `unsupported` | Assertion returned `{ kind: 'unsupported' }` with a stable `reason` code |
| `not-run` | Scenario is `live-judged`; skipped without invoking any assertion |

### harnessPassed

`harnessPassed = (fail === 0 && unsupported === 0)`.

Every `unsupported` result is unexpected — if a scenario is expected to be unsupported for a given context, its catalog entry should be `live-judged` (→ `not-run`) rather than `deterministic` (→ `unsupported`). The runner never silently drops an unsupported result.

## Retry & flake accounting

Deterministic scenarios can now return four assertion outcomes:

- `pass`
- `fail`
- `provider-flake`
- `unsupported`

Only `provider-flake` is retry-eligible. The runner applies a bounded retry policy with `maxAttempts: 3` by default. Deterministic failures and unsupported capabilities short-circuit immediately and can never be retried into a pass result.

Failure classification is surfaced separately from top-level status:

- `fail` + `failureClass: 'deterministic_failure'`
- `fail` + `failureClass: 'provider_flake'` when retries exhaust
- `unsupported` + `failureClass: 'unsupported_capability'`

Persisted `ScenarioResult` fields now include:

- `attempts` — total attempts executed
- `finalAttemptStatus` — final assertion outcome kind
- `failureClass` — deterministic failure vs provider flake vs unsupported capability
- `retryCount` — legacy field, still populated as `attempts - 1`

To mark a transient provider issue from an assertion, return:

```ts
return { kind: 'provider-flake', detail: 'provider returned malformed transient response' };
```

The persisted certification schema version is now `2`.

---

## Loud-unsupported guarantee

Three structured `unsupported` reason codes are emitted loudly in the results array (never silently dropped):

| Reason | Trigger |
|---|---|
| `fixture-not-found` | `findFixture(tool, transport)` returns `undefined` |
| `capability-validator-rejected` | `validateToolCompat()` returns `ok: false` |
| `shape-mismatch` | Scripted provider result doesn't match fixture's `expectedToolCall` |
| `registry-missing-model` | Model has no `nativeCapability` entry in the supplied registry |

All four are included in `HarnessScenarioResult.reason` when applicable. Any assertion that returns `{ kind: 'unsupported' }` must supply a non-empty `detail` string — this is the primary diagnostic surface.

---

## Dry-run guarantee

```ts
const report = await runScenarios({ ..., dryRun: true });
// report.dryRun === true
// report.liveCertifiable === false  ← always false for dry-run
```

`runScenarios({ dryRun: true })` runs every deterministic assertion (same mechanics as a live run) but sets `report.liveCertifiable = false` unconditionally. The runner itself never writes a certification artifact; that is the caller's responsibility.

**Contract:** Do not pass a `dryRun: true` report's `toArtifactScenario()` results to `writeCertification` as a live certification. The `liveCertifiable` field on the report is the programmatic guard — callers must check it before writing.

---

## Artifact projection

```ts
import { toArtifactScenario } from './certification/scenario-runner.ts';

// For live (non-dry-run) reports only:
if (report.liveCertifiable) {
  const scenarioResults = report.results.map(toArtifactScenario);
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: report.provider,
    model: report.model,
    phase: 'read-only',
    suiteVersion: 'v2',
    certifiedAt: new Date().toISOString(),
    scenarios: scenarioResults,
    knownLimitations: report.knownLimitations,
  };
  writeCertification(repoDir, artifact);
}
```

`toArtifactScenario(result)` maps any `HarnessScenarioResult` to a `ScenarioResult` shape:
- `pass` → `{ scenarioId, passed: true, attempts, finalAttemptStatus: 'pass', retryCount }`
- `fail` / `unsupported` / `not-run` → `{ scenarioId, passed: false, failureMessage: result.detail, attempts?, finalAttemptStatus?, failureClass?, retryCount? }`

---

## Operator Commands

### `wavemill native-agent models report`

Lists certification status for every native-capable model in the registry. Reads from registry metadata and on-disk artifacts only — never triggers a paid provider call.

```bash
# Human-readable table
wavemill native-agent models report

# Machine-readable JSON (suitable for CI)
wavemill native-agent models report --json

# Filter by provider
wavemill native-agent models report --provider openai

# Filter by model
wavemill native-agent models report --model gpt-4o --json
```

**Output states:**

| State | Meaning |
|---|---|
| `ready` | Fresh, passing certification; satisfies ≥1 router stage |
| `uncertified` | `certified` capability but no valid on-disk artifact |
| `stale` | Artifact present but TTL-expired or suite-version mismatch |
| `unsupported` | `readOnlyNative: 'unsupported'` — model never intended for native use |
| `certification-only` | `readOnlyNative: 'partial'` — routable in cert mode only, not task mode |

**Exit codes:** `0` always on successful listing (even with uncertified rows); `2` on invalid input.

---

### `wavemill native-agent certify`

Runs the certification scenario harness for a specific provider/model/phase. On success (non-dry-run), writes a `NativeCertificationArtifact` to disk.

```bash
# Dry run — validate without persisting (safe offline)
wavemill native-agent certify --provider openai --model gpt-4o --phase read-only --dry-run

# Live certification — runs scenarios and writes artifact on success
wavemill native-agent certify --provider openai --model gpt-4o --phase read-only

# JSON output (artifact path + scenario outcomes)
wavemill native-agent certify --provider openai --model gpt-4o --phase read-only --json

# OpenRouter example
wavemill native-agent certify --provider openrouter --model openai/gpt-4o --phase read-only --dry-run

# Publish the full current-suite matrix for every native-capable registry model
wavemill native-agent certify --all --phase workflow
```

**Flags:**

| Flag | Required | Default | Description |
|---|---|---|---|
| `--provider` | yes unless `--all` | — | `openai` or `openrouter`; filters the batch with `--all` |
| `--model` | yes unless `--all` | — | Model ID (e.g. `gpt-4o`) |
| `--phase` | no | `workflow` | `read-only`, `patch`, or `workflow` |
| `--all` | no | false | Certify every native-capable registry model for the current suite |
| `--dry-run` | no | false | Run scenarios without writing an artifact |
| `--live-coding-canary` | no | false | Run the credentialed live coding canary after deterministic success (see below) |
| `--canary-max-cost-usd` | no | 0.5 | Live canary maximum estimated cost in USD |
| `--canary-timeout-ms` | no | 240000 | Live canary wall-clock limit |
| `--canary-max-tokens` | no | 60000 | Live canary total token budget |
| `--canary-max-tool-calls` | no | 10 | Live canary tool-call budget |
| `--json` | no | false | Machine-readable JSON output |
| `--repo` | no | cwd | Repository root |

**Exit codes:** `0` harness passed (and, with `--live-coding-canary`, the effective canary state grants coding eligibility); `1` harness failed, model unsupported, or the requested canary did not grant coding eligibility; `2` invalid input.

**Dry-run contract:** A dry-run report is never `liveCertifiable`. No artifact is written regardless of scenario outcomes. Use `--dry-run` in CI pipelines to validate harness connectivity without spending quota. `--live-coding-canary` cannot be combined with `--dry-run` — the canary is a live provider run by definition.

---

### Live coding canary lane (HOK-2943)

The deterministic harness remains **necessary but insufficient for coding**: coder routing and native coding launches additionally require a fresh, live, identity-matching canary pass recorded on the artifact (see the "Live Coding Canary" section of `docs/native-certification-contract.md`).

```bash
# Opt-in credentialed canary for one known-good, low-cost model
wavemill native-agent certify --provider openrouter --model qwen-3-coder --phase workflow --live-coding-canary

# Tighter budgets for a cheap validation run
wavemill native-agent certify --provider openai --model gpt-4o --phase workflow \
  --live-coding-canary --canary-max-cost-usd 0.25 --canary-timeout-ms 120000
```

Properties of the lane:

- **One bounded provider invocation** per attempt inside a disposable `mkdtemp` git repository — never the active repo or worktree. The temp repo is removed on pass, failure, provider error, timeout, and process interruption.
- **Cost bounds**: defaults are ≤ $0.50 estimated cost, 240s wall-clock, 60k tokens, 10 tool calls, 6 turns. A typical pass costs well under $0.05 on low-cost models. When pricing is unknown, the cost budget is skipped but token/wall-clock bounds still cap spend, and `usage.costUsd` is omitted rather than recorded as zero.
- **Transient errors** (429/5xx/timeout) record `inconclusive` and are retried in a fresh repository (2 attempts by default); an inconclusive attempt never overwrites a still-valid previous pass.
- **Redaction**: the persisted artifact carries hashes, counts, and repo-relative paths only. Diagnostics are secret-redacted, path-stripped, and length-capped.
- **CI separation**: unit suites exercise the canary through injected loop runners (always recorded `isLive: false`, never eligible). The credentialed live lane is opt-in via `--live-coding-canary` and is not part of default CI.
- Certifying **without** `--live-coding-canary` still publishes deterministic evidence and carries forward a still-valid previous canary pass, but a model with no valid pass stays coding-ineligible (`missing_live_canary`).

### Canary cohort refresh (HOK-3062)

The bounded cohort configured under `nativeAgent.certification.canaryCohort` is refreshed with one idempotent command on the credentialed mill host:

```bash
npx tsx tools/native-agent-certify.ts --refresh-canary-cohort

# Optional per-run budget overrides apply to each refreshed member
npx tsx tools/native-agent-certify.ts --refresh-canary-cohort --canary-max-cost-usd 0.25
```

The command targets only members whose canary is missing, stale, renewal-due, identity-invalidated, or transiently inconclusive; healthy members and definitive failures are left alone. It reuses the canary lane above (same budgets, credentials, isolation, and redaction), prints per-member outcomes plus the cohort health block (coding-ready count, minimum, nearest expiry, last attempts), and exits non-zero when coding-ready supply stays below `minCodingReady`. It rejects `--dry-run`, `--all`, `--provider`, and `--model`. Mill preflight runs the same refresh automatically with a one-attempt-per-episode guard; see "Live Canary Cohort" in `docs/native-certification-contract.md`.

The composite CI action (`.github/actions/certify-native-fleet/action.yml`) remains deterministic and credentialless; its `${RUNNER_TEMP}` artifacts are never production certification and never satisfy the coding gate.

---

## Shared Storage And Default Pools

Successful provider/model certifications are Wavemill-wide. `wavemill native-agent certify` writes artifacts to shared user storage by default:

```text
~/.wavemill/native-agent-certifications/<provider>/<model>/<suite>.json
```

Set `WAVEMILL_NATIVE_CERTIFICATION_ROOT` to override the shared root in tests or controlled operator environments. Legacy repo-local artifacts can be imported explicitly:

```bash
wavemill native-agent certifications migrate --repo /path/to/repo --dry-run --json
wavemill native-agent certifications migrate --repo /path/to/repo
```

Routing and challenge mode derive candidates from the global effective-model projection, then apply provider availability, API-key checks, disabled-model policy, budgets, stage capability filters, global certification validity, and local readiness checks.

Use `modelExclusions` to remove models without hiding newly supported models added by a Wavemill update:

```json
{
  "modelExclusions": [
    {
      "model": "qwen-3-coder",
      "stages": ["coding", "review"],
      "reason": "cost policy"
    }
  ]
}
```

`stages` is optional; omit it to exclude the model everywhere. Accepted stage names are `planner`, `coder`, `reviewer`, `expansion`, `planning`, `coding`, `review`, `plan`, and `implementation`. The models report and route/challenge diagnostics show the exclusion source (`repo` or `local`) and reason when provided.

The models report separates:

- **Global certification**: shared provider/model artifact validity, suite version, phase, TTL, scenarios, and storage scope.
- **Local readiness**: repo opt-in and repo-dependent launcher or patch-coding readiness checks.

---

## Source of truth

| File | Role |
|---|---|
| `shared/lib/native-agent/certification/scenarios.ts` | Catalog types, scenario definitions, assertion functions, `DEFAULT_CERTIFICATION_SUITE_VERSION` |
| `shared/lib/native-agent/certification/scenario-runner.ts` | Runner, aggregator, artifact projection |
| `shared/lib/native-agent/certification/report.ts` | Report builder, serializer, table renderer |
| `shared/lib/native-agent/certification/scenarios.test.ts` | Catalog integrity tests |
| `shared/lib/native-agent/certification/scenario-runner.test.ts` | Runner behavior tests |
| `shared/lib/native-agent/certification/report.test.ts` | Report builder tests |
| `shared/lib/native-agent/certification/index.ts` | Barrel re-exports |
| `tools/native-agent-models-report.ts` | `wavemill native-agent models report` CLI |
| `tools/native-agent-certify.ts` | `wavemill native-agent certify` CLI |
| `docs/native-certification-contract.md` | Persisted artifact contract (HOK-2392) |
