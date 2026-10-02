# Router

**Last updated:** 2026-07-12T00:00:00.000Z
**Files touched:** 7 files in last 30 days

## Purpose

The router now has a single operating-mode view derived from quota health so commands can read one system-wide signal instead of inspecting each model individually.

Router-learning consumers enforce provisional model-identity holds through `shared/lib/model-evidence-policy.ts` before computing data sufficiency, KNN neighbors, historical aggregates, benchmark rows, launch-priority coverage, or Hokusai audit samples. Excluded raw eval rows stay in JSONL and remain visible through diagnostics, but they contribute zero neighbors, model counts, challenge coverage, benchmark rows, or Hokusai audit requests. Candidate-only provisional references are held for decision-training uses while unrelated executed performance remains usable.

## Operating Modes

| Mode | Meaning |
|------|---------|
| `normal` | At least one frontier model has healthy capacity after treating snapshot-absent frontier models as `healthy`. This includes mixed-frontier scenarios where the top-of-ladder frontier is degraded but a healthy frontier sibling can be substituted transparently. |
| `constrained` | Aggregate-across-frontier degraded mode: no frontier model is healthy, and at least one frontier model is `degrading` rather than `exhausted`. |
| `survival` | Aggregate-across-frontier exhausted mode: every frontier model is `exhausted`. |

Frontier models are defined by `PREMIUM_MODEL_CLASS = 'frontier'`.

## Derivation Rule

The operating mode is derived from `readQuotaSnapshot()` plus the effective model registry:

1. Resolve frontier model IDs from `getEffectiveRegistry()` where `capabilities.class === PREMIUM_MODEL_CLASS`.
2. Compute each frontier model's effective status from the quota snapshot, treating models absent from the snapshot as `healthy`.
3. Aggregate those effective statuses across the full frontier set.

Decision table:

| Effective frontier statuses (absent from snapshot = `healthy`) | Result | Notes |
|---------------------------------------------------------------|--------|-------|
| Any `healthy`, and it is the top-of-ladder frontier | `normal` | Standard routing |
| Any `healthy`, but the top-of-ladder frontier is `degrading` or `exhausted` | `normal` | Cross-frontier substitution keeps routing within the frontier class |
| None `healthy`, at least one `degrading` | `constrained` | Aggregate degraded routing; class downgrade allowed |
| Every `exhausted` | `survival` | Aggregate exhausted routing; haiku-only path |

A single degraded frontier model must never trigger `constrained` mode on its own; the router stays in `normal` until no frontier alternative is healthy.

### Normal-Mode Cross-Frontier Substitution

When `deriveOperatingMode()` returns `normal`, the routing policy still checks whether the preferred frontier candidate is degraded. If the top-of-ladder frontier is `degrading` or `exhausted` and another frontier sibling is `healthy`, routing remains in `normal` mode and substitutes the healthy sibling.

This substitution path is implemented in `routing-policy.ts`:

- `findHealthyFrontierSibling()` looks for a healthy frontier peer for the active task ladder.
- `healthyFrontierSubstituteAvailable` marks the mixed-frontier case where the preferred frontier is unhealthy but a healthy sibling exists.
- `resolveModel()` assigns `below-frontier-substitute` to non-frontier candidates in that case, preventing a downgrade to sonnet or haiku while a healthy frontier sibling is still available.

This is a normal-mode policy adjustment, not degraded routing. `workflow-router.ts` logs the substitution with `policyAdjustmentLog()` and `logFinalFrontierSubstitution()`, including `same-class=frontier` metadata. Constrained and survival banners do not fire for this path.

## API

`shared/lib/operating-mode.ts` exports:

- `deriveOperatingMode(snapshot, premiumModelIds)` for pure derivation
- `getCurrentOperatingMode(repoDir?)` for reading the current persisted quota state
- `PREMIUM_MODEL_CLASS`
- `CONSTRAINED_TRIGGER_STATUS`
- `SURVIVAL_TRIGGER_STATUS`

## Current Scope

