# Provider endpoint audit — November 16, 2026

This audit prioritizes endpoint qualification for the existing models. It does not rank models or change their configured executors or production restrictions.

The captured window is October 19 through November 16 at 21:00 UTC: 355 eval rows, 109 task identities. Stored SDK summaries retain distinct attempts; repeated evals do not count the same SDK events twice. Fifty-one overlapping summaries are conservatively excluded whole, and twenty rows lack summaries. This is an evaluated-task cohort, not account billing or a complete inventory of running/failed tasks. Native historical costs are mostly estimates; upstream host identity was generally unavailable before HOK-3495. Older broad session joins and partial usage coverage limit how confidently these figures describe recent traffic.

The SDK prices each captured model's fixed token/cache mix at the current endpoint catalog rates. Unknown cache rates stay unknown. These counterfactuals do not assume that another endpoint will reproduce the cache hit rate, tokenization, quality or latency.

| Model | Stored SDK cost, USD | Explicit comparison reference at current rates | Cheapest priced endpoint | Fixed-mix estimate, USD | Potential reduction against reference |
| -- | --: | -- | -- | --: | --: |
| Kimi K2.7 Code | 47.90 | `moonshotai`: 52.98 | `coreweave/int4` | 33.74 | 19.24 (36%) |
| Gemini 2.5 Pro | 29.93 | `google-ai-studio`: 29.93 | `google-ai-studio/flex` | 14.96 | 14.96 (50%) |
| GLM 5.3 Flash | 28.88 | `z-ai/fp8`: 18.55 | `darkbloom/fp4` | 7.44 | 11.11 (60%) |
| Gemini 3.1 Pro Preview | 21.84 | `google-ai-studio`: 21.84 | `google-vertex/global/flex` | 10.92 | 10.92 (50%) |
| Kimi K3 | 0.95 | `moonshotai`: 0.92 | `wafer/us` | 0.34 | 0.58 (63%) |
| Qwen 3 Coder | 0.13 | No exact configured reference | `venice/fp8` | 0.14 | Unknown |

The stored cost and current-rate reference columns use different prices and must not be subtracted. Gemini and GLM references are explicit operator comparisons, not claims about historical execution. Fifteen additional configured OpenRouter models have no retained SDK segments in this cohort; they are listed as unmeasured, not assigned zero spend. Catalog snapshots cover all 21 configured OpenRouter models, including those with no currently listed endpoints.

K2.7 is the first qualification target, followed by GLM Flash. K3 remains an important incident-specific target despite its small completed-task footprint. Gemini Flex is a separate service-tier opportunity worth testing next; an unconstrained Google route has no demonstrated historical baseline host in these records. Anthropic and OpenAI models retain their native CLIs.

## Captured audit inputs

- `catalogs.json`: current public endpoint metadata, exact tags and prices.
- `cohort.jsonl`: prompt-free eval projections; session and event identifiers are redacted through the existing Hokusai redactor with one consistent salt so deduplication is reproducible.
- `audit.json`: SDK cost reports, per-endpoint fixed-mix estimates, exclusions and unmeasured models.

Reproduce without network or model requests:

```sh
node tools/audit-provider-endpoints.ts --since 2026-10-19T00:00:00Z --until 2026-11-16T21:00:00Z \
  --evals docs/experiments/provider-endpoint-audit-2026-11-16/cohort.jsonl \
  --catalogs docs/experiments/provider-endpoint-audit-2026-11-16/catalogs.json \
  --references glm-5.3-flash=z-ai/fp8,gemini-2.5-pro=google-ai-studio,gemini-3.1-pro-preview=google-ai-studio \
  --output /tmp/provider-audit-reproduced.json
```

The registry used for the capture came from merged integration commit `99702dcb`. Raw private transcripts and credentials are excluded from this directory.

## Follow-up protocol and harness corrections

