#!/usr/bin/env bash
# Test: marker_clear / bounded_retry_clear / clearMarker sites are allowed (HOK-3172)
#
# Enforces the invariant that gates never clear markers — only the reconciler
# and the helper functions themselves. Sites are tracked in a ratcheting
# allowlist so the count shrinks over time as sites migrate to the reconciler.
#
# The check runs once against the real repo and once per self-test fixture,
# so the unlisted, over-count, and under-count (ratchet) failures are each
# exercised rather than assumed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ALLOWLIST="$SCRIPT_DIR/marker-clear-allowlist.txt"

if [[ ! -f "$ALLOWLIST" ]]; then
  echo "FAIL: allowlist not found at $ALLOWLIST" >&2
  exit 1
fi

# Exempt files (core helpers and the reconciler itself)
EXEMPT_FILES=(
  "shared/lib/transient-marker.sh"
  "shared/lib/transient-marker.ts"
  "shared/lib/bounded-retry.sh"
  "shared/lib/bounded-retry.ts"
  "shared/lib/condition-reconciler.sh"
)

# check_clear_sites <root> <allowlist>
# Prints violations to stderr; returns 1 if any, 0 otherwise.
check_clear_sites() {
  local root="$1" allowlist="$2"
  local -a scan_dirs=()
  local dir exempt file line max_count actual allowed skip raw_matches
  local -A actual_counts=() allowed_counts=()
  local failed=false

  for dir in shared tools; do
    [[ -d "$root/$dir" ]] && scan_dirs+=("$dir")
  done
  if (( ${#scan_dirs[@]} > 0 )); then
    raw_matches=$(cd "$root" && grep -rn 'marker_clear\|bounded_retry_clear\|clearMarker(' \
      "${scan_dirs[@]}" \
      --include='*.sh' --include='*.ts' \
      | grep -v '\.test\.' \
      | grep -v '^[^:]*:[^:]*:\s*#' \
      | grep -v '^[^:]*:[^:]*:\s*//' \
      | grep -v '^[^:]*:[^:]*\(marker_clear\|bounded_retry_clear\|clearMarker\)\s*(' \
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
      echo "FAIL: $file has $actual marker_clear/bounded_retry_clear/clearMarker calls but is not in allowlist" >&2
      echo "      Route clears through the reconciler, or add to allowlist if justified" >&2
      failed=true
      continue
    fi
    allowed="${allowed_counts[$file]}"
    if (( actual > allowed )); then
      echo "FAIL: $file has $actual marker_clear/bounded_retry_clear/clearMarker calls, allowed $allowed" >&2
      echo "      Route new clears through the reconciler (shared/lib/condition-reconciler.sh)" >&2
      failed=true
    elif (( actual < allowed )); then
      echo "FAIL: $file has $actual calls, but allowlist says $allowed" >&2
      echo "      Lower the allowance to $actual in $allowlist (ratchet)" >&2
      failed=true
    fi
  done

  # An allowlisted file whose clears are all gone must also be ratcheted out.
  for file in "${!allowed_counts[@]}"; do
    if [[ -z "${actual_counts[$file]:-}" && "${allowed_counts[$file]}" -gt 0 ]]; then
      echo "FAIL: $file has 0 calls, but allowlist says ${allowed_counts[$file]}" >&2
      echo "      Remove it from $allowlist (ratchet)" >&2
      failed=true
    fi
  done

  [[ "$failed" == "false" ]]
}

# ── Real repo ─────────────────────────────────────────────────────────────
if ! check_clear_sites "$REPO_ROOT" "$ALLOWLIST"; then
  exit 1
fi

# ── Self-tests against fixtures ───────────────────────────────────────────
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

make_fixture() {
  local name="$1" clears="$2" allowance="$3"
  local root="$FIXTURE/$name"
  local i
  mkdir -p "$root/shared/lib"
  {
    echo '#!/bin/bash'
    for (( i = 0; i < clears; i++ )); do
      echo "marker_clear \"\$dir/.marker-$i\""
    done
  } > "$root/shared/lib/gate.sh"
  if [[ -n "$allowance" ]]; then
    printf '# fixture allowlist\nshared/lib/gate.sh %s\n' "$allowance" > "$root/allowlist.txt"
  else
    printf '# fixture allowlist\n' > "$root/allowlist.txt"
  fi
  echo "$root"
}

expect_check() {
  local label="$1" expected="$2" root="$3"
  local got
  if check_clear_sites "$root" "$root/allowlist.txt" 2>/dev/null; then got=pass; else got=fail; fi
  if [[ "$got" != "$expected" ]]; then
    echo "FAIL: self-test '$label' expected $expected, got $got" >&2
    exit 1
  fi
}

expect_check "unlisted file"            fail "$(make_fixture unlisted 1 '')"
expect_check "over-count"               fail "$(make_fixture over 3 2)"
expect_check "under-count (ratchet)"    fail "$(make_fixture under 1 2)"
expect_check "allowlisted file cleared" fail "$(make_fixture gone 0 2)"
expect_check "exact allowance"          pass "$(make_fixture exact 2 2)"

echo "PASS: marker_clear sites match allowlist (5 self-tests exercised)"
exit 0
