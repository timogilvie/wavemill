# Terminal backends

Wavemill runs every agent, control pane and backstage loop inside a terminal
host. All interaction with that host goes through one seam:

| Side | Module |
|------|--------|
| Shell | `shared/lib/terminal-backend.sh` (sourced by `wavemill-common.sh`) |
| TypeScript | `shared/lib/terminal-backend.ts` |

This page is the contract. The tmux backend implements it today; the Rex and
headless backends must implement it too. Introduced in HOK-3293.

## Rules

- **Capabilities, not commands.** A backend declares the capabilities below
  that it supports. `term_capabilities` / `termCapabilities()` lists them and
  `term_has <cap>` / `termHas(cap)` checks one. The tmux backend declares all
  seven.
- **Missing capability is a typed failure.** Every operation checks its
  capability first. Shell operations exit `3` with
  `terminal-backend: missing capability=<cap> backend=<id> reason=<op>` on
  stderr; TS operations throw `TerminalCapabilityError` (`capability`,
  `reason`, `backend`). A caller that depends on a capability (prompt
  delivery, pane messages, `claude --resume`, teardown key sequences all need
  `input`) calls `term_require_capability` / `termRequireCapability` with its
  own reason rather than silently doing nothing.
- **Handles are opaque.** An operation that creates or lists a slot returns a
  handle; callers pass it back unchanged and never parse or build one. The
  only ways to get a handle without creating a slot are `term_window_handle`
  / `termWindowHandle` (session plus window name) and `termPaneHandle`
  (coordinates from a listed pane). The tmux backend uses `session:window`,
  `@id` and `%id` internally; nothing outside the seam may depend on that.
- **Small surface.** There is no "run arbitrary backend command" escape hatch.
  A new need gets a new operation under the right capability.
- **tmux by name.** The tmux backend invokes `tmux …`, never an absolute path,
  so tests that stub `tmux()` as a bash function (or put a fake `tmux` on
  `PATH`) intercept through the seam.

## Capabilities

### `host`

Run a process in a named slot that survives controller and monitor restarts,
and address it later through a stable handle.

| Shell | TS |
|-------|----|
| `term_new_session <session> [--window <name>] [--cwd <dir>] [-- <cmd>…]` | `termNewSession` |
| `term_new_window <session> <name> [--cwd <dir>] [--print-handle] [-- <cmd>…]` | `termNewWindow` (returns the handle) |
| `term_split <handle> [--horizontal\|--vertical] [--full] [--percent <n>] [--cwd <dir>] [--print-handle] [-- <cmd>…]` | `termSplit` (returns the handle) |
| `term_list_sessions` | `termListSessions` |
| `term_list_windows <session>` (`<handle>\|<name>` lines) | `termListWindows` |
| `term_list_panes [<handle>\|--all]` | `termListPanes` (structured rows) |
| `term_kill_session`, `term_kill_window`, `term_kill_pane` | `termKillSession`, `termKillWindow`, `termKillPane` |
| `term_respawn <handle> [--kill] [--cwd <dir>] [-- <cmd>…]` | `termRespawn` |
| `term_window_handle <session> <name-or-handle>` | `termWindowHandle` |
| `term_window_exists <session> <handle> [<expected_path>]` | — |
| `term_task_window_target <session> <issue> <slug> [<state_file>] [<worktree>]` | — |

Invariants: a slot outlives the process that created it; `term_window_exists`
is true only for a slot of the named session, and with `<expected_path>` only
when the slot's cwd resolves to it (or the slot's process has exited);
`term_task_window_target` resolves the recorded `windowId` first, then a
renamed title, then the canonical `<issue>-<slug>` name, then any window whose
cwd is the worktree.

### `exit`

Learn whether the slot's process has exited and with what code, without
polling heuristics.

| Shell | TS |
|-------|----|
| `term_is_dead <handle>` — 0 exited, 1 running, 2 unreadable | `termIsDead` — `true` / `false` / `null` |
| `term_exit_code <handle>` — prints the status; fails while running | `termExitCode` — number or `null` |

### `inspect`

Process facts about a slot: `pid`, `current_command` (foreground program),
`current_path` (cwd), `start_command`, `title`, `tty`, plus `dead`.

| Shell | TS |
|-------|----|
| `term_pane_field <handle> <field>` | `termPaneField` |
| `term_pane_fields <handle> <field>…` — one snapshot, values joined by `\|` | `termPaneFields`, `termPaneFieldsAsync` (record keyed by field) |

Invariant: `term_pane_fields` reads every field from the same instant.

### `capture`

Read the slot's recent output. This is "recent output", not "the screen": a
backend may serve it from a log tail.

| Shell | TS |
|-------|----|
| `term_capture <handle> [<lines>]` | `termCapture(handle, { lines })` — text or `null` |

Invariant: output is bounded; `<lines>` asks for that much history.

### `input`

Type literal text or press named keys in an interactive program.

| Shell | TS |
|-------|----|
| `term_send_text <handle> <text>` — literal, no key-name parsing | `termSendText` |
| `term_send_key <handle> <key>…` — `Enter`, `C-m`, `C-c`, `Escape`, … | `termSendKey` |

A backend without `input` (headless) cannot drive TUIs; callers must check.

### `attach`

Let a human view or attach to the work.

| Shell | TS |
|-------|----|
| `term_attach <session>` | — |
| `term_refresh_client` | `termRefreshClient` |
| `term_set_title <handle> <title>` | `termSetTitle` |

### `session-env`

Session-scoped key/value pairs visible to later launches in that session
(today: `WAVEMILL_DASHBOARD_PID`).

| Shell | TS |
|-------|----|
| `term_session_env_get <session> [<name>]` — value, or every `NAME=value` | `termSessionEnvGet`, `termSessionEnv` |
| `term_session_env_set <session> <name> <value>` | `termSessionEnvSet` |

## tmux-only helper

`term_tmux_socket_path <handle>` prints the tmux server socket hosting the
slot. Only the agent tmux guard uses it; other backends will not provide it.

## Adding a backend

1. Add the backend id to the dispatch `case` in `_term_dispatch` and implement
   `_term_<id>_<op>` for every operation of each capability it declares.
2. Mirror it in `terminal-backend.ts` (`TerminalBackendId`, the exec, and the
   argv/request builder).
3. Declare its capability subset and pin it in `tests/terminal-backend.test.sh`
   and `shared/lib/terminal-backend.test.ts`.
4. The backend selector (config key / env var) lands with the Rex prototype;
   until then tmux is the only arm.

## Legacy names

`_tmux_window_target_exists`, `_tmux_target_join`, `_tmux_task_window_target`
and `wavemill_set_tmux_pane_title` are thin aliases over the seam, kept for
one release while the shell call-site migrations land. New code calls the
`term_*` names.
