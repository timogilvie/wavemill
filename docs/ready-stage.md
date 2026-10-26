# Ready Stage

The `ready` stage is the merge-readiness gate that runs after review and before merge. Review answers "is the change correct?"; ready answers "is it safe to merge right now?"

This stage is available in two forms:

- `wavemill ready <pr>` for an on-demand check of a PR number or PR URL
- the `ready` phase inside `wavemill mill` for continuous monitor-based gating

The ready stage now includes live GitHub mergeability detection for open PRs. Merge-conflict state is reported separately from the readiness verdict so operators and the monitor can distinguish conflict remediation from other readiness failures.

When autonomous integration mode is enabled, the ready stage also becomes the policy gate that `tend` rechecks immediately before merge.

## Overview

The ready stage sits between PR creation and merge:

```text
review -> ready -> merge
```

Responsibilities of each phase:

- `review`: judge correctness, requirements coverage, and major code-quality blockers
- `ready`: judge merge-readiness, release-readiness, and operator follow-up steps
- `merge`: complete the PR only after the ready gate is satisfied

The target check categories for the ready stage are:

- CI status
- required approvals
- merge conflicts
- branch freshness
- release and manual-step requirements
- migration safety checks for risky Alembic DDL
- migration reversibility

Current implementation details:

- mergeability comes from `gh pr view --json mergeable,mergeStateStatus`
- GitHub `UNKNOWN` mergeability is retried up to 3 times with 5-second delays
- merge conflict state is surfaced in a dedicated `mergeConflict` field
- the readiness verdict still reflects the configured `checks` array

## CI Check Evaluation

Ready uses the shared PR CI evaluator in `shared/lib/pr-ci-status.ts`. A ready pass is allowed only when the observed GitHub check rollup is complete enough to prove that required CI is green.

Required contexts are resolved in this order:

- GitHub branch protection for the PR base branch
- `integration.requiredChecks` from wavemill config
- no explicit required contexts, in which case every observed check still has to be complete and passing

CI verdicts are fail-closed:

- any recognized failing, errored, cancelled, or timed-out check yields `fail`
- any missing required context, pending check, empty check set, empty check-run conclusion, or unrecognized check state yields `pending`
- an empty check set yields `skip` only when `ready.requireCiChecks` is explicitly `false`
- skipped and neutral GitHub checks count as passing once required contexts are present

Policy-mode ready checks (`integration.readyPolicy.enabled`) also include a real `ci-status` check. A stored ready result records `readyHeadSha`, `ciConclusion`, `requiredContexts`, and `requiredSource` so later monitor ticks can compare the stored verdict with live GitHub state.

## CLI Usage

### Syntax

```bash
wavemill ready <pr>
```

Direct tool invocation during development also works:

```bash
npx tsx tools/ready.ts <pr>
```

### Arguments

| Argument | Meaning |
|----------|---------|
| `<pr>` | GitHub PR number like `42` or PR URL like `https://github.com/org/repo/pull/42` |

### Options

| Flag | Meaning |
|------|---------|
| `--repo-dir <path>` | Repository directory to inspect. Defaults to the current directory. |

### Examples

Check a PR by number:

```bash
cd ~/src/my-repo
wavemill ready 42
```

Check a PR by URL:

```bash
wavemill ready https://github.com/acme/widgets/pull/42
```

Check a PR from another checkout:

```bash
wavemill ready 42 --repo-dir ~/src/my-repo
```

### Output Format

The command writes human-readable mergeability status to `stderr` and JSON to `stdout` so it can still be consumed by scripts or the monitor:

```json
{
  "prNumber": 42,
  "verdict": "warn",
  "checks": [
    {
      "name": "release-requirements",
      "status": "warn",
      "message": "No task packet found - skipping release requirements check",
      "details": {}
    }
  ],
  "mergeConflict": {
    "status": "CLEAN",
    "message": "No merge conflicts detected",
    "mergeable": "MERGEABLE",
    "mergeStateStatus": "CLEAN",
    "attempts": 1
  },
  "timestamp": "2026-04-08T12:00:00.000Z",
  "summary": "Checks passed with warnings - review before merge"
}
```

