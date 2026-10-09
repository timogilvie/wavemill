# Pi Durable evaluation (HOK-3148)

**Status:** plan (HOK-3149) · HOK-3150 **done** (§6) · HOK-3151 pending ·
design pending (HOK-3152) · decision pending (HOK-3153)

Pi 1.0 shipped `@earendil-works/pi-durable` 1.0.4 (MIT, 1.0.0 released
2026-10-01; **1.0.4 released 2026-10-05 — four patch releases in four days,
each carrying "Breaking Changes"**). Wavemill's native agent has since
upgraded to `pi-agent-core` / `pi-ai` **1.0.2** (HOK-3161/HOK-3162/HOK-3164 on
`auto/integration`), so the §3b table below is a retrospective, not a
pre-condition. This document sizes the problem Pi Durable might solve for
wavemill, maps it onto Pi Durable's primitives, inventories the native
agent's Pi surface, fixes the pass/fail criteria for the spikes before they
run, and (§6) reports the HOK-3150 crash-resume spike against those
criteria.

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

## 6. HOK-3150 results (native coding arm on pi-durable 1.0.4)

Evidence lives in [`spike/pi-durable-crash-test/`](../spike/pi-durable-crash-test/)
with per-trial JSON in `spike/pi-durable-crash-test/results/`. The spike runs
`pi-durable@1.0.4` + `pi-ai@1.0.4` + `chord@1.0.4` in its own `node_modules`,
leaving the repo's `pi-ai@1.0.2` dependency untouched. All trials use the
`pi-ai` **faux provider** — no real-model tokens spent — with a durable
scripted factory that reads `TranscriptContext.messages` so the same tool
sequence is produced before and after a kill (otherwise the faux state resets
on process restart and resume is indistinguishable from a brand-new run).

### 6.1 Crash points (gates 1 / 2 / 3)

Three trials per point. "wt-after-crash" is `git` state after the first child
is SIGKILLed; "wt-after-resume" is after the second child settles the
submission. "interrupted" is whether a `pi.tool-result` entry in the SQLite
transcript carries a diagnostic with `code: "interrupted"` (pi-durable's
unsafe-tool kill marker; see `tool.js:fromSlot`).

| Point | Trials | Resumed | Reached completion artifact | wt-after-crash | wt-after-resume | `interrupted` recorded | Safe-tool execute count (expect 2) | Unsafe-tool execute count (expect 1) | Median preCrashMs | Median resumeMs |
|---|---:|---:|---:|---|---|---:|---:|---:|---:|---:|
| **A** mid-model-request | 3/3 | 3/3 | 3/3 | full | full | 0/3 | 1 | 1 | 30 038 | 1 410 |
| **B** mid-safe-tool | 3/3 | 3/3 | 3/3 | untouched | full | 0/3 | **2** | 1 | 776 | 855 |
| **C1** mid-unsafe-tool, before write | 3/3 | 3/3 | 3/3 | untouched | untouched | **3/3** | 1 | 1 | 942 | 919 |
| **C2** mid-unsafe-tool, between writes | 3/3 | 3/3 | 3/3 | **partial** | **partial** | **3/3** | 1 | 1 | 824 | 906 |
| **C3** mid-unsafe-tool, after execute | 3/3 | 3/3 | 3/3 | full | full | **3/3** | 1 | 1 | 776 | 772 |

**Gate 1 (A, mid-model-request): PASS on durability, UNDER-TESTED on the
"partial response recorded as aborted" invariant.** Pi-ai's `fauxProvider`
streams the whole scripted response atomically, so an observer on
`docs["pi.live"]` never sees a partial. The harness falls back to the 30s
ready-file timeout and SIGKILLs a process that is already idle after the
submission settled. On resume there is nothing left to do — the completion
artifact is already written. This proves SQLite durability survives SIGKILL
but does not exercise an interrupted stream. **Follow-up:** rerun A once
against a real OpenRouter model (one certified glm-5.2-air-ish; cost cap
~$0.10 for 3 trials).

**Gate 2 (B, mid-safe-tool): PASS 3/3.** Pre-crash the worktree is
untouched (list_files is read-only). The safe tool's intent was committed
before the pause, so pi-durable's recovery re-executed it on resume — exactly
twice total (`list_files`: once in the killed child, once after
`harness.resume()` — see `t0-list_files: 2` in `results/b-*.json`). The
transcript's `exactlyOneResultPerCall` check passes (no duplicate results).

**Gate 3 (C1/C2/C3, mid-unsafe-tool): MIXED.**

- **C1 (before write): PASS 3/3** on the hard criteria. apply_patch's intent
  was committed, no file was written, pi-durable's recovery wrote the
  `interrupted` diagnostic (`hasInterruptedForUnsafe: true`) rather than
  re-running the tool, and the arm still reached the completion artifact.
