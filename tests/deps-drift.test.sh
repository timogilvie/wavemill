#!/usr/bin/env bash
# HOK-3254: pins the stale-node_modules primitive against the 2026-10-19
# incident shape (lockfile at X, installed @hokusai/core at X-1) and the
# three fallback paths (matching install, pnpm, hidden-lockfile missing).
#
# Tests must only write to a tmp dir (HOK-3157 tracked-write guard).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() {
  echo "  FAIL  $1"
  if [[ "${2:-}" ]]; then echo "    detail: $2"; fi
  FAIL=$((FAIL + 1))
}

# shellcheck source=../shared/lib/deps-drift.sh
. "$REPO_DIR/shared/lib/deps-drift.sh"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

write_npm_fixture() {
  local dir="$1" lock_version="$2" installed_version="$3" with_hidden="${4:-1}"
  mkdir -p "$dir/node_modules/foo"
  cat >"$dir/package.json" <<EOF
{"name":"demo","version":"1.0.0","dependencies":{"foo":"^${lock_version}"}}
EOF
  cat >"$dir/package-lock.json" <<EOF
{"name":"demo","version":"1.0.0","lockfileVersion":3,"packages":{"":{"dependencies":{"foo":"^${lock_version}"}},"node_modules/foo":{"version":"${lock_version}"}}}
EOF
  if [[ "$with_hidden" == "1" ]]; then
    cat >"$dir/node_modules/.package-lock.json" <<EOF
{"name":"demo","version":"1.0.0","lockfileVersion":3,"packages":{"":{"dependencies":{"foo":"^${installed_version}"}},"node_modules/foo":{"version":"${installed_version}"}}}
EOF
  fi
  cat >"$dir/node_modules/foo/package.json" <<EOF
{"name":"foo","version":"${installed_version}"}
EOF
}

# ──────────── 1. drift (incident shape: lockfile 0.5.0, installed 0.4.0)
drift_dir="$workdir/drift"
write_npm_fixture "$drift_dir" "0.5.0" "0.4.0" 1
drift_json="$(deps_drift_check "$drift_dir" 2>/dev/null)" && drift_rc=0 || drift_rc=$?
if [[ "$drift_rc" == 1 ]]; then
  pass "drift exits 1 for lockfile vs installed mismatch"
else
  fail "drift exit code" "rc=$drift_rc json=$drift_json"
fi
drift_status="$(printf '%s' "$drift_json" | jq -r '.status')"
drift_reason="$(printf '%s' "$drift_json" | jq -r '.reason')"
drift_package="$(printf '%s' "$drift_json" | jq -r '.packages[0].name')"
[[ "$drift_status" == "drift" ]] && pass "drift status=drift" || fail "status" "status=$drift_status"
[[ "$drift_reason" == "install-mismatch" ]] && pass "drift reason set" || fail "reason" "reason=$drift_reason"
[[ "$drift_package" == "foo" ]] && pass "drift names the drifted package" || fail "package" "package=$drift_package"

# ──────────── 2. matching install
match_dir="$workdir/match"
write_npm_fixture "$match_dir" "0.5.0" "0.5.0" 1
match_json="$(deps_drift_check "$match_dir" 2>/dev/null)" && match_rc=0 || match_rc=$?
[[ "$match_rc" == 0 ]] && pass "matching install exits 0" || fail "match exit" "rc=$match_rc"
match_status="$(printf '%s' "$match_json" | jq -r '.status')"
[[ "$match_status" == "ok" ]] && pass "matching install status=ok" || fail "match status" "status=$match_status"

# ──────────── 3. pnpm reports unknown (never ok)
pnpm_dir="$workdir/pnpm"
mkdir -p "$pnpm_dir"
: >"$pnpm_dir/pnpm-lock.yaml"
pnpm_json="$(deps_drift_check "$pnpm_dir" 2>/dev/null)" && pnpm_rc=0 || pnpm_rc=$?
[[ "$pnpm_rc" == 2 ]] && pass "pnpm exits 2 (unknown)" || fail "pnpm exit" "rc=$pnpm_rc"
pnpm_status="$(printf '%s' "$pnpm_json" | jq -r '.status')"
[[ "$pnpm_status" == "unknown" ]] && pass "pnpm status=unknown" || fail "pnpm status" "status=$pnpm_status"

# ──────────── 4. hidden lockfile missing → checker still detects drift from physical metadata
fb_dir="$workdir/fallback"
write_npm_fixture "$fb_dir" "0.5.0" "0.4.0" 0
fb_json="$(deps_drift_check "$fb_dir" 2>/dev/null)" && fb_rc=0 || fb_rc=$?
[[ "$fb_rc" == 1 ]] && pass "fallback (no hidden lockfile) still detects drift" || fail "fallback exit" "rc=$fb_rc json=$fb_json"
fb_reason="$(printf '%s' "$fb_json" | jq -r '.reason')"
fb_package="$(printf '%s' "$fb_json" | jq -r '.packages[0].name')"
[[ "$fb_reason" == "install-mismatch" ]] && pass "fallback reason set" || fail "fallback reason" "reason=$fb_reason"
[[ "$fb_package" == "foo" ]] && pass "fallback names drifted package" || fail "fallback package" "package=$fb_package"

# ──────────── 5. node_modules missing entirely
nm_dir="$workdir/no-nm"
mkdir -p "$nm_dir"
cat >"$nm_dir/package.json" <<EOF
{"name":"demo","version":"1.0.0"}
EOF
cat >"$nm_dir/package-lock.json" <<EOF
{"name":"demo","version":"1.0.0","lockfileVersion":3,"packages":{}}
EOF
nm_json="$(deps_drift_check "$nm_dir" 2>/dev/null)" && nm_rc=0 || nm_rc=$?
[[ "$nm_rc" == 1 ]] && pass "missing node_modules exits 1" || fail "no-nm exit" "rc=$nm_rc"
nm_reason="$(printf '%s' "$nm_json" | jq -r '.reason')"
[[ "$nm_reason" == "node_modules-missing" ]] && pass "no-nm reason set" || fail "no-nm reason" "reason=$nm_reason"

# ──────────── 6. no lockfile at all → ok
blank_dir="$workdir/blank"
mkdir -p "$blank_dir"
blank_json="$(deps_drift_check "$blank_dir" 2>/dev/null)" && blank_rc=0 || blank_rc=$?
[[ "$blank_rc" == 0 ]] && pass "no lockfile exits 0" || fail "blank exit" "rc=$blank_rc"
blank_status="$(printf '%s' "$blank_json" | jq -r '.status')"
[[ "$blank_status" == "ok" ]] && pass "no lockfile status=ok" || fail "blank status" "status=$blank_status"

echo ""
echo "Totals: $PASS passed, $FAIL failed"
[[ "$FAIL" == 0 ]]
