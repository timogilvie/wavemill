# Queue-Health Monitoring

## Overview

Queue-health tracks the reliability and state of the dependency-aware queue planner subprocess. When the planner fails or times out, queue-health records the failure with semantic cause, process metadata, bounded diagnostics, and a backoff policy to prevent repeated planner attempts during degradation.

Since HOK-3130 it also tracks whether **dependency inference** (the LLM queue classifier behind inferred edges) actually answered. A planner exit of 0 alone is not enough: before HOK-3130 the classifier could fail on every run while health still said `healthy` with zero inferred edges.

## File Location

Queue-health state is persisted at:

```
.wavemill/queue-health.json
```

This is a sibling to `workflow-state.json` and is created on first use.

## Schema

The queue-health file is a JSON object with additive compatibility. Fields can be added without breaking existing readers.

### Full Schema Example

```json
{
  "schemaVersion": 1,
  "status": "healthy",
  "lastSuccessfulPlanAt": "2026-07-30T21:00:00Z",
  "lastAttemptAt": "2026-07-30T21:01:00Z",
  "lastFailureAt": null,
  "episodeStartedAt": null,
  "degradationReason": null,
  "failureStep": null,
  "failureCount": 0,
  "retryBackoffSeconds": 0,
  "nextRetryAt": null,
  "nextAction": "use_dependency_queue",
  "planner": {
    "pid": 12345,
    "pgid": 12345,
    "timeoutSeconds": 60,
    "startedAt": "2026-07-30T21:01:00Z",
    "endedAt": "2026-07-30T21:01:02Z",
    "durationMs": 2000,
    "exitCode": 0,
    "signal": null,
    "cancellationOwner": null
  },
  "diagnostics": {
    "inputSnapshot": {
      "taskCount": 12,
      "explicitDependencyCount": 4,
      "cacheKey": "wavemill"
    },
    "stdoutExcerpt": "",
    "stderrExcerpt": ""
  },
  "inferenceStatus": "ok",
  "inferredEdgeCount": 3,
  "inference": {
    "model": "claude-haiku-4-5-20251001",
    "lastAttemptAt": "2026-09-30T12:00:00.000Z",
    "lastSuccessAt": "2026-09-30T12:00:00.000Z",
    "consecutiveFailures": 0,
    "error": null,
    "refreshKind": "partial",
    "skipReason": null
  }
}
```

### Field Descriptions

#### Status Tracking

- **schemaVersion**: Integer version of this schema (currently 1).
- **status**: Current state: `"healthy"` or `"degraded"`.
- **lastSuccessfulPlanAt**: ISO 8601 timestamp of the last successful queue plan completion.
- **lastAttemptAt**: ISO 8601 timestamp of the most recent planner launch attempt (success or failure).
- **lastFailureAt**: ISO 8601 timestamp of the most recent planner failure, or null if healthy.

#### Degradation Episode

- **episodeStartedAt**: ISO 8601 timestamp when the current degradation episode began. Set when the first failure in an episode occurs; reset to null when status returns to healthy.
- **degradationReason**: Semantic reason for degradation (see taxonomy below).
- **failureStep**: Step name from planner workflow (e.g., `"plan_queue_failed"`, `"validation_failed"`).
- **failureCount**: Number of consecutive failures in the current episode.
- **retryBackoffSeconds**: Seconds to wait before the next planner attempt. When > 0, the monitor skips launching the planner until `nextRetryAt`.
- **nextRetryAt**: ISO 8601 timestamp when the next planner attempt will be made (after backoff expires).
- **nextAction**: Human-readable hint for the next action: `"use_dependency_queue"`, `"retry_after_backoff"`, etc.

#### Process Metadata

- **planner.pid**: Process ID of the planner subprocess (or null if not captured).
- **planner.pgid**: Process group ID (or null if process group could not be established, e.g., on some macOS versions).
- **planner.timeoutSeconds**: Timeout duration configured for the planner.
- **planner.startedAt**: ISO 8601 timestamp when the planner process was launched.
- **planner.endedAt**: ISO 8601 timestamp when the planner process exited or was terminated.
- **planner.durationMs**: Milliseconds from start to end.
- **planner.exitCode**: Exit code returned by the planner process.
- **planner.signal**: Signal number if the process was terminated by signal (or null for normal exit).
- **planner.cancellationOwner**: Who terminated the process: `"queue_plan_timeout"` (watchdog fired), or null if process exited normally.

#### Diagnostics

- **diagnostics.inputSnapshot**: Summary of input to the planner (task count, dependency count, cache key).
- **diagnostics.stdoutExcerpt**: First 512 characters of planner stdout (redacted).
- **diagnostics.stderrExcerpt**: First 512 characters of planner stderr (redacted).

