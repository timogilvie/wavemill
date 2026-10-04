---
title: OpenRouter Launch-Priority Activation Plan
---

# OpenRouter Launch-Priority Activation Plan

## Situation

PRs #735, #739, and #744 did enable the intended foundation in their merged
branches:

- #735 added the launch-priority fixture and OpenRouter catalog sync.
- #739 added OpenRouter provider, launcher, registry, policy, and routing
  integration.
- #744 enabled model-diversity defaults, router exploration, challenge
  recommendation, and coverage targets.

The current `main` checkout no longer contains the #735/#739 OpenRouter files or
their commits. `main` includes #744's diversity defaults, but lacks the
OpenRouter provider and catalog surfaces. As a result, OpenRouter models cannot
enter the effective router pool, Hokusai candidate pools, or challenge
recommendations.

## Launch-Priority Model Set

Restore and activate the launch-priority aliases identified in #735:

Tier 1 active:

- `claude-opus-4-8` -> `anthropic/claude-opus-4.8`
- `claude-opus-4-7` -> `anthropic/claude-opus-4.7`
- `claude-sonnet-4-6` -> `anthropic/claude-sonnet-4.6`
- `gpt-5.5` -> `openai/gpt-5.5`
- `gpt-5` -> `openai/gpt-5`
- `deepseek-r1` -> `deepseek/deepseek-r1`
- `deepseek-v3` -> `deepseek/deepseek-chat-v3`
- `qwen-2.5-coder-32b` -> `qwen/qwen-2.5-coder-32b-instruct`
- `qwen-3-coder` -> `qwen/qwen3-coder`
- `kimi-k2` -> `moonshotai/kimi-k2`
- `gemini-2.5-pro` -> `google/gemini-2.5-pro`

Tier 2 active/watchlist:

- `claude-haiku-4-5` -> `anthropic/claude-haiku-4.5`
- `claude-fable-5` -> `anthropic/claude-fable-5`
- `gpt-5-mini` -> `openai/gpt-5-mini`
- `deepseek-coder-v2` -> `deepseek/deepseek-coder-v2-instruct`
- `qwen-3-235b` -> `qwen/qwen3-235b-a22b-instruct`
- `kimi-k2-thinking` -> `moonshotai/kimi-k2-thinking`
- `gemini-2.5-flash` -> `google/gemini-2.5-flash`
- `llama-3.3-70b` -> `meta-llama/llama-3.3-70b-instruct`
- `llama-4-maverick` -> `meta-llama/llama-4-maverick`
- `mistral-large-2` -> `mistralai/mistral-large-2411`
- `devstral-small` -> `mistralai/devstral-small`
- `devstral-medium` -> `mistralai/devstral-medium`

Tier 3 watchlist/deprecated:

- `gpt-4.1` -> `openai/gpt-4.1`
- `o3-mini` -> `openai/o3-mini`
- `qwen-2.5-72b` -> `qwen/qwen-2.5-72b-instruct`
- `gemini-2.0-flash` -> `google/gemini-2.0-flash-001`
- `llama-4-scout` -> `meta-llama/llama-4-scout`
- `mistral-medium-3` -> `mistralai/mistral-medium-3`
- `grok-code-fast` -> `x-ai/grok-code-fast-1`

## Goal

Make OpenRouter launch-priority models eligible for real traffic in three ways:

1. Normal routing can select them when policy and config allow.
2. Challenge mode can choose them as challenger models, especially for sparse
   model-stage cells.
3. Hokusai routing receives them in candidate pools and exports evidence rows
   that make zero-traffic gaps visible.

## Plan

### 1. Restore Lost OpenRouter Foundation

Reapply the functional parts of PRs #735 and #739 onto current `main`, resolving
against the latest router and Hokusai audit code instead of replaying blindly.

Required files/surfaces:

- `shared/fixtures/model_30_launch_priority_models.v1.json`
- `shared/lib/openrouter-catalog.ts`
- `shared/lib/openrouter-catalog.test.ts`
- `tools/sync-openrouter-catalog.ts`
- `shared/lib/openrouter-provider.ts`
- `shared/lib/openrouter-provider.test.ts`
- `shared/lib/openrouter-launcher.ts`
- `shared/lib/openrouter-launcher.test.ts`
- `tools/launch-openrouter.ts`
- `shared/lib/config.ts`
- `wavemill-config.schema.json`
- `shared/lib/agent-adapters.sh`
- `shared/lib/model-registry.ts`
- `shared/lib/routing-policy.ts`
- `shared/lib/workflow-router.ts`
- `shared/lib/stage-aware-router.ts`
- Hokusai audit/contribution files touched by #739, reconciled with #747.

