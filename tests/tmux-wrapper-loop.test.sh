#!/usr/bin/env bash
# Wrapper-loop replay (HOK-3329).
#
# protects: shared/agent-bin/tmux and tests/fakes/bin/tmux execing each other
# forever when both are on PATH (the HOK-3329 exec-loop incident shape), and
# private PATH-order tmux resolution guesses returning a wrapper instead of the
# real binary. The one resolver (term_resolve_real_tmux) must skip every
# wavemill wrapper, and each wrapper must refuse to exec another wrapper.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/tmux-wrapper-loop.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# A fake "real tmux" shim: a binary tmux with NO wrapper marker.
SHIM_DIR="$TMP/real-bin"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'real-tmux shim: %s\n' "$*"
exit 0
EOF
chmod 755 "$SHIM_DIR/tmux"

AGENT_WRAPPER="$REPO_DIR/shared/agent-bin/tmux"
FAKES_WRAPPER="$REPO_DIR/tests/fakes/bin/tmux"

# Run the wrappers from a scratch copy with proper exec bits: a worktree
# checkout can lose the mode bit (Dropbox), and the wrappers' own -x checks on
# their real-tmux target need an executable file.
W_BIN="$TMP/wrappers"
mkdir -p "$W_BIN"
cp "$AGENT_WRAPPER" "$W_BIN/agent-tmux"
cp "$FAKES_WRAPPER" "$W_BIN/fakes-tmux"
chmod 755 "$W_BIN/agent-tmux" "$W_BIN/fakes-tmux"
AGENT_WRAPPER="$W_BIN/agent-tmux"
FAKES_WRAPPER="$W_BIN/fakes-tmux"

# ── Case A: the resolver skips both wrappers and finds the real binary ─────
source "$REPO_DIR/shared/lib/terminal-backend.sh"
FAKE_PATH="$REPO_DIR/shared/agent-bin:$REPO_DIR/tests/fakes/bin:$SHIM_DIR"
resolved="$(term_resolve_real_tmux "$FAKE_PATH")"
[[ "$resolved" == "$SHIM_DIR/tmux" ]] \
  && pass "term_resolve_real_tmux skips both wrappers and returns the real binary" \
  || fail "term_resolve_real_tmux skips both wrappers and returns the real binary (got: $resolved)"

# Wrapper-only PATH: the resolver refuses rather than returning a wrapper.
if term_resolve_real_tmux "$REPO_DIR/shared/agent-bin:$REPO_DIR/tests/fakes/bin" >/dev/null 2>&1; then
  fail "term_resolve_real_tmux refuses a wrapper-only PATH"
else
  pass "term_resolve_real_tmux refuses a wrapper-only PATH"
fi

# A stale guard copy on PATH predates the marker (HOK-3329: the developer's
# own PATH carried a checkout's agent-bin/tmux that was never marked), so the
# marker alone cannot identify it. The resolver must skip any tmux inside an
# agent-bin directory by name.
STALE_GUARD_DIR="$TMP/old-checkout/shared/agent-bin"
mkdir -p "$STALE_GUARD_DIR"
cat > "$STALE_GUARD_DIR/tmux" <<'EOF'
#!/usr/bin/env bash
# old guard copy: no WAVEMILL_TMUX_WRAPPER marker
exit 127
EOF
chmod 755 "$STALE_GUARD_DIR/tmux"
resolved="$(term_resolve_real_tmux "$STALE_GUARD_DIR:$SHIM_DIR")"
[[ "$resolved" == "$SHIM_DIR/tmux" ]] \
  && pass "term_resolve_real_tmux skips a marker-less agent-bin guard by name" \
  || fail "term_resolve_real_tmux skips a marker-less agent-bin guard by name (got: $resolved)"

# ── Case B: the agent wrapper refuses to exec another wavemill wrapper ─────
# Point WAVEMILL_REAL_TMUX at the fakes wrapper (the misconfiguration that
# produced the exec loop). The guard must fail in one call with exit 126.
# allow-world-lifetime: replaying the kill-server refusal is this test's point.
set +e
out="$(WAVEMILL_REAL_TMUX="$FAKES_WRAPPER" WAVEMILL_SESSION="" "$AGENT_WRAPPER" kill-server 2>&1)"
rc=$?
set -e
(( rc != 0 )) \
  && pass "agent wrapper refuses to exec another wrapper (exit $rc)" \
  || fail "agent wrapper refuses to exec another wrapper (exit $rc)"
[[ "$out" == *"refuses to exec another wavemill wrapper"* ]] \
  && pass "agent wrapper refusal names the reason on stderr" \
  || fail "agent wrapper refusal names the reason on stderr (got: $out)"

