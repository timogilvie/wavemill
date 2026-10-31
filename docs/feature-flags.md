# Feature flags

Every `WAVEMILL_*` env token in the wavemill codebase must appear in one of
the tables below, or in the seeded plumbing baseline
[`tools/feature-flags-baseline.txt`](../tools/feature-flags-baseline.txt).
The preflight guard `tools/check-feature-flags.ts` enforces this and the
policy below; it runs in `npm run test:preflight` and in CI.

## Policy (HOK-3235)

- A PR that adds a shadow mode, kill switch, or legacy path must file its
  **removal issue in the same PR**, with a date at most **30 days** out from
  when it was added.
- **At most 5 open shadow modes** at any time (`MAX_OPEN_SHADOWS`). A new
  shadow requires retiring one.
- Every row carries: owner issue, added date, removal criterion, removal
  issue, and remove-by date.
- Rows whose remove-by is in the past get a `[feature-flags] overdue:` warning
  from the guard but do not fail CI; structural problems do fail
  (undocumented token, kill-switch pattern in the baseline, stale baseline or
  doc entry, missing field, bad issue ID, remove-by > added+30 days, more
  than 5 open shadows).
- Suppress a non-flag mention in code with `// allow-feature-flag: <reason>`
  (or `#` in shell), on the same line or the line above.

**Shadow mode** = a code path that computes a side-channel decision while
behavior is still determined by the pre-shadow path, enabled by a config key
or `WAVEMILL_*_SHADOW` flag.

**Kill switch / rollback / skip** = a `WAVEMILL_*` env flag that disables a
feature, forces a legacy path, or skips a step, intended to be short-lived.

**Permanent operator setting** = tuning knob or UI opt-out that is not
expected to be removed (`WAVEMILL_NO_CAFFEINATE`, `WAVEMILL_NO_PROGRESS`).

The policy start date is `2026-10-20`; grandfathered rows get 30 days from
that date to be retired.

## Open shadow modes

| Shadow | Switch(es) | Owner issue | Added | Removal criterion | Removal issue | Remove by |
|---|---|---|---|---|---|---|
| `WAVEMILL_LEDGER_SHADOW_DISABLED`, `WAVEMILL_SIDE_EFFECT_DETECTOR_DISABLED`, `WAVEMILL_LEDGER_SHADOW_DEBUG` | These three switches control the same ledger shadow | HOK-3183 | 2026-10-20 | Ledger side-effect / step / pair rows settle for 7 days with no duplicates recorded. Flip the gate per design §4b and delete the shadow writers. | HOK-3274 | 2026-11-19 |
| `WAVEMILL_HARNESS_RETENTION_SHADOW` | `WAVEMILL_HARNESS_RETENTION_SHADOW` | HOK-3235 | 2026-10-20 | Retention mode decided; shadow comparator deleted along with its sidecar artifact. | HOK-3276 | 2026-11-19 |
| `WAVEMILL_LEDGER_RENDER_WORKFLOW_STATE` | `WAVEMILL_LEDGER_RENDER_WORKFLOW_STATE` | HOK-3187 | 2026-10-20 | Confirm renderer parity and retire the opt-in when ledger authority is live. | HOK-3275 | 2026-11-19 |

## Kill switches, rollbacks, skips and legacy paths

| Flag | Default | Purpose | Owner issue | Added | Removal criterion | Removal issue | Remove by |
|---|---|---|---|---|---|---|---|
| `WAVEMILL_DISABLE_SCHEMA_STAMP` | 0 | Debug: skip the ledger schema stamp. | HOK-3183 | 2026-10-20 | Delete alongside the ledger shadow writers. | HOK-3274 | 2026-11-19 |
| `WAVEMILL_OBSERVER_LINEAR_ENABLED` | 0 | Legacy env override for `observer.linear.enabled`. HOK-2846 landed the Linear writer and HOK-3243 moved filing to shadow mode: operators now set `observer.linear.mode: shadow` in `.wavemill-config.local.json` instead. | HOK-3243 | 2026-10-20 | Shadow trial clean for a release cycle and no operator uses the env override. | HOK-3278 | 2026-11-19 |

## Permanent operator settings

