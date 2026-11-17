# Endpoint qualification

HOK-3496 extends the existing native certification contract. Production routing remains unchanged. `getOpenRouterRouting` still supplies the production pin; qualification supplies an explicit catalog endpoint through the same model builder, with automatic fallback disabled. HOK-3497 owns production selection.

A certification subject may include an endpoint tag, catalog host name, catalog quantization and deployment revision. Unknown values stay null. Endpoint storage adds a material-identity suffix to the existing suite filename, so two hosts or deployment variants cannot overwrite each other's evidence. The subject's catalog hash also binds installed Pi versions, transport, compatibility flags, the NativePatch contract, certification suite, and the prospective qualification contract (oracle, protocol, tool version, limits and attempts). Price changes alone do not invalidate compatibility. Legacy model-only artifacts remain readable and retain their existing paths and gate behavior.

The store's JSON schema is now the sole artifact parser; the loader's lossy hand-written parser is deleted. All endpoint phases require a fresh live host observation, in addition to the existing suite/phase/TTL/scenario gates. A requested tag with matching generation host evidence establishes the requested tag and observed host; it does **not** independently attest a quantization, region or deployment revision. Missing host metadata is inconclusive; contradictory host/model evidence refuses qualification. Injected loop/model/generation clients cannot produce live eligibility.

Use `tools/native-agent-certify.ts --provider openrouter --model kimi-k3 --endpoint <exact-tag> --phase workflow --live-coding-canary --certification-root <isolated-store>` to target one discovered subject. Endpoint cohort members may also be configured with `endpoint` using the same shape as the certification subject. Existing cohort locks, attempt guards, freshness and invalidation controls are reused; endpoint identities have separate keys. No new scheduler or TTL is added.

The shared canary records launch ownership and a transcript, meters each attempt through `@hokusai/costs`, and retains redacted canonical contribution evidence before removing its disposable repository. Endpoint rates reach both the live-budget and SDK estimate adapters. Generation lookups use the same resolved credential as the model client without changing process-global environment. Failed retries remain in the evidence; a definitive failure is not hidden by a later pass in the same comparison.

The `workflow` and `cache-heavy` profiles add escaped multi-file edits and real focused-test execution. Both use the same tool menu, model and controls. The cache profile supplies a fixed read-only context block; the report retains actual cache counters instead of assuming cache hits. A labeled reconstruction exercises corrupted nested patch arguments and exact escaping through the production mutation tool. Default model-only certification scenarios are unchanged; additions are scoped to endpoint subjects.

## Bounded comparison

Run `node tools/native-agent-qualify-endpoints.ts --help`. Without `--live`, the command only captures a catalog and writes a plan. Explicit reference/candidate tags must exist in that model's captured catalog; no provider list is hardcoded into routing policy. Existing output history is never overwritten.

Before candidate testing, characterize only the reference with three repetitions of each fixed profile:

```bash
node tools/native-agent-qualify-endpoints.ts --model kimi-k2.7-code --reference moonshotai --characterize --limits <declared-limits.json> --max-cost-usd <characterization-cap> --output <new-reference-report.json> --live
node tools/native-agent-qualify-endpoints.ts --model kimi-k2.7-code --reference moonshotai --candidates streamlake --characterization <new-reference-report.json> --max-cost-usd <comparison-cap> --output <new-comparison-report.json> --live
```

Limits must be chosen before characterization; omitting `--limits` retains the existing six-turn compatibility budget. The first reference non-pass stops the study. Nine live passes with matching runtime, oracle, budgets, host evidence and complete attempt accounting are required before candidate requests. Comparison limits come from that report, and its evidence hash is preregistered. Old plans remain available for offline accounting replay and cannot execute as prospective live plans.

