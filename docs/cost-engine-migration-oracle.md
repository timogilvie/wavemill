# Cost Engine Migration Oracle — HOK-3074

A migration oracle for replacing Wavemill's cost engine with the Hokusai SDK, made of:

1. **Fixture corpus** (`shared/fixtures/cost-parity/manifest.json` + session files)
2. **Captured baseline** (`shared/fixtures/cost-parity/baseline.json`)
3. **Parity comparator** (`tools/cost-parity.ts`, `shared/lib/cost-parity.ts`)
4. **Consumer inventory** (`shared/fixtures/cost-parity/consumer-inventory.json`)

---

## Production Entrypoints

| Entrypoint | Call | Pricing Source | Exact OpenRouter |
|---|---|---|---|
| `post-completion-hook.ts:883-918` (mill/monitor) | `computeWorkflowCost` (sync) | `loadPricingTable(<wavemill install dir>)` | **no** |
| `eval-orchestrator.ts:494-535` (`wavemill eval`) | `computeWorkflowCostWithExactPricing` | `loadPricingTable(repoDir)` | yes, when `OPENROUTER_API_KEY` |
| Both → `collectExecutionEconomics` | Claude + Codex adapters → `buildExecutionEconomics` | `computeModelCost`/`loadPricingTable` | n/a |
| Both → `eval-record-builder.attachWorkflowCostMetadata` | writes `workflowCost`, `workflowTokenUsage`, `workflowCostStatus`, `pricingSnapshot`, `workflowCostAttribution`, `workflowCostDiagnostics` | — | — |

The same run can record different totals depending on which entrypoint wrote it. The corpus captures **both** the sync and the exact outcome for every case.

---

## Consumer Inventory

All direct importers are classified by role:

### Measurement (Production)

These compute cost. The SDK bridge (HOK-3075) replaces them:

- `shared/lib/post-completion-hook.ts` — post-completion descriptor
- `shared/lib/eval-orchestrator.ts` — eval workflow
- `shared/lib/eval-record-builder.ts` — record writer
- `shared/lib/execution-economics.ts` — economics aggregation
- `shared/lib/native-agent/loop.ts` — native result cost
- `shared/lib/native-agent/launch-planning.ts` — native launch planning

### Measurement (Wavemill-Only Join)

These use wavemill-specific session-discovery functions that have no SDK analogue:

- `shared/lib/session-adapters.ts`, `intervention-detector.ts`, `outcome-collectors.ts` — all use `resolveProjectsDirs`
- `shared/lib/deepseek-smoke.ts` — uses `encodeProjectDir`

These are **kept** (not migrated to SDK). The SDK's public API does not support wavemill-specific session paths.

### Pricing Policy (Production)

These read pricing tables or historical costs to inform routing decisions. The SDK bridge (HOK-3076) may adjust the interface:

- `shared/lib/eval.ts` — judge-call cost
- `shared/lib/stage-aware-router.ts` — stage priors (reads historical `workflowCost`)
- `shared/lib/workflow-router.ts` — model pool selection
- `shared/lib/challenge-scheduler.ts` — challenge model config
- `shared/lib/native-agent/certification/live-coding-canary.ts` — cost type

### Backfill and Schema (Offline)

- `shared/lib/model-promotion.ts`, `tools/backfill-*.ts` — one-off backfill tools (HOK-3077 or kept as-is)
- `shared/lib/eval-schema.ts` — schema types (duplicate attribution definitions; may be unified after migration)

### Indirect Consumers

Read fields that cost produces:

- **Reports**: `eval-aggregator.ts`, `eval-export.ts`, `eval-summary-printer.ts` (prod), `challenge-analyzer.ts`, `arbiter-r6-report.ts`, `execution-economics-report.ts`, `tools/compare-prs.ts`, `feature-state.ts`
- **Hokusai boundary**: `hokusai-schema.ts:806-812` takes `workflowCost` as `actual_cost_usd` for Hokusai submissions
- **Routing**: `src/evaluation/router-eval-adapter.ts` learns stage cost from historical `workflowCost`
- **CLI**: `llm-cli.ts:456` (separate cost producer)

---

## Legacy Behavior and Expected Fixes

### EF-1: Partial totals presented as complete

**Affected consumers**: Eligibility gates, route calibration, Hokusai submission, router priors, aggregator reports

**Current behavior**:

