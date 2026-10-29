#!/usr/bin/env bash
# Golden journey: real managed eval failure -> bounded retry -> persisted success.
JOURNEY_BUDGET_SECONDS=$(( ${JOURNEY_BUDGET_SECONDS:-0} * 2 ))
export JOURNEY_INCIDENT_CURRENTNESS=1
export JOURNEY_PAIR_NAME=incident-currentness
source "$(dirname "$0")/challenge-pair-eval.journey.sh"