| Flag | Default | Purpose | Why permanent |
|---|---|---|---|
| `cleanup.branchDeletion.enabled` | true | Disable branch deletion while preserving branches. | Operator off switch. |
| `WAVEMILL_NO_CAFFEINATE` | 0 | Opt out of macOS `caffeinate` wrapping of the mill. | Operator preference; not expected to be removed. |
| `WAVEMILL_NO_PROGRESS` | 0 | Suppress interactive progress bars in long-running commands. | UI opt-out for CI / non-tty environments; not expected to be removed. |
| `DEPS_DRIFT_INTERVAL_SECONDS` | 600 | How often the monitor runs the deps-drift tick, in seconds. | Tuning knob; retained alongside `WAVEMILL_DEPS_DRIFT_*`. |
| `WAVEMILL_DEPS_DRIFT_DISABLED` | 0 | Operator kill-switch for the HOK-3254 stale-node_modules detector. `1` disables both the monitor tick and the startup preflight. | Safety switch over a path that schedules `npm ci`. |
| `WAVEMILL_DEPS_DRIFT_AUTOFIX` | 1 | `0` makes the deps-drift tick detect + log + degrade backstage health but not run `npm ci`. | Break-glass over destructive install behavior; detection still runs. |
| `WAVEMILL_CODEX_NO_DAEMON` | 0 | Force Codex to run without its shared app-server daemon. | Recovery escape hatch for stale-cwd daemons (HOK-3137 incident). |
| `WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE` | 0 | Keep the deterministic current-suite remediation guard active but require manual re-certification. | Operator opt-out for automatic certification remediation. |
| `WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD` | 0 | Targeted operator override for the certification coverage guard. | Emergency-only escape hatch (per `docs/native-certification-contract.md`). |
| `WAVEMILL_CLEANUP_EPISODES_ENABLED` | 1 | Operator override for the episodic cleanup path (`cleanup.episodes.enabled`); `0` disables it. | Operator disable over a mutating cleanup path; mirrors `cleanup.branchDeletion.enabled` (HOK-3068). |
| `WAVEMILL_UNATTENDED_CLEANUP_ENABLED` | 1 | Operator override for the unattended terminal-cleanup tick (`cleanup.terminalInbox.unattended.enabled`); `0` disables it. | Operator disable over an on-by-default cleanup path (HOK-3201). |
| `WAVEMILL_OBSERVER_AUTOFIX` | 0 | Master kill over `observer.autoFix.*` mutating actions. | Safety switch over observer actions that push branches, edit labels, and forfeit arms. |
| `WAVEMILL_STATE_INVARIANTS_DISABLED` | 0 | Kill switch for the HOK-3229 live-state invariant checker (detection only; disables the monitor tick). | Operator kill over a detector that writes JSONL + fires desktop notifications. |
| `WAVEMILL_SKIP_RELIABILITY_METRIC` | 0 | Suppress the dashboard reliability-metric line. | UI opt-out for CI / non-tty environments; same shape as `WAVEMILL_NO_PROGRESS` (HOK-3177). |
| `WAVEMILL_SKIP_FAST_STRIP` | 0 | Force `npx tsx` instead of `node --experimental-strip-types`. | Loader opt-out for test environments and older Nodes; eight call-sites and a mocked `npx` in tests make removal risky (HOK-3200). |
| `WAVEMILL_REVIEW_SKIP_FETCH` | 0 | Skip the pre-review `git fetch origin <base>`. | Sandbox/offline opt-out for review runs (HOK-3162). |
| `WAVEMILL_DISABLE_CHALLENGE` | 0 | Operator kill-switch for the whole challenge program. | Challenges are paused by default (HOK-3175); the recursive-launch gate in the monitor uses it structurally and removal would be a refactor. |

## Retired in HOK-3235

The following flags and legacy paths were deleted along with HOK-3235. They
are listed here for historical traceability. The guard rejects any new use.

- `WAVEMILL_SYNC_READY_CHECKS` / `WAVEMILL_SYNC_ROUTING` — pre-HOK-3206
  inline rollbacks for Ready-path and routing checks. Tests that still pin
  the inline contract source `tests/lib/inline-ready-checks.sh`.
- `WAVEMILL_DISABLE_GH_BATCH_CACHE` — rollback for the HOK-3206 per-pass PR
  cache. Replaced by `wavemill_pr_live_read` (shell) and the internal
  `_PR_CACHE_BYPASS` variable.
