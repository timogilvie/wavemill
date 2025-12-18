# Claude + Codex Workflow Tools

LLM-oriented workflow helpers for Claude and Codex. The repo holds shared Linear/Git helpers plus entry commands for backlog triage, planning, bugfixes, and doc generation. Claude reads commands from `~/.claude/commands/`; Codex CLI (0.73+) loads custom prompts from `~/.codex/prompts` (triggered with `/prompts:<name>`) and stores state in `.codex/state/`. Older Codex builds still look for `/commands:<name>` entries in `~/.codex/commands.json`, which the sync script keeps updated.

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
# creates ~/.codex/prompts -> repo/codex/prompts (Codex custom prompts)
# (keeps ~/.codex/commands.json in sync for older Codex builds that use /commands:<name>)
```
If you prefer copies instead of symlinks:
- `./sync-claude.sh to-claude` to copy repo commands/tools into `~/.claude/`
- `./sync-claude.sh to-codex` to copy Codex prompts (and commands.json) into `~/.codex/`

4) Restart Claude or Codex so the new commands load.

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

Canonical sources live in this repo (`commands/`, `codex/prompts/`, legacy `codex/commands.json`, `shared/lib/`, `tools/`, `templates/`). Avoid committing `.claude/state/` or `.codex/state/`.

## Repo Layout (high level)

- `shared/lib/` – shared Linear/Git/GitHub helpers
- `commands/` – Claude command markdown (symlinked into `~/.claude/commands`)
- `codex/` – Codex commands/state machine plus custom prompts
- `tools/` – Claude TypeScript entrypoints wrapping shared helpers
- `templates/` – prompt templates used by both toolchains
- `sync-claude.sh` – sync/symlink helper for Claude and Codex

## Troubleshooting

- Slash command missing: ensure `~/.claude/commands` or `~/.codex/prompts` points at this repo (`./sync-claude.sh links`), then restart the client. On older Codex builds also confirm `~/.codex/commands.json` is linked.
- Linear errors: confirm `LINEAR_API_KEY` is exported and the project name in config exists.
- Permissions errors writing to `~/.claude`/`~/.codex`: rerun sync with a user that owns those dirs or fix directory permissions.
