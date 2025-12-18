---
description: Start an epic/plan workflow (select backlog issue, create epic dir, init Codex state)
argument-hint: ""
---

Run `node codex/src/commands/start-plan.js` from the repo root.

What it does:
- Reads the default Linear project from `codex/config.json` and lists backlog issues.
- Prompts you to pick an epic, then writes `epics/<epic>/selected-task.json`.
- Initializes `.codex/state/<epic>.json` with the plan path and branch name.

Use the printed next steps to flesh out the plan and move through the gated phases.
