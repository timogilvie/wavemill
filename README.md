# Claude + Codex Workflow Tools

LLM-oriented workflow helpers for Claude and Codex. The repo holds shared Linear/Git helpers plus entry commands for backlog triage, planning, bugfixes, and doc generation. Claude reads commands from `~/.claude/commands/`; Codex reads slash commands from `~/.codex/commands.json` and stores state in `.codex/state/`.

## Requirements

- Node.js >= 18
- npm
- Linear API key (`LINEAR_API_KEY` env var)
- Optional: GitHub CLI (`gh`) for repo automation
- Claude desktop app (for Claude commands) or Codex CLI (for Codex slash commands)

## Fresh Setup

1) Clone:
```bash
git clone <this repo> && cd claude-tools
```

2) Configure:
- Edit `claude/config.json` and `codex/config.json` to match your team/project (both follow `config.schema.json`).
- Export `LINEAR_API_KEY` in your shell or shell profile. `GITHUB_TOKEN`/`gh auth login` is optional but recommended.

3) Sync commands into the assistants (recommended):
```bash
./sync-claude.sh links
# creates ~/.claude/commands -> repo/commands (Claude)
# creates ~/.codex/commands.json -> repo/codex/commands.json (Codex)
```
If you prefer copies instead of symlinks:
- `./sync-claude.sh to-claude` to copy repo commands/tools into `~/.claude/`
- `./sync-claude.sh to-codex` to copy `codex/commands.json` into `~/.codex/`

4) Restart Claude or Codex so the new commands load.

## Using the Commands

Claude (after sync) recognizes:
- `/workflow` – start feature workflow (select backlog issue, set up feature context/state)
- `/plan` – start an epic plan
- `/bugfix` – start a bug investigation/fix
- `/backlog [project]` – list backlog issues (defaults to config project)
- `/generate-doc <type> <name> [--summary "..."] [--output path]` – docs/tasks/PRDs

Codex recognizes the same slash commands once `~/.codex/commands.json` points here. Codex state is kept in `.codex/state/<name>.json`; Claude keeps feature/bug/epic context under the repo (not in `.codex/state/`).

## Keeping Things in Sync

- `./sync-claude.sh status` – show drift between repo, `~/.claude`, and `~/.codex`
- `./sync-claude.sh to-claude | from-claude` – copy repo ⇄ `~/.claude`
- `./sync-claude.sh to-codex | from-codex` – copy repo ⇄ `~/.codex/commands.json`
- `./sync-claude.sh links` – refresh the Claude commands symlink and Codex commands.json symlink

Canonical sources live in this repo (`commands/`, `codex/commands.json`, `shared/lib/`, `tools/`, `templates/`). Avoid committing `.claude/state/` or `.codex/state/`.

## Repo Layout (high level)

- `shared/lib/` – shared Linear/Git/GitHub helpers
- `commands/` – Claude command markdown (symlinked into `~/.claude/commands`)
- `codex/` – Codex commands, state machine, and `commands.json`
- `tools/` – Claude TypeScript entrypoints wrapping shared helpers
- `templates/` – prompt templates used by both toolchains
- `sync-claude.sh` – sync/symlink helper for Claude and Codex

## Troubleshooting

- Slash command missing: ensure `~/.claude/commands` or `~/.codex/commands.json` points at this repo (`./sync-claude.sh links`), then restart the client.
- Linear errors: confirm `LINEAR_API_KEY` is exported and the project name in config exists.
- Permissions errors writing to `~/.claude`/`~/.codex`: rerun sync with a user that owns those dirs or fix directory permissions.
