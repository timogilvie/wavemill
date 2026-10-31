#!/usr/bin/env bash
# Owner watcher for a fakes world (HOK-3329).
#
# fakes_start_world_host runs this as the first window of the world's private
# tmux server, so it is outside the owner's process group and outlives it. When
# the owner dies by any route that skips its EXIT trap (SIGKILL, fork subagent
# end, parent-tree kill), the watcher sees the owner pid + start time gone and
# runs fakes_teardown_world. A graceful owner tears the world down itself; the
# watcher then dies with the server.
#
# Args: world record, owner pid, owner start time (`ps -o lstart=`).
set -u

RECORD="${1:?record required}"
OWNER_PID="${2:?owner pid required}"
OWNER_START="${3:?owner start time required}"

# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

while fakes_world_owner_alive "$OWNER_PID" "$OWNER_START"; do
  sleep 1
done
# Teardown's kill-server hangs up this pane; ignore it so the socket, world dir
# and record are still removed after the server is gone.
trap '' HUP
fakes_teardown_world "$RECORD" </dev/null >/dev/null 2>&1