Individual command behavior now changes based on operating mode. In `constrained` mode, routing restricts to sonnet/haiku candidates and skips LLM-based difficulty classification. In `survival` mode, routing uses haiku only and relies on stage-aware KNN signals instead of open-ended LLM reasoning.

## Launch-Priority Audit Input

`.wavemill/audits/launch-priority-coverage.json` is a planning input only. It does not override live routing or stage-pool filtering, but it is the artifact operators should inspect when they want to target zero-evidence or below-target launch-priority models in upcoming eval/task batches.

`shared/lib/launch-priority-audit.ts` reads the same launch-priority catalog surface as the existing OpenRouter challenger tooling, so audit coverage and router-side launch-priority classification stay aligned on what counts as a launch-priority model.

Launch-priority persistence is fail-closed for provisional observations. `certify-launch-priority-model --persist` refuses held aliases with `provisional-observation-only`, while planning output omits `--persist` from blocked certification commands and surfaces the blocker in preflight diagnostics.

## Native Certification Filtering

Native model certification filtering is a Layer 3 policy constraint applied inside `resolveStagePool()` before final per-role candidate selection. It runs after provider availability and capability checks have already narrowed the pool.

### Phase Requirements

Each router role maps to a minimum required certification phase:

| Role | Required Phase | Rationale |
|------|---------------|-----------|
| reviewer | `read-only` | Reads diffs and outputs comments; no file mutations |
| coder | `patch` | Produces patch-level file edits |
| planner | `workflow` | Orchestrates the full multi-phase workflow |

A higher-phase certification satisfies lower-phase requirements: `workflow` satisfies `patch` and `read-only`; `patch` satisfies `read-only`.

### Fail-Closed Behavior

All of the following conditions reject a native model from the pool:

| Condition | Rejection Reason |
|-----------|-----------------|
| No certification artifact on disk | `missing` |
| File is unreadable or unparseable | `malformed` |
| `schemaVersion` or `suiteVersion` mismatch | `wrong-suite` |
| TTL expired or `expiresAt` in the past | `stale` |
| Certified phase does not satisfy required phase | `insufficient-phase` |
| Any scenario result is `passed: false` | `insufficient-phase` |
| Missing `nativeCapability` or `nativeProvider` in registry | `missing` |

Non-native models (no `nativeCapability` in the registry) always pass through unchanged.

## Agent Resolution

Model-to-agent resolution is now registry-backed and fail-closed across both TypeScript and shell launch paths.

- `shared/lib/model-agent-resolution.ts` is the single authority for mapping a model plus phase to an agent.
- `shared/lib/model-router.ts` delegates `resolveAgent()` and `tryResolveAgent()` to that shared resolver.
- `shared/lib/agent-adapters.sh` shells out to `tools/resolve-model-agent.ts` instead of applying prefix heuristics.
- There is no default Codex fallback for unknown, unsupported, uncertified, or malformed non-OpenAI model selections.

This prevents non-ChatGPT/Codex models such as `mistral-large-2` from reaching `codex exec`. OpenRouter/native candidates now either resolve to `native-openrouter` after certification checks or fail before tmux launch with an `[agent-resolution]` diagnostic and the matching `native-agent-certify` command.

## OpenRouter Doctor

Use `wavemill doctor openrouter` to inspect whether configured OpenRouter/native candidates can currently receive router or challenge traffic.

- `wavemill doctor openrouter --json --repo-dir <dir>` emits the full machine-readable report.
- `wavemill doctor openrouter --stage coder` limits the view to one workflow stage.
- `wavemill mill` startup runs the same doctor in a guarded, fail-silent path and caches a one-line warning in `/tmp/${SESSION}-openrouter-warning.txt` for the dashboard header.

### Reason Taxonomy

Each blocked model/stage cell reports one primary reason plus optional secondary reasons from this closed set:

- `PROVIDER_DISABLED`
- `MISSING_API_KEY`
- `DIRECT_AGENTS_DISABLED`
- `MISSING_REGISTRY_ALIAS`
- `CERTIFICATION_REJECTED`
- `AGENT_FALLBACK_TO_CODEX`
- `STAGE_NOT_PERMITTED`
- `OPERATING_MODE_RESTRICTED`

