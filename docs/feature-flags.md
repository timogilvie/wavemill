# Feature flags

The flags listed here are the kill-switches / opt-in dials shipped alongside
HOK-3235 shadow-mode guards and HOK-3254 deps-drift auto-fix. Each row names
its default, a one-line purpose, when it should be removed, and the Linear
issue it belongs to.

Every new flag goes here with a `Removal criterion` filled in. A flag with no
expiry is a bug; raise it against HOK-3235.

| Flag | Default | Purpose | Removal criterion | Linked issue |
|------|---------|---------|-------------------|--------------|
| `WAVEMILL_DEPS_DRIFT_DISABLED` | `0` | Operator kill-switch for the HOK-3254 stale-node_modules detector. `1` disables both the monitor tick and the startup preflight. | Retire once we trust the detector across every mill host and no operator has needed the escape hatch for a full release cycle. | [HOK-3254](https://linear.app/hokusai/issue/HOK-3254) |
| `WAVEMILL_DEPS_DRIFT_AUTOFIX` | `1` | When set to `0` the deps-drift tick detects + logs + degrades backstage health but does not run `npm ci`. Operator-only break-glass. | Retire once dependency bumps are gated by a CI pre-publish check that prevents stale installs on the mill host (see HOK-3235 removal plan). | [HOK-3254](https://linear.app/hokusai/issue/HOK-3254) |
| `WAVEMILL_SKIP_DEPS_DRIFT_PREFLIGHT` | `0` | Skip the one-shot `monitor_deps_drift_tick` run during `wavemill mill` startup without disabling the periodic tick. Testing / debugging only. | Retire with `WAVEMILL_DEPS_DRIFT_DISABLED`. | [HOK-3254](https://linear.app/hokusai/issue/HOK-3254) |
| `DEPS_DRIFT_INTERVAL_SECONDS` | `600` | How often the monitor runs the deps-drift tick, in seconds. Clamped to a positive integer or falls back to the default. | Tune or retire when drift auto-fix is on by default and backed by a CI gate. | [HOK-3254](https://linear.app/hokusai/issue/HOK-3254) |
