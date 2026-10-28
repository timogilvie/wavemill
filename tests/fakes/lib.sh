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

FAKES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAKES_INSTALL_DIR="$(cd "$FAKES_DIR/../.." && pwd)"

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
  mkdir -p "$root"/{home,logs,bin}
  root="$(cd "$root" && pwd -P)"


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
    FAKE_TMUX_REAL="$(PATH="$(fakes_path_without_fakes)" command -v tmux || true)"
  fi
  export FAKE_TMUX_REAL
  export FAKE_TMUX_SOCK="/tmp/wmfake-$$-$RANDOM.sock"

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

# PATH with tests/fakes/bin removed (to find the real binaries).
fakes_path_without_fakes() {
  local out="" part
  local IFS=:
  for part in $PATH; do
    [[ "$part" == "$FAKES_DIR/bin" ]] && continue
    out="${out:+$out:}$part"
  done
  printf '%s\n' "$out"
}

fakes_require_tmux() {
  [[ -n "${FAKE_TMUX_REAL:-}" && -x "$FAKE_TMUX_REAL" ]]
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

fakes_teardown() {
  if [[ -n "${FAKE_TMUX_SOCK:-}" && -n "${FAKE_TMUX_REAL:-}" ]]; then
    "$FAKE_TMUX_REAL" -S "$FAKE_TMUX_SOCK" kill-server >/dev/null 2>&1 || true
    rm -f "$FAKE_TMUX_SOCK"
  fi
}
