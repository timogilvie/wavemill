#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
INPUT_READER="$REPO_DIR/shared/lib/wavemill-input-reader.sh"

source "$COMMON_SCRIPT"

SESSION="input-reader-rereview-$$"
COMMAND_FILE="$(wavemill_command_file_path "$SESSION")"
rm -f "$COMMAND_FILE"
trap 'rm -f "$COMMAND_FILE"' EXIT

printf '  Re-Review   HOK-2999_c  \n' | WAVEMILL_INPUT_PENDING_SLEEP=0 "$INPUT_READER" "$SESSION" >/dev/null

actual="$(tail -n 1 "$COMMAND_FILE")"
if [[ "$actual" != "re-review HOK-2999_c" ]]; then
  echo "FAIL: re-review prompt input normalization"
  echo "  expected: re-review HOK-2999_c"
  echo "  actual:   $actual"
  exit 1
fi

echo "PASS: re-review prompt input normalization"
