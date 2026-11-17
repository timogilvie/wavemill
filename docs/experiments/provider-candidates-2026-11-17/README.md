# Next endpoint candidates — November 17, 2026

This round follows the [November 16 audit](../provider-endpoint-audit-2026-11-16/README.md). It tests new endpoints and retains the earlier rejected and inconclusive evidence. It does not change model selection, executors or production routing.

The harness is integration commit `f1b177e4e4be0620a6189ce5735a5fd2a42cb75f`. The qualification, generation-client and dependency-lock files are unchanged from merged PR #1870; installed Pi versions match the lockfile. The operator commands execute from this exact isolated checkout; this does not assert that the running mill monitor has been rebuilt.

## Preregistration

| Model | Exact reference tag | Exact new candidate tags | Study cap |
| -- | -- | -- | --: |
| Kimi K2.7 Code | `moonshotai` | `streamlake`, `inceptron/int4` | $10 |
| Gemini 2.5 Pro | `google-ai-studio` | `google-ai-studio/flex` | $7 |
| Gemini 3.1 Pro Preview | `google-ai-studio` | `google-vertex/global/flex`, `google-ai-studio/flex` | $7 |

The $24 combined allocation fits within the prior $25 authorization after the preceding studies' measured spend. Current public catalogs were captured on November 17. Each immutable `.plan.json` and `.catalog.json` was written by the shared CLI before its first paid request. Each study uses the same fixed model, tools and workflow/cache-heavy profiles, a five-percentage-point completion regression bound at 95% confidence, and a two-times reference p95 latency tolerance. The existing Wilson bound requires 73 complete paired repetitions even with no observed losses.

The established protocol is unchanged: standard compatibility first, then the complete preregistered rotating order. SDK-accounted spend plus the next full attempt reserve governs admission. Missing accounting stops probing; definitive candidate rejection stops further requests to that candidate, and no remaining viable candidate ends the study. Failed and partial repetitions remain in the run ledger and cost report. A new candidate's passing short probe cannot erase an older candidate's failure or establish production reliability.

Requests explicitly restrict the catalog tag and disable fallback through the shared model builder. Generation metadata must corroborate the observed host. The observed display name does not independently attest a deployment, quantization or service tier; this is especially relevant when standard and Flex tags share a host name. The report retains actual charge coverage and latency rather than inferring savings from advertised rates.

## Evidence

The plans, catalog snapshots, append-only run ledgers, final reports and feedback-export statuses are preserved here. They contain canonical redacted provider facts and SDK costs. Raw operator transcripts and ownership records remain in the private evidence roots outside the repository; credentials and raw generation identifiers are excluded.

Use `node tools/native-agent-qualify-endpoints.ts --help` for the operator command. The exact model/reference/candidate tags and spend limits above, paired with the saved catalog, reproduce each declared plan. A new live study must use a fresh output path and preserve these historical results.

## Results

| Candidate | Compatibility | Paired result | Verdict under the existing protocol |
| -- | -- | -- | -- |
| K2.7 `streamlake` | Pass | Workflow passed; cache-heavy sentinel had one extra trailing blank line | Rejected by exact-byte check |
| K2.7 `inceptron/int4` | Inconclusive | Upstream 429 rate-limit errors across both allowed attempts; no pairs | Insufficient evidence |
| Gemini 2.5 `google-ai-studio/flex` | Pass | First workflow exhausted six turns; the standard reference did too | Rejected by turn limit |
| Gemini 3.1 `google-vertex/global/flex` | Inconclusive | Compatibility reached the 240-second model-time limit; no pairs | Insufficient evidence |
| Gemini 3.1 `google-ai-studio/flex` | Pass | First workflow exhausted six turns; the standard reference did too | Rejected by turn limit |

K2.7 completed seven runs and one complete paired repetition; Gemini 2.5 completed four runs and no complete pairs; Gemini 3.1 completed five runs and no complete pairs. Inceptron's retry makes **17 attempts across 16 runs**. All 17 canonical attempt outcomes were enqueued through the existing consent gate. No candidate was rerun to erase a failure, and requests stopped when the declared gates left no viable candidates.

`combined-cost.json` is the existing SDK's report over every retained attempt: **$0.32469277** accounted total. The SDK reports the same actual-charge subtotal; generation metadata coverage is still partial for the inconclusive Inceptron/Vertex probes, so this is not a complete-billing guarantee. Its alternative estimate subtotal is **$0.324697**, which must not be added to the actual subtotal. All failed attempts and retries are included.

No candidate qualifies under the unchanged protocol, and 73 complete repetitions were not reached. HOK-3497 remains gated; no production routing or model/executor changes were made. These results do not establish that every cheaper endpoint is less reliable than its reference.

### StreamLake's exact-byte failure

`streamlake-mutation.json` retains the captured synthetic patch arguments without model reasoning or raw response identifiers. The edit's `oldText` omitted the existing final newline, while `newText` included a final newline. The untouched original newline therefore remained, leaving one additional trailing blank line. Hashing the expected sentinel plus one newline reproduces the recorded actual hash exactly.

The retained `run_tests` event also records `node --test tests/canary.test.ts` exiting successfully with code 0. The functional fixture passed.

The extra blank line violates the task's explicit full-content contract. It is **not evidence of semantic TypeScript corruption**. The original `wrong_mutation` result is preserved and is not retrospectively converted to a pass.

### Interpretation and next decision

The strict protocol is exposing both endpoint availability problems and a mismatch between its acceptance criteria and broader production reliability: the unchanged reference endpoints also exhausted the short workflow budget, and StreamLake's substantive rejection was a harmless formatting difference. The studies support their declared verdicts; they do not support a broad claim that the alternative providers are unsafe.

Before another provider sweep or any HOK-3497 promotion, preregister a calibration study that separates functional correctness and malformed structured calls from formatting-only differences, and validates a common representative workflow budget against the references. Apply the same declared checks and resource controls to every endpoint, retain these earlier outcomes, and keep Hokusai's model/executor policy intact. Changing the criteria after seeing this round must not relabel these saved results or grant a certificate retroactively.

## Validation

The existing endpoint comparison and qualification tests passed (5 tests), installed runtime pins match the lockfile, all study processes exited successfully, and the reports contain every attempt and export status. This change adds evidence and documentation only; shared harness code is unchanged.
