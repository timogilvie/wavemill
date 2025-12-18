---
description: List Linear backlog issues for the configured project (override project optionally)
argument-hint: "[project]"
---

Run `node codex/src/commands/backlog.js $ARGUMENTS` from the repo root to print backlog items.

- Without args it uses the default project in `codex/config.json`.
- Pass a project name to override: `/prompts:backlog "My Project"`.