The shared result schema is:

| Field | Type | Meaning |
|------|------|---------|
| `prNumber` | `number` | PR that was checked |
| `verdict` | `"pass" | "fail" | "warn"` | Overall merge-readiness verdict |
| `checks` | `ReadyCheck[]` | Individual check results |
| `mergeConflict` | `MergeConflictResult \| undefined` | GitHub mergeability state for the PR |
| `headSha` | `string \| undefined` | PR head SHA whose CI was evaluated |
| `ciConclusion` | `string \| undefined` | Shared CI evaluator conclusion |
| `timestamp` | `string` | ISO 8601 UTC timestamp |
| `summary` | `string` | Human-readable overall summary |

Each item in `checks` has:

| Field | Type | Meaning |
|------|------|---------|
| `name` | `string` | Stable check identifier such as `ci-status` |
| `status` | `"pass" | "fail" | "warn" | "skip"` | Result for that check |
| `message` | `string` | Human-readable explanation |
| `details` | `Record<string, unknown>` | Optional structured context |

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Ready verdict is `pass` or `warn` |
| `1` | Ready verdict is `fail` |

Operational note: `mergeConflict.status` is independent from the main verdict. A PR can have clean readiness checks but still be blocked because GitHub reports merge conflicts.

## Merge Queue Live-CI Gate

The mill merge-queue selector receives live CI state for every ready PR. A PR is selectable only when `ci.conclusion` is `pass` and GitHub `mergeStateStatus` is not `BLOCKED`, `DIRTY`, or `UNSTABLE`.

Stored ready passes are invalidated when a later tick observes live CI `fail` for that PR. The ready result is rewritten as `failed` with `ciInvalidatedAt`, `ciInvalidationReason`, `ciFailingChecks`, and `lastCi*` artifact fields. Pending or unreadable live CI is not promoted; it remains waiting until a later tick can prove green.

Queue logs no longer claim `clean/green` from stored state. Promotion logs now cite the live CI observation, for example `live CI pass: 15/15 checks @abc1234`.

### Example Pass Output

Example clean mergeability output:

```json
{
  "prNumber": 42,
  "verdict": "pass",
  "checks": [
    {
      "name": "ci-status",
      "status": "pass",
      "message": "All CI checks passing"
    }
  ],
  "mergeConflict": {
    "status": "CLEAN",
    "message": "No merge conflicts detected",
    "mergeable": "MERGEABLE",
    "mergeStateStatus": "CLEAN",
    "attempts": 1
  },
  "timestamp": "2026-04-08T12:00:00.000Z",
  "summary": "All checks passed - safe to merge"
}
```

### Example Fail Output

The fail shape below shows the contract operators and scripts should be prepared to handle once real checks are implemented:

```json
{
  "prNumber": 42,
  "verdict": "fail",
  "checks": [
    {
      "name": "merge-conflicts",
      "status": "fail",
      "message": "PR has merge conflicts with main",
      "details": {
        "state": "conflicted"
      }
    },
    {
      "name": "approvals",
      "status": "pass",
      "message": "Required approvals are present"
    }
  ],
  "mergeConflict": {
    "status": "CONFLICTED",
    "message": "PR has merge conflicts with base branch",
    "mergeable": "CONFLICTING",
    "mergeStateStatus": "DIRTY",
    "attempts": 1
  },
  "timestamp": "2026-04-08T12:05:00.000Z",
  "summary": "Merge is blocked until conflicts are resolved"
}
```

## Merge Conflict Detection

The ready engine checks mergeability with:

```bash
gh pr view <pr> --json mergeable,mergeStateStatus
```

GitHub computes mergeability lazily, so the first response can be `UNKNOWN`. The ready engine retries up to 3 times with 5-second delays before surfacing `UNKNOWN` to the caller.

Reported merge states:

