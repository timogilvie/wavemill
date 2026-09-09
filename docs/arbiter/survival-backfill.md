# Survival-Label Backfill (HOK-2805)

`tools/backfill-survival.ts` emits Arbiter S2 survival labels (frozen v1.0.0
contract, `shared/schemas/arbiter-survival-label.schema.json`) for merged PRs
on an integration branch: one JSONL row per PR per 14/30/60-day horizon on
stdout, diagnostics and per-repo/per-horizon base rates on stderr.

The engine (`shared/lib/survival-labeller.ts`) is repo-agnostic: it needs only
`(owner, repo, integrationBranch)` plus a local checkout, and reads no
wavemill state. The wavemill `evals.jsonl` join is a caller-side layer on top
of the `prUrl` key. Arbiter S4 lifts this core into `@hokusai/scan`.

## Usage

```bash
# Wavemill's own history (first/backfill run)
npx tsx tools/backfill-survival.ts \
  --integration-branch auto/integration \
  > .wavemill/evals/survival-labels.jsonl

# Any external public repo — no wavemill state required
git clone https://github.com/some/repo /tmp/some-repo
npx tsx tools/backfill-survival.ts \
  --owner some --repo repo --integration-branch develop \
  --repo-dir /tmp/some-repo --no-links > /tmp/some-repo-labels.jsonl

# Focused replay of one PR
npx tsx tools/backfill-survival.ts \
  --integration-branch auto/integration \
  --pr-url https://github.com/timogilvie/wavemill/pull/1348
```

`--no-links` skips the per-PR `gh` cross-reference lookup (offline or bulk
runs). `main` is rejected as an integration branch: in squash-promotion repos
it attributes every change to the promoter.

## Scheduling

Scheduling is an outer layer — the CLI itself is stateless and idempotent:
re-emitting a `(prUrl, horizon_days)` row is safe because queries take the
latest `computed_at` per key (contract rule). Appending re-runs to the same
JSONL file therefore never corrupts the corpus; unelapsed-horizon rows are
emitted as explicit `missing_horizon` labels and are superseded once the
horizon elapses.

Example cron entry (daily, 03:15):

```cron
15 3 * * * cd /path/to/wavemill && npx tsx tools/backfill-survival.ts --integration-branch auto/integration >> .wavemill/evals/survival-labels.jsonl 2>> /tmp/backfill-survival.log
```

Equivalent launchd (`~/Library/LaunchAgents/com.wavemill.backfill-survival.plist`):
set `ProgramArguments` to the same command via `bash -lc`, with a daily
`StartCalendarInterval`.

## Base rates

The stderr summary reports rows/missing/outcome counts and `survival_rate`
per horizon. A uniformly extreme rate (for example ~98% survived at every
horizon on every repo) is a finding to escalate to the Arbiter decision log,
not a bug to hide.

### Initial measurement (2026-09-08, labeller v1.0.0)

| Repo | Horizon | Labelled rows | survived | followup | subst. rewritten | reverted | survival_rate |
|------|---------|---------------|----------|----------|------------------|----------|---------------|
| timogilvie/wavemill (400 newest PRs) | 14d | 326 | 97 | 224 | 5 | 0 | 0.298 |
| timogilvie/wavemill | 30d | 211 | 42 | 165 | 4 | 0 | 0.199 |
| timogilvie/wavemill | 60d | 138 | 13 | 120 | 5 | 0 | 0.094 |
| expressjs/express (141 newest PRs, `master`) | 14d | 136 | 125 | 10 | 1 | 0 | 0.919 |
| expressjs/express | 30d | 131 | 109 | 11 | 11 | 0 | 0.832 |
| expressjs/express | 60d | 129 | 83 | 18 | 28 | 0 | 0.643 |

Rates are far from uniform — wavemill's high-churn integration branch amends
most PR line ranges within two weeks (`line_range_followup` dominates), while
express changes mostly survive. `reverted` (exact file-level restoration) is
rare in both. Missing rows are unelapsed horizons for recent PRs plus one
whitespace-only PR (`insufficient_line_range_substrate`).
