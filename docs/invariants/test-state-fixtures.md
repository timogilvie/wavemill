---
title: Schema-validated test fixtures
---

# Schema-validated test fixtures

**Tests seed workflow state through the schema-validated builders** (HOK-3223): TS uses `buildTask(overrides, { bare? })` / `buildWorkflowState(tasks, { bare?, topLevel? })` from `tests/lib/task-builder.ts`; shell sources `tests/lib/state-fixtures.sh` for `fixture_task` / `fixture_workflow_state <file> <id> field=value [field:=json] [-- <id> ...]` and `fixture_real_state_accessors` (the production `read_state_value` / `get_task_meta` / `state_mutate` / `task_state_mutate_existing` instead of private stubs). An override key that `workflow-task.schema.json` does not declare is an error — a test cannot invent a field no writer sets. The preflight guard `tools/check-test-task-literals.ts` fails on hand-written `tasks: { ... }` literals in tests and fixtures; `tools/test-task-literals-allowlist.txt` is a seeded ratchet that only shrinks (a listed file without a literal fails), and one-off exceptions (deliberately invalid rows, non-workflow-state `tasks` maps) use `// allow-task-literal: <reason>`.
