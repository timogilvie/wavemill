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

strip_arrow_key_sequences() {
  local raw="$1"
  local remaining="$raw"
  local output="" first match
  local esc=$'\033'
  local csi_arrow_re="^${esc}\\[[0-9;]*[ABCD]"
  local ss3_arrow_re="^${esc}O[ABCD]"

  # Strip only allowlisted arrow-key bytes at the input boundary. CSI arrows
  # arrive as ESC [ ... A-D, including common numeric modifier parameters;
  # application-cursor/SS3 arrows arrive as ESC O A-D. Keep this explicit
  # instead of using Readline or a broad ANSI stripper so malformed or unrelated
  # control input remains visible to command validation.
  while [[ -n "$remaining" ]]; do
    if [[ "$remaining" =~ $csi_arrow_re || "$remaining" =~ $ss3_arrow_re ]]; then
      match="${BASH_REMATCH[0]}"
      remaining="${remaining:${#match}}"
      continue
    fi

    first="${remaining:0:1}"
    output+="$first"
    remaining="${remaining:1}"
  done

  printf '%s' "$output"
}

while :; do
  printf 'mill> '
  if ! IFS= read -r line; then
    exit 0
  fi

  raw_line="$line"
  raw_line_was_empty=false
  [[ -z "$raw_line" ]] && raw_line_was_empty=true
  line="$(strip_arrow_key_sequences "$line")"
  line="$(normalize_line "$line")"

  shopt -s nocasematch
  event=""
  if [[ -z "$line" && "$raw_line_was_empty" == "false" ]]; then
    shopt -u nocasematch
    continue
  elif [[ -z "$line" ]]; then
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