The initial follow-up used code `b691fe64` and reserved a combined $25: $10 K2.7 (`moonshotai` vs `coreweave/int4`), $7 GLM Flash (`z-ai/fp8` vs `darkbloom/fp4`), and $8 K3 (`moonshotai` vs `wafer/us` and `relace/fp4`). Every study retained the five-point/95%-confidence reliability bar, two-times p95 latency tolerance, standard compatibility gate, and both paired workflow/cache-heavy profiles. Seventy-three complete pairs are required even with zero losses. No higher spend or weaker reliability bar is inferred from a passing short canary.

The comparison now preregisters a compact, lazily expanded complete order. The existing SDK total plus the full next-run reserve decides admission; inexpensive past runs no longer consume a fictitious $1 each. Missing accounting stops the study. A rejected candidate receives no further probes, and testing stops when no viable candidate remains. No task retry bucket or pricing engine is added.

The workflow prompt now orders both edits and test execution before the completion marker. Endpoint contract v2 invalidates earlier endpoint qualifications while leaving legacy model-only identities unchanged. Budget/provider stops retain repository/mutation evidence before cleanup, including rejected mutation counts.

The initial K2.7/GLM probes completed their fixture tasks but immediate generation metadata was incomplete. Read-only follow-up GETs recovered some records, while at least one retained ID continued returning 404. The shared generation client now uses the existing bounded network retry for 404/429/5xx and transport errors; permanent authentication refusals are not retried. Operator studies retain ownership records and transcripts in their explicit private evidence root after deleting disposable repositories. These requests recover observations; they never replay model execution.

The targeted K2.7 and GLM retests used `e33de9de`, with caps of $9.99 and $6.99 so their combined original/retest charges stay within their initial allocations. Their original inconclusive results remain preserved. K3's definitive failure was not rerun to obtain a pass.

## K3 failure evidence

The requested Moonshot K3 reference again exhausted its six-turn budget. It recorded seven rejected mutation calls, including five malformed `apply_patch` payloads. Captured arguments contain an `atomic ` key with a trailing space and corrupted `operations` keys. The valid mutation contract rejects them without changing source. The replay lives in `tests/fixtures/endpoint-qualification/captured-corrupt-arguments.json`; it is captured evidence, not the earlier reconstruction.

The original HTTP wire was not retained, so these arguments alone cannot locate corruption between inference, upstream streaming and adapter parsing. Recovered generation metadata corroborates Moonshot for the available responses, but missing rows remain explicit. Wafer US passed short compatibility; Relace remained inconclusive for missing host evidence. The failed reference stopped K3's paired phase. Production restrictions remain unchanged.

See [OpenRouter's provider routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection) for request restrictions and service-tier behavior. Catalog availability and low advertised input prices do not independently establish workload savings or qualification.


## Final follow-up results

| Study | Completed runs | Complete paired repetitions | Outcome |
| -- | --: | --: | -- |
| K2.7 initial | 2 | 0 | Tasks completed; host evidence incomplete, inconclusive |
| GLM initial | 2 | 0 | Tasks completed; host evidence incomplete, inconclusive |
| K3 follow-up | 3 | 0 | Moonshot corruption/budget failure; Wafer US short pass; Relace host evidence missing |
| K2.7 metadata retest | 15 | 3 | CoreWeave failed the next workflow's six-turn limit after a rejected mutation; candidate rejected and testing stopped |
| GLM metadata retest | 4 | 0 | Both endpoints exceeded the workflow turn limit; candidate rejected and testing stopped |

All 26 metered attempts are represented in `combined-cost.json`: SDK total **$0.218960072**, including fallback estimates; reported-charge subtotal **$0.211071072**. The SDK's `estimatedUsd` is its alternative estimate subtotal and must not be added to `actualUsd`; `totalUsd` is the combined figure to use. These are measurement-time figures, not a promise that every billed charge is known. Later read-only metadata recovery does not erase the original evidence gaps or change these saved outcomes. The normal consent-gated queue recorded every original attempt.

No tested alternative qualifies for promotion. Three complete K2.7 pairs are far short of the required 73, and the subsequent rejection remains authoritative. HOK-3497 stays gated; production pins are unchanged. This outcome does not establish that all other endpoints are unsafe: StreamLake/Inceptron for K2.7, other GLM hosts, and Gemini Flex remain untested opportunities. Their catalog prices alone do not authorize production selection.
