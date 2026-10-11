#!/usr/bin/env bash
# HOK-3204: agent_validate_model / agent_resolve_model memoize the tsx
# resolver spawn against a (model|fingerprint) and (role|model|fingerprint)
# key. The monitor pass boundary calls agent_model_cache_reset so each pass
# starts clean; within a pass the lookup is O(1). This test also exercises
# the cached node --import tsx probe inside agent_run_tsx_tool.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADAPTERS="$REPO_DIR/shared/lib/agent-adapters.sh"

TMP="$(mktemp -d -t wavemill-model-memo-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    printf '    expected: %s\n    actual:   %s\n' "$expected" "$actual"
    fail "$label"
  fi
}

echo "=== agent_validate_model / agent_resolve_model memo (HOK-3204) ==="

# ── Minimal repo fixture ────────────────────────────────────────────────────
repo="$TMP/repo"
mkdir -p "$repo"
printf '%s\n' '{"integration":{"enabled":false}}' > "$repo/.wavemill-config.json"

counter_file="$TMP/validator-counter"
: > "$counter_file"

# Shim: counts invocations and emulates model-validator.ts output. Any model
# that starts with "claude-" or "gpt-" validates; others fail. Resolution
# echoes the input model.
make_env() {
  cat <<SH
# shellcheck disable=SC1090
source "$ADAPTERS"

agent_run_tsx_tool() {
  # Count each invocation.
  local n
  n=\$(wc -l < "$counter_file" 2>/dev/null | tr -d ' ')
  echo call >> "$counter_file"
  # First arg is the tool basename, which we discard; the args contain the
  # model and the flags.
  local tool="\$1"
  shift
  local wants_resolve=0 role="" model=""
  while [[ \$# -gt 0 ]]; do
    case "\$1" in
      --selector-token) model="\$2"; shift 2 ;;
      --resolve-selector-token) wants_resolve=1; model="\$2"; shift 2 ;;
      --role) role="\$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  case "\$model" in
    claude-*|gpt-*) :;;
    *) return 1 ;;
  esac
  if [[ \$wants_resolve -eq 1 ]]; then
    printf '%s\n' "\$model"
  fi
  return 0
}

agent_model_helper_available() { return 0; }
SH
}

# ── Test 1: validate twice → spawns once ───────────────────────────────────
: > "$counter_file"
# shellcheck disable=SC2016
bash -c "
set -Eeuo pipefail
$(make_env)
agent_model_cache_reset
agent_validate_model claude-opus-4-7 \"$repo\" >/dev/null 2>&1 || true
agent_validate_model claude-opus-4-7 \"$repo\" >/dev/null 2>&1 || true
"
count=$(wc -l < "$counter_file" | tr -d ' ')
check_eq "validate twice spawns once" "$count" "1"

# ── Test 2: resolve twice → spawns once (independent of validate memo) ─────
: > "$counter_file"
bash -c "
set -Eeuo pipefail
$(make_env)
agent_model_cache_reset
agent_resolve_model reviewer claude-opus-4-7 \"$repo\" >/dev/null 2>&1 || true
agent_resolve_model reviewer claude-opus-4-7 \"$repo\" >/dev/null 2>&1 || true
"
count=$(wc -l < "$counter_file" | tr -d ' ')
check_eq "resolve twice spawns once" "$count" "1"

# ── Test 3: resolve result survives round-trip (not lost in the memo) ──────
out=$(bash -c "
set -Eeuo pipefail
$(make_env)
agent_model_cache_reset
agent_resolve_model reviewer claude-opus-4-7 \"$repo\" 2>/dev/null
agent_resolve_model reviewer claude-opus-4-7 \"$repo\" 2>/dev/null
")
# Both calls must print the resolved model exactly once each.
check_eq "memo returns correct resolve value" "$out" "$(printf 'claude-opus-4-7\nclaude-opus-4-7')"

# ── Test 4: config mtime bump invalidates the memo ─────────────────────────
: > "$counter_file"
bash -c "
set -Eeuo pipefail
$(make_env)
agent_model_cache_reset
agent_validate_model claude-opus-4-7 \"$repo\" >/dev/null 2>&1 || true
# Bump mtime so the fingerprint changes.
sleep 1
printf '%s\n' '{\"integration\":{\"enabled\":true}}' > \"$repo/.wavemill-config.json\"
agent_validate_model claude-opus-4-7 \"$repo\" >/dev/null 2>&1 || true
"
count=$(wc -l < "$counter_file" | tr -d ' ')
check_eq "config mtime bump re-spawns" "$count" "2"

# ── Test 5: agent_model_cache_reset re-spawns ──────────────────────────────
: > "$counter_file"
bash -c "
set -Eeuo pipefail
$(make_env)
agent_model_cache_reset
agent_validate_model claude-opus-4-7 \"$repo\" >/dev/null 2>&1 || true
agent_model_cache_reset
agent_validate_model claude-opus-4-7 \"$repo\" >/dev/null 2>&1 || true
"
count=$(wc -l < "$counter_file" | tr -d ' ')
check_eq "agent_model_cache_reset clears memo" "$count" "2"

# ── Test 6: negative validate result is also cached ────────────────────────
: > "$counter_file"
negative_out=$(bash -c "
set -Euo pipefail
$(make_env)
agent_model_cache_reset
rc1=0; agent_validate_model bogus-model \"$repo\" >/dev/null 2>&1 || rc1=\$?
rc2=0; agent_validate_model bogus-model \"$repo\" >/dev/null 2>&1 || rc2=\$?
printf '%s|%s\n' \"\$rc1\" \"\$rc2\"
")
count=$(wc -l < "$counter_file" | tr -d ' ')
check_eq "negative result cached (spawn=1)" "$count" "1"
check_eq "both negative calls return rc=1" "$negative_out" "1|1"

# ── Test 7: tsx probe runs at most once per process ────────────────────────
# Stub `node` on PATH to count calls that look like the probe.
probe_counter="$TMP/node-probe-counter"
: > "$probe_counter"
NODE_SHIM_DIR="$TMP/node-shim"
mkdir -p "$NODE_SHIM_DIR"
NODE_REAL="$(command -v node 2>/dev/null || true)"
cat > "$NODE_SHIM_DIR/node" <<SHIM
#!/usr/bin/env bash
# Count the capability probe (\`node --import tsx -e ""\`) and defer anything
# else to the real node binary. The probe is identified by the exact arg
# sequence \`--import tsx -e <empty>\`.
if [[ "\$1" == "--import" && "\$2" == "tsx" && "\$3" == "-e" ]]; then
  echo probe >> "$probe_counter"
  # Return success as if node --import tsx works, so the caller caches 1.
  exit 0
fi
if [[ -n "$NODE_REAL" ]]; then
  exec "$NODE_REAL" "\$@"
fi
exit 0
SHIM
chmod +x "$NODE_SHIM_DIR/node"

bash -c "
set -Eeuo pipefail
export PATH=\"$NODE_SHIM_DIR:\$PATH\"
# shellcheck disable=SC1090
source \"$ADAPTERS\"
unset WAVEMILL_NODE_IMPORT_TSX_SUPPORTED
# Any three invocations that trigger the probe.
agent_model_helper_available >/dev/null 2>&1 || true
agent_model_helper_available >/dev/null 2>&1 || true
agent_model_helper_available >/dev/null 2>&1 || true
" >/dev/null 2>&1 || true
count=$(wc -l < "$probe_counter" | tr -d ' ')
check_eq "tsx probe runs once across three calls" "$count" "1"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
exit $(( FAIL > 0 ? 1 : 0 ))