- `CLEAN`: GitHub reports the PR can merge cleanly
- `CONFLICTED`: GitHub reports merge conflicts
- `UNKNOWN`: GitHub is still computing mergeability after retries
- `ERROR`: GitHub CLI failed or returned an unexpected state

## Migration Base Freshness Check (`migration-base-freshness`)

The `migration-base-freshness` check catches a specific Alembic failure mode:
the branch migration head was valid when authored, but `origin/<base>` gained a
new migration before the PR reached ready. In that case the branch can still
look locally correct while the merge ref would create a stale `down_revision`
chain and fail later in CI.

### When it runs

- The check only applies to `ready.migrationKind = "alembic"`.
- It only fetches `origin/<base>` when the PR actually changed files matching
  `ready.migrationPatterns`.
- If no migration files changed, the check returns `skip` and does not hit the
  network.

### What it verifies

1. Fetch the latest `origin/<base>`.
2. Read Alembic revisions from that base ref and identify the current base head.
3. Read Alembic revisions from the branch worktree and identify the branch head.
4. Walk the branch head's `down_revision` chain and confirm the current base
   head is reachable.

If the branch head is not based on the current base head, the check fails with
targeted remediation. The message includes both revision IDs verbatim:

```text
Branch migration head `<branchHead>` is not based on the current base head `<baseHead>`. Rebase onto `origin/<base>` and update `down_revision` to `<baseHead>` (or a descendant) before retrying.
```

If the base branch cannot be inspected cleanly, the check degrades to `warn`
instead of crashing. If the branch already has multiple Alembic heads, the
check returns `skip` and lets `migration-chain-integrity` produce the primary
diagnostic.

## Migration Reversibility Check (`migration-reversibility`)

The `migration-reversibility` check inspects every migration file added or
modified by the PR and confirms each one has an executable `downgrade()`
function. Real incidents need rollback, so a `def downgrade(): pass` quietly
removes that option without anyone deciding it is OK; this check forces the
choice to be made deliberately rather than discovered at 3 AM.

### What gets checked

For each migration file matched by `ready.migrationPatterns` and present in
the PR's changed files, the check parses the file with Python's `ast` module
(via `shared/lib/migration_ast.py`) and inspects the body of `def downgrade()`.

Hard failures:

| Body shape | Reason key |
|------------|------------|
| Function not defined | `missing-downgrade` |
| Only `pass` | `empty-pass` |
| Only a docstring | `empty-docstring` |
| Docstring + `pass` | `empty-pass` |
| Only `raise NotImplementedError` (bare or called) | `not-implemented` |
| Docstring + `raise NotImplementedError` | `not-implemented` |
| Python syntax error / parse failure | `parse-error` |

A `non-trivial` body — anything that contains executable statements other
than the patterns above — passes.

### Override label

Repositories that genuinely cannot reverse a specific migration can apply the
`migration:irreversible` label to the PR. When the label is present, hard
failures are recorded under `details.overriddenFailures` and the check returns
`pass` so the choice is documented rather than hidden. Label matching is
case-insensitive.

### Soft warning for destructive upgrades

Even when `downgrade()` is non-trivial, the check emits an advisory entry in
`details.warnings` whenever `upgrade()` contains `op.drop_column` or
`op.drop_table`. Recreating a column or table in `downgrade()` will not
restore data that was already dropped, so reviewers should confirm the data
loss is acceptable. The warning does not change the check status (`pass`) and
does not flip the overall ready verdict to `warn`.

### When the check skips

If no changed files match the configured migration patterns, the check
returns `skip` and does not invoke Python at all.

### Configuration

- `ready.checks` honors `"migration-reversibility"` as a stable check name.
  Listing it alongside `ci-status`, etc. restricts the ready stage to that
  subset.
- `ready.migrationPatterns` controls which paths are treated as migration
  files for both this check and `migration-chain-integrity`.

### Example fail output

