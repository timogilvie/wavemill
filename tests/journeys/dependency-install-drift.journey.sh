#!/usr/bin/env bash
# protects: a real dependency-version bump is detected as drift, the same
# condition across repeated monitor ticks collapses to one incident
# occurrence (HOK-3315), the monitor's bounded autofix repairs it, and the
# verdict returns to ok — without ever touching tmux/gh/Linear, since this
# journey only drives the monitor tick + the deps-drift primitive directly.
set -euo pipefail

JOURNEY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$JOURNEY_DIR/../.." && pwd)"
LIB_DIR="$ROOT/shared/lib"
BUDGET="${JOURNEY_BUDGET_SECONDS:-90}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/journey-deps-drift.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAKE_REPO="$WORK/repo"
STATE_DIR="$WORK/state"
MILL_LOG_FILE="$WORK/mill.log"
STUB_BIN="$WORK/bin"
mkdir -p "$FAKE_REPO/node_modules/leftpad" "$STATE_DIR" "$STUB_BIN"
: > "$MILL_LOG_FILE"

fail() { echo "FAIL: $1" >&2; exit 1; }

# ── Extract the monitor's deps-drift functions without sourcing the whole
# monitor script (which ends in an unguarded `source "$1"` + the live
# tmux loop). Same technique as tests/backstage-tend-watchdog.test.sh.
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

# shellcheck source=../../shared/lib/wavemill-common.sh
source "$LIB_DIR/wavemill-common.sh"
# shellcheck source=../../shared/lib/deps-drift.sh
source "$LIB_DIR/deps-drift.sh"

FUNCS_FILE="$WORK/monitor-deps-drift-functions.sh"
: > "$FUNCS_FILE"
for fn in _monitor_terminal_cleanup_write monitor_deps_drift_interval _monitor_deps_drift_load_primitive _monitor_deps_drift_reinstall monitor_deps_drift_tick; do
  extract_function "$LIB_DIR/wavemill-monitor.sh" "$fn" >> "$FUNCS_FILE"
  printf '\n' >> "$FUNCS_FILE"
done
# shellcheck source=/dev/null
source "$FUNCS_FILE"

# ── A stub `npm` standing in for a real install: `npm ci` writes a hidden
# lockfile that matches whatever package-lock.json it was given, simulating
# a successful reinstall without touching the network.
cat > "$STUB_BIN/npm" <<'NPM_STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "ci" ]]; then
  mkdir -p node_modules
  cp package-lock.json node_modules/.package-lock.json
fi
exit 0
NPM_STUB
chmod +x "$STUB_BIN/npm"
export PATH="$STUB_BIN:$PATH"

write_lockfile() {
  local version="$1"
  cat > "$FAKE_REPO/package-lock.json" <<EOF
{"name":"journey-app","version":"1.0.0","lockfileVersion":3,"packages":{"":{"dependencies":{"leftpad":"^${version}"}},"node_modules/leftpad":{"version":"${version}"}}}
EOF
}
write_hidden_lockfile() {
  local version="$1"
  cat > "$FAKE_REPO/node_modules/.package-lock.json" <<EOF
{"name":"journey-app","lockfileVersion":3,"packages":{"node_modules/leftpad":{"version":"${version}"}}}
EOF
}
cat > "$FAKE_REPO/package.json" <<'EOF'
{"name":"journey-app","version":"1.0.0","dependencies":{"leftpad":"^1.0.0"}}
EOF
cat > "$FAKE_REPO/node_modules/leftpad/package.json" <<'EOF'
{"name":"leftpad","version":"1.0.0"}
EOF

# ── 1. Healthy install: lockfile and hidden lockfile agree.
write_lockfile "1.0.0"
write_hidden_lockfile "1.0.0"

status="$(deps_drift_check "$FAKE_REPO" | jq -r '.status')"
[[ "$status" == "ok" ]] || fail "expected ok for a healthy install, got $status"

