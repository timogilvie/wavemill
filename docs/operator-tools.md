# Operator tools

Tools in `tools/` that the mill never calls, but an operator or agent may run by hand, usually while recovering from a problem. Each one prints its options with `--help`.

Run them from the repository root: `npx tsx tools/<name>.ts --help`.

**Before running a tool that writes, read its `--help` and use `--dry-run` when it has one.** Several rewrite eval or challenge records in place.

`tools/check-operator-tools.ts` keeps this list honest (HOK-3462). It fails when:

- a tool that nothing else references is missing from this list;
- a listed tool no longer exists;
- a listed tool doesn't exit cleanly with `--help`.

To add a tool, add a row. A tool that the mill, a script, a prompt or another doc already names doesn't need one. Tools that parse their own arguments must call `exitOnHelp` from `shared/lib/tool-runner.ts` before doing any work.

## Recovery and diagnosis

| Tool | What it does | Writes |
| -- | -- | -- |
| `tools/challenge-recover.ts` | Reopens PRs wrongly closed as `wm:superseded` after an invalid challenge comparison | GitHub: reopens PRs and removes labels (`--dry-run` available) |
| `tools/quarantine-challenge.ts` | Marks challenge records that broke the one-variable rule as ineligible for stage-level learning | Rewrites `.wavemill/evals/challenge-records.jsonl` (`--dry-run` available) |
| `tools/challenge-replay-capture.ts` | Builds a replay instance from a recorded incident and prints it as JSON | No |
| `tools/diagnose-artifacts.ts` | Checks a task's stage artifacts for coverage, freshness and consistency | No |
| `tools/model-launchability-doctor.ts` | Shows which models each stage can launch, and why the others are blocked | No |
| `tools/check-parent-monitor-drift.ts` | Lists shell functions duplicated between `wavemill-mill.sh` and `wavemill-monitor.sh` | No |
| `tools/replay-native-request.ts` | Resends a captured native model request through the same transport and prints the reply shape | Calls a model (costs money) |
| `tools/view-trajectory.ts` | Renders a searchable HTML view of a native session | Writes the HTML file |
| `tools/ledger-check-consistency.ts` | Compares a task's sentinel files with its ledger rows | No |
| `tools/worktree-manager.ts` | Creates and manages git worktrees for parallel work | Git worktrees |
| `tools/batch-pr-fetch.ts` | Fetches PR rows for task branches in one `gh` call and writes the session PR cache | Session PR cache |
| `tools/get-issue-json.ts` | Prints a Linear issue as JSON | No |

## Evals and challenge data

| Tool | What it does | Writes |
| -- | -- | -- |
| `tools/validate-evals.ts` | Reports malformed or ineligible eval records | No |
| `tools/eval-rejected.ts` | Shows rejected eval quarantine records | No |
| `tools/deduplicate-evals.ts` | Removes duplicate eval records, keeping the earliest per issue and PR | Rewrites eval files (`--dry-run` available) |
| `tools/migrate-eval-corpus.ts` | Normalizes reviewer aliases and quarantines invalid eval records | Rewrites eval files (`--dry-run` available) |
| `tools/analyze-challenges.ts` | Aggregates challenge comparison results | No |
| `tools/generate-skip-report.ts` | Reports how often challenge pairs ended with no comparison | No |
| `tools/show-hokusai-ledger.ts` | Shows the local Hokusai contribution reward ledger | No |
| `tools/audit-manual-edit-attribution.ts` | Finds eval records where operator commits were scored as model work | No |

## Backfills

Each one repairs historical records once. Most were written for a specific past window, so check that it still applies before running it.

| Tool | What it does | Writes |
| -- | -- | -- |
| `tools/backfill-challenge-stage.ts` | Fills in `challengeStage` on challenge eval records | Rewrites eval records (`--dry-run` available) |
| `tools/backfill-challenge-attestation.ts` | Quarantines challenge eval records whose execution evidence disagrees with their intent | Rewrites records with `--apply` |
| `tools/backfill-stage-attribution.ts` | Fills in `taskDescriptor.stages` on legacy records from routing rationale | Rewrites records (`--dry-run` available) |
| `tools/backfill-task-descriptors.ts` | Fills in `taskDescriptor` on existing eval records | Rewrites records (`--dry-run` available) |
| `tools/backfill-manifest-refs.ts` | Fills in `manifestRef` on historical eval records | Rewrites records (`--dry-run` available) |
| `tools/backfill-tool-decisions.ts` | Harvests tool-decision corpora from worktrees and session streams | Corpus files (`--dry-run` available) |

## Analysis and measurement

| Tool | What it does | Writes |
| -- | -- | -- |
| `tools/analyze-cost-baseline.ts` | Cost and wall-clock per merged task, queue depth and integration failures (HOK-3336) | Report files |
| `tools/analyze-packet-signal.ts` | Compares task packet structure with historical eval outcomes | No |
| `tools/classify-packet.ts` | Says whether a file is a task packet or a raw issue | No |
| `tools/build-task-contract.ts` | Builds `features/<slug>/task-contract.json` from the packet and plan | The contract file |
| `tools/tool-decision-report.ts` | Corpus-quality counters for a tool-decision corpus | No |
| `tools/measure-run-related.ts` | Measures `tests/run-related.sh` selection time across recent PRs | No |
| `tools/run-wavemill-router-eval.ts` | Replays recorded tasks through the router to evaluate a routing policy | Results only with `--persist` |
| `tools/plan-launch-priority-certifications.ts` | Plans which models need launch-priority certification for coverage | Only with `--persist` |
| `tools/collect-static-features.ts` | Collects static features (type and lint errors, build, complexity) from a checkout | No |
| `tools/extract-candidate-features.ts` | Extracts Arbiter candidate features from a checkout and PR | No |
| `tools/discover-ci-checks.ts` | Lists a GitHub repo's required checks | No |

## Setup

| Tool | What it does | Writes |
| -- | -- | -- |
| `tools/init-github-labels.ts` | Creates the Wavemill PR labels in a GitHub repo | GitHub labels |
| `tools/generate-claude-permissions.ts` | Generates Claude Code permission settings from wavemill config | A settings file (default path, or `--output`) |
| `tools/generate-codex-permissions.ts` | Generates Codex permission settings from wavemill config | A settings file (default path, or `--output`) |

