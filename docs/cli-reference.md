---
title: CLI Reference
---

This page lists the public Wavemill command surface and how each command fits into the overall workflow.

## Core Workflow

### `wavemill mill`

The default way to run Wavemill. Pulls backlog work, expands thin tasks, routes model selection, launches parallel agents, monitors PRs, and records learning data.

### `wavemill init`

Initializes `.wavemill-config.json` in the current repository and can also create `.wavemill/project-context.md`.

## Supporting Workflow Tools

### `wavemill expand`

Expands backlog issues into implementation-ready task packets. Useful when you want to prepare work ahead of mill mode.

```bash
wavemill expand
wavemill expand HOK-1494
wavemill expand https://linear.app/hokusai/issue/HOK-1494/fix-archived-routing-decision-parsing-for-eval-enrichment HOK-1531
```

### `wavemill plan`

Breaks large initiatives into smaller issues that are easier for `mill` to execute autonomously.

### `wavemill review`

Runs targeted LLM-powered review on a PR or shows review metrics.

### `wavemill ready`

Runs merge-readiness checks for a PR and reports whether it is safe to merge right now. In autonomous integration mode, this is the same policy surface `tend` uses for dependency, migration, risk, and challenge guards.

For direct development use:

```bash
wavemill ready <pr> --repo-dir <repo>
npx tsx tools/ready.ts <pr> --repo-dir <repo>
```

Flags:

- `--repo-dir <path>`: inspect a repository other than the current working directory

### `wavemill abort`

Marks an active mill task as aborted so the mill can clean it up on the next poll cycle.

```bash
wavemill abort HOK-2878
wavemill abort HOK-2878_c --reason "wrong repo"
```

Flags:

- `--reason <text>`: record an operator-facing abort reason
- `--repo-dir <path>`: inspect a repository other than the current working directory
- `--state-file <path>`: override the workflow state file

If the task has no recorded PR, cleanup closes the pane, removes the worktree and local branch, and clears the state entry. If the task has a recorded PR, cleanup closes the pane and clears the state entry while preserving the worktree and local branch.

### `wavemill intervention`

Records and inspects operator recovery artifacts that eval scoring reads even when there is no commit, PR comment, or Claude transcript.

```bash
wavemill intervention record features/my-task --severity major --trigger invalid_artifact --summary "Relaunched after failed coding attempt"
wavemill intervention record HOK-537_c --stage coding --attempt 1 --severity major --trigger native_coding_failed_invalid_artifact --summary "Triaged failing suite" --archive-failed-result
wavemill intervention show HOK-537_c --json
```

Important flags:

- `--severity minor|major`, `--trigger`, and `--summary` are required for `record`.
- `--action "<text>"` can be repeated.
- `--scoring-note` gives the eval judge incident-specific scoring guidance.
- `--archive-failed-result` preserves the current failed or aborted stage result as a failed-attempt sidecar.
- `--replace` overwrites the artifact instead of appending.

## Autonomous Integration

### `wavemill tend`

Runs one pass or a continuous loop over PRs targeting the integration branch.

```bash
wavemill tend --once --repo-dir <repo>
wavemill tend --loop --repo-dir <repo>
wavemill tend --once --dry-run --repo-dir <repo>
```

Flags:

- `--once`: run a single controller pass and exit
- `--loop`: run continuously inside the mill tmux session
- `--dry-run`: print queue status without mutating labels, branches, or PRs
- `--repo-dir <path>`: repository directory to inspect

Subcommands:

- `promote`: open or refresh the promotion PR from the integration branch to the promotion branch

### `wavemill observer`

Inspects currently running mill tmux sessions and reports Wavemill infrastructure problems before they silently block progress. It reads tmux panes, process trees, `.wavemill/workflow-state.json`, and recent mill logs.

```bash
wavemill observer --once
wavemill observer --loop --interval 120
wavemill observer --json
wavemill observer --file-linear --linear-team HOK
```

Flags:

- `--once`: run one observation pass and exit
- `--loop`: continue watching active sessions
- `--interval <seconds>`: delay between loop iterations
- `--json`: emit structured snapshots for a supervising Codex session
- `--repo-dir <path>` / `--session <name>`: scope observation to one active mill repository/session
- `--file-linear`: create Linear issues for high-confidence urgent/high findings using `LINEAR_API_KEY` from `.env` or the environment
- `--file-incidents`: sync canonical incident records to Linear according to the effective `observer.linear.mode`
- `--incidents-dry-run`: legacy alias for `--incidents-mode=offline` (zero-network preview)
- `--incidents-shadow`: shadow-audit mode. Performs bounded Linear reads for correlation, resolves every eligible incident to create/update_comment/no_op/skip_recovered/failed, persists a redacted audit JSONL, and enforces zero mutations
- `--incidents-mode <off|offline|shadow|live>`: explicit mode. Overrides legacy dry-run/enabled flags. `live` still requires `observer.linear.enabled=true` in config
- `--dry-run`: report what would be found without creating Linear issues
- `--print-prompt`: print the recommended long-running Codex supervisor prompt

When launched as the Backstage service, Observer runs in detection-only mode
with `WAVEMILL_OBSERVER_SERVICE=1`, `--json`, and `--dry-run`; Linear filing is
rejected in that mode.

#### Incident sync modes

The four `observer.linear` modes are:

| Mode | Linear reads | Linear writes | Per-pass cap | Persists audit |
|------|--------------|---------------|--------------|----------------|
| `off` | never | never | n/a | no |
| `offline` | never (unknown_needs_lookup allowed) | never | bypassed | no |
| `shadow` | bounded correlation reads | **blocked** at runtime | enforced | JSONL + counters |
| `live` | as needed | yes | enforced | no |

Legacy `enabled`/`detectionOnly` map onto `off`/`offline`/`live` for backward
compatibility; explicit `mode` on the config overrides both. `shadow` is the
only mode where operators can inspect the exact rendered title, body, and
comment before enabling live filing.

#### Shadow trial procedure

To promote shadow → live, run at least one week of `--incidents-shadow` loops
(or a comparable volume of eligible incidents) with the operator inspecting
`.wavemill/observer/shadow-audit.jsonl` and the aggregate counters in
`.wavemill/observer/shadow-counters.json`. Suggested go/no-go thresholds:

- `mutationAttempts` must be `0` for the entire trial.
- `redactionFailures` must be `0`.
- `correlationCollisions` must be `0` (or, if non-zero, every collision must
  have a documented resolution).
- No incident with reconciliation `recovered` or `superseded` may appear in
  the audit with an `action` of `create` or `update_comment`.
- Every eligible incident must resolve to a deterministic decision — the
  audit must contain zero `unknown_needs_lookup` entries.
- The duplicate-proposal rate (identical `plannedTitle`+`fingerprint` for
  incidents that already have a live linked issue) should be indistinguishable
  from expected update cadence.
- Retention holds: audit file size stays bounded across restarts and the
  counters file continues from the previous total instead of resetting.

If any gate fails, set `observer.linear.mode` back to `offline` (or `off`) and
revert the shadow-planner commit; no Linear mutations were made so there is
nothing to reverse.

The observer itself is conservative: it detects and reports stuck states, warnings, crashes, and visual pane/display issues. A supervising Codex session should decide whether to apply a narrow operational nudge, file a Linear issue, or make a Wavemill PR targeting `auto/integration`.

Incident lifecycle: the observer's incident store counts **distinct source
events** (a re-polled terminal job or unchanged marker never inflates
`occurrenceCount`), stamps `firstObservedAt` on creation, and constrains
`rootCauseClass` to a bounded taxonomy. After each fully successful detection
cycle, incidents not re-observed for `incident.detection.resolutionAfterCycles`
consecutive cycles (default 5, configurable in `.wavemill-config.json`)
auto-transition to `resolved`. A new distinct event for a resolved or archived
fingerprint reopens the record with recurrence metadata, so an archived
incident that recurs is distinguishable from one that never did.

### `npx tsx tools/incidents.ts`

Operator surface for the incident store — no more hand-editing
`.wavemill/incidents/index.json`.

```bash
npx tsx tools/incidents.ts list --repo-dir <repo>          # observed/active
npx tsx tools/incidents.ts list --all --json               # every lifecycle
npx tsx tools/incidents.ts resolve <fingerprint> --reason "fixed by HOK-1234"
npx tsx tools/incidents.ts archive <fingerprint> --repo-dir <repo>
```

Flags:

- `--repo-dir <path>`: repository that owns the incident store (default: cwd)
- `--reason <text>`: audit reason recorded with resolve/archive
- `--all`: include resolved/archived records in `list`
- `--json`: structured output

### `wavemill promote`

Direct entry point for promotion mode.

```bash
wavemill promote --repo-dir <repo>
wavemill promote --dry-run --repo-dir <repo>
```

Flags:

- `--dry-run`: print promotion status without mutating GitHub state
- `--repo-dir <path>`: repository directory to inspect

## Routing And Learning

### `wavemill route`

Shows the recommended planner, coder, and reviewer workflow for a task or task file.

### `wavemill eval`

Evaluates completed workflow runs and supports reporting, export, and aggregation.

### `wavemill hokusai`

Manages opt-in submission for collective routing intelligence.

Subcommands:

- `wavemill hokusai status`
- `wavemill hokusai enable`
- `wavemill hokusai disable`

## Project Memory

### `wavemill context`

Manages subsystem documentation that helps agents retain project-specific architectural context.

Subcommands:

- `wavemill context init`
- `wavemill context update <subsystem>`
- `wavemill context check`
- `wavemill context search <query>`

## Utility Commands

### `wavemill version`

Shows the installed Wavemill version.

### `wavemill help`

Shows the built-in help output.

## Choosing The Right Command

- Start with `wavemill init` once per repository.
- Use `wavemill mill` for the default operating model.
- Use `wavemill expand` when task packets need manual preparation.
- Use `wavemill plan` when epics are too large to mill directly.
- Use `wavemill review` or `wavemill eval` when you want targeted inspection.
- Use `wavemill tend` when you need to inspect or drive the `auto/integration` queue.
- Use `wavemill observer` when you want a long-running watchdog over active mill sessions.
- Use `wavemill promote` when you are ready to move `auto/integration` toward `main`.
- Use `wavemill route` or `wavemill hokusai` when you are tuning the learning system.

## See Also

- [Autonomous Integration](autonomous-integration.md) — branch protection, promotion cadence, and rollback guidance
- [Getting Started](getting-started.md) — first-time setup
- [Mill Mode](mill-mode.md) — core workflow
- [Routing & Hokusai](routing-and-hokusai.md) — self-improving routing
