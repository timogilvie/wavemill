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
6. **Model selection belongs to Hokusai**: Hokusai decides which model runs each stage, including whether a cheaper model's risk is worth taking. A model failure is fixed by making it visible to Hokusai, with correct attribution, fault class, cost and outcome. It is never fixed by changing coder policy locally. See "Model selection belongs to Hokusai" in `AGENTS.md`.

### Shared Business Logic Modules

**Guards cap new invariants (HOK-3236).** A "never do X" rule lives in its own file under `docs/invariants/<name>.md`, with one index line here naming the rule, the guard that enforces it, and the file path. A PR that adds a new invariant adds the file, its index line, and its guard (`tools/check-<name>.ts`, built on `tools/lib/source-guard.ts` with `invariantDocs` set to the new file, wired into `test:preflight`) in the same PR; a rule that cannot be enforced mechanically does not get an invariant file. `source-guard.ts` provides the shared semantics: tracked files only, invariant source auto-excluded, whole-line comments skipped, `// allow-<name>: <reason>` on the line or the line above, and a ratcheting allowlist (`<path> [<count>]  # reason`) that only shrinks.

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
- **Bounded retry (HOK-2924)** — New relaunch paths must use this helper — never implement a private retry counter. Guard: `tools/check-retry-sentinel.ts`. → [docs/invariants/bounded-retry.md](docs/invariants/bounded-retry.md)
- **Install-health verdict (HOK-3315)** — Never compare lockfile bytes or hand-roll a `.packages` diff outside this file. Guard: `tools/check-install-verdict.ts`. → [docs/invariants/install-health-verdict.md](docs/invariants/install-health-verdict.md)
- **Failure policy (HOK-3176)** — Never add a classifier branch that parks: add a fixture to `failure-policy.fixtures.test.ts`, and only extend the allowlist (with a reason and test) when retrying provably cannot change the outcome. Guard: `tools/check-failure-policy.ts`, `tools/check-ready-failure-policy.ts`. → [docs/invariants/failure-policy.md](docs/invariants/failure-policy.md)
- **Merge labels (HOK-3181, HOK-3449)** — Never write or clear `wm:blocked`, call `setWavemillBlocked` / `releaseToBlocked`, or run `gh pr comment` outside those modules; `setMergeLabel` alone changes `wm:ready`/`wm:blocked`. Guard: `tests/check-label-write-sites.test.sh`, `tools/check-merge-block-writers.ts`. → [docs/invariants/merge-labels.md](docs/invariants/merge-labels.md)
- **Handoff gate (HOK-3450)** — Never compare a handoff state outside its module. Guard: `tools/check-handoff-state.ts`. → [docs/invariants/handoff-gate.md](docs/invariants/handoff-gate.md)
- **Head publication (HOK-3370)** — Never instruct an agent to push, publish a task-branch head outside the seam, instruct an agent to open a PR, or compare evidence head SHAs raw. Guard: `tools/check-head-publication.ts`. → [docs/invariants/head-publication.md](docs/invariants/head-publication.md)
- **Challenge route (HOK-3156)** — New pair writers must assert through this check — never diff routes privately. Guard: `tools/check-challenge-route.ts`. → [docs/invariants/challenge-route.md](docs/invariants/challenge-route.md)
- **Challenge arm state (HOK-3451)** — Use the declared predicate; write via `challenge_arms_set_state`. Guard: `tools/check-challenge-arm-state.ts`. → [docs/invariants/challenge-arm-state.md](docs/invariants/challenge-arm-state.md)
- **Session capabilities (HOK-3102)** — Never re-derive from `integration.enabled` / `useMillSession` / `MERGE_QUEUE_ENABLED` / `observer.enabled` at a producer site. Guard: `tools/check-session-capabilities.ts`. → [docs/invariants/session-capabilities.md](docs/invariants/session-capabilities.md)
- **Task progress / liveness (HOK-3101)** — New decision sites must go through the primitive — never re-derive liveness from a private TTL check. Guard: `tools/check-hook-ttl.ts`, `tools/check-agent-background-work.ts`. → [docs/invariants/task-progress.md](docs/invariants/task-progress.md)
- **Stage-agent teardown (HOK-3359)** — Never kill a task window or send teardown keystrokes outside `stage_agent_teardown`. Guard: `tools/check-stage-teardown.ts`. → [docs/invariants/stage-teardown.md](docs/invariants/stage-teardown.md)
- **Ready remediation disposition (HOK-3322)** — Never decide "remediation in flight" from running + same head or pane activity — read the disposition. Guard: `tools/check-ready-remediation-disposition.ts`. → [docs/invariants/ready-remediation-disposition.md](docs/invariants/ready-remediation-disposition.md)
- **Stage-agent disposition (HOK-3386)** — Never re-derive a stage-agent in-flight decision from a private `task_progress_json` jq filter or a private launch-identity read — consume `stage_agent_disposition`. Guard: `tools/check-ready-remediation-disposition.ts`, `tools/check-stage-agent-exit.ts`. → [docs/invariants/stage-agent-disposition.md](docs/invariants/stage-agent-disposition.md)
- **Attention (HOK-3423)** — Never classify inbox membership in the dashboard, decide attention from a raw hook state, re-check retry exhaustion, or read `.needs-attention` outside the escalation module, the reconciler and `attention.ts`. Guard: `tools/check-attention.ts`. → [docs/invariants/attention.md](docs/invariants/attention.md)
- **Condition-keyed markers (HOK-3172, HOK-3452)** — Declare `--expires-on`; clears live in the reconciler; read eval-failure decisions via `eval_failure_decision_current`. Guard: `tools/check-condition-markers.ts`. → [docs/invariants/condition-markers.md](docs/invariants/condition-markers.md)
- **Monitor hot pass (HOK-3206)** — New slow ready-path reads must be a tracked job; new per-task PR reads must try the cache first. Guard: none (see `.wavemill/context/ready-stage.md`). → [docs/invariants/monitor-hot-pass.md](docs/invariants/monitor-hot-pass.md)
- **Stage launchability (HOK-3142)** — Every router-selected model must pass this predicate — never add a routing path that returns without `finalizeDecision`. Guard: `tools/check-stage-launchability.ts`. → [docs/invariants/stage-launchability.md](docs/invariants/stage-launchability.md)
- **Provider identity (HOK-3143)** — Never trust the requested wire id as `executedModel` — stage results must carry the provider-reported id and `executionEvidence.source: 'provider-response'`. Guard: `tools/check-provider-identity.ts`. → [docs/invariants/provider-identity.md](docs/invariants/provider-identity.md)
- **Per-stage route record (HOK-3363)** — Never replace a decided stage model without appending an override, and never keep a private route-change flag (`routeChanged`, `preEscalationRoute`, `launchabilitySubstitutions`, `provenance.escalation`) or a local coder ranking. Guard: `tools/check-stage-launchability.ts`. → [docs/invariants/route-override-record.md](docs/invariants/route-override-record.md)
- **Model identity (HOK-3321)** — Never compare a model-named identifier with `===`/`!==` in challenge code. Guard: `tools/check-model-equivalence.ts`. → [docs/invariants/model-equivalence.md](docs/invariants/model-equivalence.md)
- **Executed-model record (HOK-3369)** — Never author a second executed-model derivation site, add an agent-type gate in `write_stage_result`, or write `runtime_fallback` / `missing_execution_evidence` outside `stage-result.ts`. Guard: `tools/check-executed-model-resolver.ts`. → [docs/invariants/executed-model-resolver.md](docs/invariants/executed-model-resolver.md)
- **Task identity (HOK-3113..HOK-3118)** — Never parse or build `_c` inline, and never author an inline issue-ID regex outside `task-identity.*`. Guard: `tools/check-task-identity.ts`. → [docs/invariants/task-identity.md](docs/invariants/task-identity.md)
- **Workflow-state shape (HOK-3220)** — Narrow with `Pick<TaskRecord, ...>`; a new written field goes into the schema + `TaskRecord` + `npx tsx tools/generate-schema-validators.ts`. Guard: `tools/check-task-record-shape.ts`. → [docs/invariants/workflow-state-shape.md](docs/invariants/workflow-state-shape.md)
- **Side-effect ledger / ledger recovery (HOK-3183 / HOK-3185)** — _retired 2026-11 (HOK-3274)._ The mill task ledger shadow had no live consumer and was deleted rather than flipped to authoritative. External-effect dedup is each caller's own observed-state read; `workflow-state.json` (via `state_mutate` / `mutateJsonState`) and `stage-result.ts` are authoritative; live stage recovery runs through `classifyFailure` → `maybe_retry_failed_stage`; monitoring is the HOK-3229 I9/I10 invariants. See `docs/mill-task-ledger-design.md` §8.
- **Incident replay fixtures (HOK-3231)** — A PR that fixes an incident recorded in `.wavemill/incidents/` must include that incident's evidence as a replay fixture. Guard: prompt rule (`tools/prompts/coding-phase.md`, both review prompts). → [docs/invariants/incident-replay-fixtures.md](docs/invariants/incident-replay-fixtures.md)
- **Feature flags (HOK-3235)** — New flag writers must add their row in the same PR as the flag — no new `WAVEMILL_*` without a doc entry. Guard: `tools/check-feature-flags.ts`. → [docs/invariants/feature-flags.md](docs/invariants/feature-flags.md)
- **Behavioural tests (HOK-3237)** — Tests assert against *behaviour*, not against the source text of `shared/lib/**` or `tools/**`. Guard: `tools/check-source-text-assertions.ts`. → [docs/invariants/behavioural-tests.md](docs/invariants/behavioural-tests.md)
- **Operator touch (HOK-3455)** — Every decision about whether a person had to act is made by `classifyOperatorTouch` in `shared/lib/operator-intervention.ts`. Guard: `tools/check-human-touch.ts`. → [docs/invariants/operator-touch.md](docs/invariants/operator-touch.md)
- **Settled attempt (HOK-3373)** — Never write `workflow-state.json` around the seam, write Linear state outside the renderer, or `git -C` / `mkdir -p` a task path outside the resolver. Guard: `tools/check-settled-attempt.ts`. → [docs/invariants/settled-attempt.md](docs/invariants/settled-attempt.md)
- **Live-state invariants (HOK-3229)** — New structural invariants belong in this evaluator — never add a private detector. Guard: none (evaluator rule). → [docs/invariants/state-invariants.md](docs/invariants/state-invariants.md)
- **Task evidence retention (HOK-3475)** — Use one typed inventory for cleanup and readers; archive owned transcripts and Ready results before resource release. Guard: `tools/check-task-evidence.ts`. → [docs/invariants/task-evidence.md](docs/invariants/task-evidence.md)
- **Session ownership and cost (HOK-3077)** — Record launch costs only through `recordLaunch` / `session_ownership_append`; never add a private cost engine. Guard: `tools/check-cost-ownership.ts`, `tools/check-session-ownership.ts`. → [docs/invariants/session-ownership-cost.md](docs/invariants/session-ownership-cost.md)
- **Inputs before approval (HOK-3253)** — Never write planning `awaiting_user` without passing this gate. Guard: journey only. → [docs/invariants/inputs-before-approval.md](docs/invariants/inputs-before-approval.md)
- **Native loop budget** — Native coding uses the shared loop budget; entire tool batches, including invalid calls, are admitted before dispatch. Guard: `tools/check-stage-exit-identity.ts`. → [docs/invariants/native-loop-budget.md](docs/invariants/native-loop-budget.md)
- `prompt-utils.ts` - Prompt template filling
- **Output reservation (HOK-3448)** — `AdapterLimits.reservedOutputTokens` is context space for input preflight, distinct from the explicit invocation cap `AdapterInvokeOptions.maxOutputTokens`. Guard: `tools/check-output-reservation.ts`. → [docs/invariants/output-reservation.md](docs/invariants/output-reservation.md)
- **Review result (HOK-3448)** — `claude-cli-output.ts` is the only interpreter of Claude CLI stdout; `review-engine.ts` never decides review completion from text shape. Guard: `tools/check-review-report-boundary.ts`. → [docs/invariants/review-result.md](docs/invariants/review-result.md)
- **Model transport (HOK-3460)** — Model CLI transport stays in `shared/lib/model-adapters/`. Guard: `tools/check-model-transport.ts`. → [docs/invariants/model-transport.md](docs/invariants/model-transport.md)
- `llm-cli.ts` - `callLLM` policy (candidate ladder, retry/backoff, quota state, fallback events); transport runs through `model-adapters/`
- `string-utils.ts` - String manipulation
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

