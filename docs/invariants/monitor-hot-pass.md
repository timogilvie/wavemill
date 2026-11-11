---
title: Monitor hot pass
---

# Monitor hot pass

`monitor-async-jobs.sh` / `session-gh-cache.ts` - The monitor hot-pass invariant (HOK-3206): no monitor step may block on a slow read. The cross-PR revert guard, live CI status, the ready-watchdog sweep and routing run as tracked jobs (`monitor_async_job_launch` → `launch_tracked_job`, job-tracker kinds `cross-pr-guard` / `pr-ci-status` / `ready-watchdog` / `route-task`) that write condition-keyed result markers; consumers read a result only for the head/base/packet it was computed against, treat anything else as pending (never pass), and charge crashes to a bounded-retry bucket. GitHub PR reads go through the one batched per-pass query (`monitor_refresh_pr_cache` → `<cache>.meta.json` coverage; shell `wavemill_pr_cache_*`, TS `findCachedPullRequest` with `expectedHeadSha` for head-sensitive callers); repo constants through the session repo cache. **New slow ready-path reads must be a tracked job; new per-task PR reads must try the cache first.** Details: `.wavemill/context/ready-stage.md`.
