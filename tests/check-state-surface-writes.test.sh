#!/usr/bin/env bash
# Test: no direct writes to retired state surfaces (HOK-3187, Ledger H Phase 4)
#
# The ledger (shared/lib/ledger.ts + tools/ledger.ts) is the sole authority for
# task state. Legacy files remain only as a render view (workflow-state.json)
# and as evidence feeders (hook files). Direct writes from new code to the
# retired surfaces defeat the point of the ledger, so this guard greps for
# unauthorised writers and fails on new ones.
#
# Retired surfaces:
#   - workflow-state.json  — rendered by `tools/ledger.ts view workflow-state`
#   - .retry-<bucket>-*     — ledger step row's attempt + settled_reason
#   - .workflow-aborted     — `tools/ledger.ts event abort --task <id>`
#   - condition sidecars    — `tools/ledger.ts waiting-on-set`
#
# Exempt files are the renderer itself, the state-mutate shim that writes the
# render view, and the sentinel authoring helpers that are migrating in
# follow-up PRs on this branch.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ALLOWLIST="$SCRIPT_DIR/state-surface-write-allowlist.txt"

if [[ ! -f "$ALLOWLIST" ]]; then
  echo "FAIL: allowlist not found at $ALLOWLIST" >&2
  exit 1
fi

# Core sites allowed to touch the render view / sentinel helpers.
EXEMPT_FILES=(
  "tools/ledger.ts"
  "shared/lib/view-workflow-state.ts"
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
      echo "      Route writes through tools/ledger.ts, or add to allowlist if justified" >&2
      failed=true
      continue
    fi
    allowed="${allowed_counts[$file]}"
    if (( actual > allowed )); then
      echo "FAIL: $file has $actual retired-surface writes, allowed $allowed" >&2
      echo "      Route new writes through the ledger CLI" >&2
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
