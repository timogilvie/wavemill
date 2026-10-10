#!/usr/bin/env bash
# HOK-3184: ensure every ledger.ts invocation from a .sh file is wrapped in
# error-swallow (`|| true`, redirect to /dev/null, or captured via `$(...)`
# with a `|| echo` fallback). A shadow write must never crash the shell
# caller, per plan §3f.
#
# The guard scans shell files under shared/ and tools/ for lines invoking
# `wavemill_run_tool ledger.ts ...` and ensures each either:
#   - ends with `|| true` or `|| echo` or `|| return`
#   - redirects stderr to /dev/null (`2>/dev/null`) AND is inside a `$(...)`
#     command substitution (whose exit code is discarded), or
#   - redirects both streams (`>/dev/null 2>&1`) AND ends with `|| true`
#
# Lines matching `_ignore_errors` wrapper are also accepted.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PATTERN='wavemill_run_tool[[:space:]]+ledger\.ts'
violations=0

while IFS= read -r hit; do
  file="${hit%%:*}"
  rest="${hit#*:}"
  line="${rest#*:}"
  # Skip comments and docstrings.
  trimmed="$(printf '%s' "$line" | sed 's/^[[:space:]]*//')"
  case "$trimmed" in
    '#'*) continue ;;
  esac
  # Accept any line that contains `|| true`, `|| echo`, `|| return`, `_ignore_errors`,
  # or redirects stderr while being inside a $(...) command substitution.
  if printf '%s' "$line" | grep -qE '\|\|[[:space:]]*(true|echo|return)|_ignore_errors|2>/dev/null[[:space:]]*(\)|\|)|>/dev/null[[:space:]]+2>&1'; then
    continue
  fi
  echo "VIOLATION ${file}:${rest%%:*}: $line" >&2
  violations=$((violations + 1))
done < <(grep -En "$PATTERN" \
  "$REPO_ROOT/shared" "$REPO_ROOT/tools" \
  -r --include='*.sh' 2>/dev/null \
  | grep -v 'tests/' \
  || true)

if (( violations > 0 )); then
  echo "FAIL: $violations ledger.ts shell call(s) without error-swallow wrapper" >&2
  exit 1
fi

echo "ok - every ledger.ts shell call swallows errors"
exit 0
