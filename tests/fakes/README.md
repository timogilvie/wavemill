# Shared external-edge fakes (HOK-3226)

One fake per external edge, shared by every test that needs it, instead of a
per-test stub that encodes one author's belief about how GitHub or Linear
behaves. The fakes are themselves tested against recordings of the real
services (`fakes-contract.test.sh`).

| Edge | Fake | How it hooks in |
|------|------|-----------------|
| GitHub CLI | `gh.mjs` (via `bin/gh`) | PATH. Stateful JSON (`$FAKE_GH_STATE`) backed by a real bare origin (`$FAKE_GH_ORIGIN`): PR heads follow real pushes, `pr merge` writes a real squash/merge commit, conflicts are real. |
| Linear | `linear-fetch-preload.mjs` | `NODE_OPTIONS=--import=…` replaces `fetch` for `api.linear.app/graphql`, so the real Linear tools run unmodified. Refuses every other non-loopback fetch. |
| tmux | `bin/tmux` | PATH. The real tmux binary on a private socket (`$FAKE_TMUX_SOCK`). |
| Agent CLI | `bin/claude` | PATH. Runs inside the mill's agent panes and performs each phase's real contract (task packet + plan.md; commit + `.coding-complete`; push + `gh pr create` + review artifacts). |

## Using them

```bash
source tests/fakes/lib.sh
fakes_setup "$TMP/world"               # repo, origin, state files, PATH, HOME, NODE_OPTIONS
fakes_linear_add_issue ABC-1 "Title" Todo
fakes_repo_commit main path.txt "content" "message"   # another contributor's push
fakes_gh_state '.checks.byPr["1"] = [{name:"ci",conclusion:"FAILURE"}]'
...
fakes_teardown
```

`fakes_setup` isolates `HOME`, git config and the network; nothing touches the
developer's own tmux, gh auth or Linear workspace.

## World lifetime (HOK-3329)

Every `fakes_setup` records its world in `/tmp/wmfake-worlds/<id>.json`, keyed
by the owner shell's pid and `ps -o lstart=` start time. One function,
`fakes_teardown_world`, kills the world's registered process groups, stops its
private tmux server and removes the socket, world dir and record. It runs from:

- the owner's EXIT trap (`fakes_teardown`);
- the owner watcher (`world-watcher.sh`), the first window of the server that
  `fakes_start_world_host` starts — it tears the world down within seconds of
  the owner dying untrapped (SIGKILL, subagent end, parent-tree kill);
- `fakes_reap_stale_worlds`, at the start of every `fakes_setup` and
  `run-journeys.sh`, for worlds whose watcher died too.

Start long-lived world processes with `fakes_spawn <cmd>` (own process group,
registered in the record; pid in `FAKES_LAST_SPAWN_PID`). The real tmux binary
comes from `term_resolve_real_tmux` (`shared/lib/terminal-backend.sh`), which
skips both Wavemill tmux wrappers. `tools/check-test-world-lifetime.ts` fails
on private `tmux new-session` / `kill-server`, `set -m` launches, `sleep 86400`
placeholders and private tmux resolution.

## Scripting behaviour and faults

gh state file (`$FAKE_GH_STATE`):

| Key | Effect |
|-----|--------|
| `checks.default` / `checks.byPr[n]` / `prs[n].checks` | Check runs, e.g. `[{name:"ci",conclusion:"PENDING"}]`. Drives `pr checks` (exit 8 pending / 1 failed), `statusCheckRollup`, `mergeStateStatus`. |
| `checks.integration` | Check runs reported for integration-branch commits (`commits/<sha>/check-runs`). |
| `requiredChecks` | Branch protection: `pr merge` refuses until these are green. |
| `headLag[n]` | After PR n's head moves, the next N reads still report the old head (GitHub read-after-write lag). |
| `faults` | `[{cmd:"pr view", remaining:1, exit:1, stderr:"HTTP 502"}]` — fail the next matching calls. |
| `strictBehind` | Report `BEHIND` when the base is not an ancestor of the head. |
| `prs[n].overrides` | Force `mergeable` / `mergeStateStatus`. Without one, a PR whose head does not merge cleanly into its base (real `git merge-tree`) reads `CONFLICTING` / `DIRTY`. |
| `prs[n].history` | Written by the fake: ordered `{at, event: labeled\|unlabeled\|merged, label?}` entries, for asserting label/merge ordering. |

Agent: put a bash snippet at `$FAKE_AGENT_SCRIPT_DIR/<phase>` (planning, coding,
review) to replace that phase's default behaviour — e.g. exit with a dirty
tree, never write `.coding-complete`, report review blockers.

## Unmodelled calls are failures, not silence

Anything the fakes do not model is appended to `$FAKE_GH_UNHANDLED`,
`$FAKE_LINEAR_UNHANDLED` or `$FAKE_AGENT_UNHANDLED` and fails. Tests should
assert these stay empty (`journey_assert_no_unhandled_fake_calls`), so new
production calls to an external edge are noticed and modelled deliberately.

When production starts reading a new gh field, re-record the shapes in
`recordings/` (see its README) and extend `gh.mjs` until the contract test passes.
