# Terminal Lifecycle Certification

Terminal lifecycle certification exists to catch regressions across the full
chain that caused the 2026-09-05 incident: persisted state, startup, pane
ownership, PR transition, Git cleanup, restart, and Observer/status agreement.

## Harness

The certification tests reuse the incident fixture harness and add
`terminal-lifecycle-cert` helpers. Every scenario runs in a `mktemp` sandbox
with a local bare Git remote, an isolated tmux socket, shimmed `gh`/`npx`, and
deterministic teardown. The harness never uses the developer's live tmux
server, task branches, or production remotes.

Run the local certification drivers:

```sh
bash tests/terminal-lifecycle-cert-matrix.test.sh
bash tests/terminal-lifecycle-cert-restart.test.sh
bash tests/terminal-lifecycle-cert-budgets.test.sh
bash tests/terminal-lifecycle-flags.test.sh
```

The matrix covers merge-commit, squash, rebase, merged-PR, and
changed-after-review head delivery shapes. Existing incident fixtures cover
deleted remote heads, missing network, dirty worktrees, unpublished commits,
closed PRs, and challenge supersession.

## Invariants

Certification enforces these invariants:

- Task panes converge to gone after one terminal release pass unless the pane
  policy is `retain`.
- Worktrees are removed only when dirty/unpublished/contradictory evidence is
  absent.
- Branch deletion requires a cleanup-decision marker with authority,
  `safeToDelete=true`, and `finalCheckPassed=true`.
- Shadow mode records would-delete evidence and retains local and remote
  branches.
- Restart split points converge to the same eventual state as uninterrupted
  execution.
- Budget output names latency, pane-convergence, deletion-authority, slot, and
  shadow-delete gates.

Artifacts are written under `.wavemill/terminal-lifecycle-cert/`.

## Flags

Rollback levers are independent:

- `terminal.paneRelease.enabled` and `WAVEMILL_TERMINAL_PANE_RELEASE=0` disable
  pane killing only.
- `startup.terminalPreflight.enabled` and
  `WAVEMILL_STARTUP_TERMINAL_PREFLIGHT=0` disable startup terminal preflight
  only.
- `cleanup.episodes.enabled` and `WAVEMILL_CLEANUP_EPISODES_ENABLED=0` disable
  retry scheduling only.
- `cleanup.branchDeletion.enabled` disables branch deletion authority
  evaluation; `cleanup.branchDeletion.mode` controls `shadow` vs `enforce`.
  The default is `shadow`.

`WAVEMILL_PR_AWARE_CLEANUP=0` remains the PR-aware cleanup kill-switch. It
prevents merged-PR head proof from authorizing cleanup, but it does not affect
pane release or durable cleanup episodes.

## Shadow Rollout

1. Deploy with `cleanup.branchDeletion.mode=shadow`.
2. Run one complete workload wave.
3. Generate an audit report:

```sh
npx tsx tools/terminal-lifecycle-cert-report.ts --repo-dir . --out .wavemill/terminal-lifecycle-cert/reports
```

4. Review sampled shadow decisions. A decision is unsafe if it lacks authority,
   lacks final-head verification, has `safeToDelete` other than `true`, or
   Observer evidence says the work should be retained.
5. Do not enable deletion until the shadow gate reports zero unsafe-delete
   disagreements.

## Staged Enablement

Enable pane release first and confirm pane convergence without git loss. Enable
branch deletion separately by setting:

```json
{
  "cleanup": {
    "branchDeletion": {
      "enabled": true,
      "mode": "enforce"
    }
  }
}
```

After enabling enforce mode, run a soak:

```sh
npx tsx tools/terminal-lifecycle-soak.ts --iterations 2
# operator gate:
npx tsx tools/terminal-lifecycle-soak.ts --duration 4h
```

The soak gate must show no tmux, worktree, branch, or temp-state growth and no
repeated cleanup episodes before `nextRetryAt`.

## Rollback

Rollback branch deletion first:

```json
{ "cleanup": { "branchDeletion": { "enabled": true, "mode": "shadow" } } }
```

Keep pane release enabled unless panes themselves are the incident source.
Shadow rollback preserves task evidence, retained work, and cleanup episode
history. If evidence is contradictory or verification fails, keep git work and
let pane release proceed so retained terminal work does not consume slots.

Recovery starts from the terminal record in
`.wavemill/evals/artifacts/<issue>/terminal-record.json`, then the retained
worktree or branch named in that record.
