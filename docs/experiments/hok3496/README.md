# Kimi K3 endpoint pilot — November 16, 2026

This is a captured, bounded pilot, not a production reliability claim or permission to switch hosts. Production routing was not changed. All probes used Kimi K3, the existing native canary tools and limits, and exact catalog restrictions with fallback disabled.

The preregistration allowed $25, a maximum five percentage-point completion regression at 95% confidence, and a p95 latency ratio of two. It derived a requirement of 73 complete paired repetitions and reserved up to 25 canary runs. The compatibility phase stopped the experiment before paired workflows because the reference probe failed. No extra attempts were run to wash out that failure.

| Exact requested tag | Observed host | Compatibility result | Attempts | SDK total USD | Charge basis |
| -- | -- | -- | -- | -- | -- |
| `moonshotai` | Moonshot AI | Failed: existing six-turn budget exhausted | 1 | 0.1876902 | Reported generation charges |
| `wafer` | Wafer | Passed short mutation/completion probe | 1 | 0.008307528 | Reported generation charges |
| `relace/fp4` | Unknown | Task completed, host metadata unavailable: inconclusive | 1 | 0.007529 | SDK endpoint-rate estimate; billed charge unknown |

Total: **$0.203526728** including the Relace estimate. Known reported charges total **$0.195997728**. Reference and Wafer generation charge coverage is complete; Relace coverage is unavailable. The SDK's broader token/usage coverage remains partial (for example, missing reasoning counters); complete billing is not complete usage. See the report for latency and raw cache counters. A cost ratio from these three different outcomes would not establish task-level savings.

Paired repetitions completed: **zero**. Wafer and Relace have **insufficient evidence for promotion**. The reference failed this bounded probe; that finding does not revoke its existing production pin or establish a cheaper production alternative.

The pilot exposed a harness accounting defect: the canary supplied endpoint rates to its live budget but not to the SDK meter. When generation metadata was missing, the original Relace summary incorrectly carried a zero. The final code forwards rates to the existing SDK estimate adapter. `pilot-report.json` replays retained provider observations through that same SDK and records the correction while preserving the original runs and outcomes. No per-token formula was introduced and no model rerun was used for reconciliation. The three corrected canonical outcomes were enqueued through the existing consent gate.

Files:

- `preregistration.json`: plan saved before paid requests.
- `catalog.json`: captured public endpoint catalog, including exact tags and rate snapshots.
- `original-runs.jsonl`: immutable original outcome/contribution records, including the original accounting defect.
- `pilot-report.json`: reconciled report, original runs, all observed facts, coverage, uncertainty and feedback queue status.

The prototype ran from the HOK-3496 worktree based on integration commit `2b48c806`; the accounting correction and runtime-contract binding landed afterward in this implementation. Its pilot certificates are prototype evidence, not certificates to import into production. Current qualification must use the final runtime-bound subject and gate. Unknown deployment/quantization attestation remains explicit; catalog declarations do not independently prove the executed variant.

Reproduce the accounting report without paid requests:

```sh
# Put copies together using the CLI's <base>.plan.json/.catalog.json/.runs.jsonl naming.
node tools/native-agent-qualify-endpoints.ts --replay <base>.plan.json --output <new-report.json>
```

A subsequent live study needs its own immutable preregistration and must retain these results as prior evidence. HOK-3497 stays gated on adequate current qualification and paired workflow evidence.