## Commands

### Linear Backlog Tool
To fetch the Linear backlog:
```bash
npx tsx tools/get-backlog.ts "Project Name"
```

### Operator Tools
Tools the mill never calls, used by hand or by agents during recoveries, are listed in `docs/operator-tools.md` with what each does and whether it writes. Check it before writing a one-off recovery script. `tools/check-operator-tools.ts` (preflight) fails when an unreferenced tool is missing from the list or a listed tool doesn't run with `--help`; tools that parse their own arguments call `exitOnHelp` from `shared/lib/tool-runner.ts` first.

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

## Test Discovery

A test runs because it exists. There is no list to edit (HOK-3466); `shared/lib/test-discovery.ts` decides the suite from the file itself:

| File | Suite |
|------|-------|
| `*.test.ts` / `*.test.js` anywhere | `unit` (`node --test`, `tests/run-unit-tests.sh`) |
| `tests/**/*.test.sh` | `shell` (`tests/run-shell-suite.sh`) |
| Any `.sh` file, or an extensionless script whose first line is a bash shebang or `# shellcheck shell=bash` | syntax-checked by `tests/check-shell.sh` |

A file overrides the default with a marker comment in its first lines: `// wavemill-test-suite: custom` (custom-harness `process.exit(1)` style, `tests/run-custom-tests.sh`), or `# wavemill-test-suite: lifecycle | standalone | none` to stay out of the sharded runners. An unknown suite name fails discovery. `node tools/discover-tests.ts --suite <shell|unit|custom>` prints a suite.

