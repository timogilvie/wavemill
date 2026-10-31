# Claude Configuration

## Architecture

This repository provides shared tooling for both Claude and Codex AI workflows:

### Directory Structure
- **`shared/lib/`** - Shared JavaScript helpers (Linear API, Git, GitHub) used by both Claude and Codex
- **`tools/`** - TypeScript wrappers that import from shared helpers (used by Claude commands)
- **`commands/`** - Workflow command definitions (symlinked from `~/.claude/commands/`)
- **`claude/config.json`** - Claude-specific configuration (Linear projects, git prefixes, check commands)
- **`codex/`** - Codex-specific commands and state management
- **`tools/prompts/`** - Shared prompt templates for PRDs, tasks, bug investigations, and issue expansion
- **`.wavemill/registry/`** - Append-only runtime resource registry
- **`.wavemill/manifests/`** - Per-session resource manifests

### Key Principles
1. **Single Source of Truth**: This repo is canonical. `shared/lib/` contains all API logic; `tools/` contains all CLI tools. `wavemill` runs tools directly from the repo — never from `~/.claude/tools/`. Install assets resolve via `shared/lib/native-agent/install-paths.ts` (TS) / `WAVEMILL_INSTALL_DIR` + `wavemill_tool_path` (shell); the milled repo is `WAVEMILL_MILLED_REPO_DIR`/`REPO_DIR`. Enforced by `tests/check-install-paths.test.sh` and `tests/check-common-guards.test.sh`.
2. **Config Schema**: Both `claude/config.json` and `codex/config.json` follow `claude/config.schema.json`; wavemill runtime config follows `wavemill-config.schema.json`
3. **Shared Templates**: `tools/prompts/` templates are consumed by both toolchains
4. **State Separation**: Claude uses `features/`, `bugs/`, `epics/`; Codex uses `.codex/state/`
5. **Thin Tools Pattern**: Tools in `tools/` are thin wrappers (typically <150 lines) that call shared business logic modules in `shared/lib/`. Business logic is reusable, testable, and documented with comprehensive JSDoc.

### Shared Business Logic Modules

**Guards cap new invariants (HOK-3236).** A "never do X" rule in this section names the executable preflight guard that enforces it. A PR that adds a new invariant here must add its guard (`tools/check-<name>.ts`, built on `tools/lib/source-guard.ts`, wired into `test:preflight`) in the same PR; a rule that cannot be enforced mechanically does not go into CLAUDE.md. `source-guard.ts` provides the shared semantics: tracked files only, invariant source auto-excluded, whole-line comments skipped, `// allow-<name>: <reason>` on the line or the line above, and a ratcheting allowlist (`<path> [<count>]  # reason`) that only shrinks.

All business logic lives in `shared/lib/` for reusability across CLI tools, commands, and workflows:

#### Issue Expansion
- `issue-expander.ts` - Issue parsing, context formatting, LLM expansion, drift checking
- `codebase-context-gatherer.ts` - Directory tree, git activity, subsystem search, file discovery
- `task-packet-utils.ts` - Task packet splitting, validation, format detection
- `validation-formatter.ts` - Format validation issues for display

#### Plan Decomposition
- `plan-decomposer.ts` - LLM-powered initiative decomposition, research phase
- `plan-validator.ts` - Validate plan structure and schema
- `initiative-lister.ts` - List and rank Linear initiatives
- `initiative-decomposer.ts` - Full decomposition workflow with Linear integration

#### Evaluation
- `eval-orchestrator.ts` - Complete evaluation workflow orchestration
- `eval-context-gatherer.ts` - Context gathering with auto-detection
- `eval-formatter.ts` - Detailed eval record formatting
- `eval-summary-printer.ts` - One-line eval summaries
- `eval-record-builder.ts` - Enrich records with metadata
- `intervention-detector.ts` - Detect human interventions
- `operator-intervention.ts` - Read/write operator recovery artifacts
- `difficulty-analyzer.ts` - Analyze PR difficulty
- `task-context-analyzer.ts` - Analyze task characteristics
- `repo-context-analyzer.ts` - Analyze repository context
- `outcome-collectors.ts` - Collect CI, test, review outcomes

