# Tool-choice signal analysis (HOK-2080)

Generated from `/Users/timothyogilvie/Dropbox/wavemill/worktrees/p2-tool-choice-signal-analysis-and-decision-gate-challenger/.wavemill/tool-decisions/corpus.jsonl` on 2026-09-23T23:04:26.876Z. Eval outcomes joined from `/Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/evals.jsonl`.

## Executive Summary

- Corpus: `/Users/timothyogilvie/Dropbox/wavemill/worktrees/p2-tool-choice-signal-analysis-and-decision-gate-challenger/.wavemill/tool-decisions/corpus.jsonl` (corpus file absent — no tool decisions have been captured)
- Schema adherence: n/a (0/0 lines valid against schema v1)
- Outcome join rate: n/a (0/0 candidates joined)
- Coding-stage tool-call cohort: 0 row(s), 0 joined, across 0 model(s) and 0 session(s)
- Propensity provenance mix: none
- Computed recommendation: Inconclusive
- Operator decision: Inconclusive
- Coverage gates: G1 fail, G2 fail, G3 fail, G4 fail

## Methodology

- Outcome: binary success per decision — the joined eval record's explicit `outcomes.success` when present, otherwise `score >= 0.8` (mirrors shared/lib/eval-success-policy.ts; threshold pre-registered in `TOOL_CHOICE_GATES`).
- Cohort: schema-valid rows with phase=coding and kind in {tool_call, forced_tool_call} that joined an eval outcome, deduplicated by decisionId.
- Confounder control: covariate-adjusted logistic regression per propensity-provenance tier, with standardized state features (turn/step index, prior tool calls, prior errors, prior policy denials, terminal-synthesis flag, menu size, budget fields where present) plus tool, model, policy-exposed menu-digest, runtime (when varied), and eval-joined task-class (when coverage reaches 50%) one-hots. Coverage of every declared confounder is itself reported in the Data Quality Appendix.
- Propensity tiering (REQ-F3): every estimate is reported under its provenance tier. Inverse-probability weighting (IPW) and the doubly-robust (AIPW) contrast against the always-modal-tool baseline run only on exact-provenance rows with a filled distribution, per the tool-decision schema causal-use contract.
- Uncertainty: Wilson intervals for stratified contrasts; seeded cluster bootstrap over sessions for adjusted coefficients; time-ordered 70/30 holdout; leave-one-model-out sensitivity.

Pre-registered coverage gates (all must pass before any estimate is reported):

- G1: at least 500 schema-valid coding-stage rows of kind tool_call/forced_tool_call.
- G2: at least 60% of the G1 cohort joined to an eval outcome; joined rows span at least 3 models and 20 distinct sessions.
- G3: toolMenu.digest on at least 90% of joined rows, and availableTools mirrors toolMenu.toolNames on at least 99% of rows that have both.
- G4: a provenance tier is reported only with at least 200 joined rows; the off-policy (IPW/AIPW) tier additionally requires provenance='exact' rows with a filled distribution.

Pre-registered signal criteria (Go requires all four):

- S1: at least one pre-specified stratum (model × phase=coding × menu-digest) shows a tool-choice effect whose 95% CI excludes zero after covariate adjustment (state features + budget where present + task class where joined).
- S2: the effect reproduces in a time-ordered 70/30 holdout (same direction, CI excluding zero in the holdout at 90%).
- S3: the effect survives leave-one-model-out sensitivity (direction stable).
- S4: surrogate-only evidence never justifies Go — the exact-provenance tier must pass S1–S2. Surrogate/observational agreement upgrades confidence but does not substitute.

Decision mapping: gates pass + S1–S4 pass → **Go**; gates pass + no identifiable effect → **No-go**; coverage/propensity gates fail → **Inconclusive** with a quantified minimum-capture specification. Kill condition: if the gates later pass and no effect satisfies S1–S4, the decision becomes No-go and HOK-2081 (production tool router) must not proceed.

Observed gate evaluation:

| Gate | Requirement | Observed | Result | Shortfall |
| --- | --- | --- | --- | --- |
| G1 | >= 500 schema-valid coding-stage rows of kind tool_call/forced_tool_call | 0 rows | fail | 500 more coding-stage tool-call rows |
| G2 | >= 60% of the G1 cohort joined to an eval outcome; >= 3 models and >= 20 distinct sessions among joined rows | n/a joined; 0 models; 0 sessions | fail | join rate n/a < 60%; 3 more distinct models among joined rows; 20 more distinct sessions among joined rows |
| G3 | toolMenu.digest on >= 90% of joined rows; availableTools mirrors toolMenu.toolNames on >= 99% of rows having both | digest n/a; mirror n/a | fail | menu digest coverage n/a < 90%; mirror consistency n/a < 99% |
| G4 | each reported provenance tier needs >= 200 joined rows; the off-policy (IPW/AIPW) tier additionally requires provenance='exact' rows with a filled distribution | exact=0, provider_reported=0, surrogate=0, unavailable=0; exact rows with filled distribution: 0 | fail | no provenance tier reaches 200 joined rows (largest: 0) |

## Data Quality Appendix

### Corpus integrity

| Metric | Value |
| --- | --- |
| Corpus path | /Users/timothyogilvie/Dropbox/wavemill/worktrees/p2-tool-choice-signal-analysis-and-decision-gate-challenger/.wavemill/tool-decisions/corpus.jsonl |
| Corpus file present | no |
| Non-blank lines | 0 |
| Schema-valid rows | 0 |
| Schema-invalid but joinable rows (lenient) | 0 |
| Malformed lines | 0 |
| Duplicate decisionIds | 0 (rate n/a) |
| Schema adherence | n/a |
| Rows with a projector-filled outcome field | 0 |
| Policy-denied rows | n/a |

