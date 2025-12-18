---
description: Start bugfix workflow (pick a backlog bug, create bug dir, init Codex state)
argument-hint: ""
---

Run `node codex/src/commands/start-bugfix.js` from the repo root.

What it does:
- Reads the default Linear project from `codex/config.json` and lists backlog issues.
- Prompts you to pick a bug, then writes `bugs/<bug>/selected-task.json`.
- Initializes `.codex/state/<bug>.json` with the investigation plan path and branch name.

After the script prints the follow-up commands, continue with investigation/implement/validate using the paths it outputs.