#### Utilities
- `bounded-retry.sh` - The bounded-retry invariant (HOK-2924): every path that relaunches work after a failure must count attempts against a `(state_dir, bucket, head SHA)` key, back off between attempts, terminalize at a ceiling with a greppable recorded reason (`.retry-<bucket>-exhausted` sentinel, with a `.retry-<bucket>-exhausted-condition.json` condition companion per HOK-3172), and reset on a new head SHA or successful launch. Terminal causes short-circuit via `bounded_retry_mark_exhausted` without consuming the budget. **New relaunch paths must use this helper — never implement a private retry counter.** Enforced by `tools/check-retry-sentinel.ts` (hand-built `.retry-<bucket>-*` paths, new `.<name>-attempts`/`-retries` files). Example bucket: `coding-dirty-handoff` (HOK-3128) — relaunch once per head after a coding agent exits with `.coding-complete` and a dirty tree; a challenger that exhausts it is aborted so its pair forfeits to the primary. Example buckets: `coding-launch-refused` / `coding-launch-resolver` (HOK-3142) — a typed deterministic coding launch refusal re-routes the coder with the refused model excluded (`tools/reroute-refused-coder.ts`), and terminalizes to needs-user with the certify command when no launchable coder remains, the coder is pinned, or the budget (`WAVEMILL_CODING_LAUNCH_REFUSAL_MAX_ATTEMPTS`, default 3) is spent; transient resolver failures back off in their own bucket. Example buckets: `failed-ready-recheck` / `ready-remediation` (HOK-3147) — a challenge arm that exhausts them while its sibling's Ready is green is retired and its PR closed (`ready_exhausted_challenge_terminalize`): `terminal_stage_failure:ready-exhausted` for red checks (forfeit) or `invalid_challenge:ready-transition-failed|ready-unattributed` for infrastructure (no winner; tend's `challenge-void` releases the survivor once the retired PR is closed). Example bucket: `pending-ready-recheck` (HOK-3154) — the HOK-3147 third terminal path: when a Ready launch is refused because the review verdict can never pass the readiness gate (same green-sibling precondition), `review_refused_challenge_terminalize` retires the arm with cause `terminal_stage_failure:review-{malformed-response,no-output,not-ready}` (model-fault forfeit; only emitted when execution evidence proves which reviewer ran) or `invalid_challenge:review-{identity-mismatch,unattributed}` (harness-fault; survivor released through `challenge-void`). Attribution runs against the **reviewer actually used**, not the coder. Infra review categories (`native-review-timeout` etc.) route through the HOK-3106 bucket instead. TypeScript callers should use `shared/lib/bounded-retry.ts` (`createStateDirRetry`), which is the typed bridge to the shell helper. Example buckets: `observer-update-branch` / `observer-ready-budget-reset` / `observer-forfeit-arm` (HOK-3097) — opt-in observer self-repair actions, each gated by `observer.autoFix.*`, keyed on the task's state dir. Example bucket: `window-recreate` (HOK-3210) — the monitor's missing-window recovery recreates a task window at most `WAVEMILL_WINDOW_RECREATE_MAX_ATTEMPTS` (default 3) times per worktree head, then parks at needs-user; a task whose state row is gone/an orphan stub with a tombstone or missing worktree is dropped from tracking (`monitor_task_reap_reason`) instead of recreated. Example bucket: `conflict-remediation-relaunch` (HOK-3092/HOK-3273) — one Ready conflict resolver per `(head, base)`, charged in `launch_ready_phase`'s resolver launch tail only when the launch succeeds (a guard/ownership deferral or a refused launch never charges); the launch also writes the single condition-keyed `.conflict-remediation.json` (`--expires-on head,remote,operator-event`). Conflict state itself is read from GitHub on every Ready run, never latched. Example buckets: `backstage-tend-restart` / `backstage-observer-restart` (HOK-3244) — the backstage health watchdogs retry each loop up to `BACKSTAGE_RESTART_NEEDS_USER_AFTER_ATTEMPTS` (default 3) with `BACKSTAGE_RESTART_COOLDOWN`/`BACKSTAGE_RESTART_BACKOFF_MAX_SECONDS` backoff before latching `needs-user`; a successful restart (healthy heartbeat / healthy pane) clears the bucket, a pane identity change resets it, and an exhausted bucket records `observer-restart-exhausted` / `tend-restart-exhausted` in the sentinel for operator discovery.
- `failure-policy.ts` `classifyFailure()` / `failure_policy_decide` (`wavemill-common.sh`) - The single failure policy (HOK-3176): every stage gate (planning, coding, review, Ready watchdog, tend rebase/checks/ready) classifies a failure as `terminal` (only the explicit `TERMINAL_ALLOWLIST`, each entry with a reason and a pinned test; challenge-only entries preserve pair forfeit/void semantics), `code-failure` (recognised conflict/test/guard signatures → remediation with the excerpt), or `retryable` — the default, including unrecognised strings. Retryable stage failures relaunch through `maybe_retry_failed_stage` (bucket `stage-failure-<stage>`, keyed (head, merge-base) per HOK-3103: backoff retries, one fresh relaunch, then escalate to needs-user with evidence; the exhausted sentinel's HOK-3172 condition companion expires on a new head, so escalation never latches). Tend defers retryable in-lane failures through `tend-transient-recovery` instead of labelling `wm:blocked`. **Never add a classifier branch that parks: add a fixture to `failure-policy.fixtures.test.ts`, and only extend the allowlist (with a reason and test) when retrying provably cannot change the outcome.** Enforced by `tools/check-failure-policy.ts` (`class: 'terminal'` literals, `retryable: false`, private terminal signature tables). `arm-failure-taxonomy.ts` `ArmFailureKind` is the detailed failure taxonomy used for arm-specific attribution and diagnostics; it spans terminal, code-failure, and retryable classes and is orthogonal to the `TERMINAL_ALLOWLIST` (which defines which specific failures park rather than retry).
- `merge-labels.ts` `deriveMergeLabel()` / `reconcileMergeLabels()` - Merge label reconciler invariant (HOK-3181): `wm:ready` / `wm:blocked` are a render of task state. `deriveMergeLabel()` in `shared/lib/merge-labels.ts` is the single source of truth; the per-tick reconciler `reconcileMergeLabelsForPr` applies the difference and corrects the GitHub label, never obeys it. No `wm:ready` / `wm:blocked` write may exist outside `shared/lib/merge-labels.ts` + `shared/lib/pr-state-labels.ts` (`tests/check-label-write-sites.test.sh` enforces this). **One merge-block decision (HOK-3316):** a merge-blocking outcome is a condition-keyed *fact* `deriveMergeLabel` reads, never a label write. Tend records a failed merge attempt (`rebase` / `checks` / `ready` / `merge` / `handoff` / `worktree`) as `.tend-attempt-result.json` (`shared/lib/tend-attempt-fact.ts`, keyed on (PR head, integration base), `--expires-on remote,operator-event`; a moved base is checked by its readers) and the reconciler renders `wm:blocked tend-<phase>-failed` until the head or base moves — one attempt per (head, base). The cross-PR revert guard's `.cross-pr-guard-result.json` verdict is read the same way (`cross-pr-guard`). A rebase conflict is also Ready's merge-conflict signal (`checkMergeConflicts` with the state dir), so the existing one-per-(head, base) conflict resolver launches. Tend's PR comments go through the standing, edited-in-place `postMergeStatusComment` (`shared/lib/merge-status-comment.ts`), one write per `(pr, phase, head, base)` shadow-recorded as a `pr-comment` side effect (`prCommentKey`). **Never write or clear `wm:blocked`, call `setWavemillBlocked` / `releaseToBlocked`, or run `gh pr comment` outside those modules.** Enforced by `tools/check-merge-block-writers.ts` (ratchet `tools/merge-block-writers-allowlist.txt`). **Lane progression labels (`wm:merging`, `wm:merged`, `wm:superseded`) are OUT OF SCOPE for the reconciler** — they are synchronous tend lifecycle transitions (side effects of merge execution), not latched blockers derived from task state. These are managed directly by the merge executor and are not subject to per-tick reconciliation.
- `challenge-execution-contract.ts` `assessChallengeRouteInvariant()` / `tools/check-challenge-route.ts` - The one-variable route invariant (HOK-3156): a challenge pair's arms must differ in exactly the varied stage. Post-expansion re-routing freezes challenge arms to their sealed route and never rewrites an executed stage; fork materialisation collapses a drifted pair as `challenge_collapsed reason=route-drift`, and the pre-review preflight collapses arms that differ beyond the varied stage as `challenge_collapsed reason=multiple-varied-roles` (both harness-fault `invalid_challenge`). `challengeModel` names the varied stage's model; read the coder from `coderModel` (`challenge_coder_model_for_task`). **New pair writers must assert through this check — never diff routes privately.**
- `config.ts` `resolveSessionCapabilities()` / `wavemill_session_has` (`wavemill-common.sh`) - The single session-capability resolver (HOK-3102): every producer of consumer-bound work (tend handoffs, `wm:ready` labels, pane releases to the merge queue, merge-candidate lifecycle, observer findings, merge-lane BEHIND updates) checks the matching consumer through this helper before producing work. `mergeExecutor` is `tend | operator | none`; `mergeQueue` is on only when `mergeExecutor === 'tend'` and `mergeQueue.enabled`. **Never re-derive from `integration.enabled` / `useMillSession` / `MERGE_QUEUE_ENABLED` / `observer.enabled` at a producer site.** Enforced by `tools/check-session-capabilities.ts`. Health is advisory only, never gating.
- `task-progress.ts` / `task-progress.sh` - The task progress/liveness invariant (HOK-3101): every liveness decision site (observer, monitor stage-owner check, ready-watchdog, reconciler pane release, dashboard, next-done, pane-message delivery) derives `{ lastProgressAt, sources[], agentState, agentIdle, terminal, terminalIdle, stalled, blockingPrompt }` from a single primitive. The primitive enforces three invariants: **(1) pane or process existence is NEVER progress** (it can only be reported as `agentProcessLive`, never as `lastProgressAt`); **(2) monitor/controller writes are NEVER agent evidence** (monitor-written hooks, launcher `working` status, and wavemill's own `tools/*.ts` / monitor child processes are excluded); **(3) an agent's own `idle`/`Stop` survives later monitor writes** (revoked only by a later agent work event, via the preserved `.agentRecord`). Shell callers use `wavemill_hook_read` (raw hook accessor, replaces the ten copy-paste TTL blocks) or `task_progress_json` (CLI spawn, cached). Dashboard reads only the cache. **New decision sites must go through the primitive — never re-derive liveness from a private TTL check.** Enforced by `tools/check-hook-ttl.ts` (TTL constant, raw hook `.timestamp` reads, hard-coded 300s comparisons; pre-existing monitor sites held by a count ratchet). The tend challenge gate follows the same rule (HOK-3128): a tracked no-PR challenge sibling is live only while the primitive shows progress; otherwise `pair-unresolvable:sibling-stalled` (`isNoPrSiblingStalled` / `evaluateSiblingLiveness` in `tend-challenge-gate.ts`).
- `ready-remediation-disposition.ts` `evaluateReadyRemediationDisposition()` / `ready_remediation_disposition` (`wavemill-monitor.sh`) - The one Ready remediation in-flight/completion decision (HOK-3322), shared by the monitor (through `tools/ready-remediation-disposition.ts`) and the ready-watchdog snapshot. A running `.ready-result.json` and a launch head equal to HEAD are facts about the launch, never liveness: launch identity is read once (`readReadyRemediationLaunch`: the conflict resolver's `.conflict-remediation.json`, else the `ready-remediation` bucket head; launch time from the session-ownership row), and liveness only from the HOK-3101 primitive (`gatherReadyTaskProgress`). The result is `inactive` | `advanced` (head moved: condition expiry + pending re-check) | `in-flight` (the agent's own live record after launch, a blocking prompt, background work, or no evidence yet — hold) | `settled` (idle/errored after launch, exited, or stalled — the controller re-runs its own Ready check, which publishes the handoff only on green current-head checks and otherwise charges the existing `ready-remediation` bucket). It never synthesizes success and adds no marker, bucket or terminal cause. Replay: `tests/journeys/ready-remediation-same-head.journey.sh`. **Never decide "remediation in flight" from running + same head or pane activity — read the disposition.** Enforced by `tools/check-ready-remediation-disposition.ts` (launch-head equality, `remediationPaneActive`, retired `ready_remediation_launch_head` / `conflict_remediation_in_flight`, private launch-identity reads).
- `condition-reconciler.sh` - The condition-keyed markers invariant (HOK-3172): no mill marker or status may outlive the condition that set it. Every marker records its condition (worktree head, review/ready artifact identity, observed remote value) through `marker_write` / `marker_condition_json`; one reconciler expires them when their conditions no longer hold; gates never clear markers themselves; operator commands (`re-review`, `advance`) record events (`operator_event_record`) that the reconciler consumes; observations write `waiting-on` markers, never verdicts. **Expiry triggers** (marker opts into a set via `--expires-on`; default is `head,operator-event`): `head` (worktree HEAD differs from recorded), `operator-event` (new applicable event with seq > recorded), `review-artifact` / `review-artifact-substantive` (review identity changed and status != running, and for substantive, not an infra failure), `ready-artifact` (same for ready), `remote` (PR headRefOid differs from observed), `waiting-on` (awaited value now holds), `deadline` (now >= recheckAfter). The reconciler (`reconcile_condition_markers_tick`) runs once per task per monitor tick, after command draining and before the ready watchdog. A CI grep guard (`tests/check-marker-clear-sites.test.sh`) with a ratcheting allowlist (`tests/marker-clear-allowlist.txt`) ensures that new sites route clears through the reconciler. **New markers must declare `--expires-on`; never add a `marker_clear`/`bounded_retry_clear` outside the reconciler.** Audit log: `<state_dir>/.condition-reconcile.jsonl`.
- `monitor-async-jobs.sh` / `session-gh-cache.ts` - The monitor hot-pass invariant (HOK-3206): no monitor step may block on a slow read. The cross-PR revert guard, live CI status, the ready-watchdog sweep and routing run as tracked jobs (`monitor_async_job_launch` → `launch_tracked_job`, job-tracker kinds `cross-pr-guard` / `pr-ci-status` / `ready-watchdog` / `route-task`) that write condition-keyed result markers; consumers read a result only for the head/base/packet it was computed against, treat anything else as pending (never pass), and charge crashes to a bounded-retry bucket. GitHub PR reads go through the one batched per-pass query (`monitor_refresh_pr_cache` → `<cache>.meta.json` coverage; shell `wavemill_pr_cache_*`, TS `findCachedPullRequest` with `expectedHeadSha` for head-sensitive callers); repo constants through the session repo cache. **New slow ready-path reads must be a tracked job; new per-task PR reads must try the cache first.** Details: `.wavemill/context/ready-stage.md`.
- `stage-launchability.ts` `isLaunchableForStage()` - The router ↔ launcher parity invariant (HOK-3142): the predicate *is* the launcher's resolver (`resolveModelAgent` with the effective registry), and every routing exit runs it through `enforceLaunchableRoute` (`workflow-router.ts` `finalizeDecision`), substituting a launchable model or recording `launchabilityBlocked`. **Every router-selected model must pass this predicate — never add a routing path that returns without `finalizeDecision`.** Enforced by `tools/check-stage-launchability.ts` (every exported route-decision function in `workflow-router.ts` must reach `finalizeDecision`; route-decision functions outside the router are allowlisted). Canary refusals carry a certify command with `--live-coding-canary`.
- `shared/lib/native-agent/provider-identity.ts` - The provider-identity invariant (HOK-3143): every native loop turn's provider-reported `response.model` is verified against the certified identity via `extractProviderReportedIdentity` / `verifyProviderIdentity`. Alias certificates pin a concrete `resolvedTarget.model`; a mismatch (or an unverifiable alias turn) is caught in the loop's `message_end` handler, invalidates the certificate via `invalidateCertificationIdentity` (`certification/identity-invalidation.ts`), and throws `ProviderIdentityMismatchError` so the launcher writes `failureReason: 'identity_mismatch'` and `modelAttributionIneligibleReason: 'provider_substitution'`. The gate (`eligibility-gate.ts`) refuses invalidated certificates with reason `identity_mismatch`, which routes through the HOK-3142 `coding-launch-refused` reroute. **Never trust the requested wire id as `executedModel` — stage results must carry the provider-reported id and `executionEvidence.source: 'provider-response'`.** Enforced by `tools/check-provider-identity.ts`.
- `challenge-comparison.ts` `challengeModelIdsEquivalent()` - The one model-identity decision (HOK-3321): challenge code decides "are these two spellings of the same model?" exclusively through this registry-backed helper (canonicalises OpenRouter aliases like `qwen/qwen3-coder` ⇄ `qwen-3-coder` and provider-native ids like `claude-haiku-4-5-20251001` ⇄ `claude-haiku-4-5`), threaded with the caller's `repoDir`. The HOK-3313 incident false-invalidated a valid planning experiment as `stage_override_lost` because raw `===` saw two spellings of one registry entry. **Never compare a model-named identifier with `===`/`!==` in challenge code** (`challenge-execution-contract.ts`, `challenge-pair-recovery.ts`, `challenge-attestation-backfill.ts`, `challenge-coverage-selector.ts`). Enforced by `tools/check-model-equivalence.ts` (`tools/model-equivalence-allowlist.txt`, `// allow-model-equivalence: <reason>` for justified exceptions such as the seal's byte-identity check).
- `shared/lib/task-identity.ts` / `shared/lib/task-identity.sh` - The task-identity invariant (HOK-3113..HOK-3118): every task-ID → Linear-issue-ID derivation, challenger check, and challenger-ID construction goes through this helper (`parseTaskId`, `resolveLinearIssueId`, `isChallengerTaskId`, `challengerTaskId`, `challengerTaskKey`, `isLinearWriter`, and the bash twins `task_identity_linear_id` / `task_identity_is_challenger` / `task_identity_challenger_id` / `task_identity_challenger_key`). Both are pinned against `tests/fixtures/task-identity-cases.json` and change together. **Never parse or build `_c` inline, and never author an inline issue-ID regex outside `task-identity.*`.** The HOK-3118 preflight guard (`tools/check-task-identity.ts`, in `test:preflight`) fails on `_c$`-anchored patterns (`endsWith('_c')`, `.replace(/_c$/…)`, `${…}_c`, `%_c`, `*_c ]]`, `sub("_c$"…)`, `endswith("_c")`) and inline issue-ID regex literals (`[A-Z]+-\d+` and variants) anywhere outside the invariant and its own guard. Narrow justified exceptions live in `tools/task-identity-allowlist.txt` with a reason; one-off suppressions use `// allow-task-identity: <reason>` (or `#` in shell) on the finding line or the line above.
- `shared/lib/workflow-state.ts` `TaskRecord` / `WorkflowState` / `readWorkflowState()` / `mutateWorkflowState()` - The one workflow-state shape (HOK-3220): `shared/schemas/workflow-task.schema.json` (`.lifecycle` reuses `task-lifecycle-state.schema.json`) is derived from the **writers** (`save_task_state`, `state_mutate` / `task_state_mutate_existing` sites that set `.tasks[$id].*`, `mutateWorkflowState` callers), never the readers — HOK-3181 shipped reading `prNumber`/`headSha`, which no writer sets. `TaskRecord` has no index signature, so a guessed field name is a compile error. Reads never throw (missing/unparseable → `null`; schema violations are reported, value still returned); `mutateWorkflowState` validates the rows a write changed. `workflow-state.writer-coverage.test.ts` fails when the schema names a field no writer sets or a writer sets a field the schema lacks (extraction: `workflow-state-writers.ts`). The preflight guard `tools/check-task-record-shape.ts` forbids private `tasks?: Record<...>` / `.tasks as Record<...>` / `WorkflowState` / `TaskState` shapes outside the canonical module (allowlist `tools/task-record-shape-allowlist.txt` with a `# reason`, or `// allow-task-record-shape: <reason>`). **Narrow with `Pick<TaskRecord, ...>`; a new written field goes into the schema + `TaskRecord` + `npx tsx tools/generate-schema-validators.ts`.**
- `side-effect-ledger.ts` `shadowRecordSideEffect()` - Ledger D side-effect rows (HOK-3183, Phase 1 shadow): every git push, PR label write, Linear state transition and tend PR merge records one `side_effect` row keyed per design §4b (`gitPushKey` `(remote, ref, oid)`, `prLabelKey` `(pr, label, action, head_oid)`, `linearTransitionKey` `(issue, from, to, trigger_event_id)`, `prMergeKey` `(pr, merged head)`). A repeated key bumps `attempt` and writes `side-effect-duplicate-attempt` evidence; an already-in-place observation (branch reused, PR already merged) passes `observation: true` and never counts. The monitor tick runs `tools/ledger-detect-duplicates.ts` (`monitor_side_effect_detector_tick`, every `SIDE_EFFECT_DETECTOR_INTERVAL_SECONDS`, kill switch `WAVEMILL_SIDE_EFFECT_DETECTOR_DISABLED=1`) and logs `[side-effect-duplicate]` warn lines plus `.wavemill/side-effect-duplicates.jsonl`. Behaviour is unchanged until the Gate flips each site to "insert row → read `applied_at` → skip or apply". **New external-effect sites must shadow-record through this helper with the shared key builders.** Enforced by `tools/check-side-effect-ledger.ts`: push / label / merge / Linear `stateId` sites are counted per file against a ratchet, so a new site fails until it goes through a recorded seam.
- `ledger-recovery.ts` `decideRecovery()` - The one recovery *policy* (HOK-3185, Ledger F): for a step past its `deadline` (`upsertStep` stamps the TTL per kind — `WAVEMILL_LEDGER_STEP_TTL_<KIND>_MINUTES`, default review/ready 15m, eval 60m) with no HOK-3101 progress, decide the HOK-3176 outcome — terminal → settle `aborted`, code-failure → remediation request, retryable → the shared `stage-failure-<stage>` bucket (last attempt is a fresh relaunch from the row's inputs) → escalate once as a `waiting_on: operator-event` row. The HOK-3177 replay harness runs every fixture through this policy. The Ledger F shadow recovery tick and its test (PR #1632) were retired in HOK-3235: in shadow mode the per-step rows never settled (1,306 shadow decisions across cleanly merged tasks before deletion), so flipping it live would have relaunched healthy work. HOK-3277 holds the rebuild once step rows settle. Dormant: no recovery rule is enforced here until that rebuild; live stage recovery goes through `classifyFailure` → `maybe_retry_failed_stage` (guarded by the failure-policy check above).
- `feature-flag-checker.ts` `checkFeatureFlags()` / `tools/check-feature-flags.ts` - The feature-flag inventory invariant (HOK-3235): every `WAVEMILL_*` env token in non-test code must appear in `docs/feature-flags.md` (open-shadow, kill-switch or permanent table) or in the plumbing baseline `tools/feature-flags-baseline.txt`. Shadow and expiring rows carry owner-issue, removal-issue, added date and remove-by (at most 30 days past max(added, 2026-10-20)). Open-shadow rows are capped at `MAX_OPEN_SHADOWS = 5`; a new shadow requires retiring one. The baseline rejects any name matching the kill-switch pattern `(^|_)(DISABLED?|SKIP|SYNC|LIVE|SHADOW|LEGACY|AUTOFIX|ENABLED|FORCE|NO)(_|$)` and only shrinks (an entry whose name no longer appears in code is a failure). Suppress a non-flag mention in code with `// allow-feature-flag: <reason>` on the line or the line above. Overdue rows warn but do not fail CI. The guard runs in `test:preflight`. **New flag writers must add their row in the same PR as the flag — no new `WAVEMILL_*` without a doc entry.**
- `source-text-assertions-guard.ts` `SOURCE_TEXT_ASSERTIONS_GUARD` / `tools/check-source-text-assertions.ts` - The behavioural-tests invariant (HOK-3237, enforced by HOK-3236): tests assert against *behaviour*, not against the source text of `shared/lib/**` or `tools/**`. The guard scans every tracked `*.test.*` file (except `tests/check-*` lint guards, which read source as their job) for shell `grep`/`cat`/`awk`/`sed`/`head`/`tail`/`wc`/`md5sum`/`shasum` against `$MILL_SCRIPT` / `$MONITOR_SCRIPT(_FILE)` or a literal `shared/lib/**` / `tools/**` path, and for TS `readFileSync(..., import.meta.url)` sibling-source reads, `readFileSync` of a `shared/lib/**` / `tools/**` source file, and `sha256|md5|createHash(readFileSync(...))` of source bytes. `tools/source-text-assertions-allowlist.txt` is a shrinking ratchet for pre-existing legacy tests. Suppress one line with `// allow-source-text-assertion: <reason>` (or `#` in shell). The guard runs in `test:preflight`. **Convention: each new `test(...)` / `test_*` gets a one-line `// protects: <failure scenario>` comment (or encodes the scenario in the test name) — if you cannot say what a test protects against, delete it.** New sites call the function, drive the entry point, and compare the observable result against an independent oracle (fixture, inline expected value, deterministic input); the review prompts (`tools/prompts/review-general*.md`) ask reviewers to flag any new test that cannot answer that question.
- `state-invariants.ts` `evaluateInvariants()` - The one live-state invariant checker (HOK-3229): seven structural invariants plus `ledger-consistency` evaluated against workflow state every monitor tick as a tracked async job (HOK-3206 pattern; `monitor_state_invariants_tick`, every `STATE_INVARIANTS_INTERVAL_SECONDS`, default 60). I1 progress (via HOK-3101 primitive), I2 orphan stubs, I3 label mismatch persisted ≥ 3 ticks (via `deriveMergeLabel()`), I4 Ready-pass PR without `wm:ready` for > `WAVEMILL_STATE_INV_READY_STUCK_MINUTES` minutes (replay case for HOK-3212), I5 condition markers that outlive their condition (via HOK-3172 reconciler predicates with a 2-tick grace), I6 task record schema violations, I7 `.retry-*-exhausted` sentinels without a condition companion. Detection only; appends `.wavemill/invariant-violations.jsonl` and forwards urgent findings through `appendObserverFinding` so first occurrences trigger a desktop notification. Kill switch: `WAVEMILL_STATE_INVARIANTS_DISABLED=1`. **New structural invariants belong in this evaluator — never add a private detector.**
- `session-ownership.ts` / `session-ownership.sh` / `sdk-task-cost/meter.ts` `meterWorkflowCost()` - The one session-ownership record and the one cost engine (HOK-3077, HOK-3328): every launch path (shell stage launchers, Ready/conflict remediation, native runs, `llm-cli.ts` helpers given a `featureDir`) appends `{sessionRef, harness, kind, stage?, model, launchedAt, attemptId}` to `<state_dir>/.session-ownership.jsonl` *before* the child starts (Claude Code `--session-id` minted at launch; Codex records `pending:<nonce>` resolved once to its thread id from the `exec --json` stream or the rollout carrying the launch nonce, `codex-rollout-resolver.ts`; native uses its runtime session id). `kind`: `planning | coding | review | ready-remediation | conflict-resolution | ci-fix | native-arm | helper:<purpose>`. The record is archived under the same name, so post-reap evals read it via `locateOwnershipRows`. Workflow/eval cost is `@hokusai/costs` over exactly the owned session ids (`sdk-task-cost/measure.ts`: Claude Code `sessionFiles` capture, Codex through the SDK's codex source, native via `recordUsage` with OpenRouter's billed charge as provider cost); `workflowCost` is the report's cross-harness `totalUsd`, persisted with `workflowCostByHarness` and per-kind `workflowCostByKind`. Wavemill supplies only rates (`pricing/model-pricing.ts` → `sdk-task-cost/price-overrides.ts` `HostPriceOverride[]`) and transcript locations; it never applies a per-token price, picks a harness, or adds summaries up. Stage labels (`executionEconomics[].sessions[].stageRole`, via `ownershipStageRole`) and the executed model (`resolveExecutedModelFromSessions`) read the row that names a session; a worktree session with no row is `operator`/`unowned` and never task cost. No owned session is a `no_sessions` outcome and a measurement failure an `adapter_error` outcome — never `$0`. Backfills recompute from stored per-harness summaries (`sdk-task-cost/recompute.ts`). Rollback is a revert, not an env flag. **Never add a second cost engine, a private per-token price formula, a cost-metering switch, a timestamp-window stage label, or a single-harness cost pick; a new launch path records its row through `recordLaunch` / `session_ownership_append`.** Enforced by `tools/check-cost-ownership.ts` (retired engine symbols and `WAVEMILL_*` cost switches, `CostPerMTok … / 1_000_000` arithmetic, primitive imports outside `tools/cost-ownership-allowlist.txt`) and `tools/check-session-ownership.ts` (`stageRole` built outside `session-ownership.ts`, the `timestamp_window` tier, session-vs-stage-window comparisons, single-harness selection, Wavemill-side summary totals; `tools/session-ownership-allowlist.txt`).
- `ensure_task_inputs_ready` (`wavemill-monitor.sh`) / `plan-packet-binding.sh` - The inputs-before-approval invariant (HOK-3253): planning is never offered for approval (`awaiting_user`) until the local task packet exists, the expansion handshake passes, and `.plan-packet-hash` names the packet bytes the request shows (source `preparation`). An already-detailed issue is materialised locally without an LLM (`task_inputs_materialize_detailed`, mirroring native planning's `materializeTaskPacketFromSelectedTask`) at launch and at the gate; a raw issue is expanded by the tracked `prepare-task-inputs` job (bucket `expansion-recovery-job`, attempts counted at launch, exhaustion → needs-user `inputs_preparation_failed` with `wavemill expand <issue>`), never on the monitor hot path. A packet the controller regenerated after plan.md was written re-plans instead of being offered. Accepting an approval only annotates the binding (`plan_packet_record_approval`) and the plan→code handoff never touches it (`approve_plan … none`), so neither can re-bless a changed packet; the HOK-3099 handoff guard stays armed and a re-plan that voided an approval says so in the next request (`.plan-reapproval-reason`). Replay: `tests/journeys/inputs-ready-before-approval.journey.sh` (approval budget 1). **Never write planning `awaiting_user` without passing this gate.**
- `native-agent/loop.ts` / `native-agent/tools/git.ts` / `wavemill_iso8601_to_epoch` — Native coding uses the shared loop budget (200 turns, 1,200 admitted tool calls, 60 minutes, shared stagnation thresholds). Entire tool batches, including invalid calls, are admitted before dispatch. Patch pre/post statistics use Git numstat before the crash-atomic write; private LCS tables are forbidden. Coding age checks use the shared ISO parser so native millisecond timestamps reach recovery. Enforced by `tools/check-stage-exit-identity.ts`; replay coverage includes a 24k-line patch under a 64 MiB heap, oversized tool batches and the agent-killed-mid-stage golden journey (HOK-3330).
- `prompt-utils.ts` - Prompt template filling
- `llm-cli.ts` - Claude CLI integration
- `string-utils.ts` - String manipulation (kebab-case, etc.)
- `shell-utils.ts` - Safe shell command execution
- `linear.js` - Linear API client
- `config.ts` - Centralized config loading
- `model-registry.ts` - Canonical model capability registry with task-specific fallback ladders
- `resource-registry.ts` / `resource-manifest.ts` - Runtime resource tracking and per-run attribution

### Refactoring Pattern

When creating or refactoring tools:

1. **Extract business logic** to focused modules in `shared/lib/`:
   ```typescript
   // shared/lib/my-feature.ts
   export async function doSomething(options: Options): Promise<Result> {
     // Business logic here
   }
   ```

2. **Keep tools thin** - just CLI argument parsing and orchestration:
   ```typescript
   // tools/my-tool.ts
   import { runTool } from '../shared/lib/tool-runner.ts';
   import { doSomething } from '../shared/lib/my-feature.ts';

   runTool({
     name: 'my-tool',
     description: 'Does something useful',
     async run({ args, positional }) {
       const result = await doSomething({ ...args });
       console.log(result);
     },
   });
   ```

3. **Benefits**:
   - Business logic is reusable across tools, commands, and workflows
   - Easier to test (test modules, not CLI wrappers)
   - Better separation of concerns
   - Self-documenting with JSDoc

## Commands

### Linear Backlog Tool
To fetch the Linear backlog:
```bash
npx tsx tools/get-backlog.ts "Project Name"
```

### Workflow Commands
Available in `~/.claude/commands/`:
- `/workflow` - Full feature workflow (task selection → plan → implementation → validation → PR)
- `/plan` - Epic decomposition into sub-issues
- `/bugfix` - Bug investigation and fix workflow
- `/create-plan` - Research and create implementation plan
- `/implement-plan` - Execute plan with phase gates
- `/validate-plan` - Validate implementation against plan

### Native Certification CLI
`wavemill native-agent certifications` subcommands: `list`, `inspect`, `verify`, `report`, `certify`, `re-certify`, `reidentify`, `invalidate`, `migrate`, `prune`.

Use `wavemill native-agent certify --provider <provider> --model <model> --phase <phase>` for one model, or `wavemill native-agent certify --all --phase workflow` to publish the full current-suite matrix. Use `npx tsx tools/native-agent-certify.ts --refresh-canary-cohort` on the credentialed mill host to refresh live coding canaries for the bounded cohort configured under `nativeAgent.certification.canaryCohort` (HOK-3062); mill preflight runs the same refresh automatically with a one-attempt-per-episode guard, disabled via `canaryAutoRefresh: false`. The mill startup preflight auto-remediates deterministic current-suite gaps, identity drift, stale artifacts, and near-TTL renewal by default. Set `WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE=1` to keep the guard active but require manual certification; set `WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD=1` only for a targeted operator override. Use `wavemill native-agent certifications prune` to report orphan artifacts and `--yes` to remove them.

## Test Registration

Tests only run if they are registered. Adding a test file is not enough — register it in the right place:

| Test type | Register in |
|-----------|-------------|
| Bash test (`tests/*.test.sh`) | `TESTS=( ... )` array in `tests/run-shell-suite.sh` |
| `node --test` unit test | `TESTS=( ... )` array in `tests/run-unit-tests.sh` |
| Custom-harness test (`process.exit(1)` style) | `CUSTOM_TS_TESTS=( ... )` / `CUSTOM_SH_TESTS=( ... )` arrays in `tests/run-custom-tests.sh` (repo-relative paths) |
| Any new `.sh` file | Also add to the syntax-check list in `tests/check-shell.sh` |

Shell and unit tests are **no longer listed in `package.json`**. All three suites delegate to sharding runners:

```bash
bash tests/run-shell-suite.sh              # all shell tests
bash tests/run-shell-suite.sh --shard 2/3  # CI shard 2 of 3
bash tests/run-unit-tests.sh               # all unit tests
bash tests/run-unit-tests.sh --shard 2/7   # CI shard 2 of 7
bash tests/run-unit-tests.sh --list        # print selection without running
bash tests/run-custom-tests.sh --shard 2/3 # custom harness CI shard 2 of 3
```

Shell, unit and custom shards all use **deterministic weighted partitioning**: `tools/partition-tests.ts` (LPT greedy over `shared/lib/test-partitioner.ts`) balances shards using measured per-test medians from the checked-in manifest `tests/ci-test-weights.json`. A newly added test has no manifest entry yet and receives the conservative `defaultMs` weight — adding it to the array is still all that is needed. `tools/check-shard-balance.ts` (preflight) enforces exactly-once assignment, manifest hygiene, and the 130%-of-median balance rule; refresh the manifest with `npx tsx tools/ci-test-timings.ts collect` from ≥3 CI timing artifacts (see `docs/ci-test-timings.md`).

**CI job layout** (`.github/workflows/ci.yml`): `preflight`, `shell` (×3 weighted shards), `unit` (×7 weighted shards), `custom` (×3 weighted shards), `smoke`, and `certification` run in parallel. The `shell-and-unit` job aggregates them into the single status check named **"Shell and Unit Tests"**, which is a required check on `main` — do not rename it without updating branch protection. The shell/unit/custom jobs all upload `timing-*` artifacts, and all three feed the weights manifest.

**Golden journeys and shared fakes** (HOK-3226/HOK-3227): `tests/journeys/*.journey.sh` run the *real* monitor loop and `tend.ts --once` end to end (backlog selection → plan → code → review → ready → tend merge → reap) against one shared fake per external edge in `tests/fakes/` (stateful `gh` backed by a real bare origin, a Linear `fetch` preload, real tmux on a private socket, a scripted agent CLI). Run with `npm run test:journeys` or `bash tests/journeys/run-journeys.sh <name>` (~80s each in CI, budget 90s via `JOURNEY_BUDGET_SECONDS`); waits are bounded in monitor ticks, and the opt-in tick clock seam (`shared/lib/mill-clock.sh` / `mill-clock.ts`, `WAVEMILL_TICK_CLOCK_FILE`) drives bounded-retry backoff, condition `deadline` expiry and tend's retry sleeps/deadlines from the monitor pass counter instead of the wall clock. On failure the harness prints a tick-by-tick phase/marker/label table plus the last 30 monitor log lines. CI runs one journey per job on mill-core changes and on promotion, and publishes per-journey timing as the `timing-journeys` artifact; the aggregate **"Golden Journeys"** check is required on `main` and `auto/integration` (rename only alongside branch protection). Journeys are the definition of done for mill-core PRs (HOK-3228): a PR touching the plan→merge chain (the `journeys` path filter in `ci.yml`) must pass the journey job, and a fix for an incident on that chain must add or extend a journey; the coding prompts (`tools/prompts/coding-phase.md`, `launch-coding.ts`) and both review checklists say so. New tests needing gh/Linear/tmux/agent behaviour should source `tests/fakes/lib.sh` rather than define a private `gh()` stub. See `tests/fakes/README.md`. **One test-world lifetime (HOK-3329):** every fakes world records its owner (`/tmp/wmfake-worlds/<id>.json`, pid + start time) and is torn down by `fakes_teardown_world` from the EXIT trap, an owner watcher inside the world's tmux server, or the startup reaper, so a SIGKILLed journey leaves nothing running; the real tmux binary resolves only through `term_resolve_real_tmux`. **Never start a test tmux server, `set -m` launch or placeholder outside `tests/fakes/lib.sh`, or resolve tmux privately.** Enforced by `tools/check-test-world-lifetime.ts`.

**Tests must not write tracked repo paths** (HOK-3157, extends [HOK-3121](https://linear.app/hokusai/issue/HOK-3121)): a killed test run (SIGKILL, `run_tests` timeout, suite-level kill) skips `finally` blocks and leaves tracked files modified, which parks the task's coding handoff on a dirty tree. Tests must write only to `mkdtemp` directories and inject the path (e.g. `templatePath`). Two guards enforce this:
- Static preflight: `tools/check-test-tracked-writes.ts` (in `test:preflight`) scans tracked `*.test.{ts,tsx,js,jsx,mjs,cjs}` for literal fs mutator writes to tracked repo paths. Suppress with `// allow-tracked-write: <reason>`.
- Runtime: `tests/lib/tracked-tree-guard.sh`, wired into `tests/run-unit-tests.sh` and `tests/run-custom-tests.sh`, snapshots tracked-file status before each run and fails if any tracked file was modified during the run (untracked artifacts and pre-existing dirt are ignored).

**Tests seed workflow state through the schema-validated builders** (HOK-3223): TS uses `buildTask(overrides, { bare? })` / `buildWorkflowState(tasks, { bare?, topLevel? })` from `tests/lib/task-builder.ts`; shell sources `tests/lib/state-fixtures.sh` for `fixture_task` / `fixture_workflow_state <file> <id> field=value [field:=json] [-- <id> ...]` and `fixture_real_state_accessors` (the production `read_state_value` / `get_task_meta` / `state_mutate` / `task_state_mutate_existing` instead of private stubs). An override key that `workflow-task.schema.json` does not declare is an error — a test cannot invent a field no writer sets. The preflight guard `tools/check-test-task-literals.ts` fails on hand-written `tasks: { ... }` literals in tests and fixtures; `tools/test-task-literals-allowlist.txt` is a seeded ratchet that only shrinks (a listed file without a literal fails), and one-off exceptions (deliberately invalid rows, non-workflow-state `tasks` maps) use `// allow-task-literal: <reason>`.

## Prompt Locations

Use `docs/prompt-locations.md` as the canonical registry for agent instruction locations that must be updated together.

- `shared/lib/agent-adapters.sh` - `agent_launch_autonomous()` and `agent_launch_interactive()` define mill-mode agent launch behavior. Active phase prompts are `build_planning_prompt`, `build_coding_prompt`, and `build_review_prompt`; legacy `build_routing_prompt` and `build_interactive_prompt` are test-only render surfaces, and `build_autonomous_prompt` has been removed.
- `shared/lib/wavemill-startup-runner.sh` is the active startup launcher. `shared/lib/wavemill-orchestrator.sh` is the deprecated compatibility wrapper.
- `codex/prompts/*.md` with `codex/src/commands/workflow.js` form an intentional Codex-native parallel workflow rather than a shell prompt builder path.
- `commands/workflow.md` - Phase 4 owns self-review for the interactive `/workflow` command.
- `tools/prompts/review-general.md` and `tools/prompts/review-general-scoped.md` - `shared/lib/review-engine.ts` switches between them based on operating mode; constrained/survival mode uses the scoped checklist and can emit `needs_stronger_reviewer`.
- `commands/bugfix.md` - Bug workflow does not include self-review.
- `commands/implement-plan.md` - Does not define self-review; `/workflow` owns it.

## Hook-Based Status Tracking

Wavemill tracks agent lifecycle using a JSON status file contract at `/tmp/wavemill-${SESSION}-${ISSUE}.hook`. This replaces tmux pane liveness checks with richer state reporting (working/idle/waiting/blocked/approval-needed/policy-denied/error) and supports staleness detection via timestamps.

## State Mutation

All JSON state read-modify-write updates must use `state_mutate` from `shared/lib/wavemill-common.sh` in shell or `mutateJsonState` from `shared/lib/state-mutex.ts` in TypeScript. For `workflow-state.json`, TypeScript uses `mutateWorkflowState` from `shared/lib/workflow-state.ts` (a typed, validating wrapper around `mutateJsonState`). These helpers serialize concurrent writers with a file lock before writing a temporary file and atomically renaming it into place.

Append-only files such as JSONL logs and `.wavemill/registry/` entries remain lock-free. Hook status files at `/tmp/wavemill-*.hook` also keep their existing single-writer temporary-file pattern.

Per-task writes that may run after the task has been reaped (background eval completion, job-poll settlement, retry bookkeeping) must go through `task_state_mutate_existing` in `shared/lib/wavemill-common.sh`. A raw `.tasks[$issue].x = …` state_mutate recreates the reaped entry as a phase/status/slug/lifecycle-less stub that consumes a mill slot (HOK-3125). The counter also classifies such stubs as `orphan` as defense in depth, but the writer guard is the primary fix.

### Architecture

**Shared Protocol** ([wavemill-hook-protocol.sh](shared/hooks/wavemill-hook-protocol.sh)):
- `wavemill_hook_check()` - Ensures hooks are no-ops outside wavemill contexts
- `wavemill_hook_write(state, event, detail, agent[, next_action])` - Atomic JSON writes with timestamps; optional `next_action` surfaces a human-readable hint in the dashboard
- 300s TTL for staleness detection

**Agent Adapters**:
- **Claude** ([claude-status-hook.sh](shared/hooks/claude-status-hook.sh)) - Hooks configured per-worktree in `.claude/settings.local.json` (gitignored). Fires on UserPromptSubmit, PreToolUse, Stop, StopFailure, and Notification events.
- **Codex** ([codex-status-monitor.sh](shared/hooks/codex-status-monitor.sh)) - Monitors JSONL event stream from `codex exec --json`
- **Generic** ([process-status-monitor.sh](shared/hooks/process-status-monitor.sh)) - Fallback monitoring via child process detection

**Status Reading** ([wavemill-status.sh](shared/lib/wavemill-status.sh)):
- Reads JSON hook files with TTL validation (300s)
- Falls back to tmux pane liveness if hook is stale or missing
- Extracts `detail` and `next_action` fields for dashboard display

**Hook Configuration** ([wavemill-common.sh](shared/lib/wavemill-common.sh)):
- `configure_agent_hooks()` dynamically writes `.claude/settings.local.json` per-worktree
- Claude hook adapters are always loaded from the wavemill installation at `$TOOLS_DIR/../shared/hooks/`
- Only affects wavemill-launched agents, not standalone Claude usage
- Called before each phase launch (planning, coding, review)
- Missing wavemill hook adapters warn once per session via `/tmp/wavemill-${SESSION}-hook-warnings.txt`

### JSON Status Format

```json
{
  "state": "working",
  "event": "PreToolUse",
  "detail": "Read",
  "agent": "claude",
  "timestamp": 1712345678,
  "writer": "agent",
  "agentRecord": {
    "state": "working",
    "event": "PreToolUse",
    "agent": "claude",
    "timestamp": 1712345678,
    "detail": "Read"
  }
}
```

The optional `next_action` field carries a short operator hint for actionable states:

```json
{
  "state": "approval-needed",
  "event": "Notification",
  "detail": "waiting for human approval",
  "next_action": "approve HOK-1234 to continue",
  "agent": "claude",
  "timestamp": 1712345678,
  "writer": "agent"
}
```

**States**:
- `working` — agent is actively processing
- `idle` — agent stopped normally
- `waiting` — agent blocked on user input (generic)
- `blocked` — agent cannot proceed (e.g. merge conflict); displayed in dashboard inbox
- `approval-needed` — agent paused awaiting explicit operator approval; emits OSC desktop notification
- `policy-denied` — an action was rejected by a network or mutation policy; emits OSC desktop notification
- `error` — agent encountered a failure; emits OSC desktop notification

Unknown states are silently dropped so readers never see partial or malformed hook files.

**TTL**: 300s - dashboard falls back to pane liveness if timestamp is stale

**Atomic Writes**: Uses tmp file + mv to prevent partial reads

**`writer` field (HOK-3101)**: `agent` or `monitor`. Distinguishes controller writes from agent writes. Monitor/controller writes NEVER count as agent liveness evidence and NEVER erase the agent's own record. Legacy hooks (no `writer` field, written before HOK-3101 landed) are classified by event: `pr_merged`, `pr_closed_unmerged`, `operator_abort`, `review_complete`, `ready_complete`, `pr_opened`, `blocked_completion_liveness`, `premature_plan_approval`, `recovery_contract_unavailable`, `planning_rejection_notify_failed`, `NoPR`, `worktree-setup`, `recovery_failure`, `challenge_*` are monitor; everything else is agent.

**`agentRecord` field (HOK-3101)**: preserves the agent's own last record across subsequent monitor writes so a monitor `pr_merged` write cannot erase the agent's `idle:Stop` (HOK-3089 pt 3). Callers that need the agent's true state (dashboard, ready-watchdog, reconciler pane release, monitor stage-owner check) must read from `agentRecord`, not the top level, via the shared shell accessor `wavemill_hook_read --agent-only` or the TS `readHookFile()`.

### Signal-Driven Dashboard Refresh

The dashboard supports immediate updates via `USR1` in addition to polling:

- After each successful atomic hook write, `wavemill_hook_notify()` sends `USR1` to `$WAVEMILL_DASHBOARD_PID`
- `wavemill-status.sh` traps `USR1` and sets `WAVEMILL_REDRAW=1`
- The dashboard loop uses an interruptible wait (`sleep "$REFRESH" &; wait`) for fast wakeups
- A 2-second default poll fallback remains in place in case signals are missed
- `WAVEMILL_DASHBOARD_REFRESH_SECONDS` can override the fallback cadence with integer values from `1` through `10`; invalid values fall back to `2`
- Signal delivery is best-effort with full PID validation (invalid/stale PID is a no-op, never fails hook writes)

**PID propagation architecture (tmux environment-based)**:
1. `setup_control_dashboard()` in `wavemill-startup-runner.sh` captures the dashboard pane PID after spawn
2. The PID is set as a tmux session environment variable: `tmux set-environment -t "$SESSION" WAVEMILL_DASHBOARD_PID "$WAVEMILL_DASHBOARD_PID"`
3. `agent_resolve_dashboard_pid()` in `agent-adapters.sh` reads the PID from either:
   - The current shell environment (if already set), or
   - The tmux session environment via `tmux show-environment`
4. `agent_launch_autonomous()` and `agent_launch_interactive()` export `WAVEMILL_DASHBOARD_PID` for all agent types (Claude, Codex, generic)
5. Hook scripts inherit the PID from their environment and call `wavemill_hook_notify()` for validated signal delivery

This architecture ensures complete agent coverage without coupling hook configuration to PID injection.

### OSC 7501 Program Status mirror

Every successful `wavemill_hook_write` also emits a best-effort [OSC 7501
Program Status](https://www.superlogical.com/rex/docs/build/program-status)
report to the agent's pane TTY. Terminals that understand the sequence (e.g.
Rex) show agent state natively; terminals that don't ignore it.

Mapping:

| wavemill state | OSC 7501 |
|---|---|
| `working` | `state=working` |
| `idle` | `state=idle` |
| `waiting` | `state=blocked:kind=question` |
| `approval-needed` | `state=blocked:kind=permission` |
| `blocked` | `state=blocked` |
| `policy-denied` | `state=error` |
| `error` | `state=error` |

- `app=wavemill-<agent>` on every report; an agent string that fails the
  `[A-Za-z0-9_.+-]{1,32}` validation falls back to `wavemill`.
- `msg` is base64-encoded `next_action` if set, otherwise `detail` (truncated
  to 2048 bytes before encoding, control chars stripped).
- `title` is base64-encoded `WAVEMILL_ISSUE` (truncated to 192 bytes before
  encoding).
- Writes go to the resolved pane TTY (`tmux display-message -p '#{pane_tty}'`
  under tmux, else the controlling `tty`), never to stdout or stderr.
- Under tmux, the sequence is wrapped in DCS passthrough and only reaches the
  outer terminal when tmux's `allow-passthrough` option is on. The hook does
  not change this option globally.
- Kill switch: set `hooks.programStatus: false` in `.wavemill-config.json`.
  Reads share the single `jq` invocation that already resolves
  `hooks.emitOsc`, so adding this does not cost an extra process per write.
- Separate from the existing OSC 777 notification path (`hooks.emitOsc`),
  which keeps its narrower emission rules (phase gate + actionable states).

### Dependencies

- `jq` (required for all adapters) - JSON parsing and creation
- `pgrep` (optional) - Child process detection for generic adapter

Without `jq`, hooks are no-ops. Without `pgrep`, generic adapter degrades to initial/final state only.

### Adding New Adapters

1. **Prefer native hooks** if the CLI exposes them (like Claude Code)
2. **Otherwise prefer structured event streams** (like Codex JSONL)
3. **Fall back to process monitoring** for agents without hooks/streams

All adapters:
- Source `wavemill-hook-protocol.sh`
- Call `wavemill_hook_check()` at startup
- Use `wavemill_hook_write()` for all status updates
- Set `WAVEMILL_SESSION` and `WAVEMILL_ISSUE` environment variables

### Prompt Version Registry

Template usage is automatically logged to `.wavemill/evals/prompt-registry.jsonl` for GEPA training attribution. Each entry captures:

- **Template name** (e.g., "issue-writer", "eval-judge")
- **Template hash** (SHA-256) for version tracking
- **Usage timestamp** (ISO 8601 format)
- **Content snapshot** (only stored for new hash values to save space)

**Usage**: Use `loadPromptTemplate()` from `shared/lib/prompt-utils.ts` to load templates with automatic registry logging:

```typescript
import { loadPromptTemplate } from '../shared/lib/prompt-utils.ts';

// Load with automatic registry logging
const template = await loadPromptTemplate('tools/prompts/issue-writer.md');

// Opt out if needed
const template = await loadPromptTemplate(
  'tools/prompts/issue-writer.md',
  { skipRegistry: true }
);
```

**Deduplication**: The registry only stores template content once per hash. Subsequent uses of the same template version log the timestamp but not the content.

**Graceful degradation**: Registry failures don't break workflows - errors are logged as warnings and template loading continues.

## Project Context

The `.wavemill/project-context.md` file maintains living documentation of:
- **Architectural decisions and patterns** established in the codebase
- **Key conventions** (state management, API patterns, styling approach)
- **Recent work log** - automatically updated after each PR merge
- **Known gotchas** and constraints discovered during development

This file is automatically included when agents expand Linear issues, enabling them to build on previous work rather than starting from scratch.

### Initialization

**Recommended:** Use `wavemill init` which will prompt you to initialize project context:

```bash
cd ~/your-repo
wavemill init
# Answer 'Y' when prompted to initialize project context
```

**Manual initialization** (if you skipped it during `wavemill init`):

```bash
npx tsx tools/init-project-context.ts

# Overwrite existing context (use with caution)
npx tsx tools/init-project-context.ts --force
```

**Auto-initialization:** When you run `wavemill mill` or `wavemill expand` for the first time, you'll be prompted to initialize if the file doesn't exist. You can skip this check with:

```bash
SKIP_CONTEXT_CHECK=true wavemill mill
```

### Automatic Updates

The "Recent Work" section is automatically updated after each PR merge in mill mode. The post-completion hook:
1. Analyzes the PR diff
2. Generates a concise summary using LLM
3. Appends the summary to project-context.md

Manual edits to other sections (Architecture, Conventions, etc.) are encouraged to keep documentation current.

### Size Management

If the file exceeds 100KB, you'll receive warnings during issue expansion. To manage size:

```bash
# Archive old entries
mv .wavemill/project-context.md .wavemill/project-context-archive-$(date +%Y%m).md
npx tsx tools/init-project-context.ts
# Then manually copy relevant patterns/conventions to new file
```

Best practice: Keep the "Recent Work" log to the last 20-30 entries, archiving older history.

## Subsystem Documentation (Cold Memory)

The `.wavemill/context/` directory contains detailed specifications for each logical subsystem in the codebase. This implements a **three-tier memory system** inspired by "Codified Context: Infrastructure for AI Agents" (arXiv:2602.20478):

- **Hot memory**: `project-context.md` - Concise constitution (always loaded)
- **Cold memory**: Subsystem specs and concept pages (loaded on-demand)
- **Agent memory**: Session-specific context (per workflow)

### Structure

```
.wavemill/
├── project-context.md          # Hot memory (always loaded)
└── context/                     # Cold memory (load on-demand)
    ├── *.md                     # Subsystem specs (module-oriented)
    └── concepts/                # Concept pages (cross-cutting knowledge)
        ├── progressive-disclosure.md
        ├── task-packet-format.md
        └── model-routing-strategy.md
```

### Subsystem Specs vs Concept Pages

**Subsystem specs** (`.wavemill/context/*.md`):
- Module-oriented documentation
- Tied to specific files and directories
- Describe implementation details, constraints, failure modes
- Example: `linear-api.md`, `eval-system.md`, `router.md`

**Concept pages** (`.wavemill/context/concepts/*.md`):
- Cross-cutting knowledge that spans multiple subsystems
- Durable across refactoring (not tied to specific files)
- Define shared vocabulary, invariants, decision criteria
- Example: `progressive-disclosure.md` (applies to task packets, context management, UI design)

**When to use concepts vs subsystems**:
- Use **subsystem specs** when documenting a specific module's implementation
- Use **concept pages** when documenting knowledge that:
  - Applies across multiple subsystems
  - Defines shared vocabulary or patterns
  - Should survive subsystem refactors (file moves, renames)
  - Represents architectural invariants or design principles

### Subsystem Spec Format

Each subsystem spec is structured for machine consumption:

```markdown
# Subsystem: {name}

**Last updated:** {timestamp}
**Files touched:** {count} files in last 30 days

## Purpose
[1-2 sentence description]

## Key Files
| File | Role | Notes |
|------|------|-------|
| ... | ... | ... |

## Architectural Constraints
### DO
- [Concrete rule]

### DON'T
- [Anti-pattern]

## Known Failure Modes
| Symptom | Root Cause | Fix |
|---------|------------|-----|
| ... | ... | ... |

## Testing Patterns
...

## Dependencies
...

## Related Subsystems
- [eval-system](eval-system.md) — eval orchestrator consumes router decisions
- [tools-prompts](tools-prompts.md) — prompt templates reference subsystem constraints

## Recent Changes
[Auto-updated after each PR]
```

### Concept Page Format

Each concept page follows this structure (defined in `tools/prompts/concept-page-template.md`):

```markdown
# Concept: {name}

**Concept ID:** `{id}`

## Purpose
What the concept is and why it exists

## When It Applies
Situations where this concept matters

## Core Invariants
Rules that must remain true regardless of implementation

## Mental Model
How to reason about the concept

## Operational Rules
Actionable constraints an agent should follow

## Boundaries And Non-Goals
What the concept does NOT cover

## References In This Repo
Related subsystem specs, docs, or files

## Examples
Concrete instances in the codebase

## Guidance For Future Updates
What kinds of repo changes should update this page
```

### Generating Concept Pages

To create a new concept page:

```bash
npx tsx tools/generate-concept.ts progressive-disclosure
# Or with context from specific subsystems:
npx tsx tools/generate-concept.ts task-packet-format --subsystems linear-api,context-management
```

This uses LLM to generate a structured concept page at `.wavemill/context/concepts/{concept-id}.md`.

### Automatic Generation

Subsystems are auto-detected during `wavemill init` using heuristic analysis:
- **Directory structure**: Top-level modules in `src/`, `shared/`, `tools/`
- **File naming patterns**: `*-router.ts`, `*-analyzer.ts`, etc.
- **Package dependencies**: Files importing same external packages
- **Git activity**: Frequently co-modified files

### Automatic Updates

After each PR merge, the post-completion hook:
1. Detects which subsystems were affected by the PR
2. Updates the relevant `.wavemill/context/{subsystem}.md` files
3. Adds entry to "Recent Changes" section
4. Updates architectural constraints if new patterns were established
5. Documents failure modes if bugs were fixed

### Drift Detection

Before expanding a Linear issue, the system checks if subsystem specs are stale:
- Compares spec last-modified timestamp vs recent file changes
- Warns when spec is >7 days older than most recent PR
- Lists which PRs affected the subsystem since last update

Example warning:
```
⚠️  DRIFT DETECTED: Some subsystem specs are stale

The following subsystems have been modified since their specs were last updated:

  • Linear API (linear-api)
    Last updated: 2026-02-18 (10 days ago)
    Files modified: 2026-02-28
    Recent PRs: #123, #124, #125

Consider refreshing these specs before relying on them for implementation.
Run: npx tsx tools/init-project-context.ts --refresh
```

### Manual Refreshing

To refresh subsystem navigation without replacing curated documentation:

```bash
# Refresh generated navigation blocks and the project-context index
npx tsx tools/init-project-context.ts --refresh

# This will:
# 1. Re-detect subsystems from current codebase
# 2. Update only marked generated-navigation blocks in existing specs
# 3. Create discovery indexes for stable, previously undocumented areas
# 4. Rebuild subsystem links while preserving project context and Recent Work
```

**Note**: `--refresh` preserves manual edits. The explicitly destructive `--force` option remains available for reinitialization and overwrites existing context.

### Best Practices

1. **Trust the documentation**: Agents rely on subsystem specs - keep them current
2. **Structured format**: Use tables and lists (not prose) for machine readability
3. **Maintenance cost**: ~1-2 hours/week for 34 subsystem specs (per research paper)
4. **Knowledge ratio**: Aim for ~24% (1 doc line per 4 code lines)

## Task Packet Structure (Progressive Disclosure)

When Linear issues are expanded into task packets, they use a **progressive disclosure** approach to reduce context overload:

### Two-File Format

1. **Header** (`task-packet-header.md` or loaded directly)
   - Brief overview (~50 lines)
   - Objective (2-3 sentences)
   - Top 5 key files to modify
   - Top 3 critical constraints
   - High-level success criteria
   - Links to detailed sections

2. **Details** (`task-packet-details.md`)
   - Complete 9-section specification
   - Section 1: Complete Objective & Scope
   - Section 2: Technical Context (all files, dependencies, architecture)
   - Section 3: Implementation Approach (step-by-step plan)
   - Section 4: Success Criteria (with [REQ-FX] requirement tags)
   - Section 5: Implementation Constraints (all rules)
   - Section 6: Validation Steps (concrete test scenarios)
   - Section 7: Definition of Done
   - Section 8: Rollback Plan
   - Section 9: Proposed Labels (for conflict detection)

### How Agents Use This

- **Initial context**: Agents receive the brief header (~50 lines vs ~500 lines)
- **On-demand details**: Agents read specific sections from `task-packet-details.md` as needed
- **Benefits**: Reduces initial token usage by ~90%, keeps context focused on implementation

### Backward Compatibility

- Existing full-format task packets (9 sections in one file) continue to work
- `is_task_packet()` function recognizes both old and new formats
- Linear issues always receive full content (no user-visible changes)

### For AI Agents

When you see a task packet header:
1. Start with the header to understand the objective
2. Read `task-packet-details.md` sections on-demand as you implement
3. Section 6 (Validation Steps) contains concrete test scenarios
4. Section 4 (Success Criteria) has all requirements with [REQ-FX] tags

## Config Loading (TypeScript)

TypeScript modules use `shared/lib/config.ts` for centralized config loading:

```typescript
import { loadWavemillConfig } from './config.ts';

// Load and validate config (cached per repo directory)
const config = loadWavemillConfig(repoDir);
console.log(config.router?.enabled); // typed access

// Or use typed accessors for specific sections
import { getRouterConfig, getEvalConfig } from './config.ts';
const routerConfig = getRouterConfig(repoDir);
const evalConfig = getEvalConfig(repoDir);
```

**Key features:**
- Configs are cached per-process (singleton per repoDir)
- Validated against `wavemill-config.schema.json` at load time
- All fields are optional (graceful degradation)
- Use `clearConfigCache(repoDir)` to force reload in tests
- Config ownership and precedence reference: `docs/config-files.md`

**Implementation:**
- Replaces ~7 independent `readFileSync` + `JSON.parse` blocks
- Uses Ajv for schema validation
- Provides TypeScript types matching the schema

## Permission Configuration (Auto-Approve Read-Only Commands)

The `permissions` section in `.wavemill-config.json` allows you to configure auto-approval for read-only commands, reducing confirmation prompts when working in worktrees.

### Configuration

Add to `.wavemill-config.json`:

```json
{
  "permissions": {
    "autoApprovePatterns": [
      "git status*",
      "git log*",
      "gh pr view*",
      "find *",
      "ls *"
    ],
    "worktreeMode": {
      "enabled": true,
      "autoApproveReadOnly": true
    }
  }
}
```

### Using Permission Patterns in Code

```typescript
import {
  matchesPattern,
  matchesAnyPattern,
  isSafePattern,
  getDefaultPatterns
} from './shared/lib/permission-patterns.ts';

// Check if a command matches a pattern
matchesPattern('git status --short', 'git status*')  // true

// Check if a command matches any pattern
const patterns = ['git status*', 'git log*'];
matchesAnyPattern('git status', patterns)  // true

// Validate pattern is safe (no destructive commands)
isSafePattern('git status*')  // true
isSafePattern('rm *')          // false

// Get all default read-only patterns
const defaults = getDefaultPatterns();
```

### Pattern Categories

Default patterns are organized by category:

- **File System Read**: `find *`, `ls *`, `cat *`, `head *`, `tail *`, etc.
- **Git Read**: `git status*`, `git log*`, `git show*`, `git diff*`, etc.
- **GitHub CLI Read**: `gh pr view*`, `gh issue view*`, etc.
- **Text Search**: `grep *`, `rg *`, `ag *`, `ack *`
- **Package Managers**: `npm list*`, `pnpm list*`, `yarn list*`

### Agent Integration

**For Claude Code:**
```bash
npx tsx tools/generate-permissions.ts --agent claude
# Apply generated settings to Claude Code (see docs/worktree-auto-approve.md)
```

**For Codex:**
```bash
npx tsx tools/generate-permissions.ts --agent codex
# Copy to ~/.codex/permissions.json and restart Codex
```

### Documentation

- [Permission Configuration Guide](docs/permissions.md) - Full reference
- [Worktree Auto-Approve Guide](docs/worktree-auto-approve.md) - Agent setup instructions

### Current incident disposition

`shared/lib/incident-filing-reconciler.ts` owns read-only job currentness.
`readAuthoritativeWorkflowJobs(repoDir)` reads persisted workflow jobs and job artifacts once, preserving contradictory-source diagnostics.
`reconcileIncidentForFiling(incident, repoDir, jobs?)` returns `confirmed_active`, `recovered`, `superseded`, or `needs_inspection`.
Detection, Observer reconciliation/dashboard projection, live/shadow filing and retry draining consume that decision. Recovery requires validated result content and authoritative same-task/side/pair/PR retry timestamps; file presence is never sufficient. Missing or contradictory lineage remains visible for inspection. This API never polls jobs, spends retry budgets or changes task state.
`tools/check-incident-currentness.ts` enforces the shared reader and forbids the retired presence/re-observation decisions.
