# Implementation Plan — HOK-3406: One task-repair entry point (migrate Observer auto-fixes to recovery requests)

**Slug:** `one-ta[REDACTED:openai_key]`
**Repo:** `wavemill` · **Plan depth:** light · **Verified against:** `tools/observer.ts`, `shared/lib/observer-auto-fix.ts`, `shared/lib/task-recovery-controller.ts`, `shared/lib/failure-policy.ts`, `shared/lib/bounded-retry.{ts,sh}`, `shared/lib/wavemill-monitor.sh`, `shared/lib/{arm-termination.ts, challenge-pair-resolver.ts, promotion-controller.ts, config.ts}`, `shared/lib/ta[REDACTED:openai_key].ts`, `tools/lib/source-guard.ts`, `wavemill-config.schema.json`, `package.json`, `tests/journeys/*`, guard allowlists, invariant docs.

---

## 1. Summary

Delete Observer's private repair engine (`shared/lib/observer-auto-fix.ts`) and its wiring in `tools/observer.ts`. The three repair classes already have canonical owners on the Monitor/controller path:

| Repair class | Canonical owner (verified) | What Observer keeps after migration |
|---|---|---|
| Branch update from base | `updateBranchWithBase` (`promotion-controller.ts`) dispatched via controller `remediate`/`nextAction: 'update-base'` → monitor `_ready_failure_update_base` (`wavemill-monitor.sh:12071`), guarded by `BASE_MERGE_GUARD` | the `branch-behind-base-*` finding (evidence only) |
| Retry-budget reset | `bounded-retry.sh` already resets on a new head/base key and the HOK-3172 condition companion (`--expires-on head,operator-event`) expires exhaustion — no external resetter is needed | the `ready-recheck-loop-*` / exhausted-retry findings |
| Stuck challenge-arm forfeit | `resolveUnresolvablePair` → `stampStalledArm` → `recordArmTermination` (`challenge-pair-resolver.ts`, `arm-termination.ts`), invoked by monitor `maybe_resolve_unresolvable_challenge_pair` (`wavemill-monitor.sh:16160`) and `ready_exhausted_challenge_terminalize` | the stuck-arm finding with execution-truthful evidence (sentinels, review-infra failure, last-head/progress age) |

Observer becomes evidence-only: findings + incident records it already produces are the notifications the controller consumes via its existing claim/audit seam (`.recovery-claim.json` / `.recovery-actions.jsonl`). **Preferred outcome: zero decision changes in `task-recovery-controller.ts`** — `baseDrift→remediate`, human-hold ranking, settled-attempt blocking (`isSettled`), and one-claim dedup (`already-claimed`) are all present and tested today.

---

## 2. Files to modify

### Deleted (net production-code deletion)
| File | Notes |
|---|---|
| `shared/lib/observer-auto-fix.ts` | ~1,200 lines: the three fixes, `checkAutoFixPreconditions`, private journal (`auto-fix-state.json`), `actions.jsonl` writer, private buckets `observer-update-branch` / `observer-ready-budget-reset` / `observer-forfeit-arm`, ff-only fast-forward mode |
| `shared/lib/observer-auto-fix.test.ts` | entire file |

