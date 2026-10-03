#!/usr/bin/env bash
# HOK-3100: guard test that enforces fallback-stub / per-call guards for every
# function wavemill-common.sh calls that is defined elsewhere.
#
# Standalone CLI tools (e.g. `wavemill cleanup`) source common without the
# mill or monitor environment; a bare call to e.g. `log_warn` then errors with
# `command not found`. This test:
#   1. Behaviourally sources common in a cleaned-up shell and asserts that
#      callers do not blow up on undefined functions.
#   2. Verifies the override order: a pre-existing definition wins; a late
#      definition also wins.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP_DIR="$(mktemp -d -t wm-check-common-guards-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0

pass() { echo "ok $1"; PASS=$((PASS + 1)); }
fail() { echo "not ok $1"; echo "  $2" >&2; FAIL=$((FAIL + 1)); }

COMMON_SH="$ROOT/shared/lib/wavemill-common.sh"
[[ -f "$COMMON_SH" ]] || { echo "wavemill-common.sh not found at $COMMON_SH" >&2; exit 1; }

# ------------------------------------------------------------------------------
# Behavioural test 1 — sourcing from a milled-repo cwd with spaces in its name
# must not leak `command not found` or non-zero exits.
# ------------------------------------------------------------------------------

MILLED_REPO="$TMP_DIR/milled repo"
mkdir -p "$MILLED_REPO"
STDERR_LOG="$TMP_DIR/behavioural.stderr"

if (
  cd "$MILLED_REPO"
  env -i PATH="$PATH" HOME="$HOME" bash --noprofile --norc -c '
    set -Eeuo pipefail
    source "'"$COMMON_SH"'"
    [[ -n "${WAVEMILL_INSTALL_DIR:-}" ]] || { echo "WAVEMILL_INSTALL_DIR not set" >&2; exit 2; }
    log_warn "guard-test warn"
    log_error "guard-test error"
    log info "guard-test log"
    tool_path="$(wavemill_tool_path route-task.ts)"
    [[ -f "$tool_path" ]] || { echo "wavemill_tool_path did not resolve to a real file: $tool_path" >&2; exit 2; }
    # exercises the challenge-pair guard: all helpers are undefined here, so
    # the function must noop (and should not raise).
    resolve_challenge_pair_hard_failure "p1" >/dev/null || true
  '
) 2>"$STDERR_LOG"; then
  if grep -q 'command not found' "$STDERR_LOG"; then
    fail "behavioural: no command not found on standalone source" "stderr was: $(cat "$STDERR_LOG")"
  else
    pass "behavioural: standalone source of wavemill-common works from milled repo path with spaces"
  fi
else
  fail "behavioural: standalone source of wavemill-common" "non-zero exit; stderr was: $(cat "$STDERR_LOG")"
fi

# ------------------------------------------------------------------------------
# Behavioural test 2 — override order: a pre-existing definition wins.
# ------------------------------------------------------------------------------

OVERRIDE_OUT="$TMP_DIR/override-pre.out"

if env -i PATH="$PATH" HOME="$HOME" bash --noprofile --norc -c '
  set -Eeuo pipefail
  log_warn() { echo "PRE-REAL"; }
  source "'"$COMMON_SH"'"
  log_warn "ignored"
' > "$OVERRIDE_OUT" 2>&1; then
  if grep -q "PRE-REAL" "$OVERRIDE_OUT"; then
    pass "override order: pre-existing log_warn survives sourcing common"
  else
    fail "override order: pre-existing log_warn survives sourcing common" "output was: $(cat "$OVERRIDE_OUT")"
  fi
else
  fail "override order: pre-existing log_warn survives sourcing common" "non-zero exit; output: $(cat "$OVERRIDE_OUT")"
fi

# ------------------------------------------------------------------------------
# Behavioural test 3 — override order: a later definition wins over the stub.
# ------------------------------------------------------------------------------

LATE_OUT="$TMP_DIR/override-post.out"

if env -i PATH="$PATH" HOME="$HOME" bash --noprofile --norc -c '
  set -Eeuo pipefail
  source "'"$COMMON_SH"'"
  log_warn() { echo "POST-REAL"; }
  log_warn "ignored"
' > "$LATE_OUT" 2>&1; then
  if grep -q "POST-REAL" "$LATE_OUT"; then
    pass "override order: a post-source log_warn redefinition wins"
  else
    fail "override order: a post-source log_warn redefinition wins" "output was: $(cat "$LATE_OUT")"
  fi
else
  fail "override order: a post-source log_warn redefinition wins" "non-zero exit; output: $(cat "$LATE_OUT")"
fi

