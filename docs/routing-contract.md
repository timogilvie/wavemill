---
title: Routing Contract
---

# Routing Contract

This note documents the current Wavemill routing lifecycle and the runtime contract for bootstrap routing, expanded routing, and the authoritative execution route.

## Purpose

- Document where routing is produced, persisted, reread, and archived today.
- Define the target lifecycle boundary between pre-expansion routing and post-expansion execution routing.
- Identify the exact controller handoff where expanded routing must be promoted before coding and review.

## Non-Goals

- No change to challenge-mode pairing semantics or operator overrides such as `FORCE_MODEL`.
- No change to the underlying routing policy or expanded-route cache keying.

## Scoring Format Requirement

Route artifacts used for Wavemill router benchmark scoring must be strict JSON files. Runtime readers may remain lenient and classify malformed artifacts as `invalid_route`, but benchmark inputs are only scoreable when the artifact parses as JSON and contains the required route fields.

## Current Lifecycle

### Startup Runner

`shared/lib/wavemill-startup-runner.sh::startup_run_task_phases` writes `features/<slug>/.routing-complete` from the startup-selected planner/coder/reviewer/depth values and copies that file to `features/<slug>/.initial-route.json`. It then persists the same routed stage settings into `.wavemill/workflow-state.json` before launching planning.

### Dynamic Multi-Select Launch

`shared/lib/wavemill-mill.sh::prepare_route_input_for_issue` builds a minimal routing packet from `selected-task.json` when available, otherwise from the raw Linear title and description. `batch_route_selected_tasks()` routes those packets in batch and `apply_route_json_for_issue()` writes `/tmp/${SESSION}-${ISSUE}-route.json` plus `/tmp/${SESSION}-${ISSUE}-route-source.txt`. Later, `launch_task()` consumes that cached `/tmp` route or reroutes live, writes `features/<slug>/.routing-complete`, copies it to `.initial-route.json`, stores stage fields in task state, and launches planning.

### Planning Expansion

`tools/prompts/planning-phase.md` instructs the planner to route the expanded `task-packet.md` and save the result as `features/<slug>/.post-expansion-route.json`. The controller now promotes that artifact, or falls back to `features/<slug>/.expanded-route.json`, before coding launches and before a coding-phase resume relaunch.

### Routing-To-Planning Transition

The bootstrap route is what planning launches with. In startup and dynamic flows, the controller persists the pre-expansion route into `.routing-complete`, `.initial-route.json`, and task state before the planning agent starts.

### Planning-To-Coding Transition

In `shared/lib/wavemill-mill.sh`, the `planning)` branch checks `resolved_phase == "coding"`, validates the planning output, records plan approval, batch-reroutes any eligible expanded packets through `tools/route-tasks.ts --expanded-jsonl`, applies any valid expanded route artifact into `.routing-complete`, `.phase-config.json`, and workflow state, then reads coding model and depth and launches coding. This is the authoritative promotion point.

### Coding-To-Review Transition

The `coding)` branch reads reviewer model and mode from `.phase-config.json` or task state, calls `set_task_phase "$ISSUE" "review"`, and launches `launch_review_phase()`. Because the planning handoff now rewrites those execution surfaces first, review inherits the expanded reviewer and review mode automatically.

### Challenge Mode

Challenge selection now records an explicit decision source. Startup and early launch still use the bootstrap route when no expanded artifact exists. Once planning emits `.post-expansion-route.json`, `resolve-challenge-task.ts` compares bootstrap and expanded route context and either refreshes challenge participants from the expanded route, or preserves the bootstrap pair with a recorded rationale when the route did not change materially. Eval records may persist both bootstrap and expanded route snapshots through `challengeRouteContext`.

### Resume Behavior

Resume uses persisted execution state plus cache-aware expanded reroute when needed. `detect_inflight_tasks()` reads `.wavemill/workflow-state.json`, `_restore_inflight_task_window_if_missing()` relaunches planning or coding from `.phase-config.json` first and task state second, and coding relaunch now refreshes `.post-expansion-route.json` through the expanded reroute helper before promoting it. Unchanged packets hit cache or reuse the existing artifact; changed packets reroute fresh.

