---
description: Start feature workflow (pick a backlog issue, create feature dir, init Codex state)
argument-hint: ""
---

Run `node codex/src/commands/start-workflow.js` from the repo root.

What it does:
- Reads the default Linear project from `codex/config.json` and lists backlog issues.
- Prompts you to pick an issue, then writes `features/<feature>/selected-task.json`.
- Initializes `.codex/state/<feature>.json` with the plan path and branch name.

After the script prints the follow-up commands, continue with plan/implement/validate using the paths it outputs.
