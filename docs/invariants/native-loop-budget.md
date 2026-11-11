---
title: Native loop budget
---

# Native loop budget

`native-agent/loop.ts` / `native-agent/tools/git.ts` / `wavemill_iso8601_to_epoch` — Native coding uses the shared loop budget (200 turns, 1,200 admitted tool calls, 60 minutes, shared stagnation thresholds). Entire tool batches, including invalid calls, are admitted before dispatch. Patch pre/post statistics use Git numstat before the crash-atomic write; private LCS tables are forbidden. Coding age checks use the shared ISO parser so native millisecond timestamps reach recovery. Enforced by `tools/check-stage-exit-identity.ts`; replay coverage includes a 24k-line patch under a 64 MiB heap, oversized tool batches and the agent-killed-mid-stage golden journey (HOK-3330).
