#!/usr/bin/env bash
# Shared harness for HOK-2950 incident regression fixtures.
#
# Builds an isolated workspace (bare origin + real clone, isolated tmux
# server, PATH-shimmed gh/npx, a git remote-call counter) and drives the
# REAL `monitor_issue_state` controller function (extracted from
# shared/lib/wavemill-monitor.sh) plus the real `tools/observer.ts` and
# `shared/lib/wavemill-status.sh` against it, so fixtures exercise the
# actual production decision logic instead of a re-implementation of it.
#
# Every scenario driver sources this file, calls incident_scenario_new,
# builds its own git/tmux/PR topology with real commands, then calls
# run_monitor_tick / run_observer_pass / dashboard_task_is_active.
set -euo pipefail

INCIDENT_HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INCIDENT_REPO_DIR="$(cd "$INCIDENT_HARNESS_DIR/../.." && pwd)"

INCIDENT_COMMON_SCRIPT="$INCIDENT_REPO_DIR/shared/lib/wavemill-common.sh"
INCIDENT_MONITOR_SCRIPT="$INCIDENT_REPO_DIR/shared/lib/wavemill-monitor.sh"
INCIDENT_MILL_SCRIPT="$INCIDENT_REPO_DIR/shared/lib/wavemill-mill.sh"
INCIDENT_TERMINAL_RECONCILER_SCRIPT="$INCIDENT_REPO_DIR/shared/lib/terminal-reconciler.sh"
INCIDENT_TRANSIENT_MARKER_SCRIPT="$INCIDENT_REPO_DIR/shared/lib/transient-marker.sh"
INCIDENT_QUEUE_HEALTH_SCRIPT="$INCIDENT_REPO_DIR/shared/lib/queue-health.sh"
INCIDENT_AGENT_ADAPTERS_SCRIPT="$INCIDENT_REPO_DIR/shared/lib/agent-adapters.sh"
INCIDENT_STATUS_SCRIPT="$INCIDENT_REPO_DIR/shared/lib/wavemill-status.sh"

# Would-be cache slot for the extracted controller functions. In practice
# every caller (run_monitor_tick) is invoked through a `$(...)` command
# substitution, so a fork-local write here never survives back to this
# variable in the parent shell - each tick rebuilds the library fresh. See
# the cleanup at the end of run_monitor_tick, which relies on that same fact
# to avoid leaking one temp directory per tick.
INCIDENT_MONITOR_LIB_CACHE=""

# Portable millisecond clock: prefers bash 5's $EPOCHREALTIME (seconds with
# microsecond precision, no external process) over `date +%s%3N`, which is a
# GNU-only extension and silently misbehaves under BSD/macOS date.
incident_now_ms() {
  local t="${EPOCHREALTIME:-}"
  if [[ "$t" == *.* ]]; then
    local sec="${t%%.*}" frac="${t#*.}"
    frac="${frac}000"
    frac="${frac:0:3}"
    printf '%d%03d\n' "$sec" "$((10#$frac))"
  else
    printf '%d000\n' "$(date +%s)"
  fi
}

incident_harness_note() {
  printf 'INCIDENT-HARNESS: %s\n' "$*" >&2
}

incident_harness_skip() {
  printf 'SKIP: %s\n' "$*"
  exit 0
}

incident_harness_require_tools() {
  local missing=()
  for tool in jq git npx node; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if [[ "${#missing[@]}" -gt 0 ]]; then
    incident_harness_skip "required tool(s) unavailable: ${missing[*]}"
  fi
}

# --- Function extraction ----------------------------------------------------
#
# Both helpers strip comments before counting braces so that an apostrophe in
# a comment (e.g. "don't") never desynchronizes the single-quote span
# stripper. This mirrors the brace-delta technique already used by
# tests/safe-branch-cleanup.test.sh, generalized to (a) a single named
# function and (b) every top-level function in a file, so the harness never
# has to hand-maintain a list of monitor_issue_state's transitive callees.
extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    function strip(line,   s) {
      s = line
      # Only a `#` preceded by whitespace or at line-start starts a comment;
      # `${var#pattern}` / `${var##pattern}` put `#` directly after an
      # identifier or `}` with no preceding whitespace, so this never
      # mistakes a parameter-expansion operator for a comment (which would
      # otherwise truncate the line and desync the brace count - this is
      # what broke on the log function body, which strips leading
      # whitespace via a `${msg#"${msg%%[![:space:]]*}"}` expansion).
      gsub(/(^|[[:space:]])#.*/, "", s)
      gsub(/"([^"\\]|\\.)*"/, "\"\"", s)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", s)
      return s
    }
    function brace_delta(line,   s, opens, closes) {
      s = strip(line)
      opens = gsub(/\{/, "{", s)
      closes = gsub(/\}/, "}", s)
      return opens - closes
    }
    !capture && $0 ~ "^" name "\\(\\)[[:space:]]*\\{[[:space:]]*$" {
      capture = 1
      depth = 0
      print
      depth += brace_delta($0)
      if (depth <= 0) capture = 0
      next
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth <= 0) capture = 0
    }
  ' "$source_file"
}

