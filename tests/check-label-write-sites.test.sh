#!/usr/bin/env bash
# Test: wm:ready/wm:blocked label write sites are allowed (HOK-3181)
#
# Enforces the invariant that no wm:ready / wm:blocked write may exist outside
# the reconciler. Lane progression labels (wm:merging, wm:merged, wm:superseded)
# are OUT OF SCOPE. Sites are tracked in a ratcheting allowlist so the count
# shrinks over time as sites migrate to the reconciler.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ALLOWLIST="$SCRIPT_DIR/label-write-allowlist.txt"

if [[ ! -f "$ALLOWLIST" ]]; then
  echo "FAIL: allowlist not found at $ALLOWLIST" >&2
  exit 1
fi

# Exempt files (core helpers and the reconciler itself)
EXEMPT_FILES=(
  "shared/lib/pr-state-labels.ts"
  "shared/lib/merge-labels.ts"
  "shared/lib/merge-labels.test.ts"
)

# check_label_write_sites <root> <allowlist>
# Prints violations to stderr; returns 1 if any, 0 otherwise.
check_label_write_sites() {
  local root="$1" allowlist="$2"
  local -a scan_dirs=()
  local dir exempt file line max_count actual allowed skip raw_matches
  local -A actual_counts=() allowed_counts=()
  local failed=false

  for dir in shared tools; do
    [[ -d "$root/$dir" ]] && scan_dirs+=("$dir")
  done
  if (( ${#scan_dirs[@]} > 0 )); then
    # Grep for setWavemillReady, setWavemillBlocked, clearWavemillState, and
    # gh pr edit --add-label/--remove-label wm:ready/wm:blocked
    raw_matches=$(cd "$root" && grep -rn \
      -e 'setWavemillReady' \
      -e 'setWavemillBlocked' \
      -e 'clearWavemillState' \
      -e '--add-label[[:space:]]\+["'"'"']\?wm:ready' \
      -e '--add-label[[:space:]]\+["'"'"']\?wm:blocked' \
      -e '--remove-label[[:space:]]\+["'"'"']\?wm:ready' \
      -e '--remove-label[[:space:]]\+["'"'"']\?wm:blocked' \
      "${scan_dirs[@]}" \
      --include='*.sh' --include='*.ts' \
      | grep -v '\.test\.' \
      | grep -v '^[^:]*:[^:]*:\s*#\s*allow-label-write:' \
      | grep -v '^[^:]*:[^:]*:\s*//\s*allow-label-write:' \
      | grep -v '^[^:]*:[^:]*\s*\(setWavemillReady\|setWavemillBlocked\|clearWavemillState\)\s*(' \
      | grep -v '^[^:]*:[^:]*\s*export\s\+\(function\s\+\)\?\(setWavemillReady\|setWavemillBlocked\|clearWavemillState\)' \
      || true)
  else
    raw_matches=""
  fi

  while IFS=: read -r file _rest; do
    [[ -z "$file" ]] && continue
    skip=false
    for exempt in "${EXEMPT_FILES[@]}"; do
      if [[ "$file" == "$exempt" ]]; then
        skip=true
        break
      fi
    done
    [[ "$skip" == "true" ]] && continue
    actual_counts[$file]=$(( ${actual_counts[$file]:-0} + 1 ))
  done <<< "$raw_matches"

  while IFS= read -r line; do
    [[ "$line" =~ ^# ]] && continue
    [[ -z "$line" ]] && continue
    read -r file max_count <<< "$line"
    allowed_counts[$file]=$max_count
  done < "$allowlist"

  for file in "${!actual_counts[@]}"; do
    actual="${actual_counts[$file]}"
    if [[ -z "${allowed_counts[$file]:-}" ]]; then
      echo "FAIL: $file has $actual wm:ready/wm:blocked label writes but is not in allowlist" >&2
      echo "      Route writes through the reconciler (shared/lib/merge-labels.ts)" >&2
      failed=true
      continue
    fi
    allowed="${allowed_counts[$file]}"
    if (( actual > allowed )); then
      echo "FAIL: $file has $actual label writes, allowed $allowed" >&2
      echo "      Route writes through the reconciler or add suppression comment" >&2
      failed=true
    elif (( actual < allowed )); then
      echo "FAIL: $file has $actual label writes, but allowlist says $allowed" >&2
      echo "      Lower the allowance to $actual in $allowlist (ratchet)" >&2
      failed=true
    fi
  done

  # An allowlisted file whose writes are all gone must also be ratcheted out.
  for file in "${!allowed_counts[@]}"; do
    if [[ -z "${actual_counts[$file]:-}" && "${allowed_counts[$file]}" -gt 0 ]]; then
      echo "FAIL: $file has 0 label writes, but allowlist says ${allowed_counts[$file]}" >&2
      echo "      Lower the allowance to 0 in $allowlist (ratchet)" >&2
      failed=true
    fi
  done

  if [[ "$failed" == "true" ]]; then
    return 1
  fi
  return 0
}

# Run against real repo
echo "Checking label write sites in real repo..."
if ! check_label_write_sites "$REPO_ROOT" "$ALLOWLIST"; then
  echo "FAIL: Label write site violations detected" >&2
  exit 1
fi

echo "PASS: All label write sites are allowed"
exit 0
