#!/usr/bin/env bash
# HOK-3254 / HOK-3315 — stale node_modules detector.
#
# Thin shell wrapper over the one semantic verdict (shared/lib/deps-drift.ts),
# shared across the worktree helpers (startup), the monitor tick (REPO_DIR),
# and the observer repo detector (TS twin). There is exactly one
# implementation; this file never compares lockfiles itself.
#
# Exit codes (unchanged contract):
#   0 — no drift (either matching install state, or no lockfile at all)
#   1 — drift detected (reason + packages printed as JSON on stdout)
#   2 — unknown (pnpm / yarn, unreadable metadata, or node/CLI missing).
#       Never claim `ok` when the verdict can't be computed.
#
# Output on drift (status=drift) is a single JSON line:
#   {"status":"drift","reason":"...","packages":[{...}],"platform":"...","arch":"..."}

# Emit a short JSON doc for a drift verdict. Packages come in as a
# jq-compatible JSON array string; empty when unavailable.
_deps_drift_emit() {
  local st="$1" reason="$2" packages_json="${3:-[]}"
  jq -cn \
    --arg status "$st" \
    --arg reason "$reason" \
    --argjson packages "$packages_json" \
    '{status: $status, reason: $reason, packages: $packages}' 2>/dev/null \
    || printf '{"status":"%s","reason":"%s","packages":[]}\n' "$st" "$reason"
}

# deps_drift_check <dir>
# Prints the verdict JSON on stdout and exits with 0/1/2 as above. Delegates
# entirely to deps-drift-cli.ts; Node's type-stripping runs the TS source
# directly, so this works before `npm install` has ever completed.
deps_drift_check() {
  local dir="${1:-.}"
  [[ -d "$dir" ]] || { _deps_drift_emit ok "no-dir"; return 0; }

  local cli="${BASH_SOURCE[0]%/*}/deps-drift-cli.ts"
  if ! command -v node >/dev/null 2>&1 || [[ ! -f "$cli" ]]; then
    _deps_drift_emit unknown "node-or-cli-missing"
    return 2
  fi

  local out rc=0
  out="$(node --experimental-strip-types --disable-warning=ExperimentalWarning "$cli" "$dir" 2>/dev/null)" || rc=$?
  if [[ -z "$out" ]]; then
    _deps_drift_emit unknown "cli-no-output"
    return 2
  fi
  printf '%s\n' "$out"
  return "$rc"
}

# deps_lockfile_fingerprint <dir>
# A compact hash of the current lockfile, used by callers as a bounded-retry
# key so a fresh dependency bump resets the attempt counter. This is the one
# place byte identity of package-lock.json is legitimate: a cache/retry key,
# never a drift verdict. Prints the hash on stdout, or nothing when no
# lockfile or no hash tool is available.
deps_lockfile_fingerprint() {
  local dir="${1:-.}"
  local lock="$dir/package-lock.json"
  [[ -f "$lock" ]] || return 0
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$lock" 2>/dev/null | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$lock" 2>/dev/null | awk '{print $1}'
  fi
}
