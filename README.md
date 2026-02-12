# Wavemill - Autonomous AI Workflow Tools

**Wavemill** is a CLI tool for autonomous AI-powered software development workflows. It combines Claude/Codex AI agents with Linear project management to automatically process backlogs, expand issues, and ship features in parallel.

This repo also includes traditional LLM workflow helpers for Claude and Codex: backlog triage, planning, bugfixes, and doc generation via slash commands.

## Requirements

- **Node.js** >= 18
- **npm**
- **Linear API key** (`LINEAR_API_KEY` env var)
- **tmux** (for wavemill mill: `brew install tmux`)
- **jq** (for JSON processing: `brew install jq`)
- Optional: **GitHub CLI** (`gh`) for repo automation
- Claude desktop app (for Claude commands) or Codex CLI (for Codex slash commands)

## Quick Start

### Install Wavemill CLI

```bash
git clone <this repo> && cd wavemill
./install.sh
```

This makes `wavemill` globally accessible. Test with:
```bash
wavemill help
```

### Configure for your project

1. **Set Linear API key:**
```bash
export LINEAR_API_KEY="your-key-here"
# Add to ~/.zshrc or ~/.bashrc for persistence
```

2. **Create `.wavemill-config.json` in your repo:**
```json
{
  "linear": {
    "project": "Your Project Name"
  }
}
```

### Run Wavemill

```bash
# Start continuous autonomous loop
cd ~/your-repo
wavemill mill

# Or expand issues interactively
wavemill expand
```

## Claude/Codex Commands Setup (Optional)

For traditional slash commands in Claude/Codex:

1) Configure:
- Edit `claude/config.json` and `codex/config.json` to match your team/project (both follow `config.schema.json`).
- Export `LINEAR_API_KEY` and optionally `GITHUB_TOKEN`/`gh auth login`.

2) Sync commands into the assistants:
```bash
./sync-claude.sh links
# creates ~/.claude/commands -> repo/commands (Claude)
# creates ~/.codex/prompts -> repo/codex/prompts (Codex custom prompts)
```

3) Restart Claude or Codex so the new commands load.

## Using the Commands

Claude (after sync) recognizes:
- `/workflow` – start feature workflow (select backlog issue, set up feature context/state)
- `/plan` – start an epic plan
- `/bugfix` – start a bug investigation/fix
- `/backlog [project]` – list backlog issues (defaults to config project)
- `/generate-doc <type> <name> [--summary "..."] [--output path]` – docs/tasks/PRDs

Codex (after syncing prompts) recognizes:
- `/prompts:workflow` – runs `node codex/src/commands/start-workflow.js`
- `/prompts:plan` – runs `node codex/src/commands/start-plan.js`
- `/prompts:bugfix` – runs `node codex/src/commands/start-bugfix.js`
- `/prompts:backlog [project]` – runs `node codex/src/commands/backlog.js [project]`
- `/prompts:generate-doc <type> <name> [...]` – runs `node codex/src/commands/generate-doc.js ...`

Codex state is kept in `.codex/state/<name>.json`; Claude keeps feature/bug/epic context under the repo (not in `.codex/state/`).
Using a pre-0.73 Codex build? Keep syncing `commands.json` and call `/commands:<name>` instead of `/prompts:<name>`.

## Keeping Things in Sync

- `./sync-claude.sh status` – show drift between repo, `~/.claude`, and `~/.codex`
- `./sync-claude.sh to-claude | from-claude` – copy repo ⇄ `~/.claude`
- `./sync-claude.sh to-codex | from-codex` – copy repo ⇄ `~/.codex` (commands.json + prompts)
- `./sync-claude.sh links` – refresh the Claude commands symlink and Codex prompts/commands symlink

Canonical sources live in this repo (`commands/`, `codex/prompts/`, legacy `codex/commands.json`, `shared/lib/`, `tools/`). Avoid committing `.claude/state/` or `.codex/state/`.

## Wavemill Commands

### `wavemill mill` - Continuous Task Execution

Fully autonomous task execution system that continuously processes your Linear backlog.

**What it does:**
1. Fetches prioritized tasks from Linear backlog (auto-detects project from `.wavemill-config.json`)
2. Ranks tasks using intelligent priority scoring (considers: Linear priority, task packet completeness, foundational work, dependencies, estimates)
3. Auto-expands issues without detailed descriptions (using Claude + issue-writer prompt)
4. Launches parallel agent workers in tmux windows (default: 3 concurrent tasks)
5. Monitors PR creation and merge status
6. Auto-cleans completed tasks (closes tmux windows, removes worktrees, updates Linear to "Done")
7. Prompts for next batch with 10s auto-continue

**Usage:**
```bash
cd ~/my-repo
wavemill mill

# With custom settings:
MAX_PARALLEL=5 wavemill mill
```

