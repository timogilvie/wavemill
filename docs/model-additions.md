---
title: Adding Models
---

Wavemill model support is deliberately global. Consumer repositories cannot add,
hide, remap, or certify models through `.wavemill-config.json` or local overlay
files. When adding a new model, update the Wavemill global catalog and effective
model projection so every repository sees the same model universe.

## Checklist

1. Add the model and metadata to the global registry/projection in Wavemill.
2. Publish or update the global v2 certification catalog entry before exposing
   native launch eligibility.
3. Add pricing to the canonical Wavemill defaults when cost accounting needs it.
4. Add or update launcher/provider code when the model requires a new runtime
   integration. Keep credentials as environment variables.
5. Update DSPy routing metadata and active selector artifacts when they carry
   explicit model candidates.
6. Update tests that assert exact global model lists, ladders, or launchability.
7. Run focused config, registry, router, certification, and provider-launch tests.

For frontier models, use `class: "frontier"` in the registry and include the model in the planning, coding, and review ladders. Prefer putting same-vendor successors next to the previous model so quota fallback can substitute within the same class cleanly.

## Registry Metadata

Every canonical entry in `DEFAULT_MODEL_REGISTRY` must include:

- `contextWindowTokens`
- `toolSupport` as one of `none`, `basic`, or `full`
- `multimodal` with `text` and `image`, plus optional `audio` and `video`
- `latencyTier` as one of `fast`, `standard`, or `slow`
- `reasoningTier` as one of `basic`, `standard`, or `advanced`
- `costPerMillionInputTokensUsd` and `costPerMillionOutputTokensUsd`

Repository-local `modelRegistry.models.<id>` overrides are no longer accepted.
Canonical global registry entries must provide the complete metadata above.

The authoritative registry data lives in
`shared/fixtures/model-registry.v1.json` and is projected by
`shared/lib/model-registry-loader.ts` into `DEFAULT_MODEL_REGISTRY`. Keep model
entries, ladders, OpenRouter launch mappings, identity metadata, and lineage in
the catalog; do not update the generated/effective TypeScript projection by
text replacement.

## Admission Criteria

A model may only claim stages it can run. For each claimed
`supportedModel.stages` value, the entry must declare `toolSupport` other than
`none` and a `contextWindowTokens` value at or above that stage's floor:

| Stage | Minimum context window |
| --- | ---: |
| `expansion` | 65,536 |
| `planning` | 65,536 |
| `coding` | 65,536 |
| `review` | 65,536 |

If a model qualifies for only some stages, narrow `supportedModel.stages` to
those stages before adding it. Do not add it broadly and rely on downstream
selection filters to compensate. Pre-existing entries that must be preserved
for historical attribution but cannot run any claimed stage should remain in
the registry with `supportedModel.lifecycle: "blocked"`.

Admission is enforced by the registry unit tests, by
`assertRegistryConsistency()` when registry overrides are merged, and by the
scheduled OpenRouter alias audit. The audit reconciles declared context windows
and tool support against the live provider catalog so provider drift is caught
outside runtime launches.

## Retiring Models

Retire models by keeping their registry entry and setting
`supportedModel.lifecycle: "blocked"`. Do not delete the alias, provider-native
ID, pricing, or certification identity, because historical eval records use
those mappings for attribution.

When a retired model has a future launch replacement, declare
`identity.lineage.successor` on the retired entry and
`identity.lineage.predecessors` on the replacement. The successor must exist and
must not be provisional. Lineage resolution is only for future route intent at
external-router and cache-restoration boundaries; it must not rewrite raw eval
or historical performance records.

For native OpenRouter models, also set the launch-priority fixture row to
`status: "deprecated"` and remove retired aliases from smoke watchlists. A model
with `toolSupport: "none"` is never selectable for Wavemill stages because every
stage drives a tool-using agent.

After retiring or adding a native OpenRouter alias, run:

```bash
npx tsx tools/audit-openrouter-aliases.ts
```

The audit flags aliases that resolve to no OpenRouter wire ID or to an ID absent
from the current OpenRouter catalog. It also flags declared context windows that
exceed the provider catalog and declared tool support when the provider catalog
omits tool support. The CI workflow runs this audit daily and on demand. Retired
aliases may appear in the report as expected non-selectable findings.

## OpenRouter Catalog Maintenance Runbook

Repeatable operator loop for reconciling the registry with the live OpenRouter
catalog whenever the OpenRouter Alias Audit fails or a provider-side change
lands (HOK-3081 is the worked example: a `glm-5.3-flash` cache-read price move
and the removal of `mistralai/devstral-2512`).