extract_all_functions() {
  local source_file="$1"
  awk '
    function strip(line,   s) {
      s = line
      # Only a `#` preceded by whitespace or at line-start starts a comment;
      # `${var#pattern}` / `${var##pattern}` put `#` directly after an
      # identifier or `}` with no preceding whitespace, so this never
      # mistakes a parameter-expansion operator for a comment (which would
      # otherwise truncate the line and desync the brace count - this is
      # what broke on the log function body, which strips leading
      # whitespace via a `${msg#"${msg%%[![:space:]]*}"}` expansion).
      gsub(/(^|[[:space:]])#.*/, "", s)
      gsub(/"([^"\\]|\\.)*"/, "\"\"", s)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", s)
      return s
    }
    function brace_delta(line,   s, opens, closes) {
      s = strip(line)
      opens = gsub(/\{/, "{", s)
      closes = gsub(/\}/, "}", s)
      return opens - closes
    }
    !capture && /^[A-Za-z_][A-Za-z0-9_]*\(\)[[:space:]]*\{[[:space:]]*$/ {
      capture = 1
      depth = 0
      print
      depth += brace_delta($0)
      if (depth <= 0) capture = 0
      next
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth <= 0) capture = 0
    }
  ' "$source_file"
}

# Builds the sourceable controller library into a fresh temp directory
# (see run_monitor_tick's cleanup for why this is rebuilt, not cached, per
# call). Callers source common.sh etc. for real (already proven sourceable
# standalone by tests/terminal-reconciler.test.sh) and append every function
# defined in wavemill-monitor.sh, so whichever branch monitor_issue_state
# actually takes at runtime has real callees available - no hand-picked
# closure list to keep in sync with the 16k-line source file.
incident_build_monitor_lib() {
  if [[ -n "$INCIDENT_MONITOR_LIB_CACHE" && -f "$INCIDENT_MONITOR_LIB_CACHE" ]]; then
    printf '%s\n' "$INCIDENT_MONITOR_LIB_CACHE"
    return 0
  fi

  local lib_dir lib_file monitor_funcs
  lib_dir="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-incident-monitor-lib.XXXXXX")"
  lib_file="$lib_dir/monitor-lib.sh"
  monitor_funcs="$lib_dir/monitor-functions.sh"

  # wavemill-monitor.sh cannot be `source`d as a whole (its top and bottom
  # are an unguarded script body, not a library), so its functions are
  # extracted as literal text. None of them locate siblings via
  # BASH_SOURCE (only the script's own top-level bootstrap does, and that
  # is exactly what extraction strips out), so this is safe to inline.
  extract_all_functions "$INCIDENT_MONITOR_SCRIPT" > "$monitor_funcs"

  if ! bash -n "$monitor_funcs"; then
    incident_harness_note "extracted monitor functions failed bash -n syntax check: $monitor_funcs"
    return 1
  fi

  # A brace-counting extraction bug (an unbalanced line desyncing depth)
  # would still very likely produce syntactically valid bash by accident
  # (leaked top-level lines are usually simple assignments/conditionals),
  # so bash -n alone is not sufficient. Cross-check against a direct count
  # of function-start lines in the source: a desync either swallows several
  # legitimate function boundaries into one runaway capture (fewer distinct
  # top-level defines survive) or, in principle, could fail to close one at
  # all - both show up as a count that differs from the source.
  local source_count extracted_count
  source_count="$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*\(\)[[:space:]]*\{[[:space:]]*$' "$INCIDENT_MONITOR_SCRIPT")"
  extracted_count="$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*\(\)[[:space:]]*\{[[:space:]]*$' "$monitor_funcs")"
  if [[ "$extracted_count" -ne "$source_count" ]]; then
    incident_harness_note "monitor library extraction mismatch: source defines $source_count top-level functions, extracted $extracted_count - a brace-counting desync likely swallowed a function boundary"
    return 1
  fi

  {
    printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_DEFAULT=15'
    printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_MIN=1'
    printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_MAX=600'
    printf '\n'
    # Real `source` statements (not `cat` concatenation) so that files which
    # locate siblings via `dirname "${BASH_SOURCE[0]}"` (agent-adapters.sh ->
    # routing-emitter.sh, wavemill-common.sh -> bounded-retry.sh, etc.)
    # resolve against their real shared/lib location instead of this
    # generated temp file.
    printf 'source %q\n' "$INCIDENT_TRANSIENT_MARKER_SCRIPT"
    printf 'source %q\n' "$INCIDENT_COMMON_SCRIPT"
    printf 'source %q\n' "$INCIDENT_TERMINAL_RECONCILER_SCRIPT"
    printf 'source %q\n' "$INCIDENT_QUEUE_HEALTH_SCRIPT"
    printf 'source %q\n' "$INCIDENT_AGENT_ADAPTERS_SCRIPT"
    printf '\n'
    # execute() is defined beside monitor.sh in wavemill-mill.sh and exported
    # into the monitor subprocess in production; pull the single function in
    # rather than the whole mill script (which drives its own event loop).
    extract_function "$INCIDENT_MILL_SCRIPT" "execute"
    printf '\n'
    cat "$monitor_funcs"
  } > "$lib_file"

  if ! bash -n "$lib_file"; then
    incident_harness_note "assembled monitor library failed bash -n syntax check: $lib_file"
    return 1
  fi

  INCIDENT_MONITOR_LIB_CACHE="$lib_file"
  printf '%s\n' "$lib_file"
}

