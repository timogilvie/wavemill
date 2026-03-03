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
- `difficulty-analyzer.ts` - Analyze PR difficulty
- `task-context-analyzer.ts` - Analyze task characteristics
- `repo-context-analyzer.ts` - Analyze repository context
- `outcome-collectors.ts` - Collect CI, test, review outcomes

#### Utilities
- `prompt-utils.ts` - Prompt template filling
- `llm-cli.ts` - Claude CLI integration
- `string-utils.ts` - String manipulation (kebab-case, etc.)
- `shell-utils.ts` - Safe shell command execution
- `linear.js` - Linear API client
- `config.ts` - Centralized config loading

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
- **Cold memory**: `.wavemill/context/{subsystem}.md` - Detailed specs (loaded on-demand)
- **Agent memory**: Session-specific context (per workflow)

### Structure

```
.wavemill/
├── project-context.md          # Hot memory (always loaded)
└── context/                     # Cold memory (load on-demand)
    ├── linear-api.md
    ├── eval-system.md
    ├── context-management.md
    └── ...
```

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

## Recent Changes
[Auto-updated after each PR]
```

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
Run: npx tsx tools/init-project-context.ts --force
```

### Manual Refreshing

To regenerate subsystem specs:

```bash
# Regenerate all subsystem specs
npx tsx tools/init-project-context.ts --force

# This will:
# 1. Re-detect subsystems from current codebase
# 2. Regenerate all .wavemill/context/*.md files
# 3. Update project-context.md with new subsystem links
```

**Note**: Manual edits to subsystem specs are preserved in version control, but will be overwritten by `--force`. Consider updating via PR instead.

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
npx tsx tools/generate-claude-permissions.ts
# Apply generated settings to Claude Code (see docs/worktree-auto-approve.md)
```

**For Codex:**
```bash
npx tsx tools/generate-codex-permissions.ts
# Copy to ~/.codex/permissions.json and restart Codex
```

### Documentation

- [Permission Configuration Guide](docs/permissions.md) - Full reference
- [Worktree Auto-Approve Guide](docs/worktree-auto-approve.md) - Agent setup instructions