1. **Run the live alias audit.**

   ```bash
   npx tsx tools/audit-openrouter-aliases.ts          # human summary + report artifact
   npx tsx tools/audit-openrouter-aliases.ts --json    # full JSON report
   ```

   The command fails only when `selectableFindings > 0`. Findings against
   retained-but-blocked aliases print as non-selectable ("retired - expected").

2. **Classify each finding before touching the registry.** `pricing-drift`
   means the alias still exists upstream but a registry price is missing or
   below the provider's — the audit deliberately flags only the unsafe
   direction (understating cost) — so correct the `capabilities.pricing`
   fields in `shared/fixtures/model-registry.v1.json` and keep the mirrored
   `costPerMillionInputTokensUsd` / `costPerMillionOutputTokensUsd` scalars
   consistent. `not-found-in-openrouter` means the OpenRouter ID vanished;
   confirm the removal against the live catalog before retiring the alias with
   the blocked/deprecated shape above. Treat `unresolved-openrouter-id`,
   `provider-native-id-mismatch`, `context-window-overstated`,
   `tool-support-mismatch`, and `invalid-pricing` as mapping or metadata
   defects to fix in place rather than retirements.

3. **Sweep every remaining reference.** Search the repository for the alias
   (for example `rg -n "devstral-medium"`) and update tests, comments, and
   projections so nothing still assumes it is selectable: remove it from
   `WATCHLIST_SMOKE_MODELS` in `tools/openrouter-smoke.ts` and from active
   candidate projections such as `eval.pricing` in
   `shared/lib/config-sync.ts`, whose keys feed the default routing and
   exploration pools (historical cost attribution keeps working through the
   retained registry pricing). Tests may keep the alias only to assert that it
   now fails closed; when a test needs the old shape — for example a
   coding-only alias for role-ineligible scheduling — substitute an existing
   active model with that shape and revise comments that still describe the
   retired alias as active.

4. **Validate against a saved catalog snapshot when repeated live calls are
   impractical.**

   ```bash
   curl -s https://openrouter.ai/api/v1/models > /tmp/openrouter-models.json
   npx tsx tools/audit-openrouter-aliases.ts --catalog-json /tmp/openrouter-models.json --no-write
   npx tsx tools/sync-openrouter-catalog.ts --dry-run
   ```

   `--fixture` audits against the bundled launch-priority fixture instead of
   the live catalog. That suits structural checks, but it cannot catch upstream
   removals or price moves — only the live or captured catalog can.

5. **Re-run the audit and the targeted tests** (`model-registry`,
   `openrouter-catalog`, `openrouter-alias-audit`, `challenge-mode`,
   `challenge-scheduler`, `launchable-models`, `tools/openrouter-smoke`,
   `tools/audit-openrouter-aliases`, `config-sync`). Accept when
   `selectableFindings` is zero: a blocked alias that is still absent upstream
   may remain in the report, but only as a non-selectable row, while every
   selectable alias's pricing must match the provider.

Never fix a failing audit by editing the `.github/workflows/ci.yml` path
filters — the audit step and its watched paths are contract-checked by
`tools/check-openrouter-alias-audit-ci.ts` during `test:preflight` — and do not
add a parallel audit or sync script. The workflow above only uses the existing
`tools/audit-openrouter-aliases.ts` and `tools/sync-openrouter-catalog.ts`
commands.

## Provisional Explicit-Native OpenRouter Models

Use a provisional identity when OpenRouter exposes a useful native model whose
final provider family, vendor lineage, pricing, or quality profile is not yet
verified. The Wavemill alias must be stable, but the provider wire ID remains
the exact OpenRouter ID in `supportedModel.providerNativeId`.

For provisional entries:

- Set `identity.status: "provisional"`, `identity.family: "unknown"`, and
  `identity.evidencePolicy: "held"`.
- Keep every `qualityScores` value at `0`, set
  `defaultLadderEligible: false`, and set
  `supportedModel.routingEligible: false`.
- Preserve observed zero input/output pricing only when the live catalog
  advertises zero. Leave cache read/write prices absent when the provider does
  not advertise them.
- Do not encode rumored vendor or model-family lineage. Add lineage only after
  a verified successor is available.
- Require live OpenRouter smoke before publishing a global certification
  artifact. A fresh `workflow` certificate can satisfy planner, coder, and
  reviewer native phase gates through the normal certification phase ordering,
  but it does not make the model eligible for automatic routing.
