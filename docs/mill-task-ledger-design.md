# Mill task ledger — design (HOK-3152)

**Status:** design · prerequisite for HOK-3153 (reuse-vs-build decision) ·
depends on spike results in HOK-3150 and HOK-3151 for the native-arm engine
question only · the mill-wide ledger recommendation does not depend on the
spike

**Scope.** One design document, no code. It describes a single durable
source of truth for mill task state, replacing the patchwork of
`workflow-state.json`, `/tmp/wavemill-*.hook` files, retry/condition
sentinels, and PR labels with one SQLite-backed ledger. It commits to a
reuse-vs-build recommendation (**pattern-reuse, native build**), a
concurrency model (**multi-writer SQLite WAL behind one `ledger.ts`**),
and a shadow-first migration path starting from the HOK-3172 condition-
keyed markers.

**Non-scope.** No schema is created, no migration shipped, no code
touched. The orchestrator-assigned "ASSIGNED MIGRATION NUMBER: 1" from
the parallel-task guard is a false positive for this design task;
wavemill is TypeScript/shell, no Alembic pipeline, and `.migration-
detected` is intentionally not written. The decision between pi-durable
and a native engine for the native-coding-arm transcript is deferred to
HOK-3153 pending HOK-3150 results; this doc records the design that
holds either way.

Companion documents:

- `docs/pi-durable-evaluation.md` — incident census (85 Bug issues, 44
  in scope), primitive mapping, spike criteria, and the hard constraint
  "pi-durable's storage is single-process-owner".
- `shared/lib/condition-reconciler.sh` (HOK-3172, merged `322ff87c`) —
  the first step of the migration: condition-keyed markers with one
  reconciler. The ledger treats this as the authoritative pattern for
  "state whose validity is a function of its inputs".
- `shared/lib/task-progress.ts` (HOK-3101) — the one liveness primitive.
  The ledger absorbs its three invariants (pane/process ≠ progress,
  monitor writes ≠ agent evidence, agent idle survives monitor writes)
  as construction-level guarantees.
- `shared/lib/bounded-retry.sh` (HOK-2924) — per-bucket counters keyed
  on `(state_dir, bucket, head)`. Becomes a column of the step row.

## 1. Problem recap

### 1a. Today's state surfaces

Six independent surfaces hold slices of what should be one answer per
task. Each has different durability, different writers, and different
rules for who is authoritative:

| Surface | File / shape | Readers | Writers |
|---|---|---|---|
| Workflow state | `.wavemill/workflow-state.json` via `state_mutate` (`shared/lib/wavemill-common.sh`) and `mutateJsonState` (`shared/lib/state-mutex.ts`) | monitor, tend, observer, ready-watchdog, dashboard, every TS tool | same |
| Hook status | `/tmp/wavemill-${SESSION}-${ISSUE}.hook` with 300 s TTL and `writer` + `agentRecord` discipline (HOK-3101) | `wavemill_hook_read`, `task-progress.ts` | agent adapters (`shared/hooks/*.sh`), monitor-side `wavemill_hook_write` |
| Retry sentinels | `.retry-<bucket>-count`, `.retry-<bucket>-head`, `.retry-<bucket>-exhausted` + `.retry-<bucket>-exhausted-condition.json` | gates, reconciler | `bounded_retry_*` helpers |
| Condition-keyed markers | task-dir markers with a sidecar JSON condition; expired by `condition_reconciler.sh` (HOK-3172) | gates (via file existence) | `marker_write`; cleared only by the reconciler |
| Operator events | `.operator-events.jsonl` (`operator_event_record`) | reconciler | operator commands (`re-review`, `advance`) |
| PR labels | `wm:ready`, `wm:blocked`, `wm:merging` | tend, observer, selector | tend, agent, operator |

Three other append-only stores sit alongside these (`.wavemill/registry/`
for resource attribution, `.wavemill/manifests/` for per-run manifests,
`.wavemill/incidents/` for the incident store). They are not state, they
are evidence; the ledger does not replace them.

### 1b. Why the arrangement leaks

Each HOK invariant has patched one disagreement in the pile above:
HOK-2924 (bounded retry), HOK-3101 (liveness), HOK-3102 (session
capabilities), HOK-3125 (reaped-task writes), HOK-3172 (condition-keyed
markers). The pattern is consistent — two surfaces disagree about who
is authoritative, and the fix is a new shared helper that mediates
between them. The cost is accumulated indirection: a reader of mill
state has to understand what each of the six surfaces means, which
helper owns each cross-check, and which combinations are legal. The
incident census in `pi-durable-evaluation.md` §1a sized this: 44 of 85
Bugs in the last 90 days are state-shape incidents the ledger is meant
to prevent (classes O / L / S / R, 52% of Bugs).

### 1c. Design goal

One durable row per task, every other surface either feeds it (hook
files, operator-event jsonl, label observations) or renders it
(`workflow-state.json`, PR labels, the dashboard). The ledger is
authoritative; everything else is derived. Where today a bug fix means
"add a mediator between two surfaces", the ledger-era answer is "add a
column, a constraint, or a check — the surfaces that need to render it
follow".

## 2. Ownership tree

### 2a. Task kinds

Five node kinds, from root to leaf:

- **issue** — one per Linear issue (one `HOK-XXXX` plus arm suffix if
  challenge-paired).
- **arm** — primary and `_c` challenger. Challenge-paired arms share a
  **pair** node (a parent that owns intent and comparison; see §2c).
- **phase** — plan, code, review, ready, eval. Each phase has a lifetime
  spanning its launches.
- **step** — one attempt at a phase (e.g. `review@head=abcd`,
  `review@head=efff`). Steps are keyed on their inputs, not their
  position (§2b).
- **side-effect** — one row per external effect requested from a step
  (git push, PR label, PR merge, Linear transition). See §4.

### 2b. `task` row sketch

```
task(
  id              uuid PRIMARY KEY,
  parent_id       uuid REFERENCES task(id),      -- NULL for issue roots
  kind            TEXT NOT NULL,                 -- 'issue'|'arm'|'phase'|'step'|'side-effect'
  slug            TEXT NOT NULL,                 -- 'HOK-3152', 'HOK-3152#primary', 'review', 'review@abcd'
  state           TEXT NOT NULL,                 -- see §3a
  background      INTEGER NOT NULL DEFAULT 0,    -- 1 means parent is not held open on this
  inputs_hash     TEXT,                          -- hash of the step's declared inputs; see §2b
  replay          TEXT NOT NULL DEFAULT 'unsafe', -- 'safe'|'unsafe'|'atomic'; see §5
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER,                       -- NULL means not bounded
  created_at      TEXT NOT NULL,                 -- ISO 8601, UTC
  settled_at      TEXT,
  settled_as      TEXT,                          -- 'done'|'aborted'|'interrupted'
  settled_reason  TEXT,                          -- short code; see §5
  UNIQUE(parent_id, slug, inputs_hash)
);
```