All three suites delegate to sharding runners:

```bash
bash tests/run-shell-suite.sh              # all shell tests
bash tests/run-shell-suite.sh --shard 2/3  # CI shard 2 of 3
bash tests/run-unit-tests.sh               # all unit tests
bash tests/run-unit-tests.sh --shard 2/7   # CI shard 2 of 7
bash tests/run-unit-tests.sh --list        # print selection without running
bash tests/run-custom-tests.sh --shard 2/3 # custom harness CI shard 2 of 3
```

Shell, unit and custom shards all use **deterministic weighted partitioning**: `tools/partition-tests.ts` (LPT greedy over `shared/lib/test-partitioner.ts`) balances shards using measured per-test medians from the checked-in manifest `tests/ci-test-weights.json`. A newly added test has no manifest entry yet and receives the conservative `defaultMs` weight — creating the file is all that is needed. `tools/check-shard-balance.ts` (preflight) enforces exactly-once assignment, manifest hygiene, and the 130%-of-median balance rule; refresh the manifest with `npx tsx tools/ci-test-timings.ts collect` from ≥3 CI timing artifacts (see `docs/ci-test-timings.md`).

**CI job layout** (`.github/workflows/ci.yml`): `preflight`, `shell` (×3 weighted shards), `unit` (×7 weighted shards), `custom` (×3 weighted shards), `smoke`, and `certification` run in parallel. The `shell-and-unit` job aggregates them into the single status check named **"Shell and Unit Tests"**, which is a required check on `main` — do not rename it without updating branch protection. The shell/unit/custom jobs all upload `timing-*` artifacts, and all three feed the weights manifest.

