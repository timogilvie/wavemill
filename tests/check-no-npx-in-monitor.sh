#!/usr/bin/env bash
# HOK-3190: forbid raw `npx tsx <TOOL>` invocations in the hot monitor path.
#
# The monitor loop runs hundreds of tool spawns per pass; using `npx tsx`
# costs 4–7 s of cold start each time, while `node --experimental-strip-types`
# (via `wavemill_run_tool`, defined in shared/lib/wavemill-common.sh) is
# ~0.3 s. Any new `npx tsx` added to the monitor or the libraries it sources
# must either go through that helper or be explicitly allowlisted below.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== No raw \`npx tsx\` on monitor hot path (HOK-3190) ==="

TARGETS=(
  "shared/lib/wavemill-monitor.sh"
  "shared/lib/wavemill-common.sh"
)

# Lines containing any of these fixed substrings are allowed. The allowlist
# shrinks over time as more sites move onto `wavemill_run_tool`.
ALLOW_SUBSTRINGS=(
  # Documentation / comments inside wavemill_run_tool itself and nearby.
  '# start) instead of `npx tsx`'
  '# WAVEMILL_SKIP_FAST_STRIP=1 forces the npx tsx path'
  "function named \`npx\` (see tests/*.sh) rely on the \`npx tsx <path>"
  # The fallback branch inside wavemill_run_tool.
  'npx tsx "$cli" "$@"'
  # Fallback inside trim_terminal_task_overflow_if_needed / startup migration.
  '|| npx tsx "$tool" "${args[@]}" 2>/dev/null'
  # _wavemill_tsx_invoker fallback branch and its header comment.
  "    printf 'npx tsx'"
  '`npx tsx`) for callers that build a command string for `eval`'
  # Backstage pane launchers assembled via printf -v for `exec env ...` (long-lived).
  "exec env WAVEMILL_SESSION=%q WAVEMILL_ISSUE=%q npx tsx %q"
  "exec env WAVEMILL_SESSION=%q WAVEMILL_BACKSTAGE_OBSERVER_PANE_TITLE=%q WAVEMILL_OBSERVER_SERVICE=1 npx tsx %q"
  # Informational message inside expand_issue_with_tool.
  'echo "  Running: npx tsx expand-issue.ts'
  # expand_issue_with_tool argv array form.
  'if npx tsx "${cmd_args[@]}" 2>&1'
  # One-off inline eval form (not a tool CLI launch).
  'npx tsx -e "$selector_script"'
  # Operator-facing restart hints (strings printed to users).
  'detail="Backstage window'
  "detail=\"Backstage tend"
  '1. Inspect \`npx tsx $TOOLS_DIR/challenge-eval-evidence.ts'
  '2. Or assess/supersede the pair with \`npx tsx $TOOLS_DIR/challenge-pair-recovery.ts'
  # fetch_queue_plan builds the planner command as a string for eval. Phase 5
  # (HOK-3190) will promote this to a tracked job and drop the eval.
  'planner_cmd="npx tsx \"$TOOLS_DIR/plan-queue.ts\"'
  '#   $1 = planner command (as single string: "npx tsx tools/plan-queue.ts'
)

is_allowed() {
  local line="$1" sub
  for sub in "${ALLOW_SUBSTRINGS[@]}"; do
    if [[ "$line" == *"$sub"* ]]; then
      return 0
    fi
  done
  return 1
}

violations=0
for rel in "${TARGETS[@]}"; do
  file="$REPO_DIR/$rel"
  [[ -f "$file" ]] || continue
  while IFS=: read -r line_no content; do
    [[ -z "$content" ]] && continue
    if is_allowed "$content"; then
      continue
    fi
    echo "    $rel:$line_no: $content"
    violations=$((violations + 1))
  done < <(grep -nF 'npx tsx' "$file" || true)
done

if (( violations == 0 )); then
  pass "no raw \`npx tsx\` on monitor hot path"
else
  fail "$violations raw \`npx tsx\` site(s) on monitor hot path"
  echo ""
  echo "  Use \`wavemill_run_tool <tool-basename.ts> [args...]\` instead, or"
  echo "  add a fixed-substring entry to ALLOW_SUBSTRINGS in"
  echo "  tests/check-no-npx-in-monitor.sh with a reason."
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
exit $((FAIL > 0 ? 1 : 0))
