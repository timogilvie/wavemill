#!/usr/bin/env bash
# Run golden journeys (HOK-3227).
#
#   bash tests/journeys/run-journeys.sh                 # every journey
#   bash tests/journeys/run-journeys.sh happy-path      # one journey by name
#   bash tests/journeys/run-journeys.sh --list          # print journey names
#
# Each journey runs the real mill monitor loop + tend against the shared fakes
# (tests/fakes/). CI runs one journey per job under a 90s budget
# (JOURNEY_BUDGET_SECONDS); a local macOS run is slower, ~2 minutes.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

all=()
for f in "$DIR"/*.journey.sh; do
  name="$(basename "$f" .journey.sh)"
  all+=("$name")
done

if [[ "${1:-}" == "--list" ]]; then
  printf '%s\n' "${all[@]}"
  exit 0
fi

selected=("$@")
(( ${#selected[@]} > 0 )) || selected=("${all[@]}")

failed=()
for name in "${selected[@]}"; do
  file="$DIR/$name.journey.sh"
  if [[ ! -f "$file" ]]; then
    echo "run-journeys: unknown journey '$name' (known: ${all[*]})" >&2
    exit 2
  fi
  echo ">>> journey: $name"
  if ! bash "$file"; then
    failed+=("$name")
  fi
done

if (( ${#failed[@]} > 0 )); then
  echo "--- journeys failed: ${failed[*]} ---"
  exit 1
fi
echo "--- journeys passed: ${selected[*]} ---"