- Do not run launch-priority `--persist` for held provisional identities; those
  observations are operational only and must not feed performance consumers.

Ox Alpha followed this path as alias `ox-alpha` with wire ID
`stealth/ox-alpha`. Roll back a provisional native model by changing its
lifecycle to `blocked` and its launch-priority status to `deprecated`; keep the
identity and certification history for audit.

### Promoting a disclosed provisional identity

Run the standard promotion CLI with a checked-in transition spec; never
hand-rename a provisional entry:

```bash
npx tsx tools/promote-provisional-model.ts --spec transitions/<old>-to-<new>.json --repo-dir .          # dry-run
npx tsx tools/promote-provisional-model.ts --spec transitions/<old>-to-<new>.json --repo-dir . --apply  # after review
```

The apply stamps successor lineage on the old entry (lifecycle `deprecated`,
launch/routing false, mapping row `deprecated`), appends the verified final
entry and an active mapping row, and records a manifest plus exact backups
under `.wavemill/model-promotions/<promotionId>/`. Land the final entry
conservatively (`evidencePolicy: "held"`, launch/routing false,
`readOnlyNative: "partial"`), then live-smoke and freshly certify the final
subject — the old certificate can never match the new subject fingerprint —
and only then flip certification metadata, launch/routing eligibility, and
`evidencePolicy: "eligible"` in a separate explicit catalog change.