- `WAVEMILL_LEDGER_RECOVERY_LIVE` / `WAVEMILL_LEDGER_RECOVERY_DISABLED` — the
  Ledger F shadow recovery tick (`tools/ledger-recovery-tick.ts`) and the
  `reconcile_ledger_waiting_on` reconciler branch. The policy function
  `decideRecovery()` remains and drives the HOK-3177 replay harness. Rebuilding the live recovery loop is tracked in HOK-3277.
- `cleanup.branchDeletion.mode=shadow` — branch cleanup now enforces verified deletion when enabled.
- `--mode=legacy` on `incident-replay-harness` — the original state-transform
  simulator kept for one cycle while per-stage recovery branches were
  retired. The harness now always runs through `runWithRecoveryLoop`.
- `router.rubricAware.mode = "shadow"` — the dormant shadow tier of the
  rubric-aware router. Only `off` and `on` remain.

## Retired in HOK-3077

The SDK cost engine (`shared/lib/sdk-task-cost/`) became the only workflow
cost engine and the legacy `workflow-cost.ts` engine was deleted. Its
switches went with it; `tools/check-cost-ownership.ts` rejects any new use.
Rollback is a revert of the retirement change, not a runtime flag.

- `WAVEMILL_SDK_COST_METERING_SHADOW` — the HOK-3075 shadow switch. With no
  legacy engine there is nothing to shadow: SDK summaries are always
  collected and persisted as `taskCostSummary`. The offline comparison it
  stood for lives on as the cost-parity regression corpus
  (`npx tsx tools/cost-parity.ts`).
- `WAVEMILL_COST_METERING_LEGACY` — the HOK-3076 rollback to the legacy
  engine.
- `WAVEMILL_DISABLE_OPENROUTER_COST` — debug switch that skipped OpenRouter
  exact-price lookups. Exact pricing now runs only when `OPENROUTER_API_KEY`
  is set (eval orchestrator) and folds each charge into the SDK events.

## Retired in HOK-3278

The following kill-switch rows were resolved by the HOK-3278 expiry sweep
(deleted along with their code branches). They are listed here for historical
traceability. The guard rejects any new use.

- `WAVEMILL_SKIP_DEPS_DRIFT_PREFLIGHT` — the one-shot startup deps-drift
  preflight always runs now; `WAVEMILL_DEPS_DRIFT_DISABLED` (Permanent) is
  the operator switch.
- `WAVEMILL_CODEX_NO_DAEMON_PROBE` — the codex `--no-daemon` probe is now
  process-local; `WAVEMILL_CODEX_NO_DAEMON` (Permanent) overrides it.
- `WAVEMILL_SKIP_CANARY_AUTO_REFRESH` — the canary auto-refresh operator
  path is the `canaryAutoRefresh` config key.
- `WAVEMILL_SKIP_PLANNING_REAP` — the planning reap always runs; tests
  override the `reap_completed_planning_pane` shell function seam instead.
- `WAVEMILL_SKIP_STATE_ARCHIVE` — the HOK-3190 state archive is live and
  idempotent; the guard is unconditional.
- `WAVEMILL_BLOCKED_COMPLETION_LIVE_PROCESS_MODE` — blocked-completion
  liveness always degrades to `attention`; the `terminate` branch (and
  `mill_terminate_blocking_processes`) was deleted.
- `WAVEMILL_DISABLE_AJV_VALIDATION` — Ajv schema validation is unconditional.
- `WAVEMILL_EFFECTIVE_CONFIG_LEGACY` — the contract-aware effective-task
  config loader is the only path.
- `WAVEMILL_SKIP_CONFIG_PREFLIGHT` — the mill config preflight is
  unconditional; tests stub the `run_mill_config_preflight` shell seam.
- `WAVEMILL_SKIP_POST_EVAL_CONTEXT_UPDATES` — redundant with the existing
  `postEvalContextUpdates.enabled: false` config knob.

## Not shadow modes

- `subagent_model_economics` (reclassified in HOK-3235): the offline SDK
  cost-metering evaluator policy. Its runtime shadow flag was deleted in
  HOK-3077 (see above).