# ── Case C: the fakes wrapper refuses to exec the agent wrapper ────────────
set +e
out="$(FAKE_TMUX_REAL="$AGENT_WRAPPER" FAKE_TMUX_SOCK="$TMP/fakes.sock" "$FAKES_WRAPPER" list-sessions 2>&1)"
rc=$?
set -e
(( rc != 0 )) \
  && pass "fakes wrapper refuses to exec another wrapper (exit $rc)" \
  || fail "fakes wrapper refuses to exec another wrapper (exit $rc)"
[[ "$out" == *"refuses to exec another wavemill wrapper"* ]] \
  && pass "fakes wrapper refusal names the reason on stderr" \
  || fail "fakes wrapper refusal names the reason on stderr (got: $out)"

# ── Case D: valid resolution still works end to end ─────────────────────────
# Hermetic: the shim stands in for the real tmux binary, so no system tmux is
# required and the resolver's happy path is exercised on any host.
REAL_TMUX_PATH="$(term_resolve_real_tmux "$SHIM_DIR:$PATH")"
# Through the agent wrapper, outside a session, the real binary runs.
out="$(WAVEMILL_REAL_TMUX="$REAL_TMUX_PATH" WAVEMILL_SESSION="" "$AGENT_WRAPPER" -V 2>&1)"
[[ "$out" == *"real-tmux shim: -V"* ]] \
  && pass "agent wrapper execs the real binary when nothing is misconfigured" \
  || fail "agent wrapper execs the real binary when nothing is misconfigured (got: $out)"
# Through the fakes wrapper with a real FAKE_TMUX_REAL.
out="$(FAKE_TMUX_REAL="$SHIM_DIR/tmux" FAKE_TMUX_SOCK="$TMP/fakes.sock" "$FAKES_WRAPPER" -V 2>&1)"
[[ "$out" == *"real-tmux shim: -S $TMP/fakes.sock -V"* ]] \
  && pass "fakes wrapper execs the real binary when nothing is misconfigured" \
  || fail "fakes wrapper execs the real binary when nothing is misconfigured (got: $out)"

# ── Case E: a fakes world built inside an agent pane (the incident env) ─────
# shared/agent-bin first on PATH and WAVEMILL_REAL_TMUX pointing at the fake:
# fakes_setup must still resolve the real binary, and the world's tmux works
# through the fakes wrapper in one call per command.
if REAL_TMUX="$(term_resolve_real_tmux 2>/dev/null)"; then
  WORLD_OUT="$TMP/world.out"
  if PATH="$REPO_DIR/shared/agent-bin:$REPO_DIR/tests/fakes/bin:$PATH" \
     WAVEMILL_REAL_TMUX="$REPO_DIR/tests/fakes/bin/tmux" FAKE_TMUX_REAL="" \
     bash -c '
       set -euo pipefail
       source "$1/tests/fakes/lib.sh"
       trap fakes_teardown EXIT
       fakes_setup "$2/world" acme/wrapper-loop main
       fakes_start_world_host wloop "$2/world"
       printf "real=%s\n" "$FAKE_TMUX_REAL"
       tmux list-sessions -F "session=#{session_name}"
     ' _ "$REPO_DIR" "$TMP" > "$WORLD_OUT" 2>&1; then
    grep -qx "real=$REAL_TMUX" "$WORLD_OUT" \
      && pass "agent-pane fakes world resolves the real tmux binary" \
      || fail "agent-pane fakes world resolves the real tmux binary ($(cat "$WORLD_OUT"))"
    grep -qx "session=wloop" "$WORLD_OUT" \
      && pass "agent-pane fakes world's tmux works through the fakes wrapper" \
      || fail "agent-pane fakes world's tmux works through the fakes wrapper ($(cat "$WORLD_OUT"))"
  else
    fail "agent-pane fakes world starts ($(cat "$WORLD_OUT"))"
  fi
else
  echo "  SKIP  agent-pane fakes world: no real tmux on PATH"
fi

# Both wrappers carry the fixed marker the resolver greps for (allow-world-
# lifetime: replaying the refusal is the point of this test).
if head -c 2048 "$AGENT_WRAPPER" | grep -qF 'WAVEMILL_TMUX_WRAPPER'; then
  pass "agent wrapper carries the WAVEMILL_TMUX_WRAPPER marker"
else
  fail "agent wrapper carries the WAVEMILL_TMUX_WRAPPER marker"
fi
if head -c 2048 "$FAKES_WRAPPER" | grep -qF 'WAVEMILL_TMUX_WRAPPER'; then
  pass "fakes wrapper carries the WAVEMILL_TMUX_WRAPPER marker"
else
  fail "fakes wrapper carries the WAVEMILL_TMUX_WRAPPER marker"
fi

echo ""
echo "--- tmux-wrapper-loop: $PASS passed, $FAIL failed ---"
(( FAIL == 0 ))