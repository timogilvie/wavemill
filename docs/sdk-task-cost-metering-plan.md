# Task cost metering as the SDK entry point

## Outcome

A harness author can install a Hokusai SDK package, identify a task, and receive a trustworthy local cost summary from usage events or supported Claude Code/Codex session files. No account, API key, routing call, or contribution is required. Wavemill uses this SDK for its workflow cost and execution-economics reporting; its old measurement and pricing implementation is retired after parity validation. Contribution remains a separate, explicit action that can consume the resulting summary.

## Why now

Harness authors want cost per task and comparable per-model/per-backend accounting. The [relay issue](https://github.com/ebibibi/ebi-agent-chat-relay/issues/713) asks for a persisted turn ledger and conversation/backend totals. The [HarnessTax discussion](https://news.ycombinator.com/item?id=49733726) shows interest in cost comparisons, but benchmark results cannot answer what a developer's own workload costs. Our current SDK mostly asks hosts to supply `actualCostUsd` for outcome submission; it does not give them an independent measurement product.

## Starting point

- `hokusai-sdk/packages/core/src/pricing.ts` prices one model/usage observation; `session-usage.ts` contains Claude Code baseline/transcript fallback. `@hokusai/router` accepts a caller-supplied actual cost.
- Wavemill `shared/lib/session-adapters.ts`, `workflow-cost.ts`, and `execution-economics.ts` scan Claude Code/Codex/native sessions, apply model pricing, preserve source/coverage, and persist eval economics. `post-completion-hook.ts` and `eval-orchestrator.ts` are principal call sites.
- Wavemill's cost module also supplies pricing helpers to routing, native-agent, backfill, and analysis code. Migration must inventory and replace these imports, not just change the final report line.
- HOK-2958 and HOK-2520 already delivered much of the parsing/provenance groundwork. The public site has a custom-harness integration track from HOK-2493; it currently emphasizes routing and contribution.

## Product contract

Offer an event-based API such as `createTaskCostTracker({taskId, prices, store?})`, `tracker.record({eventId, model, usage, providerCostUsd?, occurredAt, harness})`, and `tracker.summary()`. An optional `measureTask({taskId, source}, run)` wrapper makes the common event-emitting harness case one import and one call around existing execution. For Claude Code and Codex, provide an opt-in file adapter with explicit task/session boundaries. Do not promise automatic metering for arbitrary clients that emit no usage.

The result includes total cost, per-model and per-harness totals, token/cache/reasoning usage, event/turn count, source (`provider_reported`, `local_estimate`, or `none`), price revision/date, coverage (`complete`, `partial`, `unavailable`, `known_zero`), and diagnostics. Unknown cost remains null/absent, never zero. Distinguish metered API charges from token-equivalent estimates under CLI subscriptions; do not add unlike amounts under a single unlabeled “bill.” Deduplicate replayed events, support multi-model tasks, and avoid double counting cumulative usage snapshots.

Local measurement is the default. Raw prompts, transcript text, credentials, filesystem paths, and account identifiers do not enter the ledger or leave the machine. Network submission, routing, and contribution are separate opt-in integrations. Price tables support explicit host overrides and source/date metadata; provider-reported cost wins when available.

## Architecture and migration sequence

1. **Contract and golden corpus.** Define event/summary schemas, attribution and pricing precedence, task boundaries, replay semantics, source labels, and sanitized cross-repo fixtures. Capture Wavemill outputs as comparison fixtures before moving code.
2. **SDK core.** Implement provider-neutral accumulator, pricing and normalization, optional local ledger/query API, and a short public entry point. Keep `@hokusai/core` compatibility where possible; use a dedicated `@hokusai/costs` package if its dependency boundary is cleaner.
3. **SDK adapters.** Move reusable Claude Code/Codex parsing out of Wavemill-specific joins; add file/session correlation and an event-source adapter. Native/Pi usage enters through the generic event API. Run the same fixtures in SDK and Wavemill.
4. **SDK release.** Publish a tested package with typed examples, privacy and accuracy guidance, a migration note for `resolveActualCostUsd`, and a runnable offline example. Verify the two-line path actually works from a clean install.
5. **Wavemill integration.** Add an adapter from SDK summaries to existing `WorkflowCostOutcome`, execution-economics, eval schema, and reports. Preserve historical eval readability and Hokusai submission projection. Shadow compute on a representative corpus, compare totals, coverage, attribution, model identity, and pricing snapshots, then switch the reporting path.
6. **Retire duplicates.** Migrate remaining pricing consumers and backfill tools, remove duplicated session/cost calculations, and keep only Wavemill-specific stage/branch/eval joins. Prove no production cost reporting imports the retired engine.
7. **Site.** Present cost tracking as a standalone custom-harness starting point, with examples that run locally and a clearly optional route/contribute continuation. Site snippets must be checked against the published SDK.

## Delivery issues and dependencies

| Key | Project | Issue | Blocked by |
|---|---|---|---|
| [HOK-3072](https://linear.app/hokusai/issue/HOK-3072) | Hokusai SDK | Define public task cost contract and golden fixtures | — |
| [HOK-3071](https://linear.app/hokusai/issue/HOK-3071) | Hokusai SDK | Build event-based task cost accumulator and pricing | HOK-3072 |
| [HOK-3069](https://linear.app/hokusai/issue/HOK-3069) | Hokusai SDK | Add local ledger and task/model/backend queries | HOK-3071 |
| [HOK-3070](https://linear.app/hokusai/issue/HOK-3070) | Hokusai SDK | Extract Claude Code and Codex session adapters | HOK-3072, HOK-3071 |
| [HOK-3073](https://linear.app/hokusai/issue/HOK-3073) | Hokusai SDK | Ship drop-in API, offline example, and package release | HOK-3069, HOK-3070 |
| [HOK-3074](https://linear.app/hokusai/issue/HOK-3074) | wavemill | Capture cost-reporting parity corpus and consumer inventory | HOK-3072 |
| [HOK-3075](https://linear.app/hokusai/issue/HOK-3075) | wavemill | Integrate SDK summaries into eval and workflow cost reporting | HOK-3073, HOK-3074 |
| [HOK-3076](https://linear.app/hokusai/issue/HOK-3076) | wavemill | Shadow compare, switch reporting, and preserve historical reads | HOK-3075 |
| [HOK-3077](https://linear.app/hokusai/issue/HOK-3077) | wavemill | Migrate remaining cost consumers and retire duplicate engine | HOK-3076 |
| [HOK-3078](https://linear.app/hokusai/issue/HOK-3078) | Hokusai public website | Add local cost-tracking quick start and honest accuracy copy | HOK-3073 |
| [HOK-3079](https://linear.app/hokusai/issue/HOK-3079) | Hokusai public website | Connect optional routing/contribution path to measured summaries | HOK-3073, HOK-3078 |

The critical path is HOK-3072 → HOK-3071 → HOK-3070/HOK-3069 → HOK-3073 → HOK-3075 → HOK-3076 → HOK-3077. HOK-3074 can proceed alongside SDK implementation. Site work follows the SDK release without blocking Wavemill migration.

## Acceptance gates

- A clean project can install the SDK, run the offline example, and retrieve per-task and per-model totals with at most an import and one wrapper call when its harness emits usage events.
- Idempotency, cumulative-vs-delta usage, model switches, cache pricing, partial/unpriced usage, provider-reported overrides, and explicit known-zero cases have fixture coverage. Subscription estimates are visibly distinct from charges.
- SDK ledger stores only allowlisted numeric/categorical telemetry, persists/reloads deterministically, and supports task and backend queries without any Hokusai credentials or network calls.
- Wavemill parity compares a representative corpus across Claude Code, Codex, and native/Pi where present. Every cost discrepancy is explained or fixed; no partial coverage is silently promoted to complete or zero.
- Wavemill's completion/eval/report paths use the SDK. Existing records remain readable. Privacy tests confirm no new economics data enters Hokusai submissions without a separate approved change.
- Remaining Wavemill pricing/routing/backfill callers are migrated or explicitly documented as Wavemill-only policy. Duplicate measurement code is removed.
- Site examples compile or run against the published SDK, and separate measurement from optional routing and contribution.

## Risks and decisions

- Transcript formats are unstable; adapters must carry source-version diagnostics and fail soft. Correlation by “newest file” alone is insufficient for concurrent tasks.
- Local price catalogs change and may not reflect tiered or negotiated billing. Preserve the pricing snapshot and prefer provider-reported actual cost. Do not retroactively relabel estimates as actual charges.
- Wavemill's legacy `totalCostUsd` can represent partial totals. The SDK result must expose coverage, and the Wavemill bridge must preserve its current schema while preventing a partial value from being presented as complete.
- The site should not launch an automatic upload or contribution flow as part of cost tracking. If we later add an explicit “contribute this task” action, it needs separate consent and privacy review.

## Rollback

Keep the Wavemill legacy calculation behind an internal switch through the shadow period. If parity or production reporting fails, return reads to the old engine while retaining additive SDK ledger data. Remove that switch only after the duplicate engine is retired in issue I. SDK event and ledger schemas are versioned so a package rollback can still read prior records.
