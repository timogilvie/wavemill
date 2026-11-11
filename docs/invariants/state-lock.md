---
title: State locks
---

# State locks

**State locks (HOK-3403):** all state lock ownership and reclaim decisions go
through `shared/lib/state-lock.{ts,sh}` and `process-identity.{ts,sh}`. Locks
are owner-stamped directories and are reclaimed only when the local owner PID
and start time prove dead; lock age and an ownerless legacy form are never a
runtime reclaim signal. `tools/check-state-lock.ts` enforces this boundary.
