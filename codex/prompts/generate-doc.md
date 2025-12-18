---
description: Generate docs/tasks/PRDs via the Codex doc generator
argument-hint: "<type> <name> [--summary \"...\"] [--output path]"
---

Run `node codex/src/commands/generate-doc.js $ARGUMENTS` from the repo root.

- `type` can be `prd`, `tasks`, `bug-investigation`, `bug-hypotheses`, `bug-tasks`, etc.
- `name` is the feature/bug slug.
- Optional: `--summary "..."` to seed the doc, `--output path` to change the target file.
