#!/usr/bin/env bash
# Golden journey: real managed eval failure -> bounded retry -> persisted success.
export JOURNEY_INCIDENT_CURRENTNESS=1
export JOURNEY_PAIR_NAME=incident-currentness
source "$(dirname "$0")/challenge-pair-eval.journey.sh"
