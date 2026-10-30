#!/usr/bin/env bash
# Shared external-edge fakes for tests (HOK-3226).
#
# One fake per external edge, shared by every test that needs it:
#   gh      tests/fakes/bin/gh          stateful, backed by a real bare origin
#   Linear  tests/fakes/linear-fetch-preload.mjs  fetch() interceptor
#   tmux    tests/fakes/bin/tmux        real tmux on a private socket
#   agent   tests/fakes/bin/claude      scripted per-phase agent
#
# Usage (source, then call fakes_setup with an empty scratch dir):
#   source tests/fakes/lib.sh
#   fakes_setup "$TMP"            # builds the world, exports env, prepends PATH
#   fakes_linear_add_issue JRN-1 "Title" Todo
#   fakes_linear_add_issue_from_file fixture-issue.json
#   ... run production code ...
#   fakes_teardown
#
# The world: a bare origin repository at <root>/github.com/<owner>/<repo>.git
# (so code that parses owner/repo out of the remote URL still works), a clone at
# $FAKE_REPO_DIR, gh/Linear state files, and an isolated HOME / git config.
# Nothing here touches the network or the developer's tmux, HOME or gitconfig.
#
# World lifetime (HOK-3329): every fakes_setup records a world in
# /tmp/wmfake-worlds/<id>.json keyed by (ownerPid, ownerStartTime). Exactly one
# function tears it down — fakes_teardown_world — and it is called by three
# things: the owner's EXIT trap (fakes_teardown, the graceful fast path), the
# owner watcher inside the world's private tmux server
# (tests/fakes/world-watcher.sh, which runs when the owner dies untrapped),
# and the startup backstop reaper fakes_reap_stale_worlds (which finishes any
# teardown the watcher itself could not). fakes_spawn registers every long-lived
# child's pgid in the record so teardown can reach the descendants an EXIT trap
# would miss.

FAKES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAKES_INSTALL_DIR="$(cd "$FAKES_DIR/../.." && pwd)"
# Shared world registry (HOK-3329): one record per live world, across processes.
FAKES_WORLDS_DIR="/tmp/wmfake-worlds"
FAKES_LEGACY_SWEEP_MINUTES="${FAKES_LEGACY_SWEEP_MINUTES:-10}"
# shellcheck source=../../shared/lib/terminal-backend.sh
source "$FAKES_INSTALL_DIR/shared/lib/terminal-backend.sh"

# The world must not inherit the caller's mill context. Run from inside a mill
# agent pane, WAVEMILL_PHASE / WAVEMILL_ISSUE / WAVEMILL_SESSION and the pane's
# TOOLS_DIR / LIB_DIR (the install, not this checkout) would leak into every
# child: the fake agent CLI would treat an eval judge `claude -p` call as that
# pane's phase launch (no verdict → timeout), and shell helpers would run the
# install's tools. Scrubbed once, at source time, so the WAVEMILL_* a test
# exports after sourcing this file (e.g. a journey's grace override before
# journey_init) survive.
while read -r _fakes_inherited; do
  unset "$_fakes_inherited"
done < <(compgen -e WAVEMILL_ || true)
unset _fakes_inherited TOOLS_DIR LIB_DIR 2>/dev/null || true

