---
title: Native Agent Runtime Plan
---

# Native Agent Runtime Plan

Status: requirements draft; native runtime substrate decision = Pi (`pi-ai`/`pi-agent-core`), validated by source spike + runnable spike on 2026-06-19, pending formal sign-off. See "Moving forward: Pi as the chosen substrate".
Research date: 2026-06-19

## Goal

Allow Wavemill users to use any sufficiently capable model for task expansion, planning, coding, code review, ready-stage remediation, and future workflow phases without depending on Claude Code or Codex to provide the agent runtime.

The product shift is that Wavemill becomes the agent runtime:

- providers generate assistant text and tool calls
- Wavemill owns tool execution
- Wavemill owns phase policy, safety, cost, state, transcript persistence, completion contracts, and recovery
- routing chooses only models that are certified for the required phase capabilities

This should be adopted in phases. Read-only phases come first. Patch/test/commit coding comes later, behind provider certification and explicit runtime flags.

## Why Not Extend The Wrapper?

Wavemill already has useful wrapper paths:

- Claude Code and Codex remain the mature runtimes for first-party Claude/OpenAI workflows.
- `claude-openrouter` provides a bridge for OpenRouter models through Claude Code state and permissions. See [OpenRouter Launch Priority Activation Plan](openrouter-launch-priority-activation-plan.md).
- `claude-deepseek` provides a bridge for DeepSeek-like Anthropic-compatible providers. See [DeepSeek Provider](deepseek-provider.md).

Those wrappers are worth preserving, but they do not make OpenRouter and other providers first-class Wavemill runtimes. Wrapper behavior depends on what Claude Code or Codex accept, how they serialize sessions, and how they expose approvals, tool calls, reasoning state, and cost. Native runtime work is justified when Wavemill needs provider-independent control over tool schemas, execution policy, transcript format, certification, and router eligibility.

Phases A-C are intentionally read-only. They are not claiming that read-only model access is otherwise unavailable; they validate the loop, state, cost, dashboard, and policy contracts before Wavemill allows native agents to mutate source or external systems.

## Research Notes

Provider APIs converge on the same operating model but differ in request and response shapes:

- OpenAI describes tool calling as a multi-step flow where the model returns a tool call, the application executes it, then sends the tool output back for the next response. Source: https://developers.openai.com/api/docs/guides/function-calling
- Anthropic distinguishes client tools, which execute in the application, from server tools, which execute on Anthropic infrastructure. Claude returns `tool_use` blocks and expects `tool_result` blocks for client execution. Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- OpenRouter standardizes tool calling across supported models and providers, but the client still executes tool calls locally and sends tool results back. It exposes model filtering by supported tool parameters and supports multi-step/interleaved tool workflows. Source: https://openrouter.ai/docs/guides/features/tool-calling
- DeepSeek documents OpenAI-compatible function calling and says the user/application provides the function execution. Its strict schema mode is beta and has narrower JSON Schema constraints. Source: https://api-docs.deepseek.com/guides/function_calling

The durable architecture should therefore normalize provider tool-call shapes into a Wavemill schema, then run every phase through the same Wavemill-controlled loop.

## Existing Wavemill Surfaces To Preserve

Native runtime work should extend these current surfaces instead of replacing them:

- global model registry/projection and model selector handling from [Adding Models](model-additions.md) and [Model Field Configuration](model-field-configuration.md).
- Mill phase orchestration from [Mill Mode](mill-mode.md).
- Review contracts and JSON outputs from [Review Mode](review-mode.md).
- Permission and command safety conventions from [Permission Configuration Guide](permissions.md).
- Runtime resource registration from [Resource Registry](resource-registry.md).
- OpenRouter wrapper work from [OpenRouter Launch Priority Activation Plan](openrouter-launch-priority-activation-plan.md).
- DeepSeek opt-in and compatibility warning patterns from [DeepSeek Provider](deepseek-provider.md).
- Session cost/eval handling from `shared/lib/workflow-cost.ts`, `shared/lib/session-adapters/`, and eval records.
- Stage result artifacts written through `shared/lib/stage-result.ts`.
- Dashboard liveness from `wavemill_hook_write` and the `/tmp/wavemill-*.hook` status contract.

## Product Principles

1. Wavemill never treats a provider's tool-call support as permission to execute arbitrary actions.
2. Every tool has an explicit phase policy.
3. Read-only capability ships before mutation.
4. Patch-based file mutation ships before whole-file writes.
5. Generic shell exists only as a gated escape hatch; structured tools are preferred.
6. Completion is enforced by the runtime, not only prompt text.
7. Every provider/model must earn phase eligibility through smoke tests and capability metadata.
8. Native transcripts become first-class cost, eval, and intervention inputs.
9. Existing Claude Code and Codex launchers remain supported during rollout.
10. Native adapters target OpenRouter and OpenAI first; native Anthropic and DeepSeek adapters are deferred unless wrapper paths prove insufficient.

## Target Capabilities In Dependency Order

| Order | Capability | Required Before | Enables |
| --- | --- | --- | --- |
| 1 | Canonical native transcript schema | Any native run | Cost, eval, replay, debugging |
| 2 | Provider adapter interface with mock provider | Live providers | Deterministic loop tests |
| 3 | Core turn loop | Read-only tools | Multi-turn agent behavior |
| 4 | Read-only tool registry | Planning and review pilots | Task expansion, planning, diff review |
| 5 | Phase policy engine | Any real task | Safe tool exposure by phase |
| 6 | OpenRouter/OpenAI adapter | First live pilot | Broad model selection and stateful Responses validation |
| 7 | Session adapter and cost parser | Router eligibility | Workflow accounting |
| 8 | Read-only Wavemill phase integration | Planning/review rollout | Native planner/reviewer agent types |
| 9 | Patch validator and file mutation tools | Coding pilots | Controlled source edits |
| 10 | Structured command tools | Test/commit loop | Coding completion |
| 11 | Git/PR/Linear workflow tools | Full factory loop | PR creation and status updates |
| 12 | Provider certification harness | Unattended selection | Router-safe model rollout |
| 13 | Approval hooks and policy hardening | Risky command/tool use | User-approved advanced automation |
| 14 | MCP/browser/screenshot tools | UI and external workflows | Richer review and testing phases |

## Runtime Architecture

Add a new module tree. Under the Pi substrate decision (see "Moving forward: Pi as the chosen substrate"), `loop.ts`, the mock `providers/mock.ts`, and the live provider transports are adapters over `pi-agent-core`/`pi-ai` rather than original implementations; the module names below are retained as the Wavemill-owned seams.

```text
shared/lib/native-agent/
  loop.ts
  provider.ts
  transcript.ts
  messages.ts
  tools/
    registry.ts
    policies.ts
    read-only.ts
    patch.ts
    command.ts
    workflow.ts
  providers/
    mock.ts
    openrouter-chat.ts
    openai-responses.ts
    anthropic-messages.ts
    deepseek-openai.ts
  sessions/
    adapter.ts
    cost.ts
  certification/
    harness.ts
    scenarios.ts
```

The loop owns:

1. Load task prompt, phase prompt, phase policy, model, provider, and runtime resource manifest.
2. Build provider messages and tool schemas from Wavemill-native state.
3. Call the provider adapter.
4. Normalize assistant content and tool calls into Wavemill records.
5. Validate tool calls against schema and phase policy.
6. Execute approved tools.
7. Persist turn, tool call, result, cost, and touched artifact records.
8. Continue until a completion contract is satisfied, a final answer is produced, the model is blocked, or a budget/turn/timeout limit fires.
9. Write phase result artifacts and native session JSONL.

State and worktree invariants:

- All JSON state read-modify-write updates must use existing Wavemill mutex helpers: `state_mutate` from `shared/lib/wavemill-common.sh` in shell, or `mutateJsonState` from `shared/lib/state-mutex.ts` in TypeScript.
- Native stage-result, registry, certification, workflow-state, and dashboard-state writes must not introduce ad hoc JSON write paths.
- Git tools are `cwd`-locked to the active worktree and assume one active coding agent per worktree.
- Parallel native agents may run in separate worktrees, but no native tool may mutate another worktree or the parent checkout unless a phase policy explicitly grants that path.

## Core Interfaces

Provider adapter:

```typescript
export interface ToolCallingProvider {
  createTurn(input: {
    messages: AgentMessage[];
    tools: AgentToolSchema[];
    model: string;
    priorState?: ProviderConversationState;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    metadata?: Record<string, string>;
    onEvent?: (event: ProviderTurnEvent) => void;
  }): Promise<ProviderTurnResult>;
}

export interface ProviderConversationState {
  provider: string;
  previousResponseId?: string;
  encryptedReasoning?: string;
  promptCacheKeys?: string[];
  adapterState?: Record<string, unknown>;
}
```

`messages[]` is the portable replay form, not the only state model. OpenRouter and DeepSeek Chat-style adapters can ignore `priorState` and replay the complete conversation. Stateful adapters must thread provider conversation state:

- OpenAI Responses API should preserve `previous_response_id` or equivalent state so reasoning models are not forced into flattened replay every turn.
- Anthropic extended-thinking adapters, if built later, must preserve encrypted reasoning or provider-supported reasoning continuation state.
- Prompt-cache metadata should be retained as adapter state when it affects cost or quality.

The loop should also support streaming or heartbeat callbacks through `onEvent`. A non-streaming multi-minute turn must still emit Wavemill hook events so the dashboard sees progress instead of a dead pane.

Normalized provider result:

```typescript
export interface ProviderTurnResult {
  id: string;
  provider: string;
  model: string;
  text: string;
  toolCalls: NativeToolCall[];
  nextState?: ProviderConversationState;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'unknown';
  usage?: {
    inputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    costUsd?: number;
  };
  raw: unknown;
}
```

