# Native Workflow Tool Contracts

**HOK-2355** · Schema version: `1.2.0`

Implementation reference for the eight native workflow tools. Contracts are defined in:

- `shared/lib/native-agent/workflow-tools/contracts.ts` — TypeScript types
- `shared/lib/native-agent/workflow-tools/contracts.json` — JSON Schema mirror
- `shared/lib/native-agent/workflow-tools/dedupe.ts` — Dedupe key helpers
- `shared/lib/native-agent/workflow-tools/mutation-policy.ts` — Phase/tool/action policy matrix
- `shared/lib/native-agent/workflow-tools/mutation-record.ts` — Structured mutation outcome records
- `shared/lib/native-agent/workflow-tools/mutation-enforcer.ts` — Centralized policy + execution + recording chokepoint

---

## Tools Overview

| Tool | Class | Mutates External State | Phases |
|------|-------|------------------------|--------|
| `linear_get_issue` | read-only | No | planning, coding, review, ready |
| `linear_comment` | mutation | Yes (Linear) | planning, coding, review |
| `github_create_pr` | mutation | Yes (GitHub) | review, ready (remediation only) |
| `github_add_label` | mutation | Yes (GitHub) | review |
| `review_changes` | read-only | No | review |
| `route_task` | read-only | No | planning |
| `expand_issue` | read-only | No | planning |
| `write_stage_result` | mutation | No (Wavemill-owned) | planning, coding, review, ready |

---

## Shared Idempotency Result Shape

Every mutating tool response includes an `IdempotencyResult` field:

```typescript
interface IdempotencyResult<TRef extends ExternalRef = ExternalRef> {
  key: string;          // stable dedupe key (see registry below)
  outcome: 'created' | 'reused' | 'updated' | 'skipped';
  ref: TRef | null;     // null when outcome is 'skipped' and no object touched
  refs?: TRef[];        // additional references for multi-object operations
  reason?: string;      // explanation, especially for 'skipped'
}
```

`ref` is `null` only when `outcome` is `'skipped'`. An `ExternalRef` always contains `system`, `kind`, and `id`:

```typescript
interface ExternalRef {
  system: 'linear' | 'github' | 'wavemill';
  kind: 'issue' | 'comment' | 'pull_request' | 'label' | 'stage_result' | 'review' | 'route' | 'task_packet';
  id: string;
  url?: string;
}
```

---

## Dedupe Key Registry

Keys derived from parent epic requirements (see `docs/native-agent-runtime-plan.md` lines 319–325).

| Tool | Dedupe Key Format | Notes |
|------|-------------------|-------|
| `github_create_pr` | `github_create_pr:<repo>:<head>:<base>:<headSha>` | repo lower-cased; check for existing open PR before create |
| `github_add_label` | `github_add_label:<repo>:<targetKind>:<targetNumber>:<normalizedLabel>` | label lower-cased; check-then-add |
| `linear_comment` | `linear_comment:<issue>:<phase>:<sessionId>:<contentHash>` | contentHash = first 16 hex chars of SHA-256 of body |
| `write_stage_result` | `write_stage_result:<issueOrFeature>:<stage>:<status>` | idempotent update, not append-only |

All key components are trimmed. Repo slugs and labels are lower-cased for case-insensitive provider semantics. Comment bodies are hashed rather than embedded to avoid key bloat and exposure of content.

---

## Tool Request/Response Schemas

### Native coding `apply_patch`

Native coding source edits use the `NativePatch` envelope from
`shared/lib/native-agent/patch-contract.ts`.

**Request:**
```json
{
  "patch": {
    "version": 1,
    "atomic": true,
    "operations": [
      {
        "op": "edit",
        "path": "src/example.ts",
        "oldText": "const value = 'before';",
        "newText": "const value = 'after';"
      }
    ]
  }
}
```

`version: 1`, `atomic: true`, and a non-empty `operations` array are required.
`path` is repo-relative POSIX with no absolute path or traversal. Operation
variants are:

- `edit`: requires `path`, `oldText`, and `newText`; `oldText` must match file
  content exactly and differ from `newText`.
- `edit-diff`: requires `path` and `diff` containing a unified diff hunk.