```json
{
  "name": "migration-reversibility",
  "status": "fail",
  "message": "Migration file has no executable downgrade() — apply the migration:irreversible label to document this decision",
  "details": {
    "overrideLabel": "migration:irreversible",
    "overrideApplied": false,
    "failures": [
      {
        "file": "migrations/versions/2026_05_03_001_add_column.py",
        "reason": "empty-pass",
        "classification": "empty-pass",
        "message": "Migration downgrade() body is only \"pass\""
      }
    ],
    "warnings": [],
    "migrationFiles": ["migrations/versions/2026_05_03_001_add_column.py"]
  }
}
```

### Example override pass

```json
{
  "name": "migration-reversibility",
  "status": "pass",
  "message": "Migration reversibility failures overridden by migration:irreversible label",
  "details": {
    "overrideLabel": "migration:irreversible",
    "overrideApplied": true,
    "overriddenFailures": [
      {
        "file": "migrations/versions/2026_05_03_001_drop_legacy.py",
        "reason": "not-implemented",
        "classification": "not-implemented",
        "message": "Migration downgrade() raises NotImplementedError"
      }
    ],
    "warnings": [],
    "migrationFiles": ["migrations/versions/2026_05_03_001_drop_legacy.py"]
  }
}
```

### Example soft-warn pass

```json
{
  "name": "migration-reversibility",
  "status": "pass",
  "message": "Migration downgrade() bodies are non-trivial; upgrade() contains destructive operations that downgrade cannot restore data for",
  "details": {
    "warnings": [
      {
        "file": "migrations/versions/2026_05_03_002_remove_field.py",
        "destructiveOperations": ["op.drop_column"],
        "classification": "non-trivial"
      }
    ],
    "migrationFiles": ["migrations/versions/2026_05_03_002_remove_field.py"]
  }
}
```

## Integration Policy Guards

When `integration.readyPolicy.enabled = true`, autonomous merge uses `ready-engine.ts` to evaluate a focused set of policy guards before `tend` merges a PR into `auto/integration`.

The guards are:

- `checkBaseBranch()`: PR must target the configured integration branch.
- `checkMetadata()`: PR must contain a valid `wavemill-meta` block.
- `checkDependencies()`: `depends_on` and `depends_on_linear` references must already be satisfied.
- `checkMigrationCoupling()`: `db:migration` must be paired with `wm:migration` unless coupling is disabled.
- `checkRiskPolicy()`: high-risk PRs follow the configured risk policy.
- `checkChallengePairs()`: challenge PRs need a resolved comparison record before autonomous merge.

### Guard Outcomes

| Signal | Ready | Blocked / Pending / Warn |
|--------|-------|---------------------------|
| Base branch | PR targets `integration.readyPolicy.integrationBranch` or `integration.integrationBranch` | `fail` if the PR still targets another branch such as `main` |
| Metadata | Valid `wavemill-meta` block | `fail` if missing or malformed |
| PR dependency | Referenced `depends_on: ["PR#123"]` PR is merged | `pending` if still open, `fail` if missing or closed without merge |
| Linear dependency | Referenced issue is completed | `pending` if still incomplete, `fail` if missing or canceled |
| Migration coupling | no migration labels, or both `db:migration` and `wm:migration` are present | `fail` if `db:migration` is missing `wm:migration`; `warn` if `wm:migration` exists alone |
| High risk | no high-risk signal, or policy requirements are satisfied | `fail` for `riskPolicy=block`; `pending` for `require-label` without `wm-risk-acknowledged`; `warn` for `riskPolicy=auto` |
| Challenge pair | PR is not in challenge mode, or a comparison record resolves the pair | `fail` if comparison data is missing or unreadable |

### Integration-Red Blocking

Ready policy is necessary but not sufficient. `tend` also checks the current `auto/integration` branch health before selecting any candidate. If the integration branch CI is red, tend reports `health=degraded`, no PR is eligible, and autonomous merging halts until the branch is green again.

That means a PR can be individually ready and still remain unmerged because the shared integration branch is failing.

## Automatic Conflict Resolution

When `wavemill mill` runs the ready stage and sees `mergeConflict.status = "CONFLICTED"`:

1. It relaunches the task agent in that same worktree with a conflict-resolution-only prompt.
2. Only once that launch succeeds, it writes one condition-keyed marker, `features/<slug>/.conflict-remediation.json` (`{head, base, launchHead, prNumber}`, `--expires-on head,remote,operator-event`), and charges the `conflict-remediation-relaunch` bounded-retry bucket (one attempt per `(head, base)`). A Ready that defers (cross-PR guard pending, ownership held) or a refused launch charges nothing (HOK-3273).
3. The agent fetches the base branch, merges it, resolves conflicts, validates, commits, and pushes.
4. The push moves the head: the condition reconciler expires the marker, the budget key resets, and the monitor reruns `wavemill ready <pr>`, which reads mergeability from GitHub again. Conflict state is never latched locally.

If the PR is still conflicted at a `(head, base)` whose one resolver already ran, the bucket terminalizes ("Conflict remediation exhausted on identical (head, base)") and the task holds at needs-user until a new commit, a new base, or an operator event. If mergeability comes back `UNKNOWN` or `ERROR`, the monitor writes `features/<slug>/.needs-attention` and marks the task for operator follow-up.

## Monitor Behavior

`wavemill mill` uses the same ready-stage contract for automatic merge gating after review completes and a PR exists.

The intended workflow is:

```text
coding -> review -> PR open -> ready -> merge
```

Monitor responsibilities in the ready phase:

- move a task from `review` into `ready` once the PR is open
- run the same shared readiness engine used by `wavemill ready <pr>`
- persist the result in workflow state
- keep the task blocked from merge completion until the ready gate passes
- rerun readiness after operator action or automated remediation
- surface merge conflicts separately from other readiness verdict failures

Expected state transitions:

| From | Condition | To |
|------|-----------|----|
| `review` | PR created successfully | `ready` |
| `ready` | all required checks pass | `merge` |
| `ready` | required check fails | `blocked` or stay in `ready` pending remediation |
| `ready` | warnings only | `merge` with operator awareness |

Practical operator interpretation:

- a passing ready result means merge may proceed
- a warning result means merge may proceed, but the warning must be consciously handled
- a failing result means do not merge until the blocking condition is cleared

For conflicted PRs, the monitor attempts a narrow in-place remediation before escalating to the operator.

## Merge-Gating Policy

Policy for repositories adopting the ready stage:

1. Do not merge a PR until the ready check has run.
2. Do not allow human override for a `fail` verdict unless there is a documented incident-level reason.
3. Treat `warn` as mergeable only when the operator has completed or explicitly accepted the listed manual steps.
4. Keep the merge decision tied to the latest ready result, not an older successful run.

Manual operator workflow:

```bash
wavemill ready 42
```

Use the result to answer three questions before merge:

- Are blocking checks failing?
- Are there manual release steps that must happen before or after merge?
- Is the result current for the latest PR head?

Recommended merge rule once real checks are live:

- `pass`: merge allowed
- `warn`: merge allowed only with explicit operator handling of the warning
- `fail`: merge blocked

## Migration Dry-Run (Ephemeral Postgres)

Use the migration dry-run workflow when label-based or static migration checks are not enough. Running every migration end to end against a clean Postgres instance catches semantic failures that chain checks miss, including missing `create_index` calls, object-name collisions, Postgres-specific `ENUM` behavior, and hidden ordering dependencies between revisions.

Scaffold the workflow into an adopting repository with either entrypoint:

```bash
npx tsx tools/scaffold-migrate-dryrun.ts <target-repo>
wavemill scaffold migrate-dryrun <target-repo>
```

The scaffold writes two files into the target repo:

- `.github/workflows/_migrate-dryrun.yml` - the reusable workflow copied from wavemill
- `.github/workflows/migrate-dryrun.yml` - a thin wrapper triggered on `pull_request`

The wrapper defaults to `alembic upgrade head`, Python `3.11`, database `app_test`, and `requirements.txt`. Pass `--verify-reversibility` during scaffolding if the repo should also run `alembic downgrade base` followed by a second `upgrade head`.

