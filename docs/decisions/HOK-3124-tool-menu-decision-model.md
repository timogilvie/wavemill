# Tool-Menu Decision Model, and Making S4 Reachable (HOK-3124)

**Decision:** Proceed. Reframe the wavemill-owned decision from per-step
`chosenTool` (I-16 / HOK-2080, closed Inconclusive 2026-09-29) to a
per-session **menu / advanced-policy assignment**, and make the exact-
provenance tier reachable by design — randomize a small, bounded share of
challenger (`_c`) arms across a pre-registered set of menu variants and log
the assignment probability on the initial `tool_menu` event. Pre-register
new gates G1'–G4' and signal criteria S1'–S4' in this memo before any of the
new data is examined. Follow-up build issues are scoped and named but not
filed inside this workflow; the portfolio swap is named below.

This memo is written before any exploration-eligible data exists in the
corpus (`docs/tool-choice-analysis-report.md` confirms corpus absent, all
gates fail with zero rows as of 2026-09-23). Its commit time is therefore
the pre-registration timestamp.

## Context

I-16 / HOK-2080 pre-registered a per-step decision: for `(model, phase=coding,
toolMenu.digest)`, does the model's `chosenTool` at a given step move
session success? That analysis has now closed **Inconclusive** — not
because the signal is weak, but because two structural things about the
setup make Go unreachable under the pre-registered rules:

1. **Wavemill does not choose the step.** The native runtime's loop hands
   the model a menu; the model picks the tool. `chosenTool` sits inside a
   decision boundary wavemill does not own, so crediting an individual
   step for a session-level outcome is a weak causal claim even when the
   outcome data is clean.
2. **The pre-registered Go rule is not attainable observationally.** Rule
   S4 (`shared/lib/native-agent/tool-choice-analyzer.ts:2438`, enforced via
   the off-policy machinery at `tool-choice-analyzer.ts:1761`) requires
   the winning effect to sit on `provenance='exact'` rows with a filled
   distribution. The projector's `derivePropensity`
   (`shared/lib/native-agent/tool-decision-projector.ts:500`) can only emit
   `surrogate` or `unavailable` because neither OpenRouter nor Anthropic
   returns per-tool distributions; the exact-provenance tier is empty by
   construction. So the pre-registered decision cannot return Go — the
   wiring, not the evidence, forces No-go or Inconclusive.

Since I-16 was drafted, two Epic-10 pieces have landed that change what
wavemill can reasonably decide:

- **HOK-3053 (Epic 10.1)** — an advanced-tool catalog with a default-off
  policy sits behind `nativeAgent.advanced.*` in
  `wavemill-config.schema.json` (see the `advanced` block around line 1693
  of the schema, and the executor at `shared/lib/native-agent/tools/exposure.ts`).
- **HOK-3054 (Epic 10.2)** — per-turn tool exposure is live via the menu
  resolver at `shared/lib/native-agent/tools/menu-resolver.ts` and the
  `ToolMenuEvent` at `shared/lib/native-agent/session-stream.schema.ts:307`.

The lever wavemill controls is not "which tool does the model pick at step
`k`" but "which tools does the model see at all, and under what advanced-
policy configuration, for the whole session." That is the decision this
memo reframes to.

## Reframe: the target decision

**Old target (I-16 / HOK-2080).** `chosenTool` per turn given `(model,
phase=coding, toolMenu.digest)`, with session-level `success` joined back
to each row. Inconclusive on 2026-09-29, blocked structurally on S4.

**New target.** *Given task features and model, which policy-eligible
tool menu (or per-turn exposure policy) should the session be given?*

- The outcome stays session-level `success` per `shared/lib/eval-success-policy.ts`
  (`outcomes.success` when present; otherwise `score >= 0.8`). No change
  to the outcome definition.
- The treatment is a **menu / policy variant**, drawn from a finite,
  pre-registered set of `nativeAgent.advanced.*` configurations — for
  example, `{code_search: off}` (baseline / current default) vs
  `{code_search: on}` vs `{code_search: on, semantic_index: on}` once
  HOK-3059 substrates are available. Required (`core` family) tools are
  never removed; only advanced-family exposure toggles. Each variant has a
  stable name and a canonical `tool_menu.digest`.
- The decision unit is a session, not a step. Session-level randomization
  matches the session-level outcome and cleanly consumes the same tier
  of off-policy code the analyzer already implements.