The `UNIQUE(parent_id, slug, inputs_hash)` constraint is load-bearing.
A phase's launches at the same head and same artifact identity collapse
to one row; a relaunch against a new head is a different row. The
HOK-3165 case ("review-infra exhaustion survives a new commit") is
prevented because the exhaustion row is attached to the old inputs
hash; a new head produces a new row with its own fresh retry budget.

### 2c. Pair as a parent

A challenge pair becomes one `pair` task whose children are the two
`arm` tasks. The pair owns intent (`challengeIntent`), comparison
verdict, and winner. Arms read these via FK, never a local copy. This
rules out PR #1589's drift (per-arm intent copies that disagreed after
evidence was repaired) and HOK-3065 (challenge selection lost across
expansion) because there is nowhere left to drift to — the pair row is
the single owner.

### 2d. Abort runs bottom-up

An arm or phase cannot settle while any child is unsettled. Operator-
abort writes a `pending-abort` state on the target node; the reconciler
walks children first and settles each as `aborted` with a reason. A
parent flips to `aborted` only once all children are settled. This is
the construction-level fix for the "parent waits forever when a child
is lost" family (HOK-3110, HOK-3147, HOK-3005) because the parent
cannot be in a state where no child is in flight and no child is
settled.

### 2e. Writes to settled rows are impossible

The ledger write path rejects any write (state transition, attempt
increment, side-effect insert) whose target row is already in a
terminal `settled_as` state. The TS layer raises `TaskSettledError`;
shell callers get a non-zero exit from `tools/ledger.ts`. This is the
construction-level fix for HOK-3125 (post-merge eval recreates reaped
tasks as stub entries that each consume a slot) — the row cannot be
re-created once settled, and the "stub with no slug / no phase" shape
cannot be written at all.

### 2f. Where the current surfaces land under the ownership tree

| Today's surface | Ledger analogue |
|---|---|
| `workflow-state.json .tasks[issue]` | one `issue` task row + a view derived from its subtree |
| per-arm `challengeIntent` copy | pair task row; arms have no local copy |
| phase slug on the arm entry | `phase` task row under the arm; the slug is `kind='phase',slug='<name>'` |
| `.coding-complete` / phase marker files | step row's `state='done'` plus an attached completion artifact |
| ad-hoc retry sentinels | step row's `attempt`, `max_attempts`, `settled_as='aborted'`, `settled_reason='exhausted:<bucket>'` |
| label observations | `side-effect` task of kind `pr-label` on a step row |

## 3. Explicit task states

### 3a. State machine

A task row is in exactly one state at a time:

```
     ┌─────────┐
     │ pending │
     └────┬────┘
          │ start
          ▼
     ┌─────────┐
 ┌───│ running │────┐
 │   └────┬────┘    │
 │        │ yield   │
 │        ▼         │
 │   ┌─────────┐    │        ┌──────────┐
 │   │ waiting │────┼───────▶│   done   │
 │   └────┬────┘    │        └──────────┘
 │        │                  ┌──────────┐
 │        ▼        ──────────│ aborted  │
 │   ┌────────────┐          └──────────┘
 └──▶│ background │          ┌───────────────┐
     └────────────┘──────────│  interrupted  │
                             └───────────────┘
```

Terminal states — `done`, `aborted`, `interrupted` — are recorded in
`settled_as`, with `settled_reason` carrying a short code (e.g.
`exhausted:ready-infra`, `operator:re-review`, `child-aborted`).
`waiting` and `background` each carry a condition record (what the task
is waiting on, or whether a parent should hold open on it). The
condition for `waiting` is structured, not free text; see §3c.

### 3b. CLI arms are tasks

External Claude Code and Codex arms are modelled as a step of kind
`agent-run` under their phase. The step records the launch contract:
`(model_id, provider, prompt_hash, worktree, base_ref, head_sha,
tool_menu_digest, extensions_digest)`. Hook files feed the step's
evidence, not its state:

- `agent-run` enters `running` when the launch adapter records a
  success; it stays `running` until the hook file reports an agent-
  sourced `idle:Stop` (per the HOK-3101 `agentRecord` discipline, this
  is the agent's own last record, not a later monitor write).
- Agent evidence lands in an `evidence(step_id, source, event, detail,
  recorded_at)` relation. The step's state column reads evidence but is
  not identical to it; a later monitor write cannot flip the state.
- Pane / process liveness is a separate field, `agent_process_live`,
  on the step row. It is **never** read as progress; it is a diagnostic
  only. The HOK-3101 invariant "pane or process existence is never
  progress" becomes a type-level separation: `state` and
  `agent_process_live` are different columns and the state transition
  functions do not read `agent_process_live`.

This resolves the three HOK-3101 invariants by construction:

1. Pane/process ≠ progress — different columns, different write paths.
2. Monitor writes ≠ agent evidence — the `evidence.source` column
   enum (`agent-hook`, `monitor`, `controller`, `operator`) is in the
   schema, and the step's `state` transition only reads agent-sourced
   evidence (HOK-3137, which the current primitive handles via the
   `agentRecord` shim).
3. Agent idle survives monitor writes — the terminal-settled rule from
   §2e; once a step has `settled_as='done'`, no monitor write can
   reopen it.

### 3c. `waiting` conditions

A `waiting` row carries a reference to a `waiting_on` record:

```
waiting_on(
  step_id       uuid REFERENCES task(id),
  trigger       TEXT NOT NULL,     -- 'head'|'operator-event'|'review-artifact'
                                   -- |'review-artifact-substantive'|'ready-artifact'
                                   -- |'remote'|'waiting-on'|'deadline'
  condition     JSON NOT NULL,     -- shape per trigger kind
  recheck_after TEXT,              -- 'deadline' trigger only
  PRIMARY KEY (step_id, trigger)
);
```

The trigger set is exactly the one defined by `condition_reconciler.sh`
(HOK-3172) — `head`, `operator-event`, `review-artifact`,
`review-artifact-substantive`, `ready-artifact`, `remote`, `waiting-on`,
`deadline`. The migration from today's sidecar JSON to this relation is
a drop-in (§8). The reconciler role does not change: one periodic
process (the ledger's `tick`) walks `waiting` rows and promotes them to
`running` when the condition is satisfied.

### 3d. `background` for parent-visibility

A `background=1` step does not keep its parent in `running`. A parent
with only background work in flight settles when its non-background
children settle, independent of the background child's state. This is
the HOK-3137 fix in schema form (an agent waiting on its own
background job is not stalled; the parent is not held open by it). The
step itself still runs to completion and still owns its side effects;
only parent visibility changes.

### 3e. Operator commands as writes

Operator commands (`re-review`, `advance`, `abort`, `promote`,
`force-ready`) are inserts into a dedicated `operator_event` relation
with a monotonically increasing `(task_id, seq)` key. The reconciler
reads them, applies them as state transitions on the target task row,
and marks the event consumed. This is the fix for HOK-3167 and HOK-3168
(the `re-review` wedge): the operator command is a durable write that
transitions the review step row from any terminal state back to
`pending` and marks the previous attempt's row `superseded`. A review
step whose state is `done` cannot leak through an infra marker because
the marker (now a `waiting_on` row) is on the *previous* attempt row,
not the new one. §9 traces this through.

## 4. Idempotent side effects

### 4a. Side-effect table

Every external effect requested by a step is a row:

```
side_effect(
  id               uuid PRIMARY KEY,
  step_id          uuid REFERENCES task(id),
  kind             TEXT NOT NULL,      -- 'git-push'|'pr-label'|'pr-merge'|'linear-transition'
  idempotency_key  TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  applied_at       TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0,
  result           JSON,                -- payload returned by the real call
  error            TEXT,                -- last error on failure
  UNIQUE(kind, idempotency_key)
);
```

The `UNIQUE(kind, idempotency_key)` constraint is enforced by a partial
unique index: `WHERE applied_at IS NOT NULL` for terminal rows, and a
second index on `WHERE applied_at IS NULL` guarded by a conditional
insert. First-write-wins semantics come straight from the constraint.
A replay inserts the row; if the constraint catches a prior successful
row, the replay reads `result` and skips the external call.

### 4b. Idempotency key formulas

| Kind | Formula | Why |
|---|---|---|
| `git-push` | `(remote, ref, oid)` | A push of the same tree to the same ref is a no-op; a push of a different `oid` is a different effect. Tend-rebind races (HOK-3105) are prevented because the race's two writers compute the same key for the same push and the second one no-ops. |
| `pr-label` | `(pr_number, label, action, head_oid)` | A label add + remove loop (HOK-3111) is prevented because each (head, action) pair is a distinct row and the second write of the same (head, action) is a no-op. The HOK-3109 case ("failed Ready leaves `wm:ready`") is a removal keyed to the failed step's head; the removal fires once and sticks. |
| `pr-merge` | `(pr_number, merge_commit_target_oid)` | A duplicate merge attempt against the same target oid no-ops; against a different target oid, it is a different row and must pass policy again. |
| `linear-transition` | `(issue_key, from_state, to_state, trigger_event_id)` | HOK-3004 (closed challenge loser repeats `sibling-merged` transition every poll) is prevented because the trigger event is in the key — one transition per trigger per target. |

The `trigger_event_id` for Linear transitions is the id of the inbound
event that caused the transition (a merge, a label flip, an operator
command). This makes "the same event triggers at most one transition"
a key-level constraint, not a guard.

### 4c. Memo semantics inside a rerunnable step

A step with `replay='safe'` is allowed to re-execute on resume (§5).
Its side-effect calls go through a helper that inserts the
side-effect row first, with `applied_at` null; on success it updates
`applied_at` and `result`. On replay the first insert hits the unique
index and returns the earlier row's `result`; the step then skips the
external call. This is the "memo" primitive from
`pi-durable-evaluation.md` §2 (class S) expressed as a schema
constraint rather than a runtime cache.

### 4d. Observations are not side effects

A read-only observation (polling GitHub for a PR's head, polling CI
for a check, polling Linear for an issue's state) does not get a
side-effect row. It writes to `observation(step_id, kind, observed_at,
value)` which is append-only. The HOK-3171 case (GitHub head lag
turning a point-in-time observation into a permanent refusal) is
prevented because the step's state is `waiting` on the condition "PR
head == recorded head"; the condition is re-evaluated each tick, and a
stale observation does not change the state until the condition is
actually met.

### 4e. What this closes

| Issue | Mechanism in §4 that prevents it |
|---|---|
| HOK-3105 (tend-rebind race) | `git-push` key `(remote, ref, oid)` dedupes the race's two writes |
| HOK-3109 (failed Ready leaves `wm:ready`) | `pr-label` row for the removal fires once and sticks; the step owns it |
| HOK-3111 (promote/demote loop every ~15 min) | `(pr_number, label, action, head_oid)` prevents repeated same-head toggles |
| HOK-3112 (handoff published at stale local HEAD) | `git-push` key includes `oid`; a push against the stale oid no-ops; a push against the new oid is a new row |
| HOK-3115 (Linear writes not routed through task identity) | `linear-transition` key includes `issue_key` and `trigger_event_id`; the writes route through the step row that owns the trigger |
| HOK-3004 (sibling-merged repeated) | `trigger_event_id` in the Linear key — one transition per trigger |
| HOK-2999 (review recovery not transactional) | the step's side effects commit together with the step's transition in one DB transaction (§6) |
| HOK-2765 (notified before delivery confirmed) | notification is a `side-effect` row whose `applied_at` is set by the delivery confirmation, not the attempt |

## 5. Resume semantics

### 5a. `replay` on every step

Every step row declares `replay`:

- `safe` — the step may rerun to completion. Side-effect memos (§4c)
  make any external calls idempotent.
- `unsafe` — the step must not rerun if it was interrupted mid-flight.
  On restart, an unsafe `running` row is settled as `interrupted` and
  the parent sees `interrupted` instead of a re-execution.
- `atomic` — the step's work and its side-effect row commit together.
  Interrupted-but-not-committed is `pending` on restart (never
  partial). This is the sibling of `pi-durable`'s "atomic commits"
  primitive, expressed as a transaction around the step's writes.

The compile-time (TS) type of a step kind includes its `replay`
classification; at construction time a step cannot be created with the
wrong setting for its kind.

### 5b. `bounded-retry` as a property, not a sidecar

The three retry sentinels today — `.retry-<bucket>-count`,
`.retry-<bucket>-head`, `.retry-<bucket>-exhausted` with its
`.retry-<bucket>-exhausted-condition.json` — collapse to columns on the
step row:

| Today | Ledger column |
|---|---|
| `.retry-<bucket>-count` | `attempt` |
| `.retry-<bucket>-head` | the row's `inputs_hash` (which includes the head) |
| `.retry-<bucket>-exhausted` | `state='aborted'`, `settled_reason='exhausted:<bucket>'` |
| `.retry-<bucket>-exhausted-condition.json` | `inputs_hash` + the step row's recorded inputs |

Terminalisation (`bounded_retry_mark_exhausted` today) becomes a direct
transition to `aborted` with reason `exhausted:<bucket>`. A new head
starts a new step row with its own fresh `attempt=0`; the exhausted
row from the previous head is unchanged. HOK-3147 (exhausted
challenger never evaluated; primary waits forever) is prevented
because the pair row's abort walk (§2d) settles the sibling once the
challenger row is terminal, rather than keeping the primary blocked on
a child that cannot progress.

### 5c. Mapping today's sentinel files to row columns

| Sentinel | Row column(s) |
|---|---|
| `.coding-complete` | step row's `state='done'` plus a `completion_artifact` row with `commit`, `confidence`, `notes` |
| `.coding-blocked-completion.json` | step row's `state='waiting'` with a `waiting_on` row of trigger `operator-event` and condition `recommendedAction='advance_to_review'` |
| `.retry-*-exhausted` | §5b above |
| `.workflow-aborted` | an operator-event of kind `abort` on the issue row; the reconciler cascades (§2d) |
| `.recovery-contract-*` | step row's `waiting_on` with condition `kind='recovery-contract',name='<name>'` |
| `.coding-dirty-handoff.*` | side-effect row of kind `git-push` with `applied_at=NULL`; the step is `waiting` on its publish condition |

### 5d. Commit-and-push the worktree is an owned step

Per `pi-durable-evaluation.md` §2 caveat, pi-durable only checkpoints
the transcript, not the worktree. The two largest critical classes in
the incident store — `arm_died_with_unpushed_work` (71) and
`cleanup_unpublished_at_risk` (53) — are only prevented if "publish"
is a durable, owned, idempotent step inside the ledger, independent of
whether pi-durable is adopted. The ledger therefore defines a
`publish` step kind (replay = `atomic`) that commits the worktree and
pushes to the task branch; the push is a `side-effect` row with the
`(remote, ref, oid)` key. An arm's `code` phase cannot settle until
its `publish` step settles — this is the structural fix for both
critical classes.

A parent arm whose process is killed before `publish` reaches `done`
has:

- `code` step `state='running'` and no `publish` child row yet, or
- `publish` step `state='running'` with `applied_at IS NULL`.

On restart (ledger resume), the `code` row's `replay='unsafe'` turns
it into `interrupted`, and the `publish` row's `replay='atomic'` is
either absent (publish never started), in which case the child-aborted
rule walks it, or committed (publish succeeded), in which case the
`applied_at IS NOT NULL` row is the authoritative record. There is no
state where "work exists in the worktree but is unknown to the
ledger" because the publish step row is created before the push is
attempted; the row exists even on crash. Operator recovery reads the
row and either resumes the push or aborts the arm with the recorded
reason.

### 5e. Resume walk

On ledger start-up:

1. Walk tasks whose `state ∈ {running, waiting, background}` from the
   leaves up.
2. For `running` leaves: if `replay='atomic'` and all its
   side-effects' `applied_at` are set, promote to `done`. Else if
   `replay='unsafe'`, settle as `interrupted` with reason
   `restarted-mid-flight`. Else (`replay='safe'`) relaunch.
3. For `waiting` leaves: leave as-is; the reconciler tick will handle
   them.
4. For `background` leaves: same as `running` by kind.
5. Walk parents bottom-up: a non-leaf with no live children and no
   waiting_on settles as `aborted:all-children-settled` unless its
   kind's rule says otherwise.

This replaces today's recovery-prompt path in `launch-coding.ts` and
the `bounded_retry` reset-on-new-head logic with one pass over the
ledger.

## 6. Concurrency

### 6a. Writer-count reality

Live mill writers today:

| Writer | What it writes |
|---|---|
| monitor loop | phase advancement, hook writes (monitor side), reconciler tick |
| tend loop | handoff rebind, label flips, merge-queue state |
| observer loop | observation writes, finding writes, auto-fix state |
| ready-watchdog | ready step retries, label clearing |
| operator commands | `re-review`, `advance`, `abort`, label overrides |
| agent hooks | agent-sourced hook writes |
| shell scripts and TS tools | ad-hoc state updates (`state_mutate` call-sites) |

≥7 live writers. `pi-durable`'s README says *"One process owns a
storage at a time; there is no cross-process locking."* The mill does
not fit that rule; `pi-durable`'s storage cannot be the mill's shared
store without a daemon wrapping it. §7 draws the line.

### 6b. Two options

**(a) Single ledger daemon.** One process owns a SQLite store; every
other writer RPC's in via a Unix domain socket or a tiny HTTP server.
Writes serialise through one event loop. Matches pi-durable's single-
owner rule exactly; lets pi-durable be the engine as-is.

**(b) Multi-writer SQLite WAL.** Writers open the same DB in WAL mode
and use `BEGIN IMMEDIATE` for every transition; unique indexes carry
the key-level constraints (§4b, §4c). All writers go through one TS
module `shared/lib/ledger.ts` that encapsulates the open/close
discipline (`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; …`).

### 6c. Recommendation: option (b)

- Writer count forces it. A daemon in the hot path adds a process to
  the mill's already-crowded supervision tree, a restart-and-recovery
  story (what happens when the daemon crashes mid-transaction, who
  owns the socket, how clients fall back), and a cross-process RPC
  shape for every call site. The whole mill-side migration cost of (a)
  is strictly larger than (b).
- WAL + `BEGIN IMMEDIATE` serialises writers at the DB layer, with
  SQLite's own crash-safety guarantees. The `shared/lib/state-mutex.ts`
  pattern is already the ambient model (one TS module encapsulates the
  mutex); the ledger module is a strictly stronger version of it.
- A daemon can wrap this module later if contention appears. The
  wrapper is cheap; the undo path from a daemon to a module is not.

### 6d. Transition atomicity

A transition that spans a parent-and-children settle, or a step and
its side effect, is wrapped in one `BEGIN IMMEDIATE` ... `COMMIT`. The
constraints below are enforced inside the transaction:

- `UNIQUE(parent_id, slug, inputs_hash)` on `task` — no duplicate
  step for the same inputs.
- `UNIQUE(kind, idempotency_key)` on `side_effect` — no duplicate
  external effect.
- `CHECK(settled_as IN ('done','aborted','interrupted'))` — no
  invalid terminal state.
- `CHECK(parent_state_consistent(parent_id))` — a parent cannot
  settle while a non-background child is unsettled (triggered on
  parent-state updates).

### 6e. Concurrency test protocol

A pre-merge test suite covers the race-prone transitions. Each test
spawns N (≥ 7) concurrent writers hammering the same task row with the
transitions that today create wedges:

- Case A: monitor and tend both race to publish a handoff at the same
  head. Assertion: exactly one `git-push` side-effect row has
  `applied_at` set; the other read it as a no-op.
- Case B: ready-watchdog and tend both race to flip `wm:ready` on
  (removal) a failed Ready. Assertion: exactly one `pr-label` row.
- Case C: operator `re-review` fires while the previous review's
  retry loop is in flight. Assertion: previous attempt's row is
  marked `superseded`; new attempt's row starts fresh with
  `attempt=0`.
- Case D: observer `abort-arm` fires while the code step is in
  `running`. Assertion: the arm settles bottom-up; `code` becomes
  `interrupted` (replay=unsafe), `publish` is absent, arm settles as
  `aborted:operator-abort`.
- Case E: two monitor replicas (one stale, one fresh) attempt a step
  advance. Assertion: `UNIQUE(parent_id, slug, inputs_hash)` catches
  the duplicate; only one row exists.

The suite runs under `tests/run-unit-tests.sh` with a sqlite3-based
fixture; no mill process required. Each case asserts: no row where a
child settled after its parent; no duplicate side-effect application;
no interleaved transition between a transaction's `BEGIN IMMEDIATE`
and `COMMIT`.

### 6f. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `fsync` cost under WAL+SYNCHRONOUS=NORMAL | measure in Phase 1; if the ledger-write throughput is < 50/s under contention, add group commit in `ledger.ts` (coalesce multiple writers' transactions into one WAL fsync) |
| Writer that holds `BEGIN IMMEDIATE` too long starves others | all transitions bounded to a target of ≤ 5 ms wall; a watchdog logs any transaction > 50 ms and raises an alert |
| A rogue shell script bypasses `ledger.ts` and touches the DB directly | the shell CLI (`tools/ledger.ts`) is the only approved shell path; a lint rule (grep guard in CI, see §8) forbids direct `sqlite3` invocations on the ledger file outside `shared/lib/ledger.ts` |
| Backup / corruption | WAL mode supports hot backup; a nightly `VACUUM INTO` snapshot to `.wavemill/ledger-backup-<date>.db` is cheap at expected volumes |

## 7. Reuse vs build

Three distinct uses of `pi-durable` must be answered separately:

| Band | Decision | Reason |
|---|---|---|
| **Pattern** (ownership tree, state machine, `replay:"safe"`, memos, requestId, atomic commits) | **Reuse** | These are the right primitives. The ledger is a direct expression of them; the vocabulary is pi-durable's and the design doc is written in it. |
| **Engine for native coding/review arms** | **Deferred to HOK-3153**, pending HOK-3150 gates 1–6. If adopted, a native arm's transcript lives inside pi-durable; the ledger holds the owning step row and the `publish` side-effect. This is the only reuse that does not fight the single-owner rule — a native arm *is* one process, running one storage. | Pi Durable adds crash-safety and replay-safe tools for the arm's internal loop. The ledger owns everything outside the arm. |
| **Engine for the mill** | **No** | The hard constraint. The mill has ≥ 7 live writers; pi-durable's "one process owns a storage" rule rules this out. Wrapping it in a daemon makes the write path a cross-process RPC and still writes to the same SQLite file; the daemon is strictly more code than a WAL-mode SQLite accessed by one TS module. |

### 7a. What would flip the "no" on the mill engine

- pi-durable adopts multi-writer semantics (cross-process locking,
  WAL-style multi-connection), **or**
- the mill collapses to a single writer (e.g. all tend/observer/ready-
  watchdog work moves into monitor as one event loop). This is a much
  larger refactor than the ledger itself, and would still face
  SQLite's single-writer serialisation.

Neither is on the near horizon. The design does not depend on either.

### 7b. The pattern commitments

The ledger imports these words with the pi-durable meaning:

- **owner** — the parent task; abort runs bottom-up.
- **completing** — a parent that has settled its own work but is still
  waiting for owned children to settle. Encoded here as `state='waiting'`
  with a `waiting_on` row of trigger `waiting-on` and condition
  `children-settled`.
- **background: true** — §3d.
- **requestId** — the step row's `(parent_id, slug, inputs_hash)` key.
- **memos / atomic commits** — §4c, §6d.
- **replay: safe | unsafe | atomic** — §5a.
- **harness.taskGraph()** — the view generated from the task tree.
- **harness.resume()** — §5e.

### 7c. Cross-reference with HOK-3150

If HOK-3150 passes its gates (crash + resume for native arms), the
ledger adopts pi-durable as the native arm's transcript store, with the
ledger's `agent-run` step holding a `pi_durable_task_id` reference. If
HOK-3150 fails or is deferred, the `agent-run` step owns its own
evidence (hook files + session jsonl) as it does today; the ledger
design is unchanged either way.

## 8. Migration path

Shadow-first, highest-incident class first. Each phase lands a slice
alongside the current surfaces, measures a baseline, and only
switches reads once the baseline shows the ledger is correct for the
class.

### 8a. Phase 0 (shipped): condition-keyed markers

HOK-3172 merged `322ff87c`. The ledger treats this as the first slice.
Each marker's sidecar condition JSON is the on-disk form of a
`waiting_on` row; each `expires-on` trigger (`head`, `operator-event`,
`review-artifact`, `review-artifact-substantive`, `ready-artifact`,
`remote`, `waiting-on`, `deadline`) becomes a value of
`waiting_on.trigger`. Migration = re-express markers as ledger rows;
keep the sidecar JSON writer in place as the mirror, so the reconciler
reads from either during the shadow window.

### 8b. Phase 1: side-effect ledger (class S)

New `side_effect` table, written alongside today's labels / pushes /
transitions. One call site at a time flips its idempotency check from
"ad hoc guard" to "insert into `side_effect`; read `applied_at`;
skip-or-apply". Highest-value sites first:

- `shared/lib/wavemill-common.sh` git-push helpers → `(remote, ref, oid)`
- `tools/set-pr-ready-label.ts` → `(pr_number, label, action, head_oid)`
- `shared/lib/linear.js` state transition → `(issue_key, from_state,
  to_state, trigger_event_id)`
- `shared/lib/pr-merge.ts` → `(pr_number, merge_commit_target_oid)`

Shadow weeks: 1. Decision gate: zero duplicate side effects for 7 days
across the production mill. Measures: `operator-intervention.ts`
instrumented to tag class-S interventions; baseline collected the week
before Phase 1 begins.

Closes: HOK-3105, HOK-3109, HOK-3111, HOK-3112, HOK-3115, HOK-3004,
HOK-2999, HOK-2765 (8 of the 9 class-S issues; HOK-3099 is a packet /
plan drift and lands in Phase 3 with ownership).

### 8c. Phase 2: step rows for review / ready / eval (class R + L)

Hook files keep writing; step rows mirror. Each phase step inserts its
row at launch, updates on evidence, and settles on completion. Reads
move once a step row has ≥ 7 days of correct mirror data for every
workflow shape (primary-only, challenge pair, re-review, operator
advance).

Shadow weeks: 2. Decision gate: zero sentinel-vs-row disagreements for
14 days, measured by a periodic consistency check.

Closes: HOK-2924 (bounded retry becomes a column), HOK-3101
(invariants become construction-level), HOK-3137 (background), HOK-3147
(exhausted challenger settles via pair row), HOK-3165 (step keyed to
inputs). Partial on HOK-3169 (malformed review): the step retry
policy covers *retry*; the failure-classifier contract is still
upstream.

### 8d. Phase 3: ownership tree + pair rows (class O)

Pair row added first; arms migrate to FK on next launch. A retrocompat
shim reads intent from either the pair row or the arm's local copy for
one window, with a warning on mismatch. Once no mismatches for 14 days,
the local copy is removed.

Shadow weeks: 2. Decision gate: pair row authoritative for all live
arms, zero intent drift observed for 14 days.

Closes: HOK-3125 (reaped-task writes rejected at the write path),
HOK-3147 (via pair-row abort walk), HOK-3110 (primary never completes
when challenger aborted — pair settles via §2d), HOK-3065 (challenge
selection lost across expansion — pair row holds it), HOK-2965 (PR
discovery not bound to launch lineage — step row's launch contract),
HOK-2537 (closed PR held as merge candidate — ownership through the
step row), HOK-3005 (completed rows recreated — write path rejects it),
HOK-3003 (selector deadlocks on parent with terminal children — abort
walk), HOK-3068, HOK-3067, HOK-2934, HOK-2911 (orphan arms — the row
cannot be orphaned because `parent_id` is NOT NULL for non-root kinds
and the FK is enforced).

### 8e. Phase 4: remove old surfaces

- `workflow-state.json` becomes a **render view** generated from the
  ledger on each `state_mutate` boundary; the file is kept as a
  compatibility read-surface for one more window, with writes going to
  the ledger exclusively.
- Sentinel files (`.retry-*`, `.coding-complete`, `.workflow-aborted`)
  are removed; the step row's state and settled_reason replace them.
  The `.coding-complete` *marker contract* (JSON with `stage`,
  `confidence`, optional `commit`, `notes`) is preserved as the
  schema of the step row's `completion_artifact`, so coding-phase
  agents continue to write a marker file as evidence; the ledger reads
  it and transitions. In Phase 4+, the agent writes to the ledger
  directly via the shell CLI.
- Hook files remain, downgraded to evidence feeders (`writer='agent'`
  events land in the `evidence` relation).
- PR labels remain as the external render for GitHub consumers (tend,
  the merge queue). The ledger owns the label state; tend reads the
  ledger and reconciles labels.

Decision gate: 14 days green on all reads from the ledger with the
compatibility shim quiescent.

### 8f. Per-class operator-intervention metric

Before each phase: instrument `shared/lib/operator-intervention.ts` to
count interventions by O / L / S / R class (today it already captures
some; this adds the class tag). Migration policy: a phase does not
flip reads until its class's intervention count has fallen by ≥ 70%
relative to the pre-phase baseline over the shadow window.

### 8g. Shell access

A small CLI, `tools/ledger.ts`, with subcommands:

- `list [--parent <id>] [--kind <kind>] [--state <state>]`
- `inspect <id>` — print the row + its waiting_on, evidence, side_effects
- `transition <id> <new-state> [--reason <code>]` — a `BEGIN IMMEDIATE`
  transition
- `settle <id> --as <done|aborted|interrupted> [--reason <code>]`
- `side-effect record --step <id> --kind <k> --key <idempotency_key>
  [--apply] [--result <json>]`
- `event <kind> --task <id> [--payload <json>]` — operator event
- `resume` — run the §5e walk; prints a summary of what moved
- `view workflow-state` — render the compat JSON

All shell scripts call the CLI; a grep guard in CI (`tests/check-direct-
ledger-access.test.sh`) forbids any direct `sqlite3` invocation on the
ledger file outside `shared/lib/ledger.ts`.

### 8h. Phase table

| Phase | Class(es) | Issues it closes | Shadow weeks | Decision gate |
|---|---|---|---|---|
| 0 (shipped) | marker reconciler | HOK-3167, 3168, 3171, 3172 | n/a | HOK-3172 merged `322ff87c` |
| 1 side-effect ledger | S (11 %, 9 issues) | HOK-3004, 3105, 3109, 3111, 3112, 3115, 2765, 2999 | 1 wk | zero duplicate side-effects for 7 d |
| 2 step rows | R (19 %, 16) + L (8 %, 7) | HOK-2924, 2923, 2921, 3142, 2920, 3000, 3146, 3019, 2915, 3128, 2964, 2761, 2771, 2898, 3106, 2919 (R); HOK-3101, 3137, 3095, 3087, 3032, 2962, 2757 (L) | 2 wk | zero sentinel-vs-row disagreements for 14 d |
| 3 ownership tree | O (14 %, 12) | HOK-3003, 3005, 3065, 3067, 3068, 3110, 3125, 3147, 2537, 2911, 2934, 2965 | 2 wk | pair row authoritative for all live arms, zero drift 14 d |
| 4 remove old surfaces | — | — | 2 wk | 14 d green on ledger reads |

## 9. Acceptance-case coverage

### 9a. Task packet's live-incidents table

Each row from the task packet, answered against the design above:

| Case | Verdict | Prevented by | Lands in phase |
|---|---|---|---|
| `re-review` leaves `status=error`; passing review cannot advance (HOK-3167) | **Prevented** | §3e operator-command transitions settle the previous attempt's row and start a fresh step row | Phase 2 |
| Same-head infra markers survive a substantive verdict (HOK-3168) | **Prevented** | §2b inputs-hash: a markup on the old row cannot leak to the new row; §3e supersede | Phase 2 (sites are already covered by Phase 0 markers) |
| Review-infra exhaustion survives a new commit (HOK-3165) | **Prevented** | §2b inputs-hash: new head → new step row with its own fresh `attempt=0`; the exhausted row from the old head is unchanged | Phase 2 |
| `re-review` unreachable from the mill pane (HOK-3165) | **Prevented** | §3e commands are writes to the operator-event relation, not tmux picker text | Phase 1 (CLI `event` subcommand, §8g) |
| GitHub head lag turns observation into permanent refusal (HOK-3171) | **Prevented** | §4d observations are append-only and don't flip state; §3c `waiting_on` keeps the step in `waiting` until the condition is actually met | Phase 2 |
| Comparison stuck `manual_comparison_needed` after evidence repaired; per-arm intent copies drift (PR #1589) | **Prevented** | §2c pair task owns intent and comparison; arms hold FK, not local copies | Phase 3 |
| Malformed review treated as terminal (HOK-3169) | **Partly** | §5a step retry policy covers retry; the failure classifier is upstream (not in this doc) | Phase 2 (retry policy); classifier is a follow-up |
| Review diffs against stale local base (HOK-3166) | **Prevented** | §3b launch contract on the step row records `base_ref` and `head_sha` at launch; the review step pins its inputs to the recorded contract. **The design commits to this** (see §10 open question #1); a relaunch against a new head is a new step row, not a mutation. | Phase 2 |
| Watchdog misclassifies deterministic CI failure (HOK-3170) | **Not covered** | The watchdog's classifier is upstream of the ledger. The ledger would record whatever the classifier produces; it does not improve classification. | Named as a classifier follow-up (not in this doc). |
| Claude session-path truncation loses executed-model evidence (PR #1588) | **Not covered** | Evidence collection is upstream of the ledger. The ledger records `evidence` rows; it cannot invent evidence that the agent-side collector lost. | Named as an evidence-collection follow-up (not in this doc). |

Target 7 prevented / 1 partly / 2 not covered — **met** (7 / 1 / 2).

### 9b. Coverage against `pi-durable-evaluation.md` §1a

44 in-scope issues; the ledger must prevent ≥ 80 % (≥ 36). Each issue
is marked prevented / partly / not covered, with the design section
that handles it. "Prevented" means prevented *by construction* — not
by a guard — unless noted.

**Class O (12 issues).**

| Issue | Verdict | Design |
|---|---|---|
| HOK-3125 (eval recreates reaped tasks) | prevented | §2e write-to-settled rejected |
| HOK-3147 (exhausted challenger stalls primary) | prevented | §2d bottom-up abort, §5b fresh row per head |
| HOK-3110 (primary never completes when challenger aborted) | prevented | §2d bottom-up abort |
| HOK-2926 (bootstrap primary's state entry dropped) | prevented | §2b parent_id + unique constraint; the row cannot be dropped |
| HOK-3003 (selector deadlock on parent with terminal children) | prevented | §2d abort walk; §2b parent-child constraint |
| HOK-3005 (completed task rows recreated) | prevented | §2e write-to-settled rejected |
| HOK-3068 (orphan arm) | prevented | §2b `parent_id` NOT NULL on non-root kinds, FK enforced |
| HOK-3067 (orphan arm) | prevented | §2b same |
| HOK-2934 (terminal/orphan arm) | prevented | §2b, §2e |
| HOK-2911 (terminal/orphan arm with unpushed work) | prevented | §5d owned publish step |
| HOK-2965 (PR discovery not bound to launch lineage) | prevented | §3b launch contract on step row |
| HOK-2537 (closed PR held as merge candidate) | prevented | §2b, §3e supersede |

**O total: 12 prevented / 12.**

**Class L (7 issues).**

| Issue | Verdict | Design |
|---|---|---|
| HOK-3101 (task-progress primitive) | prevented | §3b three invariants are construction-level |
| HOK-3137 (agent declared dead while waiting on background) | prevented | §3d `background=1` doesn't hold the parent |
| HOK-3095 (idle prompt counted as alive) | prevented | §3b `agent_process_live` is a diagnostic, not a state read |
| HOK-3087 (stall measured from state timestamp) | prevented | §3b state transitions carry a timestamp that is the ground truth; stall measured from `evidence.recorded_at` not from a stale `state.updated_at` |
| HOK-3032 (observer filed against stale job truth) | prevented | §4d observations are append-only; §3b state is not the observation |
| HOK-2962 (liveness guess) | prevented | §3b separation of liveness and state |
| HOK-2757 (four tasks stalled at once) | prevented | §3b, §3d — four stalled children of a monitor task do not block it from writing; the monitor's state is its own row |

**L total: 7 prevented / 7.**

**Class S (9 issues).**

| Issue | Verdict | Design |
|---|---|---|
| HOK-3105 (tend rebind reads head once after push) | prevented | §4b `git-push` key `(remote, ref, oid)` |
| HOK-3112 (handoff published at stale local HEAD) | prevented | §4b same |
| HOK-3109 (failed Ready leaves `wm:ready`) | prevented | §4b `pr-label` key; §4e |
| HOK-3111 (promote/demote loop every ~15 min) | prevented | §4b `pr-label` key |
| HOK-3115 (Linear writes not routed through task identity) | prevented | §4b `linear-transition` key; §3b launch contract |
| HOK-3099 (packet replaced, plan kept) | partly | §3b launch contract pins the plan to the packet hash; the writer of a new packet must settle the old plan step — the design covers it, but the packet-side guard is a separate change |
| HOK-3065 (challenge selection lost across expansion) | prevented | §2c pair row owns intent |
| HOK-2999 (review recovery not transactional) | prevented | §6d transaction wraps step + side effect |
| HOK-2765 (notified before delivery confirmed) | prevented | §4e `applied_at` set by delivery confirmation |

**S total: 8 prevented / 1 partly / 9.**

**Class R (16 issues).**

| Issue | Verdict | Design |
|---|---|---|
| HOK-2924 (bounded-retry invariant) | prevented | §5b `attempt` + `max_attempts` on row |
| HOK-2923 (symmetric clear invariant) | prevented | §5b terminalisation is a state transition, not a sentinel |
| HOK-2921 (retry) | prevented | §5a replay classification |
| HOK-3142 (coding-launch refused) | prevented | §4b idempotency keys on reroute writes; §5a replay classification on relaunch |
| HOK-2920 (retry) | prevented | §5b fresh row per head |
| HOK-3000 (retry forever) | prevented | §5b `max_attempts` is a column |
| HOK-3146 (retry) | prevented | §5a replay |
| HOK-3019 (retry) | prevented | §5a replay |
| HOK-2915 (retry) | prevented | §5a replay |
| HOK-3128 (wedged with no recovery; coding-dirty-handoff) | prevented | §5d publish step owns the dirty-tree case; §5c `.coding-dirty-handoff.*` mapping |
| HOK-2964 (recovery or budget) | prevented | §5b columns |
| HOK-2761 (recovery) | prevented | §5a replay |
| HOK-2771 (recovery) | prevented | §5a replay |
| HOK-2898 (recovery) | prevented | §5a replay |
| HOK-3106 (recovery budget) | prevented | §5b columns |
| HOK-2919 (merge lane not self-reconciling) | partly | §4b `pr-merge` key handles the duplicate case; the self-reconciliation of the queue itself is a tend-side change not in this doc |

**R total: 14 prevented / 2 partly / 16.** (counting HOK-3142 as
prevented because the ledger expresses the reroute as a `side-effect`
with a stable key; see §4a.)

**Total: 41 prevented, 3 partly, 0 not covered, out of 44 in-scope
issues → 93.2% prevented.** Comfortably above the ≥ 80 % criterion in
`pi-durable-evaluation.md` §4 (HOK-3152 criterion 1).

### 9c. Critical-incident class check

`arm_died_with_unpushed_work` (71) and `cleanup_unpublished_at_risk`
(53) are prevented by §5d (owned publish step with `(remote, ref, oid)`
idempotency key). The step is independent of pi-durable adoption — the
ledger owns it either way. Criterion 2 in `pi-durable-evaluation.md`
§4 — "handled by an owned, idempotent publish step that works for
external CLI arms as well as native ones" — is met.

## 10. Open questions

### 10a. Are review inputs pinned to the launch contract?

**Recommendation: yes.** The design above commits to it (§9a HOK-3166
row): the review step's row records `(base_ref, head_sha,
prompt_hash, artifact_identity)` at launch, and the review runs
against those recorded values. A relaunch against a new head is a new
step row.

Cost: review-step rows are heavier (an artifact identity blob attached
to each row). Benefit: HOK-3166 (self-review diffs against stale local
base) is prevented, and review-infra exhaustion that survives a new
commit (HOK-3165) is prevented by the same inputs-hash constraint.

### 10b. What does `interrupted` mean for a CLI arm?

Native arms get `interrupted` from pi-durable semantics (unsafe tool
crash → re-return `interrupted` to the model). CLI arms don't have the
same visibility into their own tool loop; the ledger's `interrupted`
for a CLI `agent-run` step means "the step was `running`, the agent
process is no longer live, and no agent-sourced idle record was
written before the stop". A CLI arm's `interrupted` child does not
automatically escalate to arm abort — the parent arm's recovery
policy (file an incident, relaunch once, or forfeit) stays as it is
today, now expressed as a transition from the step's `interrupted`
state. Subject to refinement after HOK-3150; marked `provisional`.

### 10c. When to turn off `workflow-state.json`?

Not before the ledger has been shadow-correct for 14 days under
production load, split roughly between a week of mill traffic and a
week of weekend low-load (to catch bugs that only surface under one or
the other). The compatibility shim reads live from the ledger; the
old file remains as a diagnostic until the first operator-week with
zero sentinel-vs-row disagreements.

### 10d. Does the step row's `inputs_hash` collide on identical replays?

By construction, two runs of the same step kind against the same
inputs produce the same `inputs_hash`. The `UNIQUE(parent_id, slug,
inputs_hash)` constraint catches this as "the step already exists",
and the caller reads the row and resumes it. This is the desired
behaviour: an operator who hits `re-review` twice against the same
head does not create two rows. If an operator wants to force a new
attempt against the same head, the `re-review --force` form adds a
monotonically increasing nonce to `inputs_hash`.

### 10e. What about long-running non-mill writers (eval, backfill)?

Eval and backfill are considered secondary writers in the same multi-
writer SQLite WAL model (§6c). They open the DB in the same mode and
use the same `ledger.ts` module. The reaped-task-eval case (HOK-3125)
is prevented at the write path, not by eval policy.

## 11. Next steps (not inside this task)

- File the Phase 1 implementation issue (new HOK-xxxx: side-effect
  ledger). Scope: the four high-value call sites in §8b; the shadow-
  side table write; the duplicate-side-effect metric. Decision gate:
  §8b's "zero duplicate side effects for 7 days".
- Instrument `operator-intervention.ts` with the O / L / S / R class
  tag (feeds §8f) — one small issue, prerequisite for Phase 1's
  baseline measurement.
- Record the HOK-3150 spike result (coding-arm crash + resume on
  pi-durable) back onto §7's native-engine band.

---

**Attribution.** This document is the design artifact for HOK-3152. It
cites but does not re-derive the incident census from HOK-3148/3149
(`docs/pi-durable-evaluation.md`), the condition-reconciler primitive
from HOK-3172 (`shared/lib/condition-reconciler.sh`), the liveness
primitive from HOK-3101 (`shared/lib/task-progress.ts`), and the
bounded-retry invariant from HOK-2924 (`shared/lib/bounded-retry.sh`).