fakes_setup() {
  local root="${1:?fakes_setup: scratch dir required}"
  local slug="${2:-acme/journey}"
  local base_branch="${3:-main}"
  # The directory teardown removes; defaults to the fakes root. A journey
  # passes its own temp dir, which holds the fakes root plus its worktrees and
  # logs, so an owner that dies untrapped leaves none of it behind.
  local world_dir="${4:-$root}"
  mkdir -p "$root"/{home,logs,bin}
  root="$(cd "$root" && pwd -P)"
  world_dir="$(cd "$world_dir" && pwd -P)"


  export FAKE_ROOT="$root"
  export FAKE_REPO_SLUG="$slug"
  export FAKE_GH_ORIGIN="$root/github.com/$slug.git"
  export FAKE_REPO_DIR="$root/repo"
  export FAKE_GH_STATE="$root/gh-state.json"
  export FAKE_GH_LOG="$root/logs/gh.jsonl"
  export FAKE_GH_UNHANDLED="$root/logs/gh-unhandled.jsonl"
  export FAKE_LINEAR_STATE="$root/linear-state.json"
  export FAKE_LINEAR_LOG="$root/logs/linear.jsonl"
  export FAKE_LINEAR_UNHANDLED="$root/logs/linear-unhandled.jsonl"
  export FAKE_AGENT_LOG="$root/logs/agent.log"
  export FAKE_AGENT_UNHANDLED="$root/logs/agent-unhandled.jsonl"
  export FAKE_AGENT_TOOLS_DIR="$FAKES_INSTALL_DIR/tools"
  export FAKE_TMUX_LOG="$root/logs/tmux.log"
  : > "$FAKE_GH_LOG"; : > "$FAKE_GH_UNHANDLED"; : > "$FAKE_LINEAR_LOG"; : > "$FAKE_LINEAR_UNHANDLED"; : > "$FAKE_AGENT_UNHANDLED"

  # tmux sockets must stay under the ~104-byte sun_path limit, so the socket
  # lives in a short /tmp path rather than the (often long) scratch dir.
  if [[ -z "${FAKE_TMUX_REAL:-}" ]]; then
    FAKE_TMUX_REAL="$(term_resolve_real_tmux || true)"
  fi
  export FAKE_TMUX_REAL

  # World lifetime (HOK-3329): record this world keyed by (ownerPid,
  # ownerStartTime) before anything long-lived is spawned. The record is what
  # fakes_teardown_world, the owner watcher and the startup reaper all read.
  # Writing it before the reaper runs keeps this world's dir claimed during the
  # reaper's legacy journey-dir sweep.
  install -d -m 700 "$FAKES_WORLDS_DIR"
  WORLD_ID="$$-$RANDOM"
  WORLD_RECORD="$FAKES_WORLDS_DIR/$WORLD_ID.json"
  WORLD_OWNER_PID=$$
  WORLD_OWNER_START="$(fakes_pid_start_time "$$")"
  export FAKE_TMUX_SOCK="/tmp/wmfake-${WORLD_ID}.sock"
  export WORLD_RECORD WORLD_ID WORLD_OWNER_PID WORLD_OWNER_START
  local _record_tmp="$WORLD_RECORD.tmp.$$"
  jq -n --arg id "$WORLD_ID" --argjson pid "$WORLD_OWNER_PID" --arg start "$WORLD_OWNER_START" \
       --arg world "$world_dir" --arg sock "$FAKE_TMUX_SOCK" \
    '{schemaVersion:1,id:$id,ownerPid:$pid,ownerStartTime:$start,worldDir:$world,tmuxSocket:$sock,pgids:[]}' \
    > "$_record_tmp" && mv "$_record_tmp" "$WORLD_RECORD"
  fakes_world_log_append "$(jq -c '{world:.}' "$WORLD_RECORD")"
  fakes_reap_stale_worlds

  # Isolated identity: HOME and git config.
  export HOME="$root/home"
  export GIT_CONFIG_GLOBAL="$root/gitconfig"
  export GIT_CONFIG_NOSYSTEM=1
  cat > "$GIT_CONFIG_GLOBAL" <<EOF
[user]
	name = journey
	email = journey@example.invalid
[init]
	defaultBranch = $base_branch
[advice]
	detachedHead = false
EOF

  mkdir -p "$(dirname "$FAKE_GH_ORIGIN")"
  git init -q --bare "$FAKE_GH_ORIGIN"
  git clone -q "$FAKE_GH_ORIGIN" "$FAKE_REPO_DIR" 2>/dev/null
  (
    cd "$FAKE_REPO_DIR"
    git checkout -q -b "$base_branch"
    printf '# journey fixture repo\n' > README.md
    printf 'features/*/\n.wavemill/\n.claude/\n.wavemill-config.local.json\n' > .gitignore
    mkdir -p features && : > features/.gitkeep
    git add -A
    git commit -q -m "initial commit"
    git push -q origin "$base_branch"
  )

  jq -n --arg repo "$slug" --arg base "$base_branch" \
    '{repo:$repo, defaultBranch:$base, nextPr:1, prs:{}, checks:{default:[{name:"ci",conclusion:"SUCCESS"}]}, requiredChecks:[], faults:[], headLag:{}}' \
    > "$FAKE_GH_STATE"
  jq -n '{issues:{}, transitions:[]}' > "$FAKE_LINEAR_STATE"

  export LINEAR_API_KEY="fake-linear-key"
  export NODE_OPTIONS="--import=$FAKES_DIR/linear-fetch-preload.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}"
  export PATH="$FAKES_DIR/bin:$PATH"
  unset TMUX TMUX_PANE GH_TOKEN GITHUB_TOKEN 2>/dev/null || true
}

