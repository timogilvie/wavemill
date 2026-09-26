# Decision Record Contract (draft v0.1)

Status: draft. Adopted first by Rework Risk (HOK-2820, HOK-3020, HOK-3022,
HOK-2818, HOK-3023). Other models adopt it when they are next touched, starting
with a mapping of Model Match's existing shapes.

## Why this exists

Every Hokusai model learns some version of P(outcome | state, action). Training,
evaluation and DeltaOne attribution all need the same thing from the data: an
honest record of **what was known when the decision was made**, kept apart from
**what happened afterwards**. This contract fixes that separation. It does
**not** define a universal feature set. State and action payloads stay
model-specific and versioned (e.g. `candidate_features/v1`).

## 1. Two kinds of rows, never mixed

| Row | Written when | Mutable? | Examples |
|---|---|---|---|
| **Decision record** | At decision/scoring time | Append-only | `arbiter_shadow_score/v1` |
| **Outcome label** | After the horizon elapses | Append-only; latest `computed_at` per key and horizon wins | S2 survival label v1.0.0, `arbiter_shadow_outcome/v1`, derived `corrective_rework` |

Outcome-shaped fields (actual cost, interventions, review rubric scores,
survival) never appear in a decision record, even as nulls. Rows are joined at
read time on the decision key.

## 2. Decision record fields

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | The model-specific row schema |
| decision key | yes | Natural key for the decision. Rework Risk: `(repo, merge_sha)`. Model Match: the route `correlationId`. |
| `decision_point` | yes (may be implied by schema) | `merge`, `route`, `tool_call`, … |
| `as_of` | yes | Information cutoff. Every payload feature must be computable from state at or before it. Rework Risk: the merge commit time (`merged_at`), with features computed from `merge_sha` and history up to it. |
| `recorded_at` | yes | When the row was written. It may be later than `as_of` (e.g. shadow scoring runs every 6h), but that must never change the features. |
| policy identity | yes | Which model or scorer produced the output (`scorer_id` + `scorer_version`). |
| output | yes | The score, plus threshold and flag where applicable. |
| `payload` | yes | Features under their own versioned schema. Unavailable evidence is `null`, never `0`. |
| `trace_id` | optional | Link to the HOK-2259 task trace when a harness produced the change. |
| **Choosers only:** `options`, `recommended`, `taken`, `decision_source`, `propensity` | yes for Match models | Without the option set and propensity, logged choices cannot support off-policy evaluation (see the second-model data plan §3). |

## 3. Outcome label fields

Follow the S2 survival-label contract (`survival-label-contract.md`). It is the
reference implementation:

- keyed by decision key (or `prUrl`) **and** `horizon_days`
- `labeller_version` and `normalization_version` pinned in every row
- `label_provenance` (`harvested` | `owner_corrected`)
- typed `reason_codes`, no free text; missing labels are `null` with exactly one missing-code
- **Derived targets** (e.g. `corrective_rework`, HOK-3020) are deterministic
  functions of base label rows plus named evidence. They are emitted as their
  own versioned rows and never edit the base label.

## 4. Rules

1. Decision records and outcome labels are separate append-only streams.
2. `as_of` is declared per feature source and audited (HOK-3023). Any feature
   that could be computed after `as_of` is rejected, not warned about (HOK-2818).
3. No raw content in either row type (diffs, messages, prompts, emails). This
   matches the existing SDK validators.
4. Features that only exist for instrumented agent PRs (the candidate-feature
   Provenance group) are segment features: `null` elsewhere, and reported
   separately in backtests.
5. A new model maps its existing schemas onto this contract before adding
   fields. If the mapping is awkward, revise the contract.

## 5. Current mapping

| Contract field | Rework Risk (today) | Model Match (today) |
|---|---|---|
| decision key | `(repo, merge_sha)` in `arbiter_shadow_score/v1` | `correlationId` (`OutcomeReport` only) |
| `as_of` | `merged_at` | **missing** |
| policy identity | `scorer_id`, `scorer_version` | **missing** |
| payload | `features` = `candidate_features/v1` | flat `TechnicalTaskRouterRequest.inputs`, which **mixes in outcome fields** |
| options / recommended / taken / propensity | n/a (predictor) | options in `technical_task_router_row/v2`; recommended vs. taken in `OutcomeReport`; **no propensity** |
| outcome label | S2 survival label v1.0.0 (+ `corrective_rework`, HOK-3020) | `completionStatus` snapshot, **no horizon or labeller version** |
| link to the change | `prUrl`; wavemill PRs carry `executed_route` in `wavemill-meta` (HOK-2945) | `executed_route` records what ran; **HOK-3098** adds `route_decision` (`decision_id`, `source`, `policy_version`, `recommended`) to `wavemill-meta` |

HOK-3098 is being done now rather than with the next Model Match change,
because the link can't be backfilled: every PR merged without it is a survival
label that can never be joined to its route decision. The other Model Match gaps
are listed here so the next Model Match change closes them.
