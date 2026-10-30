#!/usr/bin/env bash
# HOK-3315 — semantic npm-install verdict (shell adapter).
#
# Thin wrapper around tools/deps-drift.ts. Runs the canonical TS checker.
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

  local output tool_path status

  # Try to find the tool relative to cwd or standard locations
  if [[ -f "tools/deps-drift.ts" ]]; then
    tool_path="tools/deps-drift.ts"
  elif [[ -f "$(pwd)/tools/deps-drift.ts" ]]; then
    tool_path="$(pwd)/tools/deps-drift.ts"
  elif [[ -f "${0%/*}/../../tools/deps-drift.ts" ]]; then
    tool_path="${0%/*}/../../tools/deps-drift.ts"
  else
    # Can't find tool and wavemill_run_tool might not work in worktrees
    printf '{"status":"unknown","reason":"checker-unavailable","packages":[]}\n'
    return 2
  fi

  # Run the tool with plain Node (works in worktrees and when tsx is stale)
  # Note: tool returns exit code 1 for drift, so we can't use "if output=..."; instead capture output and validate
  output="$(node --experimental-strip-types "$tool_path" "$dir" "$@" 2>/dev/null)"

  # Validate JSON and extract status
  if echo "$output" | jq -e '.status' >/dev/null 2>&1; then
    echo "$output"
    status="$(echo "$output" | jq -r '.status')"
    case "$status" in
      ok) return 0 ;;
      drift) return 1 ;;
      unknown) return 2 ;;
      *) return 2 ;;
    esac
  fi

  # Tool execution or validation failed
  printf '{"status":"unknown","reason":"checker-unavailable","packages":[]}\n'
  return 2
}

# Stub for backward compatibility (no longer used; monitor reads lockfileHash from JSON)
deps_lockfile_fingerprint() {
  return 0
}
