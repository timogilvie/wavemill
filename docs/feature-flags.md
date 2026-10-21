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
| `WAVEMILL_SDK_COST_METERING_SHADOW` | `WAVEMILL_SDK_COST_METERING_SHADOW` | HOK-3235 | 2026-10-20 | SDK cost metering parity confirmed vs. OpenRouter price snapshot. Reclassify as offline eval or delete. | HOK-3077 | 2026-11-19 |
| `WAVEMILL_LEDGER_RENDER_WORKFLOW_STATE` | `WAVEMILL_LEDGER_RENDER_WORKFLOW_STATE` | HOK-3187 | 2026-10-20 | Confirm renderer parity and retire the opt-in when ledger authority is live. | HOK-3275 | 2026-11-19 |

## Kill switches, rollbacks, skips and legacy paths

| Flag | Default | Purpose | Owner issue | Added | Removal criterion | Removal issue | Remove by |
|---|---|---|---|---|---|---|---|
| `WAVEMILL_DEPS_DRIFT_DISABLED` | 0 | Operator kill-switch for the HOK-3254 stale-node_modules detector. `1` disables both the monitor tick and the startup preflight. | HOK-3254 | 2026-10-13 | Trust the detector across every mill host and no operator has used the escape hatch for a full release cycle. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_DEPS_DRIFT_AUTOFIX` | 1 | `0` makes the deps-drift tick detect + log + degrade backstage health but not run `npm ci`. Operator-only break-glass. | HOK-3254 | 2026-10-13 | Dependency bumps are gated by a CI pre-publish check that prevents stale installs on the mill host. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_SKIP_DEPS_DRIFT_PREFLIGHT` | 0 | Skip the one-shot `monitor_deps_drift_tick` run during `wavemill mill` startup without disabling the periodic tick. Testing / debugging only. | HOK-3254 | 2026-10-13 | Retire with `WAVEMILL_DEPS_DRIFT_DISABLED`. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_STATE_INVARIANTS_DISABLED` | 0 | Kill switch for the HOK-3229 live-state invariant checker (detection only; disables the monitor tick). | HOK-3229 | 2026-10-20 | Detector has run for a release cycle without false-positive bursts. Fold into standard monitoring. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_BLOCKED_COMPLETION_LIVE_PROCESS_MODE` | — | Debug toggle for the HOK-2882 blocked-completion liveness primitive. | HOK-2882 | 2026-10-20 | Retire once the primitive is uncontroversial for a full release cycle. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_CODEX_NO_DAEMON` | 0 | Force Codex to run without its shared app-server daemon (workaround for stale-cwd daemons). | HOK-3137 | 2026-10-20 | Codex daemon handles reaped-cwd cleanly across versions. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_CODEX_NO_DAEMON_PROBE` | 0 | Probe variant of `WAVEMILL_CODEX_NO_DAEMON`; one-shot bypass. | HOK-3137 | 2026-10-20 | Retire with `WAVEMILL_CODEX_NO_DAEMON`. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_COST_METERING_LEGACY` | 0 | Keeps the pre-HOK-3256 cost metering path for a rollback window. | HOK-3256 | 2026-10-20 | HOK-3256 shipped across environments and the legacy path is unused for a full release cycle. | HOK-3077 | 2026-11-19 |
| `WAVEMILL_EFFECTIVE_CONFIG_LEGACY` | 0 | Rollback path to the pre-effective-config loader. | HOK-3235 | 2026-10-20 | Effective-config path stable across hosts for a release cycle. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_DISABLE_AJV_VALIDATION` | 0 | Debug: disable Ajv schema validation (never set in production). | HOK-3235 | 2026-10-20 | Delete once no bug has needed this flag in a release cycle. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_DISABLE_CHALLENGE` | 0 | Operator kill-switch for the whole challenge program. | HOK-3235 | 2026-10-20 | Challenge program leaves bake and the kill switch is unused for a release cycle. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_DISABLE_OPENROUTER_COST` | 0 | Debug: skip OpenRouter price lookups when metering. | HOK-3235 | 2026-10-20 | Delete alongside `WAVEMILL_COST_METERING_LEGACY`. | HOK-3077 | 2026-11-19 |
| `WAVEMILL_DISABLE_SCHEMA_STAMP` | 0 | Debug: skip the ledger schema stamp. | HOK-3183 | 2026-10-20 | Delete alongside the ledger shadow writers. | HOK-3274 | 2026-11-19 |
| `WAVEMILL_OBSERVER_AUTOFIX` | 0 | Opt-in observer self-repair actions (HOK-3097). | HOK-3097 | 2026-10-20 | Observer autofix stable or deprecated. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_REVIEW_SKIP_FETCH` | 0 | Debug: skip the pre-review git fetch. | HOK-3235 | 2026-10-20 | Delete once no incident has needed it for a release cycle. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_SKIP_CANARY_AUTO_REFRESH` | 0 | Skip the HOK-3062 canary auto-refresh at mill start. | HOK-3062 | 2026-10-20 | Canary cohort refresh stable; operator override replaced by config. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE` | 0 | Keeps the deterministic current-suite remediation guard active but requires manual re-certification. | HOK-3235 | 2026-10-20 | Auto-remediation stable or operator override replaced by config. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD` | 0 | Targeted operator override for the certification coverage guard. | HOK-3235 | 2026-10-20 | Delete alongside `WAVEMILL_SKIP_CERTIFICATION_AUTO_REMEDIATE`. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_SKIP_CONFIG_PREFLIGHT` | 0 | Skip the startup config preflight (debug / recovery). | HOK-3235 | 2026-10-20 | Preflight stable with no need for an operator override. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_SKIP_FAST_STRIP` | 0 | Skip the HOK-3200 fast strip in `node` loader. | HOK-3235 | 2026-10-20 | Loader stable; fast strip is default on supported Node versions. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_SKIP_PLANNING_REAP` | 0 | Skip the planning-phase reap during tests / debugging. | HOK-3235 | 2026-10-20 | Reap stable; test harness has its own seam. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_SKIP_POST_EVAL_CONTEXT_UPDATES` | 0 | Skip the post-eval context-doc update. | HOK-3235 | 2026-10-20 | Context updates stable across evals. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_SKIP_RELIABILITY_METRIC` | 0 | Skip the reliability metric emission. | HOK-3235 | 2026-10-20 | Reliability metric covered by observer / monitor. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_SKIP_STATE_ARCHIVE` | 0 | Skip the periodic workflow-state archive. | HOK-3235 | 2026-10-20 | Archive strategy decided (ledger-backed or deleted). | HOK-3278 | 2026-11-19 |
| `WAVEMILL_CLEANUP_EPISODES_ENABLED` | 0 | Opt-in gate for the episodic cleanup path. | HOK-3235 | 2026-10-20 | Decide on episodic cleanup or delete the path. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_OBSERVER_LINEAR_ENABLED` | 0 | Legacy env override for `observer.linear.enabled`. HOK-2846 landed the Linear writer and HOK-3243 moved filing to shadow mode: operators now set `observer.linear.mode: shadow` in `.wavemill-config.local.json` instead. | HOK-3243 | 2026-10-20 | Shadow trial clean for a release cycle and no operator uses the env override. | HOK-3278 | 2026-11-19 |
| `WAVEMILL_UNATTENDED_CLEANUP_ENABLED` | 0 | Opt-in gate for the unattended cleanup path. | HOK-3235 | 2026-10-20 | Decide on unattended cleanup or delete the path. | HOK-3278 | 2026-11-19 |

## Permanent operator settings

| Flag | Default | Purpose | Why permanent |
|---|---|---|---|
| `cleanup.branchDeletion.enabled` | true | Disable branch deletion while preserving branches. | Operator off switch. |
| `WAVEMILL_NO_CAFFEINATE` | 0 | Opt out of macOS `caffeinate` wrapping of the mill. | Operator preference; not expected to be removed. |
| `WAVEMILL_NO_PROGRESS` | 0 | Suppress interactive progress bars in long-running commands. | UI opt-out for CI / non-tty environments; not expected to be removed. |
| `DEPS_DRIFT_INTERVAL_SECONDS` | 600 | How often the monitor runs the deps-drift tick, in seconds. | Tuning knob; retained alongside `WAVEMILL_DEPS_DRIFT_*`. |

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

## Not shadow modes

- `subagent_model_economics` (reclassified in HOK-3235): the offline SDK
  cost-metering evaluator policy. Its runtime shadow flag
  `WAVEMILL_SDK_COST_METERING_SHADOW` is still listed above pending a
  reclassify-or-delete call under HOK-3235.
