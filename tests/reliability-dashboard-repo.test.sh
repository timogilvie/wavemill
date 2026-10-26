#!/usr/bin/env bash
# HOK-3245: the dashboard reliability line labels the repo it measured and
# shows mill-only beside all-PR rates; the refresher resolves the repo from
# --repo-dir, WAVEMILL_MILLED_REPO_DIR, the session repo cache, REPO_DIR, $PWD.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS_LIB="$ROOT/shared/lib/wavemill-status.sh"
REFRESH="$ROOT/shared/lib/wavemill-reliability-refresh.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

extract_function() {
  awk -v name="$2" '
    $0 ~ ("^" name "\\(\\)") { capture=1; found=1 }
    capture { print }
    capture && /^}/ { exit }
    END { if (!found) exit 1 }
  ' "$1"
}
extract_function "$STATUS_LIB" reliability_dashboard_line > "$tmp/funcs.sh"
extract_function "$STATUS_LIB" _reliability_fmt_rate >> "$tmp/funcs.sh"
# shellcheck source=/dev/null
source "$tmp/funcs.sh"

SESSION="wm-rel-test-$$"
cache_file="/tmp/wavemill-${SESSION}-reliability.json"
trap 'rm -rf "$tmp" "$cache_file"' EXIT

# ── Dashboard line ───────────────────────────────────────────────────────────
jq -n '{repoDir: "/Users/x/wavemill", overall: {merged: 49},
  buckets: [{merged: 49, unattendedRate: 0.204, stuckP50Ms: 4320000, stuckP90Ms: 68400000,
             millMerged: 39, millUnattendedRate: 0.256}]}' > "$cache_file"
line="$(reliability_dashboard_line)"
[[ "$line" == "7d unattended (wavemill): mill 25.6% · all 20.4% · stuck p50 72m · p90 1140m (39/49 merged)" ]] \
  || fail "dashboard line: $line"

# A cache written before HOK-3245 still renders (no label, mill N/A).
jq -n '{overall: {merged: 3}, buckets: [{merged: 3, unattendedRate: 0.5, stuckP50Ms: 0, stuckP90Ms: 0}]}' > "$cache_file"
line="$(reliability_dashboard_line)"
[[ "$line" == "7d unattended: mill N/A · all 50.0% · stuck p50 0m · p90 0m (0/3 merged)" ]] \
  || fail "legacy dashboard line: $line"

# ── Refresher repo resolution ────────────────────────────────────────────────
# A fake install plus an `npx` on PATH that echoes its argv as JSON, so the
# refresher's tool invocation is observable without node or the network.
install="$tmp/install"
mkdir -p "$install/tools" "$tmp/bin"
: > "$install/tools/report-reliability.ts"
cat > "$tmp/bin/npx" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" | jq -R . | jq -s '{argv: .}'
EOF
chmod +x "$tmp/bin/npx"
export PATH="$tmp/bin:$PATH"

mkrepo() { mkdir -p "$1" && git -C "$1" init -q; }
mkrepo "$tmp/session-repo"
mkrepo "$tmp/env-repo"
mkrepo "$tmp/arg-repo"
mkrepo "$tmp/pwd-repo"
session_cache="$tmp/session-repo.json"

refresh() {
  (cd "$tmp/pwd-repo" && env -u WAVEMILL_MILLED_REPO_DIR -u REPO_DIR \
    WAVEMILL_SESSION="$SESSION" WAVEMILL_INSTALL_DIR="$install" WAVEMILL_SESSION_REPO_CACHE="$session_cache" \
    "$@")
  jq -r '.argv | . as $a | (index("--repo-dir") + 1) as $i | $a[$i]' "$cache_file"
}
cache_dir_arg() { jq -r '.argv | . as $a | (index("--cache-dir") // -1) as $i | if $i < 0 then "unset" else $a[$i + 1] end' "$cache_file"; }

# No env, no arg, no session cache → $PWD.
rm -f "$session_cache"
got="$(refresh bash "$REFRESH")"; [[ "$got" == "$tmp/pwd-repo" ]] || fail "PWD fallback: $got"

# Session repo cache beats REPO_DIR and $PWD (the dashboard's case).
jq -n --arg dir "$tmp/session-repo" '{repoDir: $dir, nameWithOwner: "acme/site"}' > "$session_cache"
[[ "$(refresh env REPO_DIR="$tmp/env-repo" bash "$REFRESH")" == "$tmp/session-repo" ]] || fail "session cache fallback"
[[ "$(cache_dir_arg)" == "unset" ]] || fail "--cache-dir passed when not given"

# A session cache naming a non-repo falls through.
jq -n '{repoDir: "/nonexistent/repo"}' > "$session_cache"
[[ "$(refresh env REPO_DIR="$tmp/env-repo" bash "$REFRESH")" == "$tmp/env-repo" ]] || fail "stale session cache should fall through"

# WAVEMILL_MILLED_REPO_DIR beats the session cache; --repo-dir beats both.
jq -n --arg dir "$tmp/session-repo" '{repoDir: $dir}' > "$session_cache"
[[ "$(refresh env WAVEMILL_MILLED_REPO_DIR="$tmp/env-repo" bash "$REFRESH")" == "$tmp/env-repo" ]] || fail "env override"
[[ "$(refresh env WAVEMILL_MILLED_REPO_DIR="$tmp/env-repo" bash "$REFRESH" --repo-dir "$tmp/arg-repo" --cache-dir none)" == "$tmp/arg-repo" ]] \
  || fail "--repo-dir override"
[[ "$(cache_dir_arg)" == "none" ]] || fail "--cache-dir not forwarded"

# Unknown flags are rejected.
set +e
WAVEMILL_SESSION="$SESSION" bash "$REFRESH" --bogus >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" == "2" ]] || fail "unknown flag exit code: $rc"

echo "reliability-dashboard-repo test passed"
