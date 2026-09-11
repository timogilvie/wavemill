#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wavemill-common.sh"

session="${1:-${WAVEMILL_SESSION:-}}"
if [[ -z "$session" ]]; then
  echo "Error: session required (arg1 or WAVEMILL_SESSION)" >&2
  exit 1
fi

cmd_file="$(wavemill_command_file_path "$session")"
: >> "$cmd_file"

normalize_line() {
  local raw="$1"
  printf '%s' "$raw" | awk '{$1=$1; print}'
}

while :; do
  printf 'mill> '
  if ! IFS= read -r line; then
    exit 0
  fi

  line="$(normalize_line "$line")"

  shopt -s nocasematch
  event=""
  if [[ -z "$line" ]]; then
    event="enter"
  elif [[ "$line" =~ ^[0-9]+([[:space:]]+[0-9]+)*$ ]]; then
    event="select $line"
  elif [[ "$line" =~ ^advance[[:space:]]+.+$ ]]; then
    event="advance ${line#* }"
  elif [[ "$line" =~ ^re-review[[:space:]]+.+$ ]]; then
    event="re-review ${line#* }"
  elif [[ "$line" == "m" || "$line" == "more" ]]; then
    event="more"
  elif [[ "$line" == "q" || "$line" == "quit" || "$line" == "exit" ]]; then
    event="quit"
  else
    event="unknown $line"
  fi
  shopt -u nocasematch

  printf '%s\n' "$event" >> "$cmd_file"

  case "$event" in
    select\ *|enter)
      printf '\nPending...\n'
      sleep "${WAVEMILL_INPUT_PENDING_SLEEP:-2}"
      ;;
  esac
done
