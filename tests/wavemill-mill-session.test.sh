#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) {
        exit
      }
    }
  ' "$source_file"
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "expected to find: $needle"
    echo "actual: $haystack"
    exit 1
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "did not expect to find: $needle"
    echo "actual: $haystack"
    exit 1
  fi
}

FUNCS_FILE="$TMP_DIR/create-tmux-session.sh"
extract_function "$MILL_SCRIPT" dotenv_value > "$FUNCS_FILE"
extract_function "$MILL_SCRIPT" hydrate_provider_env_from_dotenv >> "$FUNCS_FILE"
extract_function "$MILL_SCRIPT" create_tmux_session >> "$FUNCS_FILE"
extract_function "$MILL_SCRIPT" hold_session_sleep_assertion >> "$FUNCS_FILE"
extract_function "$MILL_SCRIPT" mill_sleep_preflight_warning >> "$FUNCS_FILE"
source "$FUNCS_FILE"

# Host platform stubs (HOK-3174). Default to a non-macOS host so the
# pre-existing session cases never spawn a real caffeinate.
UNAME_S="Linux"
uname() { printf '%s\n' "$UNAME_S"; }
MILL_LOG="$TMP_DIR/mill.log"
: > "$MILL_LOG"
log() { shift; printf 'INFO %s\n' "$*" >> "$MILL_LOG"; }
log_warn() { printf 'WARN %s\n' "$*" >> "$MILL_LOG"; }
CAFFEINATE_LOG="$TMP_DIR/caffeinate.log"
: > "$CAFFEINATE_LOG"
caffeinate() { printf 'caffeinate %s\n' "$*" >> "$CAFFEINATE_LOG"; }
nohup() { "$@"; }
PMSET_BATT="Now drawing from 'AC Power'"
PMSET_SETTINGS=" sleep                0 (sleep prevented by powerd)"
pmset() {
  if [[ "${2:-}" == "batt" ]]; then
    printf '%s\n' "$PMSET_BATT"
  else
    printf 'System-wide power settings:\nCurrently in use:\n%s\n displaysleep 10\n' "$PMSET_SETTINGS"
  fi
}
TMUX_SERVER_PID=4242

SCRIPT_DIR="$REPO_DIR/shared/lib"
WAVEMILL_WINDOW_MILL="mill"
SESSION="collide"
REPO_DIR="/repos/requested"

TMUX_LOG="$TMP_DIR/tmux.log"
TMUX_EXISTING_REPO="/repos/active"
TMUX_HAS_SESSION=1

tmux() {
  printf 'tmux %s\n' "$*" >> "$TMUX_LOG"
  if [[ "${1:-}" == "-f" ]]; then
    shift 2
  fi
  case "${1:-}" in
    has-session)
      [[ "$TMUX_HAS_SESSION" == "1" ]]
      ;;
    show-environment)
      if [[ -n "${TMUX_EXISTING_REPO:-}" ]]; then
        printf 'REPO_DIR=%s\n' "$TMUX_EXISTING_REPO"
      else
        return 1
      fi
      ;;
    kill-session)
      return 0
      ;;
    new-session|set-option|set-environment|bind-key|send-keys)
      return 0
      ;;
    display-message)
      printf '%s\n' "$TMUX_SERVER_PID"
      ;;
    *)
      echo "FAIL: unexpected tmux invocation: $*" >&2
      return 1
      ;;
  esac
}

set +e
output="$(create_tmux_session 2>&1)"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "FAIL: mismatched repo should reject existing session"
  exit 1
fi

assert_contains "mismatch mentions session" "$output" "tmux session 'collide'"
assert_contains "mismatch mentions requested repo" "$output" "Requested repo: /repos/requested"
assert_contains "mismatch mentions active repo" "$output" "Active repo:    /repos/active"
assert_contains "mismatch includes attach command" "$output" "tmux attach -t collide"
assert_contains "mismatch includes kill command" "$output" "tmux kill-session -t collide"
assert_contains "mismatch includes override command" "$output" "SESSION=collide-alt wavemill mill"
assert_not_contains "mismatch does not kill foreign session" "$(cat "$TMUX_LOG")" "kill-session"

: > "$TMUX_LOG"
TMUX_EXISTING_REPO=""

set +e
unknown_output="$(create_tmux_session 2>&1)"
unknown_status=$?
set -e

if [[ "$unknown_status" -eq 0 ]]; then
  echo "FAIL: missing REPO_DIR should reject existing session"
  exit 1
