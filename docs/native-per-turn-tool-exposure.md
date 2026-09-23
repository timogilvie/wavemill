# Per-turn tool exposure and menu provenance

**Status:** Shipped by HOK-3054 (Epic 10.2). Builds on HOK-3053 (Epic 10.1) —
the advanced-tool exposure engine, family taxonomy, and certification
snapshot.

## Why

The registry filters tools at lookup time, but the loop used to materialize
Pi's tool list *once per launch* and never record what was actually sent per
turn. Two artifacts are needed to make that provenance auditable:

1. **`tool_menu`** — the *logical* policy-eligible menu (names, families,
   logicalIds, phases, provenance, cert requirement). Stable across provider
   wording churn.
2. **`provider_tools`** — the exact provider-visible schemas Pi will send this
   turn (name, description, label, executionMode, parameters). Byte-stable for
   identical inputs.

Both are digested with SHA-256 and attached to every `model_request` event.
This lets HOK-2076 join per-turn decisions against the actual menu each
decision was made from, without needing to replay the launch.

## Two-artifact contract

### Logical menu — `tool_menu` event

Canonical form (sorted keys, registration order):

```json
[
  {
    "allowedPhases": ["planning"],
    "certificationRequirement": "none",
    "class": "read-only",
    "exposure": "always",
    "family": "core",
    "logicalId": "core.read_file",
    "name": "read_file",
    "provenance": "repo-trusted"
  }
]
```

Logical entries omit `description`, `label`, and `parameters` — those belong
to the provider view. Splitting them means the logical digest survives wording
changes.

### Provider menu — `provider_tools` event

Canonical form (sorted keys, registration order):

```json
[
  {
    "description": "...",
    "executionMode": "sequential",
    "label": "read_file",
    "name": "read_file",
    "parameters": { ... typebox schema in canonical form ... }
  }
]
```

Parameters are serialized via `JSON.parse(JSON.stringify(...))` then
canonicalized so nested key order does not change the digest.

Both digests are `sha256(canonical)`. Both event payloads carry an
`artifactRef` when the canonical form exceeds the inline limit (default 8
KiB); the digest is always inline on the event itself.

## Loop contract

`WavemillLoopConfig.menuProvider` is the single seam:

```ts
menuProvider?: {
  resolveForTurn(input: {
    turnIndex: number;
    terminalSynthesis: boolean;
  }): {
    toolMenu: { canonical, digest, toolNames, byteSize };
    providerTools: { canonical, digest, toolCount, toolNames, byteSize };
  };
};
```

For every turn the loop:

1. Calls `resolveForTurn({ turnIndex, terminalSynthesis })`. The
   `terminalSynthesis` flag is set when the loop has just rewritten the
   next-turn tool list to `[]` for tool-free synthesis.
2. Compares `providerTools.toolNames` against the names of the tools it is
   about to hand Pi. Mismatch throws `ProviderToolMenuDriftError` — the run
   fails rather than silently record a wrong menu.
3. Emits `tool_menu` and `provider_tools` events, then writes `model_request`
   with both digests attached.

**Backward compat:** with `menuProvider` omitted, the loop still emits
`model_request` (no digest fields, no menu events) exactly as before HOK-3054.
Callers that do not opt in observe no behavioral difference.

## Launch integration

`shared/lib/native-agent/tools/menu-resolver.ts` exports
`createLaunchMenuProvider({ phase, config, certification, descriptors })`. All
three launch sites use it:

- `launch-planning.ts` — `phase: 'planning'`
- `launch-coding.ts` — `phase: 'coding'`
- `review.ts` — `phase: 'review'`

The provider returns:

- `initialMenu` — for building `AgentContext.tools`,
- `providerToolsForContext` — the mutable snapshot to set on the loop context,
- `menuProvider` — the loop-facing hook. Non-terminal turns return the same
  digests; the terminal-synthesis turn re-resolves with an empty provider
  override so its digest reflects the empty tool list Pi actually sees.

`inferCertificationSnapshotForPhase` derives the exposure engine's
`maxCertifiedPhase` from the phase gate a ready provider must satisfy
(`planning → workflow`, `coding → patch`, `review → read-only`). A
`loopModelOverride` with no certification falls back to `'none'`, which denies
every advanced-family tool.

## Failure mode: menu drift

If the resolver's `providerTools.toolNames` diverges from what the loop is
about to send, `ProviderToolMenuDriftError` is thrown from the turn boundary
and re-raised from `runWavemillLoop`. The error carries `turnIndex`,
`expected`, and `resolved` so operators can diagnose whether the drift came
from a stale menu closure, an in-loop context mutation the resolver did not
model, or a launch that mis-wired `context.tools`. There is no silent-log
path.

## Fixtures

Six byte-stable fixtures live under
`shared/lib/native-agent/fixtures/menu/`:

- `planning-menu.json`, `coding-menu.json`, `review-menu.json` — non-empty
  menus for the three phases.
- `text-only-turn-menu.json` — a planning menu identical to `planning-menu`,
  covering the "assistant returns text on turn 1" case. Both digests must be
  present even when no tool call ever happens.
- `empty-menu.json` — all descriptors denied by certification. Confirms both
  digests still fire and the canonical form is exactly `[]`.
- `terminal-synthesis.json` — non-empty logical menu with an empty provider
  override. Verifies that terminal synthesis is representable as a distinct
  provider digest while sharing the same logical digest.

Regenerate with `WAVEMILL_UPDATE_MENU_FIXTURES=1 node --test
shared/lib/native-agent/tools/menu-resolver.test.ts`.

## Logical vs. proxy indirection

The task packet reserves headroom for a future proxy adapter (many logical
tools → one provider tool, or vice versa). This epic never introduces such
indirection: `chosen_logical_tool` and `chosen_provider_tool` will always
match in the transcripts written today. The resolver's return preserves both
`logical[i]` and `provider[i]` by name so a future adapter can add the map
without touching the event schema.

## Non-goals (explicit)

- No normalized decision corpus. HOK-2076 owns per-turn decisions +
  outcome joins + offline labels.
- No advanced executor beyond what the HOK-3053 registry already exposes.
- No new opt-in config keys. `nativeAgent.advanced.*` from HOK-3053 remains
  the only surface. `menuInlineMaxBytes` (default 8 KiB) is a code constant.

## Rollback

Revert the HOK-3054 commit. `menuProvider` is optional on
`WavemillLoopConfig`; the loop degrades to pre-3054 behavior when it is
absent. No config keys are removed. Descriptor construction sites in
launch-planning/launch-coding/review continue to work — the resolver just
becomes a no-op filter over already-eligible tools.