fakes_require_tmux() {
  [[ -n "${FAKE_TMUX_REAL:-}" && -x "$FAKE_TMUX_REAL" ]]
}

# ── World lifetime (HOK-3329) ────────────────────────────────────────────────

# `ps -o lstart=` for one pid, or empty when the pid is gone. Recorded at
# fakes_setup and compared verbatim, so a reused pid never looks like the owner.
fakes_pid_start_time() {
  ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//' || true
}

# A world is owned while its owner pid is alive with the recorded start time.
fakes_world_owner_alive() {
  local owner="$1" start="$2" now
  [[ "$owner" =~ ^[0-9]+$ && -n "$start" ]] || return 1
  now="$(fakes_pid_start_time "$owner")"
  [[ -n "$now" && "$now" == "$start" ]]
}

# Optional JSONL of every world and pgid created under FAKES_WORLD_LOG, so a
# runner (run-journeys.sh) can assert its own worlds left nothing behind after
# the records themselves are gone. Unset = no-op.
fakes_world_log_append() {
  [[ -n "${FAKES_WORLD_LOG:-}" ]] || return 0
  printf '%s\n' "$1" >> "$FAKES_WORLD_LOG"
}

# Spawn a long-lived child inside the world: it gets its own process group, and
# the pgid is appended to the world record so fakes_teardown_world can reach
# every descendant with one signal per group — even after the owner's EXIT trap
# is gone. Sets FAKES_LAST_SPAWN_PID in the caller's shell (call it directly,
# not in $(...), so the caller's redirections apply to the child and the
# variable survives).
fakes_spawn() {
  local record="${WORLD_RECORD:?fakes_spawn: WORLD_RECORD not set; call fakes_setup first}"
  local pid pgid tmp
  set -m
  "$@" &
  pid=$!
  set +m
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  [[ "$pgid" =~ ^[0-9]+$ ]] || { echo "fakes_spawn: could not read pgid for pid=$pid" >&2; return 1; }
  tmp="$record.tmp.$$"
  jq --argjson pgid "$pgid" '.pgids += [$pgid]' "$record" > "$tmp" && mv "$tmp" "$record"
  fakes_world_log_append "$(jq -nc --arg id "$WORLD_ID" --argjson pgid "$pgid" '{id:$id, pgid:$pgid}')"
  # shellcheck disable=SC2034  # read by callers
  FAKES_LAST_SPAWN_PID="$pid"
}

# Start the world's private tmux server. Its first window runs the owner
# watcher (world-watcher.sh), which is both what keeps the server up and what
# tears the world down when the owner dies untrapped: the server daemonizes,
# so it outlives any signal aimed at the owner or the owner's process group.
# Args: session name, start directory, optional window name (default "mill").
fakes_start_world_host() {
  local session="${1:?session required}" cwd="${2:?start directory required}" window="${3:-mill}"
  : "${WORLD_RECORD:?fakes_start_world_host: call fakes_setup first}"
  fakes_require_tmux || { echo "fakes_start_world_host: no real tmux" >&2; return 1; }
  "$FAKE_TMUX_REAL" -S "$FAKE_TMUX_SOCK" new-session -d -s "$session" -n "$window" -c "$cwd" \
    "exec bash $(printf '%q' "$FAKES_DIR/world-watcher.sh") $(printf '%q' "$WORLD_RECORD") $WORLD_OWNER_PID $(printf '%q' "$WORLD_OWNER_START")"
}