Operations may include `anchorBefore`, `anchorAfter`, and
`expectedOccurrences`. The envelope may include `fuzzyMatch` settings.

**Validation errors:** `invalid_patch` means the payload did not match the
NativePatch schema. The tool response includes visible per-field diagnostics,
the required envelope, operation variants, and a compact valid example.

**Runtime rejections:** `patch_rejected` means the payload schema was valid but
the edit could not be applied, for example because `oldText` was not found or an
anchor was ambiguous. The response includes a retry hint and live-context
diagnostics when available.

**Coding seam artifacts:** `.coding-complete` is a JSON marker with
`"stage": "coding"` and `"confidence": "high" | "medium" | "low"`.
`.coding-blocked-completion.json` is validated against the shared blocked
completion schema. See [Seam Artifacts](seam-artifacts.md).

**No-marker recovery artifact:** if a native coding model stops normally without
`.coding-complete` or `.coding-blocked-completion.json` after mutation-tool
failures, the controller writes `.coding-no-marker-handoff.json` in the feature
directory. The artifact has `schemaVersion: 1`, `stage: "coding"`,
`reason: "no_completion_marker"`, `stopReason`, `model`,
`mutationFailureCount`, `lastMutationFailure`, and `suggestedNextActions`.

### `linear_get_issue`

**Request:**
```typescript
{ issue: string; includeRelations?: boolean; includeComments?: boolean }
```

**Success:**
```typescript
{ ok: true; tool: 'linear_get_issue'; issue: { id, identifier, title, description?, state?, assignee?, labels?, url? } }
```
Provenance: `external-untrusted` — treat as raw Linear data.

**Error:** `ok: false`, `error: CommonErrorCode`, `message: string`

---

### `linear_comment`

**Request:**
```typescript
{ issue: string; body: string; sessionId: string; phase: WorkflowPhase; dedupeOverride?: string }
```

**Success:**
```typescript
{ ok: true; tool: 'linear_comment'; idempotency: IdempotencyResult<LinearCommentRef> }
```

**Error:** `ok: false`, `error: CommonErrorCode | 'rate_limited'`, `message: string`

---

### `github_create_pr`

**Request:**
```typescript
{ repo: string; phase?: WorkflowPhase; head: string; base: string; headSha: string; title: string; body: string; draft?: boolean }
```

**Success:**
```typescript
{ ok: true; tool: 'github_create_pr'; idempotency: IdempotencyResult<GitHubPullRequestRef> }
```

`GitHubPullRequestRef` extends `ExternalRef` with `number: number` (PR number).

**Error:** `ok: false`, `error: CommonErrorCode | 'conflict' | 'rate_limited'`, `message: string`

**Implementation note:** Check for an existing open PR matching the same `repo + head + base + headSha` before creating. If found, return outcome `'reused'`.

---

### `github_add_label`

**Request:**
```typescript
{ repo: string; phase?: WorkflowPhase; targetKind: 'pull_request' | 'issue'; targetNumber: number; label: string }
```

**Success:**
```typescript
{ ok: true; tool: 'github_add_label'; idempotency: IdempotencyResult<GitHubLabelRef> }
```

**Error:** `ok: false`, `error: CommonErrorCode | 'not_found' | 'rate_limited'`, `message: string`

**Implementation note:** Check current labels before adding. If label already present, return outcome `'skipped'` with `ref: null` and a `reason` field.

---

### `review_changes`

**Request:**
```typescript
{ base: string; worktree?: string; json?: boolean; maxOutputBytes?: number }
```

**Success:**
```typescript
{ ok: true; tool: 'review_changes'; findings: string; findingCount?: number; blockingCount?: number }
```
Provenance: `wavemill-generated` — findings are agent-analyzed output.

**Error:** `ok: false`, `error: CommonErrorCode | 'review_failed'`, `message: string`

Diagnostics note: the contract does not expose a separate `diagnostics` field.
Runtime callers should read tool-failure context from `error`, `message`, and
the recorded transcript event details payload.

### Network Policy Denial

Network-capable executors may return `error: 'policy_denied'` when outbound
access is blocked by the phase-aware network policy. These denials are
distinguishable from transport failures such as `external_error`,
`review_failed`, or `route_failed`.