### Eval Artifact Archival

`archive_stage_artifacts()` copies `features/<slug>/.initial-route.json` to `.wavemill/evals/artifacts/<issue>/initial-route.json`, `features/<slug>/.routing-complete` to `.wavemill/evals/artifacts/<issue>/routing-complete.json`, and `features/<slug>/.post-expansion-route.json` to `.wavemill/evals/artifacts/<issue>/post-expansion-route.json`. Eval loading prefers live worktree artifacts and falls back to the archive copy so later summaries can compare bootstrap, expanded, and active execution routes after worktree cleanup.

## Route Read/Write Audit

| Location | File / function | R/W | Current stage | Purpose |
| --- | --- | --- | --- | --- |
| `/tmp/${SESSION}-${ISSUE}-route.json` | `shared/lib/wavemill-mill.sh::apply_route_json_for_issue`, startup route calls, `read_route_json()` in `shared/lib/wavemill-common.sh` | read + write | startup, dynamic launch, challenge prep | Session-scoped bootstrap route artifact used during launch before worktree routing state exists. It is not the only canonical route artifact for downstream scoring. |
| `/tmp/${SESSION}-${ISSUE}-model-suggestion.json` | `shared/lib/wavemill-mill.sh` startup/dynamic compatibility writes, `read_route_json()` fallback | read + write | startup compatibility | Deprecated coder-only fallback shim for older consumers. |
| `/tmp/${SESSION}-${ISSUE}-route-source.txt` | `shared/lib/wavemill-mill.sh::apply_route_json_for_issue`, `launch_task()` | read + write | startup, dynamic launch | Records whether the current `/tmp` bootstrap route came from batch cache, startup cache, or live routing. |
| `/tmp/${SESSION}-route-batch-input.jsonl` and `/tmp/${SESSION}-route-batch-output.jsonl` | `shared/lib/wavemill-mill.sh` startup batch routing | write + read | startup | Batch bootstrap routing inputs and outputs for concurrent startup launch. |
| `/tmp/${SESSION}-dynamic-route-batch-input.jsonl` and `/tmp/${SESSION}-dynamic-route-batch-output.jsonl` | `shared/lib/wavemill-mill.sh::batch_route_selected_tasks` | write + read | dynamic multi-select | Batch bootstrap routing inputs and outputs for interactive launch. |
| `/tmp/${SESSION}-${ISSUE}-expanded-reroute-input.jsonl` and `/tmp/${SESSION}-${ISSUE}-expanded-reroute-output.jsonl` | `shared/lib/wavemill-mill.sh::reroute_expanded_packets_for_coding_handoff` | write + read | planning handoff, coding resume | Batch expanded reroute inputs and outputs for approved task packets before coding promotion. |
| `features/<slug>/.routing-complete` | `shared/lib/wavemill-startup-runner.sh`, `shared/lib/wavemill-mill.sh::launch_task`, `shared/lib/wavemill-common.sh::apply_expanded_route_if_present`, `shared/lib/eval-context-gatherer.ts` | read + write | post-bootstrap, coding handoff, resume, eval | Feature-local authoritative execution route. Starts as bootstrap and is overwritten with the expanded route after successful promotion. |
| `features/<slug>/.initial-route.json` | `shared/lib/wavemill-startup-runner.sh`, `shared/lib/wavemill-mill.sh::launch_task` | write | startup, dynamic launch | Explicit bootstrap provenance snapshot captured before expansion. |
| `features/<slug>/.post-expansion-route.json` | `tools/prompts/planning-phase.md`, `shared/lib/wavemill-common.sh::apply_expanded_route_if_present`, archived by `archive_stage_artifacts()` | write + read + archive | planning completion, coding handoff, resume, eval provenance | Preferred expanded-packet route snapshot captured after task-packet expansion. |
| `.wavemill/state/expanded-route-cache.json` | `shared/lib/expanded-route-cache.ts`, `shared/lib/route-batch.ts::routeExpandedPackets` | read + write | planning handoff, coding resume | Operating-mode-gated cache of expanded routing decisions keyed by packet hash and input version. |
| `features/<slug>/.expanded-route.json` | legacy/manual producers, `shared/lib/wavemill-common.sh::apply_expanded_route_if_present` | read | coding handoff, resume | Backward-compatible fallback expanded-route artifact when `.post-expansion-route.json` is absent. |
| `features/<slug>/.phase-config.json` | `shared/lib/wavemill-mill.sh::write_phase_config`, `read_phase_config`, resume helpers, `shared/lib/wavemill-common.sh::apply_expanded_route_if_present` | read + write | planning handoff, coding, review, resume | Resolved per-stage execution settings used by downstream phase launches. Rewritten from the authoritative execution route before coding begins. |
| `.wavemill/workflow-state.json` | `save_task_state()`, `set_task_phase()`, `get_task_meta()`, resume helpers, `shared/lib/wavemill-common.sh::apply_expanded_route_if_present` | read + write | launch, phase transitions, resume, challenge | Durable task ledger for planner/coder/reviewer models, depths, review mode, challenge metadata, PR state, and active phase. Expanded-route promotion updates the execution fields in place. |
| `.wavemill/evals/artifacts/<issue>/routing-complete.json` | `archive_stage_artifacts()`, `eval-context-gatherer.ts` | read + write | cleanup, post-run eval | Archived copy of the current feature-local routing decision used by eval context loading. |
| `.wavemill/evals/artifacts/<issue>/initial-route.json` | `archive_stage_artifacts()` | read + write | cleanup, post-run eval provenance | Archived bootstrap snapshot retained for bootstrap-versus-expanded comparisons after worktree cleanup. |
| `.wavemill/evals/artifacts/<issue>/post-expansion-route.json` | `archive_stage_artifacts()` | write | cleanup, provenance | Archived expanded-route snapshot retained for later route-drift analysis, but not loaded as the active routing decision today. |

