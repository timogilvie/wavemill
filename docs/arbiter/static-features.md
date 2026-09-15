# Static feature collection (HOK-2806)

Reference for the S1 **Static** feature group of the frozen
`candidate_features/v1` contract. The four fields land on every eval record
in `outcomes.staticAnalysis` and drive the cheapest-signal floor of the
Arbiter label ladder (Tier 1: build, tests, types, lint).

Field semantics come from §4 of the **Arbiter Program Brief and Decision Log**
(the auto-expanded task packet drifted; ignore its `complexity_delta ≈ LOC`
and `pnpm` claims — this doc is authoritative).

---

## The four fields

| Field | Type | Value | Null means |
|---|---|---|---|
| `type_errors` | `integer ≥ 0` or `null` | Number of type-check errors reported for the candidate. | No supported type checker completed successfully (missing binary, missing config, timeout, spawn failure, unparseable output). |
| `lint_errors` | `integer ≥ 0` or `null` | Number of lint errors reported for the candidate. | No supported linter completed successfully. |
| `build_ok` | `boolean` or `null` | Whether the configured build completed successfully. | No build ran to a terminal result; `CiOutcome.ran=false` also maps to `null`. |
| `complexity_delta` | `number` or `null` | Candidate-minus-base change in the configured code-complexity metric. `0` is a real observation for docs-only diffs. | No supported complexity analyzer completed on both revisions. |

Provenance is stored alongside the values:

| Field | Type | Purpose |
|---|---|---|
| `build_evidence` | `'local-build' \| 'ci-build-check' \| 'ci-pipeline' \| null` | Which rung of the build ladder produced `build_ok`. |
| `complexity_metric` | `string` or `null` | Metric id used to compute `complexity_delta` (currently `wavemill-cyclomatic/v1`). |

**Null discipline.** `null` is the *only* sentinel for "the documented
evidence was unavailable." `0` and `false` are observed values, only emitted
when a tool actually completed. This matters for tree models: `null` and `0`
must be distinguishable.

---

## Collection ladders

The collector lives at `shared/lib/static-features.ts` and is called from
`shared/lib/outcome-collectors.ts`'s `collectStaticAnalysisOutcome` wrapper.
Both call sites (`post-completion-hook`, `eval-orchestrator`) go through the
wrapper.

### `type_errors` (TypeScript v1)

1. **Committed config override.** `.wavemill-config.json` →
   `staticAnalysis.typecheckCommand` — run verbatim in the checkout.
2. **Auto-detect.** `tsconfig.static.json` (measurement-only convention) wins
   over `tsconfig.json`; then `npx --no-install tsc --noEmit -p <file>`.
3. **Count.** Number of lines matching `/error TS\d+/` in stdout+stderr. tsc
   exit 2 with errors still counts as "completed." Spawn failure or
   `--no-install` resolution failure ⇒ `null`.

Other languages currently yield `null`. Generalization is HOK-2807/S4.

### `lint_errors`

1. **Committed config override.** `staticAnalysis.lintCommand`. **Required
   contract:** the command must emit `eslint --format json` output on
   stdout. Warnings are excluded; `errorCount` is summed. Fatal parse errors
   are already counted by eslint as errors.
2. **Auto-detect.** `eslint.config.{js,mjs,cjs,ts}` or any `.eslintrc*` → run
   `npx --no-install eslint . --format json`. eslint exit 1 with valid JSON
   is a completed run.
3. Missing config / missing binary / crash ⇒ `null`.

### `build_ok`

1. **Committed config override.** `staticAnalysis.buildCommand` — exit 0 ⇒
   `true`, non-zero ⇒ `false`, spawn/timeout ⇒ `null`. Provenance:
   `local-build`.
2. **Auto-detect.** `package.json` `scripts.build` ⇒ `npm run build`.
   Provenance: `local-build`.
3. **CI evidence.** With a `prNumber` and `gh` available: read
   `gh pr checks <n> --json name,state,bucket`. A build-named check
   (`/build|compile/i`) that is terminal ⇒ its conclusion; provenance
   `ci-build-check`. Otherwise if *every* check is terminal, the conjunction
   of conclusions; provenance `ci-pipeline`. Any pending check ⇒ `null`.
   `CiOutcome.ran=false` ⇒ `null`, per the frozen S1 note.

### `complexity_delta` (`wavemill-cyclomatic/v1`)

Deterministic per-file approximation of cyclomatic complexity:

1. Strip line comments (`//`, plus `#` for `.py/.rb/.sh/.bash`), block
   comments (`/* … */`), and string/template literals (`" ' \``, plus Python
   triple-quoted).
2. Count word-boundaried matches of the following branch tokens:

   `if`, `else if`, `elif`, `for`, `while`, `case`, `when`, `catch`,
   `except`, `rescue`, ternary `?` (heuristic), `&&`, `||`.

3. File complexity = **1 + count(branch tokens)**.

Supported extensions: `.ts .tsx .js .jsx .mjs .cjs .py .go .rs .java .rb .php
.c .h .cpp .hpp .cs .swift .kt .sh .bash`.

Delta:

* Base ref: PR base branch when `prNumber` + `gh` are available, else the
  `baseRef` option, else `origin/main` / `main` / `origin/HEAD`.
* Changed files: `git diff --name-status --find-renames <merge-base>...HEAD`.
* Base content comes from `git show <merge-base>:<path>` (added files
  contribute 0 at base; deleted files 0 at head; renames use the old path
  for base).
