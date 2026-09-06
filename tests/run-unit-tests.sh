#!/usr/bin/env bash
set -euo pipefail

# Runner for the node:test unit suite (previously a ~190-file list inlined in
# package.json). Supports sharding so CI can spread it across parallel jobs.
#
# Usage:
#   bash tests/run-unit-tests.sh                    # run every test
#   bash tests/run-unit-tests.sh --shard 2/7        # run shard 2 of 7
#   bash tests/run-unit-tests.sh --list             # print selected tests and exit
#   bash tests/run-unit-tests.sh --timing-out FILE  # also write per-file timing JSON
#
# Shards are assigned by the deterministic weighted partitioner
# (tools/partition-tests.ts + tests/ci-test-weights.json): cost is heavily
# skewed toward a few subprocess-spawning files, so weighted assignment keeps
# shard runtimes balanced where round-robin could not. --shard 1/1 (the
# default) short-circuits to the full list without invoking the partitioner,
# so plain local runs have no extra dependency.
#
# Each shard hands its whole subset to a single 'node --test' invocation, which
# parallelizes across cores internally; sharding adds a second level on top by
# giving each shard its own runner.
#
# Timing output (--timing-out or TIMING_OUTPUT env) is a single bounded JSON
# document produced by tests/lib/unit-timing-reporter.mjs: one entry per test
# file with id, elapsed ms, and result. It contains only test ids, durations,
# and results -- never environment content.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TESTS=(
  shared/lib/session.test.js
  shared/lib/session-timer.test.js
  shared/lib/eval-prompt-size.test.ts
  shared/lib/eval.test.js
  shared/lib/json-repair.test.ts
  shared/lib/operator-intervention.test.ts
  shared/lib/intervention-detector.test.ts
  shared/lib/stage-result.test.ts
  shared/lib/session-adapters.test.ts
  shared/lib/native-agent/provider.test.ts
  shared/lib/native-agent/provider-error-classifier.test.ts
  shared/lib/native-agent/providers.test.ts
  shared/lib/native-agent/messages.test.ts
  shared/lib/native-agent/compaction.test.ts
  shared/lib/native-agent/transcript-compactor.test.ts
  shared/lib/native-agent/context-window-guard.test.ts
  shared/lib/native-agent/prompt-size-log.test.ts
  shared/lib/native-agent/prompts.test.ts
  shared/lib/native-agent/pi-usage-cost.test.ts
  shared/lib/native-agent/provenance.test.ts
  shared/lib/native-agent/redaction.test.ts
  shared/lib/native-agent/trajectory-viewer.test.ts
  shared/lib/native-agent/tool-compat-validator.test.ts
  shared/lib/native-agent/tool-compat-fixtures.test.ts
  shared/lib/native-agent/patch-contract.test.ts
  shared/lib/native-agent/patch-runtime.test.ts
  shared/lib/native-agent/patch-matcher.test.ts
  shared/lib/native-agent/coding-failure-handoff.test.ts
  shared/lib/native-agent/coding-artifacts.test.ts
  shared/lib/native-agent/completion-normalizer.test.ts
  shared/lib/native-agent/mutation-policy.test.ts
  shared/lib/native-agent/network-policy.test.ts
  shared/lib/native-agent/completion-gate.test.ts
  shared/lib/native-agent/coding-certification.test.ts
  shared/lib/native-agent/coding-gate.test.ts
  shared/lib/native-agent/coding-handoff.test.ts
  shared/lib/native-agent/recovery.test.ts
  shared/lib/native-agent/cleanup.test.ts
  shared/lib/native-agent/coding-lifecycle.test.ts
  shared/lib/native-agent/command-transcript.test.ts
  shared/lib/native-agent/command-argv.test.ts
  shared/lib/native-agent/command-substrate.test.ts
  shared/lib/native-agent/tools/policies.test.ts
  shared/lib/native-agent/tools/registry.test.ts
  shared/lib/native-agent/tools/git.test.ts
  shared/lib/native-agent/tools/apply-patch-tool.test.ts
  shared/lib/native-agent/tools/command-tools.test.ts
  shared/lib/native-agent/tools/patch.test.ts
  shared/lib/native-agent/tools/mutation-tools.test.ts
  shared/lib/native-agent/tools/read-only.test.ts
  shared/lib/native-agent/tools/redaction.test.ts
  shared/lib/native-agent/tools/artifacts.test.ts
  shared/lib/native-agent/loop.test.ts
  shared/lib/native-agent/output-limits.test.ts
  shared/lib/native-agent/transcript.test.ts
  shared/lib/native-expansion.test.ts
  shared/lib/native-agent/workflow-tools/contracts.test.ts
  shared/lib/native-agent/workflow-tools/github.test.ts
  shared/lib/native-agent/workflow-tools/mutation-record.test.ts
  shared/lib/native-agent/workflow-tools/mutation-enforcer.test.ts
  shared/lib/native-agent/workflow-tools/linear-tools.test.ts
  shared/lib/native-agent/workflow-tools/command-tools.test.ts
  shared/lib/native-agent/workflow-tools/github-fixtures.test.ts
  shared/lib/native-agent/workflow-tools/review-integration.test.ts
  shared/lib/native-agent/workflow-tools/retry-idempotency.test.ts
  shared/lib/native-agent/workflow-tools/approval-gate.test.ts
  shared/lib/native-agent/workflow-tools/ready-remediation-integration.test.ts
  shared/lib/issue-expander.test.ts
  shared/lib/native-agent/launch-planning.test.ts
  shared/lib/native-agent/planning-canary.test.ts
  shared/lib/feature-outcome-consumer.test.ts
  shared/lib/outcome-collectors.test.ts
  shared/lib/context-analyzer.test.ts
  shared/lib/review-engine.test.ts
  shared/lib/review-runner.test.ts
  shared/lib/review-scope-guard.test.ts
  shared/lib/review-progress.test.ts
  shared/lib/review-formatter.test.ts
  shared/lib/pr-comparison.test.ts
  shared/lib/swap-test/swap-test.test.ts
  shared/lib/pr-diff-provider.test.ts
  shared/lib/pr-metadata.test.ts
  shared/lib/pr-ci-status.test.ts
  shared/lib/ready-engine.test.ts
  shared/lib/ready-stage.test.ts
  shared/lib/ci-failure-classifier.test.ts
  shared/lib/ci-log-fetcher.test.ts
  shared/lib/ready-watchdog.test.ts
  shared/lib/migration-ast.test.ts
  shared/lib/tend-challenge-gate.test.ts
  shared/lib/transient-retry.test.ts
  shared/lib/tend-loop.test.ts
  shared/lib/challenge-comparison.test.ts
  shared/lib/no-comparison-report.test.ts
  shared/lib/challenge-pair-resolver.test.ts
  shared/lib/arm-failure-taxonomy.test.ts
  shared/lib/arm-reliability.test.ts
  shared/lib/challenge-selection-health.test.ts
  shared/lib/stale-task-branches.test.ts
  shared/lib/tend-controller.test.ts
  shared/lib/observer-status-renderer.test.ts
  shared/lib/tend-status-renderer.test.ts
  shared/lib/tend-singleton.test.ts
  shared/lib/promotion-controller.test.ts
  shared/lib/cross-pr-revert-detector.test.ts
  shared/lib/llm-cli.test.ts
  shared/lib/headless-llm.test.ts
  shared/lib/router-log.test.ts
  shared/lib/challenge-analyzer.test.ts
  shared/lib/challenge-unavailable.test.ts
  shared/lib/challenge-attestation-backfill.test.ts
  shared/lib/challenge-pair-recovery.test.ts
  shared/lib/current-challenge-eval-selector.test.ts
  shared/lib/challenge-comparison-eval-evidence.test.ts
  shared/lib/harness-replay.test.ts
  shared/lib/cross-repo-parity.valid.test.ts
  shared/lib/cross-repo-parity.missing.test.ts
  shared/lib/cross-repo-parity.wrong-suite.test.ts
  shared/lib/cross-repo-parity.stale.test.ts
  shared/lib/cross-repo-parity.partial.test.ts
  shared/lib/challenge-execution-contract.test.ts
  shared/lib/challenge-pairing-repair.test.ts
  shared/lib/config.test.ts
  shared/lib/config-integrity.test.ts
  shared/lib/launch-plan-schema.test.ts
  shared/lib/launch-validation.test.ts
  shared/lib/manual-edit-attribution-audit.test.ts
  shared/lib/merge-queue.test.ts
  shared/lib/model-registry.test.ts
  shared/lib/model-promotion.test.ts
  shared/lib/model-evidence-policy.test.ts
  shared/lib/disabled-models.test.ts
  shared/lib/effective-models.test.ts
  shared/lib/model-agent-resolution.test.ts
  shared/lib/model-resolution.test.ts
  shared/lib/model-resolution-display.test.ts
  shared/lib/mill-config-preflight.test.ts
  shared/lib/routing-policy.test.ts
  shared/lib/hokusai-adapter.test.ts
  shared/lib/hokusai-consent.test.ts
  shared/lib/hokusai-redaction.test.ts
  shared/lib/hokusai-router.test.ts
  shared/lib/hokusai-schema.test.ts
  shared/lib/hokusai-router-audit.test.ts
  shared/lib/hokusai-contribution-schema.test.ts
  shared/lib/hokusai-contribution-builder.test.ts
  shared/lib/hokusai-local-config.test.ts
  shared/lib/hokusai-audit.test.ts
  shared/lib/hokusai-submission-trigger.test.ts
  shared/lib/hokusai-trigger-log.test.ts
  shared/lib/hokusai-queue.test.ts
  shared/lib/hokusai-backfill.test.ts
  shared/lib/hokusai-queue-drain.test.ts
  shared/lib/hokusai-ledger.test.ts
  shared/lib/hokusai-queue-export.test.ts
  shared/lib/hokusai-reward-ledger.test.ts
  shared/lib/text-redaction.test.ts
  shared/lib/redaction-profiles.test.ts
  shared/lib/shell-utils.test.ts
  shared/lib/jsonl-utils.test.ts
  shared/lib/resource-manifest.test.ts
  shared/lib/harness-id-backfill.test.ts
  shared/lib/harness-diff.test.ts
  shared/lib/quota-state.test.ts
  shared/lib/template-curly-checker.test.ts
  shared/lib/transient-marker.test.ts
  shared/lib/wavemill-incident-artifact-diagnostics.test.ts
  shared/lib/wavemill-incident-detector.test.ts
  shared/lib/wavemill-incident-store.test.ts
  shared/lib/state-mutex.test.ts
  shared/lib/job-tracker.test.ts
  shared/lib/operating-mode.test.ts
  shared/lib/plan-prompt-selector.test.ts
  shared/lib/cli-prompt.test.ts
  shared/lib/cli-utils.test.ts
  shared/lib/linear-update-error-log.test.ts
  shared/lib/linear-retry-queue.test.ts
  shared/lib/github-labels.test.ts
  shared/lib/pr-state-labels.test.ts
  shared/lib/progress-heartbeat.test.ts
  shared/lib/scope-shrinker.test.ts
  shared/lib/linear-dependency-resolver.test.ts
  shared/lib/dependency-classifier.test.ts
  shared/lib/queue-partial-refresh.test.ts
  shared/lib/route-artifact.test.ts
  shared/lib/route-batch.test.ts
  shared/lib/model-router.test.ts
  shared/lib/eval-aggregator.test.ts
  shared/lib/eval-corpus-migrator.test.ts
  shared/lib/eval-record-builder.test.ts
  shared/lib/eval-orchestrator.test.ts
  shared/lib/stage-eval-evidence.test.ts
  shared/lib/eval-schema.test.ts
  shared/lib/trace-event.test.ts
  shared/lib/eval-success-policy.test.ts
  shared/lib/eval-validator.test.ts
  shared/lib/eval-rejected-store.test.ts
  shared/lib/task-dependency-plan-cache.test.ts
  shared/lib/task-dependency-planner.test.ts
  shared/lib/plan-queue-utils.test.ts
  shared/lib/scaffold-migrate-dryrun.test.ts
  shared/lib/deepseek-smoke.test.ts
  shared/lib/seam-artifacts.test.ts
  shared/lib/blocked-completion.test.ts
  shared/lib/task-contract.test.ts
  shared/lib/task-lifecycle.test.ts
  shared/lib/feature-state.test.ts
  shared/lib/soft-gates.test.ts
  shared/lib/openrouter-provider.test.ts
  shared/lib/openrouter-credits.test.ts
  shared/lib/openrouter-catalog.test.ts
  shared/lib/openrouter-alias-audit.test.ts
  shared/lib/openrouter-doctor.test.ts
  shared/lib/native-agent/openrouter-credits-guard.test.ts
  shared/lib/launchable-models.test.ts
  shared/lib/openrouter-zero-traffic.test.ts
  shared/lib/parity-report.test.ts
  src/evaluation/scorers/wavemill/success-rate-under-budget.test.ts
  src/evaluation/adapters/wavemill-router-adapter.test.ts
  tools/abort-task.test.ts
  tools/add-pr-label.test.ts
  tools/backfill-challenge-stage.test.ts
  tools/backfill-hokusai-submissions.test.ts
  tools/certify-patch-coding.test.ts
  tools/promote-provisional-model.test.ts
  tools/generate-skip-report.test.ts
  tools/check-config-version.test.ts
  tools/check-pi-version.test.ts
  tools/check-ci-command-map-drift.test.ts
  tools/check-ci-concurrency.test.ts
  tools/check-cross-pr-reverts.test.ts
  tools/hok2423-verify-native-provider-gate.test.ts
  tools/hok2424-verify-native-expansion.test.ts
  tools/incidents.test.ts
  tools/launch-validation.test.ts
  tools/measure-repo-attribution.test.ts
  tools/observer.test.ts
  tools/parity-report.test.ts
  tools/resolve-challenge-task.test.ts
  tools/route-tasks.test.ts
  tools/seam-artifact-cli.test.ts
  tools/plan-queue.test.ts
  tools/select-wave.test.ts
  tools/set-pr-ready-label.test.ts
  tools/smoke-deepseek.test.ts
  tools/openrouter-doctor.test.ts
  tools/review-scope-prompt.test.ts
  tools/audit-openrouter-aliases.test.ts
  tools/resolve-orphan-challenge-pair.test.ts
  tools/resolve-primary-merged-pair.test.ts
  tests/drift-detector.test.ts
  shared/lib/parent-monitor-drift.test.ts
  tests/check-drift-tool.test.ts
  tests/jq-filter-smoke.test.ts
  tests/ready-stage-transient-mergeability.test.ts
  tools/sync-config.test.ts
  shared/lib/native-agent/certification/identity.test.ts
  shared/lib/native-agent/certification/schema.test.ts
  shared/lib/native-agent/certification/store.test.ts
  shared/lib/native-agent/certification/coverage.test.ts
  shared/lib/native-agent/certification/auto-remediate.test.ts
  shared/lib/native-agent/certification/validator.test.ts
  shared/lib/native-agent/certification/scenarios.test.ts
  shared/lib/native-agent/certification/scenario-runner.test.ts
  shared/lib/native-agent/certification/eligibility-gate.test.ts
  shared/lib/native-agent/certification/live-coding-canary.test.ts
  shared/lib/native-agent/certification/report.test.ts
  shared/lib/native-agent/certification/rollout-regression.test.ts
  tools/native-agent-certify.test.ts
  tools/native-agent-certifications-import.test.ts
  tools/native-agent-certifications-prune.test.ts
  tools/native-agent-certifications.test.ts
  shared/lib/incident-linear-retry-queue.test.ts
  shared/lib/incident-to-linear-synchronizer.test.ts
  shared/lib/verification-metrics.test.ts
  shared/lib/ci-verification-drift-detector.test.ts
  shared/lib/pre-pr-verification-drift-validator.test.ts
  tools/check-ci-verification.test.ts
  tests/verification-scenarios.test.ts
  # Registration-complete shared and tool tests.
  shared/lib/artifact-diagnostics.test.ts
  shared/lib/challenge-coverage-selector.test.ts
  shared/lib/challenge-mode.test.ts
  shared/lib/challenge-recovery.test.ts
  shared/lib/challenge-scheduler.test.ts
  shared/lib/challenge-score-selector.test.ts
  shared/lib/check-routing.test.ts
  shared/lib/codebase-context-gatherer.test.ts
  shared/lib/config-sync.test.ts
  shared/lib/constraint-parser.test.ts
  shared/lib/constraint-storage.test.ts
  shared/lib/constraint-validator.test.ts
  shared/lib/context-linter.test.ts
  shared/lib/deepseek-launcher.test.ts
  shared/lib/difficulty-analyzer.test.ts
  shared/lib/eval-backfill.test.ts
  shared/lib/eval-context-gatherer.test.ts
  shared/lib/eval-deduplication.test.ts
  shared/lib/eval-export.test.ts
  shared/lib/eval-persistence.test.ts
  shared/lib/eval-summary-printer.test.ts
  shared/lib/evals-paths.test.ts
  shared/lib/execution-contract.test.ts
  shared/lib/expanded-route-cache.test.ts
  shared/lib/reconciliation-context.test.ts
  shared/lib/launch-priority-audit.consistency.test.ts
  shared/lib/launch-priority-audit.test.ts
  shared/lib/linear.test.ts
  shared/lib/llm-router.test.ts
  shared/lib/model-validator.test.ts
  shared/lib/native-agent/certification/router-filter.test.ts
  shared/lib/native-agent/launch-coding.test.ts
  shared/lib/native-agent/review.test.ts
  shared/lib/native-agent/session-stream.test.ts
  shared/lib/native-agent/smoke.test.ts
  shared/lib/native-agent/tools/command.test.ts
  shared/lib/native-agent/tools/intended-files.test.ts
  shared/lib/native-agent/workflow-tools/dedupe-registry.test.ts
  shared/lib/native-agent/workflow-tools/ready-remediation.test.ts
  shared/lib/native-agent/workflow-tools/review-flow.test.ts
  shared/lib/native-openrouter-config-validation.test.ts
  shared/lib/openrouter-generation-api.test.ts
  shared/lib/openrouter-launcher.test.ts
  shared/lib/openrouter-runtime.test.ts
  shared/lib/openrouter-smoke.test.ts
  shared/lib/permission-patterns.test.ts
  shared/lib/permissions-verifier.test.ts
  shared/lib/plan-validator.test.ts
  shared/lib/post-completion-hook.test.ts
  shared/lib/branch-publication.test.ts
  shared/lib/pre-pr-verification-gate.test.ts
  shared/lib/pre-pr-verification.test.ts
  shared/lib/project-context-compactor.test.ts
  shared/lib/project-context-generator.test.ts
  shared/lib/prompt-hash.test.ts
  shared/lib/prompt-registry.test.ts
  shared/lib/prompt-utils.test.ts
  shared/lib/ready-diagnostics.test.ts
  shared/lib/ready-migration-base.test.ts
  shared/lib/repo-context-analyzer.test.ts
  shared/lib/resource-adapters/dspy-adapter.test.ts
  shared/lib/resource-adapters/native-runtime-adapter.test.ts
  shared/lib/resource-adapters/prompt-adapter.test.ts
  shared/lib/resource-registry.test.ts
  shared/lib/resource-retrieval.test.ts
  shared/lib/resource-selection.test.ts
  shared/lib/review-context-gatherer.test.ts
  shared/lib/review-stats.test.ts
  shared/lib/route-model-successors.test.ts
  shared/lib/router-diversity.test.ts
  shared/lib/router-exploration.test.ts
  shared/lib/rubric.test.ts
  shared/lib/rule-generator.test.ts
  shared/lib/stage-aware-router.test.ts
  shared/lib/subsystem-cross-reference.test.ts
  shared/lib/subsystem-search.test.ts
  shared/lib/sync-config-classifier.test.ts
  shared/lib/task-context-analyzer.test.ts
  shared/lib/task-descriptor-backfill.test.ts
  shared/lib/task-descriptor-builder.test.ts
  shared/lib/task-difficulty-classifier.test.ts
  shared/lib/task-packet-classifier.test.ts
  shared/lib/task-packet-utils.test.ts
  shared/lib/task-packet-validator.test.ts
  shared/lib/tool-runner.test.ts
  shared/lib/workflow-cost.test.ts
  shared/lib/workflow-router.test.ts
  shared/lib/worktree-manager.test.ts
  tools/backfill-stage-scores.test.ts
  tools/certify-launch-priority-model.test.ts
  tools/check-native-agent-launch.test.ts
  tools/check-review-setup.test.ts
  tests/cli-smoke.test.ts
  tests/model-settings-migration.test.ts
  tools/check-test-registration.test.ts
  tools/hok2425-verify-native-workflow-certification.test.ts
  tools/launch-native-review.test.ts
  tools/launch-priority-audit.test.ts
  tools/openrouter-smoke.test.ts
  tools/plan-launch-priority-certifications.test.ts
  tools/reap-stale-challengers.test.ts
  shared/lib/test-partitioner.test.ts
  shared/lib/shard-balance.test.ts
  shared/lib/ci-test-timings.test.ts
)