### Confounder coverage (over schema-valid rows)

| Confounder | Coverage |
| --- | --- |
| model | n/a (0/0) |
| provider | n/a (0/0) |
| phase | n/a (0/0) |
| runtime | n/a (0/0) |
| menu_digest | n/a (0/0) |
| available_tools_mirror | n/a (0/0) |
| provider_menu | n/a (0/0) |
| turn_budget_remaining | n/a (0/0) |
| tool_call_budget_remaining | n/a (0/0) |
| outcome_field | n/a (0/0) |
| timestamp_parseable | n/a (0/0) |
| task_class_via_eval_join | n/a (0/0) |

### Propensity provenance histogram

_No schema-valid rows, so no provenance distribution to report._

### Menu integrity

| Metric | Value |
| --- | --- |
| Rows with a toolMenu snapshot | 0 |
| Rows with both toolMenu.toolNames and availableTools | 0 |
| Mirror-consistent rows | 0 |
| Mirror consistency | n/a |
| Menu digest coverage (joined coding rows) | n/a |

### Outcome join diagnostics

| Metric | Value |
| --- | --- |
| Join candidates (valid + lenient rows) | 0 |
| Joined | 0 (n/a) |
| Unjoinable by construction (review/branch-keyed sessions) | 0 |
| — of which review sessions | 0 |
| — of which unrecognized session ids | 0 |
| Unjoinable: no matching eval record | 0 |
| Unjoinable: ambiguous eval records | 0 |
| Joined without a model match | 0 |

### Coding-stage analysis cohort

| Metric | Value |
| --- | --- |
| Coding tool_call/forced_tool_call rows | 0 |
| Joined rows | 0 (n/a) |
| Distinct models among joined rows | — |
| Distinct sessions among joined rows | 0 |
| Success rate (joined rows) | n/a |
| Menu digest coverage | n/a |
| Mirror consistency | n/a |
| Rows with unparseable timestamps | 0 |
| Exact-provenance rows with a filled distribution | 0 |
| Joined rows — exact provenance | 0 |
| Joined rows — provider_reported provenance | 0 |
| Joined rows — surrogate provenance | 0 |
| Joined rows — unavailable provenance | 0 |

### Eval outcome index

| Metric | Value |
| --- | --- |
| Evals path | /Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/evals.jsonl |
| Evals file present | yes |
| Eval records indexed | 558 |
| Malformed eval lines | 0 |
| Eval rows without issueId | 1811 |
| Literal `_c` issueId suffix normalizations | 14 |

### Operator context notes

- HOK-2076 capture pipeline merged 2026-09-23 (71543dc4); no session has been projected into the corpus yet — the newest session-event stream predates that merge.
- Stream audit (planning research, HOK-2080): 53 existing session-event streams contain 0 tool_menu / provider_tools events — menu emission landed with HOK-3054 (cd90c8bd, 2026-09-22) after those streams were written — so backfilling them would produce only propensity provenance unavailable rows with missingLogicalMenu, failing G3/G4 by construction.
- Propensity provenance today is never exact: tool-decision-projector derivePropensity emits only surrogate (menu present) or unavailable; distribution is never filled, so the IPW/AIPW causal tier is empty until a provider returns per-tool probability distributions.
- The projector never fills outcome, budget, or latency fields; the analysis joins outcomes from evals.jsonl by session-id parsing instead.

## Results

The pre-registered coverage gates failed, so no signal estimates were produced. Pre-registered coverage gates failed (G1, G2, G3, G4) — estimation suppressed to avoid manufacturing a signal.

Per-stratum observational contrasts, the covariate-adjusted regression, the off-policy estimators, and all sensitivity checks are suppressed on this run. This is not a positive signal: it is an explicit statement that the corpus cannot currently support the gated analysis. The minimum additional capture needed to re-run is quantified in the “Minimum additional capture” section.

## Uncertainty & Sensitivity

_Suppressed with the signal analysis (coverage gates failed)._

## Minimum additional capture

The pre-registered coverage gates failed, so no signal estimate was produced. This is not a positive signal. To re-run the gated analysis, capture at least:

- >= 500 schema-valid coding-stage tool_call/forced_tool_call decision rows (have 0; need 500 more)
- >= 60% of those rows joined to an eval outcome (have 0 joined; need 300 more)
- >= 3 distinct models among joined rows (have 0; need 3 more)
- >= 20 distinct sessions among joined rows (have 0; need 20 more)
- toolMenu.digest on >= 90% of joined rows (currently n/a; shortfall n/a)
- availableTools mirroring toolMenu.toolNames on >= 99% of rows having both (currently n/a; shortfall n/a)
- >= 200 joined rows with propensity.provenance='exact' and a filled distribution for the causal tier (have 0; need 200 more)

## Decision

Decision: Inconclusive

Coverage gate G1 failed: the HOK-2076 tool-decision corpus contains 0 coding-stage tool-call rows (the corpus file has never been written — the capture pipeline has only been live since 2026-09-23 and no post-capture session has been projected yet). This is not a positive or a negative signal. Backfilling the 53 pre-HOK-3054 session-event streams is disqualified: they contain no tool_menu/provider_tools events, so every backfilled row would carry propensity provenance unavailable with a missing logical menu, failing gates G3 and G4 by construction. The pre-registered minimum-capture specification (>=500 joined coding rows across >=3 models and >=20 sessions, >=90% menu-digest coverage, and >=200 exact-provenance rows with filled distributions for the causal tier) is quantified in the Data Quality Appendix. Kill condition: if the gates later pass and no effect satisfies S1-S4, the decision becomes No-go and HOK-2081 must not proceed.
