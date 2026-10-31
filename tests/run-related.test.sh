#!/usr/bin/env bash
# Self-test for tests/run-related.sh.
#
# Builds a mktemp fake repo with:
#   - a tiny TS graph (a.ts imports b.ts; tests/a.test.ts imports a.ts)
#   - a tiny shell dep tree (lib.sh sourced by tests/lib.test.sh)
#
# Then exercises --list, --dry-run, mill-core injection, --no-journeys, and
# the [FAIL] truncation path. All writes go to the mktemp tree (no tracked
# repo paths), satisfying the HOK-3157 tracked-tree guard.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_RELATED="$REPO_ROOT/tests/run-related.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1 — $2"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/wm-run-related-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

FAKE_REPO="$TMP/repo"
mkdir -p "$FAKE_REPO/shared/lib" "$FAKE_REPO/tools/related-tests" "$FAKE_REPO/tests"

# TS graph: a.ts imports b.ts; tests/a.test.ts imports a.ts
cat > "$FAKE_REPO/shared/lib/b.ts" <<'EOF'
export const b = 1;
EOF
cat > "$FAKE_REPO/shared/lib/a.ts" <<'EOF'
import { b } from './b.ts';
export const a = b + 1;
EOF
cat > "$FAKE_REPO/tests/a.test.ts" <<'EOF'
import assert from 'node:assert/strict';
import { a } from '../shared/lib/a.ts';
import { test } from 'node:test';
test('a', () => { assert.equal(a, 2); });
EOF

# Shell dep: lib.sh sourced by tests/lib.test.sh
cat > "$FAKE_REPO/shared/lib/lib.sh" <<'EOF'
#!/usr/bin/env bash
mylib_helper_fn() { echo "mylib: $1"; }
EOF
cat > "$FAKE_REPO/tests/lib.test.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
source "$(dirname "$0")/../shared/lib/lib.sh"
mylib_helper_fn "hello"
EOF
chmod +x "$FAKE_REPO/tests/lib.test.sh"

# Minimal registration files so run-related.sh classifies the test runners.
cat > "$FAKE_REPO/tests/run-unit-tests.sh" <<'EOF'
#!/usr/bin/env bash
TESTS=(
  tests/a.test.ts
)
EOF
cat > "$FAKE_REPO/tests/run-shell-suite.sh" <<'EOF'
#!/usr/bin/env bash
TESTS=(
  lib.test.sh
)
EOF
cat > "$FAKE_REPO/tests/run-custom-tests.sh" <<'EOF'
#!/usr/bin/env bash
CUSTOM_TS_TESTS=(
)
CUSTOM_SH_TESTS=(
)
EOF

# Install a minimal set of tooling the real selector will shell out to:
# we invoke the real repo's `node tools/related-tests/select.ts`, but we
# override the diff with positional files and WAVEMILL_RUN_RELATED_SCAN_ROOTS
# so the scan only sees our fake tree.
cp "$REPO_ROOT/tools/related-tests/select.ts" "$FAKE_REPO/tools/related-tests/"
cp "$REPO_ROOT/tools/related-tests/select-core.ts" "$FAKE_REPO/tools/related-tests/"
cp "$REPO_ROOT/tools/related-tests/build-ts-graph.ts" "$FAKE_REPO/tools/related-tests/"
cp "$REPO_ROOT/tests/run-related.sh" "$FAKE_REPO/tests/"
chmod +x "$FAKE_REPO/tests/run-related.sh"

# Point module resolution at the real node_modules so the fake repo can resolve it.
export NODE_PATH="$REPO_ROOT/node_modules"

run_in_fake() {
  (
    cd "$FAKE_REPO"
    WAVEMILL_RUN_RELATED_SCAN_ROOTS="$FAKE_REPO/shared:$FAKE_REPO/tools:$FAKE_REPO/tests" \
      WAVEMILL_RUN_RELATED_FAKE_RUNNER=1 \
      bash "$FAKE_REPO/tests/run-related.sh" "$@"
  )
}

echo "=== --list surfaces TS transitive dep ==="
OUT="$(run_in_fake --list shared/lib/b.ts 2>&1 || true)"
if printf '%s\n' "$OUT" | grep -q '^tests/a\.test\.ts$'; then
  pass "TS transitive dep: changing b.ts selects tests/a.test.ts"
else
  fail "TS transitive dep" "did not find tests/a.test.ts in --list output: $OUT"
fi

echo "=== shell-dep selects tests/lib.test.sh ==="
OUT="$(run_in_fake --list shared/lib/lib.sh 2>&1 || true)"
if printf '%s\n' "$OUT" | grep -q '^tests/lib\.test\.sh$'; then
  pass "shell-dep: changing lib.sh selects tests/lib.test.sh"
else
  fail "shell-dep" "did not find tests/lib.test.sh in --list output: $OUT"
fi

