---
title: Stage launchability
---

# Stage launchability

`stage-launchability.ts` `isLaunchableForStage()` - The router ↔ launcher parity invariant (HOK-3142): the predicate *is* the launcher's resolver (`resolveModelAgent` with the effective registry), and every routing exit runs it through `enforceLaunchableRoute` (`workflow-router.ts` `finalizeDecision`), substituting a launchable model or recording `launchabilityBlocked`. **Every router-selected model must pass this predicate — never add a routing path that returns without `finalizeDecision`.** Enforced by `tools/check-stage-launchability.ts` (every exported route-decision function in `workflow-router.ts` must reach `finalizeDecision`; route-decision functions outside the router are allowlisted). Canary refusals carry a certify command with `--live-coding-canary`.