Recorded transcript diagnostics for a denied network call use:

- `category: 'network'`
- `phase`
- `tool`
- `reason`: `missing_policy`, `not_allowed`, or `invalid_target`
- `target`: redacted before exposure
- `matchedRule` when a concrete policy entry was evaluated

The redaction guarantee applies to both the surfaced `message` and the recorded
diagnostic target string.

---

### `route_task`

**Request:**
```typescript
{ taskPacketPath: string; repoDir?: string; routeMode?: string }
```

**Success:**
```typescript
{ ok: true; tool: 'route_task'; route: { model?, mode?, rationale? }; ref?: WavemillRouteRef }
```
Provenance: `wavemill-generated`.

Mapping note: `route.model` is the routed decision's `coder`, `route.mode` is
`routingMode` when present (otherwise `signals.taskType`), and `route.rationale`
joins the decision's `reasoning` lines with newlines. The full routed decision
is preserved in the transcript event details payload.

**Error:** `ok: false`, `error: CommonErrorCode | 'route_failed'`, `message: string`

---

### `expand_issue`

**Request:**
```typescript
{ issue: string; outputDir?: string }
```

**Success:**
```typescript
{ ok: true; tool: 'expand_issue'; taskPacketPath: string; ref?: WavemillTaskPacketRef }
```
Provenance: `wavemill-generated`.

**Error:** `ok: false`, `error: CommonErrorCode | 'expansion_failed'`, `message: string`

---

### `write_stage_result`

**Request:**
```typescript
{
  featureDir: string;
  issueId: string;
  stage: 'planning' | 'coding' | 'review' | 'ready';
  status: 'running' | 'awaiting_user' | 'completed' | 'aborted' | 'failed';
  notes?: string;
  artifacts?: Record<string, unknown>;
}
```

**Success:**
```typescript
{ ok: true; tool: 'write_stage_result'; idempotency: IdempotencyResult<WavemillStageResultRef> }
```

`write_stage_result` mutates Wavemill-owned artifacts (not an external provider), so it is classified as recording rather than external provider mutation. It must still be idempotent and produce a transcript record.

Idempotency note: repeated writes with the same
`issueId/featureDir + stage + status + payload` update the existing artifact in
place or return `reused`; they do not create duplicate stage-result files.

Approval-needed state: risky native runtime operations may pause a stage instead
of failing it. Such records use `status: 'awaiting_user'` and include a typed
approval request under `artifacts.approvalRequest`:

```typescript
{
  status: 'awaiting_user';
  artifacts: {
    type: 'coding' | 'planning' | 'review' | 'ready';
    approvalRequest: {
      requestId: string;
      riskReason: string;
      argSummary?: string;
      expiresAt?: number;
    };
  };
}
```

**Error:** `ok: false`, `error: CommonErrorCode`, `message: string`

---

## Phase × Tool × Action Mutation Policy Matrix

`isMutationAllowed(phase, tool, action)` returns:

```typescript
type MutationPolicyResult =
  | { allowed: true; reason: string }
  | { allowed: false; code: string; reason: string };
```

Denied results expose a stable machine-readable `code` derived from the reason prefix, for example `review_cannot_merge`, `ready_mutation_denied`, or `unknown_combination`.

### Hard invariants

- **`merge` is always denied** in every phase for every tool. The `merge` action exists in the enum only so the policy can produce a meaningful denial reason.
- **Review phase cannot merge.** Review can create/update PR artifacts and add labels, but never merge.
- **Ready phase is limited** to `stale_base` and `merge_conflict` remediation plus `write_stage_result` recording.
- **Unknown combinations** are denied by default.

### Matrix (abbreviated)