SHARD_INDEX=1
SHARD_TOTAL=1
LIST_ONLY=0
TIMING_OUT="${TIMING_OUTPUT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shard)
      if [[ ! "${2:-}" =~ ^[0-9]+/[0-9]+$ ]]; then
        echo "run-unit-tests.sh: --shard requires INDEX/TOTAL (e.g. 2/5)" >&2
        exit 2
      fi
      SHARD_INDEX="${2%%/*}"
      SHARD_TOTAL="${2##*/}"
      shift 2
      ;;
    --list)
      LIST_ONLY=1
      shift
      ;;
    --timing-out)
      if [[ -z "${2:-}" ]]; then
        echo "run-unit-tests.sh: --timing-out requires a file path" >&2
        exit 2
      fi
      TIMING_OUT="$2"
      shift 2
      ;;
    *)
      echo "run-unit-tests.sh: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

if (( SHARD_TOTAL < 1 || SHARD_INDEX < 1 || SHARD_INDEX > SHARD_TOTAL )); then
  echo "run-unit-tests.sh: invalid shard ${SHARD_INDEX}/${SHARD_TOTAL}" >&2
  exit 2
fi

if (( SHARD_TOTAL == 1 )); then
  SELECTED=("${TESTS[@]}")
else
  # Deterministic weighted partitioning. A partitioner failure must fail the
  # shard loudly: a silent fallback could drop or duplicate tests across the
  # matrix if one leg fell back while others did not.
  if ! SELECTION="$(
    printf '%s\n' "${TESTS[@]}" |
      npx tsx "$REPO_DIR/tools/partition-tests.ts" --suite unit --shard "${SHARD_INDEX}/${SHARD_TOTAL}"
  )"; then
    echo "run-unit-tests.sh: partitioner failed for shard ${SHARD_INDEX}/${SHARD_TOTAL}" >&2
    exit 2
  fi
  SELECTED=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && SELECTED+=("$line")
  done <<< "$SELECTION"
