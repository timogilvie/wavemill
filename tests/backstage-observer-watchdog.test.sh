#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$source_file"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "  missing: $needle"
    echo "  actual: $haystack"
    exit 1
  fi
}

source "$COMMON_SCRIPT"

FUNCS_FILE="$TMP_DIR/backstage-observer-functions.sh"
: > "$FUNCS_FILE"
for fn in \
  read_backstage_service_health_field \
  classify_backstage_observer_health \
  restart_backstage_observer_loop \
  check_backstage_observer_health
do
  extract_function "$MONITOR_SCRIPT_FILE" "$fn" >> "$FUNCS_FILE"
  printf '\n' >> "$FUNCS_FILE"
done
source "$FUNCS_FILE"

SESSION="test-session"
STATE_DIR="$TMP_DIR/state"
REPO_DIR="$TMP_DIR/repo"
TOOLS_DIR="$TMP_DIR/tools"
mkdir -p "$STATE_DIR" "$REPO_DIR/.wavemill" "$TOOLS_DIR"
HEALTH_FILE="$STATE_DIR/backstage-health.json"
LOG_FILE="$TMP_DIR/log.txt"
RECONCILE_LOG="$TMP_DIR/reconcile.txt"
PANE_FILE="$TMP_DIR/panes.txt"
: > "$LOG_FILE"
: > "$RECONCILE_LOG"
: > "$PANE_FILE"

BACKSTAGE_HEALTH_INTERVAL=0
BACKSTAGE_RESTART_COOLDOWN=60
LAST_BACKSTAGE_OBSERVER_HEALTH_CHECK=0
LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS=""

observer_health_enabled() { return 0; }
TEND_ENABLED=true
backstage_health_enabled() { [[ "$TEND_ENABLED" == "true" ]]; }
wavemill_load_config() { printf '{"observer":{"enabled":true,"intervalSeconds":5,"heartbeatStaleSeconds":30,"maxLogLines":25}}\n'; }
probe_backstage_panes() { cat "$PANE_FILE"; }
log() { printf 'LOG %s\n' "$*" >> "$LOG_FILE"; }
log_warn() { printf 'WARN %s\n' "$*" >> "$LOG_FILE"; }
TMUX_LOG="$TMP_DIR/tmux.txt"
: > "$TMUX_LOG"
tmux() {
  printf '%s\n' "$*" >> "$TMUX_LOG"
  case "$1" in
    list-panes) [[ -s "$PANE_FILE" ]] ;;
    new-window)
      printf '%%9\tWavemill Observer\t0\tnode\tnpx tsx tools/observer.ts --loop\n' > "$PANE_FILE"
      ;;
    display-message) printf '%%9\n' ;;
    *) return 0 ;;
  esac
}
wavemill_set_tmux_pane_title() { return 0; }

wavemill_reconcile_backstage_service_pane() {
  local session="$1" window="$2" title="$3" _command="$4" mode="$5" target="$6"
  printf '%s\t%s\t%s\t%s\n' "$session:$window" "$title" "$mode" "$target" >> "$RECONCILE_LOG"
  printf '%%1\tWavemill Observer\t0\tnode\tnpx tsx tools/observer.ts --loop\n' > "$PANE_FILE"
  printf '%%1\t%s\t1\n' "$([[ "$mode" == "restart" ]] && printf respawned || printf reused)"
}

old_iso() {
  perl -MPOSIX=strftime -e 'my $offset = shift @ARGV; print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime(time() - $offset)), "\n"' -- "$1"
}

write_observer_health() {
  local heartbeat="$1"
  wavemill_write_backstage_service_health "$HEALTH_FILE" "observer" "healthy" "seed" 0 "" "%1" "$heartbeat" 1
}

printf '%%1\tWavemill Observer\t0\tnode\tnpx tsx tools/observer.ts --loop\n%%2\tWavemill Observer\t0\tnode\tnpx tsx tools/observer.ts --loop\n' > "$PANE_FILE"
write_observer_health "$(old_iso 1)"
summary="$(classify_backstage_observer_health "$(cat "$PANE_FILE")" "$(date +%s)" 30)"
IFS=$'\t' read -r status _detail _pane_count _pane_id _heartbeat count <<< "$summary"
assert_eq "duplicate classify status" "healthy" "$status"
assert_eq "duplicate classify count" "2" "$count"
check_backstage_observer_health
assert_contains "duplicate reconcile mode" "$(cat "$RECONCILE_LOG")" $'Wavemill Observer\treuse'
assert_eq "duplicate health instance count" "1" "$(jq -r '.services.observer.instanceCount' "$HEALTH_FILE")"
assert_contains "duplicate warning" "$(cat "$LOG_FILE")" "duplicate panes"

: > "$RECONCILE_LOG"
: > "$LOG_FILE"
LAST_BACKSTAGE_OBSERVER_HEALTH_CHECK=0
LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS=""
printf '%%1\tWavemill Observer\t0\tnode\tnpx tsx tools/observer.ts --loop\n' > "$PANE_FILE"
write_observer_health "$(old_iso 300)"
check_backstage_observer_health
assert_contains "stale restart mode" "$(cat "$RECONCILE_LOG")" $'Wavemill Observer\trestart'

: > "$RECONCILE_LOG"
LAST_BACKSTAGE_OBSERVER_HEALTH_CHECK=0
printf '%%1\tWavemill Observer\t0\tnode\tnpx tsx tools/observer.ts --loop\n' > "$PANE_FILE"
write_observer_health "$(old_iso 1)"
check_backstage_observer_health
assert_eq "healthy no reconcile" "0" "$(wc -l < "$RECONCILE_LOG" | tr -d ' ')"
assert_eq "healthy instance count" "1" "$(jq -r '.services.observer.instanceCount' "$HEALTH_FILE")"

LAST_BACKSTAGE_OBSERVER_HEALTH_CHECK=0
: > "$PANE_FILE"
check_backstage_observer_health
assert_eq "missing status" "backstage-missing" "$(jq -r '.services.observer.status' "$HEALTH_FILE")"
assert_eq "missing instance count" "0" "$(jq -r '.services.observer.instanceCount' "$HEALTH_FILE")"
assert_eq "missing window with tend on is not recreated by observer" "0" "$(grep -c '^new-window' "$TMUX_LOG" || true)"

# HOK-3094: with tend off the observer owns the backstage window, so a missing
# window goes through the restart flow, which recreates it with the observer.
TEND_ENABLED=false
LAST_BACKSTAGE_OBSERVER_HEALTH_CHECK=0
LAST_BACKSTAGE_OBSERVER_HEALTH_STATUS=""
rm -f "$HEALTH_FILE"
: > "$PANE_FILE"
: > "$TMUX_LOG"
: > "$RECONCILE_LOG"
check_backstage_observer_health
assert_eq "tend-off missing window recreated" "1" "$(grep -c '^new-window' "$TMUX_LOG" || true)"
assert_contains "tend-off new window runs observer" "$(cat "$TMUX_LOG")" "tools/observer.ts"
assert_eq "tend-off restart does not split" "0" "$(wc -l < "$RECONCILE_LOG" | tr -d ' ')"
assert_eq "tend-off observer healthy after restart" "healthy" "$(jq -r '.services.observer.status' "$HEALTH_FILE")"
assert_eq "tend-off observer pane recorded" "%9" "$(jq -r '.services.observer.paneId' "$HEALTH_FILE")"

echo "backstage observer watchdog tests passed"
