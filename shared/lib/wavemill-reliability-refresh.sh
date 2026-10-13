#!/usr/bin/env bash
# HOK-3177 — refresh the dashboard reliability cache off-render.
#
# Writes a JSON blob to /tmp/wavemill-${SESSION}-reliability.json by invoking
# `tools/report-reliability.ts --json`. flock-guards concurrent refreshes.
#
# Env:
#   WAVEMILL_SESSION           Session name (required)
#   WAVEMILL_INSTALL_DIR       Install root (contains tools/, shared/)
#   WAVEMILL_MILLED_REPO_DIR   Repo under test (passed as --repo-dir)
#   WAVEMILL_RELIABILITY_WINDOW   Window spec (default: 14d)
#   WAVEMILL_RELIABILITY_BUCKET   Bucket (default: rolling7d)
#
# Exit 0 on success or when another refresh is already running; non-zero only
# on hard failure (invocation itself threw). Stale cache is left in place.

set -euo pipefail

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

REPO_DIR="${WAVEMILL_MILLED_REPO_DIR:-${REPO_DIR:-$PWD}}"
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

if ! npx --prefix "$INSTALL_DIR" --yes tsx "$TOOL" \
  --since "$WINDOW" --bucket "$BUCKET" --json --repo-dir "$REPO_DIR" > "$TMP_FILE" 2>/dev/null; then
  # Leave the stale cache in place on failure; dashboard will render "…".
  exit 0
fi

mv "$TMP_FILE" "$CACHE_FILE"
exit 0
