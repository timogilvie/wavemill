#!/usr/bin/env bash
# HOK-3177 — refresh the dashboard reliability cache off-render.
#
# Writes a JSON blob to /tmp/wavemill-${SESSION}-reliability.json by invoking
# `tools/report-reliability.ts --json`. flock-guards concurrent refreshes.
#
# Usage: wavemill-reliability-refresh.sh [--repo-dir <path>] [--cache-dir <path|none>]
#
# Env:
#   WAVEMILL_SESSION           Session name (required)
#   WAVEMILL_INSTALL_DIR       Install root (contains tools/, shared/)
#   WAVEMILL_MILLED_REPO_DIR   Repo under test (passed as --repo-dir)
#   WAVEMILL_SESSION_REPO_CACHE   Session repo cache (default: /tmp/${SESSION}-repo.json)
#   WAVEMILL_RELIABILITY_WINDOW   Window spec (default: 14d)
#   WAVEMILL_RELIABILITY_BUCKET   Bucket (default: rolling7d)
#
# HOK-3245: the repo is resolved, first non-empty git worktree wins, from
# --repo-dir, WAVEMILL_MILLED_REPO_DIR, the session repo cache's `.repoDir`
# (the repo this session's monitor mills), REPO_DIR, then $PWD. The tool
# stamps the resolved repo into the JSON so the dashboard can label it.
#
# Exit 0 on success or when another refresh is already running; non-zero only
# on hard failure (invocation itself threw). Stale cache is left in place.

set -euo pipefail

ARG_REPO_DIR=""
CACHE_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir) ARG_REPO_DIR="${2:-}"; shift 2 ;;
    --cache-dir) CACHE_DIR="${2:-}"; shift 2 ;;
    *)
      echo "wavemill-reliability-refresh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

SESSION="${WAVEMILL_SESSION:-}"
if [[ -z "$SESSION" ]]; then
  echo "wavemill-reliability-refresh: WAVEMILL_SESSION not set" >&2
  exit 2
fi

INSTALL_DIR="${WAVEMILL_INSTALL_DIR:-}"
if [[ -z "$INSTALL_DIR" ]]; then
  SOURCE="${BASH_SOURCE[0]}"
  while [[ -L "$SOURCE" ]]; do
    DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
    SOURCE="$(readlink "$SOURCE")"
    [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
  done
  INSTALL_DIR="$(cd "$(dirname "$SOURCE")/../.." && pwd)"
fi

is_git_worktree() {
  [[ -n "$1" && -d "$1" ]] && git -C "$1" rev-parse --git-dir >/dev/null 2>&1
}

session_cache_repo_dir() {
  local cache="${WAVEMILL_SESSION_REPO_CACHE:-/tmp/${SESSION}-repo.json}"
  [[ -r "$cache" ]] && command -v jq >/dev/null 2>&1 || return 0
  jq -r 'if type == "object" then (.repoDir // empty) else empty end' "$cache" 2>/dev/null || true
}

RESOLVED_REPO_DIR=""
for candidate in "$ARG_REPO_DIR" "${WAVEMILL_MILLED_REPO_DIR:-}" "$(session_cache_repo_dir)" "${REPO_DIR:-}" "$PWD"; do
  if is_git_worktree "$candidate"; then
    RESOLVED_REPO_DIR="$candidate"
    break
  fi
done
# No repo to measure: leave the cache alone; the dashboard renders "…".
[[ -n "$RESOLVED_REPO_DIR" ]] || exit 0
WINDOW="${WAVEMILL_RELIABILITY_WINDOW:-14d}"
BUCKET="${WAVEMILL_RELIABILITY_BUCKET:-rolling7d}"

CACHE_FILE="/tmp/wavemill-${SESSION}-reliability.json"
LOCK_FILE="/tmp/wavemill-${SESSION}-reliability.lock"
TMP_FILE="${CACHE_FILE}.tmp.$$"

cleanup() {
  rm -f "$TMP_FILE" 2>/dev/null || true
}
trap cleanup EXIT

# Non-blocking: skip if another refresh already holds the lock.
exec 9> "$LOCK_FILE" || exit 0
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || exit 0
fi

TOOL="$INSTALL_DIR/tools/report-reliability.ts"
if [[ ! -f "$TOOL" ]]; then
  echo "wavemill-reliability-refresh: tool missing: $TOOL" >&2
  exit 1
fi

TOOL_ARGS=(--since "$WINDOW" --bucket "$BUCKET" --json --repo-dir "$RESOLVED_REPO_DIR")
[[ -n "$CACHE_DIR" ]] && TOOL_ARGS+=(--cache-dir "$CACHE_DIR")

if ! npx --prefix "$INSTALL_DIR" --yes tsx "$TOOL" "${TOOL_ARGS[@]}" > "$TMP_FILE" 2>/dev/null; then
  # Leave the stale cache in place on failure; dashboard will render "…".
  exit 0
fi

mv "$TMP_FILE" "$CACHE_FILE"
exit 0
