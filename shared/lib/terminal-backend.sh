#!/usr/bin/env bash
# HOK-3293 — terminal backend seam. The one module that talks to the terminal
# host (today: tmux). TS twin: shared/lib/terminal-backend.ts. Contract:
# docs/terminal-backends.md.
#
# The seam is capability-shaped, not tmux-shaped. A backend declares which of
# these it supports and every operation is refused (exit 3, typed stderr
# reason) when its capability is missing, never silently skipped:
#
#   host         run a process in a named slot that outlives the controller
#   exit         learn whether that process exited, and with what code
#   inspect      process facts: pid, foreground command, cwd, start command,
#                title, tty
#   capture      read recent output (screen or log tail)
#   input        type literal text or keys into an interactive program
#   attach       let a human view or attach
#   session-env  session-scoped key/value visible to later launches
#
# Handles are opaque. Callers pass back what an operation printed (or a
# session plus window name through term_window_handle) and never parse or
# build one themselves.
#
# tmux is always invoked by command name, never by absolute path: tests stub
# `tmux()` as a bash function and must keep intercepting through the seam.
#
# There is deliberately no backend selector yet and no "run arbitrary tmux"
# escape hatch; the only tmux-specific helper is term_tmux_socket_path, which
# the agent tmux guard needs and other backends will never provide.

_TERM_BACKEND_ID="tmux"
_TERM_BACKEND_CAPABILITIES=(host exit inspect capture input attach session-env)

# ── Capability metadata ──────────────────────────────────────────────────────

# Print the active backend id.
term_backend() {
  printf '%s\n' "$_TERM_BACKEND_ID"
}

# Print the capabilities the active backend supports, one per line.
term_capabilities() {
  printf '%s\n' "${_TERM_BACKEND_CAPABILITIES[@]}"
}

# Return 0 iff the active backend supports <capability>.
term_has() {
  local wanted="${1:-}" cap
  for cap in "${_TERM_BACKEND_CAPABILITIES[@]}"; do
    [[ "$cap" == "$wanted" ]] && return 0
  done
  return 1
}

# Fail with a typed reason unless the backend supports <capability>. Callers
# that depend on a capability (prompt delivery needs `input`) check here
# instead of assuming the backend can do it.
term_require_capability() {
  local capability="${1:?capability required}" reason="${2:-unspecified}"
  term_has "$capability" && return 0
  printf 'terminal-backend: missing capability=%s backend=%s reason=%s\n' \
    "$capability" "$_TERM_BACKEND_ID" "$reason" >&2
  return 3
}

# Route <op> to the active backend's implementation after checking that the
# backend declares <capability>.
_term_dispatch() {
  local capability="$1" op="$2"
  shift 2
  term_require_capability "$capability" "$op" || return
  case "$_TERM_BACKEND_ID" in
    tmux) "_term_tmux_${op}" "$@" ;;
    *)
      printf 'terminal-backend: unknown backend=%s\n' "$_TERM_BACKEND_ID" >&2
      return 3
      ;;
  esac
}

# ── host ─────────────────────────────────────────────────────────────────────

# term_new_session <session> [--window <name>] [--cwd <dir>] [-- <cmd>...]
# Create a detached session whose first slot runs <cmd> (default: a shell).
term_new_session() { _term_dispatch host new_session "$@"; }

# term_new_window <session> <name> [--cwd <dir>] [--print-handle] [-- <cmd>...]
# Create a background slot in <session>. --print-handle prints its handle.
term_new_window() { _term_dispatch host new_window "$@"; }

# term_split <handle> [--horizontal|--vertical] [--full] [--percent <n>]
#            [--cwd <dir>] [--print-handle] [-- <cmd>...]
# Split the slot at <handle> and run <cmd> in the new half.
term_split() { _term_dispatch host split "$@"; }

# term_list_sessions — print session names, one per line.
term_list_sessions() { _term_dispatch host list_sessions "$@"; }

# term_list_windows <session> — print "<handle>|<name>" per slot in <session>.
term_list_windows() { _term_dispatch host list_windows "$@"; }

# term_list_panes [<handle>|--all] — print one pane handle per line.
term_list_panes() { _term_dispatch host list_panes "$@"; }

