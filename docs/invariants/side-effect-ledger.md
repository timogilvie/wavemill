---
title: Side-effect ledger
---

# Side-effect ledger

`side-effect-ledger.ts` `shadowRecordSideEffect()` - Ledger D side-effect rows (HOK-3183, Phase 1 shadow): every git push, PR label write, Linear state transition and tend PR merge records one `side_effect` row keyed per design §4b (`gitPushKey` `(remote, ref, oid)`, `prLabelKey` `(pr, label, action, head_oid)`, `linearTransitionKey` `(issue, from, to, trigger_event_id)`, `prMergeKey` `(pr, merged head)`). A repeated key bumps `attempt` and writes `side-effect-duplicate-attempt` evidence; an already-in-place observation (branch reused, PR already merged) passes `observation: true` and never counts. The monitor tick runs `tools/ledger-detect-duplicates.ts` (`monitor_side_effect_detector_tick`, every `SIDE_EFFECT_DETECTOR_INTERVAL_SECONDS`, kill switch `WAVEMILL_SIDE_EFFECT_DETECTOR_DISABLED=1`) and logs `[side-effect-duplicate]` warn lines plus `.wavemill/side-effect-duplicates.jsonl`. Behaviour is unchanged until the Gate flips each site to "insert row → read `applied_at` → skip or apply". **New external-effect sites must shadow-record through this helper with the shared key builders.** Enforced by `tools/check-side-effect-ledger.ts`: push / label / merge / Linear `stateId` sites are counted per file against a ratchet, so a new site fails until it goes through a recorded seam.