`costUsd` is optional diagnostic data only. Native sessions must record normalized token counts compatible with `SessionModelUsage`; workflow cost remains computed by `computeModelCost()` using registry/config pricing and cache-rate fallbacks.

Canonical session event:

```typescript
export type NativeAgentEvent =
  | { type: 'session_started'; session: NativeAgentSessionHeader }
  | { type: 'turn_started'; turnIndex: number; model: string; provider: string }
  | { type: 'provider_progress'; turnIndex: number; event: ProviderTurnEvent }
  | { type: 'assistant_message'; turnIndex: number; text: string; toolCalls: NativeToolCall[] }
  | { type: 'tool_started'; turnIndex: number; call: NativeToolCall; policy: ToolPolicyDecision }
  | { type: 'tool_result'; turnIndex: number; result: NativeToolResult }
  | { type: 'turn_completed'; turnIndex: number; usage?: NativeUsage; costUsd?: number }
  | { type: 'phase_completed'; completion: PhaseCompletion }
  | { type: 'phase_blocked'; reason: BlockedReason; diagnostic: string };
```

Primary session locations:

```text
features/<slug>/native-agent-session.jsonl
.wavemill/sessions/<issue>/<phase>.jsonl
```

Native runtime must also translate turn, tool, waiting, blocked, and completion state into `wavemill_hook_write` events. The dashboard should work without native-agent-specific dashboard changes.

## Tool-Call Batch Execution

Providers may return multiple tool calls in one assistant turn. The runtime must define deterministic batch semantics before enabling real mutation:

- Read-only tools may execute concurrently when they do not depend on each other and share the same phase policy.
- Mutation tools execute sequentially in the provider-provided order against live worktree state.
- Mixed read/mutation batches are serialized. Reads that appear before a mutation execute before it; reads that appear after a mutation observe post-mutation state.
- A batch containing any mutation is fail-fast. If one mutation fails or is denied, later calls in the same batch are not executed.
- Multi-operation patch calls are atomic: either every operation in that single patch applies, or none do.
- Separate mutation calls in the same batch are not atomic across calls. If `apply_patch A` succeeds and `apply_patch B` fails, A remains applied unless the phase policy chooses an explicit rollback strategy. The transcript must make this partial batch state clear.
- Policy is evaluated independently for every call. One `phase_denied` call does not authorize or deny unrelated earlier calls; it stops later calls in a fail-fast mutation batch.
- Read results produced earlier in the same batch are still untrusted/provenanced tool output. They cannot escalate authorization for a later mutation in the same batch.
- Every call result is fed back to the model in order, including skipped calls with a `skipped_after_failure` result.

These rules allow patch-on-patch workflows while preventing ambiguous "all calls saw the original tree" behavior.

## Conversation History And Context Windows

Stateless adapters replay `messages[]`, so read-heavy native sessions need active history management. The loop must maintain both canonical transcript history and a provider-bound prompt history.

Required strategy:

- Every tool result has both `maxOutputBytes` and `maxOutputTokens` caps.
- Large `read_file`, `search_text`, and `git_diff` results are stored in the transcript but summarized or truncated in replay history.
- Superseded reads can be compacted into summaries when the same file/diff region is read again.
- The active plan, current task packet summary, current diff summary, unresolved tool failures, and completion contract state must be retained across compaction.
- Recent mutation results and the latest live-file context around pending patch failures must be retained until resolved.
- For stateful providers, compaction must not discard provider state such as `previous_response_id` or encrypted reasoning.
- For stateless providers, compaction should use the model registry context window and phase budget to reserve output space before the next request.
- Before the first request of every native loop, `shared/lib/native-agent/context-window-guard.ts` estimates prompt tokens with the bytes/4 heuristic plus a 10% input safety margin, adds the phase's reserved output tokens, and refuses to launch when the total exceeds the registry `contextWindowTokens`; the diagnostic names the model, estimate, and limit.
- Compaction events must be written to the native transcript so eval/debugging can distinguish raw history from replay history.

This is separate from `.wavemill/project-context.md` compaction; it manages per-session conversation growth.

## Tool Registry

Start with a typed registry. Each tool definition includes name, description, JSON Schema, executor, result shape, phase policy, output limits, timeout, redaction behavior, and artifact metadata.

### Tier 1: Read-Only Tools

- `read_file({ path, startLine?, maxLines? })`
- `list_files({ path?, glob?, maxResults? })`
- `search_text({ query, path?, glob?, caseSensitive?, maxResults? })`
- `git_status()`
- `git_diff({ base?, path?, maxBytes? })`
- `read_stage_result({ featureDir, stage })`
- `read_task_packet({ slug })`
- `read_plan({ slug })`

These unblock native task expansion, research, planning, and code review.

### Tier 2: Controlled Mutation Tools

- `apply_patch({ patch })`
- `write_artifact({ path, content, artifactType })`
- `update_status({ issue, status, detail? })`
- `create_marker({ path, markerType, content? })`

`apply_patch` is the primary source-editing path. Whole-file writes are allowed only for generated artifacts and a concrete Wavemill-owned allowlist such as:

- `features/<slug>/plan.md`
- `features/<slug>/task-packet*.md`
- `features/<slug>/.native-agent-*.json`
- `.wavemill/sessions/**`
- global native-agent certification artifacts

The allowlist must be phase-scoped. A generic "safe path" exception is not acceptable because it defeats patch-first editing.

### Tier 3: Structured Command And Git Tools

- `run_tests({ command, timeoutMs?, maxOutputBytes? })`
- `run_format({ command, timeoutMs?, maxOutputBytes? })`
- `git_add({ paths })`
- `git_commit({ message, paths? })`
- `git_diff_stat({ base? })`
- `git_log({ maxCount?, base? })`

Use structured tools for common workflows instead of raw shell. Keep generic `run_command` for later, with strict classification and approval policy.

`run_tests` and `run_format` execute parsed argv directly without a shell. They honor POSIX-style quoting for arguments, reject shell operators, redirects, `$` expansion, backticks, and leading environment assignments, and require callers to use one program per call plus the `cwd` parameter for directory changes.

### Tier 4: Workflow Tools

- `linear_get_issue({ issue })`
- `linear_comment({ issue, body })`
- `github_create_pr({ title, body, base, head })`
- `github_add_label({ pr, label })`
- `review_changes({ base, json: true })`
- `route_task({ taskPacketPath })`
- `expand_issue({ issue })`
- `write_stage_result({ featureDir, stage, status, summary?, artifacts? })`

These should mostly wrap existing Wavemill tools so product behavior stays consistent.

External mutation tools must be idempotent under retry:

- `github_create_pr` should use a dedupe key such as repo + head branch + base branch + head SHA, and should check for an existing open PR before creating.
- `linear_comment` should use issue + content hash + native session/phase metadata to avoid duplicate comments after retries.
- `github_add_label` should be check-then-add.
- `update_status` and `write_stage_result` should be idempotent updates keyed by issue/phase/status, not append-only duplicates.
- Tool results must record the idempotency key and whether the operation created, reused, updated, or skipped an external object.

### Later Tool Families

- browser/browserless inspection
- screenshot capture and visual comparison
- MCP client tools. If Pi remains the chosen substrate, evaluate `pi-mcp-adapter` as the first bridge reference because its proxy-tool design avoids loading every MCP server schema into each model turn. Wavemill must still run phase policy before each proxied MCP call and must own tool result provenance.
- structured code search
- AST transforms
- eval/scoring tools
- image/media tools, only when product workflows require them

## Phase Policy

The runtime should calculate a policy decision before every tool call:

```typescript
export interface ToolPolicy {
  allowedPhases: NativeAgentPhase[];
  pathMode: 'none' | 'read-only' | 'workspace-write' | 'artifact-write';
  network: 'deny' | 'allowlisted' | 'allow';
  mutatesGit: boolean;
  mutatesExternalSystems: boolean;
  requiresApproval: boolean | 'when-risky';
  timeoutMs: number;
  maxOutputBytes: number;
  maxOutputTokens: number;
  redactionProfile: 'default' | 'secrets' | 'none';
}
```

Default phase policy:

| Phase | Files | Commands | Network | External systems | Completion |
| --- | --- | --- | --- | --- | --- |
| task expansion | read-only plus task artifact writes | no generic shell | deny by default | optional Linear read and `update_status` | task packet written |
| planning | read-only plus `plan.md` write | read-only commands only | deny by default | optional Linear read/comment and `update_status` | plan artifact and planning result |
| coding | workspace patch writes | structured tests/git only | deny by default | `update_status`; no PR until review | commit plus coding marker |
| review | read-only, limited patch fixes only when configured | review/test commands | deny by default | PR/labels/comments and `update_status` allowed late | review result and PR |
| ready remediation | branch update/conflict writes only | structured git/tests | deny by default | GitHub status reads and `update_status` | ready result |

Raw unrestricted shell should not be exposed in the first implementation. Later generic command execution must classify commands, lock `cwd` to the worktree, reject destructive patterns, cap output, enforce timeout, deny network by default, and record approval decisions.

`requiresApproval: 'when-risky'` and any future `run_command` gate should reuse `shared/lib/permission-patterns.ts` and `isSafePattern()` for read-only command classification instead of creating a second command-safety dialect.

## File Editing Model

Source mutation should be patch-first:

1. Agent reads target file.
2. Agent calls `apply_patch`.
3. Wavemill validates target paths are inside the worktree and permitted for the phase.
4. Wavemill applies the patch.
5. Wavemill records changed files and diff stat.
6. Optional formatter/test tools run under policy.
7. Runtime rejects whole-file source rewrites unless the path is explicitly generated or Wavemill-owned.

Patch rejection should return nearby context and a precise reason so the model can repair the patch in the next turn.

Patch application must be atomic at the tool-call level. A `NativePatch` containing multiple operations is validated against live state first, then applied all-or-nothing. If operation 3 fails, operations 1-2 must not remain in the working tree.