Tradeoffs:

- Upgrade-only runs are typically about 30 seconds on `ubuntu-latest`
- Reversibility roughly doubles that to about 60 seconds
- Budget roughly 2 GitHub Actions minutes per PR when the workflow is enabled

Integration with `checkCIStatus` is automatic. This workflow appears like any other GitHub status check, so the ready stage will pick it up without new ready-specific code.

## Ready Configuration

The ready stage always runs for mill-managed repositories. The `ready` config section controls which checks run and which checks are required; it does not disable the ready phase itself.

Configuration cases:

- `ready` missing from `.wavemill-config.json`: only universal checks run (`pr-exists`, `merge-conflict`, `ci-status`)
- `ready.checks` missing or `[]`: same conservative universal defaults
- `ready.checks`: explicit allowlist of checks to run
- `ready.requiredChecks`: subset of `ready.checks` that is merge-blocking
- `ready.migrationPatterns`: overrides the regex patterns used to discover migration files for migration-related checks (including `migration-reversibility`)
- `ready.migrationKind`: declares migration format (`alembic`, `sql`, `none`) for migration-specific checks

### Recommended Alembic Configuration (Hokusai-style)

Use this when the repository stores Alembic revisions under `alembic/versions/` and wants local ready checks to match GitHub's merge-context behavior:

```json
{
  "ready": {
    "checks": [
      "pr-exists",
      "merge-conflict",
      "ci-status",
      "schema-migrations",
      "migration-base-freshness",
      "migration-chain-integrity",
      "migration-reversibility",
      "forbidden-ddl"
    ],
    "requiredChecks": [
      "pr-exists",
      "merge-conflict",
      "ci-status",
      "migration-base-freshness",
      "migration-chain-integrity",
      "migration-reversibility"
    ],
    "migrationKind": "alembic",
    "migrationPatterns": ["alembic/versions/.*\\.py$"]
  }
}
```

Behavior notes:

- `migration-base-freshness` fetches `origin/<base>` only when the PR changed
  migration files, then verifies the branch head is still descended from the
  latest base head before later merge-ref validation runs.
- `migration-chain-integrity` evaluates the merged tree of `origin/<base>` plus `HEAD` when run through `wavemill ready <pr>`, so a branch-local single head can still fail if the merge result would create two heads.
- If git cannot build that merge tree, the check falls back to the worktree scan and records `details.mergeContext = { "source": "worktree-fallback", "reason": "merge-conflict" | "git-unavailable" }`.
- Head failures name the revision IDs and files inline, for example: `Migration chain must have exactly one head, found 2: 044 (alembic/versions/044_main.py), 045 (alembic/versions/045_branch.py)`.

Workflow expectations:

- the ready contract remains stable even as checks are added
- existing review and merge workflows continue after the ready gate reports `pass` or `warn`

`forbidden-ddl` inspects changed migration files with Python AST parsing and evaluates these rules inside `upgrade()`:

- `add_column_non_nullable_no_default`: `fail`
- `drop_column`: `fail` unless the PR has `migration:destructive`
- `drop_table`: `fail` unless the PR has `migration:destructive`
- `alter_column_type`: `warn` unless the PR has `migration:long-running`
- `execute_dml`: `warn` with guidance to run the backfill as a separate online job

Analyzer scope:

- only `op.*` calls inside `upgrade()` are inspected
- `op.execute(...)` only warns on literal SQL strings containing `UPDATE`, `INSERT`, or `DELETE`
- string literals that merely mention dangerous operations do not trigger findings

Minimal explicit configuration:

```json
{
  "ready": {
    "checks": ["pr-exists", "merge-conflict", "ci-status"],
    "requiredChecks": ["pr-exists", "merge-conflict", "ci-status"]
  }
}
```

## Failure Paths And Recovery

The ready stage exists to make blocking conditions explicit. The scenarios below describe the operator response expected once the real checks are enabled.

### CI Failure

Symptoms:

- ready result shows a failing `ci-status` check
- the PR is not safe to merge yet

Typical response:

