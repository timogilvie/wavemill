# Arbiter P2.4e Challenge Validity Contract (v1.46.0)

Status: frozen for HOK-2968. This document is the human-readable side of the
challenge validity contract between wavemill producers and Arbiter consumers in
the data pipeline, SDK, website, and reviewer-stage adjudicator.

| Artefact | Path | Role |
|---|---|---|
| This document | `docs/arbiter/challenge-validity-contract.md` | Field semantics, validity reasons, and consumer rules |
| TypeScript contract | `shared/lib/challenge-execution-contract.ts` | `DeliveryVerdict`, `StageAttribution`, `ForkIdentity`, executed identities, and eligibility helpers |
| Eval JSON Schema | `shared/lib/eval-schema.json` | Wire validation for optional `EvalRecord` fields |
| Eval schema types | `shared/lib/eval-schema.ts` | `SCHEMA_VERSION=1.46.0` and optional `EvalRecord` fields |
| Contract tests | `shared/lib/eval-schema.test.ts`, `shared/lib/challenge-execution-contract.test.ts` | Drift and invariant coverage |
| Decision log | `docs/arbiter/decision-log-HOK-2968.md` | Program decision entry for delivery-vs-stage separation |

## 1. Delivery vs. stage

`deliveryVerdict` and `stageAttribution` answer different questions.

- **`deliveryVerdict`** says which arm's PR was accepted as the delivered
  contribution: `primary`, `challenger`, `tie`, or `null`.
- **`stageAttribution`** says whether one arm's varied stage was causally
  better under matched pre-stage inputs and observed execution evidence:
  `valid`, `invalid`, or `insufficient_evidence`.

A row may have a usable delivery verdict while its stage attribution is invalid.
That is intentional. Candidate-selection consumers may read the delivery target;
model-stage coverage and routing-training consumers must use the stage
eligibility helpers.

## 2. DeliveryVerdict

Shape:

```jsonc
{
  "outcome": "primary" | "challenger" | "tie" | null,
  "reason": "NoComparisonReason",
  "prUrl": "https://github.com/org/repo/pull/123",
  "primaryMerged": true,
  "source": "final-pr-arbiter" | "auto-primary" | "operator" | "derived-from-comparison",
  "rationale": "human-readable context"
}
```

`outcome` and `source` are required when the object is present. `reason` is a
typed `NoComparisonReason` used when no arm delivered. `rationale` is not a
training target.

Consumer rule: `deliveryVerdict` remains readable even when
`stageAttribution.status` is `invalid` or `insufficient_evidence`.

## 3. StageAttribution

Shape:

```jsonc
{
  "status": "valid" | "invalid" | "insufficient_evidence",
  "outcome": "primary" | "challenger" | "tie" | null,
  "stage": "plan" | "implementation" | "review",
  "reasonCodes": ["typed_reason_code"],
  "reasonDetails": "human-readable context",
  "winningStageModel": "model-id",
  "losingStageModel": "model-id",
  "evidenceProvenance": "direct" | "inferred" | "insufficient",
  "divergentInputsSuppressedDirectEvidence": true,
  "decidedAt": "2026-09-10T12:00:00Z",
  "producer": "reviewer-stage-adjudicator/v1"
}
```

Invariants:

- `valid`: `outcome` is `primary`, `challenger`, or `tie`; `reasonCodes` is
  empty; `evidenceProvenance` is `direct` or `inferred`.
- `invalid`: `outcome` is `null`; `reasonCodes` is non-empty and names a
  causal invalidity.
- `insufficient_evidence`: `outcome` is `null`; `reasonCodes` is non-empty;
  `evidenceProvenance` is `insufficient`.
- `divergentInputsSuppressedDirectEvidence=true` requires invalid attribution
  plus a hash-mismatch reason.

Reason codes:

| reasonCode | When it fires | Consumer rule |
|---|---|---|
| `stage_override_lost` | The selected stage model was replaced before or during execution | Invalid stage attribution |
| `native_launch_fallback` | Runtime fallback executed a different model than the selected stage model | Invalid stage attribution |
| `identical_effective_route` | The arms did not actually vary for the challenged stage | Invalid stage attribution |
| `state_vs_derived_side_mismatch` | Workflow state and derived side disagree | Invalid stage attribution |
| `operator_reroute` | Operator intervention changed the challenge route | Invalid stage attribution |
| `missing_challenge_intent` | A challenge row has no durable intent | Invalid stage attribution |
| `divergent_pre_stage_inputs` | One or more pre-stage inputs no longer match | Invalid stage attribution; direct evidence is ignored |
| `unverified_fork_commit` | The shared fork commit is absent or unverified | Invalid stage attribution |
| `missing_fork_identity` | Required fork identity is absent | Invalid stage attribution |
| `plan_hash_mismatch` | Fork plan hash is missing or divergent | Invalid stage attribution |
| `prompt_hash_mismatch` | Fork prompt hash is missing or divergent | Invalid stage attribution |
| `task_packet_hash_mismatch` | Fork task-packet hash is missing or divergent | Invalid stage attribution |
| `tool_config_hash_mismatch` | Fork tool-configuration hash is missing or divergent | Invalid stage attribution |
| `missing_direct_review_evidence` | Reviewer-stage direct evidence artifacts are absent | Insufficient evidence |
| `inferred_evidence_only` | Only inferred fallback evidence exists for the varied stage | Insufficient for reviewer-stage training by default |
| `executed_identity_conflict` | Executed identity sources disagree unresolvably | Invalid stage attribution |
| `executed_identity_missing` | A required executed identity is absent or unpinned | Invalid stage attribution |
| `inherited_stage_evidence_only` | The varied stage was inherited rather than executed by that arm | Invalid stage attribution |
| `presentation_order_bias_unresolved` | Swap-test presentation-order bias remains unreconciled | Invalid stage attribution |
| `insufficient_review_iterations` | Review loop did not run enough iterations for adjudication | Insufficient evidence |
| `insufficient_evidence_other` | Closed catch-all above the evidence threshold | Insufficient evidence |

