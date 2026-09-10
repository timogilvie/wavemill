# Wavemill Lifecycle Certification & Staged Rollout (HOK-2957)

This document is the operator runbook and technical reference for the
end-to-end lifecycle certification suite and the staged-rollout machinery
introduced by HOK-2957 to safely re-introduce branch deletion after the
2026-09-05 terminal-resource-leak / repeated-cleanup incident.

## What this suite proves

The 2026-09-05 incident was caused by helper-level suites that individually
verified their scope but did not exercise the full lifecycle chain:
`persisted state → startup → agent/pane ownership → PR transition → Git
cleanup → restart → Observer/status`. The certification suite exercises the
chain as a system on real tmux + real git + real controller code:

| Packet success criterion | Enforced by |
|---|---|
| Harness leaves zero tmux processes, worktrees, branches, or temp state | `invariant_no_leaks` + double-pass runner (`--runs 2`) |
| Terminal panes gone within one reconciliation interval unless `retainPane` | `invariant_pane_released_within_interval` |
| No duplicate cleanup attempt before `nextRetryAt` | `invariant_no_duplicate_attempt_before_next_retry` |
| No branch deletion without recorded authority + exact final-head verification | `invariant_deletion_requires_authority` + `check-lifecycle-budgets --report` |
| Monitor p95 idle iteration below `pollSeconds` | `lifecycle-budgets.ts:monitor_p95` (reads `monitor-timing.json`) |
| Observer and controller classifications agree per scenario | `invariant_agreement` |
| Restart at every injected boundary reaches the same eventual state | `lifecycle-certification-faults.test.sh` + `cert_capture_state` diff |
| Shadow mode yields zero unsafe-delete disagreements before enable | `tools/audit-shadow-cleanup.ts` |
| Multi-hour soak completes without leaks or repeated episodes | `tools/lifecycle-soak-report.ts` |

## Suite architecture

### Two tiers

* **Tier 1 — lifecycle tests** (`tests/run-lifecycle-tests.sh`): tmux-free by
  charter. Runs on every PR touching lifecycle-tagged paths as the required
  "Lifecycle Integration Tests" check.
* **Tier 2 — lifecycle certification** (`tests/run-lifecycle-certification.sh`):
  real tmux, real bare-Git remote, real controller + observer. Runs in the
  new `lifecycle-certification` CI job on the same path filter.

### Files

| Path | Role |
|---|---|
| `tests/lib/lifecycle-certification-harness.sh` | Sourcing wrapper on `incident-fixture-harness.sh`; adds report emission, flag toggling, restart-equivalence state capture, and named fault points |
| `tests/lib/lifecycle-invariants.sh` | Per-invariant assertion library |
| `tests/lifecycle-certification.test.sh` | Scenario × flag matrix driver |
| `tests/lifecycle-certification-faults.test.sh` | Fault + restart-equivalence driver |
| `tests/run-lifecycle-certification.sh` | Runner with `--runs`, `--filter`, `--report-dir`, `--soak-iterations` |
| `tests/fixtures/incidents/*.sh` | Real-git scenario fixtures (squash, merge, rebase, closed, superseded, etc.) |
| `shared/lib/lifecycle-budgets.ts` | Budget verdict logic |
| `shared/lib/lifecycle-soak.ts` | Soak-gate verdict logic |
| `shared/lib/shadow-cleanup-ledger.ts` | Append-only shadow decision store |
| `shared/lib/shadow-cleanup-audit.ts` | Ledger cross-check (safe/unsafe deletions) |
| `tools/check-lifecycle-budgets.ts` | CLI: fails CI on budget breach |
| `tools/audit-shadow-cleanup.ts` | CLI: operator audit before flipping to enforce |
| `tools/lifecycle-soak-report.ts` | CLI: soak-gate verdict against a live state dir |

### Local usage

```bash
# Full local matrix, packet validation setting (two runs)
bash tests/run-lifecycle-certification.sh --runs 2

# Only the fault suite
bash tests/lifecycle-certification-faults.test.sh

# Focus on one scenario (regex on scenario id)
bash tests/run-lifecycle-certification.sh --filter squash

# Local mini-soak (matrix loop)
bash tests/run-lifecycle-certification.sh --soak-iterations 10

# Budget check against generated report
npx tsx tools/check-lifecycle-budgets.ts --report /tmp/wavemill-cert-report/certification-report.json
```

The runner honors `WAVEMILL_CERT_TIMING_TOLERANCE_MULTIPLIER` (default 1.0)
for local runs on slower hardware.

## Staged rollout — flag inventory

Four independently-reversible flags gate the rollout. Each has an env
kill-switch that overrides its config counterpart.

| Flag | Config key | Env kill-switch | Default | Effect when disabled |
|---|---|---|---|---|
| Pane release | `terminal.paneRelease.enabled` | `WAVEMILL_TERMINAL_PANE_RELEASE=0` | true | Pane stays open; truthful state / archive / terminal record still written |
| Startup terminal preflight | `startup.terminalPreflight.enabled` | `WAVEMILL_STARTUP_TERMINAL_PREFLIGHT=0` | true | Legacy: rehydrate instead of reconcile at startup |
| Cleanup episodes | `cleanup.episodes.enabled` | `WAVEMILL_CLEANUP_EPISODES_ENABLED=0` | true | Bounded-retry cleanup episodes disabled |
| PR-aware deletion | `cleanup.prAwareCleanup.enabled` | `WAVEMILL_PR_AWARE_CLEANUP=0` | true | `safe_terminal_pr_head` authority skipped; falls back to retention with evidence |
| **Branch deletion mode** | `cleanup.branchDeletion.mode` | `WAVEMILL_BRANCH_DELETION_MODE` | **shadow** | See below |

