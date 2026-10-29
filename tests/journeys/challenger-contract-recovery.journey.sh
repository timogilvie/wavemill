#!/usr/bin/env bash
# Golden journey: a plan-stage challenger loses arm-local intent during coding.
# The persisted coding contract must replay, retaining its edits and approved plan.
export JOURNEY_RECOVERY_CONTRACT_REPLAY=1
export JOURNEY_PAIR_STAGE=plan
JOURNEY_BUDGET_SECONDS=$(( ${JOURNEY_BUDGET_SECONDS:-0} * 2 ))
export JOURNEY_PAIR_NAME=challenger-contract-recovery
source "$(dirname "$0")/challenge-pair-eval.journey.sh"