Each reason includes the blocking detail, the relevant config surface or env var, and a concrete remediation hint.

### Alias vs Raw ID

The doctor keeps three identities distinct:

- Wavemill alias, such as `glm-5.2`
- Raw OpenRouter/native provider ID, such as `z-ai/glm-5.2`
- Certification storage identity/path, such as `.wavemill/native-agent-certifications/z-ai/glm-5.2/v1.json`

`providers.openrouter.models` should contain Wavemill aliases. `nativeAgent.providers.openrouter.models` may contain raw provider IDs. When those surfaces disagree or a raw ID has no effective alias/registry entry, the doctor reports `MISSING_REGISTRY_ALIAS` and points to the offending config surface.

### Selection History and Zero-Traffic Alerts

The zero-traffic detector is read-only. It inspects existing route and eval artifacts only:

- feature and archive route artifacts via `readRouteLifecycleArtifacts()`
- `.wavemill/evals/evals.jsonl`, skipping malformed lines

If the last `N` observed selections contain no configured OpenRouter/native model, the doctor emits a concise warning and includes the next challenge candidate when one can be derived from the current challenge pool. If no route/eval history is available, the warning degrades to an eligibility-only check instead of failing.

### Diagnostics

Each rejected native model produces one `RouterCertificationRejection` record on the routing decision:

```typescript
{
  modelId: string;
  role: 'planner' | 'coder' | 'reviewer';
  requestedPhase: CertificationPhase;
  certifiedPhase?: CertificationPhase;   // from artifact, when readable
  nativeCapability: string;              // readOnlyNative value from registry
  requiredSuiteVersion: string;
  reason: RouterCertificationRejectionReason;
}
```

These are collected in `WorkflowRouteDecision.nativeCertificationRejections` and mirrored as human-readable entries in `decision.reasoning`.

### Implementation

- **Filter module**: `shared/lib/native-agent/certification/router-filter.ts`
- **Phase mapping**: `STAGE_PHASE_REQUIREMENT` (exported from `workflow-router.ts`)
- **Unified gate**: `evaluateNativeProviderGate()` in `shared/lib/native-agent/certification/eligibility-gate.ts`
- **Artifact loading**: router preserves `missing` versus `malformed` by calling `loadCertification()` before delegating freshness/suite/phase checks to the unified gate
- **Applied in**: `resolveStagePool()` in `workflow-router.ts`, and task-mode native provider resolution in `shared/lib/native-agent/providers.ts`

### Scope

The filter only runs when a `repoDir` is provided to the routing call. Native models only appear in repo-specific registry configs, so this is always a no-op in global/default-registry contexts.

## Capability Filtering

Capability-aware filtering is an opt-in Layer 3 refinement behind `router.capabilityFiltering.enabled`.

- It only applies inside policy/stage-aware candidate filtering after provider availability, quota state, difficulty floors, and other policy guards have already run.
- It never overrides an explicit pinned selector resolution path in `model-registry.ts`.
- The active constraint shape is derived from `ModelCapabilities` metadata and currently supports `minContextWindow`, `requiresTools`, `requiresMultimodal`, and `maxLatencyTier`.
- Missing capability metadata fails closed only for the field being checked. Empty or omitted constraints are treated as satisfied.
- If capability filtering removes every otherwise-viable candidate for a role/stage, routing falls back to the unfiltered viable pool and records `capability-filter-empty-fallback` reasoning rather than failing the route outright.

## Expanded Packet Reroute

Expanded-packet reroute now reuses the same `routeBatch()` pipeline as bootstrap routing:

- `tools/route-tasks.ts --expanded-jsonl` accepts one JSON object per expanded packet and delegates to `routeExpandedPackets()`.
- `routeExpandedPackets()` hashes the current packet bytes, checks `.wavemill/state/expanded-route-cache.json`, and only routes misses.
- Two or more misses are routed in one shared batch so config and eval history load once.
- A batch failure falls back to per-task reroute for only the missing or failed entries.
- Successful fresh decisions are recorded back into the expanded-route cache under the current operating mode.