# --- Scenario workspace ------------------------------------------------------

incident_scenario_new() {
  local name="$1"
  SCENARIO_NAME="$name"
  SCENARIO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-incident-${name}.XXXXXX")"
  ORIGIN_DIR="$SCENARIO_DIR/origin.git"
  REPO_DIR="$SCENARIO_DIR/repo"
  WORKTREE_ROOT="$SCENARIO_DIR/worktrees"
  BIN_DIR="$SCENARIO_DIR/bin"
  GH_PR_DIR="$SCENARIO_DIR/gh/pr"
  STATE_FILE="$REPO_DIR/.wavemill/workflow-state.json"
  MILL_LOG_FILE="$SCENARIO_DIR/mill.log"
  GIT_REMOTE_CALLS_LOG="$SCENARIO_DIR/git-remote-calls.log"
  GH_CALLS_LOG="$SCENARIO_DIR/gh-calls.log"
  NPX_CALLS_LOG="$SCENARIO_DIR/npx-calls.log"
  SESSION="wavemill-incident-$$-${name}"
  TMUX_TMPDIR="$SCENARIO_DIR/tmux-tmp"
  TMUX_SOCK="$SCENARIO_DIR/tmux.sock"
  REAL_TMUX="$(command -v tmux 2>/dev/null || true)"

  mkdir -p "$WORKTREE_ROOT" "$BIN_DIR" "$GH_PR_DIR" "$TMUX_TMPDIR"
  : > "$MILL_LOG_FILE"
  : > "$GIT_REMOTE_CALLS_LOG"
  : > "$GH_CALLS_LOG"
  : > "$NPX_CALLS_LOG"

  git init --bare "$ORIGIN_DIR" >/dev/null
  git clone "$ORIGIN_DIR" "$REPO_DIR" >/dev/null 2>&1
  mkdir -p "$REPO_DIR/.wavemill"
  jq -n '{cleanup:{branchDeletion:{enabled:true,mode:"enforce"}}}' > "$REPO_DIR/.wavemill-config.json"
  git -C "$REPO_DIR" config user.email "wavemill-incident@example.com"
  git -C "$REPO_DIR" config user.name "Wavemill Incident Fixture"
  git -C "$REPO_DIR" checkout -b auto/integration >/dev/null 2>&1
  printf 'base\n' > "$REPO_DIR/README.md"
  # Matches this repo's own convention (features/*/ is gitignored): workflow
  # bookkeeping files (.ready-result.json, task packets, etc.) that fixtures
  # write into a task worktree's features/<slug>/ directory must not make
  # `git status --porcelain` report the worktree dirty.
  printf 'features/*/\n' > "$REPO_DIR/.gitignore"
  git -C "$REPO_DIR" add README.md .gitignore
  git -C "$REPO_DIR" commit -m "base" >/dev/null
  git -C "$REPO_DIR" push -u origin auto/integration >/dev/null 2>&1

  cat > "$STATE_FILE" <<'EOF'
{"tasks":{}}
EOF

  incident_scenario_gh_shim
  incident_scenario_npx_shim
  incident_scenario_git_call_counter
  incident_scenario_tmux_shim

  INCIDENT_TEARDOWN_TRAPS+=("incident_scenario_teardown '$SCENARIO_DIR' '$TMUX_SOCK' '$REAL_TMUX'")
}

