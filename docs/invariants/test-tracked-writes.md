---
title: Tracked-repo-path writes in tests
---

# Tracked-repo-path writes in tests

**Tests must not write tracked repo paths** (HOK-3157, extends [HOK-3121](https://linear.app/hokusai/issue/HOK-3121)): a killed test run (SIGKILL, `run_tests` timeout, suite-level kill) skips `finally` blocks and leaves tracked files modified, which parks the task's coding handoff on a dirty tree. Tests must write only to `mkdtemp` directories and inject the path (e.g. `templatePath`). Two guards enforce this:
- Static preflight: `tools/check-test-tracked-writes.ts` (in `test:preflight`) scans tracked `*.test.{ts,tsx,js,jsx,mjs,cjs}` for literal fs mutator writes to tracked repo paths. Suppress with `// allow-tracked-write: <reason>`.
- Runtime: `tests/lib/tracked-tree-guard.sh`, wired into `tests/run-unit-tests.sh` and `tests/run-custom-tests.sh`, snapshots tracked-file status before each run and fails if any tracked file was modified during the run (untracked artifacts and pre-existing dirt are ignored).