# term_kill_session <session> / term_kill_window <handle> / term_kill_pane <handle>
term_kill_session() { _term_dispatch host kill_session "$@"; }
term_kill_window() { _term_dispatch host kill_window "$@"; }
term_kill_pane() { _term_dispatch host kill_pane "$@"; }

# term_respawn <handle> [--kill] [--cwd <dir>] [-- <cmd>...]
# Restart the slot's process in place; --kill replaces a still-live process.
term_respawn() { _term_dispatch host respawn "$@"; }

# term_window_handle <session> <window-name-or-handle>
# Print the handle for a window of <session>; handles pass through unchanged.
term_window_handle() { _term_dispatch host window_handle "$@"; }

# term_window_exists <session> <handle> [<expected_path>]
# Return 0 iff <handle> is a live slot of <session> (and, with
# <expected_path>, its cwd resolves to that path, or the slot has exited).
term_window_exists() { _term_dispatch host window_exists "$@"; }

# term_task_window_target <session> <issue> <slug> [<state_file>] [<worktree>]
# Print the handle of the task's window: the recorded windowId, then a
# renamed title, then the canonical "<issue>-<slug>" name, then any window
# whose cwd is <worktree>. Returns 1 when none is live.
term_task_window_target() { _term_dispatch host task_window_target "$@"; }

# ── exit ─────────────────────────────────────────────────────────────────────

# term_is_dead <handle> — 0 when the process exited, 1 when it is still
# running, 2 when the slot cannot be read.
term_is_dead() { _term_dispatch exit is_dead "$@"; }

# term_exit_code <handle> — print the exit status of an exited process;
# returns 1 while it is still running or cannot be read.
term_exit_code() { _term_dispatch exit exit_code "$@"; }

# ── inspect ──────────────────────────────────────────────────────────────────

# term_pane_field <handle> pid|current_command|current_path|start_command|title|tty|dead
term_pane_field() { _term_dispatch inspect pane_field "$@"; }

# term_pane_fields <handle> <field>... — one snapshot, values joined by "|".
term_pane_fields() { _term_dispatch inspect pane_fields "$@"; }

# ── capture ──────────────────────────────────────────────────────────────────

# term_capture <handle> [<lines>] — print recent output; <lines> extends the
# read that many lines back into history.
term_capture() { _term_dispatch capture capture "$@"; }

# ── input ────────────────────────────────────────────────────────────────────

# term_send_text <handle> <text> — type <text> literally (no key parsing).
term_send_text() { _term_dispatch input send_text "$@"; }

# term_send_key <handle> <key>... — press named keys (Enter, C-m, C-c, Escape).
term_send_key() { _term_dispatch input send_key "$@"; }

# ── attach ───────────────────────────────────────────────────────────────────

# term_attach <session> — attach the current terminal to <session>.
term_attach() { _term_dispatch attach attach "$@"; }

# term_refresh_client — redraw attached viewers (status line included).
term_refresh_client() { _term_dispatch attach refresh_client "$@"; }

# term_set_title <handle> <title> — label the slot for human viewers.
term_set_title() { _term_dispatch attach set_title "$@"; }

# ── session-env ──────────────────────────────────────────────────────────────

# term_session_env_get <session> [<name>] — print the value of <name>, or
# every "NAME=value" pair when <name> is omitted. Returns 1 when unset.
term_session_env_get() { _term_dispatch session-env session_env_get "$@"; }

# term_session_env_set <session> <name> <value>
term_session_env_set() { _term_dispatch session-env session_env_set "$@"; }

# ── tmux-only helper ─────────────────────────────────────────────────────────

# term_tmux_socket_path <handle> — the tmux server socket hosting <handle>.
# Used only by the agent tmux guard; no other backend will provide it.
term_tmux_socket_path() {
  local target="${1:?handle required}"
  tmux display-message -p -t "$target" '#{socket_path}'
}

# ── tmux backend ─────────────────────────────────────────────────────────────

# Map an inspect field name to its tmux format token.
_term_tmux_field_format() {
  case "$1" in
    pid) printf '#{pane_pid}' ;;
    current_command) printf '#{pane_current_command}' ;;
    current_path) printf '#{pane_current_path}' ;;
    start_command) printf '#{pane_start_command}' ;;
    title) printf '#{pane_title}' ;;
    tty) printf '#{pane_tty}' ;;
    dead) printf '#{pane_dead}' ;;
    *)
      printf 'terminal-backend: unknown pane field=%s\n' "$1" >&2
      return 2
      ;;
  esac
}