## Target Lifecycle

### Bootstrap Route

The bootstrap route is the route produced from raw Linear issue fields, `selected-task.json`, or any other pre-expanded packet representation. It exists only to launch planning and early challenge preparation.

If a Linear description already contains unusually rich detail, the route is still a bootstrap route until planning completes and a post-expansion route is captured.

### Expanded Route

The expanded route is the route produced from `task-packet.md` after planning expansion and saved as `.post-expansion-route.json`. If that file does not exist, the controller may use `.expanded-route.json` as a backward-compatible fallback.

Expanded route artifacts may additionally include:

- `cache_hit`
- `route_source` with values `cache`, `batch`, or `single`
- `packet_hash` as a 64-character SHA-256 hex digest

If planning fails, expansion is incomplete, or the discovered expanded-route artifact is malformed or missing required execution fields, no promotion occurs. The controller emits an `expanded route invalid` warning and execution remains on the previously persisted bootstrap route.

## Route Lifecycle Logs

Operator-facing routing logs use the stable prefix `route.lifecycle:`. Dashboards and parsers should key on the prefix plus `event=...`, not on older free-form phrases such as `Workflow route recovered from batch cache`.

Current event names:

- `bootstrap_assigned`: bootstrap route persisted to `.routing-complete` and `.initial-route.json`
- `expanded_assigned`: valid expanded route promoted or confirmed for execution
- `expansion_cache_hit`: expanded reroute reused cached packet-hash output
- `expansion_skipped`: expanded reroute skipped — `reason=disabled`, `reason=not_eligible`, or `reason=routing_error_using_existing_artifact` (routing call failed but a pre-existing artifact was found and used)
- `expansion_failed`: expanded reroute or promotion failed with `reason=routing_error`, `reason=invalid_artifact`, or `reason=cache_error`
- `execution_active`: route actually used for coding execution, with `source=bootstrap|expanded|preserved`

Common fields:

- `issue=<LINEAR_ID>`
- `route="coder=...,codeDepth=...,reviewer=...,reviewMode=..."`
- `bootstrap_route="..."`
- `expanded_route="..."`
- `active_route="..."`
- `route_changed=true|false`
- `packet_hash=<sha256>`
- `source=batch|single|cache|bootstrap|expanded|preserved`