## 4. ForkIdentity

`ForkIdentity` proves matched pre-stage inputs:

| Field | Meaning |
|---|---|
| `stage` | Stage where the pair forked; `null` for independent launches |
| `commit` | Shared git commit at fork point; `null` when no shared prefix exists |
| `tree` | Git tree object id at the fork point |
| `taskPacketHash` | SHA-256 of the task packet content at fork time |
| `planHash` | SHA-256 of the plan artifact at fork time |
| `promptHash` | SHA-256 of the prompt artifact at fork time |
| `toolConfigHash` | SHA-256 over tool registry, allow lists, hook config, and agent adapters |
| `sharedPrefix` | Whether the challenger inherited pre-fork primary artifacts |
| `primaryInheritedStages` | Primary stages inherited from pre-fork execution |
| `challengerInheritedStages` | Challenger stages inherited from pre-fork execution |
| `producer`, `producerVersion` | Producer stamp for the identity envelope |

Direct review evidence never compensates for divergent pre-stage inputs. If a
task-packet, plan, prompt, or tool-config hash does not match, producers set the
specific mismatch code plus `divergent_pre_stage_inputs`; when direct evidence
was collected they also set `divergentInputsSuppressedDirectEvidence=true`.

## 5. ExecutedIdentity

Reviewer-stage attribution records executed identities separately:

- `review_orchestrator`: outer coordinator that controls passes and remediation.
- `substantive_analysis`: inner reviewer that reads code and finds issues.
- `remediation`: model invoked to apply review fixes; may be `null`.

Each identity has `requestedModel`, `resolvedModel`, optional `agent`, `source`,
optional `fallbackReason`, `pinned`, and optional `conflict`. `pinned=true`
requires durable route or artifact evidence. A missing, unpinned, or conflicting
identity makes reviewer-stage attribution invalid or insufficient.

## 6. Consumer Rules

1. Invalid or insufficient `stageAttribution` never counts toward
   `router.coverage.minRecordsPerModelStage`.
2. Invalid or insufficient `stageAttribution` never trains routing or
   reviewer-stage models.
3. `deliveryVerdict` remains usable independently of `stageAttribution`; Model
   A's candidate-selection target is `deliveryVerdict` per HOK-2817.
4. Inherited stages are excluded from per-model coverage counting per HOK-2812.
5. Reviewer-stage adjudication may only emit a stage winner when
   `stageAttribution.status='valid'` per HOK-2970.
6. `divergentInputsSuppressedDirectEvidence=true` codifies that direct evidence
   does not compensate for divergent pre-stage inputs.

Consumers should call `isStageAttributionEligibleForCoverage` and
`isStageAttributionEligibleForTraining` from
`shared/lib/challenge-execution-contract.ts` instead of re-implementing these
predicates.

## 7. Additivity and historical records

All fields in this contract are optional on `EvalRecord` and challenge
comparison records. Historical JSONL rows are preserved untouched and continue
to validate. Producers add the new objects when evidence exists; consumers must
tolerate absence and fail closed for stage coverage/training.

Any new reason code, field, or semantic change requires a `SCHEMA_VERSION` bump
in `shared/lib/eval-schema.ts`, matching `$defs` in
`shared/lib/eval-schema.json`, and updated drift tests. The later
`arbitration_row/v1` pipeline change is coordinated by HOK-2817.

## 8. Sources of Truth

| Source | What it owns |
|---|---|
| `shared/lib/challenge-execution-contract.ts` | TypeScript types, reason-code constants, folding helper, eligibility helpers |
| `shared/lib/eval-schema.json` | JSON wire contract for eval records |
| `shared/lib/eval-schema.test.ts` | TypeScript-to-JSON enum parity and schema fixtures |
| `shared/lib/challenge-execution-contract.test.ts` | Folding-helper and eligibility behavior |
| `docs/arbiter/decision-log-HOK-2968.md` | Program decision text |