- **Golden journeys and shared fakes (HOK-3226)** — Never start a test tmux server, `set -m` launch or placeholder outside `tests/fakes/lib.sh`, or resolve tmux privately. Guard: `tools/check-test-world-lifetime.ts`. → [docs/invariants/golden-journeys.md](docs/invariants/golden-journeys.md)

- **Tracked-repo-path writes in tests (HOK-3157)** — Tests must write only to `mkdtemp` directories and inject the path; a killed run must not leave tracked files modified. Guard: `tools/check-test-tracked-writes.ts`, `tests/lib/tracked-tree-guard.sh`. → [docs/invariants/test-tracked-writes.md](docs/invariants/test-tracked-writes.md)

- **Schema-validated test fixtures (HOK-3223)** — Tests seed workflow state through the schema-validated builders (`buildTask`/`buildWorkflowState`, `fixture_*`), never a hand-written `tasks: { ... }` literal. Guard: `tools/check-test-task-literals.ts`. → [docs/invariants/test-state-fixtures.md](docs/invariants/test-state-fixtures.md)

## Prompt Locations

Use [docs/prompt-locations.md](docs/prompt-locations.md) as the canonical registry for agent instruction locations that must be updated together.

## Hook-Based Status Tracking

Wavemill tracks agent lifecycle through a JSON status file contract at `/tmp/wavemill-${SESSION}-${ISSUE}.hook`. See [docs/hook-status-tracking.md](docs/hook-status-tracking.md) for the protocol, adapters, JSON format, dashboard refresh, OSC 7501 mirror and dependency notes.

