#!/usr/bin/env bash
# HOK-3361 replay fixture (HOK-3371): a stand-in for stamp-pr-route.ts whose
# FIRST invocation fails with the incident's deterministic contract error, and
# whose later invocations delegate to the real tool (the mill after an
# operator reconstructed the evidence).
#
# Set FAKE_STAMP_CALLS_FILE to a scratch path (never a tracked repo path) and,
# for delegation, FAKE_STAMP_REAL_TOOL to the tool to exec after the first
# call.
set -euo pipefail

CALLS_FILE="${FAKE_STAMP_CALLS_FILE:?FAKE_STAMP_CALLS_FILE is required (scratch path)}"
mkdir -p "$(dirname "$CALLS_FILE")"
touch "$CALLS_FILE"

calls="$(wc -l < "$CALLS_FILE" | tr -d ' ')"
if (( calls == 0 )); then
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$CALLS_FILE"
  echo "Expected resolved_model for planner inherited" >&2
  exit 1
fi

printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$CALLS_FILE"
exec "${FAKE_STAMP_REAL_TOOL:?FAKE_STAMP_REAL_TOOL is required for the recovery call}" "$@"