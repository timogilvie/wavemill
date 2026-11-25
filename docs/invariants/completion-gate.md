# Native Completion Gate Invariant (HOK-3514)

## Rule

Native coding has one completion decision. `.coding-complete` is written only through `executeWholeFileWrite` in `shared/lib/native-agent/tools/mutation-tools.ts`, which calls `evaluateCodingCompletionGate` (`shared/lib/native-agent/completion-gate.ts`) with the task's dirty paths before the marker lands. Never add a second `create_marker` / `write_artifact` tool, and never write the marker on a path that skips the gate.

Which dirty path the coder may commit or discard is decided by one authority, the intended-file tracker (`tools/intended-files.ts`): `git_add`, `git_commit` and `discard_owned_path` consult it. The dirty-handoff recovery guard narrows the tool menu only. It never parses a path list or a command argv of its own.

## Why

HOK-3454 and HOK-3451 (2026-11-11) both parked at needs-user. Each native coder created a file through `run_tests`. The tracker had not recorded it, so `git_add` refused it. Recovery allowed only `git checkout` / `git restore`, which cannot remove an untracked file, and `create_marker` accepted `.coding-complete` on the dirty tree. The gate already existed but had no production caller.

## What the gate reads

`readTaskDirtyPaths` (`shared/lib/worktree-dirty-status.ts`) lists the porcelain status minus Wavemill-owned output. That filter, `isWavemillOwnedDirtyPath`, is the TypeScript twin of `wavemill_owned_dirty_path` in `wavemill-monitor.sh`, so the gate agrees with the monitor's dirty-handoff check. An unreadable status refuses the marker (fail closed).

## Guard

`tools/check-completion-gate.ts` (preflight) fails when:

- `executeWholeFileWrite` no longer reaches `evaluateCodingCompletionGate`, or
- a `create_marker` / `write_artifact` tool descriptor is defined outside `mutation-tools.ts`.

Suppress one line with `// allow-completion-gate: <reason>`.
