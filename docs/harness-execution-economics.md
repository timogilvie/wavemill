---
title: Harness Execution Economics
---

# Harness Execution Economics (HOK-2958)

Wavemill ingests Claude Code and Codex session/turn telemetry into one
versioned, provider-independent execution-economics record and joins it to the
requested/resolved route, executed-stage evidence, workflow cost, and eval/PR
outcomes. Collection is observation-only: it never changes routing or workflow
behavior, and the record is **local-only** (excluded from Hokusai submissions).

## Where it lives

| Concern | Location |
|---|---|
| Contract types + `EXECUTION_ECONOMICS_SCHEMA_VERSION` | `shared/lib/eval-schema.ts` / `$defs` in `shared/lib/eval-schema.json` |
| Parsing (per-session/turn detail) | `ClaudeSessionAdapter` / `CodexSessionAdapter` in `shared/lib/session-adapters.ts` (`SessionUsageResult.externalSessions`) |
| Normalization + joins | `shared/lib/execution-economics.ts` |
| Persistence | `executionEconomics` on the eval record (`evals.jsonl`), attached via `attachExecutionEconomics` in `shared/lib/eval-record-builder.ts` |
| Collection | fail-soft collectors in `shared/lib/post-completion-hook.ts` and `shared/lib/eval-orchestrator.ts` |
| Corpus-quality report | `npx tsx tools/execution-economics-report.ts [--json]` |

## Supported source versions

| Harness | Contract | Observed versions | Session files |
|---|---|---|---|
| Claude Code | `claude-code/1` | ≥ ~2.1.x (fields verified at 2.1.270; older 2.1.2xx sessions degrade gracefully) | `~/.claude/projects/<encoded-worktree>/*.jsonl` |
| Codex | `codex/1` | ≥ ~0.15x (fields verified at CLI 0.154.0) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |

Each block stamps `schemaVersion` (the record contract, currently `1.0.0`),
`providerContractVersion` (the parser contract above), and per-session
`harnessVersion` (the observed `version` / `cli_version`).

## Field mapping

The issue-level requirement names are snake_case; persisted fields are
camelCase (matching every other eval-record block):

| Requirement | Persisted field |
|---|---|
| `schema_version` | `schemaVersion` |
| `provider_contract_version` | `providerContractVersion` |
| `harness` / `harness_version` | `harness` / `sessions[].harnessVersion` |
| session/root/parent/turn IDs | `sessions[].sessionId`, `sessions[].rootSessionId`, `turns[].turnId`, `turns[].parentId` |
| trigger source + provenance | `sessions[].triggerSource.{value,provenance,availability}` |
| requested / forced / resolved / executed model | `sessions[].models.{requested,forced,resolved,executed}` + `models.provenance` |
| `actual_cost_usd` / `estimated_cost_usd` | `sessions[].actualCostUsd` / `sessions[].estimatedCostUsd` |
| cost source, pricing timestamp/revision | `sessions[].costSource`, `sessions[].pricingTimestamp`, `sessions[].pricingRevision` |
| token/cache/reasoning usage | `usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens}` |
| coverage (record + field level) | `coverage` + `sessions[].coverage` + `sessions[].fieldAvailability` |
| conflict state | `sessions[].models.conflict` |

Source-field provenance per harness:

| Normalized | Claude Code | Codex |
|---|---|---|
| `sessionId` | `sessionId` (entry) | `session_meta.payload.id` |
| `turnId` / `parentId` | `uuid` / `parentUuid` | `turn_context.payload.turn_id` / `root_turn_id` |
| `isSubagent` | `isSidechain` | not available (`null`) |
| `triggerSource` | `promptSource` (first non-sidechain user prompt on the branch) | `session_meta.payload.originator` (fallback `source`) |
| `reasoningTokens` | `usage.output_tokens_details.thinking_tokens` (already included in `output_tokens`) | `reasoning_output_tokens` (billed as output; added to output for estimates) |
| `cacheWriteTokens` | `cache_creation_input_tokens` | `last_token_usage.cache_write_input_tokens` (absent from cumulative totals) |
| `actualCostUsd` | absent in current versions → `null` | absent → `null` |

## Degradation behavior

Missing fields are **availability diagnostics, never parser failures**:

- Old Claude Code entries lacking `uuid` / `isSidechain` / `thinking_tokens`
  produce turns with `null` in those positions plus a per-session diagnostic;
  the aggregate `models` result is unchanged.
- Codex files with only cumulative `total_token_usage` (no `last_token_usage`,
  no `turn_id`) produce session-level usage with turn identity `null` and
  `perTurnUsage: unavailable`; when per-turn deltas disagree with the
  cumulative totals, the session totals stay authoritative and a diagnostic is
  recorded.
- A missing or unpriced value is `null` with `unavailable`/`partial` coverage —
  **never a fabricated `0`**. A literal zero cost appears only as `known_zero`,
  which requires explicit zero pricing for every model involved.

## Join semantics and confidence tiers

1. **`branch_worktree`** (discovery): sessions are selected by `gitBranch` /
   `cwd` match; the block's `joinEvidence` records the issue and branch.
2. **`timestamp_window`** (stage attribution): a session whose timestamps
   overlap exactly one `.{stage}-result.json` window gets that `stageRole`;
   route intent (`routing.jsonl` requested/resolved per role) is joined only
   for attributed sessions.
3. **`unattributed`**: zero or ambiguous window overlaps. The session is still
   persisted, with evidence describing the ambiguity.

When the resolved route model was never observed executing, the disagreement is
recorded in `models.conflict` (`{otherSource, otherResolvedModel, detail}`,
mirroring `ExecutedIdentity.conflict`) — both values stay visible, and
first-party stage evidence outranks route intent in the conflict detail. No
causal or off-policy claim may be made from this telemetry alone.

## Privacy exclusions

Adapters copy only allowlisted fields, so the following never reach persisted
records (regression-tested with poisoned fixtures): `user.email`,
`organization.id`, `user.account_uuid`, any other `user.*`/`organization.*`
key, `cwd`, transcript file paths, `git.repository_url`, rate limits, prompts,
and transcript content. Session/turn UUIDs are pseudonymous by construction and
kept as local join keys only. The whole `executionEconomics` block is excluded
from `toHokusaiSubmission` (allowlist projection) until the cross-repo
contribution schema and privacy audit explicitly allow it.

## Workflow-cost interaction

`computeWorkflowCost` for Claude/Codex now always emits `attribution`; unpriced
models carry no `costUsd` in attribution rows (`coverage: unavailable` when
nothing is priced, `partial` when mixed) while the legacy
`models[...].costUsd`/`totalCostUsd` numeric view is preserved for old readers.
When per-session detail exists, `attribution.sessions`/`attribution.turns` are
real observed records (Codex no longer reports one turn per session there), and
provider-reported session cost — when a future harness version supplies it — is
retained as `providerReportedCostUsd` alongside the local estimate.

## Rollback

The change is additive. Reverting the adapter/schema commits restores
aggregate-only external cost scanning with no data migration; readers must
ignore the optional `executionEconomics` field when absent (records without it
still validate).
