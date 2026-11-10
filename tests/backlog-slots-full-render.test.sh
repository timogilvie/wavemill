#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

if ! awk '
  index($0, "update_free_slots_state \"$free_slots\"") { after_slot_update=1 }
  after_slot_update && index($0, "if (( free_slots <= 0 )); then") { in_branch=1 }
  in_branch && index($0, "refresh_backlog_cache") { saw_refresh=1 }
  in_branch && index($0, "Next tasks (slots full):") { saw_heading=1 }
  in_branch && index($0, "0 slots available; waiting for active tasks to finish") { saw_wait=1 }
  in_branch && index($0, "continue") { saw_continue=1; exit }
  END { exit !(saw_refresh && saw_heading && saw_wait && saw_continue) }
' "$MILL_SCRIPT"; then
  echo "full-slot backlog branch does not render a refreshed read-only backlog preview" >&2
  exit 1
fi

echo "PASS: full-slot backlog branch renders refreshed read-only preview"