echo "=== mill-core triggers journeys ==="
# Create the mill-core sentinel path in the fake tree so classification sees it.
mkdir -p "$FAKE_REPO/shared/lib"
touch "$FAKE_REPO/shared/lib/wavemill-monitor.sh"
OUT="$(run_in_fake --dry-run shared/lib/wavemill-monitor.sh 2>&1 || true)"
if printf '%s\n' "$OUT" | grep -q '__journeys__'; then
  pass "mill-core: journeys injected"
else
  fail "mill-core" "no __journeys__ in dry-run: $OUT"
fi

echo "=== --no-journeys suppresses journey injection ==="
OUT="$(run_in_fake --dry-run --no-journeys shared/lib/wavemill-monitor.sh 2>&1 || true)"
if printf '%s\n' "$OUT" | grep -q '__journeys__'; then
  fail "--no-journeys" "found __journeys__ despite flag: $OUT"
else
  pass "--no-journeys suppresses journeys"
fi

echo "=== --list output is deterministic and sorted ==="
# Add a second test to the fake unit TESTS array and change multiple files.
cat >> "$FAKE_REPO/tests/run-unit-tests.sh" <<'EOF'
TESTS=(
  tests/a.test.ts
  tests/z.test.ts
)
EOF
# Overwrite — only the last TESTS=() counts due to our shell parser.
cat > "$FAKE_REPO/tests/run-unit-tests.sh" <<'EOF'
#!/usr/bin/env bash
TESTS=(
  tests/a.test.ts
  tests/z.test.ts
)
EOF
cat > "$FAKE_REPO/tests/z.test.ts" <<'EOF'
import assert from 'node:assert/strict';
import { b } from '../shared/lib/b.ts';
import { test } from 'node:test';
test('z', () => { assert.equal(b, 1); });
EOF
OUT1="$(run_in_fake --list shared/lib/b.ts 2>&1 || true)"
OUT2="$(run_in_fake --list shared/lib/b.ts 2>&1 || true)"
if [[ "$OUT1" == "$OUT2" ]]; then
  pass "deterministic: two --list runs match"
else
  fail "deterministic" "mismatched runs"
fi
# Sorted check: output lines are already sorted
SORTED="$(printf '%s\n' "$OUT1" | LC_ALL=C sort)"
if [[ "$OUT1" == "$SORTED" ]]; then
  pass "sorted: --list output is in ASCII order"
else
  fail "sorted" "output not sorted:\n$OUT1\n---sorted---\n$SORTED"
fi

echo "=== [FAIL] output truncates to first 20 lines ==="
# Create a shell test that fails with 100 lines of output, drive run-related
# with WAVEMILL_RUN_RELATED_FAKE_RUNNER unset so the real runner executes.
FAKE_REPO2="$TMP/repo2"
mkdir -p "$FAKE_REPO2/shared/lib" "$FAKE_REPO2/tools/related-tests" "$FAKE_REPO2/tests"
cp "$REPO_ROOT/tools/related-tests/"*.ts "$FAKE_REPO2/tools/related-tests/"
cp "$REPO_ROOT/tests/run-related.sh" "$FAKE_REPO2/tests/"
chmod +x "$FAKE_REPO2/tests/run-related.sh"
cat > "$FAKE_REPO2/shared/lib/subject.sh" <<'EOF'
#!/usr/bin/env bash
subject_sh_do_a_thing() { echo "subject_sh"; }
EOF
cat > "$FAKE_REPO2/tests/loud.test.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
source "$(dirname "$0")/../shared/lib/subject.sh"
for i in $(seq 1 100); do echo "LOUD-OUTPUT-LINE-$i"; done
exit 1
EOF
chmod +x "$FAKE_REPO2/tests/loud.test.sh"
cat > "$FAKE_REPO2/tests/run-unit-tests.sh" <<'EOF'
#!/usr/bin/env bash
TESTS=()
EOF
cat > "$FAKE_REPO2/tests/run-shell-suite.sh" <<'EOF'
#!/usr/bin/env bash
TESTS=(
  loud.test.sh
)
EOF
cat > "$FAKE_REPO2/tests/run-custom-tests.sh" <<'EOF'
#!/usr/bin/env bash
CUSTOM_TS_TESTS=()
CUSTOM_SH_TESTS=()
EOF
OUT="$(
  cd "$FAKE_REPO2"
  WAVEMILL_RUN_RELATED_SCAN_ROOTS="$FAKE_REPO2/shared:$FAKE_REPO2/tests" \
    bash "$FAKE_REPO2/tests/run-related.sh" shared/lib/subject.sh 2>&1 || true
)"
# Count LOUD-OUTPUT-LINE occurrences in reported output; must be <= 20
COUNT=$(printf '%s\n' "$OUT" | grep -c 'LOUD-OUTPUT-LINE' || true)
if [[ "$COUNT" -gt 0 && "$COUNT" -le 20 ]] && printf '%s\n' "$OUT" | grep -q 'lines truncated'; then
  pass "[FAIL] truncates output to 20 lines + emits truncation marker"
else
  fail "truncation" "LOUD count=$COUNT, truncation marker missing. Output head:\n$(printf '%s\n' "$OUT" | head -25)"
fi

echo
echo "Results: PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