The cache key is a SHA-256 over the expanded packet content plus the cache input version. Full packets hash raw `task-packet.md` bytes; split packets hash `task-packet-header.md` + `task-packet-details.md` with stable separators and the version suffix.

Cache entries are gated by operating mode. A route cached in `normal` mode is not reused in `constrained` or `survival`.

Expanded route artifacts now carry additive top-level metadata:

- `cache_hit`
- `route_source` with values `cache`, `batch`, or `single`
- `packet_hash`

Transparency logs emitted during expanded reroute include:

- `route_source=<cache|batch|single>`
- `packet_hash=<12-char prefix>`
- `issue=<issue id>`

## Proactive Degradation Detection

Operating mode now includes proactive quota-state transitions, not just reactive 429-driven state.

`readQuotaSnapshot()` can mark a model `degrading` before hard-stop if any heuristic triggers:
- Rolling request volume in the last 5 minutes crosses configured threshold
- Repeated near-limit warnings accumulate inside the healthy decay window
- Provider-surfaced budget signal reports low remaining percentage
- Remaining estimate drops below near-limit ratio threshold relative to known limit

Manual per-model overrides in `.wavemill-config.json` are applied after projection and can force
`healthy`, `degrading`, or `exhausted` status for known high-usage windows.

See [Quota Tracking](quota-tracking.md) for full signal definitions, thresholds, and CLI override flow.

## Degraded-Mode Routing

When the operating mode is `constrained` or `survival`, `routeWorkflowAuto()` automatically invokes degraded-mode routing:

- **Constrained**: Model pool restricted to `strong_generalist` and `fast_economy` classes. LLM-based difficulty classification is skipped.
- **Survival**: Model pool restricted to `fast_economy` class (haiku-only). LLM-based difficulty classification is skipped.

Both modes use stage-aware KNN signals for candidate selection and prepend a degraded-mode rationale to the routing decision's reasoning field. Those degraded-mode banners only fire once the aggregate frontier state has crossed into `constrained` or `survival`. If any frontier sibling remains healthy, routing stays in `normal` mode, uses cross-frontier substitution, and does not emit degraded-mode rationale. If no models of the appropriate class are available, routing falls back to the full pool with a warning.

`routeWorkflowDegraded()` is the explicit API for degraded-mode routing; `routeWorkflowAuto()` uses it automatically based on current operating mode.

## Architectural Constraints

### DO
- Always prepend degraded-mode rationale to routing decisions when constrained or survival
- Treat constrained and survival as aggregate-across-frontier states, not single-model triggers
- Prefer a healthy frontier sibling over non-frontier fallbacks when the top-of-ladder frontier is degrading in normal mode
- Respect `modelsAvailable` option in routing functions to allow test injection
- Keep capability-aware filtering inside Layer 3 policy/stage-aware candidate selection and behind `router.capabilityFiltering.enabled`
- Skip LLM-based difficulty classification in constrained and survival modes
- Fall back to full model pool if no degraded candidates exist (with warning)
- Register agent configurations and DSPy artifacts as resources when they are used in routing decisions
- Wrap resource registration in try-catch to ensure registry failures do not break routing
- Gate rubric-aware stage scoring on nearest-neighbor window coverage, not per-record coverage
- Stamp route artifacts with `provenance.source`, `inputKind`, `inputPath`, `inputHash`, `routedAt`, and `routerMode`
- Preserve `cache_hit`, `route_source`, and `packet_hash` when promoting `.post-expansion-route.json` into `.routing-complete`
- Prefer cache hits for unchanged expanded packets on coding launch and resume

