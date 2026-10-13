# pi-durable crash-test spike (HOK-3150)

Throwaway spike that answers the HOK-3149 questions about moving the wavemill
native coding arm from `pi-agent-core`'s loop to `@earendil-works/pi-durable`'s
`Harness`. **Not registered in CI.** Fully self-contained under this directory
with its own `package.json`, `node_modules`, and pinned versions.

## Pins

- `@earendil-works/pi-durable` **1.0.4** (`experimental` label; patch releases
  carry breaking changes)
- `@earendil-works/pi-ai` **1.0.4**
- `@earendil-works/chord` **1.0.4**
- `typebox` **1.3.27**

The repo-level production dependencies and lockfile are **not** touched. Two
copies of `pi-ai` therefore coexist in the tree (repo 1.0.2, spike 1.0.4) —
documented as a blocker in gate 5.

## Layout

```
spike/pi-durable-crash-test/
  README.md              — this file
  package.json           — own lockfile; pi-durable 1.0.4 pins
  src/
    durable-tool-adapter.ts  toDurableTool() — mirrors tools/pi-adapter.ts
    replay-labels.ts         replay:safe/unsafe table + startup assertion
    policy-extension.ts      mutation-policy + output-limits as hooks
    coding-arm.ts            minimal 5-tool arm (read_file, list_files,
                             search_text, apply_patch, write_artifact)
    fixture-task.ts          mkdtemp scratch repo seeded with the task packet
    crash-points.ts          HOK3150_CRASH_POINT=<A|B|C1|C2|C3|none> signalling
    fork-docs.ts             (HOK-3151) app state docs with fork rules
    fork-pair.ts             (HOK-3151) forkChallengePair + materializeArmWorktree
    usage-probe.ts           (HOK-3151) extension to capture usage metrics
    faux-script.ts           (HOK-3151) durable faux factory (factored)
  scripts/
    smoke.ts                 pi-durable 1.0.4 opens SQLite, round-trips a run
    run-arm.ts               child: open storage, submit or resume
    crash-harness.ts         parent: spawn child, SIGKILL, restart, audit
    audit-transcript.ts      checks exactlyOneResultPerCall / interrupted
    baseline-relaunch.ts     resume vs today's fresh relaunch (gate 4)
    provider-matrix.ts       pi-ai support probe for certified models (gate 5)
    policy-parity.ts         gate 6: production policy vs hook decisions
    test-forking.ts          (HOK-3151) gates 1, 3, state rules (faux + real)
    fork-child.ts            (HOK-3151) child process for crash harness
    fork-crash-harness.ts    (HOK-3151) gate 2: atomic pairing
    challenger-baseline-history.ts  (HOK-3151) production baseline aggregator
    test-counterfactual-fork.ts     (HOK-3151) info 5: fork vs checkpoint
  results/                   — JSON evidence per trial + summaries
```

## How to run

### HOK-3150 (existing)

```sh
cd spike/pi-durable-crash-test
npm install

# faux-model smoke test (free)
npx tsx scripts/smoke.ts

# policy parity (gate 6)
npx tsx scripts/policy-parity.ts

# crash tests (gate 1/2/3) — faux model, free
npx tsx scripts/crash-harness.ts --point A,B,C1,C2,C3 --trials 3

# resume vs fresh-relaunch baseline (gate 4) — faux
npx tsx scripts/baseline-relaunch.ts

# provider coverage dry-run (gate 5)
npx tsx scripts/provider-matrix.ts
```

### HOK-3151 (fork-based challenge pairs)

```sh
cd spike/pi-durable-crash-test
npm install

# gates 1, 3, state rules — faux mode (free)
npx tsx scripts/test-forking.ts

# gate 2: atomic pairing crash tests (faux, free)
npx tsx scripts/fork-crash-harness.ts --point=F1,F2,F3 --trials=5

# gate 4: real-provider cost mode (requires OPENROUTER_API_KEY, capped $2)
npx tsx scripts/test-forking.ts --real --max-usd=2

# production challenger baseline (read-only)
npx tsx scripts/challenger-baseline-history.ts /Users/timothyogilvie/Dropbox/wavemill

# info 5: counterfactual fork vs checkpoint (faux, free)
npx tsx scripts/test-counterfactual-fork.ts
```

The write-up lives in [docs/pi-durable-evaluation.md](../../docs/pi-durable-evaluation.md):
§6 for HOK-3150, §7 for HOK-3151. One place to run and one place to read.

## Faux limitations (recorded as findings)

- Point A (mid-model-request): pi-ai's `fauxProvider` streams instantly, so a
  partial-content observer on `pi.live` never fires in time. Our harness
  SIGKILLs on the ready-file timeout, which lands after the run has already
  settled. The A rows document this; a real-provider repeat is a follow-up.
- Faux state does not persist across process restarts. The spike's faux is
  wrapped in a durable factory that keys off `message.role === 'toolResult'`
  in `TranscriptContext.messages`, so each generation on resume picks the
  same scripted step a real model would see; this is what makes resume
  deterministic without real tokens.

## Constraints respected

- No edits to `shared/lib/native-agent/launch-coding.ts`, `loop.ts`, or any
  production file.
- Repo `package.json` / `package-lock.json` untouched.
- `spike/` is excluded from `tests/check-shell.sh:3589` seam guard.
- All runs use `mkdtemp` scratch dirs (HOK-3157 rule).
- No live-coding canaries, no fleet re-certify, no provider credit spend.
