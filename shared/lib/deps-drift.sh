#!/usr/bin/env bash
# HOK-3315 — semantic npm-install verdict (shell adapter).
#
# Thin wrapper around tools/deps-drift.ts. Runs the canonical TS checker
# using wavemill_run_tool and maps exit codes.
#
# Exit codes:
#   0 — no drift (lockfile matches install or no lockfile)
#   1 — drift detected (packages printed as JSON on stdout)
#   2 — unknown (pnpm/yarn, corrupt metadata, or checker unavailable)

# deps_drift_check <dir> [--os X --cpu Y --libc Z --omit a,b]
# Calls the TS checker and prints one-line JSON on stdout.
deps_drift_check() {
  local dir="${1:-.}"
  shift || true

  local output tool_path

  # Try to use wavemill_run_tool if available
  if declare -f wavemill_run_tool >/dev/null 2>&1; then
    output="$(wavemill_run_tool deps-drift.ts "$dir" "$@" 2>/dev/null)" || {
      printf '{"status":"unknown","reason":"checker-unavailable","packages":[]}\n'
      return 2
    }
  else
    # Fall back to plain Node with experimental-strip-types
    # Find tools/deps-drift.ts relative to this script (shared/lib -> tools)
    local script_dir root_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    root_dir="$(cd "$script_dir/../.." && pwd)"
    tool_path="$root_dir/tools/deps-drift.ts"
    if [[ ! -f "$tool_path" ]]; then
      printf '{"status":"unknown","reason":"checker-unavailable","packages":[]}\n'
      return 2
    fi
    output="$(node --experimental-strip-types "$tool_path" "$dir" "$@" 2>/dev/null)" || {
      printf '{"status":"unknown","reason":"checker-unavailable","packages":[]}\n'
      return 2
    }
  fi

  # Validate JSON and extract status
  if ! echo "$output" | jq -e '.status' >/dev/null 2>&1; then
    printf '{"status":"unknown","reason":"checker-unavailable","packages":[]}\n'
    return 2
  fi

  echo "$output"

  # Map status to exit code
  local status
  status="$(echo "$output" | jq -r '.status')"
  case "$status" in
    ok) return 0 ;;
    drift) return 1 ;;
    unknown) return 2 ;;
    *) return 2 ;;
  esac
}

# Stub for backward compatibility (no longer used; monitor reads lockfileHash from JSON)
deps_lockfile_fingerprint() {
  return 0
}