### Branch deletion mode

`cleanup.branchDeletion.mode` gates the destructive git mutation itself:

* `off` — never delete, never write ledger; the classification / evidence
  path still runs, but no `wouldDelete=true` entries land in the ledger.
* `shadow` (**default during rollout**) — classify + record decision + append
  shadow-ledger entry as if a delete would happen; skip the git mutation.
  The published outcome is `retained_shadow_mode`, which callers treat as a
  retention-by-policy (episode records + operator surfacing keep working).
* `enforce` — full behavior including destructive git mutations, gated
  behind the same authority record and TOCTOU re-check as before HOK-2957.

The mode is applied at the classification → mutation boundary inside
`safe_remove_task_worktree_and_branch` and also inside
`cleanup_remote_task_branch`, `tend-controller.ts`, and the stale-task
pruner in `wavemill-mill.sh`. Non-funnel deletion sites emit a
`safe_remote_delete` / `safe_stale_prune` ledger entry so the audit tool
sees them.

## Rollout order

1. **Deploy this PR** — production defaults to `mode=shadow`. All existing
   flags remain at their previous defaults, so the only behavior change is
   that task-branch deletions stop happening in production and are recorded
   in `.wavemill/shadow/cleanup-decisions.jsonl` instead.
2. **Run one full workload wave** with deletion disabled (mode=shadow).
   The wave should include at least: a squash merge, a merge-commit merge,
   a rebase merge, a closed-unmerged PR, a challenge supersession.
3. **Audit the ledger**:
   ```bash
   npx tsx tools/audit-shadow-cleanup.ts --json
   npx tsx tools/audit-shadow-cleanup.ts --fail-on-disagreement
   ```
   Every `wouldDelete=true` entry must classify as one of the safe forms
   (`safe_ancestor`, `safe_exact_remote`, `safe_terminal_pr_head`,
   `safe_noop`) with matching evidence. Any disagreement is a bug — do NOT
   flip to enforce until the disagreement is fixed or explained.
4. **Enable pane release first** (already enabled by default; verify it
   still works via a smoke tick).
5. **Enable branch deletion** by setting `cleanup.branchDeletion.mode` to
   `enforce` in `.wavemill-config.json` (or export
   `WAVEMILL_BRANCH_DELETION_MODE=enforce` for a targeted host). The env
   var wins — use it for canary hosts.
6. **Complete the soak gate**:
   ```bash
   npx tsx tools/lifecycle-soak-report.ts --json > soak-report.json
   ```
   Pass criteria are encoded in `SoakReport.pass`:
   - monitor p95 iteration < `pollSeconds`·1000 ms
   - zero repeated cleanup episodes above `--max-attempts` (default 3)
   - zero terminal exhaustion outcomes
   - zero preserved-branch markers (i.e. no retained work)
   - zero shadow-ledger disagreements

## Rollback

Rollback is per-flag, reversible independently, and preserves all evidence:

1. **Disable branch deletion first**: set
   `WAVEMILL_BRANCH_DELETION_MODE=shadow` (fast) or update
   `cleanup.branchDeletion.mode` to `shadow` (durable). Ongoing tasks retain
   their branches; retained work stays retained; the ledger keeps recording
   the decisions the enforce path would have taken.
2. **If PR-aware authority is the culprit**: set
   `WAVEMILL_PR_AWARE_CLEANUP=0` or `cleanup.prAwareCleanup.enabled=false`.
   Branches with only PR-headRefOid authority are retained; ancestry-based
   authority still works.
3. **If pane release is the culprit**: set
   `WAVEMILL_TERMINAL_PANE_RELEASE=0`. Panes stay open; every other lifecycle
   step still runs. Diagnose from the terminal record.
4. **If startup preflight is misbehaving**: set
   `WAVEMILL_STARTUP_TERMINAL_PREFLIGHT=0`. Legacy behavior returns; use
   only as an escape hatch — the preflight is the only reconciliation gate
   at cold-start.

Each flag is orthogonal to the others; nothing about rollback deletes,
overwrites, or masks the decision ledger, terminal records, cleanup
episodes, or preserved-branch markers.

## Incident response

* **Retained work** (`retain_dirty`, `retain_unpublished`, `retain_unverifiable`):
  see `.wavemill/incidents/preserved-branches/<slug>.json`. The
  `operatorGuidance` field describes the recovery. Do NOT delete the
  preserved branch manually until you have confirmed delivery on the
  authoritative source (merged PR, ancestry into base, or explicit
  abandon).
* **Verification failure** during deletion (mode=enforce): the terminal
  record's `recovery.howToRecover` field names the recovery steps. Log
  line is prefixed `PRESERVED_UNPUSHED_WORK` or `PRESERVED_DIRTY_WORKTREE`.
* **Shadow-ledger disagreement**: the entry is the audit trail. Reproduce
  locally by seeding the same scenario in
  `tests/fixtures/incidents/` and running the certification test.
* **Soak-gate failure**: read
  `tools/lifecycle-soak-report.ts --repo-dir <dir>` output. The `failures`
  array lists specific breaches (p95, repeated episodes, retained work,
  ledger disagreements). Each has its own runbook line above.
