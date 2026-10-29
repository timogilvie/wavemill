#!/usr/bin/env bash
# Repeated infrastructure failure must escalate quietly without model attribution.
JOURNEY_BUDGET_SECONDS=$(( ${JOURNEY_BUDGET_SECONDS:-0} * 2 ))
export JOURNEY_PAIR_ISSUE=HOK-3076
export JOURNEY_EVAL_FAILURE_FIXTURE="$(cd "$(dirname "$0")/../fixtures/incidents" && pwd)/hok-3076-eval-failure.json"
export JOURNEY_EVAL_EXHAUSTION=1
export JOURNEY_PAIR_NAME=eval-failure-exhaustion
source "$(dirname "$0")/challenge-pair-eval.journey.sh"
