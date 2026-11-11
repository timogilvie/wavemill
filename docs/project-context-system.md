---
title: Project Context System
---

# Project Context System

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
