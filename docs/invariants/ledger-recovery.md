---
title: Ledger recovery
---

# Ledger recovery

`ledger-recovery.ts` `decideRecovery()` - The one recovery *policy* (HOK-3185, Ledger F): for a step past its `deadline` (`upsertStep` stamps the TTL per kind — `WAVEMILL_LEDGER_STEP_TTL_<KIND>_MINUTES`, default review/ready 15m, eval 60m) with no HOK-3101 progress, decide the HOK-3176 outcome — terminal → settle `aborted`, code-failure → remediation request, retryable → the shared `stage-failure-<stage>` bucket (last attempt is a fresh relaunch from the row's inputs) → escalate once as a `waiting_on: operator-event` row. The HOK-3177 replay harness runs every fixture through this policy. The Ledger F shadow recovery tick and its test (PR #1632) were retired in HOK-3235: in shadow mode the per-step rows never settled (1,306 shadow decisions across cleanly merged tasks before deletion), so flipping it live would have relaunched healthy work. HOK-3277 holds the rebuild once step rows settle. Dormant: no recovery rule is enforced here until that rebuild; live stage recovery goes through `classifyFailure` → `maybe_retry_failed_stage` (guarded by the failure-policy check above).