- In the Claude/Codex path, an unpriced model adds `0` to `totalCostUsd`
- `attachWorkflowCostMetadata` writes `record.workflowCost = totalCostUsd` regardless of coverage (`partial` → lower bound, `unavailable` → `0`)
- Downstream readers treat the value as a real total:
  - `computeEligibility` raises no `missing_cost` error
  - `computeRouteCalibration.actualCostUsd` uses it as fact
  - `stageOutcomes.routing.costUsd` reports it
  - Hokusai `actual_cost_usd` submission uses it
  - Stage-aware-router priors learn from it
  - Reports all print it as the real cost

**Proposed fix**:

- When `coverage !== 'complete'`, either omit `workflowCost` or set it to `null` (not `0`)
- Downstream eligibility/routing should check coverage before using the value
- Reports should flag partial/unavailable costs explicitly

**Evidence**: `workflow-cost.ts:731-736, 503-506`; `eval-record-builder.ts:862`; `hokusai-schema.ts:806`

---

### EF-2: Claude Code usage double-counted

**Affected consumers**: Cost totals, token attribution, historical priors

**Current behavior**:

- Claude Code writes one JSONL line per content block
- Each line repeats the same `message.id` with identical `usage`
- The adapter sums every line instead of deduplicating

**Verification**: Numeric-only check on a local session with 400 usage lines, 193 distinct message ids, 228 identical repeats, 0 differing

**Proposed fix**:

- Deduplicate by message id and requestId before summing

**Cross-repo status**: Hokusai SDK already fixes this (HOK-3070). The SDK's Claude adapter dedupes by message id and requestId, keeping the last occurrence. In migration mode, EF-2 is an expected fix the SDK bridge should satisfy.

**Evidence**: `session-adapters.ts:315-340`

---

### EF-3: Codex cached and reasoning tokens double-charged

**Affected consumers**: Cost totals, token attribution, historical priors

**Current behavior**:

- `cached_input_tokens` is a subset of `input_tokens` (not additional)
- `reasoning_output_tokens` is a subset of `output_tokens` (not additional)
- Wavemill prices the full input **plus** the cached tokens again at the cache-read rate
- Wavemill prices output **plus** reasoning separately

**Verification**: Local rollout with `{input:2978251, cached:2844672, output:8343, reasoning:545, total:2986594}` — totals confirm subsets, not additions

**Proposed fix**:

- Do not add cached tokens to input; subtract them from the base
- Do not add reasoning to output; use only the delta

**Cross-repo status**: Still present in hokusai-sdk (as of 2026-09-28):

- `sources/codex/parser.ts` maps `input_tokens` without subtracting `cached_input_tokens`
- `pricing-resolver.ts billableOutputTokens` adds `reasoning_tokens` to output
- `codex-simple` and `wavemill-golden` fixtures encode the same convention

A new SDK issue should block HOK-3075.

**Evidence**: `session-adapters.ts:724-734`

---

### EF-4: recalculateWorkflowCost loses attribution

**Current behavior**:

- Prices unpriced models at `0`
- Drops `attribution` metadata

**Impact**: Test-only function; no production callers

**Proposed fix**: Keep attribution, mark unpriced as `null` cost

**Evidence**: `workflow-cost.ts:916-955`

---

### EF-5: pricedSessions/unpricedSessions count models, not sessions

**Current behavior**:

- The counts track unique model ids in the session results, not the number of sessions
- A session with 2 models counts as 2 priced/unpriced sessions

**Impact**: Diagnostic fields; misleading only

**Proposed fix**: Count sessions (number of session files), not models

**Evidence**: `workflow-cost.ts:716-730`

---

### EF-6: Claude adapter returns null when files exist but no branch matches

**Current behavior**:

- The Claude adapter returns `null` when session files exist but no assistant turn matched the branch
- The engine then reports `no_sessions` / "No session files found"
- The `no_branch` status is unreachable for Claude

**Impact**: Diagnostic accuracy only

**Proposed fix**: Return a scan result with `turnCount: 0` so the engine can distinguish "no files" from "no matches"

**Evidence**: `session-adapters.ts:409`; `workflow-cost.ts:681-687`

---

### EF-7: Native exact pricing with any local fallback yields coverage `partial`

**Current behavior**:

- Native exact pricing is only attempted if all turns have responseIds
- If any turn falls back to local estimate, coverage becomes `partial`
- Source mix (mixed) gets conflated with completeness (partial)

**Impact**: Priors and reports treat partial accuracy as lower bound

**Proposed fix**:

