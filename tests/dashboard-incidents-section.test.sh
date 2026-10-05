#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS_LIB="$REPO_DIR/shared/lib/wavemill-status.sh"
FIXTURE_DIR="$REPO_DIR/tests/fixtures/incidents"

extract_function() {
  local file="$1"
  local name="$2"
  awk -v name="$name" '
    $0 ~ ("^" name "\\(\\)") { capture=1; found=1 }
    capture { print }
    capture && /^}/ { exit }
    END { if (!found) exit 1 }
  ' "$file"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FUNCS_FILE="$TMP_DIR/incidents-functions.sh"
extract_function "$STATUS_LIB" wavemill_incident_index_path > "$FUNCS_FILE"
extract_function "$STATUS_LIB" format_incident_since >> "$FUNCS_FILE"
extract_function "$STATUS_LIB" incident_severity_color >> "$FUNCS_FILE"
extract_function "$STATUS_LIB" render_incidents_section >> "$FUNCS_FILE"

# shellcheck source=/dev/null
source "$FUNCS_FILE"

FRAME="$TMP_DIR/frame.txt"
WAVEMILL_MILLED_REPO_DIR="$TMP_DIR/repo"
mkdir -p "$WAVEMILL_MILLED_REPO_DIR"
EL=""
B=""
N=""
D=""
G=""
Y=""
R=""

render_fixture() {
  local fixture="$1"
  : > "$FRAME"
  WAVEMILL_INCIDENT_INDEX_OVERRIDE="$fixture" render_incidents_section
}

frame_text() {
  cat "$FRAME"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "missing $label: $needle" >&2
    printf '%s\n' "$haystack" >&2
    exit 1
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "unexpected $label: $needle" >&2
    printf '%s\n' "$haystack" >&2
    exit 1
  fi
}

first_line_number() {
  local needle="$1"
  grep -n -F "$needle" "$FRAME" | head -n 1 | cut -d: -f1
}

render_fixture "$FIXTURE_DIR/active_only.json"
active_out="$(frame_text)"
assert_contains "$active_out" "🔥 INCIDENTS (1)" "active header"
assert_contains "$active_out" "product_defect / medium" "active category and severity"
assert_contains "$active_out" "occ=30336" "active occurrence count"
assert_contains "$active_out" "since 08-24" "active first observed date"
assert_contains "$active_out" "eval job eval-HOK-2893-primary-1265 ended failed" "active summary"
assert_contains "$active_out" "fingerprint 0409b10f…" "active fingerprint"
if [[ "$(grep -c '^🔥  ' "$FRAME")" != "1" ]]; then
  echo "expected exactly one active incident row" >&2
  printf '%s\n' "$active_out" >&2
  exit 1
fi

render_fixture "$FIXTURE_DIR/mixed_lifecycles.json"
mixed_out="$(frame_text)"
assert_contains "$mixed_out" "active incident should render" "mixed active row"
assert_not_contains "$mixed_out" "observed incident must stay hidden" "observed row"
assert_not_contains "$mixed_out" "resolved incident must stay hidden" "resolved row"
assert_not_contains "$mixed_out" "archived incident must stay hidden" "archived row"
if [[ "$(grep -c '^🔥  ' "$FRAME")" != "1" ]]; then
  echo "expected exactly one mixed lifecycle incident row" >&2
  printf '%s\n' "$mixed_out" >&2
  exit 1
fi

render_fixture "$FIXTURE_DIR/sorted_many.json"
sorted_out="$(frame_text)"
assert_contains "$sorted_out" "🔥 INCIDENTS (7)" "sorted header"
assert_contains "$sorted_out" "…and 2 more incidents" "sorted cap summary"
if [[ "$(grep -c '^🔥  ' "$FRAME")" != "5" ]]; then
  echo "expected top five incident rows" >&2
  printf '%s\n' "$sorted_out" >&2
  exit 1
fi
critical_line="$(first_line_number "critical severity count 2")"
high50_line="$(first_line_number "high severity count 50")"
high1_line="$(first_line_number "high severity count 1")"
medium101_line="$(first_line_number "medium severity count 101")"
medium100_line="$(first_line_number "medium severity count 100")"
if ! (( critical_line < high50_line && high50_line < high1_line && high1_line < medium101_line && medium101_line < medium100_line )); then
  echo "incident sort order is wrong" >&2
  printf '%s\n' "$sorted_out" >&2
  exit 1
fi
assert_not_contains "$sorted_out" "low severity high count" "low row hidden by cap"
assert_not_contains "$sorted_out" "low severity count 20" "low row hidden by cap"

render_fixture "$FIXTURE_DIR/no_task_id.json"
no_task_out="$(frame_text)"
assert_contains "$no_task_out" "remote dependency probe failure" "null task incident"
assert_contains "$no_task_out" "fingerprint abcd1234…" "null task fingerprint"
assert_not_contains "$no_task_out" "taskId" "task id label"
assert_not_contains "$no_task_out" "null" "null task value"

render_fixture "/nonexistent/wavemill/incidents/index.json"
missing_out="$(frame_text)"
if [[ -n "$missing_out" ]]; then
  echo "missing incident index should render nothing" >&2
  printf '%s\n' "$missing_out" >&2
  exit 1
fi

render_fixture "$FIXTURE_DIR/empty.json"
empty_out="$(frame_text)"
if [[ -n "$empty_out" ]]; then
  echo "empty incident index should render nothing" >&2
  printf '%s\n' "$empty_out" >&2
  exit 1
fi

malformed_err="$TMP_DIR/malformed.err"
: > "$FRAME"
WAVEMILL_INCIDENT_INDEX_OVERRIDE="$FIXTURE_DIR/malformed.json" render_incidents_section 2>"$malformed_err"
malformed_out="$(frame_text)"
if [[ -n "$malformed_out" ]]; then
  echo "malformed incident index should render nothing to frame" >&2
  printf '%s\n' "$malformed_out" >&2
  exit 1
fi
if [[ ! -s "$malformed_err" ]]; then
  echo "malformed incident index should leave jq parse detail on stderr" >&2
  exit 1
fi

# HOK-3094: without an override, the index comes from the milled repo's state
# dir (the one holding STATE_FILE), never the wavemill install dir.
WAVEMILL_INSTALL_DIR="$TMP_DIR/install"
MILL_STATE_DIR="$TMP_DIR/milled-repo/.wavemill"
mkdir -p "$WAVEMILL_INSTALL_DIR/.wavemill/incidents" "$MILL_STATE_DIR/incidents"
cp "$FIXTURE_DIR/no_task_id.json" "$WAVEMILL_INSTALL_DIR/.wavemill/incidents/index.json"
cp "$FIXTURE_DIR/active_only.json" "$MILL_STATE_DIR/incidents/index.json"
unset WAVEMILL_INCIDENT_INDEX_OVERRIDE

: > "$FRAME"
STATE_FILE="$MILL_STATE_DIR/workflow-state.json" render_incidents_section
repo_out="$(frame_text)"
assert_contains "$repo_out" "eval job eval-HOK-2893-primary-1265 ended failed" "milled repo incident"
assert_not_contains "$repo_out" "remote dependency probe failure" "install dir incident"

: > "$FRAME"
STATE_FILE="" render_incidents_section
no_state_out="$(frame_text)"
if [[ -n "$no_state_out" ]]; then
  echo "no STATE_FILE should render no incident panel (never the install dir)" >&2
  printf '%s\n' "$no_state_out" >&2
  exit 1
fi
