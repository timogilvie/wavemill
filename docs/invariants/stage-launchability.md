---
title: Stage launchability
---

# Stage launchability

`stage-launchability.ts` `isLaunchableForStage()` - The router ↔ launcher parity invariant (HOK-3142): the predicate *is* the launcher's resolver (`resolveModelAgent` with the effective registry), and every routing exit runs it through `enforceLaunchableRoute` (`workflow-router.ts` `finalizeDecision`), substituting a launchable model or recording `launchabilityBlocked`. **Every router-selected model must pass this predicate — never add a routing path that returns without `finalizeDecision`.** Enforced by `tools/check-stage-launchability.ts` (every exported route-decision function in `workflow-router.ts` must reach `finalizeDecision`; route-decision functions outside the router are allowlisted). Canary refusals carry a certify command with `--live-coding-canary`.

Cohort health consumes `evaluateNativeProviderGate` for coding readiness (HOK-3501). A fresh canary alone cannot bypass the registry suite, certificate phase, expiry or identity checks. The stage-launchability guard rejects a cohort reader that bypasses this gate.

Provider and native enablement are part of the predicate. With a `repoDir`, `resolveModelAgent` refuses a DeepSeek model on the Claude CLI when `providers.deepseek.enabled` is not true, and refuses a native model when `nativeAgent.enabled` is not true or its provider is turned off (`provider-disabled` / `native-disabled`, see `shared/lib/provider-enablement.ts`). Config is read through `loadWavemillConfig`, so `.wavemill-config.local.json` applies. The router guard, the challenge pool, the challenge scheduler and the launchability doctor therefore never offer such a model. The launch-time refusals in `agent-adapters.sh` and `check-native-agent-launch.ts` stay as defence in depth.