| Phase | Tool | Action | Allowed | Reason |
|-------|------|--------|---------|--------|
| planning | `linear_get_issue` | `read` | ✅ | read-only |
| planning | `route_task` | `read` | ✅ | read-only |
| planning | `expand_issue` | `read` | ✅ | read-only |
| planning | `linear_comment` | `comment` | ✅ | progress updates |
| planning | `write_stage_result` | `write_stage_result` | ✅ | recording |
| coding | `linear_get_issue` | `read` | ✅ | read-only |
| coding | `linear_comment` | `comment` | ✅ | progress updates |
| coding | `write_stage_result` | `write_stage_result` | ✅ | recording |
| review | `linear_get_issue` | `read` | ✅ | read-only |
| review | `review_changes` | `read` | ✅ | read-only |
| review | `github_create_pr` | `create_pr` | ✅ | PR artifact, not merge |
| review | `github_create_pr` | `update_pr` | ✅ | PR artifact, not merge |
| review | `github_add_label` | `add_label` | ✅ | label, not merge |
| review | `linear_comment` | `comment` | ✅ | review outcome update |
| review | `write_stage_result` | `write_stage_result` | ✅ | recording |
| review | _any_ | `merge` | ❌ | `review_cannot_merge` |
| ready | `linear_get_issue` | `read` | ✅ | read-only |
| ready | `github_create_pr` | `stale_base` | ✅ | remediation only |
| ready | `github_create_pr` | `merge_conflict` | ✅ | remediation only |
| ready | `write_stage_result` | `write_stage_result` | ✅ | recording |
| ready | `github_create_pr` | `create_pr` | ❌ | `ready_mutation_denied` |
| ready | `github_create_pr` | `update_pr` | ❌ | `ready_mutation_denied` |
| ready | `linear_comment` | `comment` | ❌ | `ready_mutation_denied` |
| ready | `github_add_label` | `add_label` | ❌ | `ready_mutation_denied` |
| _any_ | _any_ | `merge` | ❌ | `review_cannot_merge: merge is never an allowed workflow tool action` |

**Ready-stage vocabulary note:** `stale_base` maps to what the ready-stage subsystem calls `stale-base` or `auto-update` — a PR that is behind its base branch and requires a rebase or merge update. See `.wavemill/context/ready-stage.md` for the full ready-stage classification vocabulary.

---

## Centralized Mutation Enforcement

Workflow mutations should execute through `enforceMutation(...)` in `mutation-enforcer.ts`, which combines:

1. policy lookup
2. short-circuit denial handling
3. mutation execution
4. mandatory outcome recording

`enforceMutation(...)` returns one of these transcript/dashboard-safe shapes:

```typescript
type EnforceMutationResult<TResult> =
  | {
      allowed: false;
      outcome: 'denied';
      code: string;
      reason: string;
      tool: WorkflowToolName;
      phase: WorkflowPhase;
      action: WorkflowMutationAction;
      target?: Record<string, unknown>;
    }
  | {
      allowed: true;
      outcome: 'executed';
      tool: WorkflowToolName;
      phase: WorkflowPhase;
      action: WorkflowMutationAction;
      result: TResult;
      target?: Record<string, unknown>;
    }
  | {
      allowed: true;
      outcome: 'failed';
      code: 'external_error';
      reason: string;
      error: { name: string; message: string };
      tool: WorkflowToolName;
      phase: WorkflowPhase;
      action: WorkflowMutationAction;
      target?: Record<string, unknown>;
    };
```

Ordering guarantee:

1. evaluate policy
2. if denied, record `denied`
3. return denial result without calling the executor
4. if allowed, execute
5. record `executed` on success or `failed` on execution error

---

## Review Flow Orchestration

`shared/lib/native-agent/workflow-tools/review-flow.ts` composes the existing
workflow tools into the native review handoff:

1. `review_changes`
2. optional per-finding narrow `review_fix` execution when a fix executor is supplied
3. `linear_comment`
4. `github_create_pr`
5. `github_add_label`
6. `write_stage_result`

Runtime guarantees:

- Structured review runs first and the flow parses its JSON payload before any PR mutation.
- If `needsStrongerReviewer` is true, the flow records a terminal review stage-result and stops before PR mutation.
- The flow never merges. It always reports `haltedBeforeMerge: true` and `merged: false`, leaving merge control to ready/tend policy.
- GitHub PR and label calls are recorded into the session transcript and stage artifact log by the flow, because the lower-level GitHub helpers remain provider-focused and side-effect free outside their own idempotent mutation result.

Idempotent reruns:

- `github_create_pr` reuses or updates the existing open PR based on the current head/base/body state.
- `github_add_label` skips labels already present.
- `write_stage_result` reuses or updates the same review artifact instead of creating duplicates.
- `linear_comment` reuses identical comment bodies. If the review summary body changes, current tool semantics create a new comment rather than updating in place; the flow surfaces that limitation through its result warnings when relevant instead of bypassing the existing Linear tool contract.

Fix policy:

- Review-phase source edits are not routed through the native `apply_patch` tool because the review mutation policy intentionally denies broad source editing there.
- Instead, the flow accepts an injected narrow fix executor. When no executor is supplied, fixes are skipped cleanly. When an executor returns `denied`, the finding remains in the review summary and the flow continues to PR/stage-result handling.

This guarantees policy-denied mutations short-circuit before side effects.

---

## Native Coding `apply_patch` Contract

The native coding `apply_patch` tool accepts a single `patch` argument whose value is a `NativePatch` object. `shared/lib/native-agent/patch-contract.ts` is the validator source of truth and exports the prompt/tool guidance used by native coding.

Required envelope:

- `version`: must be `1`
- `atomic`: must be `true`
- `operations`: non-empty array

Operation variants:

- `edit`: requires `path`, `oldText`, and `newText`
- `edit-diff`: requires `path` and `diff`

Paths are repo-relative POSIX paths without traversal. Operations may include `anchorBefore`, `anchorAfter`, and `expectedOccurrences`. The optional top-level `fuzzyMatch` object supports controlled fuzzy recovery settings.

Compact valid example:

```json
{
  "version": 1,
  "atomic": true,
  "operations": [
    {
      "op": "edit",
      "path": "src/example.ts",
      "oldText": "export const value = \"before\";\n",
      "newText": "export const value = \"after\";\n"
    }
  ]
}
```

Malformed patch calls are rejected by `validateNativePatch` and return model-visible diagnostics as `<json-path>: <message>` plus the same compact example.

## Native Coding `ast` Transform Contract (HOK-3060)

The `ast` advanced-tool family provides policy-bound, previewable structured source transforms. It is **opt-in**, **coding-only**, and requires `patch` certification. It is disabled by default; enable it under `nativeAgent.advanced.ast` with `allowedPhases: ["coding"]`. The transform reuses the TypeScript language index (HOK-3059) to locate occurrences but performs **no file writes of its own** — every edit is applied through the existing atomic `apply_patch` NativePatch runtime (`shared/lib/native-agent/patch-runtime.ts`), so patch validation, atomicity, snapshot recovery, and dirty-tree completion contracts remain authoritative.

Two tools:

- `ast_transform_preview` (read-only): resolves matches and returns an immutable, versioned, digest-sealed `AstTransformPreview`. It writes nothing.
- `ast_transform_apply` (mutation): accepts exactly one preview, revalidates live state against the sealed digest, and — only when nothing drifted — applies the bound patch.

Supported transform kinds (deterministic, name-bounded):

- `rename_symbol` — rename a symbol; `replacement` must be a valid identifier.
- `rewrite_symbol` — replace every occurrence with arbitrary `replacement` text.

Only the TypeScript/JavaScript engine is supported. Any other language, a zero-match symbol, a symbol with more than one definition (unless a `path` scope narrows it to one), or an out-of-worktree/traversal `path` scope fails closed with an explicit error code and no writes.

The preview is a versioned handshake. `AstTransformPreview` carries `version` (currently `1`), `transform`, `symbol`, `replacement`, `language`/`engine`/`engineVersion`, `indexRevision`, `scope`, `sourceRevisions` (per-file SHA-256 of the exact on-disk bytes), the generated `patch` (edit-diff operations — never whole-file replacement), `patchDigest`, `matches` (capped at `limits.maxMatches`), `matchCount`, `truncated`, a `formatter` outcome, a bounded/redacted `summary`, and a `previewDigest` that seals every other field.

Apply revalidation order (each step fails closed, leaving the tree unchanged):