fi

assert_contains "missing repo reports unknown" "$unknown_output" "Active repo:    unknown"
assert_not_contains "unknown repo does not kill session" "$(cat "$TMUX_LOG")" "kill-session"

: > "$TMUX_LOG"
TMUX_HAS_SESSION=0
TMUX_EXISTING_REPO=""
REPO_DIR="$TMP_DIR/repo"
unset OPENROUTER_API_KEY DEEPSEEK_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY
mkdir -p "$REPO_DIR"
cat > "$REPO_DIR/.env" <<'EOF'
OPENROUTER_API_KEY=sk-openrouter-from-dotenv
EOF

create_tmux_session >/dev/null

assert_contains \
  "new session exports OPENROUTER_API_KEY from root .env" \
  "$(cat "$TMUX_LOG")" \
  "set-environment -t collide OPENROUTER_API_KEY sk-openrouter-from-dotenv"

echo "PASS: create_tmux_session rejects foreign sessions and hydrates provider env"

# ── HOK-3174: session sleep assertion ────────────────────────────────────
assert_not_contains "non-macOS host never runs caffeinate" "$(cat "$CAFFEINATE_LOG")" "caffeinate"
assert_not_contains "non-macOS host logs no assertion" "$(cat "$MILL_LOG")" "sleep assertion"

UNAME_S="Darwin"
: > "$TMUX_LOG"; : > "$MILL_LOG"; : > "$CAFFEINATE_LOG"
create_tmux_session >/dev/null
wait 2>/dev/null || true
assert_contains "macOS binds caffeinate to the tmux server pid" "$(cat "$CAFFEINATE_LOG")" "caffeinate -i -s -w 4242"
assert_contains "server pid resolved from the session" "$(cat "$TMUX_LOG")" "display-message -p -t collide #{pid}"
held_lines="$(grep -c 'Holding sleep assertion' "$MILL_LOG" || true)"
if [[ "$held_lines" != "1" ]]; then
  echo "FAIL: expected exactly one held-assertion log line, got $held_lines"
  exit 1
fi

: > "$MILL_LOG"; : > "$CAFFEINATE_LOG"
WAVEMILL_NO_CAFFEINATE=1 create_tmux_session >/dev/null
wait 2>/dev/null || true
assert_not_contains "WAVEMILL_NO_CAFFEINATE=1 opts out" "$(cat "$CAFFEINATE_LOG")" "caffeinate"
assert_not_contains "opt-out logs no assertion" "$(cat "$MILL_LOG")" "sleep assertion"

: > "$MILL_LOG"; : > "$CAFFEINATE_LOG"
TMUX_SERVER_PID=""
create_tmux_session >/dev/null
assert_not_contains "unresolvable server pid holds nothing" "$(cat "$CAFFEINATE_LOG")" "caffeinate"
assert_contains "unresolvable server pid warns" "$(cat "$MILL_LOG")" "Could not resolve the tmux server pid"
TMUX_SERVER_PID=4242

echo "PASS: create_tmux_session holds a caffeinate assertion bound to the tmux server on macOS"

# ── HOK-3174: startup sleep preflight ────────────────────────────────────
: > "$MILL_LOG"
mill_sleep_preflight_warning
assert_not_contains "AC with sleep 0 does not warn" "$(cat "$MILL_LOG")" "WARN"

PMSET_SETTINGS=" sleep                10"
: > "$MILL_LOG"
mill_sleep_preflight_warning
assert_contains "AC sleep warns" "$(cat "$MILL_LOG")" "sleep after 10m on AC"
assert_contains "warning gives the fix" "$(cat "$MILL_LOG")" "sudo pmset -c sleep 0"
assert_contains "warning mentions the lid" "$(cat "$MILL_LOG")" "external display"
if [[ "$(grep -c WARN "$MILL_LOG")" != "1" ]]; then
  echo "FAIL: expected a single preflight warning"
  exit 1
fi

PMSET_SETTINGS=" sleep                0"
PMSET_BATT="Now drawing from 'Battery Power'"
: > "$MILL_LOG"
mill_sleep_preflight_warning
assert_contains "battery warns" "$(cat "$MILL_LOG")" "on battery"

UNAME_S="Linux"
: > "$MILL_LOG"
mill_sleep_preflight_warning
assert_not_contains "non-macOS preflight is silent" "$(cat "$MILL_LOG")" "WARN"

echo "PASS: mill_sleep_preflight_warning warns on AC sleep and battery only on macOS"
