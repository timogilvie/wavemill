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
2. **Config Schema**: Both `claude/config.json` and `codex/config.json` follow `config.schema.json`
3. **Shared Templates**: `tools/prompts/` templates are consumed by both toolchains
4. **State Separation**: Claude uses `features/`, `bugs/`, `epics/`; Codex uses `.codex/state/`

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

## Syncing with ~/.claude

This repo is the source of truth. `~/.claude/` is a consumer that can optionally sync from the repo for use by Claude commands outside of wavemill.

```bash
# Sync repo → ~/.claude (after making changes in the repo)
./sync-claude.sh to-claude

# Sync ~/.claude → repo (if you edited tools directly in ~/.claude)
./sync-claude.sh from-claude

# Check sync status
./sync-claude.sh status

# Set up symlinks for commands
./sync-claude.sh links
```

`wavemill` will warn on startup if `~/.claude/tools/` has drifted from the repo.