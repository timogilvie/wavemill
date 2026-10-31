#!/usr/bin/env bash
# Golden journey (HOK-3369): a challenge pair's challenger arm emulates the
# native OpenRouter contract — ownership row, session stream, direct
# provider-response stage result — for every stage. The pair runs end to end
# (plan → code → review → eval → compare → merge). Every subsequent monitor
# or CLI write that completes a stage must keep the direct provider-response
# evidence; without the HOK-3369 merge rule the agent-type gate would
# downgrade native evidence to inherited/runtime_fallback on completion.
export JOURNEY_NATIVE_ARM_EVIDENCE=1
export JOURNEY_PAIR_STAGE=implementation
export JOURNEY_PAIR_NAME=native-arm-evidence
source "$(dirname "$0")/challenge-pair-eval.journey.sh"