### Modified
| File | Change |
|---|---|
| `tools/observer.ts` | Remove `applyAutoFixes` (~110 lines) and its call in `main()`; remove imports of `runObserverAutoFixes`, `appendAutoFixActionRecords`, auto-fix types, `updateBranchWithBase` (keep `measureBranchBaseDistance` — detection uses it), `abortTaskInState`; remove `--autofix-dry-run` flag, `autoFixDryRun` option, and the `getObserverAutoFixConfig` usage in `writeServiceHeartbeat` (collapse `detectionMode` to `'off' | 'detection-only'`, never emitting `'remediation'`); update `usage()` help, `observerPrompt()` text, and the `detectBranchBehindBase` recommendation (drop the "observer.autoFix.updateBranchFromBase (HOK-3097) can apply this fix automatically" sentence; point at the monitor/controller path) |
| `tools/observer.test.ts` | Delete `applyAutoFixes` imports/tests (incl. HOK-3243 dry-run tests, the no-op-when-disabled test); add a test that `--autofix-dry-run` is now rejected by `parseArgs`; keep all detection tests |
| `shared/lib/config.ts` | Delete `ObserverAutoFixConfig`, `OBSERVER_AUTO_FIX_DEFAULTS` (line 1274), `getObserverAutoFixConfig` (line 2687), `ObserverConfig.autoFix?` field |
| `wavemill-config.schema.json` | Delete the `autoFix` block (line 639); fix the `observer.enabled` description (line 392) that mentions autoFix |
| `shared/validators/wavemill-config.validator.cjs` | Regenerate via `tools/generate-schema-validators.ts` (`check-schema-validators` preflight enforces sync) |
| `shared/lib/ta[REDACTED:openai_key].ts` | Extend `TASK_RECOVERY_OWNERSHIP_GUARD` patterns (see §4 Step 5) — extend the existing guard, no new scanner |
| `shared/lib/ta[REDACTED:openai_key].test.ts` (or the spec's existing test file; follow `failure-policy-guard.test.ts` pattern) | Positive/negative fixtures for the new patterns |
| Guard allowlist file named by the spec's `allowlistFile` (`tools/ta[REDACTED:openai_key].txt`) | Keep empty — no exceptions |
| `tools/ready-failure-policy-allowlist.txt` (line 7), `tools/retry-sentinel-allowlist.txt` (line 16), `tools/settled-attempt-allowlist.txt` (line 12) | Remove rows referencing `shared/lib/observer-auto-fix.ts` (ratcheting guards flag stale entries if left) |
| `docs/invariants/task-recovery-ownership.md` | Update "Live hosting" line: HOK-3406 migration complete — Observer is evidence-only, no executors, no private buckets |
| `docs/feature-flags.md` (line 75) | Delete the `WAVEMILL_OBSERVER_AUTOFIX` row (feature-flags guard ratchet: name leaving code requires same-change removal) |
| `docs/mq-1-1-telemetry-writers-inventory.md` | Delete rows 5.21 and 6.20 (observer auto-fix bucket writer + action-record writer) |
| `tests/ci-test-weights.json` | Remove the `shared/lib/observer-auto-fix.test.ts` entry (`check-shard-balance` manifest hygiene) |
| `tests/observer-managed-filing.test.sh` | Update the HOK-3243 comment; the `assert_not_contains "--autofix-dry-run"` assertions still pass and stay |
| `tests/journeys/observer-independent-recovery.journey.sh` (**new**) | Golden journey per §4 Step 6 |

### Expected unchanged
`shared/lib/task-recovery-controller.ts`, `shared/lib/failure-policy.ts`, `shared/lib/bounded-retry.{ts,sh}`, `shared/lib/arm-termination.ts`, `shared/lib/challenge-pair-resolver.ts`, `shared/lib/wavemill-monitor.sh`, `shared/lib/promotion-controller.ts` — the controller, policy, buckets, recorder, resolver and monitor seams already implement everything needed. Only change them if a gap surfaces in Step 2 verification (then justify against the scope-out constraints: no new terminal causes, classifier strings, retry buckets, or shadow switches).

---

## 3. Architectural decisions & rationale

1. **Controller consumes existing Observer outputs; no new request artifact.** Observer already emits typed findings (`branch-behind-base-*`, `ready-recheck-loop-*`, incident records) and incident records the monitor's recovery jobs correlate. Introducing a new "repair request" file would create a second seam the ownership invariant forbids in spirit (one control path). The controller's `evidenceId` + claim collapse is the dedup mechanism (REQ-F4) — verified: `claimRecoveryAction` returns `already-claimed` for identical `(action, stage, runId, evidenceId)` and unacknowledged same-run claims.
2. **Delete, don't port, the private retry bookkeeping.** `bounded-retry.sh` resets on new head SHA by construction, and exhaustion is latched with a condition companion expiring on `head,operator-event` — the observer's `reset-ready-budget` fix duplicated this. The stuck-arm forfeit bypassed `recordArmTermination` (used `abortTaskInState` + `gh pr close` directly), which is exactly the fragmentation the arm-termination invariant (HOK-3358) and REQ-F5 forbid; migrating means routing to the existing resolver path, not copying logic.
3. **ff-only fast-forward mode is deleted, not migrated.** The `origin/<branch> ahead of local HEAD` catch-up has no controller action today. Adding one would be new executor surface (scope-out risk); detection (the finding) remains, and tend's lane base-integration covers merge-lane movement. Flagged as decision point D2 below.
4. **Guard extension, not a parallel scanner.** New patterns live in the existing `TASK_RECOVERY_OWNERSHIP_GUARD` (which the invariant doc already points at HOK-3406 for), reusing `scopedPaths` for observer-scoped rules and repo-wide patterns for the dead bucket names.
5. **Schema removal is a hard break by design** (validation step REQ-F1/F2 expects `additionalProperties: false` to reject `observer.autoFix`), with rollback = revert commit (packet §9). Leftover runtime artifacts (`.retry-observer-*` sentinels, `.wavemill/observer/auto-fix-state.json`, old `actions.jsonl`) are untracked state; they are simply orphaned — no migration.

---

## 4. Step-by-step implementation approach

**Step 1 — Strip Observer execution authority (`tools/observer.ts`).**
Remove `applyAutoFixes` + its `main()` call; remove the auto-fix imports, `--autofix-dry-run`, heartbeat auto-fix read (`detectionMode` collapses to `!options.incidentDetector ? 'off' : 'detection-only'`); update the three text sites (usage, prompt, behind-base recommendation). Verify `detectBranchBehindBase` still compiles using `measureBranchBaseDistance` only.

**Step 2 — Verify the controller covers each migrated condition (read-only proof, no changes unless a gap is found).**
Behind-base → existing `baseDrift` snapshot field → `remediate`/`update-base` (controller line ~290; monitor `_maybe_retry_failed_stage_now` dispatches `_ready_failure_update_base`). Human hold → rule 3 (`wait.owner === 'human'`), settled → `isSettled` in `claimRecoveryAction` (REQ-F6). Dedup → `already-claimed`/`settled-attempt`/`stale-run` (REQ-F4). Stuck arm → `maybe_resolve_unresolvable_challenge_pair` + `ready_exhausted_challenge_terminalize` through `recordArmTermination` (REQ-F5).

**Step 3 — Delete the module and config.**
`git rm shared/lib/observer-auto-fix.ts` + its test; delete the config interface/defaults/getter and schema block; regenerate the validator; remove feature-flag row, telemetry-inventory rows, and the three guard-allowlist rows; prune `tests/ci-test-weights.json`.

**Step 4 — Update Observer tests** (`tools/observer.test.ts`, `tests/observer-managed-filing.test.sh`).

**Step 5 — Extend the source guard** (`ta[REDACTED:openai_key].ts`), adding:
- `observer-auto-fix-import` (ts, repo-wide): `\bobserver-auto-fix\b` — the deleted module cannot be re-imported.
- `observer-repair-bucket` (both, repo-wide): `\bobserver-(update-branch|ready-budget-reset|forfeit-arm)\b` — dead bucket names cannot return (satisfies the "grep returns no matches" validation).
- `observer-executor-call` (ts, `scopedPaths: ['tools/observer.ts']`): `\b(updateBranchWithBase|abortTaskInState|recordArmTermination|createStateDirRetry)\s*\(` — observer cannot call repair executors directly.
- `observer-autofix-surface` (ts, scoped to `tools/observer.ts`): `autoFixDryRun|getObserverAutoFixConfig` — the config/flag surface cannot return.
Add fixtures in the guard's test file; keep the allowlist empty; the invariant doc edit (§2) lands in the same commit since the guard enforces doc existence.

**Step 6 — Golden journey** `tests/journeys/observer-independent-recovery.journey.sh` (harness: `journey_init`, `journey_start_monitor`, `journey_write_config`, `journey_set_tick_budget`, `journey_assert`, tick-clock `WAVEMILL_TICK_CLOCK_FILE` for determinism; follow `ready-fail-remediate` + `observer-attention-push` patterns; do **not** start an Observer loop and write config with `observer.enabled: false`):
- (A) REQ-F6 golden: seed a behind-base ready task (fake CI/base movement as in `ready-fail-remediate`); assert the branch is updated by the mill, the task advances/merges with zero operator touches (no `.needs-attention`, no `needs-user` window).
- (B) REQ-F4 dedup: across ≥5 monitor ticks assert exactly one claimed execution — one `remediate` entry with applied outcome in the feature dir's `.recovery-actions.jsonl` and one `updateBranchWithBase` log line ("PR #… updated from origin/…"); a failed first attempt shows shared backoff, not a duplicate.
- (C) REQ-F5: seed a stalled challenge arm with an evalCompleted sibling; assert retirement carries `terminal_stage_failure:*` via the shared recorder (`.challenge-aborted.json` present); assert an arm with no execution-truthful evidence is *not* retired (age-only forbidden); both-arms-stuck → no forfeit.
- (D) REQ-F6 hold/settled: with an explicit human hold and a settled attempt, assert no claim/execution appears.
- Edge: base unfetchable → transient infra classification parks safely without crash.

**Step 7 — Add controller regression tests** (`task-recovery-controller.test.ts`): deterministic replay of the three repair classes with exactly one claimed execution; repeat-evidence collapse; hold/settled blocking; `baseDrift → remediate(update-base)`.

**Step 8 — Validation** (repo uses **npm**, not pnpm):
- `npm run lint` · `npm run typecheck` · `npm run test:preflight` (runs `check-task-recovery-ownership`, `check-base-merge`, `check-arm-termination-recorder`, `check-feature-flags`, `check-schema-validators`, `check-shard-balance`) · `bash tests/run-related.sh`
- Config rejection (REQ-F1/F2): there is **no `validate-config` script** — use `npm run test:config` (`tests/config-loading.test.sh`); add/extend a case there asserting `observer.autoFix` fails schema validation.
- Grep gates: `observer-update-branch`, `observer-ready-budget-reset`, `observer-forfeit-arm`, `observer-auto-fix`, `WAVEMILL_OBSERVER_AUTOFIX` → zero production matches.
- Net-deletion check: `git diff --stat` shows production deletions ≫ additions (est. ≈ −1,300 production lines vs +~350 incl. journey/tests).

---

## 5. Dependencies, risks, edge cases

- **Dependencies:** HOK-3277 controller + monitor async `task-recovery` hosting (present); HOK-3101 task-progress evidence (Observer findings already carry it); HOK-3092 `updateBranchWithBase`; HOK-3358 `recordArmTermination`; HOK-3172 exhaustion condition companions.
- **Risks:** (1) A ready/review task whose only recovery was the observer's ff-only catch-up loses that repair (decision D2). (2) Repos with `observer.autoFix` in config now fail schema validation at every entrypoint (`config-integrity` surfaces it loudly) — intended, but announce in PR description. (3) Regressions could stall tasks if the monitor path misses a case the observer used to fix — mitigated by journeys (A)/(B) and the existing `ready-fail-remediate` journey.
- **Edge cases covered:** both challenge arms stuck (no forfeit, finding only); dirty worktree/agent working (controller's disposition rules + preconditioned executors); unfetchable base (transient infra policy); in-flight upgrades with orphaned `.retry-observer-*` state files (harmless, untracked); stale `actions.jsonl` history remains readable.
- **Operator intent (REQ-F6):** verified ranked before failures in `decideTaskRecovery`; settled attempts rejected at claim time under the workflow lock; journey (D) pins it.

---

## Release Readiness

- **database_change_risk:** none
- **env_changes:** none (kill-switch `WAVEMILL_OBSERVER_AUTOFIX` is removed along with the feature; no env var remains)
- **config_changes:** `wavemill-config.schema.json` — `observer.autoFix` becomes invalid (unknown property); repos carrying it must delete the block (validator regenerated in-repo; no runtime env var change)
- **manual_steps:** none (in-flight orphaned retry-sentinel files need no migration)
- **Rollback:** revert the consolidation commit; restore `observer-auto-fix.ts` + schema block; tasks caught mid-transition surface as `needs-user` via normal failure policy — no data rollback.

---

## Unresolved questions (decision points for approval)

1. **D1 — `detectionMode` enum in the Backstage heartbeat:** keep the `'remediation'` member but never emit it (safe for unknown consumers, recommended) or narrow the union to `'off' | 'detection-only'`?
2. **D2 — ff-only origin-ahead fast-forward:** delete with the module (recommended; detection finding remains, no new executor) or extend the monitor's `update-base` seam to also handle origin-ahead worktrees (adds executor surface; contradicts "reuse, don't rewrite" spirit)?
3. **D3 — `--autofix-dry-run` flag:** remove entirely (recommended, it has no remaining meaning) or keep as a tolerated no-op for scripting compatibility?
4. **D4 — Journey observer default:** confirm during implementation whether the journey harness's default config launches the backstage observer pane (`observer.enabled` default per schema) — the new journey must explicitly set `observer.enabled: false` if so; to be verified against `tests/journeys/harness.sh` defaults at implementation time.
5. The task packet's `pnpm run validate-config` / `pnpm lint` commands do not exist in this repo (npm + `tests/config-loading.test.sh`); the substituted commands in §4 Step 8 should be confirmed acceptable.