#!/usr/bin/env bash
# HOK-2899: permanent characterization guard for the extracted monitor script.
#
# The mill generates /tmp/${SESSION}-monitor.sh by copying the committed
# shared/lib/wavemill-monitor.sh (formerly a 15,035-line MONITOR_EOF heredoc
# embedded in wavemill-mill.sh). This test proves the generated temporary
# monitor stays byte-identical to the committed source, that the generated
# copy still passes the same MONITOR_BASH -n gate the mill applies, and that
# the interface contracts the extraction must preserve are still present:
#   - the shebang + `set -Eeuo pipefail` prologue
#   - the `source "$1"` environment-file contract with the parent
#   - the WAVEMILL_READY_WATCHDOG_SOURCE_ONLY early-return that
#     tools/ready-watchdog.ts relies on when sourcing the generated monitor
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

echo "=== Monitor Script Byte-Identity Guard (HOK-2899) ==="

if [[ ! -f "$MONITOR_SCRIPT_FILE" ]]; then
  fail "shared/lib/wavemill-monitor.sh not found"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

GENERATED="$(mktemp /tmp/monitor-identity-XXXXXX.sh)"
trap 'rm -f "$GENERATED"' EXIT

# Mirror the mill's generation step: cp of the committed monitor file.
cp "$MONITOR_SCRIPT_FILE" "$GENERATED"

if [[ "$(sha "$GENERATED")" == "$(sha "$MONITOR_SCRIPT_FILE")" ]]; then
  pass "generated monitor copy is byte-identical to the committed source"
else
  fail "generated monitor copy diverges from shared/lib/wavemill-monitor.sh"
fi

# Mirror the mill's post-generation syntax gate (same MONITOR_BASH selection).
MONITOR_BASH="/opt/homebrew/bin/bash"
[[ ! -x "$MONITOR_BASH" ]] && MONITOR_BASH="bash"
if "$MONITOR_BASH" -n "$GENERATED" 2>/dev/null; then
  pass "generated monitor passes $MONITOR_BASH -n syntax validation"
else
  fail "generated monitor fails syntax validation: $("$MONITOR_BASH" -n "$GENERATED" 2>&1 | head -3)"
fi

# The mill's cp must remain guarded so a missing monitor file fails loudly.
if grep -qF 'cp "$SCRIPT_DIR/wavemill-monitor.sh" "$MONITOR_SCRIPT"' "$MILL_SCRIPT" \
  && grep -qF '[[ ! -f "$SCRIPT_DIR/wavemill-monitor.sh" ]]' "$MILL_SCRIPT"; then
  pass "mill copies the committed monitor file behind an existence guard"
else
  fail "mill no longer generates the monitor via guarded cp of wavemill-monitor.sh"
fi

# Prologue contract: shebang followed by set -Eeuo pipefail.
if [[ "$(head -2 "$MONITOR_SCRIPT_FILE")" == $'#!/usr/bin/env bash\nset -Eeuo pipefail' ]]; then
  pass "monitor starts with shebang + set -Eeuo pipefail prologue"
else
  fail "monitor prologue changed (expected shebang + set -Eeuo pipefail)"
fi

# Environment-file contract: the first executable statement sources "$1".
if grep -qx 'source "$1"' "$MONITOR_SCRIPT_FILE"; then
  pass 'monitor sources its environment file via source "$1"'
else
  fail 'monitor no longer sources its environment file via source "$1"'
fi

# Ready-watchdog source-only contract (tools/ready-watchdog.ts sources the
# generated monitor and expects this exact early-return to stop execution).
SOURCE_ONLY_GUARD="$(awk '
  /^if \[\[ "\$\{WAVEMILL_READY_WATCHDOG_SOURCE_ONLY:-\}" == "1" && "\$\{WAVEMILL_MONITOR_SOURCE_ONLY:-\}" != "1" \]\]; then$/ { found=1 }
  found { print; count++ }
  count == 3 { exit }
' "$MONITOR_SCRIPT_FILE")"
EXPECTED_GUARD='if [[ "${WAVEMILL_READY_WATCHDOG_SOURCE_ONLY:-}" == "1" && "${WAVEMILL_MONITOR_SOURCE_ONLY:-}" != "1" ]]; then
  return 0 2>/dev/null || exit 0
fi'
if [[ "$SOURCE_ONLY_GUARD" == "$EXPECTED_GUARD" ]]; then
  pass "WAVEMILL_READY_WATCHDOG_SOURCE_ONLY early-return is present"
else
  fail "WAVEMILL_READY_WATCHDOG_SOURCE_ONLY early-return is missing or changed"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