1. `phase_denied` — not the coding phase.
2. `preview_required` / `invalid_preview` — missing or structurally invalid preview.
3. `version_mismatch` / `engine_mismatch` — contract or engine version differs.
4. `preview_tampered` — recomputed `previewDigest` ≠ the sealed value.
5. `patch_digest_mismatch` — the embedded patch's digest ≠ `patchDigest`.
6. `path_denied` — a target no longer resolves inside the worktree.
7. `source_drift` — a target file's current SHA-256 ≠ its captured `sourceRevisions` digest (catches any change, including whitespace).
8. `index_drift` — the rebuilt whole-worktree `indexRevision` differs (e.g. an unrelated file was added).
9. Then the sealed patch is handed to `applyNativePatch`; `patch_rejected` surfaces the runtime rejection, `io_error` a write failure.

Formatter interaction: when a deterministic formatter is configured, its output for each transformed file is folded into the **same** NativePatch before the single atomic apply (recorded in `preview.formatter.applied`); there is no separate write path.

Successful applies record `apply_patch`-style mutation and patch-snapshot evidence through the same recorder, and a failed transform is surfaced to the loop as a tool error (`astTransformAfterToolCall`), so mutation-failure tracking and transcript evidence stay uniform with ordinary patch behavior.

## Coding Failure Handoff

`.coding-failure-handoff.json` is controller-authored diagnostic output for terminal native coding failures where the model either stopped without `.coding-complete` or `.coding-blocked-completion.json`, or kept writing a present-but-invalid completion artifact after bounded retries. It is distinct from `.coding-blocked-completion.json`: blocked-completion is model-authored and can drive review advancement, while failure handoff preserves failure context and the stage result remains failed.

The handoff records `schemaVersion: "1.0"`, the final stop reason, mutation failure count, the last mutation-tool error when available, whether the one-time recovery prompt was attempted, and a suggested retry path. Version `1.0` readers must tolerate both `reason` values and ignore unknown optional fields.

Valid reasons:

- `no_completion_artifact`: no `.coding-complete` or `.coding-blocked-completion.json` was produced. Existing behavior is unchanged.
- `invalid_completion_artifact`: a completion artifact was present but failed validation after retries. The handoff includes `validationErrors` and `quarantinedArtifacts`.

For `invalid_completion_artifact`, `validationErrors` is an array of `{ code, field?, message }` entries derived from seam validation. `quarantinedArtifacts` lists invalid marker files preserved as `<path>.invalid-N`, relative to the worktree, including the final invalid artifact. The canonical `.coding-complete` or `.coding-blocked-completion.json` path is removed by that quarantine step.

---

## Transcript and Stage Artifact Recording Requirements

Credentials and secret-bearing headers must never appear in recorded fields.

| Tool | Transcript Record Required | Stage Artifact Record Required | Required Recorded Fields |
|------|---------------------------|-------------------------------|--------------------------|
| `linear_get_issue` | ✅ | ❌ | `tool`, `phase` |
| `linear_comment` | ✅ | ✅ | `tool`, `phase`, `idempotency.key`, `idempotency.outcome`, `idempotency.ref` |
| `github_create_pr` | ✅ | ✅ | `tool`, `phase`, `idempotency.key`, `idempotency.outcome`, `idempotency.ref` |
| `github_add_label` | ✅ | ✅ | `tool`, `phase`, `idempotency.key`, `idempotency.outcome`, `idempotency.ref` |
| `review_changes` | ✅ | ❌ | `tool`, `phase` |
| `route_task` | ✅ | ❌ | `tool`, `phase` |
| `expand_issue` | ✅ | ❌ | `tool`, `phase` |
| `write_stage_result` | ✅ | ✅ | `tool`, `phase`, `idempotency.key`, `idempotency.outcome`, `idempotency.ref` |

**Notes:**
- Transcript records must reference the existing `tool_started` and `tool_result` event types defined in `shared/lib/native-agent/transcript.ts`.
- Stage artifact records must not include credentials, authorization headers, or secret-bearing fields.
- `write_stage_result` is classified as recording (Wavemill-owned artifact) rather than external provider mutation, but still requires both transcript and stage artifact records for audit purposes.
- `mutation-record.ts` emits a single structured record shape for all mutation outcomes:

