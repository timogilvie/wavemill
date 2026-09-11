# Arbiter Storage

Challenge comparisons persist a compact diff identity for both arms so later
analysis can reconstruct the compared contributions from local git state.

Each comparison record may include `primaryDiffIdentity` and
`challengerDiffIdentity`:

- `head_sha`: the side's PR head commit at comparison time.
- `merge_sha`: the diff base SHA used for reconstruction. For forked pairs this
  is `forkCommit`; for independently launched pairs it is the local
  `git merge-base` of the PR base ref and the side's head commit.
- `files_touched`: file paths reported by `git diff --name-only merge_sha
  head_sha`.
- `line_ranges`: added-side line ranges parsed from `git diff --unified=0
  merge_sha head_sha`.

The pair structure is represented by the comparison-level fork descriptor:
`forkStage`, `forkCommit`, `sharedPrefix`, `primaryInheritedStages`, and
`challengerInheritedStages`. For independently launched pairs `forkCommit` is
`null` and each side's `merge_sha` is its own merge base.

Reviewer-stage pairs (HOK-2811, Arbiter P2.4a) populate all five: the pair
shares one planner and one coder run on the primary's branch, then forks at
the primary's coding HEAD. On materialisation the challenger's arm is created
by `challenge_materialize_challenger_arm()` in `shared/lib/wavemill-monitor.sh`:
- `forkStage` is set to `"review"` on both arms' `.challenge-intent.json`.
- `forkCommit` is the primary's HEAD after coding completed.
- `sharedPrefix` is `true`.
- `challenger.inheritedStages` is `["plan","implementation"]`; the primary
  side is `[]`.
- The primary's `.planning-result.json` and `.coding-result.json` are copied
  into the challenger's feature dir with `source: "inherited"` added, which
  `challenge-comparison.ts:parseStageArtifact()` surfaces as an `inherited`
  provenance source instead of the file name.

The fork descriptor is stamped by the narrow writer
`challenge_intent_stamp_fork_descriptor()` (also in
`shared/lib/wavemill-monitor.sh`); it is exempt from the seal check that
guards `persist_challenge_execution_intent`, because it never touches the
selection fields the seal protects — only the descriptor.

## Pending challenger arms (`challengeArms[]`)

Before materialisation, a deferred challenger exists only as a nested record
in the primary task's `challengeArms[]` array in
`.wavemill/workflow-state.json` (HOK-2811/HOK-2813). The record is written by
`challenge_arm_json_build()` in `shared/lib/challenge-arms.sh` and carries the
planned key/slug/branch, role, varied stage, per-role models and agents,
depths, and review mode. State machine:

```text
awaiting_fork → materializing → materialized      (happy path)
              → cancelled                         (pre-fork collapse)
              → exhausted                         (materialisation retry ceiling)
materializing → awaiting_fork                     (retryable failure, or restart recovery)
```

Lifecycle contract:

- **No task, worktree, pane, branch, or PR exists** for an `awaiting_fork`
  arm — by design, not by damage. Sweepers, watchdogs, orphan resolvers,
  pairing repair, pair recovery, and terminal reconciliation treat the pair
  as intact-but-deferred (`taskHasPendingChallengeArm` /
  `pairHasPendingChallengeArm` in `shared/lib/tend-challenge-gate.ts`); the
  dashboard renders the arm as an `awaiting fork` annotation under the
  primary without any pane lookup.
- **Restart:** only the primary rehydrates as a task. An arm caught in
  `materializing` by a restart is reset to `awaiting_fork`
  (`challenge_arms_recover_interrupted()`) and retried through the
  bounded-retry fork trigger. Recovery consumes the persisted arm record
  verbatim — planned identity, models, and immutable intent references are
  never recomputed. If the recovered fork identity cannot be verified at
  comparison time, delivery recovery proceeds but stage attribution is marked
  invalid with the existing typed reason codes (`unverified_fork_commit`,
  `missing_fork_identity`).
- **Pre-fork primary failure:** the primary's terminal pre-fork cleanup
  collapses the challenge to a single run via
  `challenge_arms_cancel_pending(issue, "pre_fork_primary_failure", detail)`.
  The cancelled arm record is retained on the primary for audit
  (`cancelReason`, `cancelDetail`, `cancelledAt`); active pairing selection
  is cleared; `pre_fork_primary_failure` is a registered no-comparison
  reason. The surviving primary is never promoted to a fresh solo pipeline,
  and no challenger task/worktree/branch/PR is created by the collapse.

The losing side's full patch is retained locally when there is a winner:

```text
.wavemill/evals/artifacts/<challengePairId>/loser.patch
```

Only the loser patch is written by default. The winner is represented by the
comparison identity and normal git history after merge, while the loser is the
side most likely to lose branch/worktree state after PR closure.

Patch retention is capped at 10 MiB. If `git diff merge_sha head_sha` exceeds
that cap, Wavemill skips `loser.patch`, emits a warning, and still writes both
sides' compact diff identities to the comparison record.

These artifacts are local runtime data under `.wavemill/evals`, which is
gitignored. They are not uploaded, included in PR comments, sent to Linear or
Hokusai export, or otherwise moved across the repository privacy boundary by
comparison storage. No database migration, external egress path, or config file
is required for this retention policy.

## Swap-test corpus and runs

The presentation-order swap test retains its replay corpus and raw run outputs
under the same local eval artifact root:

```text
.wavemill/evals/artifacts/<challengePairId>/primary.diff
.wavemill/evals/artifacts/<challengePairId>/challenger.diff
.wavemill/evals/artifacts/<challengePairId>/swap-test-context.json
.wavemill/evals/swap-test/runs/<runId>/manifest.json
.wavemill/evals/swap-test/runs/<runId>/results.jsonl
.wavemill/evals/swap-test/runs/<runId>/summary.json
.wavemill/evals/swap-test/runs/<runId>/summary.md
```

Hydration is one-time and idempotent. Existing `primary.diff`,
`challenger.diff`, and retained `loser.patch` files are reused; missing side
diffs are fetched by full PR URL and then replayed locally. The runner never
fetches GitHub state.

`swap-test-context.json` records prompt provenance, challenge type and
difficulty strata, head identity, original verdict metadata, and degenerate
flags such as empty diffs or tied original dimensions. Raw result rows include
judge model, prompt hash, template hash, usage, cost, truncation state, and
duration for each pair/order call.

These files are runtime artifacts and remain gitignored. The committed
write-up material is limited to aggregate Markdown summaries, with no diffs,
prompts, or per-pair judge rationales.
