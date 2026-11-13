# HOK-3478 — source × requirement matrix

Evidence categories describe the requirement, not the mere presence of a similarly named field. **Recorded** means a field exists in this source; **inferred** means a proxy supplied the claim; **missing** means the required field was not found; **unobservable** means the retained record cannot decide it. A source's model string is recorded metadata, not proof of the executed provider model.

`manifest.json.samples` joins each local sample name to its exact pinned source URL, line index, trace ID and record SHA-256. `assessments.json.rows` retains the extracted facts and judgments without copying conversation text.

| Requirement | Devtime (1 trace) | Runtime (7 traces) | Lambda/Hermes (42 traces) |
|---|---|---|---|
| Human messages / unplanned intervention | **Recorded** user-role steps; human authorship and rescue role **unobservable** (`/steps/*/role`) | **Recorded** prompt-bank user steps; rescue distinction **unobservable** | **Recorded** user-role messages; actual human origin and prior episode **unobservable** |
| Planned handoff versus rescue | **Unobservable**: initial position does not establish history (`/steps`, `/task`) | **Unobservable**: source completion is not an intervention annotation | **Unobservable**: references to earlier work do not establish the task boundary |
| Terminal outcome | **Inferred/derived** success/commit evidence (`/outcome/signal_confidence`, `/outcome/committed`) | **Inferred** source completion and `goal_reached` (`/metadata/source_completion_status`, `/outcome`) | Mostly **missing** usable terminal success; derived source fields do not establish autonomy |
| Failed / abandoned task coverage | **Missing** explicit rescue/abandonment annotations in sampled record | **Missing** negative examples in this sample; `high_quality_kept` indicates upstream selection (`/metadata/source_subset`) | **Missing** determinate failure labels; null outcomes are not failures |
| Full chronological task prefixes | **Unobservable** across workflow attempts (`/session_id`, `/steps`) | **Unobservable**: conversation-turn fidelity and source slicing | **Unobservable**: source conversation turns are not a complete task/attempt lifecycle |
| Retry-decision context and policy | **Missing** an explicit decision/policy linkage; textual retry mentions do not substitute | **Missing** (`/metadata`, `/steps`) | **Missing**; tool diversity does not identify the retry policy |
| Executed model | `/agent/model` **recorded**; provider identity **unobservable** | Same | Same |
| Stable task / attempt identity | `/trace_id` and `/session_id` **recorded**; continuity across retries **unobservable** | Same; upstream subset and row index also recorded | Same; source corpus and row index also recorded |
| Attributable cost | One `/metrics/estimated_cost_usd` value **recorded** as an estimate; attempt join **missing** | Cost **missing** in all sampled rows | Cost **missing** in all sampled rows; zero token fields do not prove free execution |

## Evidence anchors

- Devtime example: `033-OpenTraces__opentraces-devtime-85e7bc3d-40e5-4648-8632-5ea84d725092.jsonl`; inspect `/outcome`, `/environment/vcs`, `/agent/model`, `/metrics`.
- Runtime example: `004-OpenTraces__opentraces-runtime-aedca9e0-c568-4b08-9555-d334e3f2ed7a.jsonl`; inspect `/metadata/source_subset`, `/metadata/step_fidelity`, `/metadata/source_completion_status`, `/outcome`.
- Lambda/Hermes example: `001-OpenTraces__lambda-hermes-agent-reasoning-opentraces-79688c75-0701-460d-9575-b299c6bc689f.jsonl`; inspect `/metadata/source_dataset`, `/metadata/step_fidelity`, `/task`, `/outcome`.

These names identify cached public records, not files redistributed with the PR. `fetch.py --reproduce` reconstructs them under `.cache/samples/`. Every row remains **unknown** for the target label because none supplies the complete rescue/autonomy evidence required by the Stall Risk definition. Counts: positive 0, negative 0, unknown 50.

<!-- audit-status: operator-verified-complete -->