### Patch Format

The native `apply_patch` tool should use a Wavemill patch envelope, not raw unified diff as the only accepted format:

```typescript
export interface NativePatch {
  version: 1;
  operations: NativePatchOperation[];
}

export type NativePatchOperation =
  | {
      op: 'replace';
      path: string;
      anchorBefore?: string;
      anchorAfter?: string;
      oldText: string;
      newText: string;
    }
  | {
      op: 'insert_after' | 'insert_before';
      path: string;
      anchor: string;
      text: string;
    }
  | {
      op: 'delete';
      path: string;
      anchorBefore?: string;
      anchorAfter?: string;
      oldText: string;
    };
```

Application rules:

- `path` must resolve inside the worktree and satisfy phase policy.
- Exact `oldText` matches should be preferred.
- If exact matching fails, the patcher may use bounded fuzzy/context-anchored matching against `anchorBefore`, `anchorAfter`, and nearby unchanged context.
- Ambiguous matches must be rejected, not guessed.
- Line-number-only hunks are advisory at most; they are not sufficient authority to edit.
- Every accepted operation records the matched byte/line range and final diff.

Rejection feedback must include:

- failing operation index
- reason code such as `path_denied`, `old_text_not_found`, `ambiguous_anchor`, `anchor_mismatch`, or `phase_denied`
- normalized excerpt of the requested anchor/old text
- live-file context around the nearest candidate match
- next-step hint for the model

Epic 5 must test this format against at least two providers because patch failure modes vary by model.

### Tool Schema Dialects

The registry owns a provider-neutral schema, but every adapter needs a schema dialect normalizer. This is not just response parsing.

Required behavior:

- OpenAI strict-compatible schemas must ensure object properties are required where the strict dialect requires it and set `additionalProperties: false`.
- DeepSeek strict mode is beta and supports a narrower JSON Schema subset; adapters must either down-convert schemas or mark the tool/model combination unsupported.
- Anthropic client tools use `input_schema`, not OpenAI-style `function.parameters`.
- OpenRouter uses OpenAI-style tool definitions but may route to providers with different supported parameters; unsupported tools must fail certification rather than being silently dropped.
- Tool descriptions and parameter names must be stable across dialects so transcript replay and certification remain comparable.

Epic 3 acceptance must include per-adapter conformance tests proving every registry tool can be converted, sent in a fixture request, parsed back from a fixture response, and rejected explicitly when a dialect cannot represent it.

## Completion Contracts

Completion must be checked by runtime code.

### Task Expansion

- Must write a task packet artifact.
- Must not edit source files.
- Must produce structured route hints when requested.
- Must write a stage result.

### Planning

- Must write `features/<slug>/plan.md` or the configured plan path.
- Must not edit source files.
- Must summarize dependencies, risks, and verification.
- Must wait for approval marker when the workflow requires approval before coding.

### Coding

- Must apply source changes only through mutation tools.
- Must run scoped checks or record why they could not run.
- Must commit changes when policy requires a commit.
- Must write `.coding-complete` only after commit/check requirements are met, using the existing confidence contract:

```text
confidence=high
```

or:

```text
confidence=low
```

- Must emit blocked artifact instead of declaring completion when verification is impossible.
- Must write `.coding-result.json` through the orchestrator-owned stage-result path with `agent`, `model`, and `CodingArtifacts` such as `filesChanged`, `linesAdded`, `linesRemoved`, and `commitCount`.

### Review

- Must run `review_changes` or equivalent structured review.
- May fix only review findings when configured for self-review repair.
- Must create or update PR only after review passes.
- Must not merge.
- Must surface `needs_stronger_reviewer` when operating-mode policy requires it.

### Ready Remediation

- Must only remediate merge conflicts, stale base, or ready-stage findings.
- Must not add unrelated feature work.
- Must run ready checks again.
- Must reuse ready-stage classifications from `shared/lib/ready-stage.ts` for stale base, merge conflict, waiting-on-CI, and user-needed states.

## Abort, Timeout, And Dirty-Tree Cleanup

`AbortSignal`, provider timeout, command timeout, blocked stops, and process shutdown must leave a defined repository state:

- Running commands receive termination first, then forced kill after a bounded grace period.
- Atomic patch calls either complete fully or leave no file changes from that call.
- If a turn aborts after one successful mutation call and before a later call, the already-applied mutation remains unless the phase policy explicitly rolls it back; the transcript and stage result must report the partial state.
- On blocked coding with a dirty tree, phase policy must choose one of: commit allowed changes, leave dirty and mark blocked, stash native changes, or reject completion. It must not silently proceed to review.
- Dirty-tree cleanup must never discard user-authored changes unless the change is known to have been created by the current native session and policy explicitly allows rollback.
- Before creating `.coding-complete`, the runtime verifies expected commit/check policy and dirty-tree policy.

## Tool Result Provenance And Prompt Injection

Native runtime turns read tools into future mutation authority unless provenance is explicit. Every tool result must be tagged:

```typescript
export type ToolResultProvenance =
  | 'wavemill-generated'
  | 'repo-trusted'
  | 'repo-untrusted'
  | 'external-untrusted'
  | 'provider-generated';
```

Default provenance:

- `read_file`, `search_text`, and `git_diff` are `repo-untrusted` unless reading Wavemill-owned runtime artifacts.
- `linear_get_issue`, GitHub comments, PR bodies, and remote metadata are `external-untrusted`.
- stage results, native transcripts, certification artifacts, and Wavemill-generated prompts are `wavemill-generated`.

Required invariant: untrusted tool output can inform the model, but it can never escalate phase policy. For example, a malicious issue body, source comment, diff line, or PR comment must not cause the runtime to expose mutation tools in planning, bypass path policy, request network access, approve a command, or weaken completion requirements.

Mutation tools should receive a summary of relevant untrusted context, but the policy engine must evaluate only Wavemill-controlled state: phase, config, approved tool registry, worktree path, command classifier, explicit user approval, and certification metadata.

## Provider Adapters

Implement adapters behind the normalized interface:

| Adapter | First use | Notes |
| --- | --- | --- |
| `mock` | Phase 1 | Deterministic tests and transcript fixtures |
| `openrouter-chat` | Phase 2 | First-class prize: broad model coverage; supports model filtering for `tools`; should be the first live target |
| `openai-responses` | Phase 2 | Second live target; validates provider-side reasoning state with Responses API tools |
| `anthropic-messages` | Deferred | Build only if Claude Code wrapper proves insufficient for a required native phase |
| `deepseek-openai` | Deferred | Build only if `claude-deepseek` or OpenRouter paths prove insufficient; strict mode beta needs schema constraints |
| local/provider-specific | Later | Require explicit certification records |

Adapter responsibilities:

- translate Wavemill tools into provider-specific schema
- translate provider messages into provider request shape
- parse tool calls, parallel calls, text, finish reasons, and usage
- preserve raw responses in transcript events with redaction
- map provider errors into retryable, blocked, or fatal classes
- expose capability metadata for the model registry

## Capability And Certification Metadata

Reuse the existing global model registry dispatch model. Native runtime should be represented as another `agent` value, such as `native-openrouter` or `native-openai`, resolved by `resolveAgent()` from global `ModelCapabilities.agent`. Do not add a parallel `runtime` axis; that would duplicate routing concepts and collide conceptually with governed `resources.runtimeSelection`.

Extend model registry metadata around the existing `toolSupport: 'none' | 'basic' | 'full'` field. Do not add a second `toolCalling` enum with the same meaning.

```typescript
export interface NativeAgentCapabilities {
  nativeAgent: boolean;
  toolSupport: ToolSupport;
  parallelToolCalls: boolean;
  strictJsonSchema: boolean;
  longContextReliable: boolean;
  patchTaskScore?: number;
  shellTaskScore?: number;
  reviewTaskScore?: number;
  maxCertifiedPhase: 'none' | 'read-only' | 'patch' | 'workflow';
  certifiedAt?: string;
  certificationSuiteVersion?: string;
  knownLimitations?: string[];
}
```

Routing rule:

- task expansion, planning, and read-only review require `agent` mapped to a native agent, `toolSupport !== 'none'`, and `maxCertifiedPhase >= read-only`
- coding requires native agent mapping and `maxCertifiedPhase >= patch`
- PR/review workflow automation requires native agent mapping and `maxCertifiedPhase >= workflow`
- challenge mode may only select native models when their certification satisfies the phase policy

## Evaluation Harness

Create a provider-neutral native tool-loop smoke suite before enabling live tasks:

1. Read one file and summarize it.
2. Search for a symbol and read matching context.
3. Write a Wavemill-owned artifact.
4. Refuse or block a forbidden source edit in planning.
5. Apply a clean patch to one source file.
6. Recover from a malformed patch.
7. Run a passing test.
8. See a failing test, apply a fix, rerun the test.
9. Create a git commit with the intended files only.
10. Enforce path boundaries for attempted writes outside the worktree.
11. Enforce command timeout and output cap.
12. Stop when turn, token, cost, or wall-clock budget is exhausted.
13. Emit a parseable native transcript and cost summary.

Each provider/model run should produce a certification artifact:

```text
<global-certification-root>/<provider>/<model>/<suite-version>.json
```

Certification policy:

- Deterministic scenarios: path-boundary rejection, forbidden phase mutation, budget stop, malformed tool-call recovery, malformed patch rejection, clean patch application, command timeout, and transcript parsing.
- LLM-judged or probabilistic scenarios: task understanding, failing-test repair, review quality, and multi-step planning quality.
- Live suites should use bounded retries for probabilistic scenarios and record retry counts.
- Certification artifacts are generated under `.wavemill/`; router-facing capability flags are checked into the model registry or repo config after review so ordinary routing and CI do not require paid live recertification.
- `certificationSuiteVersion` changes invalidate older artifacts for the affected phase.
- Certification TTL should fail closed for unattended routing. A stale model can still be manually selected with an explicit override if policy allows it.

