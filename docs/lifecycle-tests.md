# Lifecycle Tests

Lifecycle tests are the focused integration gate for wavemill controller behavior. They cover planning validation, startup handoff, stage result state, monitor transitions, recovery paths, control pane layout, and dashboard status rendering without running a real mill session.

The terminal lifecycle/resource model used by these tests is documented in [Wavemill Terminal Lifecycle And Resources](wavemill-terminal-lifecycle.md).

## Running Locally

Run the whole lifecycle suite:

```sh
npm run test:lifecycle
```

You can also invoke the runner directly:

```sh
bash tests/run-lifecycle-tests.sh
```

The runner executes each scenario and continues after failures so the summary reports every failing scenario in one pass.

## CI Triggers

The GitHub Actions workflow in `.github/workflows/ci.yml` always runs `npm test` for pull requests and pushes to `main`. The lifecycle suite runs when a pull request or `main` push changes high-risk wavemill lifecycle paths.

The lifecycle suite also runs on the scheduled daily workflow and on manual `workflow_dispatch`, regardless of changed files.

## High-Risk Paths

The high-risk path list lives in `.github/workflows/ci.yml` under the `check-paths` job. Update that list whenever a new file can affect lifecycle state, marker semantics, handoff instructions, or controller behavior.

Current categories:

- Core controller loop and phase transitions: `shared/lib/wavemill-mill.sh`, `shared/lib/agent-adapters.sh`, `shared/lib/stage-result.ts`, `shared/lib/wavemill-startup-runner.sh`, `shared/lib/wavemill-status.sh`, `shared/lib/wavemill-common.sh`, `shared/lib/ready-stage.ts`
- Hook protocol: `shared/hooks/**`
- Phase and prompt handoff instructions: `tools/prompts/**`
- Top-level launcher: `wavemill`
- Lifecycle test definitions: `tests/run-lifecycle-tests.sh`, `tests/planning-validation.test.sh`, `tests/startup-handoff.test.sh`, `tests/stage-state.test.sh`, `tests/stage-state.test.ts`, `tests/monitor-ready-transition.test.sh`, `tests/error-recovery.test.sh`, `tests/control-layout.test.sh`, `tests/wavemill-status.test.sh`
- Dependency-aware task queue: `tests/lifecycle-harness.test.sh`, `tests/lifecycle-scenarios.test.sh`, `tests/wavemill-dependent-launch.test.sh`, `tests/wavemill-queued-tasks-state.test.sh`, `tests/wavemill-launch-plan-queue-metadata.test.sh`, `tests/fixtures/lifecycle/**`
- Stage result CLI: `tools/stage-result-cli.ts`

CI-specific lifecycle categories currently include:

- Dependency-queue lifecycle: `tests/wavemill-dependent-launch.test.sh`, `tests/wavemill-queued-tasks-state.test.sh`, `tests/wavemill-launch-plan-queue-metadata.test.sh`
- Lifecycle scenario fixtures: `tests/lifecycle-scenarios.test.sh`, `tests/lifecycle-harness.test.sh`, `tests/fixtures/lifecycle/**`

The ready-stage lifecycle coverage also includes automatic remediation transitions. When a fixable ready failure launches remediation, lifecycle tests should verify that the monitor keeps the task active, clears operator attention, and avoids repeated relaunch while the remediation head is still in flight.

## Adding A High-Risk Path

Add the path or glob to the `lifecycle` filter in `.github/workflows/ci.yml`. Keep the entry in the category that explains why the path can affect lifecycle behavior. If the path starts a new category, add a short YAML comment above it.

Then update the high-risk path list in this document so local contributors can see what CI considers lifecycle-relevant.

## Adding A Lifecycle Test

Create a deterministic `.test.sh` or `node --test` scenario under `tests/`. Prefer self-contained fixtures, temporary directories, and mocked command binaries over live services.

After adding the test:

1. Add it to `tests/run-lifecycle-tests.sh`.
2. Add the test file to the lifecycle path filter in `.github/workflows/ci.yml`.
3. Update the current path list in this document.
4. Run `npm run test:lifecycle` and `npm test`.

## Test Requirements

Lifecycle tests must be deterministic and network-free. They must not require real Linear API access, GitHub API access, tmux session state, Claude, or Codex.

Failures should be clear enough to act on from CI output. Scenario tests should print the scenario name, expected state, actual state, and relevant logs whenever an assertion fails.