```bash
gh pr checks 42
gh run view <run-id> --log-failed
```

Recovery:

- fix the failing code or flaky test in the worktree
- push a new commit
- rerun `wavemill ready 42`
- merge only after the verdict returns to `pass` or acceptable `warn`

### Merge Conflicts

Symptoms:

- ready result shows `mergeConflict.status = "CONFLICTED"`
- GitHub reports the PR is not mergeable

Typical response:

- let `wavemill mill` attempt automatic remediation first
- if it writes `.needs-attention`, open the existing worktree and resolve manually

Recovery goal:

- get the PR back to a clean merge state
- rerun ready after the push

### Approval Failure

Symptoms:

- ready result shows the approvals check failed
- required reviewers have not approved or approval was dismissed

Typical response:

```bash
gh pr view 42 --json reviews,reviewDecision
```

Recovery:

- request the missing reviewer
- address review feedback
- rerun `wavemill ready 42` after approvals land

### Manual Release Steps Required

Symptoms:

- ready result returns `warn`
- the result references a manual deployment, config, or migration action

Typical response:

- confirm who owns the manual step
- decide whether the step must happen before merge or immediately after merge
- record the handoff in the PR or release notes

Example operator checklist:

```text
- apply production config change
- run migration playbook
- invalidate caches
- confirm post-merge smoke check owner
```

### Network Or API Error

Symptoms:

- CLI exits non-zero before producing a usable result
- GitHub or local repo inspection fails transiently

Typical response:

```bash
wavemill ready 42 --repo-dir ~/src/my-repo
```

Recovery:

- rerun the command
- verify repository access and GitHub authentication
- avoid merging while readiness status is unknown

## Configuration Reference

Ready-stage settings live in `.wavemill-config.json` under `ready`.

### Schema

```json
{
  "ready": {
    "checks": [],
    "requiredChecks": []
  }
}
```

### Options

| Setting | Type | Default | Meaning |
|---------|------|---------|---------|
| `ready.checks` | `string[]` | `[]` | Checks to run. Missing/empty uses universal defaults (`pr-exists`, `merge-conflict`, `ci-status`). |
| `ready.requiredChecks` | `string[]` | `[]` | Subset of `ready.checks` that must pass. Required `skip` is non-blocking and reported as warning. |
| `ready.migrationPatterns` | `string[]` | repo defaults | Regex patterns used to discover migration files for migration-related checks. |
| `ready.migrationKind` | `"alembic" \| "sql" \| "none"` | unset | Migration format hint for migration-specific checks; unsupported kinds are skipped instead of failed parsing. |

### Minimal Configuration

```json
{
  "ready": {
    "checks": ["pr-exists", "merge-conflict", "ci-status"],
    "requiredChecks": ["pr-exists", "merge-conflict", "ci-status"]
  }
}
```

### Explicit Full Configuration

```json
{
  "ready": {
    "checks": [
      "pr-exists",
      "merge-conflict",
      "ci-status",
      "schema-migrations",
      "migration-base-freshness",
      "migration-chain-integrity",
      "forbidden-ddl",
      "migration-reversibility"
    ],
    "requiredChecks": [
      "pr-exists",
      "merge-conflict",
      "ci-status",
      "schema-migrations",
      "migration-base-freshness",
      "migration-chain-integrity",
      "migration-reversibility"
    ],
    "migrationKind": "alembic",
    "migrationPatterns": ["alembic/versions/.*\\.py$"]
  }
}
```

Guidance:

- use `checks` to narrow which checks are evaluated
- use `requiredChecks` to distinguish blockers from advisory checks
- keep `requiredChecks` aligned with branch-protection and release policy

## Operator Policy Summary

Use the ready stage as the final pre-merge decision point.

- Review passing is necessary but not sufficient.
- Ready passing is the merge gate.
- Failures block merge.
- Warnings require deliberate operator handling.
- Missing ready configuration keeps onboarding conservative and non-opinionated.

The ready contract, monitor behavior, and operator policy should stay stable as additional checks are added.