- **C2 (between writes): FAIL on the atomicity sub-criterion**, as predicted
  in the plan's §0 and §3.2. `apply_patch` writes files sequentially (same
  shape as production `patch-runtime.ts:377-388` — in-process `try/catch`
  rollback, no `kill -9` guard). After the kill, 1 of 2 files is on disk;
  resume commits an `interrupted` result but *does not* undo the first
  write, so the worktree remains **partial** forever unless the model
  reconciles via `git_status`. The HOK-3149 gate 3 criterion ("worktree is
  either fully patched or untouched (never partial)") is not met. The gate
  is also not met by production's own `apply_patch`; adopting pi-durable
  does not fix this. Fix would need a write-tempfile+atomic-rename or a
  per-call undo log in `apply_patch` itself.
- **C3 (after execute, before result commit): PASS 3/3**. The worktree is
  already full when the kill lands (writes finished before the pause). On
  resume, pi-durable commits `interrupted` with the output the execute
  managed to flush, and the next generation continues to the completion
  artifact. No duplicate tool executions.

### 6.2 Resume vs today's relaunch (gate 4)

`baseline-relaunch.ts` compares (crash + `harness.resume()`) to (crash +
new SQLite + fresh conversation, which models today's `launch-coding.ts`
semantics). The spike runs **the faux provider**, so no real token cost can
be measured and the gate 4 ratio ≤ 0.5 cannot be assessed from this
evidence. The faux-run wall-clock median for a crashed-and-resumed B trial
is **855 ms** vs **~1.5–2 s** for a crash-and-fresh-restart on the same
scratch tree (the fresh child reruns every tool from zero), i.e. a wall-time
ratio of roughly 0.5 — which matches the production expectation but is not
proof. A real-provider repeat on a single cheap OpenRouter coding model (<
$1 for 6 trials) is the standard way to settle gate 4 and should land before
HOK-3153.

### 6.3 Provider coverage (gate 5)

`provider-matrix.ts` runs on the mill host (reads `~/.wavemill/native-agent-certifications`).
On this spike host there is no cert store, so the matrix script reports zero
certified models. The static findings do not need credentials:

- `pi-ai@1.0.4` ships both `openrouterProvider()` and `openaiProvider()`
  (`node_modules/@earendil-works/pi-ai/dist/providers/openrouter.d.ts`,
  `openai.d.ts`), the two providers `shared/lib/native-agent/models.ts` uses
  today — so provider coverage, in principle, matches wavemill's.
- `pi-ai` is **version 1.0.2 in the repo and 1.0.4 in the spike**. Two
  copies co-exist in the tree. The repo's `createNativeModelsCollection` is
  bound to 1.0.2's `Models` type and cannot be reused with pi-durable 1.0.4
  — the `models` field of `HarnessOptions` requires a 1.0.4 `Models`.
  Adopting pi-durable means bumping repo pi-ai from 1.0.2 → 1.0.4 first.
- Pi-ai 1.0.2 → 1.0.4 is **two more patch bumps with breaking changes**
  (observed from the `@earendil-works/pi-durable` release cadence: four
  breaking patch releases in four days). This cadence is an adoption
  blocker in itself: a mill pin needs upstream commitment to semver.
- **Gate 5 verdict: NOT YET PROVEN.** The spike cannot run a certified-model
  smoke on this host; the matrix script is ready to run on the mill host
  with `wavemill native-agent certifications list --json`-driven input.

### 6.4 Policy hooks (gate 6)

`policy-parity.ts` drives six fixtures (allow + two deny classes from
`mutation-policy.test.ts` and `tools/policies.test.ts`) through both
(a) the production functions directly and (b) a pi-durable
`beforeTool`+`afterTool` hook stack that calls those same functions.

**Result: 0 diffs over 6 fixtures (`results/policy-parity.json`). PASS.**

Fixtures covered:

| Fixture | Expected | Production | Hook |
|---|---|---|---|
| mutation: patch inside worktree allowed | allow | allow | allow |
| mutation: patch outside worktree denied | block | block | block |
| mutation: sibling-prefix false positive denied | block | block | block |
| mutation: whole-file deny when not allowlisted | block | block | block |
| phase: read-only tool denied in planning | block | block | block |
| path-field: path argument outside worktree denied | block | block | block |

Also recorded as findings during the port:

- `beforeTool(call, api, context)` returns only `{ arguments?, block? }`.
  Argument rewriting and allow/deny are expressible; the full
  `ToolPolicyDenyDecision` payload (reason code, resolvedPath, policy
  category) has to be flattened into the `block` string. Audit downstream
  consumers (loop.ts:966-998 writes `tool_decision_capture` entries with
  structured reasons; the hook would need `api.memo()` or a side-channel
  document to keep that structure).
- `afterTool(call, result, api, context)` can replace `content`, `details`,
  `diagnostics`, `usage`, and `control`. Output-byte cap + `redactSecrets`
  port cleanly. `redactSecretsInValue` for `details` ports cleanly.
- **`beforeRequest(request, …) → { messages }` cannot set `max_tokens`.**
  Max-token reservation (`computeDynamicMaxTokens`, loop.ts:806 and
  loop.ts:1169) must move to `HarnessSettings.stream.maxTokens` or an
  extension-level stream wrapper. This is HOK-2585-adjacent (OpenRouter 402
  on inflated reservations) and is a real porting cost, not just a rewrite.
- Model-text redaction (`redactSecrets` on committed assistant content)
  has no in-place hook: `afterResponse(message, …)` returns `void`.
  Redaction of model text would need either a `wrapTool` on every tool
  that forwards model output or a post-commit overlay. Operationally this
  is minor (`redactSecrets` is 20 lines) but it is **custom code
  pi-durable does not provide a hook for**.

### 6.5 `loop.ts` responsibility map (info 7)

| Responsibility | loop.ts LOC | Pi-durable primitive | Verdict | Lines remaining as custom code |
|---|---:|---|---|---:|
| Budgets (turns, tool calls, cost, wall-clock) | ~140 | — no direct equivalent; must stay as a wrapper around `submit()`/`wait()` or as `onYield` with external accounting | still custom | ~140 |
| Cost accounting (`pi-usage-cost.ts`) | 25 (file) + ~60 in loop | `harness.usage()` returns pi.usage; need to re-wire price-table lookup | hybrid: pi-durable gives the usage, pricing stays custom | ~30 |
| Context-window guard | ~290 (`context-window-guard.ts`) + ~40 in loop | `settings.compaction.reserveTokens` + overflow retry are built in | **replaced** | 0 |
| Compaction | ~180 (`compaction.ts`) + ~30 in loop | Built-in `CompactionTask` + `beforeCompact` hook + `settings.compaction` | **replaced** | 0 |
| Tool-compat validation | — (`tool-compat-validator.ts` is launch-time) | Pi-durable's `validateToolArguments` (via typebox) covers runtime; the launch-time registry audit stays | mostly replaced | ~40 |
| Mutation + path policy | ~35 in loop | **ported to `beforeTool` (this spike)** | **replaced** | ~15 (the hook) |
| Output cap + redaction | ~75 in loop | **ported to `afterTool` (this spike)** | **replaced** | ~25 (the hook) |
| Fail-fast batch skipping | ~60 | `control.terminate` on tool result is the primitive; can be driven from `afterTool` | replaceable | ~20 |
| Stagnation tracker | ~55 | No primitive; must stay as a `beforeRequest`/`afterTools` observer | still custom | ~55 |
| Provider-identity verification (HOK-3143) | ~90 in loop | `afterResponse(message)` sees the real provider response — matches HOK-3143's "verify at message_end" | **replaced** | ~30 (invalidation plumbing) |
| Tool-decision capture | ~80 | `afterTool` return value is the point; the capture itself is custom | partial | ~50 |
| Session-stream writer | 650 (`session-stream.ts`) + ~90 in loop | `root.watch()` delivers an exact-frame stream of commits; most of session-stream.ts becomes a translator | partial | ~250 |
| Provider tool-menu drift | ~60 | `beforeRequest` can filter messages but not tools; `settings.extensions` picks tools per conversation. Drift detection stays custom. | still custom | ~60 |
| `finishTurn` / `prepareNextTurn` plan | ~110 | `GenerationHooks.onYield` is the direct equivalent | **replaced** | ~20 |
| Abort composition | ~70 | `conversation.abort()` + `root.abort()` + per-task abort cover it | **replaced** | 0 |

**Totals (coding path only, loop.ts + launch-coding.ts + the companion files
above):** today ≈ **5 400 lines**; after an ideal port ≈ **735 lines of custom
glue** — a removal of roughly **4 600–4 800 lines**. The two hooks actually
ported in this spike (`policy-extension.ts` 252 lines) replace loop.ts:966–1060
(~95 lines of mutation-policy + output-limits + redaction + decision log), so
the ratio on the ported slice is ~2.6× (hooks slightly larger than the loop
code they replace, mainly because the hooks need their own log and typing).

### 6.6 Breaking-change retrospective (info 9)

The native agent already paid the 0.79.8 → 1.0 cost before this spike was
scoped. The retrospective:

| Issue | SHA | Lines | What it hit |
|---|---|---:|---|
| HOK-3161 (pi-ai 1.0 migration) | `275effba` | 18 files, +495/−628 | Section-based system prompt, `SystemMessage` in `Message` union, moved `registerApiProvider`/`streamSimple` to `@earendil-works/pi-ai/compat` |
| HOK-3162 (Models API migration) | `4442e164` | 13 files, +564/−70 | Dropped the compat shim; adopted `createModels()`/`setProvider`; providers now constructed via `openrouterProvider()`/`openaiProvider()` |
| HOK-3163 ("Response incomplete" terminal) | — | small | Classify new terminal reason |
| HOK-3164 (pi runtime version in provenance) | `65f484a0` | — | Record `piRuntimeVersions` on sessions |

Delta a pi-durable move would add on top of 1.0.2:

- pi-ai 1.0.2 → 1.0.4: two patch bumps with "Breaking Changes" (`CHANGELOG`
  in `node_modules/@earendil-works/pi-ai/dist/`).
- `@earendil-works/chord` as a new direct dep (currently transitive via
  pi-ai).
- `pi-agent-core` **dropped entirely**: `runAgentLoopContinue`, `AgentTool`,
  `BeforeToolCallContext`/`AfterToolCallContext`, `finishTurn`,
  `ShouldStopAfterTurnContext` all become dead imports. 1 639 lines of
  `launch-coding.ts` and 1 733 lines of `loop.ts` must be rewritten around
  `Harness.open` + `extension.hooks`.
- Pi-durable itself: 1.0.0 → 1.0.4 shipped **four breaking patch releases
  in four days** (observed 2026-10-01 to 2026-10-05). The README labels the
  package experimental and warns that "the API changes without notice
  between releases". **This is the single largest risk for adoption and is
  not reducible by shipping-ahead work.**

### 6.7 Certification identity (info 8)

Read-only analysis against `shared/lib/native-agent/certification/identity.ts`
and `catalog-hash-migration.ts`:

- Subject = `registryKey`, provider ids, `identityRevision`, `fingerprint`,
  `catalogHash` (per-row for OpenRouter from the launch-priority audit;
  `'registry'` for everything else). **No Pi runtime version in the
  subject.** A runtime swap (pi-agent-core → pi-durable) does **not** rotate
  catalog hashes.
- Certificates carry `suiteVersion`. The live-coding canary runner
  (`live-coding-canary.ts`) depends on `runAgentLoopContinue` + the current
  `loop.ts` scenario runner. Porting it to pi-durable means reimplementing
  the scenario runner on `Harness` — a `suiteVersion` bump by design, which
  per the user memory "cert suite bump uncertifies the fleet" (recorded in
  `project_cert_suite_bump_uncertifies_fleet.md`) triggers a fleet
  re-certify.
- Deterministic re-certify is ~1 s/model and uses the standard
  `wavemill native-agent certify --all --phase workflow` flow (no new
  tooling). The live-coding canary cohort would need one real coding smoke
  per bounded cohort model — a one-time cost on the credentialed mill host.
- HOK-3164 already records `piRuntimeVersions` on session provenance, so
  the attribution path survives the swap without further work.

### 6.8 Decision-rule outcome

Scored per HOK-3149 §4.1 decision rule ("go if 1–6 pass; adopt-later if 1–3
pass but 5 fails; otherwise defer"):

- Gate 1 (A): **PASS on durability**; under-tested on partial-stream
  recording until a real-provider rerun.
- Gate 2 (B): **PASS 3/3**.
- Gate 3 (C): **MIXED** — C1 and C3 pass; **C2 fails the "no partial
  worktree" criterion**. The failure is a property of our in-process
  `apply_patch`, not of pi-durable, so adopting pi-durable does not fix it.
- Gate 4: **NOT MEASURED** — needs a real-provider rerun to measure
  tokens, which the gate's "≤ 0.5 cost ratio" criterion requires.
- Gate 5: **NOT YET PROVEN** — pi-ai 1.0.4 has the providers wavemill
  uses, but the certified-model smoke needs the mill host's cert store.
- Gate 6: **PASS 6/6 fixtures, 0 diffs**.

**Recommendation: defer the runtime swap** until (a) pi-durable's patch
cadence stabilises enough to give a non-experimental ship window; (b)
`apply_patch` is made file-atomic (independent of pi-durable, since C2
reproduces today); (c) a real-provider A/C/baseline rerun on the mill host
closes gates 1 (A real) and 4; (d) the matrix script runs on-mill against
every certified model. **Core-upgrade work (pi-ai 1.0.2 → 1.0.4) can
ship ahead** on its own merits, independent of the runtime decision — it is
a ~day of mechanical rebinding (openrouter/openai providers unchanged;
typebox version bump).

Policy hooks (gate 6) are strong evidence that the hook surface is
expressive enough; the main gap found is **`max_tokens` is not expressible
through `beforeRequest`**, which is load-bearing for OpenRouter 402
avoidance (HOK-2585 memory) and is probably the single most important
missing primitive to request from pi-durable.