## Expansion Handshake Gate

At plan-to-code transition, the controller now enforces an expansion handshake:

- If `task-packet.md` already looks like a full task packet, the transition passes.
- If it is raw issue text, the controller looks for a valid expanded route artifact before coding.
- If the artifact is missing, the default policy now attempts one automatic recovery by re-running issue expansion locally, rerouting the recovered packet, and promoting the resulting expanded route before coding starts.
- If that one recovery attempt fails, mill records the failed attempt and proceeds with the existing bootstrap route instead of stranding the approved plan.
- If the artifact exists but is malformed or missing required execution fields, the transition still blocks by default because that indicates corrupted controller state rather than missing preparation.

Policy is controlled by `.wavemill-config.json`:

```json
{
  "mill": {
    "expansionHandshake": {
      "policy": "recover"
    }
  }
}
```

Policies:

- `recover` (default): try one missing-artifact recovery, then fall back to the bootstrap route if recovery fails.
- `block`: preserve the original fail-closed behavior for missing artifacts.
- `warn`: log and continue immediately without recovery.

When blocked, the controller logs the artifact reason and clears `.plan-approved` so resume does not auto-advance. Manual recovery flow remains available:

1. Run `wavemill expand <ISSUE>`.
2. Re-approve planning by touching `.plan-approved`.

### Authoritative Execution Route

The authoritative execution route is the route consumed by coding, review, resume, challenge follow-on behavior, and eval context that claims to represent the execution workflow.

- Before expansion succeeds, the authoritative execution route is the bootstrap route.
- After expansion succeeds, the authoritative execution route must equal the expanded route.
- `FORCE_MODEL` remains a higher-priority operator override than either persisted route.

## Authoritative Promotion Point

The required promotion point is the planning-to-coding controller handoff in `shared/lib/wavemill-mill.sh` when the `planning)` branch sees `resolved_phase == "coding"`.

Ordering at that handoff:

1. Validate planning output and approval state.
2. Refresh eligible expanded packets through the batch/cache reroute helper.
3. If `.post-expansion-route.json` or `.expanded-route.json` is valid, promote it to the authoritative execution route, preferring `.post-expansion-route.json`.
4. Persist that promoted route into the execution-state surfaces used by later phases.
5. Only then read coding model and depth.
6. Only then call `set_task_phase "$ISSUE" "coding"`.
7. Only then call `launch_coding_phase()`.

Promotion updates the surfaces that coding, review, resume, and eval treat as execution state: `.routing-complete`, `.phase-config.json`, and `.wavemill/workflow-state.json`.

## Field Mutability

### Immutable / Provenance Fields

| Classification | Fields | Contract |
| --- | --- | --- |
| immutable | issue id, slug, original Linear issue id, bootstrap snapshot in `.initial-route.json`, challenge pair identity | Expansion must not rewrite bootstrap evidence or pair identity. |
| mutable-after-expansion | planner, coder, reviewer, planDepth, codeDepth, reviewRecommended or reviewMode, expectedSuccess, confidence, expectedCost, routingMode, neighborCount, signals, reasoning, challengeRecommendation | These fields may change when the richer task packet changes the route. |
| derived | resolved agent commands, `.phase-config.json` stage blocks, task-state execution fields, eval conversion fields | These should be regenerated from the authoritative execution route rather than treated as independent source-of-truth inputs. |

Special case: challenge entries may intentionally keep distinct coder models for primary and challenger. Expanded-route promotion must not erase challenge identity. Unless a future implementation explicitly changes that rule, planner, reviewer, and depth values for both sides should follow the authoritative execution route while challenger coder override remains allowed.

## Resume And Archival Contract

Resume should reconstruct active execution from the authoritative route persisted in `.phase-config.json` and `.wavemill/workflow-state.json`, while retaining `.initial-route.json` and `.post-expansion-route.json` as provenance artifacts.

