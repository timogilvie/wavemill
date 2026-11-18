# Scope Stop Record Invariant

## Rule

Every review scope-guard refusal must record a typed `.review-scope-stop.json` finding through `writeMarker` before exiting. The prompt must never instruct the agent to wait, pause, or stop-but-not-exit on a scope stop.

## Rationale

This invariant prevents silent stalls where the review agent hits a scope guard, stops, and sits idle without the mill noticing. Previously this happened in incidents like HOK-3358 and HOK-3231 where tasks would park indefinitely waiting for operator intervention.

By ensuring that every scope stop is recorded as a typed finding and that the agent exits immediately, the mill can automatically route the task back to coding with the offending paths included in the next coding prompt. This creates a closed loop that eliminates manual operator intervention for scope changes.

## Implementation

The invariant is enforced by:

1. **Producer**: `tools/check-review-scope.ts` writes `.review-scope-stop.json` via `writeMarker` with `--expires-on head,operator-event` when exiting with code 1 due to a scope violation.

2. **Prompt**: `tools/prompts/review-phase.md` and `shared/lib/agent-adapters.sh` instruct the agent to exit 1 immediately rather than wait or stop review-fix committing.

3. **Consumer**: `shared/lib/wavemill-monitor.sh` reads the scope stop marker and classifies it as `code-failure` to return the task to coding.

4. **Guard**: `tools/check-scope-stop-record.ts` enforces the invariant through pattern matching in source files.

## Allowed Patterns

- "exit 1 immediately" - Approved phrasing for immediate exit on scope stop
- "Do NOT commit, do NOT wait, and do NOT retry — exit 1 immediately" - Complete instruction to exit immediately

## Forbidden Patterns

- "preserve the index, report the violation, and stop review-fix committing" - Old instruction that causes stalls
- "wait...scope" - Any phrase that tells the agent to wait on scope violations
- "pause" or "stop-but-not-exit" on scope violations - Instructions that don't lead to immediate exit

## References

- Related incidents: HOK-3358, HOK-3231
- Related tasks: HOK-3457 (this change), HOK-2890 (original remediation design)