Acceptance:

- `rg --files shared/lib tools shared/fixtures | rg "openrouter|model_30"` returns the catalog, provider, launcher, tests, fixture, and CLI.
- Config validation accepts `providers.openrouter`.
- `npx tsx tools/launch-openrouter.ts --help` works.

### 2. Make Provider Enablement Explicit and Safe

Add `providers.openrouter` to config with the same operational shape as
DeepSeek but with launch-priority alias support:

```json
{
  "providers": {
    "openrouter": {
      "enabled": true,
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "baseUrl": "https://openrouter.ai/api",
      "models": ["qwen-3-coder", "kimi-k2", "deepseek-r1", "gemini-2.5-pro"],
      "stages": ["planner", "coder", "reviewer"]
    }
  }
}
```

Implementation details:

- Keep Wavemill aliases slash-free; map each alias to its OpenRouter ID in the
  provider/catalog layer.
- Filter OpenRouter models out of router pools unless:
  - `providers.openrouter.enabled === true`
  - the configured API key env var is present
  - the model is present in the global effective-model projection
  - the workflow stage is enabled by global catalog metadata
- Emit clear router warnings when models are excluded for provider/key/stage
  reasons.

Acceptance:

- Without `OPENROUTER_API_KEY`, OpenRouter aliases are removed from candidate
  pools with a warning.
- With `OPENROUTER_API_KEY`, configured aliases remain in candidate pools.
- Disabled/unallowlisted aliases never launch.

### 3. Restore Registry Entries and Quality Priors

Add launch-priority aliases to `DEFAULT_MODEL_REGISTRY` with conservative
metadata:

- `vendor`: `openrouter` or the upstream family, with provider metadata carrying
  the OpenRouter ID.
- `agent`: `claude-openrouter` for Qwen, Kimi, Gemini, Llama, Mistral/Devstral,
  and Grok aliases.
- `agent`: keep `codex` for OpenAI aliases unless they are intentionally routed
  through OpenRouter for benchmarking.
- `defaultLadderEligible`: `false` for watchlist and unproven models; explicit
  ladder placement controls early traffic.
- `releasedAt`: set for recency boost where appropriate.
- `contextWindowTokens`, pricing, latency, reasoning tier, tool support, and
  multimodal fields from catalog snapshot or conservative fallback.

Initial ladder intent:

- Coding ladder: include `qwen-3-coder`, `qwen-2.5-coder-32b`, `kimi-k2`,
  `deepseek-r1`, `deepseek-v3`, `gemini-2.5-pro`, and `devstral-small`.
- Review ladder: include `qwen-3-coder`, `kimi-k2`, `deepseek-r1`,
  `gemini-2.5-pro`, `llama-3.3-70b`, and `mistral-large-2`.
- Planning ladder: include only higher-context/reasoning candidates at first:
  `kimi-k2`, `deepseek-r1`, `gemini-2.5-pro`, `qwen-3-235b`, and
  `mistral-large-2`.

Acceptance:

- `validateModelOrThrow()` accepts each launch-priority alias.
- `resolveAgent(alias, ...)` returns `claude-openrouter` for OpenRouter-only
  families.
- `getLadder()` includes only intended active aliases and excludes deprecated
  aliases.

### 4. Wire Launchers End to End

Restore `claude-openrouter` launch behavior from #739 and harden it:

- `agent_resolve_from_model()` maps OpenRouter families to `claude-openrouter`.
- `agent_binary_for_cmd()` maps `claude-openrouter` to `claude`.
- `agent_default_model_for_cmd()` returns `qwen-3-coder`.
- `agent_check_auth()` validates `OPENROUTER_API_KEY`.
- Launcher env exports:
  - `ANTHROPIC_BASE_URL`
  - `ANTHROPIC_AUTH_TOKEN`
  - `ANTHROPIC_MODEL`
  - `CLAUDE_CODE_SUBAGENT_MODEL`
  - `WAVEMILL_AGENT_KIND=claude-openrouter`
  - isolated `HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME`
- State discovery mirrors DeepSeek so dashboard/session tooling can attribute
  runs.

Acceptance:

- Dry-run launcher tests assert env construction for `qwen-3-coder` and
  `kimi-k2`.
- Missing API key exits with a distinct code and no partial launch.
- Shell tests cover interactive and non-interactive launcher paths.

### 5. Put Models Into Runtime Candidate Pools