#### Dependency Inference (HOK-3130)

- **inferenceStatus**: `ok` | `failed` | `stale` | `never`, or null when the planner ran without a cache (no report). `failed` is sticky until the next success; `never` means no recorded success (including caches written before HOK-3130); `stale` means the last success is older than 24h.
- **inferredEdgeCount**: Inferred (cache-sourced) edges used by the last plan. Explicit Linear relations are not counted.
- **inference.model**: Model that actually answered on the last success.
- **inference.consecutiveFailures**, **inference.error**: Repeated-failure count and the first line of the last classifier error.
- **inference.refreshKind** / **inference.skipReason**: `full` | `partial` | `none`, and why a run skipped inference (`cooldown`, `no_changes`, `cache_disabled`).

These fields come from the report `tools/plan-queue.ts --inference-report-file <path>` writes; the monitor merges it through `queue_health_record_success`. The planner persists the underlying state in the `inference` block of `.wavemill/cache/task-dependency-plans/<project>.json`.

## Degradation Reason Taxonomy

Failure classifications:

- **timeout**: Watchdog timer fired; planner exceeded configured timeout.
- **external_cancellation**: Process received SIGTERM (exit code 143) without watchdog firing; terminated by external process.
- **planner_error**: Planner process exited with nonzero status; not a timeout or cancellation.
- **malformed_graph**: Dependency graph contains a cycle or the planner detected invalid structure.
- **invalid_input**: Input massaging (jq) or dependency extraction failed.
- **empty_queue**: No tasks in backlog.
- **diagnostics_setup_failed**: Could not allocate temp files for capturing diagnostics.
- **inference_unavailable**: The planner succeeded, but `inferenceStatus` is `failed`, `stale`, or `never`. `failureStep` is `queue_inference` and `nextAction` is `use_explicit_edges_only`. The plan (explicit edges only) is still used; no planner backoff is set, `failureCount` stays 0, and `lastSuccessfulPlanAt` still advances.

### Inference refresh and cooldown

- The mill runs `plan-queue --refresh-missing-cache`. A **full** refresh classifies the whole backlog when the cache has no fingerprints, every task changed, or the status is `never`/`stale` (or `failed` with nothing pending). A **partial** refresh covers only new or changed tasks.
- A failed refresh keeps the *previous* fingerprints, so unclassified tasks are retried instead of being marked as analyzed. It also starts a 10-minute cooldown, during which inference is skipped (`skipReason: cooldown`) and the status stays `failed`.
- The classifier ladder only attempts models the Claude CLI transport can serve. It uses the CLI's own login, not `ANTHROPIC_API_KEY`. Skipped rungs are logged as `[classifier] <model> skipped (transport claude-cli cannot serve vendor deepseek)`.

## Backoff Policy

When a planner failure occurs:

1. **First failure in episode**: `episodeStartedAt` is set to the current timestamp; `failureCount = 1`.
2. **Subsequent failures**: `failureCount` increments; `retryBackoffSeconds` follows exponential backoff:
   - Failure 2: 15s
   - Failure 3: 30s
   - Failure 4: 60s
   - Failure 5: 120s
   - Failure 6+: 300s (capped)
3. **During backoff**: Monitor checks `queue_health_should_skip_attempt` before launching planner; if in backoff, skips and returns degraded status without launching.
4. **Recovery**: When a planner succeeds, `status` returns to `"healthy"`, `episodeStartedAt` is cleared, and backoff resets.

## Dashboard Warning

When queue-health status is `"degraded"`, the dashboard renders a single-line warning:

```
├─ WARN: queue planning degraded: timeout; flat fallback active; retry in 14s
```

The warning is produced by `queue_health_dashboard_warning()` in `wavemill-status.sh` and deduplicates naturally by rendering current state (not by appending logs).

For `inference_unavailable` the backstage line reads `Queue: degraded (inference_unavailable: failed)` and the warning reads:

```
├─ WARN: queue inference unavailable (failed); planning with explicit edges only; last error: …
```

When healthy with a report, the backstage line shows the edges in use: `Queue: healthy (inferred 3)`. The monitor also logs one `queue inference unavailable (<status>)` warning per status transition (deduplicated with `$STATE_DIR/.queue-inference-warn`).

## Dependency-Safety Fallback

When the planner is degraded:

- Monitor falls back to flat task list (`avail_unblocked`), sorted by Linear state and score.
- Flat mode only selects and launches tasks that have no blockers (dependency-safe).
- Grouped dependency-aware rendering is unavailable; blocked tasks are hidden or marked.
- Stale `QUEUE_PLAN_CACHE` is not used if queue-health status is degraded at plan time.