INCIDENT_TEARDOWN_TRAPS=()

incident_scenario_teardown() {
  local scenario_dir="$1"
  local tmux_sock="${2:-$scenario_dir/tmux.sock}"
  local real_tmux="${3:-$(command -v tmux 2>/dev/null || true)}"
  if [[ -n "$real_tmux" && -S "$tmux_sock" ]]; then
    "$real_tmux" -S "$tmux_sock" kill-server >/dev/null 2>&1 || true
  fi
  rm -rf "$scenario_dir" 2>/dev/null || true
}

incident_preserve_diagnostics() {
  local scenario_dir="$1" name="$2"
  local tarball="/tmp/wavemill-hok2950-${name}-$(date +%s).tar.gz"
  tar -czf "$tarball" -C "$(dirname "$scenario_dir")" "$(basename "$scenario_dir")" 2>/dev/null || true
  incident_harness_note "diagnostics preserved: $tarball"
}

incident_run_teardown_traps() {
  local rc=$?
  if [[ "$rc" -ne 0 && -n "${SCENARIO_DIR:-}" && -n "${SCENARIO_NAME:-}" ]]; then
    incident_preserve_diagnostics "$SCENARIO_DIR" "$SCENARIO_NAME"
  fi
  local entry
  for entry in "${INCIDENT_TEARDOWN_TRAPS[@]:-}"; do
    [[ -n "$entry" ]] && eval "$entry" || true
  done
  exit "$rc"
}

# --- gh / npx / git shims ----------------------------------------------------

# Writes a `gh` shim that answers `gh pr view <n> --json f1,f2 [--jq expr]`
# from a pre-recorded JSON file, and refuses every other invocation. This is
# the only network-shaped surface fixtures touch, matching the task's "no
# GitHub or Linear network access" constraint.
incident_scenario_gh_shim() {
  cat > "$BIN_DIR/gh" <<SHIM
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >> "$GH_CALLS_LOG"
if [[ "\${1:-}" == "pr" && "\${2:-}" == "view" ]]; then
  pr="\${3:-}"
  shift 3
  json_fields=""
  jq_expr=""
  while [[ \$# -gt 0 ]]; do
    case "\$1" in
      --json) json_fields="\$2"; shift 2 ;;
      --jq) jq_expr="\$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  src="$GH_PR_DIR/\$pr.json"
  if [[ ! -f "\$src" ]]; then
    echo "gh: no such PR fixture: \$pr" >&2
    exit 1
  fi
  if [[ -n "\$json_fields" ]]; then
    filter="{}"
    IFS=',' read -ra fields <<< "\$json_fields"
    for f in "\${fields[@]}"; do
      filter="\$filter + {(\"\$f\"): (.\"\$f\" // null)}"
    done
    out="\$(jq -c "\$filter" "\$src")"
  else
    out="\$(cat "\$src")"
  fi
  if [[ -n "\$jq_expr" ]]; then
    printf '%s' "\$out" | jq -r "\$jq_expr"
  else
    printf '%s\n' "\$out"
  fi
  exit 0
fi
echo "gh: unsupported fixture invocation: \$*" >&2
exit 1
SHIM
  chmod +x "$BIN_DIR/gh"
}

# record_pr <pr> <state> [mergedAt] [headRefOid] [headRefName] [baseRefName]
record_pr() {
  local pr="$1" state="$2" merged_at="${3:-null}" head_oid="${4:-}" head_ref="${5:-}" base_ref="${6:-auto/integration}"
  local merged_at_json head_oid_json head_ref_json
  if [[ "$merged_at" == "null" || -z "$merged_at" ]]; then
    merged_at_json="null"
  else
    merged_at_json="\"$merged_at\""
  fi
  [[ -n "$head_oid" ]] && head_oid_json="\"$head_oid\"" || head_oid_json="null"
  [[ -n "$head_ref" ]] && head_ref_json="\"$head_ref\"" || head_ref_json="null"
  jq -cn --argjson number "$pr" --arg state "$state" --argjson mergedAt "$merged_at_json" \
    --argjson headRefOid "$head_oid_json" --argjson headRefName "$head_ref_json" --arg baseRefName "$base_ref" \
    --arg url "https://example.invalid/pr/$pr" --arg title "Fixture PR #$pr" \
    '{number:$number,state:$state,mergedAt:$mergedAt,headRefOid:$headRefOid,headRefName:$headRefName,baseRefName:$baseRefName,url:$url,title:$title}' \
    > "$GH_PR_DIR/$pr.json"
}

