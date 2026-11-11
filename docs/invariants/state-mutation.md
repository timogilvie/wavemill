---
title: State mutation
---

# State mutation

All JSON state read-modify-write updates must use `state_mutate` from `shared/lib/wavemill-common.sh` in shell or `mutateJsonState` from `shared/lib/state-mutex.ts` in TypeScript. For `workflow-state.json`, TypeScript uses `mutateWorkflowState` from `shared/lib/workflow-state.ts` (a typed, validating wrapper around `mutateJsonState`). These helpers serialize concurrent writers with a file lock before writing a temporary file and atomically renaming it into place.

Writes to `workflow-state.json` validate the task records they add or change against the HOK-3220 schema at the write seam (HOK-3222): `mutateJsonState` / `mutateJsonStateSync` in TS (so every `mutateWorkflowState` caller) and `state_mutate` in shell, via `tools/validate-task-record-write.ts` under the lock (Node type stripping, never `tsx`). Both call `shared/lib/task-record-write-guard.ts`; only violations the write introduced count. During the HOK-3222 bake (`WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW`, `0` = kill switch) violations are shadow-logged to `.wavemill/state-schema-violations.jsonl` + stderr + one observer finding per new signature and the write proceeds; Phase 2 refuses the write.

Append-only files such as JSONL logs and `.wavemill/registry/` entries remain lock-free. Hook status files at `/tmp/wavemill-*.hook` also keep their existing single-writer temporary-file pattern.

Per-task writes that may run after the task has been reaped (background eval completion, job-poll settlement, retry bookkeeping) must go through `task_state_mutate_existing` in `shared/lib/wavemill-common.sh`. A raw `.tasks[$issue].x = …` state_mutate recreates the reaped entry as a phase/status/slug/lifecycle-less stub that consumes a mill slot (HOK-3125). The counter also classifies such stubs as `orphan` as defense in depth, but the writer guard is the primary fix.
