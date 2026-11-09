# Terminal planning feedback replay

Reduced from HOK-3424_c on 2026-11-08: four GLM-5.3 planning attempts,
40 turns each, all ending in tool use without a final plan. The termination
recorder wrote a local failure eval with `trainingEligible: false`; the normal
contribution converter rejected it as `arm-terminated`.

`incident.json` retains only route, budget, identity and usage facts. Prompts,
assistant text, reasoning and local worktree paths have been removed. Provider
response identifiers are replaced with deterministic replay IDs. The replay
injects a one-cent generation charge per response through the existing exact
pricing seam, so all 160 turns are costed by the SDK without network access.

The regression verifies completion feedback separately from output-quality and
reward eligibility. It also checks that harness/unknown faults, absent identity,
identity contradictions, and failed cost measurement remain held. The extended
operator-abort journey exercises the real recorder before building the v4 row.
