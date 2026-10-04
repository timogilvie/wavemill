#!/usr/bin/env bash
# HOK-3036: managed Observer-to-Linear filing — deterministic, fail-closed,
# credential-safe service command construction.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "FAIL: $1"; exit 1; }
assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label — missing: $needle | actual: $haystack"
}
assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  [[ "$haystack" != *"$needle"* ]] || fail "$label — must not contain: $needle | actual: $haystack"
}
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  [[ "$expected" == "$actual" ]] || fail "$label — expected: $expected | actual: $actual"
}

# shellcheck disable=SC1090
source "$COMMON_SCRIPT"

SESSION="wavemill"
TOOLS_DIR="$REPO_DIR/tools"
WORK_REPO="$TMP_DIR/repo"
mkdir -p "$WORK_REPO"

# ── Command construction is distinct per mode ────────────────────────────────
off_cmd="$(wavemill_build_observer_loop_command "$SESSION" "$WORK_REPO" "$TOOLS_DIR" 120 240 off)"
shadow_cmd="$(wavemill_build_observer_loop_command "$SESSION" "$WORK_REPO" "$TOOLS_DIR" 120 240 shadow)"
live_cmd="$(wavemill_build_observer_loop_command "$SESSION" "$WORK_REPO" "$TOOLS_DIR" 120 240 live)"

assert_not_contains "off has no incident flag" "$off_cmd" "--file-incidents"
assert_contains "off keeps legacy dry-run" "$off_cmd" "--dry-run"

assert_contains "shadow files incidents" "$shadow_cmd" "--file-incidents"
assert_contains "shadow uses explicit shadow mode" "$shadow_cmd" "--incidents-mode=shadow"
assert_not_contains "shadow is not live" "$shadow_cmd" "--incidents-mode=live"

assert_contains "live files incidents" "$live_cmd" "--file-incidents"
assert_contains "live uses explicit live mode" "$live_cmd" "--incidents-mode=live"

# Default (no mode arg) is off — never silently live.
default_cmd="$(wavemill_build_observer_loop_command "$SESSION" "$WORK_REPO" "$TOOLS_DIR" 120 240)"
assert_not_contains "default builder omits incident filing" "$default_cmd" "--file-incidents"

# The credential is never embedded in any command text.
secret_cmd="$(LINEAR_API_KEY="sk-super-secret" wavemill_build_observer_loop_command "$SESSION" "$WORK_REPO" "$TOOLS_DIR" 120 240 live)"
assert_not_contains "live command never carries the key" "$secret_cmd" "sk-super-secret"
assert_not_contains "live command never names LINEAR_API_KEY" "$secret_cmd" "LINEAR_API_KEY"

# ── Credential readiness (boolean only, never printed) ───────────────────────
if ( unset LINEAR_API_KEY; wavemill_observer_linear_credential_ready "$WORK_REPO" ); then
  fail "credential should be unavailable with no env and no .env"
fi
printf 'LINEAR_API_KEY=sk-from-dotenv\n' > "$WORK_REPO/.env"
if ! ( unset LINEAR_API_KEY; wavemill_observer_linear_credential_ready "$WORK_REPO" ); then
  fail "credential should be available from .env"
fi

# ── Service-mode resolution is fail-closed ───────────────────────────────────
resolve() { wavemill_observer_linear_service_mode "$1" "$WORK_REPO"; }

# off / offline / default → off
assert_eq "explicit off → off" "off" "$(resolve '{"observer":{"linear":{"mode":"off"}}}')"
assert_eq "offline → off" "off" "$(resolve '{"observer":{"linear":{"mode":"offline"}}}')"
assert_eq "empty config → off" "off" "$(resolve '{}')"

# shadow requires a credential.
rm -f "$WORK_REPO/.env"
assert_eq "shadow without credential → off" "off" \
  "$(env -u LINEAR_API_KEY bash -c "source '$COMMON_SCRIPT'; wavemill_observer_linear_service_mode '{\"observer\":{\"linear\":{\"mode\":\"shadow\"}}}' '$WORK_REPO'")"
printf 'LINEAR_API_KEY=sk-from-dotenv\n' > "$WORK_REPO/.env"
assert_eq "shadow with credential → shadow" "shadow" "$(resolve '{"observer":{"linear":{"mode":"shadow"}}}')"

# live with unmet gates downgrades to shadow (credential present).
assert_eq "live missing routing/gates → shadow" "shadow" \
  "$(resolve '{"observer":{"linear":{"mode":"live"}}}')"

# live with full routing + all gates → live.
full='{"observer":{"linear":{"mode":"live","team":"HOK","project":"Wavemill","label":"obs","rollout":{"gatesPassed":true,"shadowTrialCompleted":true,"rollbackRehearsed":true,"maxProposedPerPass":5}}}}'
assert_eq "live fully gated → live" "live" "$(resolve "$full")"

# live fully gated but no credential → off (fail closed, no restart storm).
assert_eq "live gated but no credential → off" "off" \
  "$(env -u LINEAR_API_KEY bash -c "source '$COMMON_SCRIPT'; rm -f '$WORK_REPO/.env'; wavemill_observer_linear_service_mode '$full' '$WORK_REPO'")"

echo "observer managed filing tests passed"