* Head content is read from the working tree.
* Sum head complexities minus sum base complexities across measured files.

`complexity_delta = 0` is legitimate for docs-only diffs (no supported file
changed). Only git-plumbing failures (no merge-base, missing objects) yield
`null`.

Because the metric is deterministic given the file bytes, it's reproducible
from a bare checkout — the S1 parity contract.

---

## Bare-checkout parity

**Contract (issue "Done when"):** "Same values from bare checkout as
wavemill worktree."

The collector reads the *committed* `.wavemill-config.json` directly. It
never merges the gitignored `.wavemill-config.local.json` overlay
(`loadWavemillConfig()` would). See `readCommittedStaticAnalysisConfig`.

The parity test builds a fixture repo, then runs the collector against:

1. the fixture directly; and
2. a `git worktree` of the same commit.

The four fields must be equal. A follow-up test additionally writes a
`.wavemill-config.local.json` alongside `.wavemill-config.json` and verifies
that the local overlay does **not** change any field.

---

## PR-head checkout resolution

The wrapper (`collectStaticAnalysisOutcome`) knows how to make sure tools
run at the actual PR head SHA, not the caller's working tree:

1. Resolve the PR head SHA via `gh pr view <n> --json headRefOid`.
2. If the caller passed a `checkoutDir` whose `HEAD` matches the SHA, run
   the collector in place (mill flow: this is the arm's own worktree).
3. Otherwise create a disposable git worktree at the head SHA under
   `<repoDir>/.static-collect-worktrees/pr-<n>-<pid>` — placed inside
   `repoDir` so Node's `node_modules` resolution walks up to the repo's dev
   deps (required for `npx --no-install`). Fetch
   `refs/pull/<n>/head` if the SHA is unknown locally. Always cleaned up in
   a `finally`; `.static-collect-worktrees/` is gitignored and reaped by
   `git worktree prune` at the next collector run.
4. If the SHA cannot be resolved or fetched, tool-based signals are `null`,
   but CI-evidence `build_ok` may still resolve if `gh` is available in
   `repoDir`.

---

## Backfill

`tools/backfill-static-features.ts` reconstructs Static values for historical
eval records to a sidecar `.wavemill/evals/static-backfill.jsonl` (never
in-place mutation — eval JSONLs are append-only). Row shape:

```json
{
  "recordId": "…",
  "prUrl": "…",
  "headSha": "…40 hex…",
  "collectedAt": "…iso 8601…",
  "backfill": true,
  "outcome": "collected|skipped|failed",
  "reason": "…when not collected",
  "type_errors": 0,
  "lint_errors": 0,
  "build_ok": true,
  "complexity_delta": 0,
  "build_evidence": "ci-pipeline",
  "complexity_metric": "wavemill-cyclomatic/v1"
}
```

HOK-2807's extractor can join by `recordId` / `prUrl`. Idempotent: records
already present in the sidecar are skipped on re-run.

### Feasibility

| Signal | Feasible for historical trees? |
|---|---|
| `complexity_delta` | **Yes.** Pure git; `refs/pull/<n>/head` persists on GitHub for closed / merged PRs. |
| `build_ok` via CI evidence | **Yes.** `gh pr checks` history is queryable. |
| `type_errors` | **No, honestly.** Trees predating the committed `tsconfig.static.json` have no supported type checker configured, so per S1 the honest value is `null`. Injecting today's tsconfig into a historical tree would break bare-checkout parity. |
| `lint_errors` | **No, honestly.** Same reasoning as `type_errors`. |

This is stated deliberately: the exit criterion is ≥90% populated on **new**
records, not on the historical corpus.

---

## Fill-rate measurement

To measure the exit criterion against the wavemill eval log (post-merge and
after promotion to `main`):

```sh
jq -c 'select(.timestamp > "2026-09-14T00:00:00Z") | .outcomes.staticAnalysis // {}' \
   .wavemill/evals/evals.jsonl \
| jq -s '
  reduce .[] as $s ({n:0, t:0, l:0, b:0, c:0};
    .n += 1
  | .t += (if $s.type_errors != null then 1 else 0 end)
  | .l += (if $s.lint_errors != null then 1 else 0 end)
  | .b += (if $s.build_ok != null then 1 else 0 end)
  | .c += (if $s.complexity_delta != null then 1 else 0 end)
  )'
```

For a formal exit sign-off, compute the intersection: `all four non-null` /
`n`.

---

## Timeouts

Defaults in `DEFAULT_TIMEOUTS_MS`:

| Signal | Default (ms) |
|---|---|
| typecheck | 180000 |
| lint | 120000 |
| build | 300000 |
| complexity | 60000 |

Committed `staticAnalysis.timeoutSeconds.<signal>` overrides defaults;
explicit `options.timeouts.<signal>` on `collectStaticFeatures()` overrides
both.

Wavemill's own committed config raises these to
`typecheck: 600, lint: 900, complexity: 120` seconds so eslint/tsc over ~1k
TS files fit comfortably.

---

## Related work

- **HOK-2807**: extends collection to the other four S1 groups
  (Shape / Test / Intent / Provenance) and wires `candidate_features/v1`
  emission.
- **HOK-2816 (S4)**: extracts this module to `@hokusai/scan` so the same
  code path runs inside the scan pipeline.
- **`docs/arbiter/challenge-validity-contract.md`**: adjacent contract also
  frozen 2026-09-14; consumers of both should read them together.
