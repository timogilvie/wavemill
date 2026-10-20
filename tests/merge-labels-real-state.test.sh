#!/usr/bin/env bash
set -euo pipefail

# Integration test for merge label reconciler with real workflow-state shape
# Tests that findTaskInState can match tasks from real workflow state

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/state-fixtures.sh
source "$SCRIPT_DIR/lib/state-fixtures.sh"

# Create temporary test directory
readonly TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Testing findTaskInState with real workflow-state shape..."

# Test: Task with pr as string, slug, and worktree can be matched
test_task_found() {
  local test_dir="$TMP_DIR/test1"
  mkdir -p "$test_dir"

  local slug="test-feature"
  mkdir -p "$test_dir/.wavemill"
  mkdir -p "$test_dir/features/$slug"

  # Seed the row through the schema-validated builder (HOK-3223): pr is the
  # string the shell writers store; a reader-only name like prNumber is rejected.
  fixture_workflow_state "$test_dir/.wavemill/workflow-state.json" \
    HOK-9999 pr=9999 slug="$slug" worktree="$test_dir" phase=ready

  # Write ready result for headSha derivation
  cat > "$test_dir/features/$slug/.ready-result.json" <<EOF
{
  "status": "completed",
  "sha": null,
  "artifacts": {
    "verdict": "pass",
    "readyHeadSha": "cafebabedeadbeef"
  }
}
EOF

  # Test that findTaskInState can find this task
  local output
  output=$(cd "$REPO_ROOT" && npx tsx -e "(async () => {
    const { findTaskInState } = await import('./shared/lib/merge-labels.ts');
    const { readWorkflowState } = await import('./shared/lib/workflow-state.ts');
    const { join } = await import('node:path');

    const repoDir = '$test_dir';
    const state = readWorkflowState(join(repoDir, '.wavemill', 'workflow-state.json'), {
      onInvalid: (_path, issues) => { console.error('FAIL: schema violations', JSON.stringify(issues)); process.exit(1); },
    });
    const task = findTaskInState(9999, state, repoDir);

    if (!task) {
      console.error('FAIL: Task not found');
      process.exit(1);
    }
    if (task.prNumber !== 9999) {
      console.error('FAIL: Wrong prNumber:', task.prNumber);
      process.exit(1);
    }
    if (task.headSha !== 'cafebabedeadbeef') {
      console.error('FAIL: Wrong headSha:', task.headSha);
      process.exit(1);
    }
    if (task.challengeRole !== 'primary') {
      console.error('FAIL: Wrong challengeRole:', task.challengeRole);
      process.exit(1);
    }
    if (!task.featureDir.endsWith('features/$slug')) {
      console.error('FAIL: Wrong featureDir:', task.featureDir);
      process.exit(1);
    }
    console.log('PASS: Task found with correct fields');
  })();" 2>&1)

  if ! echo "$output" | grep -q "PASS: Task found with correct fields"; then
    echo "FAIL: $output" >&2
    return 1
  fi

  echo "  ✓ Task with pr as string matched correctly"
}

# Test: Challenger task ID is recognized
test_challenger_role() {
  local test_dir="$TMP_DIR/test2"
  mkdir -p "$test_dir"

  local slug="test-challenger"
  mkdir -p "$test_dir/.wavemill"
  mkdir -p "$test_dir/features/$slug"

  fixture_workflow_state "$test_dir/.wavemill/workflow-state.json" \
    HOK-123_c pr=456 slug="$slug" worktree="$test_dir" phase=ready

  local output
  output=$(cd "$REPO_ROOT" && npx tsx -e "(async () => {
    const { findTaskInState } = await import('./shared/lib/merge-labels.ts');
    const { readWorkflowState } = await import('./shared/lib/workflow-state.ts');
    const { join } = await import('node:path');

    const repoDir = '$test_dir';
    const state = readWorkflowState(join(repoDir, '.wavemill', 'workflow-state.json'), {
      onInvalid: (_path, issues) => { console.error('FAIL: schema violations', JSON.stringify(issues)); process.exit(1); },
    });
    const task = findTaskInState(456, state, repoDir);

    if (!task) {
      console.error('FAIL: Task not found');
      process.exit(1);
    }
    if (task.challengeRole !== 'challenger') {
      console.error('FAIL: Expected challenger role, got:', task.challengeRole);
      process.exit(1);
    }
    console.log('PASS: Challenger role recognized');
  })();" 2>&1)

  if ! echo "$output" | grep -q "PASS: Challenger role recognized"; then
    echo "FAIL: $output" >&2
    return 1
  fi

  echo "  ✓ Challenger task ID (_c suffix) recognized"
}

# Test: Blank pr field returns null
test_blank_pr() {
  local test_dir="$TMP_DIR/test3"
  mkdir -p "$test_dir"

  local slug="test-blank"
  mkdir -p "$test_dir/.wavemill"
  mkdir -p "$test_dir/features/$slug"

  fixture_workflow_state "$test_dir/.wavemill/workflow-state.json" \
    HOK-789 pr= slug="$slug" worktree="$test_dir" phase=planning

  local output
  output=$(cd "$REPO_ROOT" && npx tsx -e "(async () => {
    const { findTaskInState } = await import('./shared/lib/merge-labels.ts');
    const { readWorkflowState } = await import('./shared/lib/workflow-state.ts');
    const { join } = await import('node:path');

    const repoDir = '$test_dir';
    const state = readWorkflowState(join(repoDir, '.wavemill', 'workflow-state.json'), {
      onInvalid: (_path, issues) => { console.error('FAIL: schema violations', JSON.stringify(issues)); process.exit(1); },
    });
    const task = findTaskInState(789, state, repoDir);

    if (task !== null) {
      console.error('FAIL: Expected null for blank pr, got:', task);
      process.exit(1);
    }
    console.log('PASS: Blank pr returns null');
  })();" 2>&1)

  if ! echo "$output" | grep -q "PASS: Blank pr returns null"; then
    echo "FAIL: $output" >&2
    return 1
  fi

  echo "  ✓ Blank pr field returns null"
}

# Run all tests
test_task_found
test_challenger_role
test_blank_pr

echo "All tests passed!"
