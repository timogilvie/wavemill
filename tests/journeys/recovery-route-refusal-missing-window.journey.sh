#!/usr/bin/env bash
# Same recovery contract, independently entering through a lost task window.
set -euo pipefail
export REFUSAL_DROP_WINDOW=1
export REFUSAL_JOURNEY_NAME=recovery-route-refusal-missing-window
exec bash "$(dirname "$0")/recovery-route-refusal.journey.sh"
