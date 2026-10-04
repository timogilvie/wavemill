# Pi Durable evaluation (HOK-3148)

**Status:** plan (HOK-3149) · spikes pending (HOK-3150, HOK-3151) · design
pending (HOK-3152) · decision pending (HOK-3153)

Pi 1.0 shipped `@earendil-works/pi-durable` 1.0.0 (MIT, released 2026-10-01,
labelled experimental) alongside `pi-agent-core` and `pi-ai` 1.0.0. Wavemill's
native agent pins `pi-agent-core` and `pi-ai` at **0.79.8**. This document sizes
the problem Pi Durable might solve for wavemill, maps it onto Pi Durable's
primitives, inventories the native agent's Pi surface, and fixes the pass/fail
criteria for the spikes *before* they run.

Sources: the [announcement post](https://earendil.com/posts/pi-durable/), the
`pi-durable@1.0.0` README shipped in the npm tarball, and a type-check of this
repo against `pi-agent-core@1.0.0` / `pi-ai@1.0.0` (§3).

## 1. Incident census

### 1a. Closed Bug issues, last 90 days

Scope: wavemill project, label `Bug`, completed 2026-07-04 → 2026-10-02.
**85 issues.** Issues that were not labelled `Bug` are not counted, so this
undercounts; the class ratios are the useful signal.

| Class | Issues | Share | What goes wrong |
|---|---:|---:|---|
| **O** ownership / orphan | 12 | 14% | A child outlives, loses, or blocks its parent; a terminal task is recreated or never reaped |
| **L** liveness inference | 7 | 8% | "Alive" or "stalled" is guessed from hook files, panes, processes, or timestamps and guessed wrong |
| **S** duplicate / lost / inconsistent side effect | 9 | 11% | A label, handoff, Linear write, or multi-artifact update runs twice, at a stale head, or only partially |
| **R** retry / resume | 16 | 19% | A failure relaunches forever, never relaunches, consumes budget wrongly, or leaves a marker that never clears |
| **X** other | 41 | 48% | Guard logic, classifiers, observability, attribution, config, infra |
| **In scope (O+L+S+R)** | **44** | **52%** | |

Issue lists by class:

- **O:** HOK-3125 (eval recreates reaped tasks as slot-consuming stubs),
  HOK-3147 (exhausted challenger never evaluated; primary waits forever),
  HOK-3110 (primary never completes when its challenger aborted),
  HOK-2926 (bootstrap primary's state entry dropped), HOK-3003 (selector
  deadlocks on parent with only terminal children), HOK-3005 (completed task
  rows recreated), HOK-3068, HOK-3067, HOK-2934, HOK-2911 (terminal/orphan arms
  and their unpushed work), HOK-2965 (PR discovery not bound to launch
  lineage), HOK-2537 (closed PR held as merge candidate).
- **L:** HOK-3101 (task-progress primitive), HOK-3137 (agent declared dead
  while waiting on its own background task), HOK-3095 (idle prompt counted as
  alive), HOK-3087 (stall measured from state timestamp), HOK-3032 (observer
  filed against stale job truth), HOK-2962, HOK-2757 (all four tasks stalled at
  once).
- **S:** HOK-3105 (tend rebind read head once after push), HOK-3112 (handoff
  published at stale local HEAD), HOK-3109 (failed Ready leaves `wm:ready`),
  HOK-3111 (promote/demote loop every ~15 min), HOK-3115 (Linear writes not
  routed through task identity), HOK-3099 (packet replaced, plan kept),
  HOK-3065 (challenge selection lost across expansion), HOK-2999 (review
  recovery not transactional), HOK-2765 (notified before delivery confirmed).
- **R:** HOK-2924 and HOK-2923 (the bounded-retry and symmetric-clear
  invariants), HOK-2921, HOK-3142, HOK-2920, HOK-3000 (retry forever),
  HOK-3146, HOK-3019, HOK-2915, HOK-3128 (wedged with no recovery), HOK-2964,
  HOK-2761, HOK-2771, HOK-2898, HOK-3106 (recovery or budget semantics),
  HOK-2919 (merge lane not self-reconciling).
- **X:** HOK-3102, 3145, 3121, 3130, 3129, 2963, 3092, 3090, 3064, 2933, 2918,
  3119, 3108, 3107, 2913, 3091, 3063, 3033, 3052, 3051, 3031, 2929, 2917, 2767,
  3002, 2949, 2927, 2768, 2948, 2928, 2895, 2908, 2909, 2766, 2769, 2764, 2763,
  2770, 2762, 2680, 2721.

Classification was done from titles and known root causes. Borderline calls:
HOK-3128 (R, though the fix also aborts the challenger, which is O),
HOK-2917/2767 (X: intent-vs-execution attribution. A durable transcript would
make attribution true by construction, but that is a side benefit, not a fix),
HOK-3102 (X: consumer configuration, not task state).

### 1b. Incident store (`.wavemill/incidents/`)

The store has 471 incidents across 141 tasks, observed 2026-09-09 → 2026-10-02.
It only has resolution tracking since HOK-2929, so nothing older is available.

| Root cause | Incidents | Severity | Class |
|---|---:|---|---|
| `arm_died_with_unpushed_work` | 71 | critical | R (partial, see §2 caveat) |
| `cleanup_unpublished_at_risk` | 53 | critical | O |
| `cleanup_dirty_worktree` | 47 | high | O |
| `stage_marker_not_advanced` | 23 | high | L |
| `terminal_arm_parked_with_residue` | 14 | critical/high/medium | O |
| `active_unpublished_work_stalled` | 14 | medium | L |
| `failed_background_job`, `failed_job_no_result`, `pr_create_failed` | 7 | medium/high | S |
| `cleanup_retained_by_policy` | 202 | info | (policy noise, 2 tasks) |
| config drift, harness outcomes, transient, other | 40 | mixed | X |

**Every critical incident in the store is O or R.** They involve arms that die
or finish with work that has not been published, and cleanup that then has
nothing authoritative to reconcile against.

### 1c. Operator time

Operator time is not measured anywhere today, so no per-class estimate is
given. The first ledger milestone (HOK-3152) should record operator
interventions per class (`operator-intervention.ts` already captures some) so
that a later decision can be checked against real data.

## 2. Primitive mapping

| Class | Pi Durable primitive | Wavemill code it would replace or simplify |
|---|---|---|
| O | **Ownership tree.** Every task has an owner (a conversation or a task). Abort runs bottom-up. A finishing task stays `completing` until owned work is done. A parent with `waiting … policy: failFast \| allSettled` resumes when its children settle. | Pair bookkeeping in `workflow-state.json`, `task_state_mutate_existing` (HOK-3125 guard), terminal-inbox finalizer, cleanup orphan classification, the tend challenge gate's pair-resolution states |
| L | **Committed task status** (`pending`/`running`/`waiting`/`completing`), plus **`background: true`** for work that must not keep a parent busy, plus **`harness.taskGraph()`** | `task-progress.ts` and its three invariants, hook-file TTL reads, pane liveness fallback, observer stall heuristics. For external CLI agents, hook evidence would feed a task's state rather than *be* it. |
| S | **Atomic commits.** Entries, documents, and task creation commit together or not at all. **`requestId`** dedupes submissions. **Memos** are first-write-wins values for side effects inside rerunnable code. | Tend handoff rebind, `set-pr-ready-label`, `linear_set_state`, review-result recovery, multi-file packet/plan updates |
| R | **Checkpoint per step** plus **`replay: "safe"`** declared per tool. An unsafe call interrupted by a crash returns an `interrupted` result instead of rerunning. **`harness.resume()`** continues pending tasks. | `bounded-retry.sh` (attempt counting stays useful; the "did it already happen?" question goes away), `.coding-complete` / `.retry-*-exhausted` sentinels, the recovery prompt path in `launch-coding.ts` |

**Caveat that limits the R and O mapping.** Pi Durable checkpoints the
*transcript and documents*, not the worktree. Files written through the
execution environment are not stored. The largest critical class,
`arm_died_with_unpushed_work`, is only fixed if the arm resumes and reaches its
publish step, or if "publish" is itself a durable step that the ledger owns.
Native arms could get resume from Pi Durable. External Claude Code and Codex
arms cannot, so the ledger (HOK-3152) has to model "commit and push the
worktree" as an owned, idempotent step whatever happens with Pi Durable.

**Hard constraint for the mill.** The pi-durable README says: *"One process
owns a storage at a time; there is no cross-process locking."* The mill has
many writers (monitor, tend, observer, ready-watchdog, shell scripts). So
pi-durable cannot be the mill's shared store as-is. Its task model can be
copied; its storage can only be used behind a single owning daemon.

## 3. Native agent Pi surface

### 3a. Imports today (non-test code)

| Package | Symbols | Files |
|---|---|---|
| `pi-agent-core` | `runAgentLoopContinue`, `AgentContext`, `AgentLoopConfig`, `AgentEvent`, `AgentEventSink`, `AgentMessage`, `BeforeToolCallContext`, `AfterToolCallContext`, `AfterToolCallResult`, `ShouldStopAfterTurnContext`, `AgentTool`, `AgentToolResult` | `loop.ts`, `transcript.ts`, `compaction.ts`, `tools/pi-adapter.ts` |
| `pi-ai` | `registerApiProvider`, `registerBuiltInApiProviders`, `getApiProvider`, `streamSimple`, `createAssistantMessageEventStream`, `Api`, `Model`, `Context`, `Message`, `UserMessage`, `AssistantMessage`, `AssistantMessageEvent`, `ToolResultMessage`, `ToolCall`, `TextContent`, `ThinkingContent`, `Tool`, `Usage`, `StopReason`, `StreamFunction`, `SimpleStreamOptions` | `provider.ts`, `messages.ts`, `loop.ts`, `transcript.ts`, `tools/pi-adapter.ts` |

### 3b. Type-check against Pi 1.0.0

Method: `tsc -p tsconfig.static.json` before and after
`npm i @earendil-works/pi-agent-core@1.0.0 @earendil-works/pi-ai@1.0.0`, then a
diff of the error sets. The repo baseline already has 631 errors (the static
config isn't a gating check). The upgrade adds **25 new errors in 11 files**
(and clears one baseline error):

| Change in 1.0 | Effect on wavemill | Sites |
|---|---|---|
| `AgentContext.systemPrompt` removed. The system prompt is now a `SystemMessage` (`role: "system"`) in `messages`, with named, replaceable `sections`. | Every context construction | `loop.ts`, `launch-coding.ts`, `launch-planning.ts`, `review.ts`, `smoke.ts`, `lifecycle-smoke.ts`, `native-expansion.ts`, `certification/live-coding-canary.ts` |
| `Message` union now includes `SystemMessage` | Exhaustive switches hit `never`, and the assistant-message narrowing breaks | `messages.ts`, `provider.ts` |
| `shouldStopAfterTurn` / `ShouldStopAfterTurnContext` replaced by `finishTurn` → `{ action: "continue" \| "end" }` (plus new `prepareRequest` / `prepareNextTurn`) | Turn-stop policy | `loop.ts` |
| `runAgentLoopContinue(context, config, emit, signal, streamFn)` now needs an explicit `streamFn` | Loop entry | `loop.ts` |
| `registerApiProvider`, `registerBuiltInApiProviders`, `getApiProvider`, `streamSimple` moved from the root to `@earendil-works/pi-ai/compat` | Provider registration | `provider.ts`, `tools/pi-adapter.ts` |
| Tool-call `arguments` typed as `JsonObject` / `JsonValue` instead of `Record<string, unknown>` | Message conversion | `messages.ts` |

This is mechanical work and fits in one issue. It doesn't require pi-durable.
OpenRouter remains a built-in provider in `pi-ai@1.0.0`.

### 3c. pi-durable is a different runtime, not a layer on pi-agent-core

`pi-durable@1.0.0` depends on `pi-ai` and `typebox` but **not on
`pi-agent-core`**. It runs its own loop: `pi.generation` tasks call the model
and own `pi.tool` tasks. Moving to pi-durable therefore **replaces**
`runAgentLoopContinue` and the 1,518-line `loop.ts` around it; it is not an
upgrade of either. The responsibilities `loop.ts` carries today (budgets,
cost, context-window guard, compaction, tool-compat validation, mutation and
network policy, tool-decision capture, session-stream writing, provider
tool-menu drift) have to be re-expressed as pi-durable extensions, hooks
(`beforeRequest`, `afterResponse`, `onYield`, `afterTools`, `beforeTool`,
`afterTool`), documents, and settings. Mapping each one is part of HOK-3150.

Two separate decisions follow:

1. **Core upgrade** (0.79.8 → 1.0, §3b). Worth doing on its own, because
   version drift will only grow.
2. **Runtime replacement** (pi-agent-core loop → pi-durable). This is what
   HOK-3150 tests.

There is a precedent for the spike layout in `spike/pi-native-agent/` (the
HOK-3055 MCP proxy spike).

## 4. Spike success criteria

The criteria are fixed here, before any spike runs. "Gate" criteria decide go
or no-go; "info" criteria are recorded but don't decide anything on their own.

### HOK-3150: native coding arm on pi-durable (SQLite)

| # | Criterion | Kind | Pass |
|---|---|---|---|
| 1 | `kill -9` mid-model-request, then restart | gate | Run continues to a completion artifact in 3/3 trials; the partial response is recorded as aborted; no tool executes twice |
| 2 | `kill -9` mid-safe-tool (`read_file`/`search_text`), then restart | gate | The tool reruns exactly once; the transcript has exactly one result for the call; 3/3 trials |
| 3 | `kill -9` mid-unsafe-tool (`apply_patch`), then restart | gate | No rerun; the model receives `interrupted`; the worktree is either fully patched or untouched (never partial); the arm still reaches a completion artifact in ≥2/3 trials |
| 4 | Resume cost | gate | Total cost of crash + resume ≤ 50% of crash + today's fresh relaunch on the same task (same model, same seed task) |
| 5 | Provider coverage | gate | Every model currently certified for a native stage completes the coding smoke scenario through `pi-ai@1.0.0`. A gap is a blocker unless the model can be retired. |
| 6 | Policy hooks | gate | `mutation-policy` and `output-limits` ported to `beforeTool`/`afterTool` hooks make the same block/allow decisions as today on the existing policy test fixtures |
| 7 | `loop.ts` responsibility map | info | Each responsibility listed in §3c mapped to built-in / hook / extension / still custom, with a line-count estimate |
| 8 | Certification identity | info | Whether the runtime change alters catalog hashes or identity, and whether a fleet re-certify (the standard flow) is enough |
| 9 | Core-upgrade effort | info | Hours to clear the 25 errors in §3b; recommend whether it should ship ahead of, and independently of, the runtime decision |

**Decision rule:** native adoption is a **go** if gates 1–6 pass. If 1–3 pass
but 5 fails, it is **adopt later**, pending provider work. Otherwise it is
**defer**.

### HOK-3151: fork-based challenge pair

| # | Criterion | Kind | Pass |
|---|---|---|---|
| 1 | Model switch on fork | gate | A fork can be configured with a different model and extension set before its first request |
| 2 | Atomic pairing | gate | Crash injected between fork commit and the challenger's first request, 5 trials: 0 one-armed pairs (both arms exist, or neither does) |
| 3 | Worktree isolation | gate | The two arms run in different worktrees through per-conversation environment/cwd with no shared mutable files |
| 4 | Cost | gate | Challenger input-token cost ≤ 70% of a separately launched challenger on the same task; cache-read ratio reported |
| 5 | Counterfactual fidelity | info | A fork at a mid-session tool decision reproduces the pre-decision model context; compared against `replayCheckpointAgainstItself` fidelity |

**Decision rule:** adopt for native pairs if gates 1–4 pass. Criterion 5
decides separately whether the `session-checkpoint.ts` /
`deterministic-replay.ts` path can be retired.

### HOK-3152: mill task ledger design

This is a design, not a spike, so these are acceptance criteria:

| # | Criterion | Pass |
|---|---|---|
| 1 | Coverage | Each of the 44 in-scope issues in §1a is shown to be prevented by construction (not by a guard), or listed as not covered with a reason; ≥80% covered |
| 2 | Critical incidents | `arm_died_with_unpushed_work` and `cleanup_unpublished_at_risk` handled by an owned, idempotent publish step that works for external CLI arms as well as native ones |
| 3 | Concurrency | The writer model is chosen (single ledger daemon vs multi-writer SQLite WAL) with a test that shows concurrent monitor/tend/observer writes cannot interleave a task transition |
| 4 | Reuse vs build | A recommendation that accounts for the no-cross-process-locking constraint in §2 |
| 5 | Migration | Shadow-first phases, highest-incident class first, with a per-class operator-intervention metric (§1c) to measure before and after |

## 5. Not being evaluated now

Multi-client delta streaming and hot-swapping extensions in a running process
are out of scope unless a spike result changes the picture. The dashboard and
the cache-plus-`USR1` refresh are adequate for now. Swapping extension code
into a running process conflicts with certification identity, which pins what
a certified arm runs.