fi

# A shard with no work is a configuration error, not a silent pass.
if (( ${#SELECTED[@]} == 0 )); then
  echo "run-unit-tests.sh: shard ${SHARD_INDEX}/${SHARD_TOTAL} selected no tests" >&2
  exit 2
fi

if (( LIST_ONLY == 1 )); then
  printf '%s\n' "${SELECTED[@]}"
  exit 0
fi

# This check is a real safety net: node --test only exits non-zero on a
# missing path when it is the sole argument -- alongside other existing paths
# it silently ignores the missing one (verified on Node 22). It also names the
# offending entry against this script's own list, which is where a stale path
# actually needs fixing.
missing=0
for f in "${SELECTED[@]}"; do
  if [[ ! -f "$REPO_DIR/$f" ]]; then
    echo "run-unit-tests.sh: missing test file $f" >&2
    missing=1
  fi
done
if (( missing == 1 )); then
  exit 1
fi

if (( SHARD_TOTAL > 1 )); then
  echo "=== Unit tests shard ${SHARD_INDEX}/${SHARD_TOTAL} (${#SELECTED[@]} of ${#TESTS[@]} files) ==="
else
  echo "=== Unit tests (${#TESTS[@]} files) ==="
fi

cd "$REPO_DIR"

if [[ -n "$TIMING_OUT" ]]; then
  # Second reporter writes the bounded per-file timing JSON to $TIMING_OUT
  # while the spec reporter keeps human-readable output on stdout. The shard
  # label reaches the reporter through the environment.
  export WAVEMILL_TIMING_SHARD="${SHARD_INDEX}/${SHARD_TOTAL}"
  exec node --test \
    --test-reporter spec --test-reporter-destination stdout \
    --test-reporter "$REPO_DIR/tests/lib/unit-timing-reporter.mjs" \
    --test-reporter-destination "$TIMING_OUT" \
    "${SELECTED[@]}"
fi

exec node --test "${SELECTED[@]}"