Before any paid request, the command writes the model subject, catalog snapshot, reliability margin, confidence, latency ratio, fixed run order and spend reservation. Every outer canary attempt reserves the declared contract's cost limit; its outer-attempt limit is included. Plan v3 expands its declared full order lazily and admits the next run only when the SDK-accounted spend plus its full reserve fits the cap. Missing accounting stops further probes. The shared qualification outcome interpretation skips hard-disqualified candidates. Functional/protocol corruption disqualifies; resource/availability outcomes count against completion. No remaining viable candidate ends the study. These are experiment admission rules, not a second task-wide retry or spend mechanism.

Sample size is derived by inverting the existing Wilson interval. A pair is a complete bundle of both workflow profiles, and counts as a loss if the reference passes while the candidate fails either profile. Reverse discordance never cancels a loss. At a five-point regression margin and 95% confidence, even zero observed losses require 73 complete paired repetitions. A pilot that stops before this sample cannot establish the declared promotion bar. The intervals cover this fixed fixture/workload distribution, not arbitrary production tasks.

Any non-passing reference probe stops the study. Missing host attestation or charge coverage prevents promotion. Each run is appended before feedback export. Canonical contributions use `wavemill-certification` as their harness and the normal config/consent/idempotency queue; the exporter never overrides an opt-out. Reports record disabled or failed export states explicitly.

Generation metadata GETs use the shared bounded network retry because completed responses may briefly return 404. Operator studies retain their ownership/transcript evidence under `<output>.private-evidence`; keep this private. Disposable source repositories are still removed. The redacted report and contribution never export raw response identifiers. Endpoint contract v2 orders source edits and focused tests before completion and retains rejected mutation counts even when a run stops on budget.

Accounting replay uses `--replay <original.plan.json> --output <new-report.json>`. It reads adjacent original catalog/run evidence, replays observations through the existing SDK with captured endpoint rates, and preserves original outcomes/history. No model calls occur. See the captured pilot and limitations in [experiments/hok3496/README.md](experiments/hok3496/README.md).

## Prospective functional verification (HOK-3502)

Endpoint contracts use one generated test oracle, both during model work and after the final edit. Final verification uses the production command tool substrate. Oracle tampering, out-of-scope changes, invalid completion and rejected structured mutation calls fail. Source edits after a passing model test are tested again. Formatting differences are separate diagnostics; exact NativePatch byte-fidelity checks remain unchanged. Legacy model-only canaries keep their literal contract, and saved historical results are never converted into functional passes.

Explicit cohort contracts flow through the canonical launch gate, the same subject resolver and the certification refresh pipeline. A certificate for another budget or protocol cannot satisfy that request. End-to-end time derives from timestamp facts over all attempts, including final verification and accounting; native time-split categories remain distinct and unknown overhead stays unknown. Session-end boundaries prevent accounting time from becoming provider wait.

The old whole-file byte veto for functional endpoints, payload-substring heuristic, historical-test-pass shortcut and copied any-fail comparison policies are removed. See the preregistered [HOK-3502 study](experiments/hok3502/README.md), including its reference-health stop and evidence limitations.

## Owners and deletions

| Question | Existing owner extended |
| -- | -- |
| Which endpoint/runtime contract was tested? | certification identity, schema and storage |
| May this phase launch? | existing certification loader/gate and live-canary eligibility |
| What restriction is sent? | `endpointRouting` → `buildOpenRouterModel` |
| What did every attempt cost? | session ownership → SDK meter; retained-fact replay uses the same SDK bridge |
| How are failures/retries classified? | existing provider classifier, arm fault taxonomy and canary retry bounds |
| How fresh is evidence, and when is it retried? | existing certification TTL and cohort refresh/attempt guards |
| How much uncertainty remains? | existing `stats-utils` Wilson interval |
| Which facts reach Hokusai? | canonical SDK contribution builder and existing consent-gated queue |

Deleted: the loader's private artifact/subject/canary/usage/scenario parsers, duplicated endpoint-rate projection in the CLI, and the obsolete loader deadline allowlist entry. The provider-identity source guard checks endpoint propagation through the shared gate and request restriction.