# record_pr_deleted_branch <pr> ... - same as record_pr, kept as a distinct
# name so scenario files can self-document "this PR's remote head branch was
# deleted after merge" even though the JSON shape is identical; branch
# deletion itself is modeled by actually deleting the ref in the bare origin.
record_pr_deleted_branch() {
  record_pr "$@"
}

# Real npx is only safe to forward for tools/observer.ts (no Linear/GitHub
# writes with --dry-run). Every other npx call inside the real controller
# code (Linear state sync, challenge-pair resolution, reconciliation
# classifiers) is best-effort and already wrapped in `|| true` / `2>/dev/null`
# by the production code, so a shim that simply fails for anything else is
# both safe and faithful - it reproduces "no network available", which the
# real helpers already tolerate.
incident_scenario_npx_shim() {
  cat > "$BIN_DIR/npx" <<SHIM
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >> "$NPX_CALLS_LOG"
for arg in "\$@"; do
  if [[ "\$arg" == *tools/observer.ts ]]; then
    exec "$(command -v npx)" "\$@"
  fi
done
exit 1
SHIM
  chmod +x "$BIN_DIR/npx"
}

# Wraps real git so remote-facing subcommands are counted without changing
# behavior - composition over stubbing (constraint from the task packet).
incident_scenario_git_call_counter() {
  local real_git
  real_git="$(command -v git)"
  cat > "$BIN_DIR/git" <<SHIM
#!/usr/bin/env bash
set -euo pipefail
args=("\$@")
i=0
while [[ \$i -lt \${#args[@]} && "\${args[\$i]}" == "-C" ]]; do
  i=\$((i + 2))
done
sub="\${args[\$i]:-}"
case "\$sub" in
  fetch|ls-remote|push)
    printf '%s\n' "\${args[*]}" >> "$GIT_REMOTE_CALLS_LOG"
    ;;
esac
exec "$real_git" "\$@"
SHIM
  chmod +x "$BIN_DIR/git"
}

incident_scenario_path() {
  printf '%s:%s\n' "$BIN_DIR" "$PATH"
}

# --- tmux -------------------------------------------------------------------

# Production code and observer.ts intentionally invoke bare `tmux`. Put a
# scenario-local executable ahead of PATH so those calls are forced onto the
# same explicit private socket as the harness itself. TMUX_TMPDIR alone is not
# isolation when the test inherits TMUX from the Wavemill controller.
incident_scenario_tmux_shim() {
  [[ -n "${REAL_TMUX:-}" ]] || return 0
  local real_tmux_q tmux_sock_q
  printf -v real_tmux_q '%q' "$REAL_TMUX"
  printf -v tmux_sock_q '%q' "$TMUX_SOCK"
  cat > "$BIN_DIR/tmux" <<SHIM
#!/usr/bin/env bash
exec $real_tmux_q -S $tmux_sock_q "\$@"
SHIM
  chmod +x "$BIN_DIR/tmux"
}

incident_scenario_start_tmux() {
  [[ -n "${REAL_TMUX:-}" ]] || incident_harness_skip "tmux unavailable"
  "$REAL_TMUX" -S "$TMUX_SOCK" new-session -d -s "$SESSION" -x 200 -y 50 'sleep 600' \
    2>/dev/null || incident_harness_skip "could not start isolated tmux server"
  INCIDENT_TMUX_STARTED=1
}

incident_tmux() {
  "$REAL_TMUX" -S "$TMUX_SOCK" "$@"
}

# incident_scenario_add_task_window <issue> <slug>
#
# The window's pane MUST start in the task's worktree directory: production
# code (_tmux_task_window_target / _tmux_window_target_exists in
# wavemill-common.sh) confirms a discovered window target by comparing
# `#{pane_current_path}` against the expected worktree path, and treats a
# path mismatch as "target already gone" - silently skipping the
# `tmux kill-window` call instead of failing loudly. Without `-c` here, the
# pane would inherit the harness's own cwd and every real cleanup path in the
# suite would silently no-op instead of exercising the actual kill-window
# behavior it is supposed to prove.
incident_scenario_add_task_window() {
  local issue="$1" slug="$2"
  local window="${issue}-${slug}"
  local wt_dir="$WORKTREE_ROOT/$slug"
  incident_tmux new-window -t "$SESSION" -n "$window" -c "$wt_dir" 'sleep 600' >/dev/null 2>&1
}

incident_window_target() {
  local issue="$1" slug="$2"
  printf '%s:%s-%s\n' "$SESSION" "$issue" "$slug"
}

assert_pane_alive() {
  local issue="$1" slug="$2" label="${3:-pane alive}"
  local target
  target="$(incident_window_target "$issue" "$slug")"
  if incident_tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
    return 0
  fi
  echo "FAIL: $label: expected live pane at $target" >&2
  return 1
}

assert_pane_closed() {
  local issue="$1" slug="$2" label="${3:-pane closed}"
  local target
  target="$(incident_window_target "$issue" "$slug")"
  if incident_tmux list-panes -t "$target" >/dev/null 2>&1; then
    echo "FAIL: $label: expected window to be closed at $target" >&2
    return 1
  fi
  return 0
}

# --- workflow-state seeding --------------------------------------------------

# incident_seed_task <issue> <json-fragment>
# json-fragment is merged as the task's full state object, e.g.:
#   incident_seed_task HOK-2595 '{"slug":"x","branch":"task/x","pr":"1000", ...}'
incident_seed_task() {
  local issue="$1" fragment="$2"
  local tmp
  tmp="$(mktemp)"
  jq --arg issue "$issue" --argjson task "$fragment" '.tasks[$issue] = $task' "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

incident_write_hook() {
  local issue="$1" state="$2" event="$3" detail="${4:-}" agent="${5:-claude}" ts="${6:-}"
  [[ -n "$ts" ]] || ts="$(date +%s)"
  jq -cn --arg state "$state" --arg event "$event" --arg detail "$detail" --arg agent "$agent" --argjson timestamp "$ts" \
    '{state:$state,event:$event,detail:$detail,agent:$agent,timestamp:$timestamp}' \
    > "/tmp/wavemill-${SESSION}-${issue}.hook"
}

incident_cleanup_hooks() {
  rm -f "/tmp/wavemill-${SESSION}-"*.hook 2>/dev/null || true
}

# incident_backdated_iso <hours-ago> - portable (BSD/GNU) ISO-8601 timestamp
# N hours in the past, for seeding/backdating a task's `updated` field so
# age-gated staleness detectors (tools/observer.ts --stale-minutes) fire
# deterministically without a real-time wait.
incident_backdated_iso() {
  local hours_ago="$1"
  date -u -v-"${hours_ago}H" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "${hours_ago} hours ago" +"%Y-%m-%dT%H:%M:%SZ"
}

# incident_set_task_updated <issue> <iso8601> - directly rewrites a task's
# `updated` timestamp. Used to simulate elapsed wall-clock time between the
# last monitor tick (which stamps `updated=now` on every terminal
# reconciliation write) and a later Observer pass, without an actual sleep.
incident_set_task_updated() {
  local issue="$1" iso="$2" tmp
  tmp="$(mktemp)"
  jq --arg issue "$issue" --arg updated "$iso" '.tasks[$issue].updated = $updated' "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

# incident_slot_consuming_count - evaluates the real slot accounting
# (wm_slot_consumes over lifecycle dispositions) against the scenario's
# workflow-state, so fixtures can assert slot counts before/after a pass.
incident_slot_consuming_count() {
  STATE_FILE="$STATE_FILE" COMMON="$INCIDENT_COMMON_SCRIPT" bash -c '
    set -euo pipefail
    source "$COMMON" >/dev/null 2>&1
    slot_consuming_task_count
  '
}

# --- driving monitor_issue_state ---------------------------------------------

# run_monitor_tick <issue> <slug> [pr]
#
# Every call is a brand-new bash process sourcing the extracted controller
# library fresh - deliberately stricter than production (which keeps one
# long-lived process across ticks) so that calling this function twice in a
# row for the same issue *is* the restart-replay scenario: nothing survives
# between calls except what is actually persisted to disk (workflow-state,
# git, tmux, hook files). That is exactly the property the task asks
# fixtures to prove ("workflow state alone is enough to reach a stable
# terminal state").
run_monitor_tick() {
  local issue="$1" slug="$2" pr="${3:-}"
  local lib_file
  lib_file="$(incident_build_monitor_lib)" || {
    echo "FAIL: could not build monitor library" >&2
    return 1
  }

  local record_file
  record_file="$(mktemp)"

  local before_remote_calls after_remote_calls
  before_remote_calls="$(wc -l < "$GIT_REMOTE_CALLS_LOG" | tr -d ' ')"

  local start_ms end_ms
  start_ms="$(incident_now_ms)"

  PATH="$(incident_scenario_path)" \
  LIB_FILE="$lib_file" \
  SESSION="$SESSION" \
  ISSUE="$issue" \
  SLUG="$slug" \
  PR="$pr" \
  REPO_DIR="$REPO_DIR" \
  WORKTREE_ROOT="$WORKTREE_ROOT" \
  STATE_FILE="$STATE_FILE" \
  MILL_LOG_FILE="$MILL_LOG_FILE" \
  TMUX_TMPDIR="$TMUX_TMPDIR" \
  TMUX_SOCK="$TMUX_SOCK" \
  RECORD_FILE="$record_file" \
  bash -c '
    set -Eeuo pipefail
    export TMPDIR="${TMPDIR:-/tmp}"
    source "$LIB_FILE"

    BASE_BRANCH="auto/integration"
    API_TIMEOUT=5
    AGENT_CMD="codex"
    AUTO_EVAL=false
    REQUIRE_CONFIRM=false
    QUIT_REQUESTED=false
    DRY_RUN=false
    CHALLENGE_AUTO_MERGE=false
    TOOLS_DIR="'"$INCIDENT_REPO_DIR"'/tools"
    LIB_DIR="'"$INCIDENT_REPO_DIR"'/shared/lib"
    DASHBOARD_VERBOSITY="info"
    VERBOSITY_NUM=2
    MAX_PARALLEL=4
    EFFECTIVE_MAX_PARALLEL=4
    active_count=0

    declare -Ag BRANCH_BY_ISSUE=()
    declare -Ag SLUG_BY_ISSUE=()
    declare -Ag PR_BY_ISSUE=()
    declare -Ag CLEANED=()
    BRANCH_BY_ISSUE["$ISSUE"]="task/$SLUG"
    SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
    [[ -n "$PR" ]] && PR_BY_ISSUE["$ISSUE"]="$PR"

    # Instrument (not stub) the three cleanup entry points so fixtures can
    # assert "cleanup attempted exactly once" without altering behavior.
    CLEANUP_COMPLETED_CALLS=0
    CLEANUP_ABORTED_CALLS=0
    CLEANUP_MERGED_PRIMARY_CALLS=0
    eval "$(declare -f cleanup_completed_task | sed "1s/.*/_orig_cleanup_completed_task ()/")"
    cleanup_completed_task() { CLEANUP_COMPLETED_CALLS=$((CLEANUP_COMPLETED_CALLS + 1)); _orig_cleanup_completed_task "$@"; }
    eval "$(declare -f cleanup_aborted_challenge_arm | sed "1s/.*/_orig_cleanup_aborted_challenge_arm ()/")"
    cleanup_aborted_challenge_arm() { CLEANUP_ABORTED_CALLS=$((CLEANUP_ABORTED_CALLS + 1)); _orig_cleanup_aborted_challenge_arm "$@"; }
    eval "$(declare -f cleanup_merged_primary_challenge_task | sed "1s/.*/_orig_cleanup_merged_primary_challenge_task ()/")"
    cleanup_merged_primary_challenge_task() { CLEANUP_MERGED_PRIMARY_CALLS=$((CLEANUP_MERGED_PRIMARY_CALLS + 1)); _orig_cleanup_merged_primary_challenge_task "$@"; }

    set +e
    monitor_issue_state "$ISSUE"
    rc=$?
    set -e

    phase="$(jq -r --arg i "$ISSUE" ".tasks[\$i].phase // \"\"" "$STATE_FILE" 2>/dev/null || echo "")"
    status="$(jq -r --arg i "$ISSUE" ".tasks[\$i].status // \"\"" "$STATE_FILE" 2>/dev/null || echo "")"
    present="$(jq -r --arg i "$ISSUE" ".tasks | has(\$i)" "$STATE_FILE" 2>/dev/null || echo "false")"

    {
      printf "rc=%s\n" "$rc"
      printf "phase=%s\n" "$phase"
      printf "status=%s\n" "$status"
      printf "present=%s\n" "$present"
      printf "cleaned=%s\n" "${CLEANED[$ISSUE]:-}"
      printf "active_count=%s\n" "$active_count"
      printf "cleanup_completed_calls=%s\n" "$CLEANUP_COMPLETED_CALLS"
      printf "cleanup_aborted_calls=%s\n" "$CLEANUP_ABORTED_CALLS"
      printf "cleanup_merged_primary_calls=%s\n" "$CLEANUP_MERGED_PRIMARY_CALLS"
    } > "$RECORD_FILE"
  ' 2> "$SCENARIO_DIR/tick-stderr.log" || true

  end_ms="$(incident_now_ms)"
  after_remote_calls="$(wc -l < "$GIT_REMOTE_CALLS_LOG" | tr -d ' ')"

  {
    cat "$record_file"
    printf 'iteration_ms=%s\n' "$((end_ms - start_ms))"
    printf 'remote_call_delta=%s\n' "$((after_remote_calls - before_remote_calls))"
  }
  rm -f "$record_file"
  # incident_build_monitor_lib's in-process cache (INCIDENT_MONITOR_LIB_CACHE)
  # never actually hits: run_monitor_tick is always invoked through a
  # `$(...)` command substitution by every driver ("tick1=\"$(run_monitor_tick
  # ...)\""), so any variable it sets is a fork-local write that vanishes with
  # the subshell - each call rebuilds the library fresh. Removing it here
  # (rather than relying on cache reuse or a would-be top-level EXIT trap that
  # can never see it either) is what actually keeps this from leaking one
  # `wavemill-incident-monitor-lib.XXXXXX` temp directory per tick.
  rm -rf "$(dirname "$lib_file")" 2>/dev/null || true
}

tick_field() {
  local tick_output="$1" field="$2"
  printf '%s\n' "$tick_output" | awk -F'=' -v f="$field" '$1 == f { sub(/^[^=]*=/, ""); print; found=1 } END { if (!found) print "" }'
}

# --- Observer -----------------------------------------------------------------

# run_observer_pass - runs the real observer.ts against the scenario repo.
# Uses --dry-run (no Linear writes) and --repo-dir (reads workflow-state.json
# directly), so it needs no network access. The scenario-local PATH shim forces
# observer.ts's bare `tmux list-panes -a` calls onto the private socket.
# --stale-minutes 1 makes the
# age-gated residue detectors deterministic in a fixture that seeds a
# backdated `updated` timestamp rather than actually waiting out the default
# 10-minute threshold in real time.
run_observer_pass() {
  local output
  output="$(PATH="$(incident_scenario_path)" TMUX_TMPDIR="$TMUX_TMPDIR" TMUX_SOCK="$TMUX_SOCK" npx tsx "$INCIDENT_REPO_DIR/tools/observer.ts" \
    --once --json --dry-run --repo-dir "$REPO_DIR" --session "$SESSION" --stale-minutes 1 2>"$SCENARIO_DIR/observer-stderr.log")" || true
  printf '%s\n' "$output"
}

observer_has_finding_prefix() {
  local observer_json="$1" prefix="$2"
  printf '%s\n' "$observer_json" | jq -e --arg p "$prefix" \
    '[.findings[]? // empty | select(.id | startswith($p))] | length > 0' >/dev/null 2>&1
}

# --- Dashboard ----------------------------------------------------------------

# dashboard_task_is_active <issue> - extracts wavemill-status.sh's own
# gather_tasks/is_active/task_window_target classifiers (rather than the
# full ANSI render loop, which never terminates) and reports whether the
# dashboard still surfaces the issue as an active/spinner row: "absent" once
# the task entry is gone from workflow-state, "inactive" if the entry
# lingers but neither the worktree directory nor a live tmux window back it,
# "active" otherwise.
dashboard_task_is_active() {
  local issue="$1"
  local funcs_file
  funcs_file="$(mktemp)"
  {
    extract_function "$INCIDENT_STATUS_SCRIPT" "task_window_target"
    printf '\n'
    extract_function "$INCIDENT_STATUS_SCRIPT" "is_active"
    printf '\n'
    extract_function "$INCIDENT_STATUS_SCRIPT" "gather_tasks"
  } > "$funcs_file"

  PATH="$(incident_scenario_path)" \
  ISSUE="$issue" STATE_FILE="$STATE_FILE" SESSION="$SESSION" WORKTREE_ROOT="$WORKTREE_ROOT" \
  FUNCS_FILE="$funcs_file" TMUX_TMPDIR="$TMUX_TMPDIR" TMUX_SOCK="$TMUX_SOCK" bash -c '
    set -euo pipefail
    source "$FUNCS_FILE"
    found=0
    while IFS="|" read -r key slug branch worktree status phase pr; do
      [[ "$key" == "$ISSUE" ]] || continue
      found=1
      win="${key}-${slug}"
      if is_active "$worktree" "$win"; then
        echo "active"
      else
        echo "inactive"
      fi
      break
    done < <(gather_tasks 2>/dev/null || true)
    [[ "$found" -eq 1 ]] || echo "absent"
  '
  rm -f "$funcs_file"
}

trap incident_run_teardown_traps EXIT