- When all turns have a cost (exact or local), coverage is `complete` with source `mixed`
- Only mark partial when some turns are truly missing usage or pricing

**Evidence**: `workflow-cost.ts:540`

**SDK cross-reference**: The SDK uses coverage `complete` with source `mixed` for this case

---

### EF-8: Two production entrypoints differ in exact pricing

**Current behavior**:

- `post-completion-hook.ts` calls `computeWorkflowCost` (sync only)
- `eval-orchestrator.ts` calls `computeWorkflowCostWithExactPricing` (exact if enabled)
- Same run can record different totals depending on which entrypoint wrote it

**Proposed fix**: Unify entrypoints so exact pricing is available where needed

**Open decision for HOK-3075**: How to handle this without breaking the mill's determinism (post-completion runs synchronously, cannot wait for network)

---

### EF-9: post-completion descriptor uses `workflowCost \|\| undefined`

**Current behavior**:

- If `workflowCost` is `0` (genuinely zero cost), it is dropped from the descriptor

**Impact**: Known-zero costs are indistinguishable from missing costs

**Proposed fix**: Always include `workflowCost`, even if `0`

**Evidence**: `post-completion-hook.ts:582`

---

### EF-10: Codex workflow-cost path hard-codes `cacheCreationTokens: 0`

**Current behavior**:

- Current rollouts carry `cache_write_input_tokens`
- The parser ignores them and always writes `0`

**Proposed fix**: Parse and use `cache_write_input_tokens`

**Evidence**: `session-adapters.ts:728`

---

### EF-11: eval-schema.ts duplicates attribution types

**Current behavior**:

- `eval-schema.ts` (463-498) defines its own copy of attribution types
- `workflow-cost.ts` defines the canonical versions
- Both must be kept in sync

**Proposed fix**: Import from workflow-cost (or SDK) instead of duplicating

**Evidence**: `eval-schema.ts:463-498`

---

### EF-12: Pricing table differences

**Current behavior**:

- Wavemill's default table and the SDK's table differ on some models (e.g., claude-sonnet-5)
- This is independent of compute parity

**Proposed fix**: The corpus pins explicit per-case tables, so compute parity is tested apart from table parity

**SDK cross-reference**: Documented in hokusai-sdk's `task-cost/wavemill-parity.md`

---

## Strict-Parity Requirements (After SDK Integration)

These must hold for the SDK bridge in all non-expected-fix cases:

| Req | Description |
|---|---|
| **SP-1** | Token totals per model, except where EF-2/EF-3 apply |
| **SP-2** | Unpriced ⇒ no `costUsd` on attribution rows (null, never 0) |
| **SP-3** | `known_zero` only from explicit zero pricing or trusted provider zero |
| **SP-4** | Provider/OpenRouter exact cost wins over local estimate, with fallback per generation |
| **SP-5** | Native session dedupe by sessionId |
| **SP-6** | Failure statuses and diagnostic keys unchanged |
| **SP-7** | `pricingSnapshot` equals exactly the entries used |
| **SP-8** | eval-record field names and shapes (historical readability) |
| **SP-9** | **No transcript text in any output** (privacy canary) |
| **SP-10** | execution-economics block shape and coverage for non-EF cases |
| **SP-11** | Cache-multiplier defaults (1.25×/0.1×) |
| **SP-12** | USD tolerance 1e-9 |

---

## Running the Harness

```bash
# Regenerate baseline (after legacy engine changes)
npx tsx tools/cost-parity.ts --write

# Regression test (default)
npx tsx tools/cost-parity.ts
# Exit code 0 if all tests pass, 1 if differences found, 2 for corpus errors

# Inspect a case
npx tsx tools/cost-parity.ts --case claude-mixed-one-unpriced

# JSON output
npx tsx tools/cost-parity.ts --json
```

---

## Open Decisions for HOK-3075

1. **EF-1**: When coverage is partial/unavailable, should `workflowCost` be `null` or a lower bound?
2. **EF-8**: How to unify entrypoints without breaking mill determinism?

Document decisions in the SDK PR when they are resolved.

---

## See Also

- `shared/fixtures/cost-parity/README.md` — Running and debugging the harness
- `shared/fixtures/cost-parity/manifest.json` — Test case specification
- `shared/fixtures/cost-parity/consumer-inventory.json` — Machine-readable consumer list
- `shared/lib/cost-parity.ts` — Harness implementation
- `tools/cost-parity.ts` — CLI tool
- `shared/lib/cost-parity.test.ts` — Validation tests
