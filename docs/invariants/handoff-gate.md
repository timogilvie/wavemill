---
title: Handoff gate
---

# Handoff gate

`shared/lib/ready-tend-handoff.ts` `handoffStateIsPublished()` /
`tools/check-handoff-state.ts` (HOK-3450).

"May Tend take this PR?" has one answer, read from the Ready→Tend handoff
record (`.ready-tend-handoff.json`) at the PR head. The record's states are
declared once, in `READY_TEND_STATES`: `checked`, `ready-published`,
`tend-claimed`. A handoff is *published* when its state is `ready-published`
or `tend-claimed`; `checked` (Ready passed but the publish did not land) is
not.

Both consumers use that one test:

- `deriveMergeLabel` rule 7 grants `wm:ready` only for a published handoff at
  the PR head. A `checked` record derives no label.
- `classifyClaim` (Tend's claim) refuses an unpublished record as
  `not-published`.

So the label never offers Tend a PR its claim will refuse.

**Never compare a handoff state literal outside the handoff module.** Use
`handoffStateIsPublished`, `classifyClaim` or `isMatchingTendClaim`. Shell
callers run `tools/ready-tend-handoff.ts`, which exits non-zero on a rejected
transition so the monitor's transition-failure path
(`ready_failure_classify_and_act`) sees it.

The record carries no failure diagnostic. A failed transition is recorded in
`.ready-result.json` `artifacts.transitionFailure`.
