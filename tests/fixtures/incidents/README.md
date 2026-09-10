# Incident regression fixtures (HOK-2950)

Cross-component regression fixtures that reproduce the 2026-09-05 terminal
resource leak / repeated-cleanup incident, and the safety controls that must
keep holding once it is fixed. See the incident writeup on
[HOK-2950](https://linear.app/hokusai/issue/HOK-2950) for full context.

## Why these exist

The focused unit suites (`tests/safe-branch-cleanup.test.sh`,
`tests/completed-task-cleanup.test.sh`, `tests/terminal-reconciler.test.sh`,
`tests/launch-pane-liveness.test.sh`, `tools/observer.test.ts`) each exercise
one helper in isolation with stubbed git/tmux. The incident was a
**disagreement between components** operating on the same real inputs
(workflow state, git ancestry, PR evidence, tmux pane ownership, Observer
classification) - stubbing any one of those away hides the exact
disagreement these fixtures need to reproduce. So these fixtures build a
**real** bare git remote, a **real** isolated tmux server, and drive the
**real** `monitor_issue_state` controller (extracted live from
`shared/lib/wavemill-monitor.sh`) plus the real `tools/observer.ts`. The only
shimmed surface is `gh pr view` (pre-recorded JSON, no network) and `npx`
(forwarded only for `tools/observer.ts --dry-run`).

## Files

```
tests/lib/incident-fixture-harness.sh              # shared setup/teardown/assertions
tests/incident-fixtures-terminal-panes.test.sh     # 3 incident topologies (must FAIL pre-fix)
tests/incident-fixtures-safety-controls.test.sh    # 5 safety controls (must PASS always)
tests/fixtures/incidents/
  hok2595_closed_non_challenge.sh                  # closed non-challenge PR, retained pane
  hok2913c_superseded_challenger.sh                # challenger superseded by merged primary
  squash_delivery_deleted_remote_head.sh           # squash-merged PR, deleted remote head
  control_dirty_worktree.sh                        # dirty worktree must be preserved
  control_local_head_changed.sh                    # local head races the verification window
  control_divergent_local_ahead.sh                 # local ahead of what was actually pushed
  control_missing_network.sh                       # origin remote unreachable
  control_never_pushed.sh                          # branch never pushed to origin
  merge_commit_delivery.sh                         # HOK-2957: merge-commit merged PR
  rebase_delivery.sh                               # HOK-2957: rebase-merged PR (rewritten SHAs)
```

The HOK-2957 fixtures (`merge_commit_delivery.sh`, `rebase_delivery.sh`)
extend the same harness; they are consumed by
`tests/lifecycle-certification.test.sh` and documented in
`docs/lifecycle-certification.md`.

## Local invocation

Run everything:

```bash
bash tests/incident-fixtures-terminal-panes.test.sh
bash tests/incident-fixtures-safety-controls.test.sh
```

Run a single scenario during development by commenting out the others in the
driver, or add `set -x` around a specific `incident_scenario_new` block. Every
scenario builds its own `mktemp -d` workspace (bare origin + clone +
worktrees + an isolated tmux socket at `$SCENARIO_DIR/tmux.sock`), so
scenarios never interfere with each other or with a real `wavemill` tmux
session.

Both drivers are idempotent and leak nothing on success - the EXIT trap in
`incident-fixture-harness.sh` always kills the isolated tmux server and
removes the scenario's temp directory. Run either driver twice in a row to
confirm no state leaks between runs:

```bash
bash tests/incident-fixtures-terminal-panes.test.sh && bash tests/incident-fixtures-terminal-panes.test.sh
```

If `tmux` is unavailable or cannot start an isolated server, tmux-dependent
scenarios print `SKIP: tmux unavailable` and exit 0 rather than failing.

### CI invocation

Both driver files are registered in `tests/run-shell-suite.sh`'s `TESTS`
array and run automatically as part of the sharded shell suite (`bash
tests/run-shell-suite.sh` or a specific `--shard`). All fixture and harness
files are also registered in the `bash -n` syntax-check list in
`tests/check-shell.sh`.

### Diagnostics on failure

If a scenario fails (non-zero exit from the driver), the harness's EXIT trap
copies the scenario's temp directory - workflow-state.json, git-remote-calls
log, gh-calls log, mill log, tick stderr - into a tarball before cleaning up:

```
/tmp/wavemill-hok2950-<scenario-name>-<epoch>.tar.gz
```

Un-tar it and inspect `repo/.wavemill/workflow-state.json`,
`git-remote-calls.log`, and `tick-stderr.log` to see exactly what the real
controller code did.

### Timing budgets

Per-tick iteration time is asserted with a CI-tolerance multiplier so slow
shared runners don't flake:

```bash
WAVEMILL_INCIDENT_FIXTURE_TIMING_TOLERANCE_MULTIPLIER=3 bash tests/incident-fixtures-terminal-panes.test.sh
```

Defaults (multiplier 1): first tick (cold git/tmux/gh calls) budget is 10s;
second tick (everything already resolved, nothing new to do) budget is 1s.

## Adding a new fixture

1. Create `tests/fixtures/incidents/<name>.sh` with a single
   `incident_setup_<name>` function that builds the git/tmux/PR/workflow-state
   topology using the harness helpers (`incident_seed_task`, `record_pr`,
   `incident_scenario_add_task_window`, `incident_write_hook`, ...). See any
   existing fixture for the pattern - real `git`/`git worktree`/`git push`
   commands against the scenario's bare `$ORIGIN_DIR`, never stubs.
2. Source it from the relevant driver
   (`incident-fixtures-terminal-panes.test.sh` for a new incident reproduction,
   `incident-fixtures-safety-controls.test.sh` for a new safety guard) and
   drive it with `run_monitor_tick <issue> <slug> [pr]`, `run_observer_pass`,
   and the `assert_*` / `expect_*` helpers in the harness or driver.
3. Register the new fixture file in the `bash -n` list in
   `tests/check-shell.sh` (see the "Syntax Check" section).
4. Run the driver twice consecutively to confirm the new scenario doesn't
   leak state or tmux windows into the next run.

## What each incident fixture reproduces

- **`hok2595_closed_non_challenge.sh`** - `should_cleanup_closed_pr()` only
  recognizes a challenger role; a regular task with a closed, unmerged PR
  falls through the `else` branch (`CLEANED[$issue]=1`, nothing else).
  Separately, `wavemill_reconcile_terminal` DOES mark workflow-state
  phase/status "closed" for this reason (`pr_closed_unmerged`) - but never
  removes the tmux window or worktree. The two disagree: state says
  terminal, resources are still live. `tools/observer.ts`'s
  `terminal-task-parked-*` detector is the one that catches this (not the
  non-terminal `stale-active-task-*` detectors, which skip any task whose
  status is already terminal).
- **`hok2913c_superseded_challenger.sh`** - a challenger missing
  `challengeRole` (the exact field HOK-2926 targeted) is recognized as "a
  challenge task" by `is_challenge_task()` (which reads `.challenge`) but
  NOT by `should_cleanup_closed_pr()` (which reads `.challengeRole`).
  Neither the terminal reconciler nor `cleanup_completed_task` ever runs -
  strictly worse than the hok2595 case, since workflow-state itself never
  updates either.
- **`squash_delivery_deleted_remote_head.sh`** -
  `safe_remove_task_worktree_and_branch`'s `merged_to_base` check relies
  solely on `git merge-base --is-ancestor`, which is never true for a
  squash-merged branch even when the PR's `headRefOid` proves delivery. This
  writes a `PRESERVED_UNPUSHED_WORK` marker and retries verification on
  every tick - the "thousands of preservation/error messages" from the
  incident.

## What each safety control proves

Every control drives the exact same `monitor_issue_state` ->
`cleanup_merged_primary_challenge_task` -> `cleanup_completed_task` ->
`safe_remove_task_worktree_and_branch` path (workflow-state pre-seeded with
`status: "merged"`), so a "fix" for the incidents above cannot weaken these
without also breaking here:

| Fixture | Guard proven |
|---|---|
| `control_dirty_worktree.sh` | Uncommitted/untracked changes block deletion (`dirty_worktree`) |
| `control_local_head_changed.sh` | A commit landing mid-verification is caught by the final re-verify step (`local_head_changed`) |
| `control_divergent_local_ahead.sh` | A local commit never pushed after the last push is detected (`remote_missing_local_head`) |
| `control_missing_network.sh` | An unreachable origin fails closed rather than assuming safety (`base_fetch_failed:*`) |
| `control_never_pushed.sh` | A branch never pushed at all is never deleted (`remote_missing_local_head`) |

Each control asserts the guard holds across two consecutive ticks: the
branch, worktree, and workflow-state task entry all survive, and the
preservation marker (`.wavemill/incidents/preserved-branches/<branch>.json`)
records the correct `reason` / `verificationReason`.