Resume should not re-run expensive expanded routing for unchanged packets. It may refresh the expanded route helper on coding relaunch, but unchanged packets must reuse the persisted artifact or the expanded-route cache by `packet_hash` and operating mode.

Eval archival now retains `initial-route.json`, `routing-complete.json`, and `post-expansion-route.json` so later analysis can compare bootstrap-to-expanded drift without a live worktree.

Eval schema `1.18.0` adds optional `routeProvenance`:

```json
{
  "routeProvenance": {
    "bootstrapRoute": { "coder": "…", "codeDepth": "…", "reviewer": "…", "reviewMode": "…" },
    "expandedRoute": { "coder": "…", "codeDepth": "…", "reviewer": "…", "reviewMode": "…" },
    "activeRoute": { "coder": "…", "codeDepth": "…", "reviewer": "…", "reviewMode": "…" },
    "decisionSource": "expanded",
    "stageRoutes": {
      "planner": { "hokusai": { "requestId": "…", "recommended": "…" }, "executed": "…", "overrides": [] },
      "coder": {
        "hokusai": { "requestId": "<inference_log_id>", "decisionId": "…", "recommended": "claude-haiku-4-5" },
        "executed": "claude-opus-5-5",
        "overrides": [
          { "source": "escalation", "from": "claude-haiku-4-5", "to": "glm-5.3-flash", "reason": "hokusai_reask_below_floor", "at": "…",
            "triggers": [{ "metric": "confidence", "value": 0.334, "threshold": 0.4 }], "hokusai": { "requestId": "<re-ask inference_log_id>" } },
          { "source": "operator", "from": "glm-5.3-flash", "to": "claude-opus-5-5", "reason": "operator_force_reroute", "at": "…" }
        ]
      },
      "reviewer": { "executed": "…", "overrides": [] }
    },
    "hokusaiInferenceLogId": "<inference_log_id>",
    "expandedCacheHit": false,
    "packetHash": "<sha256>",
    "routeSource": "batch"
  }
}
```

`stageRoutes` is the one per-stage route record (HOK-3363, `shared/lib/route-override-record.ts`): what Hokusai recommended, what executed, and every override in between (`escalation`, `launchability`, `challenge`, `operator`). It replaces the retired `routeChanged` flag (still accepted on legacy records, never written), `preEscalationRoute`, `launchabilitySubstitutions` and `provenance.escalation`. The PR stamp (`route_decision.overrides`, `route_schema` 3) and the queued Hokusai contribution row (`inputs.inference_log_id` + `route_override_*`) read it.

## Current Vs Target Summary

| Surface | Current behavior | Target behavior |
| --- | --- | --- |
| startup runner | Writes bootstrap route to `.routing-complete` and `.initial-route.json` before planning. | Same bootstrap behavior, but clearly scoped as planning-launch input and provenance. |
| dynamic launch | Uses `/tmp` route cache or live route on raw/minimal packet, then writes `.routing-complete` and `.initial-route.json`. | Same bootstrap capture, followed by later promotion if expansion succeeds. |
| planning expansion | Writes `.post-expansion-route.json` only. | Writes `.post-expansion-route.json`, and the controller promotes it before coding/review execution begins. |
| expanded reroute | Single-task planner-owned route write. | Controller-owned cache-aware reroute that batches misses, falls back per-task, and tags artifacts with `cache_hit`, `route_source`, and `packet_hash`. |
| coding and review launch | Read `.phase-config.json` or task state, which may still reflect bootstrap routing. | Read authoritative execution state derived from the promoted expanded route. |
| challenge mode | Uses launch-time route and persists challenge-specific overrides. | Preserve distinct coder identities, refresh or preserve the pair from explicit bootstrap-versus-expanded routing context, and record the decision source for evals. |
| resume | Relaunches from `.phase-config.json` or task state, even if they still hold bootstrap values. | Relaunches from the promoted authoritative route, keeping bootstrap and expanded artifacts only as provenance. |
| eval archival | Archives both `.routing-complete` and `.post-expansion-route.json`, but loads only `.routing-complete` as routing decision. | Preserve both artifacts and make the bootstrap-versus-expanded distinction explicit for later analysis. |
