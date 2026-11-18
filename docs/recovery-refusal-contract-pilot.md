# Recovery refusal contract pilot — HOK-3512

## Selection and prediction (before implementation)

HOK-3512 is a Now task, currently blocked for landing by HOK-3505. This second
proof point stays in the existing isolated pilot branch/draft PR. It does not
change production configuration or remove that dependency. HOK-3511 owns why
the saved route is wrong; this pilot owns the outcome of any validator refusal.

Prediction: the existing controller returns a permanent tool wait for a refused
coding route. An independently stated progress contract will reject it and
also reject an overly broad fix that escalates before consuming completion,
honoring a human hold, or fencing stale control. Full validator evidence must
reach the same controller and escalation primitive from each refusal entry.

## Contract

* A current failed stage with a positively refused saved route reaches visible,
  reason-bearing escalation; repeated polling alone does not repair that route.
* Backoff does not hide a deterministic refusal. A repaired route can retry
  within the existing bounded allowance; no automatic model substitution occurs.
* Stale control, explicit human holds, valid completion, uncertain external
  effects and genuinely in-flight work retain their existing precedence.
* Failed-stage and missing-window refusal use the same policy and escalation
  decision. They do not author private stopped state or raw blocked hooks.

## Existing owners and evidence

| Question | Owner | Change to evaluate |
| --- | --- | --- |
| Can the saved route launch? | `execution-contract.ts` validator | Retain its full result rather than reducing it to a boolean |
| What recovery action is legal? | `task-recovery-controller.ts` | Compose refusal with existing safety/hold/completion priority |
| Is refusal terminal until intervention? | `failure-policy.ts` | Reuse the existing `recovery_contract_unavailable` vocabulary with a reasoned allowlist entry |
| How is an operator alerted? | `operator-escalation.*` and `attention.ts` | Existing policy-terminal marker and projection |
| What expires attention after a reroute? | Condition reconciler/operator events | Existing operator-event expiry, not a new timer |
| Identity, claims, retry allowance | Existing attempt/claim/bounded-retry primitives | Preserve; no new counter or state fields |

