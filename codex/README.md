# Codex Workflow Helpers

This directory contains Codex-ready helpers that mirror the Claude workflows while keeping phase gates and state in code. Codex CLI 0.73+ loads custom prompts from `~/.codex/prompts` (trigger with `/prompts:<name>`).

## Commands

- Entry prompts (mirroring Claude):
  - `/prompts:workflow` → `node codex/src/commands/start-workflow.js` (fetch backlog, prompt selection, create feature dir/context, initialize state).
  - `/prompts:bugfix` → `node codex/src/commands/start-bugfix.js` (fetch backlog, prompt selection, create bug dir/context, initialize state).
  - `/prompts:plan` → `node codex/src/commands/start-plan.js` (fetch backlog, prompt selection, create epic dir/context, initialize state).
  - `/prompts:backlog` → `node codex/src/commands/backlog.js [project]` (list Backlog issues; defaults to config project).
  - `/prompts:generate-doc` → `node codex/src/commands/generate-doc.js <type> <name> [--summary "..."] [--output path]`.

- Workflow gate helper (used by the entry commands internally):
  - `node codex/src/commands/workflow.js init|complete|status|next ...`

State is stored in `.codex/state/<feature>.json` to allow context handoff across sessions without mixing with Claude state.

## Config

`codex/config.json` follows `claude/config.schema.json`. Override with `CODEX_CONFIG_PATH` if needed. The config keeps Linear project names, git prefixes, and test commands in sync with the Claude stack while allowing separate runtime files.

## Syncing prompts into Codex

- `./sync-claude.sh links` – symlink `codex/prompts` → `~/.codex/prompts`
- `./sync-claude.sh to-codex` – copy prompts into `~/.codex/prompts`
- Restart Codex after syncing so it reloads the prompt list.