Update the global v2 catalog/effective-model projection so the models can
actually receive traffic.

Global catalog/projection:

- Add pricing entries for at least tier-1 active challengers.
- Add tier-1 OpenRouter aliases with native-agent metadata.
- Add stage-specific global effective-model entries to control rollout.
- Consider local override for API-key-dependent provider enablement if shared
  config should not assume everyone has access.

Acceptance:

- `routeWorkflowAuto()` candidate pools include OpenRouter aliases when provider
  config and key are present.
- Challenge model pool contains OpenRouter challengers.
- Config sync does not remove these settings from downstream repos.

### 6. Ensure Exploration Produces Traffic

The current diversity defaults are not enough by themselves; exploration only
samples from viable candidates. Add targeted traffic controls:

- Seed the global challenge-eligible projection with all tier-1 active challengers.
- Lower `challengeScheduler.newModelChallengeCount` for launch-priority models
  if needed, so zero-record models are preferred until each has coverage.
- Add an OpenRouter-specific coverage target:
  - minimum 5 implementation-stage challenge records for each tier-1 coding
    model
  - minimum 3 review-stage records for review-eligible tier-1 models
  - minimum 2 planning-stage records for planning-eligible tier-1 models
- Add a temporary `router.exploration.launchPriority` or equivalent policy that
  boosts aliases from the launch-priority fixture until coverage thresholds are
  met.
- Keep production safety by making OpenRouter traffic challenge-first before it
  becomes primary-route traffic.

Acceptance:

- A route for a normal coding task with zero OpenRouter history emits a
  `challengeRecommendation` whose challenger is a launch-priority OpenRouter
  alias.
- The recommendation rotates to the next sparse model-stage cell after a record
  is added.
- `router-diversity-report` shows OpenRouter sparse cells explicitly.

### 7. Reconcile Hokusai Routing

The local overlay sends `auto` routing to Hokusai when
`router.hokusai.endpoint` is configured. Ensure OpenRouter candidates are not
lost before that call.

Work:

- Include OpenRouter aliases in `resolvePolicyStagePools()`.
- Apply OpenRouter provider filtering before sending candidate pools to Hokusai.
- Export `available_models` and selected OpenRouter aliases in contribution rows.
- Ensure zero-evidence OpenRouter cells appear in Hokusai audit output.
- Verify Hokusai fallback behavior does not discard OpenRouter aliases returned
  by the external router.

Acceptance:

- Hokusai request payload includes OpenRouter aliases in `plannerModels`,
  `coderModels`, and `reviewerModels` when eligible.
- Hokusai audit identifies tier-1 aliases with zero evidence.
- Returned OpenRouter selections summarize with `claude-openrouter` agent.

### 8. Verification Matrix

Run focused tests first:

```bash
node --test shared/lib/openrouter-catalog.test.ts shared/lib/openrouter-provider.test.ts shared/lib/openrouter-launcher.test.ts
node --test shared/lib/config.test.ts shared/lib/model-registry.test.ts shared/lib/routing-policy.test.ts
npx tsx shared/lib/workflow-router-native-certification.test.ts
bash tests/check-shell.sh
bash tests/wavemill-mill-model-flags.test.sh
npx tsx tools/check-routing.ts --json --prompt "Implement a small routing feature with tests"
```

Run live checks only when `OPENROUTER_API_KEY` is set:

```bash
npx tsx tools/sync-openrouter-catalog.ts --dry-run
npx tsx tools/launch-openrouter.ts --repo . --session wavemill --issue smoke --model qwen-3-coder
```

Success criteria:

- Config validates with `providers.openrouter`.
- Router pools include OpenRouter models only when provider prerequisites pass.
- Route summaries show `claude-openrouter` for OpenRouter selections.
- Challenge recommendation picks an OpenRouter alias for sparse model-stage
  coverage.
- At least one dry-run launcher path resolves OpenRouter env without starting a
  real task.

### 9. Rollout

Roll out in three stages:

1. Shadow: provider and registry present, candidates visible in audits, no
   automatic primary routing.
2. Challenge-first: OpenRouter aliases can appear as challengers for sparse
   model-stage cells.
3. Primary eligible: promote specific aliases into normal ladders after enough
   successful challenge records.

Promotion rule:

- A launch-priority model becomes primary-eligible only after it has enough
  successful challenge evidence for its role and no unresolved launcher/provider
  incidents.

Rollback:

- Set `providers.openrouter.enabled=false`.
- Remove aliases from the global effective-model projection.
- Leave registry entries disabled so historical eval attribution remains valid.
