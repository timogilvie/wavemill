# HOK-3478 — OpenTraces suitability for Stall Risk

**Verdict: feature/parser research only. Do not use the inspected data as a labeled training supplement.**

The verified sample contains **0 determinate rescue positives, 0 determinate autonomous-completion negatives, and 50 unknowns**. These counts describe label *observability*, not a measured failure or rescue rate. A committed change, a successful source outcome, or a user-role message cannot establish whether the agreed task finished without unplanned human rescue.

This closes the bounded source-fit assessment. Wavemill's chronological task-group held-out data remains the test of value against bounded retry. **The Dec 2 unrun→Dismiss gate is unchanged.** Any experiment or follow-up collection requires a separate scope; this audit authorizes none.

## Evidence and source inventory

The original sample was collected on 2026-11-12. On 2026-11-13 the operator independently downloaded all ten pinned shards, checked their SHA-256 hashes, repeated the deterministic selection over **9,380 records**, and verified all 50 selected record hashes. The current public catalogue still returns the same three collections and revision SHAs. `inventory.json` records the current endpoint URLs, timestamps, content hashes and repository-license blob identity. `manifest.json` is the frozen sample authority; catalogue checks never advance its pins.

| Public collection | Pinned revision | Source records / shards | Inspected |
|---|---|---:|---:|
| [OpenTraces/opentraces-devtime](https://huggingface.co/datasets/OpenTraces/opentraces-devtime) | `22b0d09856d7f59d3de034682e8f5daac5780db8` | 96 / 4 | 1 |
| [OpenTraces/opentraces-runtime](https://huggingface.co/datasets/OpenTraces/opentraces-runtime) | `778faed3c7d7a36089324f4f3f5bab66bf77f2ad` | 1,639 / 4 | 7 |
| [OpenTraces/lambda-hermes-agent-reasoning-opentraces](https://huggingface.co/datasets/OpenTraces/lambda-hermes-agent-reasoning-opentraces) | `617a8e0c6942b392c017e5d7f4e05af83ec6b515` | 7,645 / 2 | 42 |

These are counts of parsed records in these pinned files, not the size of the whole OpenTraces catalogue, a count of independent tasks, or a count of coding tasks. The public catalogue request cannot reveal inaccessible private collections. All three visible datasets were public and ungated in the checked metadata.

Each dataset card declares **CC-BY-4.0**. The separate [software LICENSE](https://github.com/JayFarei/opentraces/blob/main/LICENSE), fetched through GitHub's license API, declares MIT and separately describes the default contributed-data license. GitHub's `NOASSERTION` metadata is not the license text; the earlier draft's description of it as a non-SPDX license was insufficient. The software repository was not archived at verification. No capture software was installed or run. The deliverable attributes the datasets and retains links and hashes; raw conversations and source shards stay in ignored local caches and are reconstructed from their public sources rather than redistributed in this PR.

All 50 sampled records declare **schema version 0.2.0**. The current [schema reference](https://www.opentraces.ai/schema/latest) and [outcome documentation](https://www.opentraces.ai/docs/schema/outcome-attribution) describe a broader, evolving contract. Their current examples or optional fields do not establish that an older trace recorded them. Outcome fields can be derived from commits or source completion metadata; the documentation does not turn those signals into rescue annotations. The checked page hashes are in `inventory.json`.

## Sampling frame, selection and limitations

All JSONL shards at the three pinned revisions enter the record frame. The original seed, `hok-3478-opentraces-audit-2025-01-09`, is preserved exactly for reproducibility; its embedded date is a seed string, not the audit date. Selection takes the 50 smallest `SHA256(seed + trace_id)` values. This is hash ranking, not a modulo filter. `fetch.py --reproduce` verifies both the full source-file hashes and the exact selected source/path/line/trace-id set.

This is an **unstratified, mixed-agent sample**, heavily dominated by Lambda/Hermes. It is not 50 verified coding tasks, and is not a balanced estimate across coding harnesses. Devtime supplies one code-editing session. Runtime contains coding-oriented prompt-bank tasks, and Lambda/Hermes includes both coding and general agent-tool exercises. The dataset's `task.type` field is absent in all sampled rows. This audit does not infer a coding-only population or generalize a zero observable-label count to all OpenTraces data. The narrow conclusion is that the inspected records do not supply usable Stall Risk labels.

The runtime sample identifies its upstream source subset as `high_quality_kept`, a direct selection-bias warning. Lambda/Hermes identifies an upstream `train` split with conversation-turn fidelity. These histories do not establish the rate of excluded failed or abandoned work. The snapshot is therefore unsuitable for estimating Wavemill's rescue or failure prevalence.

## Label mapping and counts

| Label | Operational rule | Count |
|---|---|---:|
| Positive | Explicit evidence that a human intervened unexpectedly to rescue the agreed task | 0 |
| Negative | A completed agreed endpoint, with coverage sufficient to establish absence of unplanned rescue | 0 |
| Unknown | Incomplete coverage, source-derived outcome, ambiguous actor or handoff, or insufficient task continuity | 50 |

`assessments.json` contains one independently checked record-level assessment per manifest row, with exact source record hashes and field pointers. `requirement-matrix.md` maps the task's requirements to observed and missing evidence.

Observed fields in this sample:

- `outcome.signal_confidence`: 43 derived, 7 inferred.
- `outcome.success`: 41 null, 9 true; no explicit false value in the sample.
- `outcome.terminal_state`: 43 null, 7 `goal_reached` values.
- `metrics.estimated_cost_usd`: 49 null, 1 populated estimate. No sampled record establishes an attempt-level billed cost joined to retry decisions.
- `agent.model`: 42 `moonshotai/kimi-k2.5`, 7 `z-ai/glm-5`, 1 `claude-opus-4-6`. These are source assertions, not independently verified provider-response identities.

User-role messages are recorded, but their existence does not prove a real human authored them, distinguish an initial prompt from rescue, or establish the full prior episode. Some initial prompts refer to earlier work; their location at the start of a trace is not evidence that no earlier intervention occurred. No determinate positive or negative can be assigned under the target definition. Missing telemetry stays unknown; it is not converted to zero cost, no retries, or autonomous success.

## Duplication and leakage

The sample has 50 distinct `(collection, session_id)` keys and no exact duplicate canonicalized `(task, steps)` payloads. This does not exclude semantic duplicates or shared upstream trajectories. The provenance fields in `assessments.json` expose the upstream datasets, subsets and row indices so later research can group them rather than pretending each row is independent.

A full-text case-insensitive scan of the sampled records found no Wavemill/Hokusai name hints. Exact 40-character hex values were compared with all **5,276 commits** visible to `git rev-list --all` in the local Wavemill checkout; no matches were found. This is a limited negative check: it does not prove absence of paraphrased tasks, inaccessible branches, or leakage from the complete Hokusai SDK history. `manifest.json.verification` records the comparison and limitations.

## Decision, mapping uncertainty and SDK scope

**External label import: reject for this sample.** There are no determinate positive/negative labels to map. Source success, commit, reward or terminal-state proxies must never be mapped directly onto Wavemill's autonomy label. Even future determinate labels would need task-boundary alignment, a known source selection policy, and separation from the chronological Wavemill evaluation set.

**Feature/parser research only:** tool-call shape, role transitions and outcome-confidence fields can be inspected as ideas for features measured on Wavemill's own fully observed attempts. This is a possible separately scoped activity, not an implemented integration or a demonstrated economic improvement.

**No demonstrated SDK adaptation gap:** the inspected external-data problem is missing outcome semantics and task continuity. No OpenTraces-to-Hokusai adapter was implemented, and no absent SDK API was demonstrated as a prerequisite. Therefore this audit does not file an SDK capability task. The Wavemill run's separate failure-feedback transport limitation is operational incident evidence, not evidence that this external dataset requires a new adapter.

## Reproduction and verification

From the repository root, using Python 3.9+ and the standard library:

```bash
# Public downloads only; verifies all 10 shard hashes, frame size and top-50 selection.
python3 research/stall-risk/opentraces/fetch.py --reproduce
# Offline verification of all cached records against manifest and extracted assessments.
python3 research/stall-risk/opentraces/fetch.py --verify-local
```

Fresh reproduction downloads about 860 MB across the ten shards; subsequent runs use a hash-addressed local cache. It never changes the source revisions or rewrites the frozen manifest. A changed, incomplete or corrupted shard fails verification. No authentication or capture SDK is needed. Cached raw records are not trusted as evidence unless their hashes match. Public source availability is an external dependency.

Verification completed on 2026-11-13: ten source-file hashes matched, 9,380 records scanned, selected set matched, 50 record hashes and extracted fields matched, and the label tally was 0/0/50. No production tests are claimed for this research-only change.

## Execution, time and stop rules

The initial Kimi coding attempt ran from **2026-11-12 21:02:56 UTC to 21:33:54 UTC (30m58s)**, then failed on accumulated context. It did not complete autonomously. Its earlier draft's assertion of a completed two-hour audit was removed. The user explicitly requested operator completion on 2026-11-13; that intervention is recorded separately from the failed attempt, with model identity, provider charges and Hokusai submission evidence retained locally. Operator verification and completion took approximately 35 minutes, including source reproduction and correction of the draft. Active audit work remained within the two-hour cap; overnight waiting is not counted as research time. This is an approximate operator duration, not a fabricated instrumented stage measure.

The sample was stopped at 50 and label fit is decisive. No training, product integration, policy change, new budget commitment, paid data collection, capture installation, or Wavemill trace upload occurred. The Dec 2 unrun→Dismiss rule remains in force. No next experiment is started by this report.

<!-- audit-status: operator-verified-complete -->