This ensures no blocked work is launched accidentally when dependency ordering is unavailable.

## Observer Integration (HOK-2595)

The observer reads `queue-health.json` from each repo and creates a structured finding when `status == "degraded"`:

- **id**: Derived from session + `episodeStartedAt` to deduplicate by episode.
- **severity**: `"high"` if `failureCount >= 5`, `"medium"` if >= 3, `"low"` otherwise.
- **category**: `"warning"`.
- **title**: `"Queue planning degraded: {reason}"`.
- **evidence**: Includes episodeStartedAt, reason, failureCount, backoff, planner metadata, and stderr excerpt.

The observer also suppresses generic `"queue analysis unavailable"` log-warning findings for repos with an active queue-health finding, preventing duplicate tickets.

Finding IDs include the `episodeStartedAt` timestamp, so the same underlying episode does not spawn duplicate tickets even if the degradation persists across multiple observer runs.

## Startup and Resume

Queue-health file is initialized on first planner launch. If the file is missing or unreadable:

- Monitor treats the state as unknown/healthy and attempts a planner launch.
- No error is raised; backward compatibility is preserved.

When the monitor restarts after a crash or manual stop:

- Queue-health state is preserved. If in backoff, the monitor respects the backoff window on resume.
- This prevents hammering the planner immediately after restart if it failed repeatedly before the stop.

## Usage in Code

### Shell (wavemill-mill.sh)

```bash
# Initialize queue-health file
queue_health_init

# Check if should skip planner due to backoff
if queue_health_should_skip_attempt; then
  # Skip attempt, return degraded
fi

# Record successful plan (optional 5th arg: plan-queue inference report JSON)
queue_health_record_success "$pid" "$pgid" "$duration_ms" "$command" "$inference_report_json"

# Record failed plan
queue_health_record_failure "$reason" "$step" "$pid" "$pgid" \
  "$timeout_secs" "$exit_code" "$signal" "$cancellation_owner" \
  "$stdout_excerpt" "$stderr_excerpt" "$input_snapshot"
```

### TypeScript (observer.ts)

Queue-health is read from disk during repo analysis:

```typescript
if (repo.queueHealth && repo.queueHealth.status === 'degraded') {
  // Create finding for degraded queue planning
}
```

### Dashboard (wavemill-status.sh)

```bash
if queue_health_warning="$(queue_health_dashboard_warning "$STATE_FILE" 2>/dev/null)"; then
  printf "${D}├─ WARN: %s${N}${EL}\n" "$queue_health_warning" >> "$FRAME"
fi
```

## Backward Compatibility

The schema is additive. Readers should use `.foo // default_value` when accessing optional fields.

If the queue-health file does not exist, the monitor treats it as healthy and initializes it on first use.

Missing fields are interpreted as defaults (e.g., missing `status` = `"healthy"`).

## Troubleshooting

### Zero inferred edges while healthy

Check `jq '.inferenceStatus, .inferredEdgeCount, .inference' .wavemill/queue-health.json`. `ok` with 0 edges is an explicit empty answer from the model. Anything else is `inference_unavailable`: look for `[classifier]` lines in the mill log (a skipped or unavailable model, a timeout) and confirm the Claude CLI is logged in on the mill host.

### High Failure Count

If `failureCount` is high (>= 5), the backoff has reached the 300s cap. The planner is failing consistently.

**Action**: Inspect the dependency graph for cycles or invalid task data. Check recent Linear issue changes. Verify planner process is not blocked by resource constraints.

### External Cancellation

If `planner.cancellationOwner` is null but exit code is 143, the planner was terminated by an external process (not the watchdog).

**Action**: Check system resource usage (memory, CPU, file descriptors). Inspect concurrent processes for resource contention.

### Malformed Graph

If `degradationReason == "malformed_graph"`, the dependency extraction or cycle detection failed.

**Action**: Export the planner input from `diagnostics.inputSnapshot` and test the planner offline:

```bash
jq --argjson snapshot "$snapshot" '...' | npx tsx tools/plan-queue.ts --stdin --json
```

### Timeout

If `degradationReason == "timeout"`, the planner exceeded `planner.timeoutSeconds`.

**Action**: Check if the backlog is unusually large or if the planner has a performance regression. Verify the machine has adequate memory for the backlog size.

## See Also

- `shared/lib/queue-health.sh` — Helper functions and schema.
- `shared/lib/wavemill-mill.sh` — Planner lifecycle and integration points.
- `tools/observer.ts` — Observer queue-health analysis and deduplication.
- `shared/lib/wavemill-status.sh` — Dashboard warning rendering.
- HOK-2595 — Incident detection and correlation system.
