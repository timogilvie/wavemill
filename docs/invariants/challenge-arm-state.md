---
title: Challenge arm state
---

# Challenge arm state

`shared/lib/challenge-execution-contract.ts` `isChallengeArmPendingState()` /
`shared/lib/challenge-arms.sh` `challenge_arm_state_is_pending()` /
`shared/lib/challenge-arms.sh` `challenge_arm_state_is_valid()` /
`tools/check-challenge-arm-state.ts` (HOK-3451).

The challenge-arm lifecycle states are declared once in
`shared/lib/challenge-execution-contract.ts`:
`awaiting_fork`, `awaiting_expanded_route`, `materializing`, `materialized`,
`cancelled`, `exhausted`. The pending subset is exactly
`awaiting_fork` and `awaiting_expanded_route`; `materializing` is deliberately
*not* pending (the arm is mid-fork and treated as absent).

**Readers must never test `challengeArmState == "awaiting_fork"` privately.**
Derive "is this arm pending?" from `isChallengeArmPendingState` (TS) or
`challenge_arm_state_is_pending` (shell). Writers must transition arms only
through `challenge_arms_set_state`, which validates the target state and
performs compare-and-set inside the locked `state_mutate` jq script.