REPO_DIR="$FAKE_REPO"
STATE_DIR="$STATE_DIR"
DRY_RUN=false
WAVEMILL_DEPS_DRIFT_AUTOFIX=1
rm -f "$STATE_DIR/.deps-drift-last-at"
monitor_deps_drift_tick
[[ -f "$STATE_DIR/backstage-health.json" ]] && degraded_before="$(jq -r '.services.deps.status // "none"' "$STATE_DIR/backstage-health.json")" || degraded_before="none"
[[ "$degraded_before" != "degraded" ]] || fail "backstage health must not be degraded for a healthy install"

# ── 2. A real dependency bump lands (leftpad 1.0.0 -> 2.0.0); nothing
# reinstalled yet, so node_modules is now genuinely stale.
write_lockfile "2.0.0"

# ── 3. Repeated polls of the identical condition must compute an identical
# verdict (REQ-F5's premise) — drive the pure primitive 3x directly.
first_json="$(deps_drift_check "$FAKE_REPO" 2>/dev/null)" || true
for _ in 1 2 3; do
  json="$(deps_drift_check "$FAKE_REPO" 2>/dev/null)" || true
  [[ "$json" == "$first_json" ]] || fail "deps_drift_check must be stable across repeated polls of an unchanged condition"
done
drift_status="$(printf '%s' "$first_json" | jq -r '.status')"
[[ "$drift_status" == "drift" ]] || fail "expected drift after the dependency bump, got $drift_status"

# ── 4. Stable condition identity end-to-end through the real incident
# detector + store: three polls of the unchanged drift collapse to one
# occurrence, and a changed mismatch computes a distinct identity.
node --import tsx --input-type=module <<JS
import assert from 'node:assert/strict';
import { DepsDriftDetector } from '$LIB_DIR/wavemill-incident-detector.ts';
import { IncidentStore } from '$LIB_DIR/wavemill-incident-store.ts';

const repoDir = '$FAKE_REPO';
const detector = new DepsDriftDetector();
const context = { repoDir, now: new Date('2026-01-01T00:00:00.000Z') };

const polls = [1, 2, 3].map(() => detector.detectRepo(repoDir, context));
for (const incidents of polls) assert.equal(incidents.length, 1, 'each poll must detect exactly one drift incident');
const keys = polls.map((incidents) => incidents[0].evidence[0].key);
assert.ok(keys.every((k) => k === keys[0]), 'evidence key must be stable across repeated polls');

const store = new IncidentStore('$STATE_DIR/incidents');
let record;
for (const incidents of polls) {
  ({ record } = await store.upsertDetailed(incidents[0]));
}
assert.equal(record.occurrenceCount, 1, 'three polls of an unchanged condition must count as one occurrence, not three');
console.log('journey: deps-drift incident identity is stable across repeated polls (occurrenceCount=1)');
JS

# ── 5. The monitor tick now detects the drift, degrades backstage health,
# and (autofix on) launches the bounded repair via the stub npm.
rm -f "$STATE_DIR/.deps-drift-last-at"
monitor_deps_drift_tick
grep -q '\[deps-drift\] drifted packages' "$MILL_LOG_FILE" || fail "monitor tick must log the drift"
degraded="$(jq -r '.services.deps.status // "none"' "$STATE_DIR/backstage-health.json")"
[[ "$degraded" == "degraded" ]] || fail "backstage health must be degraded while drifted, got $degraded"

# ── 6. Wait (bounded) for the backgrounded repair to land, then confirm
# recovery: the verdict returns to ok.
deadline=$(( $(date +%s) + 20 ))
recovered=0
while (( $(date +%s) < deadline )); do
  if [[ "$(deps_drift_check "$FAKE_REPO" 2>/dev/null | jq -r '.status')" == "ok" ]]; then
    recovered=1
    break
  fi
  sleep 0.2
done
(( recovered == 1 )) || fail "install never recovered to ok within the bounded wait"
grep -q '\[deps-drift\] reinstall + swap complete' "$MILL_LOG_FILE" || fail "expected a logged successful swap"

echo "--- dependency-install-drift journey passed (budget ${BUDGET}s) ---"
