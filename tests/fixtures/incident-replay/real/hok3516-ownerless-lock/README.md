# HOK-3516 / HOK-3231: ownerless workflow-state lock wedges the mill

Sanitised evidence for the two-step lock-removal class HOK-3516 fixes. No
local paths beyond repo-relative ones, and no operator-identifying details
are kept. Source: `.wavemill/weekly-reviews/evidence/2026-11-24-ownerless-workflow-state-lock/`
(read-only capture) and the archived mill log.

## Shape

The mill ran from a `main` checkout with the HOK-3403 owner-stamped lock in
place. At 2026-11-21 05:06:37Z the holder of the `workflow-state.json` lock
died (cause unknown and immaterial), and the module's own removal path left
`.wavemill/workflow-state.json.lock` behind as an **empty directory**: no
`owner.json`, mode `drwx------`, born in the same second as the last state
write. Because HOK-3403 deliberately never reclaims an ownerless directory at
runtime, every writer then failed with `Timed out acquiring state lock …
after 5000ms` (3,458+ occurrences) for ~88 hours: 0 launches, 0 merges, three
tasks held, inbox frozen at 05:06:34Z. A second ownerless directory,
`.wavemill/quota-state.lock`, appeared the same run after a queue-planner
call was killed on timeout (exit 143).

Root cause: "this lock is gone" was produced in four places as two separate
filesystem steps (unlink `owner.json`, then `rmdir`), while "is this lock
held?" treats the half-removed state as held forever. A concurrent waiter's
`mkdir .reclaim` between the two steps makes the final `rmdir` fail silently;
the waiter then reads no owner, backs off, and removes only its `.reclaim` —
leaving an empty directory nobody owns. Which of the two possible
interleavings (release vs. inspector, or two racing reclaimers) happened on
11-21 is **unknown**: the lock records nothing once its owner file is gone.

After HOK-3516, removal is one atomic rename to a detached private sibling
(`removeLockDirectory` in `state-lock.ts`, `_state_lock_remove` in
`state-lock.sh`), so the lock path goes from owned to absent in one step and
a waiter's `.reclaim` travels with the detached directory.

## Files

- `incident.json` — the sanitised timeline (lock path, stranded-at instant,
  log counts, held tasks) and the oracle: an ownerless directory at the lock
  path must `never` be producible by the module's own operations.

## Oracle

Consumed by `shared/lib/state-lock.hok3516-replay.test.ts` (release racing a
`.reclaim`-spamming inspector; many concurrent waiters reclaiming one dead
owner) and by the deterministic interleaving replay in
`tests/state-lock.test.sh`, which replays the exact 11-21 step sequence:
unlink `owner.json` → waiter's `mkdir .reclaim` → failed `rmdir` → waiter
backs off. Every sampled state of the lock path must be absent or
owner-stamped — never an ownerless directory.
