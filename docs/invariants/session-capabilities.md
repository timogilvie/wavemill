---
title: Session capabilities
---

# Session capabilities

`config.ts` `resolveSessionCapabilities()` / `wavemill_session_has` (`wavemill-common.sh`) - The single session-capability resolver (HOK-3102): every producer of consumer-bound work (tend handoffs, `wm:ready` labels, pane releases to the merge queue, merge-candidate lifecycle, observer findings, merge-lane BEHIND updates) checks the matching consumer through this helper before producing work. `mergeExecutor` is `tend | operator | none`; `mergeQueue` is on only when `mergeExecutor === 'tend'` and `mergeQueue.enabled`. **Never re-derive from `integration.enabled` / `useMillSession` / `MERGE_QUEUE_ENABLED` / `observer.enabled` at a producer site.** Enforced by `tools/check-session-capabilities.ts`. Health is advisory only, never gating.