# Tear down one world: kill every registered pgid (TERM then KILL), stop the
# world's private tmux server, and remove the socket, world dir and record.
# The one teardown, called by the owner's EXIT trap (fakes_teardown), the owner
# watcher and the startup reaper. Idempotent: safe to re-run after a
# half-finished teardown.
fakes_teardown_world() {
  local record="${1:?record required}"
  [[ -f "$record" ]] || return 0
  local sock world pgid pgids real_tmux
  sock="$(jq -r '.tmuxSocket // ""' "$record" 2>/dev/null || true)"
  world="$(jq -r '.worldDir // ""' "$record" 2>/dev/null || true)"
  pgids="$(jq -r '.pgids[]? // empty' "$record" 2>/dev/null || true)"
  if [[ -n "$pgids" ]]; then
    for pgid in $pgids; do
      [[ "$pgid" =~ ^[0-9]+$ ]] && kill -TERM -- "-$pgid" 2>/dev/null || true
    done
    sleep 0.3
    for pgid in $pgids; do
      [[ "$pgid" =~ ^[0-9]+$ ]] && kill -KILL -- "-$pgid" 2>/dev/null || true
    done
  fi
  if [[ -n "$sock" ]]; then
    real_tmux="${FAKE_TMUX_REAL:-$(term_resolve_real_tmux 2>/dev/null || true)}"
    if [[ -n "$real_tmux" && -S "$sock" ]]; then
      "$real_tmux" -S "$sock" kill-server >/dev/null 2>&1 || true
    fi
    rm -f "$sock"
  fi
  if [[ "${JOURNEY_KEEP_TMP:-0}" != "1" && -n "$world" && -d "$world" ]]; then
    rm -rf "$world"
  fi
  rm -f "$record"
}

# EXIT-trap fast path: tear down this shell's own world.
fakes_teardown() {
  [[ -n "${WORLD_RECORD:-}" ]] || return 0
  fakes_teardown_world "$WORLD_RECORD"
}

# A journey dir from before world records has no live owner when its monitor
# was reparented to pid 1 (the owner shell died), or, with no monitor at all,
# when it is older than FAKES_LEGACY_SWEEP_MINUTES (the age keeps a dir created
# a moment before its own fakes_setup safe).
fakes_legacy_world_orphaned() {
  local dir="$1" pid ppid monitors
  monitors="$(pgrep -f -- "$dir/monitor.env" 2>/dev/null || true)"
  if [[ -n "$monitors" ]]; then
    for pid in $monitors; do
      ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
      [[ -z "$ppid" || "$ppid" == "1" ]] || return 1
    done
    return 0
  fi
  [[ -n "$(find "$dir" -maxdepth 0 -mmin "+$FAKES_LEGACY_SWEEP_MINUTES" 2>/dev/null)" ]]
}