_term_tmux_new_session() {
  local session="${1:?session required}"
  shift
  local -a args=(new-session -d -s "$session")
  while (($#)); do
    case "$1" in
      --window) args+=(-n "$2"); shift 2 ;;
      --cwd) args+=(-c "$2"); shift 2 ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  tmux "${args[@]}" "$@"
}

_term_tmux_new_window() {
  local session="${1:?session required}" name="${2:?window name required}"
  shift 2
  local -a args=(new-window -d -t "$session" -n "$name")
  while (($#)); do
    case "$1" in
      --cwd) args+=(-c "$2"); shift 2 ;;
      --print-handle) args+=(-P -F '#{window_id}'); shift ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  tmux "${args[@]}" "$@"
}

_term_tmux_split() {
  local target="${1:?handle required}"
  shift
  local -a args=(split-window -t "$target")
  while (($#)); do
    case "$1" in
      --horizontal) args+=(-h); shift ;;
      --vertical) args+=(-v); shift ;;
      --full) args+=(-f); shift ;;
      --percent) args+=(-p "$2"); shift 2 ;;
      --cwd) args+=(-c "$2"); shift 2 ;;
      --print-handle) args+=(-P -F '#{pane_id}'); shift ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  tmux "${args[@]}" "$@"
}

_term_tmux_list_sessions() {
  tmux list-sessions -F '#{session_name}'
}

_term_tmux_list_windows() {
  local session="${1:?session required}"
  tmux list-windows -t "$session" -F '#{window_id}|#{window_name}'
}

_term_tmux_list_panes() {
  local scope="${1:---all}"
  if [[ "$scope" == "--all" ]]; then
    tmux list-panes -a -F '#{pane_id}'
  else
    tmux list-panes -t "$scope" -F '#{pane_id}'
  fi
}

_term_tmux_kill_session() {
  tmux kill-session -t "${1:?session required}"
}

_term_tmux_kill_window() {
  tmux kill-window -t "${1:?handle required}"
}

_term_tmux_kill_pane() {
  tmux kill-pane -t "${1:?handle required}"
}

_term_tmux_respawn() {
  local target="${1:?handle required}"
  shift
  local -a args=(respawn-pane)
  if [[ "${1:-}" == "--kill" ]]; then
    args+=(-k)
    shift
  fi
  args+=(-t "$target")
  while (($#)); do
    case "$1" in
      --cwd) args+=(-c "$2"); shift 2 ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  tmux "${args[@]}" "$@"
}

_term_tmux_window_handle() {
  local session="$1" target="$2"
  [[ -n "$target" ]] || return 1
  case "$target" in
    @*|*:*) printf '%s\n' "$target" ;;
    *) printf '%s:%s\n' "$session" "$target" ;;
  esac
}

_term_tmux_window_exists() {
  local session="$1" target="$2" expected_path="${3:-}"
  local target_session target_path expected_real target_real pane_dead

  [[ -n "$session" && -n "$target" ]] || return 1
  target_session="$(tmux display-message -p -t "$target" '#{session_name}' 2>/dev/null || true)"
  [[ "$target_session" == "$session" ]] || return 1
  if [[ -n "$expected_path" ]]; then
    target_path="$(tmux display-message -p -t "$target" '#{pane_current_path}' 2>/dev/null || true)"
    if [[ -z "$target_path" ]]; then
      pane_dead="$(tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | head -1 || true)"
      [[ "$pane_dead" == "1" ]] && return 0
      return 1
    fi
    expected_real="$(cd -P "$expected_path" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$expected_path")"
    target_real="$(cd -P "$target_path" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$target_path")"
    [[ "$target_real" == "$expected_real" ]] || return 1
  fi
  return 0
}