## Epics

### Epic 1: Native Schema, Transcript, And Pi Loop Adapter

Dependencies: none.

Substrate: the turn loop, provider-state continuation, batch ordering, and the scripted mock come from `pi-agent-core`/`pi-ai` (pinned per the vendoring contract). This epic is the Wavemill schema + transcript + budget wrapper around `agentLoop`/`runAgentLoop`, promoted from `spike/pi-native-agent/`.

Deliverables:

- Define `AgentMessage`, `AgentToolSchema`, `NativeToolCall`, `NativeToolResult`, `AgentTurn`, `NativeAgentEvent`, and `NativeAgentSessionHeader`, with adapter mappings to/from Pi types (`Message`/`AgentMessage`, `ToolCall`, `AssistantMessage`, `Usage`). Confine Pi types to `provider.ts`/`messages.ts`.
- Implement append-only JSONL transcript writer (`transcript.ts`) that derives `NativeAgentEvent`s from Pi's `AgentEvent` stream, with redaction hooks. Use `pi-langfuse` / `@raindrop-ai/pi-agent` as reference implementations for span shapes over model calls, tool calls, usage, cost, redaction, and privacy presets — borrow the event shapes without taking a runtime dependency on a third-party hosted telemetry service.
- Implement the deterministic mock provider via `registerApiProvider` with a scripted, input-keyed turn list (the spike's pattern) so tests can assert exact multi-turn behavior.
- Implement no-op/mock tools as Pi `AgentTool`s.
- Adopt `agentLoop`/`runAgentLoop`; implement Wavemill-owned turn, token, tool, wall-clock, and cost budgets via `shouldStopAfterTurn` plus an `AbortSignal` wrapper.
- Thread provider continuation state: Pi carries OpenAI-Responses-style continuation in replayed message signatures (`thinkingSignature`/`responseId`), so `ProviderConversationState`/`priorState` is an optional passthrough, not a required hand-rolled mechanism. Map `onEvent`/Pi progress events to heartbeat events.
- Configure tool-call batch execution via `toolExecution` + per-tool `executionMode`; verify Pi's ordering matches the plan's concurrent-read/serialized-mutation rules, and implement fail-fast + `skipped_after_failure` results in the policy/`afterToolCall` layer where Pi does not already cover them.
- Implement initial replay-history compaction via `transformContext` with per-tool-result token caps.
- Add transcript fixtures for successful, blocked, and malformed-tool-call sessions.

Acceptance:

- Unit tests cover tool-call mapping, schema validation, retries, budget stops, blocked stops, and transcript shape.
- A mock native planning run writes a valid session JSONL and stage result without touching source files.
- Continuation tests prove turn N+1 replays prior-turn message signatures (and any optional adapter state) correctly across the Pi loop.
- Heartbeat tests prove long turns produce `wavemill_hook_write`-compatible working events.
- Batch tests cover read-only concurrency, patch-on-patch sequencing, mixed read/mutation ordering, phase-denied fail-fast behavior, and skipped-call results.
- Compaction tests prove active plan, current diff summary, unresolved failures, and provider continuation survive replay-history truncation.
- A pinned-version check fails CI if `pi-ai`/`pi-agent-core` drift from the locked version without passing the integration suite.

Suggested tests:

- `shared/lib/native-agent/transcript.test.ts`
- `shared/lib/native-agent/loop.test.ts` (Wavemill config/budget wrapper over the Pi loop)
- `shared/lib/native-agent/providers/mock.test.ts` (`registerApiProvider` scripted mock)
- `shared/lib/native-agent/provider.test.ts` (Pi↔Wavemill type/usage mapping)

### Epic 2: Safe Read-Only Tool Registry

Dependencies: Epic 1.

Substrate: tools are Wavemill-owned `AgentTool` executors registered with Pi; the registry shape and typebox arg validation come from Pi, while the policy gate is Wavemill's `beforeToolCall` evaluator (proven in the spike).

Deliverables:

- Implement `read_file`, `list_files`, `search_text`, `git_status`, `git_diff`, `read_task_packet`, and `read_plan` as `AgentTool`s with Wavemill-owned executors.
- Implement the read-only phase policy evaluator and wire it as `beforeToolCall`, so a denied call blocks before execution and returns a `phase_denied`/`path_denied` reason that the loop feeds back to the model as an `isError` tool result.
- Enforce worktree path boundaries inside the policy evaluator (only Wavemill-controlled state: phase, config, worktree path).
- Build the registry so tools can be exposed lazily/selectively per turn rather than loading every schema into each request — forward-compatible with `pi-mcp-adapter`'s proxy-tool design before MCP itself lands.
- Cap file, search, and diff outputs with byte and token truncation metadata (via tool result + `afterToolCall`).
- Add secret redaction for tool results and raw provider payloads.

Acceptance:

- Native read-only sessions can inspect a task packet, plan file, source file, and diff.
- Attempts to write files or run mutation commands in read-only phases are rejected by `beforeToolCall`, recorded in the transcript, and surfaced back to the model.
- Path-boundary and forbidden-tool denials are deterministic and unit-tested (extends the spike's deny cases).

Suggested tests:

- `shared/lib/native-agent/tools/read-only.test.ts`
- `shared/lib/native-agent/tools/policies.test.ts` (the `beforeToolCall` evaluator)
- lifecycle fixture for native read-only planning.

### Epic 3: First Live Providers For Read-Only Phases

Dependencies: Epics 1-2.

Substrate: live providers are Pi `Model` objects routed through Pi's built-in API transports (`openai-completions`, `openai-responses`, `anthropic-messages`) plus `registerApiProvider` for non-standard wire formats. OpenRouter is an `openai-completions` `Model` (baseUrl + `compat`); OpenAI Responses uses Pi's `openai-responses` provider. "Adapter" work here is config + capability mapping, not a new HTTP client.

Deliverables:

- Define OpenRouter and OpenAI `Model` objects (baseUrl, headers, `compat`) and confirm dispatch through `getApiProvider`.
- Add provider config blocks and env var resolution (`nativeAgent.providers.*`).
- Add model registry capability fields, derived where possible from Pi `compat` flags.
- Add the native session adapter for the workflow cost scanner (`Usage`→`SessionModelUsage`, priced by `computeModelCost()`).
- Add a smoke command for the live read-only tool loop, skipped cleanly without keys.
- Set/verify per-model `compat` flags; fail loudly when a model/tool/provider combination is unsupported rather than silently dropping a tool.

Acceptance:

- A live OpenAI or OpenRouter `Model` can run the read-only smoke suite.
- Cost scanner consumes native session JSONL before falling back to Claude/Codex session adapters.
- Router refuses native use for models without read-only certification.
- Every registry tool has a per-model `compat` round-trip fixture (request build + response parse).
- Unsupported `compat`/tool/provider combinations fail loudly during certification or config validation; the runtime must not silently drop tools.

Suggested tests:

- Provider/`Model` unit tests with captured Pi response fixtures.
- `tools/smoke-native-agent.ts --provider openrouter --phase planning --dry-run`
- optional `--live` mode when keys are present.

### Epic 4: Native Task Expansion, Planning, And Read-Only Review Integration

Dependencies: Epics 1-3.

Deliverables:

- Add native agent types such as `native-openrouter` and `native-openai`.
- Wire native runtime into task expansion, planning, and read-only review launch points.
- Write normal Wavemill stage artifacts for native phases.
- Register selected prompt/tool/runtime resources in the resource registry manifest.
- Register `native-openrouter` and `native-openai` through global `ModelCapabilities.agent` and `resolveAgent()`.
- Extend `AgentType`, `getSessionAdapter()`, and detection for native session files.
- Reuse existing phase prompt surfaces: `build_planning_prompt`, `build_coding_prompt`, and `build_review_prompt`, or explicitly fork them with registry logging through `loadPromptTemplate()`/resource registry metadata.
- Update [Prompt Locations](prompt-locations.md) whenever native phase prompt loading changes.
- Add config flags:

```json
{
  "nativeAgent": {
    "enabled": false,
    "allowedPhases": ["task-expansion", "planning", "review"],
    "providers": {
      "openrouter": { "enabled": false, "apiKeyEnv": "OPENROUTER_API_KEY" },
      "openai": { "enabled": false, "apiKeyEnv": "OPENAI_API_KEY" }
    }
  }
}
```

Acceptance:

- Users can opt into native read-only planning/review without changing coding behavior.
- The product shows native model/provider in stage results, dashboard state, cost data, and eval records.
- Read-only phases cannot mutate source even if the model requests a mutation tool.
- Native phases emit existing hook states so the dashboard requires no special-case liveness path.
- Native stage results include required `agent` and `model` fields.
- Native prompt output remains comparable with Claude/Codex runs, or any deliberate prompt fork is recorded in the resource manifest and prompt registry.

Suggested tests:

- `tests/launch-native-planning-phase.test.sh`
- `tests/native-read-only-review.test.sh`
- focused config/schema tests.

### Epic 5: Patch-Based Coding Runtime

Dependencies: Epics 1-4.

Deliverables:

- Implement `apply_patch`, `write_artifact`, `create_marker`, and `update_status`.
- Implement patch validation, changed-file tracking, conflict diagnostics, and retry hints.
- Implement the `NativePatch` envelope, context-anchored/fuzzy matching rules, and rejection-feedback contract.
- Add phase policy for coding mutation.
- Add small-coding-task smoke suite.
- Gate native coding behind explicit config and certification.
- Implement dirty-tree policy checks before completion.

Acceptance:

- Native coding can complete a one-file task using patch/test/commit flow.
- Whole-file source writes are rejected unless policy marks the path generated/safe.
- Failed patch application returns actionable context.
- Coding completion marker is rejected unless commit/check policy is satisfied.
- Patch smoke tests run against at least two providers/models before coding certification is granted.
- `.coding-complete` includes `confidence=high` or `confidence=low`, and `.coding-result.json` includes `CodingArtifacts`.
- Multi-operation patch application is all-or-nothing.
- Blocked coding with a dirty tree follows explicit phase policy and never silently advances to review.

Suggested tests:

- `shared/lib/native-agent/tools/patch.test.ts`
- malformed patch recovery smoke.
- lifecycle fixture for native patch coding.

### Epic 6: Structured Commands, Tests, And Git

Dependencies: Epic 5.

Deliverables:

- Implement `run_tests`, `run_format`, `git_add`, `git_commit`, `git_diff_stat`, and `git_log`.
- Add command classifier for generic future shell support.
- Enforce timeout, max output, cwd lock, env filtering, and redaction.
- Enforce one-worktree scope for git commands and use existing state mutex helpers for JSON state updates.
- Record command class and approval outcome in transcripts.

Acceptance:

- Native coding can run scoped checks and commit intended files.
- Commands cannot write outside allowed roots.
- Dangerous commands are rejected before execution.
- Test output is capped but still useful for repair.

Suggested tests:

- `shared/lib/native-agent/tools/command.test.ts`
- `tests/native-command-sandbox.test.sh`
- `tests/native-coding-commit.test.sh`

### Epic 7: Workflow Tools For Review, PR, Linear, And Ready

Dependencies: Epics 4-6.

Deliverables:

- Wrap existing `review-changes`, Linear, GitHub, route, expand, and stage-result commands as native tools.
- Add PR creation/update contract for review phase.
- Add ready remediation-only policy for stale base and merge conflict handling.
- Add idempotency keys and check-then-create/update behavior for external mutation tools.
- Ensure external mutations require phase-appropriate policy and are recorded.

Acceptance:

- Native review can run structured review, fix findings when allowed, and create a PR.
- Native ready remediation cannot make unrelated feature edits.
- Linear/GitHub tool calls are visible in transcript and stage artifacts.
- Retried PR/comment/label/status calls do not create duplicate external objects.

Suggested tests:

- Fixture-backed GitHub/Linear mock tests.
- Review phase integration test that stops before merge.
- Ready remediation fixture for stale base and conflict flow.

### Epic 8: Safety, Approval, And Recovery Hardening

Dependencies: Epics 1-7.

Deliverables:

- Human approval hooks for risky commands/tools.
- Network allowlists by phase and tool.
- Secret redaction profiles for files, command output, provider raw payloads, and external comments.
- Extend `shared/lib/text-redaction.ts` or add a companion secret-redaction profile for API keys, bearer tokens, private keys, GitHub tokens, provider keys, and configured secret names.
- Compare Wavemill's phase-policy semantics against `@gotgenes/pi-permission-system`, especially most-restrictive-wins layering, cross-cutting path gates, outside-worktree gates, bash pattern policy, MCP/skill gates, and session-scoped approvals. Borrow patterns where useful, but do not delegate safety authority to the plugin.
- Tool-result provenance tagging and prompt-injection tests for untrusted file, diff, issue, PR, and comment content.
- Stuck-loop detection:
  - repeated same tool failure
  - repeated same patch rejection
  - no touched artifacts after N turns
  - no new information after N read-only turns
  - budget exhaustion
- Recovery artifacts for blocked phases.
- Abort/timeout cleanup for running commands, partial mutation batches, atomic patch rollback, and dirty-tree policy outcomes.
- Dashboard/status surfacing for waiting, blocked, approval-needed, and policy-denied states.

Acceptance:

- Runtime stops cleanly with diagnostics when progress stalls.
- Approval-needed states do not look like agent crashes.
- Redaction tests cover env vars, common token patterns, and configured secrets.
- Prompt-injection tests prove untrusted tool output cannot escalate phase policy, path policy, approval policy, network policy, or completion requirements.
- Abort/timeout tests prove the worktree, transcript, and stage result report the final tree state and cleanup decision.

Suggested tests:

- `shared/lib/native-agent/recovery.test.ts`
- `shared/lib/native-agent/redaction.test.ts`
- dashboard/status shell tests for waiting and blocked states.

### Epic 9: Provider Certification And Router Rollout

Dependencies: Epics 1-8.

Deliverables:

- Implement certification harness and certification artifact schema.
- Add registry fields for native certification.
- Add router filters by phase requirements.
- Add challenge-mode guardrails for native models.
- Add certification TTL, suite-version, flake-retry, and deterministic-vs-LLM-judged scenario classification.
- Add reporting command:

```bash
wavemill native-agent models
wavemill native-agent certify --provider openrouter --model <model> --phase read-only
```

Acceptance:

- Router selects native models only for certified phases.
- Challenge mode excludes uncertified native coding models.
- Certification reports show pass/fail by scenario and known limitations.
- Certification artifacts are generated under the global certification root; deterministic router/CI capability flags are checked into the global model registry so paid live reruns are not required for ordinary routing decisions.
- Suite-version bumps require recertification; stale certifications fail closed after the configured TTL.
- Flaky live scenarios get bounded retries and record retry counts.

Suggested tests:

- registry validation tests
- router policy tests
- dry-run certification tests

### Epic 10: Advanced Tooling

Dependencies: production read-only and patch runtime stability.

Deliverables:

- Browser/browserless inspection.
- Screenshot capture and visual review support.
- MCP client tool bridge.
- Structured code search or AST transform tools.
- Eval/scoring tools available inside native review.

Acceptance:

- Each advanced tool family has its own phase policy, output caps, transcript format, and smoke suite.
- No advanced tool is globally available by default.

**Epic 10.7 status:** `code_search` is now populated — the runtime substrate
lives in `shared/lib/native-agent/language-index.ts` and the four tool
descriptors in `shared/lib/native-agent/tools/code-search.ts`, gated by the
new `nativeAgent.advanced.code_search` config block. Substrate rationale is
recorded in `docs/decisions/structured-search-substrate.md`.

#### Advanced-tool exposure contract (HOK-3053)

The first Epic 10 landing is the catalog and default-off policy — no advanced
executor ships with it. Descriptors declare `family` (`browser` / `screenshot`
/ `mcp` / `code_search` / `ast` / `eval`), a family-scoped `logicalId`,
`exposure: 'opt-in'`, a full `ToolPolicyMetadata` shape (pathMode, network,
mutation surfaces, approval, timeout, byte/token caps, redaction profile), a
`ToolProvenanceClass`, and a `NativeCertificationRequirement`. Legacy Tier
1–4 descriptors inflate to `family: 'core'` / `exposure: 'always'` /
`certificationRequirement: 'none'` at registration time; no descriptor site
had to change.

Eligibility is calculated once per phase launch by `computeEligibility()` in
`shared/lib/native-agent/tools/exposure.ts`. It is a pure function; the only
inputs are the requested phase, the resolved wavemill config, the native
certification snapshot, and the registry metadata. No tool output, prompt
content, or environment lookup can enable a family. Advanced families remain
denied (`family_not_enabled`) until an operator opts in via
`nativeAgent.advanced` in `.wavemill-config.json`, e.g.:

```json
{
  "nativeAgent": {
    "advanced": {
      "browser": {
        "enabled": true,
        "allowedPhases": ["coding"],
        "logicalIds": ["browser.navigate"]
      }
    }
  }
}
```

Enabled → `allowedPhases` must contain the requested phase; the descriptor's
own `allowedPhases` must also permit it; the model's `maxCertifiedPhase` must
satisfy the descriptor's requirement (default `workflow` for advanced
families); if a `logicalIds` allowlist is present, the logical id must appear
in it. Every failure surfaces as a structured `EligibilityDenial` for logs
and dashboards. The per-call policy evaluator adds a defense-in-depth
`not_exposed` reason so that a materialised call for a hidden tool is
rejected even if exposure and materialisation are ever wired asymmetrically.

#### Advanced-tool family: `eval` (HOK-3061)

The first advanced family to ship real descriptors is `eval`: four bounded,
read-only scorers exposed only inside the review phase and only when the
operator enables them via `nativeAgent.advanced.eval`. All four descriptors
carry `class: 'read-only'`, `allowedPhases: ['review']`,
`certificationRequirement: 'read-only'` (overriding the advanced default of
`workflow` so review-phase snapshots satisfy the ladder), and a 32 KB output
cap with truncation bookkeeping.

Shipped tools:

- `score_diff_difficulty` — wraps `analyzeDiffStats` / `computeDifficultyBand`
  / `computeStratum` / `detectTechStack(prDiff)` against the workspace diff.
- `score_task_context` — wraps `analyzeTaskContext` over the task packet and
  `selected-task.json` (and optional workspace diff).
- `score_patch_selection` — wraps `scorePatchSelection`
  (`hokusai.scorers.wavemill.patch_selection_accuracy:v1`) over inline,
  strict-schema-validated records with a 200-item cap.
- `score_success_rate_under_budget` — wraps
  `scoreWavemillSuccessRateUnderBudget`
  (`hokusai.scorers.wavemill.success_rate_under_budget:v1`) over inline,
  strict-schema-validated records with a 200-item cap.

Every tool returns a byte-stable canonical-JSON envelope
`{ scorer, toolVersion, inputDigest, evidence[], eligibility, metrics?,
rationale, diagnostics, advisory: true }`. Missing / malformed / oversized /
conflicting evidence yields a structured non-score state (`missing_evidence`,
`malformed_evidence`, `oversized_evidence`, `conflicting_evidence`) with no
`metrics` key rather than fabricated zeros. Rationale text is
template-generated (never raw evidence excerpts); the envelope carries
per-evidence digests, not evidence bodies.

Non-goals — and hard invariants of the module:

- No recursive `review_changes`; no additional model invocation.
- No Hokusai submission, routing update, reward mutation, or append to
  `.wavemill/evals/evals.jsonl`.
- Scorer output is advisory: it cannot set the final review verdict or Ready
  state, which remain independently enforced.

Operator enablement (opt-in, default off):

```json
{
  "nativeAgent": {
    "advanced": {
      "eval": { "enabled": true, "allowedPhases": ["review"] }
    }
  }
}
```

`buildReviewToolRegistry` only registers the descriptors when the family is
enabled — so the prompt catalog never advertises tools the model cannot call —
and `computeEligibility` re-checks the family / phase / certification /
logical-id allowlist per turn as the authoritative gate.

## Rollout Plan

### Phase A: Internal Mock Runtime

Ship Epics 1-2 without live provider usage.

Operator impact:

- no user-facing runtime selection yet
- tests and fixtures only

Exit criteria:

- mock read-only loop passes
- native transcript can be parsed by test utilities
- `pi-ai`/`pi-agent-core` pinned with committed lockfile and a CI drift gate; Pi imports confined to the adapter seams

### Phase B: Native Read-Only Pilot

Ship Epic 3 and expose opt-in read-only planning/review.

Operator impact:

- users can configure `nativeAgent.enabled`
- only task expansion, planning, and read-only review are eligible

Exit criteria:

- at least one OpenAI and one OpenRouter model certified read-only
- cost/session adapter active
- no source mutation possible in native read-only phases

### Phase C: Product Integration For Planning And Review

Ship Epic 4.

Operator impact:

- native agent types appear in launch plans and stage results
- router can pick certified native models for read-only phases when enabled

Exit criteria:

- lifecycle tests cover native planning and review
- dashboard/status/cost/eval display native runs correctly

### Phase D: Patch Coding Alpha

Ship Epics 5-6 behind explicit config.

Operator impact:

- native coding available only for small tasks and certified models
- default remains existing Claude/Codex launchers

Exit criteria:

- patch smoke suite passes for target provider/model
- command sandbox tests pass
- coding completion contract enforced

### Phase E: Workflow Automation

Ship Epic 7.

Operator impact:

- native review can create PRs and update Linear/GitHub under policy
- ready remediation can use native runtime for narrow remediation tasks

Exit criteria:

- end-to-end feature fixture can plan, code, review, and open PR through native runtime
- merge remains controlled by existing ready/tend policy

### Phase F: Broad Model Rollout

Ship Epics 8-9.

Operator impact:

- router and challenge mode can safely include native-certified models
- unsupported models remain available only through explicit opt-in or existing wrappers

Exit criteria:

- certification metadata exists for all enabled native models
- router refuses uncertified phase assignments
- blocked/approval states are visible and recoverable

## Config Shape

Proposed high-level config:

```json
{
  "nativeAgent": {
    "enabled": false,
    "rolloutMode": "wrapper",
    "allowedPhases": ["task-expansion", "planning", "review"],
    "providers": {
      "openai": {
        "enabled": false,
        "apiKeyEnv": "OPENAI_API_KEY",
        "baseUrl": "https://api.openai.com/v1"
      },
      "openrouter": {
        "enabled": false,
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "baseUrl": "https://openrouter.ai/api/v1"
      },
      "anthropic": {
        "enabled": false,
        "apiKeyEnv": "ANTHROPIC_API_KEY",
        "priority": "deferred"
      },
      "deepseek": {
        "enabled": false,
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "baseUrl": "https://api.deepseek.com",
        "priority": "deferred"
      }
    },
    "policy": {
      "networkDefault": "deny",
      "requireApprovalForRiskyTools": true,
      "maxTurns": 40,
      "maxToolCalls": 120,
      "maxSessionCostUsd": 10
    }
  }
}
```

Global model registry entries should carry provider, native adapter, certification metadata, and the existing `agent` field. Certified models resolve to `native-openrouter`, `native-openai`, or similar launchers from that global metadata. `rolloutMode` is a native-agent rollout flag, not a second router dispatch axis.

## Build vs. Adopt: Open-Source Harness Evaluation

Research date: 2026-06-19. Stats verified against the GitHub API on that date.

The architecture above assumes Wavemill builds the native runtime itself. Before committing to that, we evaluated whether an existing open-source coding harness could provide a more solid foundation than building everything ourselves. This section records that evaluation so the build-vs-adopt decision is explicit rather than implied.

### What "adopt" would and would not replace

The runtime "owns" list in this plan splits cleanly into two layers:

- **Generic runtime plumbing** — the provider tool-calling loop, a typed tool registry, patch/diff file editing, multi-provider model abstraction, cost/token accounting, JSONL transcripts, and session persistence. This maps to Epics 1-3 and parts of Epic 6. **Every serious harness below already provides most of it.**
- **Wavemill's differentiation** — the phase-policy engine (per-phase tool permissions across task-expansion/planning/coding/review), completion contracts, provider certification, the stage-aware model router and global model projection, worktree isolation conventions, Linear/PR/ready workflow tools, eval/GEPA/challenge learning loops, and the dashboard/hook status contract. This maps to Epics 4-5, 7-9. **No harness provides this; it stays ours regardless of what we adopt.**

So adoption is not "build vs. buy the product." It is "build vs. borrow the runtime substrate underneath Epics 1-3," while Epics 4-9 remain Wavemill-owned in either case. The product principle that "Wavemill becomes the agent runtime" (and "owns tool execution, phase policy, safety, cost, state") is preserved even when the turn-loop primitive is borrowed, because Wavemill still owns the policy and tool-execution wrapper around it.

### Evaluation axes

Per the product brief, candidates were scored on three axes:

1. **Capability acceleration** — how much of the roadmap (Epics 1-3 especially) they provide out of the box, and how *embeddable* that is from a TypeScript/Node + shell codebase.
2. **License alignment** — whether their license and commercial structure let an MIT-licensed product (Wavemill's `LICENSE` is MIT) extend, vendor, fork, and commercialize without being crippled.
3. **Complementary long-term ambition** — whether arbitrary/custom models (the Hokusai testbed goal) can be first-class providers, plus project maturity and long-term-support outlook.

### Comparison matrix

| Harness | Lang | License | Stars | Embeddable from TS/Node? | Custom-model fit | LTS outlook |
| --- | --- | --- | ---: | --- | --- | --- |
| **Pi** (`earendil-works/pi`) | TypeScript | MIT | ~64k | Yes — npm packages (`pi-ai`, `pi-agent-core`) | **Best**: `registerProvider` + custom streaming API + `compat` matrix | Young (b. 2025), fast churn, founder-led |
| **OpenCode** (`sst/opencode`, now `anomalyco/opencode`) | TS/Bun | MIT | ~176k | Yes — headless server + `@opencode-ai/sdk` | Strong: AI-SDK + Models.dev, OpenAI-compatible config | Very active, company-backed (SST) |
| **Cline** (`cline/cline`) | TypeScript | Apache-2.0 | ~63k | Yes — `@cline/core`/`@cline/sdk`, no VS Code dep | Strong: `@cline/llms`, OpenAI-compatible base URL | Active, VC-backed (Cline Bot Inc.) |
| **OpenHands** (`OpenHands/software-agent-sdk`) | Python | MIT (core; `enterprise/` is PolyForm) | ~78k flagship / 0.8k SDK | Sidecar only — REST Agent Server, no JS bindings | Strong: LiteLLM + `base_url` | Active, funded (All Hands AI) |
| **Goose** (`block/goose`) | Rust | Apache-2.0 | ~50k | Sidecar only — `goosed` HTTP/WS, ACP | Good: generic OpenAI provider / LiteLLM gateway | **Strongest institutional** (Block + Linux Foundation) |
| **Aider** | Python | Apache-2.0 | ~46k | No — CLI; Python API explicitly unstable | First-class via LiteLLM | Single maintainer, cadence slowing |
| **SWE-agent / mini-swe-agent** | Python | MIT | ~20k / ~5k | No — research framework / CLI | First-class via LiteLLM | Academic; full SWE-agent superseded by mini |
| **Continue** | TypeScript | Apache-2.0 | ~34k | Core embeddable, but… | First-class (`apiBase`, vLLM/Ollama) | **Sunset** — repo read-only, final 2.0.0 |

Roo Code was excluded (archived/shut down 2026-05-15). Kilo Code (live MIT Cline/Roo fork) is VS-Code-extension-first with a commercial gateway, not a clean embeddable SDK.

### License alignment (Axis 2)

This axis produces no disqualifiers, which is the most important finding: **every viable candidate is permissively licensed (MIT or Apache-2.0)**, both of which an MIT product can vendor, fork, and commercialize. Apache-2.0 (Cline, Goose, Aider, Continue) is fully compatible inside an MIT product — it adds an explicit patent grant (a plus) and only requires preserving `NOTICE` and not using the upstream trademark; we ship under the Wavemill name regardless. The only real license traps are:

- **OpenHands' `enterprise/` carve-out** is **PolyForm Free Trial 1.0.0** (proprietary, 30-day, no redistribution). Building on `openhands-sdk`/`openhands-tools` and avoiding `enterprise/` keeps it clean MIT. (This is why GitHub reports the flagship repo's license as `NOASSERTION`.)
- **CLAs** (confirmed for Aider; unverified for Cline/Continue) affect *upstreaming contributions*, not our right to fork/extend/use. Pi notably has **no CLA** but a deliberately high-friction contribution gate, which argues for a vendor/track-fork model over co-development.

Net: license is not the deciding axis. Maturity, embeddability, and model-pluggability are.

### Capability acceleration (Axis 1)

The decisive sub-question is not language but **who executes the tools and evaluates the policy**, because that determines whether adopting a project preserves or undercuts product principle #1 ("Wavemill owns tool execution"). This splits the candidates into two fundamentally different adoption shapes:

- **Library embed — Wavemill keeps the loop/policy/execution seam (best fit):** Pi (MIT) and Cline (`@cline/core`, Apache-2.0). You register *your own* tool executors and drive the loop in-process, so Wavemill still owns tool execution, phase policy, and safety. Each independently implements ~60-70% of Epics 1-3 in TypeScript. This is the only shape that satisfies the native-runtime ambition as written.
- **Server backend — the project owns runtime semantics (reference/comparison only):** OpenCode (TS server + SDK) and OpenHands (Python REST Agent Server), plus Goose (Rust `goosed` HTTP/WS or ACP). Even run locally, tool execution and permission decisions happen *inside their runtime*. Adopting one of these as the runtime would revert Wavemill to an outer scheduler and hand off the semantics this plan says Wavemill must own. They are valuable to spike for provider breadth, session-API behavior, sandbox/deployment architecture (OpenHands especially), and UX — but they must not become the authority for runtime semantics or safety.
- **Reference, not foundation:** Aider (edit-format taxonomy is the transferable asset), SWE-agent/mini-swe-agent (ACI "state-command" + linter-gated edits are excellent design patterns to port), Continue (tool-permission policy + model roles map well to our phase-policy engine — but upstream is sunset).

A related safety constraint applies to every adoption shape: **the adopted component's permission model is never the safety authority.** Pi ships no permission sandbox (it runs with caller privileges unless externally sandboxed) and OpenCode's default posture is more permissive than the phase policy in this plan. Any adopted loop must route every tool call through Wavemill's phase-policy engine, which evaluates only Wavemill-controlled state (see "Tool Result Provenance And Prompt Injection"). We inherit the harness's loop, never its permission posture.

### Long-term fit and the Hokusai testbed (Axis 3)

Every candidate can route a self-hosted OpenAI-compatible endpoint, so a Hokusai model exposing the OpenAI chat-completions wire format is a first-class provider everywhere with config-only changes — already strictly better than wrapping Claude Code/Codex, which hard-bind to their vendor APIs. Depth differs where Hokusai is *non-standard* (the realistic case for an experimental model and a model testbed):

- **Pi is the standout for the testbed goal.** Its `pi.registerProvider(...)` supports OAuth flows, dynamic model discovery, and a documented **"Custom Streaming API"** for fully non-standard wire formats — plus a `compat` matrix of ~15 conformance flags (thinking format, strict-mode, cache-control, reasoning-effort, etc.) and a `faux` test provider. That `compat` matrix is essentially a ready-made substrate for **Epic 9's provider-certification harness** and directly serves "use Wavemill as a testbed for Hokusai models."
- **OpenCode / Cline** handle custom OpenAI-compatible providers cleanly via config / `@cline/llms`; non-standard formats need a custom AI-SDK provider package (config-level, not a fork).
- **LiteLLM-based** (OpenHands, Goose, Aider, SWE-agent) is the most battle-tested provider layer, but only reachable across the Python/Rust boundary.

Maturity/LTS favors OpenCode (176k stars, multiple releases/week, SST-backed) and Goose (Block + Linux Foundation governance — lowest abandonment risk, but wrong language). Pi is young and fast-churning; Cline is VC-backed and the only fork-family project investing in a decoupled embeddable SDK. Continue is being sunset and is viable only as a fork-and-own base.

### Recommendation

This recommendation was cross-checked against an independent second review (Codex, 2026-06-19); the two evaluations converged on "selective adoption of components, not replacement of the runtime," and on Pi as the strongest component candidate. The notes below incorporate that review's sharper framing of adoption shape and safety authority.

1. **Spike Pi as the primary library-embed substrate.** It is the only candidate that is MIT, native TypeScript, *and* a library where Wavemill keeps tool execution and the policy seam. It leads on the Hokusai/testbed axis (custom-provider depth + `compat` certification substrate, which feeds Epic 9) and maps cleanly onto `provider.ts`, `loop.ts`, and `messages.ts`. The spike should (a) drive a read-only planning turn through `pi-agent-core` from Node with Wavemill-owned tool executors, (b) register a mock non-standard "Hokusai" provider via `registerProvider`/custom streaming, (c) confirm transcript/cost extraction maps onto `SessionModelUsage` and `computeModelCost()`, and (d) run focused plugin probes for `@gotgenes/pi-permission-system`, `pi-mcp-adapter`, and one Pi observability plugin.
2. **Keep Cline as the Apache-2.0 library-embed fallback.** It is the other "right-shaped in the right language" option (stateless loop + stateful session split, `@cline/core` decoupled from VS Code, hub daemon for multi-agent/worktree-style attach-resume) — the backup if Pi's v0.x churn or contribution gate makes it too costly to track.
3. **Spike OpenCode and OpenHands only as server-API comparisons, not as the runtime.** Drive OpenCode through its server/SDK to benchmark provider breadth, session-API behavior, and permissions/UX; study OpenHands' Agent Server, sandbox, and deployment architecture. Neither becomes the authority for runtime semantics or safety — doing so would revert Wavemill to an outer scheduler and undercut this plan. Goose stays an ACP/HTTP interop target.
4. **Never delegate safety to an adopted component.** Pi has no permission sandbox and OpenCode's default posture is too permissive; every adopted loop must execute tools through Wavemill's phase-policy engine, which evaluates only Wavemill-controlled state.
5. **Harvest patterns regardless of the runtime decision:** Aider's edit-format taxonomy into the `apply_patch` design, SWE-agent's ACI state-command + linter-gated rejection into the patch rejection-feedback contract, Continue's tool-permission policy into the phase-policy engine, and Pi plugin patterns for permission gates, MCP proxying, observability, memory/compaction, code intelligence, and persistent session UI.
6. **Whatever we adopt, vendor and pin it.** All TS candidates ship multiple releases per week; depend on a pinned version behind a thin Wavemill adapter (the `ToolCallingProvider` interface in this plan is the right seam) so upstream churn never reaches Epics 4-9.

If the Pi (or Cline) spike cleanly drives Epics 1-3, keeps Wavemill-owned tool execution, and accepts a custom provider, adopting it as a library could compress the schema/loop/adapter/command work (Epics 1-3, 6) by months, leaving Wavemill to invest in the differentiated layer — phase policy, completion contracts, certification, routing, and the Hokusai testbed — which no harness gives us. If the spike surfaces blocking churn, impedance mismatch, or an unacceptable loss of execution ownership, the from-scratch module tree in this plan remains the fallback, now informed by the patterns above. In all cases Wavemill remains the canonical orchestrator, transcript, phase-policy, eval, routing, and certification authority.

### Pi source spike findings (2026-06-19)

A direct read of Pi's source at `pi-ai@0.79.8` / `pi-agent-core@0.79.8` (not READMEs) resolves the four kill criteria. **Verdict: GO WITH CAVEATS** — Pi exposes exactly the seams the plan requires, with churn/governance as the only real risk.

`pi-agent-core` depends only on `pi-ai` + `ignore`/`typebox`/`yaml` (no TUI/CLI coupling), so it is a clean standalone embed.

Mapping of Pi exports onto this plan's interfaces:

| Plan interface | Pi symbol (file) | Fit |
| --- | --- | --- |
| `ProviderTurnResult` + `usage` | `AssistantMessage` / `Usage{input,output,cacheRead,cacheWrite,cost{…}}` (`pi-ai/src/types.ts`) | Direct. `cacheWrite`→`cacheCreationTokens`; thinking is content, not a token field |
| `ToolCallingProvider.createTurn` | `StreamFunction(model, context, options) => AssistantMessageEventStream` (`pi-ai/src/types.ts`) | Direct; `Context{systemPrompt,messages,tools}` |
| `finishReason` | `StopReason = stop\|length\|toolUse\|error\|aborted` | Direct |
| **Phase policy before tool exec** | `AgentLoopConfig.beforeToolCall(ctx) => {block?,reason?}` (`pi-agent-core/src/types.ts:262`) | **Make-or-break PASS** — runs after arg validation, before `execute`; `block:true` emits an error tool result with `reason` fed back to the model (= our `phase_denied`/`skipped_after_failure`) |
| Wavemill-owned tool execution | `AgentTool.execute(...)` — embedder supplies the executor | Direct; Wavemill owns the executor |
| Result redaction / provenance | `afterToolCall` override of `content`/`details`/`isError` | Direct |
| Completion contract / terminating tool | `AgentToolResult.terminate` + `AfterToolCallResult.terminate` | Direct |
| Batch semantics (concurrent reads, serial mutations) | `toolExecution: sequential\|parallel` + per-tool `executionMode` | Direct |
| Replay-history compaction | `transformContext(messages, signal)` | Direct |
| `NativeAgentEvent` JSONL | `AgentEvent` stream (`agent_start`/`turn_*`/`message_*`/`tool_execution_*`) + `convertToLlm` keeps Wavemill's canonical transcript separate from provider replay | Wavemill derives its own events; Pi format is not opaque |
| Custom message types | `CustomAgentMessages` declaration merging | Direct |

Kill-criteria scorecard:

- **(a) Policy before tool exec — PASS.** `beforeToolCall` is the phase-policy gate; it evaluates Wavemill-controlled state, can deny, and feeds a synthetic result back to the model.
- **(b) Custom provider without forking core — PASS, two tiers.** Standard Hokusai endpoint = construct a `Model` data object (`api: "openai-completions"` etc., `baseUrl`, `headers`, `compat`). Non-standard wire format = `registerApiProvider({api, stream, streamSimple})` (`pi-ai/src/api-registry.ts:66`), a public export — no core fork.
- **(c) Usage → `SessionModelUsage` — PASS.** `Usage` already carries input/output/cacheRead/cacheWrite; map and let `computeModelCost()` price it (ignore Pi's own `cost{}`).
- **(d) Churn/governance — CAVEAT (the one real risk).** Pre-1.0 (0.79.8), ESM-only, Node ≥22.19, documented breaking changes at 0.65/0.69/0.77, and a hostile contribution gate (new-contributor PRs auto-closed). Mitigation: vendor-and-pin behind the `ToolCallingProvider` adapter; do not plan to upstream.

Bonus alignment for later epics: the `compat` flag set (`OpenAICompletionsCompat`/`OpenAIResponsesCompat`/`AnthropicMessagesCompat` in `pi-ai/src/types.ts`, ~20 flags: `supportsStrictMode`, `thinkingFormat`, `cacheControlFormat`, `maxTokensField`, …) is a ready-made conformance dimension set for the Epic 9 certification harness. OpenAI Responses stateful continuation is handled via message-content signatures (`ThinkingContent.thinkingSignature`, `AssistantMessage.responseId`) replayed through `convertToLlm`, so the plan's `priorState` threading becomes optional rather than required.

Gaps Wavemill still owns regardless (unchanged from this plan): phase-policy engine, worktree isolation, `NativePatch` envelope (Pi ships string-replace `edit`/`edit-diff`, not the anchored/fuzzy contract), MCP policy and product semantics, sub-agents, and Linear/PR/ready workflow tools. Pi core omits MCP by design, but `pi-mcp-adapter` is a strong reference/spike candidate for bridge mechanics.

### Pi plugin ecosystem findings (2026-06-19)

Pi's package ecosystem strengthens the Pi option, but plugins should be treated as accelerators or references, not as trusted authorities for Wavemill runtime semantics. Any adopted Pi plugin must sit behind Wavemill-owned interfaces, be pinned or vendored, be disabled by default during rollout, and have Wavemill integration tests proving phase policy, transcript shape, certification, worktree boundaries, and completion contracts remain Wavemill-controlled.

| Plugin | Plan treatment | Relevant roadmap |
| --- | --- | --- |
| `@gotgenes/pi-permission-system` | Highest-fit reference for policy mechanics. Study or adapt allow/ask/deny gates, cross-cutting path protection, outside-cwd checks, bash patterns, MCP/skill gates, most-restrictive-wins layering, and session-scoped approvals. Do not delegate final phase-policy authority to it. | Epics 2, 6, 8 |
| `pi-mcp-adapter` | Highest-fit MCP candidate. Its proxy-tool approach keeps MCP schemas out of the default context, supports lazy server startup, OAuth, direct-tool opt-in, and shared `.mcp.json` discovery. Wavemill should preserve per-call policy checks and provenance on top. | Epic 10 / later tool families |
| `pi-langfuse` / `@raindrop-ai/pi-agent` | Observability references for spans over agent runs, model calls, tool calls, usage, cost, redaction, privacy presets, and trace-level scores. Wavemill should borrow event-shape ideas without depending on a third-party hosted telemetry service. | Epics 1, 8, eval/observability |
| `@remnic/plugin-pi` | Optional memory/compaction reference. Useful ideas include context recall before turns, compaction checkpoints, token deltas, dedupe state, and local-daemon boundaries. It should not replace Wavemill's repo-as-system-of-record artifacts. | Later context and memory work |
| `pi-langsrv` | Later code-intelligence spike for LSP, tree-sitter indexing, symbol navigation, references, call graph, and import tracking. Needs maturity and policy-boundary verification before adoption. | Epic 10 structured code search / AST tools |
| `@jmfederico/pi-web` | Product-surface reference for persistent sessions, workspaces, worktrees, daemon/browser split, WebSocket status, multi-session supervision, and remote machines. Too much overlap to adopt directly. | Dashboard/operator UI |
| `pi-acp` | Interop reference for Agent Client Protocol clients such as Zed. Useful if Wavemill later wants an ACP bridge, but not central to the Hokusai/native-runtime path. | Future editor/ACP integration |
| `pi-agent-flow` / `@agentuity/coder-tui` | Subagent and hub-driven workflow references. Interesting for isolated workers, parallel tasks, structured results, and server-provided tools, but Wavemill's factory/challenge/worktree model remains the authority. | Future parallel agents |

Immediate Pi-plugin spike additions:

1. Run `@gotgenes/pi-permission-system` or a minimal extracted equivalent against one Wavemill read-only deny case and one outside-worktree deny case.
2. Run `pi-mcp-adapter` with a toy MCP server in proxy-tool mode and verify Wavemill can still enforce phase policy before the proxied call executes.
3. Inspect `pi-langfuse` or `@raindrop-ai/pi-agent` event mapping against `NativeAgentEvent`, `SessionModelUsage`, redaction, and cost computation.

### Moving forward: Pi as the chosen substrate (implementation shape)

The source spike and the runnable spike (`spike/pi-native-agent/`, all kill criteria PASS) are sufficient to promote Pi from "leading candidate" to the **default native runtime substrate**, vendored and pinned behind Wavemill-owned interfaces. The from-scratch `shared/lib/native-agent/` module tree is retained only as the fallback if a pinned Pi upgrade ever becomes unsustainable. This re-scopes the early epics; the differentiated epics (4-9) are unchanged.

**Module tree, re-read as adapters.** The files keep their names but most become thin adapters over Pi rather than original implementations:

| Module | With Pi |
| --- | --- |
| `provider.ts` | Adapter: wrap `pi-ai` `StreamFunction`/`registerApiProvider`; normalize `Usage`→`SessionModelUsage`. Mapping code, not a new client. |
| `loop.ts` | Owned by `pi-agent-core` (`agentLoop`/`runAgentLoop`). Wavemill supplies `AgentLoopConfig`: `convertToLlm`, `beforeToolCall` (policy), `afterToolCall` (redaction/provenance), `transformContext` (compaction), budgets via `shouldStopAfterTurn`. |
| `transcript.ts` | Wavemill-owned: derive `NativeAgentEvent` JSONL from Pi's `AgentEvent` stream (the spike's `mapToNative`). |
| `messages.ts` | Adapter: Pi `Message`/`AgentMessage` ↔ Wavemill canonical records. |
| `tools/*` | Wavemill-owned `AgentTool` executors + phase policy; only the registry/validation shape comes from Pi (typebox). Build the registry so tools can be exposed lazily/selectively per turn (forward-compat with `pi-mcp-adapter`'s proxy-tool design). |
| `providers/mock.ts` | Pi `registerApiProvider` scripted mock (the spike's pattern) instead of a hand-rolled mock. |
| `sessions/*`, `certification/*` | Wavemill-owned; the `compat` flag set feeds certification. |

**Re-scoped early epics (Pi compresses 1-3):**

- Epic 1 shrinks to schema + transcript derivation + budgets/heartbeat wrapper + Pi-based mock; the loop and provider-state threading come from Pi (and `priorState` is optional per the spike).
- Epic 2 shrinks to registering Wavemill read-only `AgentTool`s + the `beforeToolCall` policy evaluator; the registry and arg validation come from Pi.
- Epic 3 shrinks to constructing real `Model` objects (OpenRouter/OpenAI) plus `registerApiProvider` for non-standard wire formats; most schema-dialect work is Pi's `compat`.
- Epics 4-9 are unchanged — phase-policy engine, `NativePatch`, workflow tools, certification, router rollout, and safety remain Wavemill's differentiation with no Pi shortcut.

**Vendoring contract.** Pin `pi-ai`/`pi-agent-core` to an exact version (`0.79.8` today) and commit the lockfile; confine all Pi imports to `provider.ts`/`loop.ts`/`messages.ts`/`tools/registry.ts` so no Pi type leaks into Epics 4-9; gate every Pi upgrade on the certification + integration suites; do not plan to upstream (hostile contribution gate). Plugins follow the stricter posture in "Pi plugin ecosystem findings."

**Updated immediate tasks (supersede the build-first list where they conflict):**

1. Promote `spike/pi-native-agent/` into `shared/lib/native-agent/provider.ts` + `transcript.ts` behind the `ToolCallingProvider` seam.
2. Pin Pi and commit the lockfile; add an upgrade-gate CI note.
3. Land re-scoped Epic 1 + Epic 2 read-only tools with the `beforeToolCall` policy evaluator.
4. First live `Model` (OpenRouter) read-only planning run.
5. Run the three plugin probes above and record results here.

## Open Questions

- Build vs. adopt: does a Pi/OpenCode spike clear the bar to embed an external runtime under Epics 1-3, or do we build the module tree from scratch?
- How much raw provider payload should be persisted by default versus only under debug mode?
- What is the first acceptable native coding task class: one-file docs/code changes, test-only fixes, or production code patches?
- Should approval hooks reuse the existing command permission profile or introduce a native-agent-specific approval queue?
- What certification TTL is right for unattended routing: 30, 60, or 90 days?

## Immediate Next Tasks

Tracked in Linear under the **Agent execution** milestone (wavemill project / Hokusai team): Epics 1-10 = HOK-2278…HOK-2287 (linear critical path 1→…→9; Epic 10 off Epic 5). Epic 1 is decomposed into HOK-2288…HOK-2292; start at **HOK-2288** (vendor Pi + promote `spike/pi-native-agent/`). Remaining epics are decomposed just-in-time as they unblock.

1. ~~Create Linear epics matching Epics 1-9.~~ Done (HOK-2278…HOK-2287, plus Epic 1 sub-issues HOK-2288…HOK-2292).
2. Implement Epic 1 with mock provider and transcript fixtures.
3. Add `nativeAgent` config schema as default-off.
4. Build read-only tools and policy tests.
5. Build OpenRouter as the first live adapter, then OpenAI Responses as the stateful-provider validation adapter.
6. Add certification metadata fields to model registry, initially all native phases disabled, and map native targets through `agent`.
7. Add a `smoke-native-agent.ts` dry-run command before any router integration.
