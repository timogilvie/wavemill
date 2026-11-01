# Arbiter S2 Survival Label Contract (v1.0.0, extended by v1.1.0)

> **v1.1.0 (HOK-3265, 2026-10-20).** The canonical v1.1.0 artefacts live in
> `@hokusai/core` (hokusai-sdk `packages/core/schemas/arbiter-survival-label.schema.json`
> and `packages/core/src/arbiter-survival-label.ts`); `@hokusai/scan` emits them.
> v1.1.0 adds `envelope.integration_mode` and admits `main` for direct-merge
> repos — see [The squash-promotion wrinkle](#the-squash-promotion-wrinkle).
> Nothing else changes, and v1.0.0 rows remain valid. The `shared/` copies in
> this repo are the v1.0.0 snapshot that wavemill's own labeller still emits.

Status: frozen for HOK-2803. This document is the human-readable side of the
survival-label contract between the **wavemill labeller** (producer) and the
**`Hokusai/hokusai-data-pipeline`** training ingest (consumer).

The three artefacts below are versioned together; a change to any of them is a
contract change and requires a `schema_version` bump coordinated with the
pipeline:

| Artefact | Path | Role |
|---|---|---|
| This document | `docs/arbiter/survival-label-contract.md` | Semantics: what each value means and how it is computed |
| JSON Schema | `shared/schemas/arbiter-survival-label.schema.json` | Single source of validation truth for producer and consumer |
| Types + helpers | `shared/lib/arbiter-survival-label.ts` | `ArbiterSurvivalLabelV1`, `deriveReportOutcome`, `canonicalHash`, constants |
| Contract test | `shared/lib/arbiter-survival-label.test.ts` | Fails when producer, schema, or consumer expectations drift (HOK-2499 pattern) |
| Round-trip fixture | `shared/lib/arbiter-survival-label.fixtures.json` | Canonical harvested + owner-corrected pair; the pipeline copies it into its own consumer tests |

Lineage: this contract adopts the undo/survival definitions of
`docs/hokusai-second-model-data-plan.md` §3.1 **at PR granularity**, as
reconciled for Arbiter R5 in
[`survival-label-reconciliation.md`](survival-label-reconciliation.md)
(HOK-2792). It does not define a parallel label. `ReworkOutcome` is a
different, already-taken concept (within-branch implementation rework in
`shared/lib/eval-schema.ts`); this object is the **survival label**.

## 1. Unit of labelling

One label object per **merged PR** per **elapsed horizon** (`14 | 30 | 60`
days after the merge), aggregated over the PR's **normalized line ranges** as
walked on the **integration branch**. The label is repo-agnostic: the same
shape describes a label produced from an external repository the scanner has
never seen before — nothing in the contract assumes wavemill state, Linear
IDs, or GitHub specifically.

A PR therefore yields up to three harvested rows (one per elapsed horizon),
plus any owner-correction rows (§8). Rows are append-only; nothing is ever
mutated in place.

## 2. Top-level shape

```jsonc
{
  "schema_version": "1.0.0",
  "prUrl": "https://github.com/example-org/example-repo/pull/123",
  "horizon_days": 30,
  "label_provenance": "harvested",
  "line_ranges": [ { "path": "...", "old": { ... } | null, "new": { ... } | null } ],
  "outcome": {
    "survived": true,
    "survival_ratio": 1.0,
    "reverted": false,
    "undone_by": null,
    "followup": false,
    "report_outcome": "survived",
    "reason_codes": ["no_evidence"]
  },
  "envelope": { /* reproducibility envelope, §6 */ },
  "owner_correction": { /* Tier-2b only, §8 */ }
}
```

- **`prUrl`** — stable PR URL; the join key with the eval and training
  corpora. Any host that assigns URLs to PRs works (GitHub, GitLab, Gitea,
  Bitbucket, …).
- **`horizon_days`** — exactly `14`, `30`, or `60`.
- **`label_provenance`** — `harvested` (automatic) or `owner_corrected`
  (Tier-2b, §8). Downstream training weights `owner_corrected` heavier; the
  weight ratio is pinned in the pipeline, **not** in this contract.
- **`owner_correction`** — required iff `label_provenance ==
  'owner_corrected'`, forbidden otherwise (schema-enforced).

## 3. Outcome fields (§3.1 semantics at PR granularity)

- **`survived`** — `true` when no exact revert and no qualifying follow-up
  affected the normalized PR line ranges inside the horizon; `false` when the
  ranges were exactly reverted or required qualifying follow-up; `null` for
  missing/ineligible labels (§7).
- **`survival_ratio`** — line-weighted fraction `0.0–1.0` of normalized
  PR-changed lines still present in the horizon terminal tree
  (`envelope.horizon_terminal_sha`). Line-weighting is the PR-scale
  normalization: a broad patch is not penalized for touching more lines — its
  larger denominator absorbs proportional churn. `null` for
  missing/ineligible.
- **`reverted`** — `true` **only** for exact/high-precision restoration of the
  pre-change lines over the PR ranges. Same-file churn, partial rewrites, and
  behavioural regressions without line restoration are not `reverted`. `null`
  for missing/ineligible.
- **`undone_by`** — `human | agent | null`: the attributable dominant undoer
  of the undo event affecting the labelled ranges. `null` for no undo,
  formatter-only churn, ambiguous or mixed attribution, or missing labels
  (this preserves the §3.1 enum — no silent `unknown` value). Human undo is
  weighted heavily downstream, agent self-undo lightly.
- **`followup`** — `true` for a qualifying line-range amendment inside the
  horizon, a later PR/issue reference to the labelled change, a same-task
  redispatch, or a **pre-merge human edit that materially undoes or replaces
  the candidate ranges before merge**. `null` for missing/ineligible.
- **`reason_codes`** — non-empty list of typed codes (§5). There is no
  free-form `reason` string on the wire.
- **`report_outcome`** — deterministic derived field (§4).

### Post-merge temporal semantics

The label measures **post-merge** survival of the merged artifact. Pre-merge
human edits are intervention/candidate-rework provenance
(`shared/lib/intervention-detector.ts`) and **never themselves set the merged
artifact's post-merge `survived = false`**. They fold into the label only when
they materially undo or replace the labelled PR ranges before merge, in which
case they contribute `followup = true`, `undone_by = 'human'` (when
attributable), and reason code `pre_merge_human_edit`. "A human touched the
PR" stays distinct from "the PR's candidate lines failed to survive."

## 4. `report_outcome`: deterministic, mutually exclusive

`report_outcome ∈ { survived, followup, substantially_rewritten, reverted, null }`,
derived by `deriveReportOutcome` with this precedence (first match wins):

1. **`null`** — any of `survived`, `survival_ratio`, `reverted`, `followup`
   is `null` (missing/ineligible; §7).
2. **`reverted`** — `reverted === true`. Exact revert beats a co-occurring
   follow-up.
3. **`substantially_rewritten`** — `survival_ratio <
   substantial_rewrite_threshold` (strict `<`).
4. **`followup`** — `followup === true`.
5. **`survived`**.

The substantial-rewrite threshold is **`0.5` in v1.0.0**
(`SUBSTANTIAL_REWRITE_THRESHOLD`). It is part of the versioned normalization
contract: changing it requires bumping `envelope.normalization_version`, and a
replayer must use the threshold pinned by the emitting label's
`normalization_version` (pass it to `deriveReportOutcome` explicitly).

The schema additionally enforces outcome/report consistency: e.g.
`report_outcome='reverted'` requires `reverted=true` and reason code
`exact_revert`; `report_outcome='survived'` requires
`survived=true, reverted=false, followup=false`.

## 5. Reason codes (typed; no free-form)

| Code | Used with | Meaning |
|---|---|---|
| `exact_revert` | `reverted` | Later commit(s) exactly restored pre-change lines over the PR ranges |
| `line_range_followup` | `followup`, `substantially_rewritten` | A later change intersected and amended the labelled ranges |
| `linked_issue_or_pr` | `followup` | A later PR/issue explicitly references the labelled change as needing amendment. hokusai-scan labeller ≥ 1.3.0 counts only references from the same repo, by a non-bot author, and not from a PR into another branch (backports) |
| `pre_merge_human_edit` | `followup` | Human materially undid/replaced the candidate ranges before merge (§3) |
| `task_redispatch` | `followup` | The same task was redispatched to redo the work |
| `substantial_rewrite` | `substantially_rewritten` | `survival_ratio` below the versioned threshold |
| `no_evidence` | `survived` | No revert/follow-up evidence found inside the horizon |
| `unmerged_pr` | missing | PR was never merged to the integration branch |
| `missing_horizon` | missing | The horizon has not fully elapsed since `merge_sha` |
| `insufficient_history` | missing | The horizon terminal tree cannot be resolved |
| `insufficient_line_range_substrate` | missing | Normalization removed every line; nothing to score |
| `inaccessible_history` | missing | Integration-branch history inaccessible or shallow |
| `ambiguous_change` | missing | No canonical line coordinates exist (e.g. rename churn) |

A missing label carries **exactly one** missing-code; terminal labels carry
one or more non-missing codes (schema-enforced).

## 6. Reproducibility envelope

Everything a downstream re-runner needs to reproduce the label bit-for-bit:

| Field | Meaning |
|---|---|
| `schema_version` | Contract version at emit time; must equal the top-level `schema_version` (contract test asserts it) |
| `labeller_version` | Semver of the labeller code |
| `normalization_version` | Semver of the normalizer + threshold table (whitespace/formatter stripping, rename tracking, substantial-rewrite threshold) |
| `pr_head_sha` | Head commit of the labelled PR branch |
| `merge_sha` | Integration-branch merge commit for this PR. For a bors rollup member (`direct` mode corpora), the member's own `Rollup merge of #N` commit: reachable from `integration_branch` through the rollup's landing merge, but not on its first-parent walk |
| `horizon_terminal_sha` | Tip of `integration_branch` at (`merge_sha` committer time + `horizon_days`), resolved deterministically from the git graph. For a rollup member the clock starts at the landing merge, when the change reached the branch |
| `integration_branch` | The branch the labeller walked, e.g. `auto/integration` |
| `integration_mode` | v1.1.0+: `promotion` (the branch is later squash-promoted, e.g. wavemill's `auto/integration` → `main`) or `direct` (PRs merge straight into it). Absent on v1.0.0 rows |
| `computed_at` | ISO-8601 UTC; latest `computed_at` per (`prUrl`, `horizon_days`) wins in queries |

### The squash-promotion wrinkle

The labeller walks **`integration_branch` and PR SHAs, never `main` blame**.
In squash-promotion repos `main` is a squashed rewrite that destroys the
per-PR merge boundary and intermediate SHAs the labeller needs. The contract
therefore carries the walked branch and every anchor SHA so any verifier can
re-walk the same graph without touching `main`. In v1.0.0 the schema **hard
rejects** `integration_branch = 'main'`.

v1.1.0 makes that relaxation for repos that legitimately integrate on `main`.
Every v1.1.0 row declares `envelope.integration_mode`. `main` is accepted only
with `integration_mode = 'direct'`: PRs merge straight into it, so its
first-parent lineage *is* the per-PR history. Squash-promotion repos record
`promotion` and keep the ban. The HOK-3022 public corpus is all direct-merge
repos. Wavemill itself stays `promotion` on `auto/integration`.

## 7. Line ranges (SHA-anchored coordinates)

`line_ranges` is the normalized substrate the outcome was computed over — the
denominator of `survival_ratio` and the matching target for revert/follow-up
evidence. Each entry:

```jsonc
{
  "path": "src/module.ts",                                  // repo-relative, post-change path
  "old": { "start": 10, "end": 24, "sha": "<base sha>" },   // pre-change coords; null for pure additions
  "new": { "start": 10, "end": 30, "sha": "<pr_head_sha>" } // post-change coords; null for pure deletions
}
```

Coordinates are 1-based inclusive and anchored to explicit commits (`old` at
the PR's base for that file, `new` at `pr_head_sha`) so a consumer can
re-check the substrate byte-exactly. `old` and `new` are never both `null`.

### Normalization: applied at label time vs. left as features

Normalized away at label time (never count against `survived`):

- whitespace-only diff hunks; formatter/linter-only lines (formatter passes
  are never undoers);
- rename-only and move-only changes (rename tracking applied);
- pure refactors that preserve the labelled ranges — they neither restore
  pre-change lines nor materially amend them;
- unrelated feature work in the same file that does not intersect the
  labelled ranges.

Left as features (not label-time normalized):

- a more thorough follow-up patch carrying more surface area — shows up as
  denominator growth in `survival_ratio`, and sets `followup=true` only when
  it intersects the labelled ranges;
- churn for unrelated reasons — excluded from the labelled denominator
  entirely;
- human interventions that do not undo the labelled ranges — they stay
  intervention features (`intervention-detector.ts`), never a survival-label
  failure.

Ambiguous refactors are marked missing (`ambiguous_change`), not `survived=false`.
The labeller is precision-biased throughout: favour precision over recall.

## 8. Missing labels: explicit, never imputed

A missing label has **all** outcome components `null`
(`survived, survival_ratio, reverted, undone_by, followup`),
`report_outcome = null`, and exactly one missing-reason code (§5). Causes:
unmerged PR, unelapsed horizon, inaccessible/shallow history, unresolvable
horizon terminal, no line-range substrate after normalization, or ambiguous
coordinates.

Missing labels **must be emitted as rows**, not silently omitted, so training
can distinguish "not yet observed" from "observed and survived". Missing is
never imputed to a boolean, in either direction: a terminal outcome with a
`null` component is schema-invalid, and so is a missing outcome with a
non-null component.

## 9. Tier-2b owner correction

Lifecycle when an owner disputes a label:

1. A new full label row is emitted with the same (`prUrl`, `horizon_days`), a
   fresh `envelope.computed_at`, `label_provenance = 'owner_corrected'`, and
   an `owner_correction` block.
2. `owner_correction.supersedes.label_hash` is the SHA-256 of the
   **canonical-JSON** serialization of the superseded row (harvested or a
   prior correction) — recursively key-sorted, no insignificant whitespace;
   use `canonicalHash` from `shared/lib/arbiter-survival-label.ts`.
3. The superseded row is **never mutated or deleted**. Both rows persist;
   queries pick the latest `computed_at` per (`prUrl`, `horizon_days`).
4. If the superseded row was already trained on, the pipeline joins on
   `supersedes.label_hash` to locate the trained-on row and uses
   `correction.previous_report_outcome` to compute the delta. Whether it
   invalidates the row from the next training pass or applies a correction
   weight is the pipeline's policy; this contract only guarantees the
   invalidation is *possible*.
5. `correction.reason_code` is a typed code (or `owner_dispute` for disputes
   not expressible as a labeller code); `corrected_by` is an opaque identity
   string; `note` is advisory and never parsed by training.

## 10. Versioning and compatibility

- Any change to fields, enums, conditionals, precedence, or the
  substantial-rewrite threshold bumps `ARBITER_SURVIVAL_LABEL_SCHEMA_VERSION`
  (and the schema's `schema_version` const), coordinated with
  `Hokusai/hokusai-data-pipeline`.
- Threshold/normalizer changes additionally bump `normalization_version`;
  labeller code changes bump `labeller_version`.
- The consumer-drift test (`CONSUMER_REQUIRED_FIELDS` in
  `shared/lib/arbiter-survival-label.test.ts`) is hand-maintained: when the
  pipeline starts reading a new field, add it there; the test fails until the
  schema requires it. When the schema drops a field the pipeline reads, the
  same test fails on this side first.
- The pipeline copies `shared/schemas/arbiter-survival-label.schema.json` and
  `shared/lib/arbiter-survival-label.fixtures.json` into its own contract test
  (sibling task HOK-2805), closing the loop from the consumer side.
