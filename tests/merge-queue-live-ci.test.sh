#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INPUT_FILE="$(mktemp)"
OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$INPUT_FILE" "$OUTPUT_FILE"' EXIT

cat >"$INPUT_FILE" <<'JSON'
{
  "now": "2026-08-21T20:00:00Z",
  "config": {
    "enabled": true,
    "maxConcurrentCandidates": 1,
    "stuckTimeoutSeconds": 900,
    "conflictGroupingEnabled": true,
    "skipCooldownSeconds": 60
  },
  "readyPrs": [
    {
      "issue": "HOK-2850",
      "slug": "partial-ci",
      "prNumber": 1186,
      "branch": "task/partial-ci",
      "queueState": "ready",
      "changedFiles": ["shared/lib/wavemill-mill.sh"],
      "readyAt": "2026-08-21T19:31:00Z",
      "workflowStatus": "ready",
      "prState": "OPEN",
      "labels": ["wm:ready"],
      "ci": {
        "conclusion": "pending",
        "headSha": "3e6ae104",
        "mergeStateStatus": "BLOCKED",
        "observed": 1,
        "required": 15,
        "failing": []
      }
    }
  ]
}
JSON

node --import tsx "$REPO_DIR/tools/merge-queue-select.ts" --input "$INPUT_FILE" >"$OUTPUT_FILE"

if [[ "$(jq -r '.selectedIssues | length' "$OUTPUT_FILE")" != "0" ]]; then
  echo "partial live CI was promoted" >&2
  cat "$OUTPUT_FILE" >&2
  exit 1
fi

if grep -q 'clean/green' "$REPO_DIR/shared/lib/wavemill-mill.sh"; then
  echo "stale clean/green wording remains in mill logs" >&2
  exit 1
fi

echo "merge queue live CI regression passed"