Per-step observational data continues to flow into the projector — the
per-step rows are still useful as a **secondary read** (e.g., which tools
the model actually reached for under each variant), but they no longer
carry the decision. The per-step analysis (HOK-2080 gates G1–G4, signals
S1–S4) remains in place and continues to run, purely as secondary
descriptive analysis; the primary decision rides on the menu-level
gates G1'–G4' below.

## Reachability of S4 (exact propensity by design)

S4 requires exact propensity. Observational propensity cannot be
promoted to exact by any amount of feature engineering; the only way to
put rows on the exact tier is for the assignor to *know* the assignment
probability. That is possible here because wavemill assigns the menu.

**Data flow, end to end.** Every step below is anchored to a source file
so the follow-up issue has a fixed touchpoint, but no code changes in
this PR.

1. **Variant registration and assignment.** At challenge-pair
   materialization (challenger-arm creation in `shared/lib/wavemill-monitor.sh`)
   or in the native-runtime session bootstrap that reads
   `nativeAgent.advanced.*`, an RNG-seeded assignor draws a variant from
   the pre-registered variant set. Only challenger (`_c`) arms in the
   exploration-eligible window are eligible; the primary arm always gets
   the baseline (current-default) variant. Assignment probability is
   recorded at draw time.
2. **`ToolMenuEvent` carries the probability.** The initial `tool_menu`
   event of the session (`shared/lib/native-agent/session-stream.schema.ts:307`)
   gains two optional fields: `variantName: string` and
   `assignmentProbability: number`. Existing consumers ignoring unknown
   fields are unaffected.
3. **Projector emits `exact`.** `derivePropensity` in
   `shared/lib/native-agent/tool-decision-projector.ts:500` learns to
   look for the initial tool-menu event's `assignmentProbability` and
   `variantName`; when present, it emits `propensity.provenance = 'exact'`
   with a filled `distribution`. The schema union already permits `'exact'`
   (`shared/lib/native-agent/tool-decision-schema.ts:57–61`); no schema
   change to that surface is required.
4. **Analyzer consumes the exact tier.** The off-policy machinery at
   `shared/lib/native-agent/tool-choice-analyzer.ts:1761` already restricts
   IPW/AIPW to the exact-provenance tier. Once exact-provenance rows
   exist, that code runs as written; the analyzer needs a small
   configuration change to switch its primary decision from the per-step
   gates (G1–G4/S1–S4) to the menu-level gates (G1'–G4'/S1'–S4') listed
   below, but the estimators are reusable unchanged.
5. **Exploration mechanics reuse HOK-2081's dormant code.** The
   counterfactual runner at `shared/lib/native-agent/counterfactual-runner.ts`
   already models bounded exploration and deterministic replay hooks. It
   is the named reuse target rather than a rebuild.

**What this memo does not do.** It does not change what
`PropensityProvenance` values the schema permits — the `'exact'` value is
already listed. It does not change gate thresholds in `TOOL_CHOICE_GATES`
or their code path. It does not claim exact-provenance rows exist yet.

## Pre-registration

The following gates and signal criteria are pre-registered by this
memo's commit. They are the primary decision rule for the reframed
target. The K, M, S, N, and Δ values below are numerical proposals — the
initial build issue confirms them via a power calculation against the
then-current session-success base rate, before the corpus is examined
under the new setup. Any change to a threshold after the first look at
the exploration data is a re-pre-registration and is called out
explicitly at that point.

