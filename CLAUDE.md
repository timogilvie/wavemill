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
1. **Single Source of Truth**: This repo is canonical. `shared/lib/` contains all API logic; `tools/` contains all CLI tools. `wavemill` runs tools directly from the repo — never from `~/.claude/tools/`.
2. **Config Schema**: Both `claude/config.json` and `codex/config.json` follow `claude/config.schema.json`; wavemill runtime config follows `wavemill-config.schema.json`
3. **Shared Templates**: `tools/prompts/` templates are consumed by both toolchains
4. **State Separation**: Claude uses `features/`, `bugs/`, `epics/`; Codex uses `.codex/state/`
5. **Thin Tools Pattern**: Tools in `tools/` are thin wrappers (typically <150 lines) that call shared business logic modules in `shared/lib/`. Business logic is reusable, testable, and documented with comprehensive JSDoc.

### Shared Business Logic Modules

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
- `bounded-retry.sh` - The bounded-retry invariant (HOK-2924): every path that relaunches work after a failure must count attempts against a `(state_dir, bucket, head SHA)` key, back off between attempts, terminalize at a ceiling with a greppable recorded reason (`.retry-<bucket>-exhausted` sentinel), and reset on a new head SHA or successful launch. Terminal causes short-circuit via `bounded_retry_mark_exhausted` without consuming the budget. **New relaunch paths must use this helper — never implement a private retry counter.**
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

Use `wavemill native-agent certify --provider <provider> --model <model> --phase <phase>` for one model, or `wavemill native-agent certify --all --phase workflow` to publish the full current-suite matrix. Use `npx tsx tools/native-agent-certify.ts --refresh-canary-cohort` on the credentialed mill host to refresh live coding canaries for the bounded cohort configured under `nativeAgent.certification.canaryCohort` (HOK-3062); mill preflight runs the same refresh automatically with a one-attempt-per-episode guard, disabled via `canaryAutoRefresh: false` or `WAVEMILL_SKIP_CANARY_AUTO_REFRESH=1`. The mill startup preflight auto-remediates deterministic current-suite gaps, identity drift, stale artifacts, and near-TTL renewal by default. Set `WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE=1` to keep the guard active but require manual certification; set `WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD=1` only for a targeted operator override. Use `wavemill native-agent certifications prune` to report orphan artifacts and `--yes` to remove them.

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
bash tests/run-shell-suite.sh --shard 2/4  # CI shard 2 of 4
bash tests/run-unit-tests.sh               # all unit tests
bash tests/run-unit-tests.sh --shard 2/7   # CI shard 2 of 7
bash tests/run-unit-tests.sh --list        # print selection without running
bash tests/run-custom-tests.sh --shard 2/3 # custom harness CI shard 2 of 3
```

Shell shards are assigned round-robin. Unit and custom shards use **deterministic weighted partitioning**: `tools/partition-tests.ts` (LPT greedy over `shared/lib/test-partitioner.ts`) balances shards using measured per-test medians from the checked-in manifest `tests/ci-test-weights.json`. A newly added test has no manifest entry yet and receives the conservative `defaultMs` weight — adding it to the array is still all that is needed. `tools/check-shard-balance.ts` (preflight) enforces exactly-once assignment, manifest hygiene, and the 130%-of-median balance rule; refresh the manifest with `npx tsx tools/ci-test-timings.ts collect` from ≥3 CI timing artifacts (see `docs/ci-test-timings.md`).

**CI job layout** (`.github/workflows/ci.yml`): `preflight`, `shell` (×4 shards), `unit` (×7 weighted shards), `custom` (×3 weighted shards), `smoke`, and `certification` run in parallel. The `shell-and-unit` job aggregates them into the single status check named **"Shell and Unit Tests"**, which is a required check on `main` — do not rename it without updating branch protection. The unit/custom jobs also upload `timing-*` artifacts used to refresh the weights manifest.

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

All JSON state read-modify-write updates must use `state_mutate` from `shared/lib/wavemill-common.sh` in shell or `mutateJsonState` from `shared/lib/state-mutex.ts` in TypeScript. These helpers serialize concurrent writers with a file lock before writing a temporary file and atomically renaming it into place.

Append-only files such as JSONL logs and `.wavemill/registry/` entries remain lock-free. Hook status files at `/tmp/wavemill-*.hook` also keep their existing single-writer temporary-file pattern.

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
  "timestamp": 1712345678
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
  "timestamp": 1712345678
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
