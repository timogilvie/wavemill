# Tool-choice signal analysis and decision gate (HOK-2080)

_Snapshot generated 2026-09-23 from the local mill checkout at
`/Users/timothyogilvie/Dropbox/wavemill/.wavemill/` (54 session-event
streams, 2,365 eval records). Re-run the pipeline to refresh this file as
post-HOK-3054 capture accumulates — see [Re-run](#re-run)._

## Method

The pipeline runs four staged, pure modules:

1. **Outcome join** (`shared/lib/native-agent/tool-choice-outcome-join.ts`) —
   parses the wavemill session-id (`…-coding-HOK-####`, optional `_c` challenger
   suffix) and joins to `EvalRecord.issueId`. Review-phase sessions (branch,
   not issue) are flagged rather than silently joined. Ambiguity is counted.
2. **Quality gate** (`tool-choice-quality-gate.ts`) — validates coverage,
   menu integrity, outcome-join rates, propensity provenance, and Tier-0
   result-status coverage against a documented threshold constant
   (`QUALITY_GATE_THRESHOLDS`). Estimators must inspect the gate; strata
   whose gate is false are refused, not silently reported.
3. **Signal statistics** (`tool-choice-signal-stats.ts`) — stratified
   contrasts with cluster (per-trace) bootstrap CIs, a Newton-Raphson
   logistic regression with model / phase / prior-error / tool-dummy
   controls, and a self-normalized IPS + DR module that **refuses to run**
   unless propensity provenance is `exact` (per the P1 schema contract).
   Every emitted estimate is tagged with its propensity basis; exact and
   surrogate results are never merged. Sensitivity: leave-one-model-out
   and leave-one-issue-out.
4. **Decision gate** (`tool-choice-decision-gate.ts`) — go / no-go /
   inconclusive with a documented rule set, a computed
   `minimumAdditionalCapture`, and the stated kill condition.

Estimands:

- **Local (Tier-0):** `P(result.status = success | chosenTool, controls)` per decision.
- **Trace:** terminal success / merged as a function of trace-level
  tool-mix features, controlled for model, phase, difficulty band,
  challenge side, budget state.

**Tier-0 stated assumption.** "Tier-0" is not repo-defined; we use the
labeler's `tool_status_local` reading — universal per-decision signals
available at every stage without extra capture: result status, error flag,
prior-error state, tool-menu digest identity, latency, cost. See
`shared/lib/native-agent/tool-decision-labeler.ts` for the pre-existing
usage of this term.

## Data-quality appendix (2026-09-23 snapshot)

| Check | Observed | Threshold | Pass |
|---|---:|---:|---|
| Total decisions | 2,650 | 100 | ✓ |
| Distinct traces | 5 | 20 | ✗ |
| Distinct sessions | 52 | — | — |
| Menu presence fraction | 0.033 | 0.80 | ✗ |
| Rows with terminal result (Tier-0 success signal) | 0 | — | ✗ |
| Rows with skipped result | 2,107 | — | — |
| Joined-outcome traces | 2 | 30 | ✗ |
| Exact-propensity rows | 0 | 1 | ✗ |
| Provider-reported propensity rows | 0 | — | — |
| Surrogate propensity rows | 87 | — | — |
| Unavailable propensity rows | 2,563 | — | — |
| **Observational gate pass** | — | — | **no** |
| **Off-policy gate pass** | — | — | **no** |

Per-phase decomposition: `{"planning": 158, "coding": 2492}` — coding
sessions dominate, as scoped, but nearly all coding rows come from
challenger `_c` arms (2,527 rows) and none carry a `tool_menu` snapshot
because the historical streams pre-date HOK-3054 (2026-09-22).

Outcome-join breakdown: 139 joined rows / 2,511 unjoinable (reason
`no_eval_record_for_issue` for every unjoinable row) / 0 pending. The
join yields **only 2 distinct traces** with a joined outcome — under the
30-per-cell floor.

Menu integrity: 87 of 2,650 rows carry a `tool_menu` snapshot (3.3%). All
menus that are present are digest-consistent within their turn.

Tool-result terminal coverage: **0 of 2,650 rows have `result.status`
= success or error.** 2,107 tool-call rows carry `result.status = skipped`;
the remaining 543 are `n/a` (respond / think / policy_denied). The
`tool_result` events are absent in the projected historical streams, so
the Tier-0 local success signal cannot be evaluated from this backfill.
This is orthogonal to the P1 capture contract; it reflects what pre-HOK-3054
sessions actually recorded.

Propensity provenance: **0 exact, 0 provider_reported, 87 surrogate,
2,563 unavailable.** Off-policy estimation is refused per the schema
contract (surrogate propensities may never participate in causal
off-policy estimators).

## Results (2026-09-23 snapshot)

- Traces joined to eval outcomes: **2**.
- Distinct models observed: **25** (mostly OpenRouter-served `moonshotai`,
  `qwen`, `google`, `mistralai`, `z-ai`; the rest are scripted fixture
  models from planning-canary streams).
- Distinct tools observed: **24**.

**Stratified contrasts.** The estimator emits nine non-gated
model × phase × menu-digest × prior-error cells. In every cell, the two
most-frequent tools (typically `read_file` vs `apply_patch`, `search_text`,
`run_tests`, `run_format`) yield an observed success-rate difference of
exactly zero, because every row carries `result.status = skipped` (see
above) — the local success signal is uniformly absent. The CIs from the
per-trace cluster bootstrap collapse to `[0.000, 0.000]`.

**Sensitivity sweeps.** 25 leave-one-model-out sweeps and 3
leave-one-issue-out sweeps ran. In every LOO run, the number of
significant contrasts is zero — consistent with the base run.

**Off-policy / propensity separation.** IPS refused; reason
`no_exact_propensity_rows`, basis `mixed`. The DR module is available and
tested but is gated identically. Surrogate results are reported in the
provenance histogram above and never merged with any (non-existent)
exact-basis result.

## Decision

**Decision: Inconclusive.**

Reasons (from the gate):

- Quality gate did not pass (see notes).
- `distinctTraces 5 < 20`.
- `menuPresenceFraction 0.03 < 0.80`.
- `exactPropensity 0 < 1` (off-policy refused).
- `joinedTraces 2 < 30`.

Computed minimum additional capture:

- Additional joined-outcome traces needed: **28** (to reach the 30-per-cell floor).
- Additional menu-bearing rows needed: **~2,033** at current corpus size (or a fresh capture where the fraction is met naturally after HOK-3054).
- Additional exact-propensity rows needed: **1** (unblocks the estimator; more is better).
- Also: capture `tool_result` events so the Tier-0 local success signal is observable — the current corpus has zero rows with a terminal result status.
- Also: enable provider logprob capture (or provider-reported top-tool probability) on a controlled coding-stage subset before any off-policy estimation.

**Kill condition.** If, after collecting the minimum additional capture
above, the pre-registered contrasts remain null OR propensity quality
still bars off-policy validation, HOK-2081 (Phase-3 gated Tier-2
replay/online tool-selection exploration) will not be built. The corpus
is retained for diagnostics only.

## Re-run

The decision is data, not prose. To recompute against a refreshed corpus:

```bash
npx tsx tools/tool-choice-analysis.ts --backfill --report docs/tool-choice-analysis-report.md
```

With explicit paths (e.g. running against the mill checkout in read mode
while writing the report to the worktree):

```bash
npx tsx tools/tool-choice-analysis.ts \
  --corpus /path/to/.wavemill/tool-decisions/corpus.jsonl \
  --evals  /path/to/.wavemill/evals/evals.jsonl \
  --session-events /path/to/.wavemill/session-events \
  --report docs/tool-choice-analysis-report.md
```

An operator override is available for out-of-band decisions but always
records the computed value alongside:

```bash
npx tsx tools/tool-choice-analysis.ts \
  --decision-override no-go \
  --decision-reason "operator judgment on 2026-09-23"
```

## Notes and caveats

- Rows are the P1 (HOK-2076) tool-decision corpus. This task never mutates
  P1 capture code; capture bugs are filed, not fixed here.
- The `exact` and `provider_reported` results are reported separately from
  surrogate/unavailable and are never merged.
- The estimator is deterministic with a seeded RNG; re-running with the
  same inputs reproduces the same numbers.
- Historical bias: nearly all coding rows come from challenger `_c` arms.
  Arm-restricted sensitivity is available but does not repair the
  quality-gate failures listed above.
- The `traceId` for many pre-HOK-3054 sessions falls back to a common
  prefix (five distinct trace ids for 52 sessions) — an artifact of the
  older event stream that further restricts effective sample size and is
  captured in the quality-gate report under `distinctTraces`.
- See `shared/lib/native-agent/tool-decision-schema.ts` for the row
  contract this analysis consumes.
