#!/usr/bin/env bash
# Golden journey (HOK-3456): required files are admitted in review scope
# automatically, with no operator touch.
#
# Protects against: a regression in the REQUIRED_PATHS admission or the
# ci.yml structural check that forces an operator scope extension for files
# the mill's own rules demand.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP required-files-review-scope journey: $reason"
  exit 0
fi

ISSUE="JRN-3456"
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/required-files-review-scope/fake-agent" && pwd)"
journey_init required-files-review-scope
fakes_linear_add_issue "$ISSUE" "Add required files journey and output file" Todo

# Seed the integration branch with a ci.yml that has a journey matrix.
# The task will add a new journey entry to this matrix.
mkdir -p "$FAKE_REPO_DIR/.github/workflows"
tee "$FAKE_REPO_DIR/.github/workflows/ci.yml" <<'YAML'
name: CI
on:
  push:
jobs:
  journeys:
    name: Golden Journey (${{ matrix.journey }})
    strategy:
      matrix:
        journey: [happy-path]
    steps:
      - run: echo ${{ matrix.journey }}
YAML
(
  cd "$FAKE_REPO_DIR"
  git checkout -q "$JOURNEY_INTEGRATION_BRANCH"
  git add .github/workflows/ci.yml
  git -c user.name=journey -c user.email=journey@example.invalid commit -q -m "seed ci.yml"
  git push -q origin "$JOURNEY_INTEGRATION_BRANCH"
  git checkout -q main
  git merge -q --ff-only "origin/$JOURNEY_INTEGRATION_BRANCH"
  git push -q origin main
)

journey_start_monitor
journey_set_tick_budget 60

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"
journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 30 "PR merged by tend"           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert_landed "$ISSUE"
journey_assert "no operator attention needed" test "$JOURNEY_SAW_ATTENTION" = "0"
journey_assert "required journey file landed on integration" \
  git --git-dir "$FAKE_GH_ORIGIN" cat-file -e "refs/heads/$JOURNEY_INTEGRATION_BRANCH:tests/journeys/required-files-review-scope-test.journey.sh"
journey_assert "required fixture file landed on integration" \
  git --git-dir "$FAKE_GH_ORIGIN" cat-file -e "refs/heads/$JOURNEY_INTEGRATION_BRANCH:tests/fixtures/incident-replay/real/required_files_review_scope.json"
journey_assert "registration file landed on integration" \
  git --git-dir "$FAKE_GH_ORIGIN" cat-file -e "refs/heads/$JOURNEY_INTEGRATION_BRANCH:tests/run-unit-tests.sh"
journey_assert "ci.yml matrix includes the new journey" \
  bash -c 'grep -q "required-files-review-scope-test" <(git --git-dir "$1" show "refs/heads/$2:.github/workflows/ci.yml")' _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"

journey_finish