```typescript
type MutationRecord<TResult> =
  | { outcome: 'executed'; tool; phase; action; result: TResult; target?: Record<string, unknown> }
  | { outcome: 'denied'; tool; phase; action; code: string; reason: string; target?: Record<string, unknown> }
  | {
      outcome: 'failed';
      tool;
      phase;
      action;
      code: 'external_error';
      reason: string;
      error: { name: string; message: string };
      target?: Record<string, unknown>;
    };
```

- Recorder sinks are injected for testability. If the sink throws, the recorder warns and continues rather than failing the mutation call itself.

---

## Error Codes

### Common error codes (all tools)

| Code | Meaning |
|------|---------|
| `invalid_input` | Request failed schema validation |
| `policy_denied` | Operation blocked by mutation policy gate |
| `not_found` | Target resource does not exist |
| `aborted` | Operation cancelled by abort signal |
| `external_error` | Remote provider returned an unexpected error |
| `io_error` | Filesystem or network I/O failure |
| `schema_mismatch` | Response from provider did not match expected shape |

### Tool-specific error codes

| Code | Tools | Meaning |
|------|-------|---------|
| `conflict` | `github_create_pr` | PR already exists with conflicting parameters |
| `rate_limited` | `linear_comment`, `github_create_pr`, `github_add_label` | Provider rate limit exceeded |
| `review_failed` | `review_changes` | Review script or subprocess failed |
| `route_failed` | `route_task` | Router produced no valid routing decision |
| `expansion_failed` | `expand_issue` | Issue expansion produced no usable task packet |

---

## Ready-Phase Per-Edit Guardrail (HOK-2361)

In addition to the per-(phase, tool, action) mutation policy matrix, the ready phase enforces a **per-edit-path** guardrail through `shared/lib/native-agent/workflow-tools/ready-remediation.ts`.

### Purpose

The per-action matrix gates whether a tool call is permitted at all (e.g. `github_create_pr` + `merge_conflict` is allowed in `ready`). The per-edit guardrail goes one level deeper and checks whether every **individual file path** in a proposed edit set is within the scope declared by the active ready-stage classification. This prevents an agent from smuggling unrelated feature edits through a conflict-remediation window.

### Vocabulary mapping

| Ready-remediation kind | Ready-stage / ready-watchdog term | Trigger |
|---|---|---|
| `stale_base` | `auto-update` (watchdog), `stale-base` (docs) | PR is behind the base branch |
| `merge_conflict` | `CONFLICTED` (ready-stage `MergeConflictResult`) | PR has merge conflicts |
| `unknown` | Any other state | Classification could not be determined; scope is empty (deny-all) |

### Decision shape

```typescript
interface ReadyRemediationDecision {
  decision: 'allowed' | 'denied';
  classification: 'stale_base' | 'merge_conflict' | 'unknown';
  allowedScope: string[];    // normalized, sorted, deduped repo-relative paths
  rejectedEdits: string[];   // paths from proposedEdits that were out-of-scope
  rationale: string;         // human-readable; names rejected paths when denied
}
```

This decision is attached to `ReadyArtifacts.remediationDecision` in the stage result file.

### Deny-by-default semantics

- **Unknown classification** → empty scope → all edits denied.
- **Empty edit set** → `allowed` with rationale `"no edits proposed"` (cannot violate scope).
- **Path traversal or absolute paths** → always rejected (appended to `rejectedEdits`).
- **Any proposed path outside `allowedScope`** → `denied`; all out-of-scope paths listed in `rejectedEdits` and named in `rationale`.

### Adapter helpers

```typescript
// Build a classification from a ready-stage MergeConflictResult
fromMergeConflictResult(result: MergeConflictResult, conflictedFiles: string[]): ReadyRemediationClassification

// Build a classification for the stale-base condition
fromStaleBaseCheck(affectedFiles: string[], source?: string): ReadyRemediationClassification
```

---

## Schema Versioning

The schema version is `1.2.0`, exposed as:
- TypeScript: `WORKFLOW_TOOL_SCHEMA_VERSION` in `contracts.ts`
- JSON Schema: `x-schema-version` in `contracts.json`

Schema changes follow semver. Additive (backward-compatible) field additions increment the minor version. Breaking changes increment the major version. Tests assert that both surfaces expose the same version string.