# ------------------------------------------------------------------------------
# Static analysis — compute the set of external functions and verify guards.
#
# This extracts all function definitions in common, then extracts all function
# calls in command position, and verifies that every external call (one not
# defined in common) is guarded by a `declare -F <fn>` check or a per-call guard.
# Accepts --lib-dir to analyze a different file.
# ------------------------------------------------------------------------------

_analyze_guards() {
  local lib_file="${1:-$COMMON_SH}"

  [[ -f "$lib_file" ]] || { echo "File not found: $lib_file" >&2; return 1; }

  # Extract all function definitions in the file.
  # Matches: `function foo {...}`, `foo() {...}`, or `foo ()`.
  local -A defined_functions
  while IFS= read -r func; do
    [[ -n "$func" ]] && defined_functions["$func"]=1
  done < <(grep -oE '^(function[[:space:]]+)?[a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*(\(\))?[[:space:]]*\{' "$lib_file" | \
    sed -E 's/^(function[[:space:]]+)?([a-zA-Z_][a-zA-Z0-9_]*).*/\2/' | sort -u)

  # Extract all function calls that are in command position.
  # This includes calls preceded by: start of line, spaces, semicolons, pipes, &&, ||, or (
  local -A called_functions
  while IFS= read -r call; do
    [[ -n "$call" && "$call" != "if" && "$call" != "then" ]] && called_functions["$call"]=1
  done < <(grep -oE '(^|[[:space:]];|&&|[|]|[[:space:]]\(|[[:space:]])[a-zA-Z_][a-zA-Z0-9_]*' "$lib_file" | \
    sed -E 's/^[^a-zA-Z_]*//; s/[[:space:]]*$//' | grep -v '^$' | sort -u)

  # Check that all external functions (not defined in the file) have guards.
  # Guard patterns: `declare -F function_name` or `declare -F "$var"` patterns.
  local -a missing_guards=()
  for call in "${!called_functions[@]}"; do
    # Skip shell builtins and keywords
    case "$call" in
      if|then|else|elif|fi|case|esac|do|done|while|for|in|until|function|local|declare|export|source|readonly|unset|set|shift|return|exit|eval|exec|cd|pwd|test|\[|true|false|echo|printf|read|wait|trap|bg|fg|jobs|kill) continue ;;
    esac

    # Skip if the function is defined in this file
    [[ -v defined_functions["$call"] ]] && continue

    # Check if the function is guarded by a `declare -F` pattern
    if ! grep -qE "declare[[:space:]]+-F[[:space:]]+(\"?$call\"?|'$call'|\\\$\{?_fn\}?)" "$lib_file" 2>/dev/null; then
      missing_guards+=("$call")
    fi
  done

  if (( ${#missing_guards[@]} == 0 )); then
    pass "static: all external function calls are guarded in $(basename "$lib_file")"
    return 0
  else
    echo "  External function calls missing guards in $(basename "$lib_file"):" >&2
    for fn in "${missing_guards[@]}"; do
      echo "    - $fn" >&2
    done
    fail "static: all external function calls are guarded in $(basename "$lib_file")" "${#missing_guards[@]} missing"
    return 1
  fi
}

# Support --lib-dir fixture testing: allows testing on a different file
if [[ "${1:-}" == "--lib-dir" && -n "${2:-}" ]]; then
  _analyze_guards "$2"
else
  _analyze_guards "$COMMON_SH"
fi

# ------------------------------------------------------------------------------
# Fixture self-test — a wrapper script that sources common and then calls an
# undefined, unguarded function must fail. This is what would happen if a
# future edit added such a call inside common itself.
# ------------------------------------------------------------------------------

FIXTURE_SH="$TMP_DIR/bad-caller.sh"
cat > "$FIXTURE_SH" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
source "$COMMON_SH"
# Fixture: an unguarded, undefined function call that would blow up any
# standalone caller that reached this line.
my_new_unguarded_function_call
EOF

FIXTURE_LOG="$TMP_DIR/fixture.stderr"
if env -i PATH="$PATH" HOME="$HOME" bash --noprofile --norc "$FIXTURE_SH" 2>"$FIXTURE_LOG"; then
  fail "fixture: unguarded sibling call must fail the sourcing" "but it succeeded; stderr: $(cat "$FIXTURE_LOG")"
else
  if grep -qE 'my_new_unguarded_function_call|command not found' "$FIXTURE_LOG"; then
    pass "fixture: unguarded external call is detected by failing to run cleanly"
  else
    fail "fixture: unguarded sibling call must fail the sourcing" "stderr: $(cat "$FIXTURE_LOG")"
  fi
fi

echo ""
echo "# $PASS passed, $FAIL failed"
if (( FAIL > 0 )); then
  exit 1
fi
exit 0