| ID | Type | Definition | Proposed value | Justification |
| --- | --- | --- | --- | --- |
| G1' | Coverage — arms | ≥ K sessions per menu variant | K such that 80% power to detect Δ = 5pp at α = 5% given current base rate; expected order of ~200 per variant | Base rate ballpark taken from the current session-success ranges reported by the eval framework; final K is set by the power calc on the actual base rate at build time. |
| G2' | Coverage — models × tasks | ≥ M distinct models and ≥ S distinct task classes represented in each variant cohort | M = 3, S = 20 | Mirrors HOK-2080 G2 for models; task-class count matches the analyzer's current 50%-coverage threshold for the task-class one-hots. |
| G3' | Assignment integrity | ≥ 99% of exploration-eligible `_c` arms carry a `tool_menu.assignmentProbability` and a `variantName`; variant-drift rate (recorded ≠ actually resolved) ≤ N% | 99% coverage, N = 1% | Same intent as HOK-2080 G3 (menu-digest coverage). 1% drift is the honest tolerance for infrastructure noise (worker restart mid-session, cert expiry, etc.) without letting a mis-assigned row into the exact tier. |
| G4' | Off-policy tier viability | The exact-provenance tier reaches ≥ 200 joined rows per variant contrast (matches `TOOL_CHOICE_GATES.minTierJoinedRows`) | 200 | Reuses the existing `minTierJoinedRows` constant so the analyzer needs no threshold change here. |
| S1' | Primary effect | A pre-specified `(task-class × model × variant)` stratum's session-success rate difference has a 95% CI excluding zero after covariate adjustment (state features + task-class one-hots) | — | Same shape as HOK-2080 S1; treatment unit is the variant, not the individual tool. |
| S2' | Holdout replication | Effect direction reproduces on a time-ordered last-20% holdout by decided-at, with 95% CI excluding zero at 90% direction agreement | — | Mirrors HOK-2080 S2 and matches the 70/30 pattern already used by the analyzer, tightened to a later holdout because menu variants land later in the corpus. |
| S3' | Model sensitivity | Direction stable under leave-one-model-out | — | Same as HOK-2080 S3. |
| S4' | Off-policy confirmation | Winning effect sits on `provenance='exact'` rows, computed with IPW/AIPW against the always-baseline-variant contrast; 95% CI excludes zero | — | The reframe's whole reason for existing: the exact tier is now populated by design, so S4 is a reachable check rather than a structural blocker. The always-baseline contrast is the natural target because the baseline variant is the current-default menu. |

**Kill condition.** If G1'–G4' pass and no menu variant satisfies
S1'–S4', the decision is **No-go**. Exploration retires to zero and I-27
closes as decided. Stated here so it is not renegotiable after data is
seen.

**Secondary track (retained, not decision-making).** The per-step
HOK-2080 gates G1–G4 and signals S1–S4 continue to be computed and
reported as descriptive statistics. Analyzer output for the per-step
tier is *not* authoritative under the reframe; the memo requires the
report to state this explicitly on every run so downstream readers do
not misread a per-step S1–S3 pass as a Go signal.

**Pre-registration integrity.** No corpus data from the reframed
exploration has been examined at the time this memo is committed. The
corpus state cited in this memo is the state reported in
`docs/tool-choice-analysis-report.md` on 2026-09-23: corpus absent, all
per-step gates fail with zero rows. The pre-registration timestamp is
this PR's merge commit.

## Cost / safety bounds

**Exploration share, primary arms untouched.** Randomization applies
only to challenger (`_c`) arms. Primary arms always run the baseline
(current-default) variant, so primary behavior is unchanged and the
winner-visibility contract that downstream systems (Arbiter, tend,
merge-lane) depend on is preserved.

Within `_c` arms, exploration share is capped:

- **Initial cap:** 25% of `_c` arms in the exploration-eligible window
  receive a non-baseline variant. The other 75% run the baseline, so the
  Arbiter comparison surface is not skewed.
- **Ramp:** cap rises to 50% once G3' (assignment integrity) has
  demonstrably passed on ≥ 500 challenger arms.
- **Ceiling:** never above 50%. If more coverage is needed, the answer
  is more time, not a higher exploration rate.

**Never remove required tools.** Variants may vary only
`nativeAgent.advanced.*` toggles. The `core` family remains always-on
in every variant. This aligns with HOK-3053's default-off policy — the
baseline variant is literally the current default menu.

**Within the challenge budget, not on top of it.** Menu-variant
exploration must not raise `challenge.rate` (that would breach the
HOK-2815 R6 yield window; see `docs/arbiter/decision-log-HOK-2815.md`).
Variants are drawn *within* the existing challenge budget: exploration
is a re-labeling of `_c` arms wavemill is already running, not
additional arms.

**Safety fallback.** If variant resolution fails mid-session (for
example a variant becomes uncertifiable because a required cert
expired), the runtime falls back to the baseline variant and the row is
tagged `variantFallback = true`. Fallback rows are excluded from S1'
analysis but retained for cost accounting; they do not touch the exact
tier.

**Rollback.** Setting the exploration share to 0 in config is the
rollback. No schema field is removed; existing rows simply stop being
produced. The projector treats a missing `assignmentProbability` as
`surrogate`, exactly as it does today.

## Interaction with Arbiter

