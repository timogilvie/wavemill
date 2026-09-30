---
title: Prompt Locations
---

# Prompt Locations

Use this page as the canonical registry for agent instruction locations in this repo. When prompt behavior changes, update this file and any source files listed here together.

Prompt templates are also mirrored into the first-class resource registry at `.wavemill/registry/resources.jsonl`. The legacy `.wavemill/evals/prompt-registry.jsonl` log remains for GEPA compatibility.

Planner and reviewer phase prompts now resolve through `tools/resolve-runtime-resource.ts`, which applies governed runtime selection before `shared/lib/agent-adapters.sh` performs placeholder substitution. If runtime selection fails, the shell layer logs a warning and falls back to the static prompt file.
Runtime code should prefer typed lookup through `shared/lib/resource-retrieval.ts` when it needs prompt, memory, or policy assets. The backing files below remain the source of truth in phase one.

## Registry

- `shared/lib/agent-adapters.sh`: `agent_launch_autonomous()` and `agent_launch_interactive()` define how mill mode launches agents in autonomous vs phase-launch flows. Codex launchers should use `codex exec ... --dangerously-bypass-approvals-and-sandbox - < prompt_file`, while Claude keeps its interactive CLI path. Active phase prompts are `build_planning_prompt`, `build_coding_prompt`, and `build_review_prompt`; `build_planning_prompt` and `build_review_prompt` call `tools/resolve-runtime-resource.ts` before loading prompt content while `build_coding_prompt` still reads `tools/prompts/coding-phase.md` directly and appends the `.coding-blocked-completion.json` fallback guidance for coding-phase verification blockers. `build_autonomous_prompt` has been removed; `build_routing_prompt` and `build_interactive_prompt` remain legacy test-only render paths.
- `tools/prompts/planning-phase.md`: Planning phase instructions (loaded by `build_planning_prompt`). GEPA-optimizable.
- `tools/prompts/coding-phase.md`: Coding phase instructions (loaded by `build_coding_prompt`). GEPA-optimizable.
- `tools/prompts/review-phase.md`: Review phase instructions (loaded by `build_review_prompt`). GEPA-optimizable.
- `tools/resolve-runtime-resource.ts`: Shell-safe runtime resolver for planner/reviewer prompt content plus selection metadata.
- `shared/lib/seam-artifacts.ts`: Shared seam artifact registry, schema-backed validator, retry guidance, and contract descriptions.
- `shared/lib/blocked-completion.ts`: Thin compatibility wrapper for the coding blocked-completion artifact contract.
- `shared/schemas/*.schema.json`: JSON Schemas for JSON-kind seam artifacts including `.coding-complete`, `.coding-blocked-completion.json`, stage results, and planning rejection.
- `tools/seam-artifact-cli.ts`: Shell-callable seam artifact validator used by mill paths.
- `docs/seam-artifacts.md`: Human-readable seam artifact contract, timing rule, CLI usage, and error vocabulary.
- `tools/prompts/review-general.md`: Default general-purpose review persona prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `shared/lib/review-engine.ts` in normal operating mode).
- `tools/prompts/review-general-scoped.md`: Degraded-mode scoped review persona prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `shared/lib/review-engine.ts` when operating mode is `constrained` or `survival`).
- `tools/prompts/initiative-planner.md`: Standard initiative decomposition prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `tools/plan-initiative.ts` via `shared/lib/plan-prompt-selector.ts`). Used when operating mode is `normal`. GEPA-optimizable.
- `tools/prompts/initiative-planner-compressed.md`: Compressed initiative decomposition prompt (resolved by typed lookup in `shared/lib/resource-retrieval.ts`, consumed by `tools/plan-initiative.ts` via `shared/lib/plan-prompt-selector.ts`). Used when operating mode is `constrained` or `survival`. GEPA-optimizable.
- `tools/prompts/issue-writer.md`: Expand-mode task packet generation template. Keep section naming and Key Files semantics aligned with `shared/lib/task-packet-validator.ts`.
- `shared/lib/task-packet-validator.ts`: Expand-mode quality gate for task-packet structure and path semantics. Update in lockstep with `tools/prompts/issue-writer.md` when changing validation-section or Key Files contracts.
- `.wavemill/project-context.md`: Typed `memory` lookup role `project-context`.
- `.wavemill/context/*.md`: Typed `memory` lookup role `subsystem-spec`.
- `.wavemill/context/concepts/*.md`: Typed `memory` lookup role `concept-page`.
- `.wavemill-config.json`: Typed `policy` lookup role `wavemill-config`.
- `commands/workflow.md`: Phase 4 defines the interactive `/workflow` self-review loop.
- `commands/bugfix.md`: Phase 5 defines the bugfix self-review loop.
- **Pre-commit review scope guard instruction** (`npx tsx .../check-review-scope.ts --repo-dir .`, run immediately before any review-fix commit; the instruction distinguishes the guard's exit codes: exit 1 = policy violation → preserve the index, report the violation, and stop — no review commit may be created; exit 2 = scope unverified (tool/git failure — infrastructure, not a violation) → capture stderr, note "review scope unverified (infrastructure)" in the commit and PR bodies, and proceed with the commit): carried by `tools/prompts/review-phase.md`, `tools/prompts/self-review-instructions.md`, `commands/bugfix.md`, `commands/workflow.md`, and the review-phase heredoc in `shared/lib/agent-adapters.sh`. These five surfaces must stay in sync; `tools/review-scope-prompt.test.ts` asserts the command, its ordering relative to the commit instruction, and the exit-1 vs exit-2 wording on all of them. The guard itself is `shared/lib/review-scope-guard.ts` (git-derived scope, no featureDir needed) with CLI `tools/check-review-scope.ts` (exit 0 ok / 1 policy violation / 2 tool failure = unverified; the review runner classifies the unverified case as `failureCategory: review-scope-unverifiable`, HOK-2889).
- `commands/create-plan.md`: Phase 5 plan review must surface planner/coder/reviewer model routing via `shared/lib/model-resolution-display.ts` before approval.
- `commands/plan.md`: Phase 5 verification must keep the plan-review routing block aligned with `/create-plan` when routing records are present.
- `commands/implement-plan.md`: does not define self-review; that behavior is owned by `/workflow`.
- `tools/prompts/native-read-only-phase.md`: **Native agent fork** — system prompt for native read-only phases (planning and review). Loaded via `loadNativePhasePrompt()` in `shared/lib/native-agent/prompts.ts` and consumed by `shared/lib/native-agent/launch-planning.ts` and `shared/lib/native-agent/smoke.ts`; the read-only review path in `shared/lib/native-agent/review.ts` also uses it as the registry-logged system prompt. This is a fork from `tools/prompts/planning-phase.md` because the planning-phase template contains shell-specific placeholders (`{{TOOLS_DIR}}`, `{{ISSUE}}`, etc.) that do not apply to the TypeScript native agent path. Prompt usage is logged through `logPromptUsage()`, and the native adapter registers provider/model/api identity as a `runtime` resource plus the exposed phase tool set as an `agent-config` resource linked in the session manifest.
- `shared/lib/native-agent/launch-coding.ts`: Native coding appends a "Native Coding Tool Rules" block to `tools/prompts/coding-phase.md` at runtime. This native-only block embeds the NativePatch `apply_patch` envelope/example from `shared/lib/native-agent/patch-contract.ts`; the shared shell coding prompt is intentionally unchanged.
- `shared/lib/native-agent/review.ts`: Native read-only review path. Reuses `tools/prompts/review-general.md` and `tools/prompts/review-general-scoped.md` through `loadPromptResourceSync()` for the user-message review surface, and uses `tools/prompts/native-read-only-phase.md` as the registry-logged system prompt for runtime read-only instructions. Transcript artifacts are written under `.wavemill/runs/*/native-sessions/` for downstream `NativeSessionAdapter` consumption.
- `shared/lib/resource-adapters/native-runtime-adapter.ts`: Registers native provider/model/api identity (`runtime` resource type) and phase-level tool set (`agent-config` resource) for eval traceability. Called by `runNativeAgentDryRun` and `runNativeAgentLive` in `shared/lib/native-agent/smoke.ts`.
- `shared/lib/wavemill-startup-runner.sh`: active startup launch path used by `wavemill-mill.sh` to enter planning.
- `docs/routing-contract.md`: bootstrap, expanded, and authoritative execution route lifecycle for mill-mode routing.
- `shared/lib/wavemill-orchestrator.sh`: deprecated compatibility wrapper that delegates to `wavemill-startup-runner.sh`.
- `codex/prompts/*.md` plus `codex/src/commands/workflow.js`: intentional Codex-native parallel workflow; these prompts are not built through `shared/lib/agent-adapters.sh`.
- **Post-PR reconciliation prompts (HOK-2936)**: `build_ready_remediation_prompt` and `build_conflict_resolution_prompt` in `shared/lib/agent-adapters.sh` remain the narrow process instructions. When `ready.postPrReconciliation.enabled` is true, `shared/lib/wavemill-monitor.sh` prepends the capsule projection produced by `tools/reconciliation-capsule.ts project` (backed by `shared/lib/reconciliation-context.ts`). The projection contract is **stable prefix first, volatile suffix last**: the immutable task foundation (byte-stable per task, cacheable by provider prompt caches) is serialized before the review identity, current incident, and attempt history. Large artifacts (task packet, execution contract, logs) are referenced by digest-checked path with on-demand inspection commands, never inlined. See `.wavemill/context/tools-prompts.md`.

## Typed Lookup Status

- Migrated runtime callers: `shared/lib/plan-prompt-selector.ts`, `shared/lib/review-engine.ts`.
- Remaining direct path-backed surface: `shared/lib/agent-adapters.sh` phase prompt loading still reads `tools/prompts/*.md` directly.
- Stability and versioning: `resource-retrieval.ts` accepts `stability` and `version` fields, but phase one only supports `stable` and rejects explicit version selection until HOK-1379 lands.

## Mill Label Ownership

Every `wm:*` label (including `wm:ready`, `wm:blocked`, `wm:merging`, `wm:merged`, `wm:superseded`, and any future `wm:*` label) is owned exclusively by the mill: the Ready gate publishes a `.ready-tend-handoff.json` for the current PR head, and only then does the mill apply `wm:ready` (see `shared/lib/wavemill-monitor.sh`'s "publish before exposing wm:ready" invariant). Agents MUST NOT run `gh pr edit ... --add-label wm:*` or `--remove-label wm:*` at any point. This rule is enforced consistently across the review/PR-creation prompt surfaces — `tools/prompts/review-phase.md` (FORBIDDEN section), `shared/lib/agent-adapters.sh` (`build_review_prompt` heredoc), `commands/bugfix.md` (self-review diagnostic block), and `commands/workflow.md` (Phase 4 review verdict guidance). Defense in depth: `shared/lib/tend-controller.ts` `executeMerge` treats `wm:ready` on a PR without a published Ready → Tend handoff for the live head as untrusted and strips it (HOK-3107).

## Update Rule

If you change agent launch instructions, workflow phase ownership, self-review behavior, or degraded-mode scoped review behavior, update this registry and the corresponding Claude/Codex-facing entrypoint docs so future editors can find the full instruction surface quickly.
