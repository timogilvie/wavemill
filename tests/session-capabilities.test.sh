#!/usr/bin/env bash
# HOK-3102: shell wrappers around resolveSessionCapabilities. Verify the
# override env, cache hits, cache invalidation, and failure paths.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Extract the session-capabilities helpers into a small standalone lib so we
# can source them without pulling in the whole common script's side effects.
helper_file="$tmp/session-helpers.sh"
awk '
  BEGIN { emit = 0; depth = 0 }
  /^# ─── Session capabilities \(HOK-3102\)/ { emit = 1 }
  /^# HOK-3102 \(D7\)/ { emit = 0 }
  emit { print }
' "$COMMON_SCRIPT" > "$helper_file"

# The stat helper depends on the mtime helper, which is inside the block, so it
# is present. Add stubs for missing dependencies.
{
  printf '%s\n' '# Test harness stubs'
  printf '%s\n' 'startup_log() { :; }'
  cat "$helper_file"
} > "$tmp/lib.sh"

# ─── Test 1: WAVEMILL_SESSION_CAPABILITIES_JSON override ─────────────────────
(
  # shellcheck disable=SC1090
  source "$tmp/lib.sh"
  export WAVEMILL_SESSION_CAPABILITIES_JSON='{"tend":false,"observer":false,"mergeExecutor":"operator","mergeQueue":false}'
  wavemill_session_cache_reset
  json="$(wavemill_session_capabilities_json /nonexistent 2>/dev/null)"
  [[ "$json" == *'"mergeExecutor":"operator"'* ]] || fail "override JSON not returned: $json"
  wavemill_session_has tend /nonexistent && fail "expected tend=false with override"
  wavemill_session_has mergeQueue /nonexistent && fail "expected mergeQueue=false with override"
  executor="$(wavemill_session_merge_executor /nonexistent)"
  [[ "$executor" == "operator" ]] || fail "expected operator, got $executor"
) || exit 1

# ─── Test 2: cache hits (tool invoked once across two calls) ─────────────────
repo="$tmp/repo1"
mkdir -p "$repo/tools"
cat > "$repo/.wavemill-config.json" <<'JSON'
{"integration": {"enabled": true, "useMillSession": true}}
JSON

# Stub tool: increments a counter each invocation.
counter_file="$tmp/counter"
: > "$counter_file"
cat > "$repo/tools/session-capabilities.ts" <<EOF
#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const p = '$counter_file';
const n = existsSync(p) ? parseInt(readFileSync(p, 'utf-8').trim() || '0', 10) : 0;
writeFileSync(p, String(n + 1));
process.stdout.write('{"tend":true,"observer":false,"mergeExecutor":"tend","mergeQueue":true}\n');
EOF
chmod +x "$repo/tools/session-capabilities.ts"

(
  # shellcheck disable=SC1090
  source "$tmp/lib.sh"
  unset WAVEMILL_SESSION_CAPABILITIES_JSON
  wavemill_session_cache_reset
  TOOLS_DIR="$repo/tools" wavemill_session_capabilities_json "$repo" >/dev/null
  TOOLS_DIR="$repo/tools" wavemill_session_capabilities_json "$repo" >/dev/null
  count="$(cat "$counter_file")"
  [[ "$count" == "1" ]] || fail "expected 1 invocation with cache hit, got $count"
) || exit 1

# ─── Test 3: cache invalidation on config mtime change ───────────────────────
(
  # shellcheck disable=SC1090
  source "$tmp/lib.sh"
  unset WAVEMILL_SESSION_CAPABILITIES_JSON
  wavemill_session_cache_reset
  : > "$counter_file"
  TOOLS_DIR="$repo/tools" wavemill_session_capabilities_json "$repo" >/dev/null
  # Bump mtime by rewriting the config.
  sleep 1
  printf '%s\n' '{"integration":{"enabled":true,"useMillSession":true},"observer":{"enabled":true}}' > "$repo/.wavemill-config.json"
  TOOLS_DIR="$repo/tools" wavemill_session_capabilities_json "$repo" >/dev/null
  count="$(cat "$counter_file")"
  [[ "$count" == "2" ]] || fail "expected 2 invocations after mtime bump, got $count"
) || exit 1

# ─── Test 4: failure with a cache → cached value ─────────────────────────────
(
  # shellcheck disable=SC1090
  source "$tmp/lib.sh"
  unset WAVEMILL_SESSION_CAPABILITIES_JSON
  wavemill_session_cache_reset
  TOOLS_DIR="$repo/tools" wavemill_session_capabilities_json "$repo" >/dev/null
  # Break the tool.
  cat > "$repo/tools/session-capabilities.ts" <<'EOF'
#!/usr/bin/env -S npx tsx
process.exit(3);
EOF
  chmod +x "$repo/tools/session-capabilities.ts"
  sleep 1
  # A new mtime forces re-spawn but tool fails; expect cache fallback.
  printf '%s\n' '{"integration":{"enabled":false}}' > "$repo/.wavemill-config.json"
  json="$(TOOLS_DIR="$repo/tools" wavemill_session_capabilities_json "$repo" 2>/dev/null)"
  [[ "$json" == *'"tend":true'* ]] || fail "expected cached value on failure, got: $json"
) || exit 1

# ─── Test 5: failure without a cache → rc 2, executor prints unknown ─────────
(
  # shellcheck disable=SC1090
  source "$tmp/lib.sh"
  unset WAVEMILL_SESSION_CAPABILITIES_JSON
  wavemill_session_cache_reset
  # Point at a non-existent tools dir.
  json="$(TOOLS_DIR="$tmp/missing-tools" wavemill_session_capabilities_json "$tmp/missing-repo" 2>/dev/null)"
  rc=$?
  [[ $rc -eq 2 ]] || fail "expected rc=2 with no cache, got $rc"
  [[ -z "$json" ]] || fail "expected empty output on failure, got: $json"
  executor="$(TOOLS_DIR="$tmp/missing-tools" wavemill_session_merge_executor "$tmp/missing-repo" 2>/dev/null)"
  [[ "$executor" == "unknown" ]] || fail "expected unknown, got: $executor"
) || exit 1

# ─── Test 6: wavemill_session_has returns 1 on unknown ────────────────────────
(
  # shellcheck disable=SC1090
  source "$tmp/lib.sh"
  unset WAVEMILL_SESSION_CAPABILITIES_JSON
  wavemill_session_cache_reset
  if TOOLS_DIR="$tmp/missing-tools" wavemill_session_has tend "$tmp/missing-repo" 2>/dev/null; then
    fail "wavemill_session_has should return false on unknown"
  fi
) || exit 1

# ─── Test 7: HOK-3094 real resolver: integration off → observer on, tend off ─
repo7="$tmp/repo7"
mkdir -p "$repo7"
printf '%s\n' '{"integration":{"enabled":false}}' > "$repo7/.wavemill-config.json"
(
  # shellcheck disable=SC1090
  source "$tmp/lib.sh"
  unset WAVEMILL_SESSION_CAPABILITIES_JSON
  wavemill_session_cache_reset
  TOOLS_DIR="$REPO_DIR/tools" wavemill_session_has observer "$repo7" \
    || fail "expected observer=true with integration off (HOK-3094)"
  if TOOLS_DIR="$REPO_DIR/tools" wavemill_session_has tend "$repo7"; then
    fail "expected tend=false with integration off"
  fi
) || exit 1

printf 'session-capabilities.test.sh: all 7 checks passed\n'
