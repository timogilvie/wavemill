#!/usr/bin/env bash
# Test: no direct writes to managed state surfaces
#
# Task state and its sentinels have one authoring seam each. Direct writes
# from new code bypass the mutate lock, the schema/settlement gate and the
# bounded-retry / condition-marker primitives, so this guard greps for
# unauthorised writers and fails on new ones.
#
# Managed surfaces and their authoring seam:
#   - workflow-state.json  — `state_mutate` / `mutateJsonState`
#   - .retry-<bucket>-*     — `bounded_retry_*` (attempt + settled_reason)
#   - .workflow-aborted     — the abort seam
#   - condition sidecars    — `marker_write` / `marker_clear`
#
# Exempt files are the authoring helpers themselves.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ALLOWLIST="$SCRIPT_DIR/state-surface-write-allowlist.txt"

if [[ ! -f "$ALLOWLIST" ]]; then
  echo "FAIL: allowlist not found at $ALLOWLIST" >&2
  exit 1
fi

# Core sites allowed to author the managed surfaces / sentinel helpers.
EXEMPT_FILES=(
  "shared/lib/bounded-retry.sh"
  "shared/lib/bounded-retry.ts"
  "shared/lib/condition-reconciler.sh"
  "shared/lib/wavemill-common.sh"
  "shared/lib/state-mutex.ts"
)

# check_surface_writes <root> <allowlist>
# Prints violations to stderr; returns 1 if any, 0 otherwise.
check_surface_writes() {
  local root="$1" allowlist="$2"
  local -a scan_dirs=()
  local dir exempt file line max_count actual allowed skip raw_matches
  local -A actual_counts=() allowed_counts=()
  local failed=false

  for dir in shared tools; do
    [[ -d "$root/$dir" ]] && scan_dirs+=("$dir")
  done
  if (( ${#scan_dirs[@]} > 0 )); then
    # Grep for direct write patterns. We flag both shell-redirect writes and
    # mv/cp destinations landing on retired surfaces.
    raw_matches=$(cd "$root" && grep -rnE \
      '> *(\.[a-zA-Z0-9/_.-]+/)?workflow-state\.json|>> *(\.[a-zA-Z0-9/_.-]+/)?workflow-state\.json|mv [^#]*workflow-state\.json|cp [^#]*workflow-state\.json|touch [^#]*\.retry-[a-z0-9_-]+|touch [^#]*\.workflow-aborted|echo [^#]*> *.*\.retry-[a-z0-9_-]+' \
      "${scan_dirs[@]}" \
      --include='*.sh' --include='*.ts' \
      | grep -v '\.test\.' \
      | grep -v '^[^:]*:[^:]*:[[:space:]]*#' \
      | grep -v '^[^:]*:[^:]*:[[:space:]]*//' \
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
      echo "FAIL: $file has $actual unauthorized writes to a retired state surface" >&2
      echo "      Route writes through state_mutate / mutateJsonState, or add to allowlist if justified" >&2
      failed=true
      continue
    fi
    allowed="${allowed_counts[$file]}"
    if (( actual > allowed )); then
      echo "FAIL: $file has $actual retired-surface writes, allowed $allowed" >&2
      echo "      Route new writes through the mutate seam" >&2
      failed=true
    elif (( actual < allowed )); then
      echo "FAIL: $file has $actual retired-surface writes, but allowlist says $allowed" >&2
      echo "      Lower the allowance to $actual in $allowlist (ratchet)" >&2
      failed=true
    fi
  done

  # An allowlisted file that is now clean must also be ratcheted out.
  for file in "${!allowed_counts[@]}"; do
    if [[ -z "${actual_counts[$file]:-}" && "${allowed_counts[$file]}" -gt 0 ]]; then
      echo "FAIL: $file has 0 retired-surface writes, but allowlist says ${allowed_counts[$file]}" >&2
      echo "      Remove it from $allowlist (ratchet)" >&2
      failed=true
    fi
  done

  [[ "$failed" == "false" ]]
}

# ── Real repo ─────────────────────────────────────────────────────────────
if ! check_surface_writes "$REPO_ROOT" "$ALLOWLIST"; then
  exit 1
fi

# ── Self-tests against fixtures ───────────────────────────────────────────
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

make_fixture() {
  local name="$1" write_count="$2" allowance="$3"
  local root="$FIXTURE/$name"
  local i
  mkdir -p "$root/shared/lib"
  {
    echo '#!/bin/bash'
    for (( i = 0; i < write_count; i++ )); do
      echo "touch \"\$dir/.retry-bucket-$i\""
    done
  } > "$root/shared/lib/mutator.sh"
  if [[ -n "$allowance" ]]; then
    printf '# fixture allowlist\nshared/lib/mutator.sh %s\n' "$allowance" > "$root/allowlist.txt"
  else
    printf '# fixture allowlist\n' > "$root/allowlist.txt"
  fi
  echo "$root"
}

expect_check() {
  local label="$1" expected="$2" root="$3"
  local got
  if check_surface_writes "$root" "$root/allowlist.txt" 2>/dev/null; then got=pass; else got=fail; fi
  if [[ "$got" != "$expected" ]]; then
    echo "FAIL: self-test '$label' expected $expected, got $got" >&2
    exit 1
  fi
}

expect_check "unlisted file"             fail "$(make_fixture unlisted 1 '')"
expect_check "over-count"                fail "$(make_fixture over 3 2)"
expect_check "under-count (ratchet)"     fail "$(make_fixture under 1 2)"
expect_check "allowlisted file cleared"  fail "$(make_fixture gone 0 2)"
expect_check "exact allowance"           pass "$(make_fixture exact 2 2)"

echo "PASS: state surface writes match allowlist (5 self-tests exercised)"
exit 0