**Controls:**
- `Ctrl+B D` - Detach from tmux (loop continues in background)
- `touch ~/.wavemill/.stop-loop` - Stop loop after current cycle
- `Ctrl+C` - Interrupt and reset in-progress tasks to Backlog

**Features:**
- **Conflict avoidance** - Won't run multiple tasks on same area/component
- **Migration conflict prevention** - Pre-assigns migration numbers to parallel tasks
- **Validation gates** - Checks CI status and merge target before marking tasks "Done"
- **State persistence** - Tracks all work in `.wavemill/workflow-state.json`

**Environment variables:**
- `MAX_PARALLEL` - Number of parallel tasks (default: 3)
- `SESSION` - Tmux session name (default: wavemill)
- `AGENT_CMD` - Agent to use (default: claude, can be: codex)
- `WORKTREE_ROOT` - Worktree location (default: ../worktrees)
- `BASE_BRANCH` - Base branch (default: main)
- `POLL_SECONDS` - PR polling interval (default: 10)
- `DRY_RUN` - Dry run mode (default: false)
- `REQUIRE_CONFIRM` - Require confirmations (default: true)

### `wavemill expand` - Batch Expand Linear Issues

Interactively expand multiple Linear issues with detailed task packets.

**What it does:**
1. Fetches Linear backlog (auto-detects project from repo)
2. Filters to issues WITHOUT detailed task packets
3. Ranks by priority score (same algorithm as wavemill mill)
4. Shows up to 9 candidates
5. Lets you select up to 3 issues
6. Expands each with Claude using issue-writer prompt
7. Extracts and applies suggested labels
8. Updates both description and labels in Linear

**Usage:**
```bash
cd ~/my-repo
wavemill expand

# With custom project:
PROJECT_NAME="My Project" wavemill expand
```

**Environment variables:**
- `PROJECT_NAME` - Linear project name (auto-detected from `.wavemill-config.json`)
- `MAX_SELECT` - Max issues to select (default: 3)
- `MAX_DISPLAY` - Max issues to display (default: 9)

**Output example:**
```
Issues needing expansion (ranked by priority, showing up to 9):

1. HOK-219 - Build Registration Dashboard (score: 85)
2. HOK-217 - Add Usage Credits System (score: 75)
3. HOK-216 - Create Welcome Email (score: 70)

Enter up to 3 numbers to expand (e.g. 1 3 5), or press Enter to skip:
> 1 2 3

Processing HOK-219...
  ✓ Expanded and updated in Linear
  → Adding labels...
    ✓ Added: Risk: Medium
    ✓ Added: Layer: UI
    ✓ Added: Area: Dashboard
```

## Under the Hood

### Wavemill Architecture

The `wavemill` CLI is a thin wrapper around these core scripts:

- **`wavemill-mill.sh`** - Main loop implementation
- **`wavemill-orchestrator.sh`** - Parallel task launcher (tmux)
- **`wavemill-expand.sh`** - Issue expansion implementation
- **`wavemill-common.sh`** - Shared utilities (DRY)

**Shared functions in wavemill-common.sh:**
- `detect_project_name()` - Auto-detect Linear project from `.wavemill-config.json`
- `is_task_packet()` - Check if issue has detailed description
- `score_and_rank_issues()` - Priority scoring algorithm
- `expand_issue_with_tool()` - Expand issues using expand-issue.ts
- `write_task_packet()` - Backwards-compatible wrapper
- `extract_labels_from_description()` - Parse labels from expanded issues

## Repo Layout

```
wavemill/
├── wavemill                    # Main CLI entry point
├── install.sh                  # Installation script
├── shared/lib/                 # Core autonomous workflow scripts
│   ├── wavemill-mill.sh       # Continuous task execution loop
│   ├── wavemill-orchestrator.sh # Parallel task launcher (tmux)
│   ├── wavemill-expand.sh     # Batch issue expansion tool
│   ├── wavemill-common.sh     # Shared functions (DRY)
│   └── linear.js              # Linear API client
├── tools/                      # TypeScript wrappers for Linear API
│   ├── expand-issue.ts        # Expand single issue with Claude CLI
│   ├── add-issue-label.ts     # Add labels to Linear issues
│   ├── list-backlog-json.ts   # Fetch backlog as JSON
│   └── get-issue-json.ts      # Fetch single issue as JSON
├── commands/                   # Claude slash commands (symlinked)
├── codex/                      # Codex commands and prompts
└── sync-claude.sh             # Sync helper for Claude/Codex
```

## Troubleshooting

- Slash command missing: ensure `~/.claude/commands` or `~/.codex/prompts` points at this repo (`./sync-claude.sh links`), then restart the client. On older Codex builds also confirm `~/.codex/commands.json` is linked.
- Linear errors: confirm `LINEAR_API_KEY` is exported and the project name in config exists.
- Permissions errors writing to `~/.claude`/`~/.codex`: rerun sync with a user that owns those dirs or fix directory permissions.