### DON'T
- Trigger constrained mode while any frontier model is healthy
- Skip cross-frontier substitution and fall back to non-frontier models while a healthy frontier sibling is available
- Use frontier models (opus) in constrained or survival mode
- Use LLM reasoning for candidate selection in degraded modes
- Let capability constraints override explicit pinned model selector resolution
- Assume model registry will have preferred classes available
- Overwrite `.initial-route.json` after bootstrap routing has been persisted
- Allow an uncertified native model to reach the final pool (fail closed, never silently ignore certification failures)
- Accept a native model based only on registry `maxCertifiedPhase` metadata without checking the on-disk artifact
- Assume an OpenRouter alias and its raw `vendor/model` ID resolve to different certification artifacts

## Known Failure Modes

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| Degraded routing falls back to full pool | No models of restricted class available in registry | Ensure model registry includes sonnet/haiku; verify class definitions in `model-registry.ts` |
| Task parks at `.plan-approved`; mill log shows `[launch-refusal] … reason=uncertified certification=missing_live_canary` | Router picked a coder the launch gate refuses (HOK-3142, HOK-3138): only `resolveStagePool` ran the native filter, so the policy, Hokusai, floor, and escalation paths could select an uncanaried native coder | `finalizeDecision` now runs `enforceLaunchableRoute` (the launcher's own `isLaunchableForStage`) at every exit; the monitor re-routes on a typed refusal (`tools/reroute-refused-coder.ts`) and terminalizes to needs-user with the certify command (`.retry-coding-launch-refused-exhausted`). Certify with `--phase patch --live-coding-canary`, then remove the sentinel |
| Non-OpenAI model launches in Codex and fails with unsupported-model | Before 2026-07-10, shell or TS resolution fell through to a default Codex agent instead of consulting registry-backed native routing | Inspect the `[agent-resolution]` diagnostic, certify the model via `npx tsx tools/native-agent-certify.ts --provider openrouter --model <id> --phase <phase>`, or remove it from router candidates |
| `constrained` mode fires even though one frontier model is healthy | Operating mode derived from a single-model check instead of aggregating all frontier IDs | Ensure `deriveOperatingMode()` iterates the full frontier set from the effective registry and treats snapshot-absent frontier models as `healthy` |
| A non-frontier model is selected while a healthy frontier sibling is available | Frontier-sibling substitution was skipped, or `below-frontier-substitute` exclusions were not applied | Verify `findHealthyFrontierSibling()` can see the current quota snapshot and `resolveModel()` is excluding non-frontier candidates in the mixed-frontier path |
| No policy-adjustment line appears for a frontier-to-frontier swap | The route never passed through `logPolicyAdjustment()` or `logFinalFrontierSubstitution()` for that path | Confirm routing stayed out of degraded mode and note that `routingMode === 'policy'` intentionally skips the final frontier-substitution log |
| `heuristic-fallback, neighbors=0` appears in degraded mode despite populated `evals.jsonl` | The degraded `modelsAvailable` allowlist filters every k-nearest neighbor before stage selection, so `routeStageAware()` returns `null` and the caller reports zero neighbors | Retry `rankModelsPerStage()` without model constraints when filtering caused the null, return `stage-aware-partial`, and let the caller overlay degraded model selection while preserving the real neighbor count |
| Capability-aware routing appears ignored | `router.capabilityFiltering.enabled` is unset/false, so capability constraints are not applied | Enable `router.capabilityFiltering.enabled` and verify the route went through Layer 3 policy or stage-aware selection instead of explicit pinned resolution |
| Capability-aware route falls back unexpectedly | Every in-pool candidate failed one or more capability checks, so the empty-filter fallback restored the unfiltered viable pool | Inspect decision reasoning for `capability-filter-empty-fallback` and either loosen the task constraints or expand the configured model pool |
| Route artifacts are missing provenance or still marked as cache/live incorrectly | Route JSON write sites did not stamp or refresh `provenance` fields on reuse | Ensure route persistence paths always write/merge `provenance` and refresh source on cache recovery |
| Native provider reports `missing_artifact` even though an OpenRouter cert exists on disk | The artifact was written under a different storage identity than the router/provider gate resolves (for example alias vs raw ID mismatch) | Compare the reported `artifactPath` with `.wavemill/native-agent-certifications/<provider>/<model>/<suite>.json`; alias `glm-5.2` and raw `z-ai/glm-5.2` must both land under `z-ai/glm-5.2/` |
| Rubric-aware mode is enabled but scalar routing still wins | Rubric coverage in the nearest-neighbor window is below `router.rubricAware.minCoverage` | Check decision reasoning for `rubric-aware fallback`; lower `minCoverage` only after validating mixed-dataset behavior |
| Native model appears selected despite having no cert artifact | `repoDir` was not passed to the routing call, so the cert filter did not run | Always pass `repoDir` to routing calls in production paths; cert filter is a no-op without it |
| Coder rejects valid native model | Cert phase is only `read-only` (insufficient for `patch` requirement) | Re-certify the model at the `patch` phase and write a fresh artifact |
| `nativeCertificationRejections` missing from decision | No native models were in the resolved pool, or all native models passed | Expected; field is omitted when empty |

## Testing Patterns

`shared/lib/workflow-router.test.ts` includes:
- Test helpers (`writeQuotaState`) for injecting quota state into repos
- Survival mode test verifying haiku-only routing and no opus/sonnet usage
- Constrained mode test verifying opus exclusion but sonnet/haiku availability
- Normal mode test verifying no degraded rationale is prepended
- Native certification policy tests: valid/invalid cert per role, missing/stale/wrong-suite/malformed artifacts, fail-closed pool, diagnostic field completeness

`shared/lib/native-agent/certification/router-filter.test.ts` includes:
- Phase requirement mapping assertions
- Non-native pass-through
- All rejection reason paths with direct `filterNativeModels()` calls
- Mixed pool separation (eligible vs rejected)

## Dependencies

- `operating-mode.ts` — for `getCurrentOperatingMode()` to detect quota state
- `model-registry.ts` — for model class definitions and effective registry resolution
- `stage-aware-router.ts` — for KNN-based routing fallback
- `resource-manifest.ts` — for recording agent and artifact use in per-run manifests
- `resource-adapters/agent-config-adapter.ts` — for registering agent configurations as resources
- `resource-adapters/dspy-adapter.ts` — for registering DSPy artifacts as resources

## Related Subsystems

- [Quota Tracking](quota-tracking.md) — quota state derivation, thresholds, and the persisted snapshot consumed by operating-mode and substitution logic
- `shared/lib/model-registry.ts` — model class definitions and effective registry resolution used to identify frontier models
- `shared/lib/stage-aware-router.ts` — KNN-based routing used by degraded modes after aggregate frontier exhaustion/degradation is confirmed

## Recent Changes

### 2026-06-30T00:00:00.000Z - HOK-2397: Enforce native certification phase filters in router
**Changed:** `resolveStagePool()` now applies a native certification filter before returning per-role candidate pools. A new `shared/lib/native-agent/certification/router-filter.ts` module implements `filterNativeModels()` with a closed rejection-reason set (`missing`, `malformed`, `wrong-suite`, `stale`, `insufficient-phase`). Rejections are collected in `WorkflowRouteDecision.nativeCertificationRejections` and mirrored as reasoning entries. Phase requirements: reviewer→`read-only`, coder→`patch`, planner→`workflow`.
**Impact:** Native models without a valid, fresh, phase-satisfying on-disk certification artifact are rejected fail-closed instead of silently passing through. Non-native models are unaffected. All existing routing paths and tests continue to work unchanged.

### 2026-04-30T00:00:00.000Z - HOK-1511: Persist route provenance and input hashes
**Changed:** Route artifacts now include a nested `provenance` object (`source`, `inputKind`, `inputPath`, `inputHash`, `routedAt`, `routerMode`) and shell route readers can resolve both legacy top-level fields and provenance metadata.
**Impact:** Bootstrap vs expanded/cache/live decisions are now distinguishable and unchanged input packets can be detected by stable `inputHash`, while `.initial-route.json` remains immutable once written.

### 2026-05-01T00:00:00.000Z - HOK-1514: Batch and cache expanded reroute
**Changed:** Expanded reroute now routes approved task packets through a shared batch path, persists decisions in `.wavemill/state/expanded-route-cache.json`, and tags expanded artifacts with `cache_hit`, `route_source`, and `packet_hash`.
**Impact:** Multi-task planning-to-coding handoffs avoid repeated config/eval loads where batching is possible, unchanged packets skip reroute safely on resume/retry, and operators can distinguish cache hits from fresh expanded routing in logs and artifacts.

### 2026-05-13T00:00:00.000Z - HOK-1638: Capability-aware Layer 3 filtering
**Changed:** Policy and stage-aware routing can now honor context-window, tooling, multimodal, and latency constraints derived from task metadata when `router.capabilityFiltering.enabled` is true. The router applies those checks only inside Layer 3 candidate filtering and falls back to the unfiltered viable pool when every candidate is excluded.
**Impact:** Task-specific capability requirements can influence family-ladder selection without breaking explicit pinned resolution or making routes impossible when capability metadata is incomplete or overly restrictive.

### 2026-04-27T00:00:00.000Z - HOK-1410: Rubric-aware stage labels in stage-aware routing
**Changed:** Stage-aware routing can now blend per-record rubric mean scores with scalar stage scores behind `router.rubricAware`. The default remains `off`; `shadow` records a side-channel decision while preserving scalar routing, and `on` uses rubric-aware scoring when nearest-neighbor coverage meets the configured threshold.
**Impact:** Historical records with rubric descriptors can improve per-stage model ranking without dropping legacy records. Sparse mixed windows explicitly fall back to scalar scoring and prepend a `rubric-aware fallback` rationale.

### 2026-04-21T14:28:57.564Z - HOK-1378: Create a first-class resource registry and per-run resource manifest
**Changed:** Routing functions now register agent configurations and DSPy artifacts as resources and record their use in per-session manifests. All major routing entry points (`routeWorkflowStageAware`, `routeWorkflowHokusai`, `routeWorkflowAuto`) register the planner, coder, and reviewer models; artifact loading also triggers registration and use recording.
**Impact:** Routing decisions are now attributed to specific resource versions in the manifest, enabling eval attribution and performance analysis tied to concrete agent/artifact versions. Resource registration is non-breaking (wrapped in try-catch) and gracefully degrades when WAVEMILL_SESSION is not set.

### 2026-04-19T16:30:00.000Z - HOK-1370: Router docs refreshed for multi-frontier semantics
**Changed:** Updated the router subsystem spec to document aggregate-across-frontier operating modes, explicit mixed-frontier decision-table behavior, normal-mode frontier sibling substitution, and the `below-frontier-substitute` / transparency-log invariants.
**Impact:** Future routing work can distinguish true degraded-mode entry from healthy frontier substitution and avoids reintroducing single-model triggers for `constrained` mode.

### 2026-04-19T16:00:00.000Z - HOK-1369: Cross-frontier substitution transparency
**Changed:** Normal-mode routing now emits per-role policy-adjustment lines when a healthy frontier sibling is chosen because the top frontier is `degrading` or `exhausted`, for example `[coder] policy adjustment: claude-opus-4-7 -> gpt-5.4 (quota=exhausted, same-class=frontier)`.
**Impact:** Operators can distinguish healthy cross-frontier rerouting from true class downgrades, while constrained and survival banners remain reserved for aggregated degraded modes only.

### 2026-04-19T15:13:53.493Z - HOK-1341: Degraded-mode behavior for the `route` command
**Changed:** `routeWorkflowAuto()` now detects operating mode and delegates to `routeWorkflowDegraded()` when constrained or survival. Degraded routing restricts model pool (sonnet/haiku in constrained, haiku-only in survival), skips LLM difficulty classification, and prepends mode-aware rationale to reasoning field.
**Impact:** Auto-mode routing now makes quota-aware decisions automatically. Commands using auto routing gracefully fall back to smaller models under quota pressure without user intervention.