_term_tmux_task_window_target() {
  local session="$1" issue="$2" slug="$3" state_file="${4:-${STATE_FILE:-}}" wt_dir="${5:-}"
  local stored_target="" canonical target issue_number renamed_target

  if [[ -n "$state_file" && -f "$state_file" ]]; then
    stored_target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$state_file" 2>/dev/null || true)"
  fi
  if _term_tmux_window_exists "$session" "$stored_target" "$wt_dir"; then
    printf '%s\n' "$stored_target"
    return 0
  fi

  issue_number="${issue##*-}"
  renamed_target="$(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null \
    | awk -F'|' -v issue="$issue" -v issue_number="$issue_number" -v slug="$slug" '
        index($2, issue_number " · " slug " ·") == 1 { print $1; exit }
        index($2, issue_number " · " slug) == 1 { print $1; exit }
        index($2, issue " · " slug " ·") == 1 { print $1; exit }
        index($2, issue " · " slug) == 1 { print $1; exit }
      ')"
  if _term_tmux_window_exists "$session" "$renamed_target" "$wt_dir"; then
    printf '%s\n' "$renamed_target"
    return 0
  fi

  canonical="${issue}-${slug}"
  target="$(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null \
    | awk -F'|' -v name="$canonical" '$2 == name { print $1; exit }')"
  if _term_tmux_window_exists "$session" "$target" "$wt_dir"; then
    printf '%s\n' "$target"
    return 0
  fi

  if [[ -n "$wt_dir" ]]; then
    while IFS='|' read -r target _name; do
      [[ -n "$target" ]] || continue
      if _term_tmux_window_exists "$session" "$target" "$wt_dir"; then
        printf '%s\n' "$target"
        return 0
      fi
    done < <(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null || true)
  fi

  return 1
}

_term_tmux_is_dead() {
  local target="${1:?handle required}" dead
  dead="$(tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | head -1 || true)"
  case "$dead" in
    1) return 0 ;;
    0) return 1 ;;
    *) return 2 ;;
  esac
}

_term_tmux_exit_code() {
  local target="${1:?handle required}" row
  row="$(tmux list-panes -t "$target" -F '#{pane_dead}:#{pane_dead_status}' 2>/dev/null | head -1 || true)"
  [[ "$row" == 1:* && -n "${row#1:}" ]] || return 1
  printf '%s\n' "${row#1:}"
}

_term_tmux_pane_field() {
  local target="${1:?handle required}" field="${2:?field required}" format
  format="$(_term_tmux_field_format "$field")" || return
  tmux display-message -p -t "$target" "$format"
}

_term_tmux_pane_fields() {
  local target="${1:?handle required}" format="" field token
  shift
  (($#)) || { printf 'terminal-backend: pane fields required\n' >&2; return 2; }
  for field in "$@"; do
    token="$(_term_tmux_field_format "$field")" || return
    format+="${format:+|}$token"
  done
  tmux display-message -p -t "$target" "$format"
}

_term_tmux_capture() {
  local target="${1:?handle required}" lines="${2:-}"
  if [[ -n "$lines" ]]; then
    tmux capture-pane -p -t "$target" -S "-$lines"
  else
    tmux capture-pane -p -t "$target"
  fi
}

_term_tmux_send_text() {
  tmux send-keys -t "${1:?handle required}" -l -- "${2-}"
}

_term_tmux_send_key() {
  local target="${1:?handle required}"
  shift
  (($#)) || { printf 'terminal-backend: key required\n' >&2; return 2; }
  tmux send-keys -t "$target" "$@"
}

_term_tmux_attach() {
  tmux attach -t "${1:?session required}"
}

_term_tmux_refresh_client() {
  tmux refresh-client -S
}

_term_tmux_set_title() {
  local target="${1:?handle required}" title="${2:?title required}"
  tmux select-pane -t "$target" -T "$title"
}

_term_tmux_session_env_get() {
  local session="${1:?session required}" name="${2:-}" line
  if [[ -z "$name" ]]; then
    tmux show-environment -t "$session" | grep -v '^-' || true
    return 0
  fi
  line="$(tmux show-environment -t "$session" "$name" 2>/dev/null)" || return 1
  [[ "$line" == "$name="* ]] || return 1
  printf '%s\n' "${line#"$name="}"
}

_term_tmux_session_env_set() {
  local session="${1:?session required}" name="${2:?name required}"
  tmux set-environment -t "$session" "$name" "${3-}"
}

# ── Legacy names (remove once the shell call-site migrations land) ───────────

wavemill_set_tmux_pane_title() {
  term_set_title "$@" >/dev/null 2>&1
}

_tmux_window_target_exists() { term_window_exists "$@"; }
_tmux_target_join() { term_window_handle "$@"; }
_tmux_task_window_target() { term_task_window_target "$@"; }
