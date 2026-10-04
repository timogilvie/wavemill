#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
INPUT_READER="$REPO_DIR/shared/lib/wavemill-input-reader.sh"

source "$COMMON_SCRIPT"

case_counter=0
SESSION=""
COMMAND_FILE=""

cleanup_command_file() {
  [[ -n "$COMMAND_FILE" ]] && rm -f "$COMMAND_FILE"
  return 0
}
trap cleanup_command_file EXIT

run_reader_line() {
  local input="$1"
  case_counter=$((case_counter + 1))
  SESSION="input-reader-test-$$-$case_counter"
  COMMAND_FILE="$(wavemill_command_file_path "$SESSION")"
  rm -f "$COMMAND_FILE"

  printf '%s\n' "$input" | WAVEMILL_INPUT_PENDING_SLEEP=0 "$INPUT_READER" "$SESSION" >/dev/null
}

assert_commands() {
  local label="$1" expected="$2" actual=""
  [[ -f "$COMMAND_FILE" ]] && actual="$(cat "$COMMAND_FILE")"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
  rm -f "$COMMAND_FILE"
  COMMAND_FILE=""
}

assert_reader_line() {
  local label="$1" input="$2" expected="$3"
  run_reader_line "$input"
  assert_commands "$label" "$expected"
}

assert_reader_line "arrow-prefixed selection" $'\033[B1' "select 1"

for direction in A B C D; do
  assert_reader_line "CSI arrow $direction before selection" "$(printf '\033[%s1' "$direction")" "select 1"
done

for direction in A B C D; do
  assert_reader_line "SS3 arrow $direction before selection" "$(printf '\033O%s1' "$direction")" "select 1"
done

assert_reader_line "modified CSI arrow before selection" $'\033[1;2B1' "select 1"
assert_reader_line "multiple arrows around selection" $'\033[A1\033[B 3\033[C' "select 1 3"
assert_reader_line "arrow-only input is no-op" $'\033[A' ""
assert_reader_line "whitespace plus arrows is no-op" $' \t\033[B  \033OC ' ""
assert_reader_line "true blank line remains enter" "" "enter"

assert_reader_line "single selection unchanged" "1" "select 1"
assert_reader_line "multi-selection unchanged" "1 3" "select 1 3"
assert_reader_line "m shorthand unchanged" "m" "more"
assert_reader_line "more command unchanged" "more" "more"
assert_reader_line "q shorthand unchanged" "q" "quit"
assert_reader_line "quit command unchanged" "quit" "quit"
assert_reader_line "advance command unchanged" "advance HOK-1639" "advance HOK-1639"
assert_reader_line "re-review command normalization unchanged" "  Re-Review   HOK-2999_c  " "re-review HOK-2999_c"

assert_reader_line "malformed CSI remains unknown" $'\033[X1' "$(printf 'unknown \033[X1')"
assert_reader_line "non-arrow CSI remains unknown" $'\033[31m1' "$(printf 'unknown \033[31m1')"
assert_reader_line "non-arrow control input remains unknown" $'\0011' "$(printf 'unknown \0011')"

echo "PASS: input reader sanitizes arrow keys without broad control stripping"