Owning issue: [HOK-3512](https://linear.app/hokusai/issue/HOK-3512).
Adopted plan: [Stage route ownership, rule 6](https://linear.app/hokusai/document/stage-route-ownership-plan-of-record-156306dc3ba6).
Recent merged work reviewed in the base checkout includes
[PR #1856, controller ownership](https://github.com/timogilvie/wavemill/pull/1856)
and [PR #1738, recovery contracts](https://github.com/timogilvie/wavemill/pull/1738).
Prior attempts: HOK-2601 (private stop), HOK-3326 (contract replay), HOK-3277
(controller plus the wakeless wait). The fixture transcribes the November 17
HOK-3500 incident from Linear. Raw transcript, incident-time manifest, confirmed
executed model and metered cost are not available in this pilot; none is inferred
from the saved route. Route refusal is a harness fault, not model quality signal.

## Scope and reuse measurement

Reuse the first pilot's contract/preservation/negative-control/report pattern,
shared fast-check seed helper, task fixture builders, shared fakes, real monitor
journey and existing guards. The new controller contract runs in-process so
generation need not launch a shell for every step. Measure its runtime and the
new adapter work separately. No general framework or broad prompt changes.

## Observed results

Baseline was recorded before implementation. With seed 3512, the original
controller failed the historical replay, refusal table and generated property;
the generated counterexample shrank to `["refuse"]` (path `7:0`). The priority
preservation check passed against that baseline. A deliberately overbroad
"escalate every refusal first" mutation fails the preservation and read-failure
checks as well as the reason-bearing contract.

The first implementation passed the pure suite and the normal failed-stage
journey, but the lost-window journey rejected it: repair bypassed the retry
claim. A separate persisted-claim check reproduced duplicate escalation after
an acknowledged worker exited. A subsequent full journey counted three coding
launches instead of two: the missing-window restorer raced the supervised retry
between its running-result write and window creation. Coding restoration now
requests the same controller action and its competing direct launcher is removed.
The adapter also checks that queued jobs revalidate the operator's latest route
and retain a pre-existing terminal failure, such as recorded spend exhaustion.
These are integration counterexamples, not
additional historical incident facts. They justify keeping both layers.

A missing pane without a recorded exit is not proof that an agent ended. An
initial live-window-removal experiment correctly retained the liveness hold;
the final lost-window replay removes the pane after the real fake-agent exit
is recorded. Fixture fault injection and renamed window titles also caused
test-construction failures; the final test uses the shared task-window resolver
and explicitly asserts that the monitor observed the missing window.

Final local validation on 2026-11-18:

| Check | Result |
| --- | --- |
| Action contract | Five checks pass, including 1,000 generated sequences, seed 3512; generated property body took 72 ms on this host |
| Focused unit suites | 50 controller checks plus 65 contract/policy/taxonomy/guard checks pass; combined latter invocation took 2.14 seconds |
| Monitor adapter | Six checks pass: all three stages retain validator evidence, queued jobs read a repaired route, evidence identity changes, write failures stay retryable, existing terminal failures survive, no private state/result writes |
| Normal failed-stage journey | Pass, 17 ticks / 197 seconds |
| Lost-window journey | Pass, 19 ticks / 213 seconds; confirms the missing-window entry, one initial coding launch plus one authorized retry, stable attention across polls and worker exit, audited operator repair, then review and merge |
| Shared-world hygiene | Both journeys' runner reports success with no unhandled fake calls or leaked world resources |
| First-pilot regression | Six checks pass, including 12 generated sequences, seed 3491, 62.8 seconds |
| Existing regression suites | Stage recovery 21, Ready first-failure 9, Ready failure classification 35, startup handoff 29 and routing writes 16 checks pass; review-window and contract replay suites pass |
| Shell validation | 881 pass, zero fail |
| Preflight and whitespace | Full repository preflight and `git diff --check` pass |

The pure contract is much cheaper to execute than the first pilot's per-step
shell adapter. Authoring and debugging the adapter/journeys still dominated the
work; no development-time savings were measured. These timings came from one
local host under concurrent checks, not a controlled benchmark.

The earlier remote run at `d7cd52a9` completed with only **OpenRouter Alias
Audit** failing: live llama-4-maverick cache-read pricing differed from the local
registry. [Failed job](https://github.com/timogilvie/wavemill/actions/runs/44393523535/job/135117301015).
That catalog/pricing issue is separate from these local pilot results. New-head
CI status must be checked separately after publication.

A finite progress
contract is not an unbounded temporal-logic proof. HOK-3505/3511 dependencies,
production exposure and Hokusai feedback coverage remain separate from local
validation; no issue is closed by this pilot report.


## Reproduction and repeatable assets

```bash
FAST_CHECK_SEED=3512 node --test tests/recovery-refusal-contract.test.ts
bash tests/recovery-refusal-adapter.test.sh
node --test shared/lib/task-recovery-controller.test.ts shared/lib/failure-policy.test.ts
bash tests/journeys/run-journeys.sh recovery-route-refusal recovery-route-refusal-missing-window
```

For the historical negative control, save
`git show d7cd52a9:shared/lib/task-recovery-controller.ts` outside the checkout
and pass that path as `RECOVERY_CONTRACT_CONTROLLER_SOURCE` to the first command.
The test-only loader compiles just that source against current dependencies;
it does not claim to replay a complete incident-time build. The fixture is a
sanitized Linear evidence packet, not an actual provider transcript.

Reusable assets are the contract/preservation/negative-control/report recipe,
the existing seed helper and fast-check dependency, the small test-only source
loader, the shared state builders and fake services, and ordinary CI recipes.
The oracle and adapter are specific to the obligation being checked. The new
adapter checks full evidence forwarding and changed claim identity; it replaces
the controller boundary with snapshot capture, so it is not an escalation proof.
The journeys supply that missing integration evidence.

The explicit operator intervention uses the existing audited reroute CLI and
an explicit operator-release event through `operator_event_record`. The CLI
alone does not emit that release event today; this pilot does not pretend that
it does. No automatic route change or model substitution is added.
An explicit release also changes recovery evidence even if the route remains
refused, so reconciliation cannot clear attention and leave an applied old
claim silently suppressing the next assessment. The adapter checks this case.

## Assessment

This second application supports making the recipe a targeted part of
specification and root-cause work: state the obligation and preservation rules
before coding, reject the old implementation and a plausible incomplete fix,
then run the real journey. Keep the pure checks in the normal testing suite.
It does not justify installing TLA+, mandating a model language for every task,
or changing all phase prompts. Revisit formal model checking when the state
space or concurrency assumptions can no longer be covered economically by
these finite checks.

This is the same author's second application to a known backlog defect, not a
blind discovery benchmark or an independent-agent adoption trial. It measures
regression detection and reuse, not production reliability gains. HOK-3505 stays
a landing dependency; HOK-3511 still owns saved-route construction. General
recovery of a missing window with no exit evidence remains outside this slice.


Fault injection in both golden journeys targets coding. Planning/review refusal
forwarding is checked at the adapter boundary, not by a full faulted journey for
each phase. The existing planning/review valid-route restoration remains outside
this consolidation. The stronger local result is that the coding retry and
missing-window paths now share control and cannot race through the retired
direct coding launcher; the ownership guard rejects reintroducing that shape.