**Ox Alpha → GLM 5.3 Flash (2026-08-27).** OpenRouter disclosed `ox-alpha`
(`stealth/ox-alpha`) as **GLM 5.3 Flash** (`z-ai/glm-5.3-flash`, family
`glm`, vendor Z.ai): <https://openrouter.ai/z-ai/glm-5.3-flash>. Promotion
`ox-alpha-to-glm-5.3-flash` applied via
`transitions/ox-alpha-to-glm-5.3-flash.json` with disclosed pricing
input/output/cache-read **0.075 / 0.25 / 0.015** USD per MTok
(`cacheWriteCostPerMTok: 0` because OpenRouter advertises no
`input_cache_write` dimension — a schema-forced representation of "no
separate cache-write price", not a guess), context window 1,310,720. The
final identity passed live smoke and a fresh suite-v3 `workflow`
certification (2026-08-27T23:03:41.432Z). Quality scores stay 0 until
canonical local evidence accumulates; disclosure captures, dry-run/apply
manifests, and the certification run are retained under
`.wavemill/audits/model-promotions/glm-5.3-flash/`.

## Family Aliases

Family aliases are stable developer-facing names that parse into `ModelSelector` values in `shared/lib/model-registry.ts`. `parseModelSelector` only validates selector syntax and shape; it does not resolve aliases against the active registry.

| Family | Stable model ID | Notes |
| --- | --- | --- |
| `opus` | `claude-opus-4-8` | Stable Anthropic frontier alias. |
| `sonnet` | `claude-sonnet-5` | Stable Anthropic generalist alias. |
| `haiku` | `claude-haiku-4-5-20251001` | Stable Anthropic economy alias. |
| `gpt-5.5` | `gpt-5.5` | Alias lookup wins over pinned-ID parsing for this family name. |
| `gemini-pro` | `gemini-pro` | Declared for selector compatibility; provider/model integration is separate follow-up work when Gemini is not present in the active registry. |

Selector syntax:

- `family` parses as an alias selector and defaults to `channel: "stable"`.
- `family:channel` parses as an alias selector with a validated channel.
- `family-channel` also parses as an alias selector with a validated channel.
- `inherit` parses as an inherit selector.
- A concrete model ID parses as a pinned selector.

## Stability Channels

Family aliases can expose up to three stability channels:

- `stable`: the default production-ready pin. Bare aliases like `opus` resolve as `{ family: "opus", channel: "stable" }`.
- `preview`: an early-adopter opt-in for newer candidates that may change before promotion.
- `experimental`: the bleeding-edge opt-in for work that may break or disappear without deprecation.

Channel promotion is manual. Additions and promotions should update the pinned model ID in `shared/lib/model-registry.ts` after whatever evaluation or operational review you require. Do not build automated channel promotion or eval-driven channel selection into the alias resolver.

To add a channel pin for a family alias, extend the alias entry's `channels` map:

```typescript
opus: Object.freeze({
  channels: Object.freeze({
    stable: 'claude-opus-4-8',
    preview: 'claude-opus-4-8-preview',
  }),
  description: 'Stable Anthropic frontier alias for the Opus family.',
}),
```

If a selector requests a known channel that has no registered pin for that family, `resolveSelector()` throws `ModelResolutionError` with code `channel_unpinned`.

## resolveSelector()

`resolveSelector(selector, context?)` in `shared/lib/model-registry.ts` resolves a `ModelSelector` to a concrete pinned model ID and returns a `ResolvedModel` record with structured provenance.

### Function signature

```typescript
export function resolveSelector(
  selector: ModelSelector,
  context?: ResolutionContext,
): ResolvedModel
```

### ResolvedModel shape

```typescript
export interface ResolvedModel {
  requested: ModelSelector;     // the original selector as supplied
  resolved: string;             // the concrete pinned model ID
  source: ResolutionSource;     // how the model was resolved (see below)
  familyChannel?: Channel;      // present when selector.kind === 'alias'; defaults to "stable"
  parentContextId?: string;     // present when source === 'inherited' and context.parentContextId was supplied
  fallbackReason?: FallbackReason; // present when the policy layer had to substitute another model
}

export type ResolutionSource = 'alias' | 'pinned' | 'inherited' | 'fallback' | 'policy';
export type FallbackReason = 'quota-exhausted' | 'disabled-by-policy' | 'unavailable';
```

### Source values emitted by resolveSelector

| source | When emitted | Example |
|--------|-------------|---------|
| `alias` | Selector is `{ kind: 'alias', family, channel }` and the family/channel pair matches a pinned `FAMILY_ALIASES` entry | `resolveSelector({ kind: 'alias', family: 'sonnet', channel: 'stable' })` → `{ resolved: 'claude-sonnet-5', source: 'alias', familyChannel: 'stable' }` |
| `pinned` | Selector is `{ kind: 'pinned', modelId }` and the ID passes `validateModelId` | `resolveSelector({ kind: 'pinned', modelId: 'claude-opus-4-8' })` → `{ resolved: 'claude-opus-4-8', source: 'pinned' }` |
| `inherited` | Selector is `{ kind: 'inherit' }` and `context.parent` is supplied | `resolveSelector({ kind: 'inherit' }, { parent: parentResult })` → `{ resolved: parentResult.resolved, source: 'inherited' }` |
| `fallback` | Reserved for the policy layer (not emitted directly by `resolveSelector`) | — |
| `policy` | Reserved for the policy layer (not emitted directly by `resolveSelector`) | — |

### Error cases

- `alias` selector: throws `ModelResolutionError` if `selector.family` is not in `FAMILY_ALIASES` or if `selector.channel` is known but not pinned for that family.
- `pinned` selector: throws `ModelResolutionError` (via `validateModelId`) if the model ID is malformed.
- `inherit` selector: throws `ModelResolutionError` if `context?.parent` is absent.

## resolveSelectorWithPolicy()

`resolveSelectorWithPolicy(selector, context, options)` in `shared/lib/model-resolution-policy.ts` composes selector resolution with quota and routing policy checks. `resolveSelector()` remains unchanged; this wrapper is the policy-aware entry point when callers need explicit downgrade metadata.

### Function signature

```typescript
export function resolveSelectorWithPolicy(
  selector: ModelSelector,
  context: ResolutionContext | undefined,
  options: ResolveSelectorWithPolicyOptions,
): ResolvedModel
```

### Behavior

- Calls `resolveSelector()` first and preserves the original `requested` selector, `familyChannel`, and `parentContextId`.
- Returns the baseline result unchanged when the resolved model is still viable under policy.
- Returns `source: 'fallback'` with `fallbackReason: 'quota-exhausted'` when quota blocks the requested model.
- Returns `source: 'policy'` with `fallbackReason: 'disabled-by-policy'` when non-quota policy rules block the requested model.
- Returns `source: 'fallback'` with `fallbackReason: 'unavailable'` when the requested pinned target is absent from the active registry or filtered out as unavailable.
- Throws a typed `ModelPolicyResolutionError` when no viable substitute exists.

### Canonical example

```typescript
resolveSelectorWithPolicy(
  { kind: 'alias', family: 'opus' },
  undefined,
  {
    taskType: 'review',
    difficulty: 'moderate',
    quotaState: exhaustedOpusSnapshot,
    registryOverride: DEFAULT_MODEL_REGISTRY,
  },
);
// =>
// {
//   requested: { kind: 'alias', family: 'opus' },
//   resolved: 'claude-sonnet-5',
//   source: 'fallback',
//   fallbackReason: 'quota-exhausted',
// }
```
