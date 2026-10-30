#!/usr/bin/env bash
# Run golden journeys (HOK-3227).
#
#   bash tests/journeys/run-journeys.sh                 # every journey
#   bash tests/journeys/run-journeys.sh happy-path      # one journey by name
#   bash tests/journeys/run-journeys.sh --list          # print journey names
#
# Each journey runs the real mill monitor loop + tend against the shared fakes
# (tests/fakes/). CI runs one journey per job under a 120s budget
# (JOURNEY_BUDGET_SECONDS); a local macOS run is slower, ~2 minutes.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$DIR/../.." && pwd)"

# Backstop reaper (HOK-3329): before any journey starts, tear down worlds whose
# owner or watcher died without completing cleanup. Every world this run
# creates is logged to FAKES_WORLD_LOG for the hygiene check at the end.
source "$INSTALL_DIR/tests/fakes/lib.sh"
fakes_reap_stale_worlds
RUN_TMP="$(mktemp -d "${TMPDIR:-/tmp}/run-journeys.XXXXXX")"
trap 'rm -rf "$RUN_TMP"' EXIT
export FAKES_WORLD_LOG="$RUN_TMP/worlds.jsonl"
: > "$FAKES_WORLD_LOG"

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

# Hygiene (HOK-3329): nothing from this run's own worlds may survive it — no
# record, registered process group, tmux socket or (unless JOURNEY_KEEP_TMP=1)
# world dir. Worlds of concurrent runs are not ours and are not inspected.
strays=()
while IFS=$'\t' read -r kind a b; do
  case "$kind" in
    world)
      [[ -e "$a" ]] && strays+=("record $a")
      [[ -e "$b" ]] && strays+=("socket $b")
      ;;
    dir)
      [[ "${JOURNEY_KEEP_TMP:-0}" != "1" && -e "$a" ]] && strays+=("dir $a")
      ;;
    pgid)
      kill -0 -- "-$a" 2>/dev/null && strays+=("pgid $a")
      ;;
  esac
done < <(jq -r --arg reg "$FAKES_WORLDS_DIR" '
  if .world then
    ["world", "\($reg)/\(.world.id).json", .world.tmuxSocket], ["dir", .world.worldDir, ""]
  else
    ["pgid", (.pgid | tostring), ""]
  end | @tsv' "$FAKES_WORLD_LOG")
if (( ${#strays[@]} > 0 )); then
  printf 'run-journeys: left behind after the run: %s\n' "${strays[@]}" >&2
  exit 1
fi

if (( ${#failed[@]} > 0 )); then
  echo "--- journeys failed: ${failed[*]} ---"
  exit 1
fi
echo "--- journeys passed: ${selected[*]} ---"
