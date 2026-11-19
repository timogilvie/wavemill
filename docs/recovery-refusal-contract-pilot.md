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

## Revised decision after external review (2026-11-19)

Land the bug fixes and retain their regression tests. Defer packaging a recipe,
workflow-wide prompt changes, a new specification framework and TLA+ installation.
An independent reuse test comes before any packaging decision.

The generated sequence count is not a state-coverage claim. The HOK-3512 generated
case projects its history onto four booleans: refused, held, complete and stale.
That is at most 16 configurations in a fixed failure context, with a handwritten
priority oracle. Its one-event counterexample is also catchable by a table test.
Other table/preservation cases check additional dimensions, but the useful new
composition findings came from the journeys and persisted-claim test. Neither
journey explores all interleavings. HOK-3491's generated test uses 12 samples and
a fixed suffix through a relatively expensive shell adapter.

Revised sequence:

1. Finish the existing bug-fix PR: repair the schema/type retirement and JSON
   fixture-loading CI failures, verify a clean checkout, and retain the HOK-3505
   landing dependency. At review time HOK-3505 is In Progress in PR #1894;
   its earlier PR #1886 closed without merging. Keep unrelated pricing work in
   PR #1895 separate. Do not deploy the new retry key into active old-key tasks.
2. Run one bounded independent trial on the next suitable, unfixed recovery
   issue (HOK-3514 or HOK-3504 are candidates, subject to their current status).
   A different model receives issue evidence and the public contract, without
   the proposed patch, implementation priority ladder or previous oracle.
   Freeze its expectations before the implementation is changed. Require it
   to reject the original code and a held-out plausible incomplete fix, accept
   the correct fix, and preserve legitimate holds/completion/stale-control
   behavior. Record its incremental authoring effort. If it cannot do that,
   stop this adoption experiment; do not package the recipe first.
3. Only if that trial succeeds, extend existing suites with the demonstrated
   general obligation. A standing controller property should be scoped to
   current, unfinished recovery obligations and distinguish live work,
   completion consumption, effect verification and stale rejection. A wait
   needs an actual reachable producer or deadline; a producer name alone is
   insufficient. Keep retry-allowance accounting at its existing owner and
   exercise adapter/claim interleavings where the pure function has no state.
   Do not create a second all-purpose recovery model.
4. Move a decision out of bash when fixing a concrete duplicated-owner defect,
   deleting the competing path in the same change. File relocation and line
   counts alone are not evidence of reduced ownership or better liveness.
5. Use the existing weekly review for a three-to-four-week decision checkpoint
   if the independent trial passes. Track regressed/partial fixes per eligible
   recovery change, incremental engineering effort, and unattended completion
   in that cohort alongside the overall unattended rate. Use existing operator
   touch classification. If the trial fails or the follow-on evaluation shows
   no benefit, stop additional methodology work and retain useful regression
   tests. Insufficient sample volume does not justify a rollout.

The helper property "a new head resets the bucket" is valid when that head is
its caller's input (for example review). HOK-3491 passed a coder's output as that
input. A standing requirement must constrain this binding rather than globally
forbid head-based resets. Correct requirement selection remains the problem.

This was one author's work on two known defects. There is no independent-agent
adoption result, production reliability gain, development-time saving or formal
liveness proof. HOK-3511 owns route construction. Missing windows without exit
evidence and complete Hokusai feedback coverage remain separate work.


Fault injection in both golden journeys targets coding. Planning/review refusal
forwarding is checked at the adapter boundary, not by a full faulted journey for
each phase. The existing planning/review valid-route restoration remains outside
this consolidation. The stronger local result is that the coding retry and
missing-window paths now share control and cannot race through the retired
direct coding launcher; the ownership guard rejects reintroducing that shape.

## Integration compatibility update (2026-11-19)

CI at `aa2f37f5` failed both refusal journeys after the integration merge brought
in HOK-3511. The journeys corrupted only the saved agent. Recovery now correctly
re-derives the executor from the saved model, so that historical mismatch is
repaired and the task completes instead of escalating. The test was waiting for
an outcome that the new executor contract intentionally makes unreachable.

The journey fault now removes the saved coding model after a correctly routed
agent starts. The real validator must confirm `contract_missing`; stale executor
metadata remains repairable. The operator restores the exact original model
through `reroute-task.ts`, which derives its executor through the canonical
resolver. This changes test injection and expectations, not production routing
or refusal policy. The historical issue fixture remains historical evidence;
`stage-executor-replay.test.ts` covers its now-correct repair behavior.

Local verification after the fixture update: both full journeys pass (19 ticks,
263 seconds and 278 seconds), as do 25 execution-contract, stage-executor replay
and recovery-contract checks, full preflight and `git diff --check`. These are
local results; the new remote run must test the pushed remediation commit.