## State Mutation

- **State locks (HOK-3403)** — All state lock ownership and reclaim decisions go through `shared/lib/state-lock.{ts,sh}` and `process-identity.{ts,sh}`. Guard: `tools/check-state-lock.ts`. → [docs/invariants/state-lock.md](docs/invariants/state-lock.md)

- **State mutation** — All JSON state read-modify-write updates use `state_mutate` / `mutateJsonState` (and `mutateWorkflowState` for `workflow-state.json`), never a raw write. Guard: write-seam validation (`tools/validate-task-record-write.ts`, HOK-3222). → [docs/invariants/state-mutation.md](docs/invariants/state-mutation.md)

### Prompt Version Registry

Template usage is logged to `.wavemill/evals/prompt-registry.jsonl` for GEPA attribution via `loadPromptTemplate()`. See [docs/prompt-version-registry.md](docs/prompt-version-registry.md).

## Project Context

`.wavemill/project-context.md` (hot memory) and `.wavemill/context/` (cold memory) hold living project documentation. See [docs/project-context-system.md](docs/project-context-system.md) for initialisation, updates, drift detection and concept pages.

## Task Packet Structure (Progressive Disclosure)

Task packets use a two-file format (a brief header plus detailed sections). See [docs/task-packet-structure.md](docs/task-packet-structure.md).

## Config Loading (TypeScript)

TypeScript modules load config through `shared/lib/config.ts` (`loadWavemillConfig`, typed accessors, schema validation, per-repo caching). See [docs/config-loading.md](docs/config-loading.md).

## Permission Configuration (Auto-Approve Read-Only Commands)

The `permissions` section in `.wavemill-config.json` configures auto-approval for read-only commands. See [docs/permission-configuration.md](docs/permission-configuration.md).

### Current incident disposition

- **Current incident disposition** — `shared/lib/incident-filing-reconciler.ts` owns read-only job currentness; detection, projection, filing and retry draining consume `reconcileIncidentForFiling`. Guard: `tools/check-incident-currentness.ts`. → [docs/invariants/incident-currentness.md](docs/invariants/incident-currentness.md)