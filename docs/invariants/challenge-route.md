---
title: Challenge route
---

# Challenge route

`challenge-execution-contract.ts` `assessChallengeRouteInvariant()` / `tools/check-challenge-route.ts` - The one-variable route invariant (HOK-3156): a challenge pair's arms must differ in exactly the varied stage. Post-expansion re-routing freezes challenge arms to their sealed route and never rewrites an executed stage; fork materialisation collapses a drifted pair as `challenge_collapsed reason=route-drift`, and the pre-review preflight collapses arms that differ beyond the varied stage as `challenge_collapsed reason=multiple-varied-roles` (both harness-fault `invalid_challenge`). `challengeModel` names the varied stage's model; read the coder from `coderModel` (`challenge_coder_model_for_task`). **New pair writers must assert through this check — never diff routes privately.**