The Arbiter contract (see `docs/arbiter/decision-record-contract.md` and
the challenge-validity rules in
`docs/arbiter/challenge-validity-contract.md`) separates a
**delivery verdict** (which arm shipped) from a **stage attribution**
(whether one arm's stage was causally better under matched inputs).
`divergentInputsSuppressedDirectEvidence` (introduced in
`docs/arbiter/decision-log-HOK-2968.md`) codifies that when pre-stage
inputs diverge, direct in-session evidence does not compensate — stage
attribution is downgraded to `invalid` or `insufficient_evidence`.

A menu-variant `_c` arm and its baseline-menu primary have divergent
pre-stage inputs (tool-config hash differs). The consequences the memo
locks in:

- Menu-variant `_c` arms **contribute to menu-selection analysis**
  (they are the entire point of the reframe).
- Menu-variant `_c` arms **do not contribute to reviewer-stage or
  coder-stage causal attribution**. Their `stageAttribution.status`
  will be `insufficient_evidence` by the existing rule, and that is
  correct behavior — no change needed to R6.
- Their **delivery verdict remains usable** for pair-yield accounting
  (HOK-2815 R6), because the delivery verdict does not depend on
  matched inputs.

Concretely, this means the analyzer's menu-level report joins on
`(session, variant, outcome=success)` and does not attempt to combine
menu-variant rows with reviewer-stage attribution rows. It also means
that the R6 yield window is unaffected: menu exploration lives inside
the existing challenge budget, and matched-input attribution work
(reviewer routing, coder routing) continues to draw only from
matched-menu pairs.

## Product shape if Go

If G1'–G4' pass and at least one variant satisfies S1'–S4', the
product shape is a pre-launch **"recommend advanced-tool policy"**
call, surfaced alongside the router and Rework Risk. Interface shape
(sketch, not this memo's decision):

- Input: task features + model.
- Output: recommended `nativeAgent.advanced.*` policy (variant name +
  config).
- Called once per session (single decision per session, `as_of`
  recorded), same fingerprinting rules as the router.
- Decision key: `(repo, session_id, model)`; recorded per the Arbiter
  decision-record contract at `docs/arbiter/decision-record-contract.md`.
- SDK-level: sibling of `arbitrate()`.

The memo does not design the API surface in detail; it fixes the
above contract so the follow-up build issue has a stable target.

## Portfolio swap

The initiative brief states the portfolio funds only **Rework Risk**
and **Cost SDK**. Any Proceed follow-up must name its swap.

**Named swap for the Proceed follow-ups:** pause the reviewer-router
build work already known No-go from B1 (HOK-2073). That effort is not
on the funded portfolio and is a plausible source of engineering time
to reallocate to menu-variant assignment plumbing without touching
Rework Risk or Cost SDK.

**Fallback if no swap is available:** if HOK-2073-adjacent work has
already retired all of its pausable increments, the follow-up build
issues under I-27 default to **Defer** — the data-collection scaffold
proceeds under the existing I-27 issues (HOK-3120–3123), and the
analyzer / recommender build is deferred to the next portfolio
review. The memo does not authorize taking increments off Rework Risk
or Cost SDK under any circumstance.

## Decision

**Proceed**, with the exploration share bounded as specified in the
cost/safety section, conditional on:

- The named portfolio swap being available and accepted by the
  initiative owner.
- The build-issue power calculation for G1' returning a K that fits
  inside the challenge budget under the R6 yield window; if K is too
  large, the memo's fallback is **Defer** until the challenge budget
  opens or the base rate widens.

**Decision map (this is the pre-registered rule):**

- G1'–G4' pass + at least one variant satisfies S1'–S4' → **Go**
  (open the recommend-policy build under the named swap).
- G1'–G4' pass + no variant satisfies S1'–S4' → **No-go** (retire
  exploration, close I-27 as decided).
- G1'–G4' fail → **Inconclusive** with a quantified minimum-capture
  spec, re-checked on a cadence matching the analyzer refresh.

**No-go conditions specific to the reframe.** The reframe itself is
No-go if the advanced-tool catalog turns out to be empty or single-
entry (nothing to vary), or if the challenge-pair yield window is red
for long enough that even the initial 25% exploration cap starves
G1'. Neither is the case today, but the memo names them so operator
retirement is unambiguous later.

## Follow-ups

To be filed by the initiative owner under I-27 after this memo merges.
Each has a working title, a one-line scope, and a named owner surface;
none are filed inside the coding phase.

1. **Menu-variant assignment and `assignmentProbability` emission**
   (owner surface: `native-agent/monitor`, `native-agent/session
   bootstrap`). Scope: variant registry, RNG-seeded assignor at
   challenger-arm creation, extend `ToolMenuEvent` with `variantName`
   and `assignmentProbability`, tag rows with `variantFallback` when
   resolution fails. Reuse: `shared/lib/native-agent/counterfactual-runner.ts`.
2. **Projector: emit `exact` when the tool-menu event carries an
   assignment probability** (owner surface: `native-agent/projector`).
   Scope: `derivePropensity` in
   `shared/lib/native-agent/tool-decision-projector.ts:500` looks up the
   initial `tool_menu` event's `assignmentProbability` and
   `variantName`; when present, returns `{ provenance: 'exact',
   distribution }`. No schema change.
3. **Analyzer: switch primary decision to the menu-level gates
   G1'–G4'/S1'–S4', keep per-step as secondary** (owner surface:
   `native-agent/tool-choice-analyzer`). Scope: consume the new pre-
   registration, emit the menu-level tier in the report, mark the per-
   step tier as descriptive-only. Reuse: the IPW/AIPW code at
   `shared/lib/native-agent/tool-choice-analyzer.ts:1761` runs unchanged.
4. **Report and doc surface: menu-level Go/No-go section in
   `docs/tool-choice-analysis-report.md`** (owner surface: `docs` +
   analyzer report generator). Scope: add a menu-level section with
   G1'–G4' evaluations, per-variant contrasts, and the pre-registered
   S1'–S4' signal readout. Cite this memo as the pre-registration
   artifact.

If the memo is later re-decided to **Defer** at portfolio review time,
follow-ups 1 and 2 remain viable as data-collection scaffolding (they
populate the exact tier without committing to build the recommender);
follow-ups 3 and 4 wait.

## Related

- **Linear:** I-27 (Tool-Menu Decision Model: Data Collection),
  HOK-2080 (per-step decision, closed Inconclusive 2026-09-29),
  HOK-2081 (dormant exploration / production tool router),
  HOK-3053 (advanced-tool catalog and default-off policy),
  HOK-3054 (per-turn tool exposure and menu provenance),
  HOK-3120–3123 (I-27 data-collection scaffolding),
  HOK-2073 (reviewer-router B1 No-go — named portfolio swap),
  HOK-2815 (R6 yield window), HOK-2802–2836 (Arbiter program).
- **Wavemill source:**
  `shared/lib/native-agent/tool-choice-analyzer.ts` (gate wiring at
  ~line 2438, off-policy machinery at ~line 1761),
  `shared/lib/native-agent/tool-decision-projector.ts:500`
  (`derivePropensity`),
  `shared/lib/native-agent/tool-decision-schema.ts:57` (`PropensityProvenance`
  union, already permits `'exact'`),
  `shared/lib/native-agent/session-stream.schema.ts:307` (`ToolMenuEvent`,
  the attach point for `variantName` and `assignmentProbability`),
  `shared/lib/native-agent/counterfactual-runner.ts` (HOK-2081 dormant
  exploration code — reuse target),
  `shared/lib/native-agent/tools/menu-resolver.ts` and
  `shared/lib/native-agent/tools/exposure.ts` (per-turn menu emission
  and the advanced-family executor),
  `shared/lib/eval-success-policy.ts` (session-level `success` outcome
  definition),
  `shared/lib/wavemill-monitor.sh` (challenger-arm creation site — one
  of the two candidate hosts for variant assignment).
- **Wavemill docs:**
  `docs/tool-choice-analysis-report.md` (current corpus-empty baseline
  and per-step gate state, 2026-09-23),
  `docs/native-per-turn-tool-exposure.md` (HOK-3054 per-turn exposure
  contract),
  `docs/arbiter/decision-record-contract.md` (recommendation-call
  contract),
  `docs/arbiter/decision-log-HOK-2968.md`
  (`divergentInputsSuppressedDirectEvidence` rule),
  `docs/arbiter/decision-log-HOK-2815.md` (R6 yield window),
  `docs/arbiter/challenge-validity-contract.md` (delivery verdict vs.
  stage attribution).
- **Sibling decision:** `docs/decisions/structured-search-substrate.md`
  (HOK-3059 — precedent for the shape of this doc).
- **Config surface:** `nativeAgent.advanced.*` in
  `wavemill-config.schema.json` (see the `advanced` block from line 1693;
  `code_search` family from line 3569).