# Backstop reaper: tear down every recorded world whose owner is gone (the
# watcher itself was killed, or the host rebooted). Runs at the start of every
# fakes_setup and run-journeys.sh. Also sweeps worlds leaked before records
# existed: /tmp/wmfake-<pid>-*.sock servers whose pid is dead, and unclaimed
# ${TMPDIR}/journey-* dirs with no live owner, together with any process still
# running out of them.
fakes_reap_stale_worlds() {
  install -d -m 700 "$FAKES_WORLDS_DIR"
  local record owner start
  for record in "$FAKES_WORLDS_DIR"/*.json; do
    [[ -f "$record" ]] || continue
    owner="$(jq -r '.ownerPid // empty' "$record" 2>/dev/null || true)"
    start="$(jq -r '.ownerStartTime // empty' "$record" 2>/dev/null || true)"
    fakes_world_owner_alive "$owner" "$start" || fakes_teardown_world "$record"
  done

  local sock pid real_tmux
  real_tmux="${FAKE_TMUX_REAL:-$(term_resolve_real_tmux 2>/dev/null || true)}"
  for sock in /tmp/wmfake-*.sock; do
    [[ -e "$sock" ]] || continue
    pid="${sock##*/wmfake-}"; pid="${pid%%-*}"
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    kill -0 "$pid" 2>/dev/null && continue
    if [[ -n "$real_tmux" && -S "$sock" ]]; then
      "$real_tmux" -S "$sock" kill-server >/dev/null 2>&1 || true
    fi
    rm -f "$sock"
  done

  local world_dir
  for world_dir in "${TMPDIR:-/tmp}"/journey-*; do
    [[ -d "$world_dir" ]] || continue
    # Records store canonical paths (/tmp and $TMPDIR are symlinks on macOS).
    world_dir="$(cd "$world_dir" && pwd -P)" || continue
    if jq -s --arg wd "$world_dir" 'any(.[]; .worldDir == $wd or (.worldDir | startswith($wd + "/")))' \
         "$FAKES_WORLDS_DIR"/*.json 2>/dev/null | grep -qx true; then
      continue
    fi
    fakes_legacy_world_orphaned "$world_dir" || continue
    pkill -KILL -f -- "$world_dir/" 2>/dev/null || true
    rm -rf "$world_dir"
  done
}

# Push a new branch to the fake origin (e.g. the integration branch).
fakes_origin_branch() {
  local branch="$1" from="${2:-main}"
  git --git-dir "$FAKE_GH_ORIGIN" update-ref "refs/heads/$branch" "refs/heads/$from"
  git -C "$FAKE_REPO_DIR" fetch -q origin
}

# Land a commit on <branch> of the fake origin, as another contributor would:
# from a separate scratch clone, never from $FAKE_REPO_DIR (production code
# may be running against that checkout).
fakes_repo_commit() {
  local branch="$1" path="$2" content="$3" message="${4:-fixture change}"
  local clone="$FAKE_ROOT/contributor-clone"
  [[ -d "$clone/.git" ]] || git clone -q "$FAKE_GH_ORIGIN" "$clone"
  (
    cd "$clone"
    git fetch -q origin
    git checkout -q -B "$branch" "origin/$branch"
    mkdir -p "$(dirname "$path")"
    printf '%s\n' "$content" > "$path"
    git add "$path"
    git commit -q -m "$message"
    git push -q origin "$branch"
  )
}

# Mutate the gh fake's state file with a jq program (args after the program
# are passed through to jq, e.g. --arg).
fakes_gh_state() {
  local program="$1"; shift
  local tmp="$FAKE_GH_STATE.tmp.$$"
  jq "$@" "$program" "$FAKE_GH_STATE" > "$tmp" && mv "$tmp" "$FAKE_GH_STATE"
}

fakes_linear_add_issue() {
  local identifier="$1" title="$2" state="${3:-Todo}" project="${4:-}"
  local tmp="$FAKE_LINEAR_STATE.tmp.$$"
  jq --arg id "$identifier" --arg title "$title" --arg state "$state" --arg project "$project" \
    '.issues[$id] = {identifier:$id, title:$title, description:("Journey fixture issue " + $id), state:$state}
     + (if $project == "" then {} else {project:$project} end)' \
    "$FAKE_LINEAR_STATE" > "$tmp" && mv "$tmp" "$FAKE_LINEAR_STATE"
}

# Seed an issue from a JSON file ({identifier, title, description, state?,
# project?}) — e.g. a sanitised incident fixture whose description is already
# a detailed task packet.
fakes_linear_add_issue_from_file() {
  local file="$1"
  local tmp="$FAKE_LINEAR_STATE.tmp.$$"
  jq --slurpfile issue "$file" '
      ($issue[0]) as $i
      | .issues[$i.identifier] = ({identifier: $i.identifier, title: $i.title, description: ($i.description // ""), state: ($i.state // "Todo")}
          + (if ($i.project // "") == "" then {} else {project: $i.project} end))' \
    "$FAKE_LINEAR_STATE" > "$tmp" && mv "$tmp" "$FAKE_LINEAR_STATE"
}

fakes_linear_state_of() {
  jq -r --arg id "$1" '.issues[$id].state // empty' "$FAKE_LINEAR_STATE"
}

fakes_gh_pr_field() {
  local number="$1" field="$2"
  jq -r --arg n "$number" --arg f "$field" '.prs[$n][$f] // empty | if type == "array" then join(",") else . end' "$FAKE_GH_STATE"
}
