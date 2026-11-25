---
title: State locks
---

# State locks

**State locks (HOK-3403):** all state lock ownership and reclaim decisions go
through `shared/lib/state-lock.{ts,sh}` and `process-identity.{ts,sh}`. Locks
are owner-stamped directories and are reclaimed only when the local owner PID
and start time prove dead; lock age and an ownerless legacy form are never a
runtime reclaim signal. `tools/check-state-lock.ts` enforces this boundary.

**One lock removal (HOK-3516):** a lock path stops existing only through the
rename-away helper in each twin (`removeLockDirectory` in `state-lock.ts`,
`_state_lock_remove` in `state-lock.sh`): the lock directory is atomically
renamed to a detached private sibling and deleted there. A direct recursive
removal of a lock path is two filesystem steps, and a concurrent waiter's
`mkdir .reclaim` between them strands an ownerless directory that nothing may
reclaim at runtime — the 2026-11-21 incident wedged the mill for ~88 hours
this way. `tools/check-state-lock.ts` rejects direct `rm -rf` / `rmSync` /
`rmdir` of a lock path outside the twins.
