# Retry contract pilot — HOK-3491

## Question and prediction

Can an independently stated workflow requirement catch a defect that passes
the existing bounded-retry helper tests, using the software already installed?

Prediction: holding coding/planning input constant while varying output commits
will reveal allowance refills in the pre-pilot monitor. Input-keyed admission
and accounting will prevent them. Review/Ready must still reset when the input
head or merge-base changes. Reconciliation must not reopen exhausted coding.

## Behavioral contract

| Property | Requirement |
| --- | --- |
| Ceiling | At most the configured number of relaunches for unchanged stage input |
| Output independence | Planning/coding commits do not replenish that allowance |
| New input | Replaced recorded input or task run can receive a new allowance |
| Preservation | Review/Ready still reset on new head or merge-base |
| Exhaustion | Reconciliation preserves coding exhaustion; the real monitor escalates visibly |

The oracle counts authorized relaunches per input. It does not compare the
implementation with a copy of its key formula or private storage layout.
The fixture limit is three, matching this incident; it does not change defaults.

## Evidence and reuse decisions

Owner: [HOK-3491](https://linear.app/hokusai/issue/HOK-3491). The sanitized
fixture transcribes the owning issue's November 15 sequence. It is not a raw
provider transcript. The issue reports eight relaunches/nine sessions; its
displayed log excerpt accounts for seven relaunches. These are different
coverage counts, not interchangeable measurements. Incident-time harness
manifest, provider-confirmed execution identity and exact metered cost are
unknown here; the pilot makes no new model-fault or cost attribution.

| Decision | Existing owner | Pilot change |
| --- | --- | --- |
| Counter, backoff, ceiling, reset | `bounded-retry.sh` | None; pass stage input as its existing key |
| Stage input identity | Task `runId` and `lifecycle.launchContract.baseSha` | One monitor key adapter consumed by admission and accounting |
| Failure classification and recovery | Failure policy and recovery controller | No policy change |
| Marker expiry | Condition reconciler | Input-key prefix prevents an unrelated HEAD from expiring coding exhaustion |
| External execution | Shared fakes and journey harness | Scripted coder commits and exits on every launch |

No task-state fields, retry buckets, model-routing policy, dependency or
production feature flag is added. Production changes are in the monitor's
existing recovery adapter. `Consolidation Exception`: the small shared key
adapter adds lines while replacing the two output-keyed bindings; this pilot's
new code is predominantly tests and evidence.

## Repeatable assets

* `tests/fixtures/retry-contract/hok-3491.json`: historical sequence and coverage.
* `tests/stage-retry-contract.test.ts`: independent oracle, preserved cases,
  generated sequences with a reproducible seed and counterexample shrinking.
* `tests/lib/stage-retry-contract.sh`: executes actual monitor admission and
  accounting, shared retry storage and the condition reconciler in temp repos.
  It projects the controller CLI to the snapshot's retry verdict and replaces
  agent execution/UI; it does not test controller claims or actual agents.
* `tests/journeys/coding-retry-input-budget.journey.sh`: actual monitor,
  controller/claims, worker, git commits and agent exits through shared fakes.
* Existing retry-sentinel preflight guard: now also rejects admission/accounting
  that bypass the declared key adapter.

Run from the checkout:

```bash
FAST_CHECK_SEED=3491 node --test tests/stage-retry-contract.test.ts
node --test shared/lib/retry-sentinel-guard.test.ts
bash tests/stage-failure-retry.test.sh
bash tests/journeys/run-journeys.sh coding-retry-input-budget
```

Negative control (expected nonzero exit):

```bash
git show 27ba68a3:shared/lib/wavemill-monitor.sh > /tmp/retry-contract-old-monitor.sh
RETRY_CONTRACT_MONITOR_SOURCE=/tmp/retry-contract-old-monitor.sh FAST_CHECK_SEED=3491 \
  node --test --test-name-pattern='HOK-3491|generated' tests/stage-retry-contract.test.ts
```

`RETRY_CONTRACT_MONITOR_SOURCE` is a test-only source injection, never a
production routing/configuration option. Schema builders validate task rows;
all test mutations occur in temporary directories. Real lock tests need process
identity access; golden journeys additionally require bash 4+, git and tmux.

## Limits and next decision

Generated traces sample finite behavior; this is not a formal liveness proof.
The recorded launch base is coarser than an arbitrary revised plan: this pilot
does not invent a new plan-input version. A future distinct input needs an
existing authoritative revision or a separately designed contract. Upgrading
an existing head-keyed bucket to the new input key can grant one new allowance;
deployment/migration behavior needs review before production rollout.

This evaluates a known defect, not blind discovery performance. No second
agent has independently reused the adapter. No production deployment, lower
operator-touch rate or cost improvement is established. Broad prompt/skill
changes and a general specification framework remain outside this pilot.

Continue with one second problem only if the negative control, preserved
cases and full journey pass, and the incremental work is small enough to reuse.
The shell adapter is Wavemill-specific; the contract format, sequence oracle,
negative control and replay-report pattern are the reusable parts.

## Observed results

Verified 2026-11-18, against base `27ba68a3` plus this pilot:

| Check | Observed result |
| --- | --- |
| Original monitor negative control | Historical replay and generated property both fail as expected; seed 3491 shrinks to planning with an empty generated prefix (the fixed failure/output/reconcile suffix remains) |
| Incomplete fix mutation | A raw input-SHA key still fails the reconciliation case: the exhaustion companion expires against output HEAD; the tagged input key passes |
| Generated contract suite | All six checks pass; final seed 3570245532, 12 generated sequences; includes temporary input-evidence loss |
| Existing retry/guard unit tests | 19 pass |
| Existing stage recovery suite | 21 pass, including backoff, replacement input, review merge-base reset, challenger retirement and delayed worker fencing |
| Ready regression suites | 9 first-failure/attention checks and 35 failure-disposition checks pass |
| Full journey | First completed positive run: four coding launches total, three retries, one plan approval, escalation still present after four more ticks; 26 monitor ticks / 194 seconds |
| Repository preflight | Passes, including CI recipe registration, schemas, tracked-write and ownership guards |

Test-construction errors were caught and corrected: the task fixture initially
omitted required lifecycle fields; the first journey assertion read `basis`
instead of the actual `escalationBasis`; the review preservation fixture needed
zero test backoff. Sandbox-denied process identity and tsx IPC caused separate
infrastructure failures; those checks were rerun with the required access.
These are not production counterexamples or autonomous coding success.

The adapter suite took roughly 46–67 seconds on this host, mostly shell/git/jq
processes; the full journey took several minutes. This is useful CI coverage,
but the feedback loop needs to become cheaper before applying it broadly.

**Assessment:** supported for catching a known semantic defect and rejecting
an incomplete solution across two primitives. It does not establish blind bug
finding, general adoption cost or production improvement. Proceed to one second
problem using the same evidence/contract/negative-control pattern; do not yet
build a general framework or mandate broad prompt changes.

Final rerun: six contract checks pass in 63.5 seconds (seed 3570245532);
latest monitor journey passes in 25 ticks / 236 seconds; shell checks pass
877/877. No external deployment or model execution was performed.

The second application is recorded in
[Recovery refusal contract pilot](recovery-refusal-contract-pilot.md). It reuses
this recipe on HOK-3512 and adds a fast in-process action oracle, then uses real
journeys to expose integration defects that the pure oracle alone did not catch.


Post-review landing gate (2026-11-19): this PR does not migrate persisted retry
buckets. A live old head-keyed bucket would receive a fresh allowance under the
new input key. Drain existing task runs before starting a monitor bundle with
this change, preserving their normal outcomes and evidence. If a deployment
cannot wait for that boundary, it needs a separately reviewed/tested counter
migration before rollout. Do not reset buckets or mint replacement runs to work
around this restriction. Merge is not evidence that the running bundle changed.

The revised adoption decision is in the second report: independent reuse comes
before packaging or broader workflow changes. The helper's head-reset property
remains valid for input heads; the defect was the caller's choice of identity.
