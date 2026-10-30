#!/usr/bin/env bash
#
# Run only the tests related to the current change.
#
#   bash tests/run-related.sh [--base <ref>] [--list] [--dry-run] [--no-journeys] [files...]
#
# Selection:
#   - TS: tests that import a changed module, transitively (regex scan +
#     reverse-dep index cached at .wavemill/cache/related-test-graph.json).
#   - Shell: tests that reference a changed .sh file (by basename) or call a
#     function it defines.
#   - Preflight guards: `npm run test:preflight` when any file under
#     tools/check-*.ts, tests/check-*.test.sh, tests/check-*.test.ts, or
#     shared/lib/*.sh is changed.
#   - Journeys: tests/journeys/run-journeys.sh when any mill-core path is
#     changed (toggleable with --no-journeys).
#
# Change set defaults to:
#   git diff --name-only <base>...HEAD ∪ unstaged ∪ staged
# where <base> is the first available of:
#   origin/auto/integration, origin/main, main.
#
# Positional files override the diff.
#
# Target budget: under 60 s for a typical single-module change (no mill-core
# edit). The script prints [elapsed] at the end so agents and CI can verify.
#
# Env:
#   WAVEMILL_RUN_RELATED_SCAN_ROOTS  Colon-separated dirs for the TS graph
#                                    scan (test-only override).
#   WAVEMILL_RUN_RELATED_FAKE_RUNNER When set, the executor prints [FAKE] for
#                                    each selected test and exits 0 without
#                                    running anything. Used by the measurement
#                                    helper to time selection, not test
#                                    execution.
#
# Exit codes:
#   0 nothing selected OR all selected pass
#   1 at least one selected test failed
#   2 argument/usage error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

print_usage() {
  cat <<'EOF'
Usage: bash tests/run-related.sh [--base <ref>] [--list] [--dry-run] [--no-journeys] [files...]

Options:
  --base <ref>     Diff base (default: origin/auto/integration, falling back
                   to origin/main, then main).
  --list           Print selected tests, one per line, and exit 0.
  --dry-run        Print the full plan with reason tags and exit 0.
  --no-journeys    Suppress journey-suite injection even if mill-core paths
                   changed.
  --help           Show this message.

Positional files...: override the diff. When given, exactly these files are
treated as the change set.

Risks and misses:
  - TS selection uses regex-only import resolution; dynamic imports via
    computed strings and tsconfig path-alias remaps may be missed. Any
    change to tsconfig*.json or package.json falls back to running the
    preflight guards (safe superset).
  - Shell selection is coarse (basename grep + function-name whole-word
    scan). It errs on the side of running an unrelated test rather than
    missing a related one.
EOF
}

BASE_REF=""
LIST_ONLY=0
DRY_RUN=0
NO_JOURNEYS=0
POSITIONAL_FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      shift
      [[ $# -gt 0 ]] || { echo "run-related.sh: --base requires an argument" >&2; exit 2; }
      BASE_REF="$1"
      shift
      ;;
    --base=*)
      BASE_REF="${1#--base=}"
      shift
      ;;
    --list) LIST_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-journeys) NO_JOURNEYS=1; shift ;;
    --help|-h) print_usage; exit 0 ;;
    --) shift; while [[ $# -gt 0 ]]; do POSITIONAL_FILES+=("$1"); shift; done ;;
    --*) echo "run-related.sh: unknown argument: $1" >&2; print_usage >&2; exit 2 ;;
    *) POSITIONAL_FILES+=("$1"); shift ;;
  esac
done

timestamp_start=$(date +%s)

resolve_base_ref() {
  if [[ -n "$BASE_REF" ]]; then
    if git -C "$REPO_ROOT" rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
      echo "$BASE_REF"
      return 0
    fi
    echo "run-related.sh: --base '$BASE_REF' does not resolve to a known ref" >&2
    return 1
  fi
  for cand in origin/auto/integration origin/main main; do
    if git -C "$REPO_ROOT" rev-parse --verify "$cand" >/dev/null 2>&1; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

compute_change_set() {
  if [[ ${#POSITIONAL_FILES[@]} -gt 0 ]]; then
    printf '%s\n' "${POSITIONAL_FILES[@]}" | sort -u
    return 0
  fi
  local base
  if ! base="$(resolve_base_ref)"; then
    # User explicitly asked for --base and it was invalid: resolve_base_ref
    # printed the error to stderr. A silent fallback would run on the wrong
    # change set, so bail out as a usage error.
    if [[ -n "$BASE_REF" ]]; then
      exit 2
    fi
    # Auto-fallback case: no candidate base available. Use just the local diff.
    {
      git -C "$REPO_ROOT" diff --name-only 2>/dev/null || true
      git -C "$REPO_ROOT" diff --name-only --cached 2>/dev/null || true
    } | sort -u
    return 0
  fi
  {
    git -C "$REPO_ROOT" diff --name-only "$base"...HEAD 2>/dev/null || true
    git -C "$REPO_ROOT" diff --name-only 2>/dev/null || true
    git -C "$REPO_ROOT" diff --name-only --cached 2>/dev/null || true
  } | sort -u
}

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wm-run-related.XXXXXX")"
cleanup_tmp() { rm -rf "$TMP_DIR"; }
trap cleanup_tmp EXIT

CHANGE_FILE="$TMP_DIR/changed.txt"
compute_change_set > "$CHANGE_FILE"

# Drop empty lines
awk 'NF' "$CHANGE_FILE" > "$CHANGE_FILE.tmp" && mv "$CHANGE_FILE.tmp" "$CHANGE_FILE"

if [[ ! -s "$CHANGE_FILE" ]]; then
  echo "[INFO] No changes vs base and no files provided; nothing to run."
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[run-related] changed files:"
  while IFS= read -r line; do
    printf '  %s\n' "$line"
  done < "$CHANGE_FILE"
fi

PLAN_JSON="$TMP_DIR/plan.json"
SELECT_ARGS=()
if [[ "$NO_JOURNEYS" -eq 1 ]]; then SELECT_ARGS+=(--no-journeys); fi
SELECT_ARGS+=(--repo-root "$REPO_ROOT" --files-from "$CHANGE_FILE")

if ! node "$REPO_ROOT/tools/related-tests/select.ts" "${SELECT_ARGS[@]}" > "$PLAN_JSON" 2> "$TMP_DIR/select.err"; then
  cat "$TMP_DIR/select.err" >&2
  exit 2
fi

# Parse plan with jq if present; otherwise with node (jq is nearly always
# installed on this repo's hosts, but keep a fallback). The node fallbacks
# default to CommonJS (no --input-type) so `require` is available.
mapfile -t SELECTED_LINES < <(
  if command -v jq >/dev/null 2>&1; then
    jq -r '.tests[] | "\(.path)\t\(.runner)\t\(.reason)"' "$PLAN_JSON"
  else
    node -e "const d=JSON.parse(require('fs').readFileSync('$PLAN_JSON','utf8'));for(const t of d.tests){console.log(t.path+'\t'+t.runner+'\t'+t.reason);}"
  fi
)

JOURNEYS_INJECTED="$(
  if command -v jq >/dev/null 2>&1; then
    jq -r '.journeysInjected' "$PLAN_JSON"
  else
    node -e "console.log(JSON.parse(require('fs').readFileSync('$PLAN_JSON','utf8')).journeysInjected)"
  fi
)"

if [[ ${#SELECTED_LINES[@]} -eq 0 ]]; then
  echo "[INFO] No tests selected for the current change."
  if [[ "$LIST_ONLY" -eq 1 || "$DRY_RUN" -eq 1 ]]; then
    exit 0
  fi
  exit 0
fi

if [[ "$LIST_ONLY" -eq 1 ]]; then
  for row in "${SELECTED_LINES[@]}"; do
    IFS=$'\t' read -r p _runner _reason <<< "$row"
    printf '%s\n' "$p"
  done
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[run-related] plan (${#SELECTED_LINES[@]} entries):"
  for row in "${SELECTED_LINES[@]}"; do
    IFS=$'\t' read -r p runner reason <<< "$row"
    printf '  [%s] %-72s %s\n' "$reason" "$p" "$runner"
  done
  elapsed=$(( $(date +%s) - timestamp_start ))
  echo "[elapsed] ${elapsed}s (plan only)"
  exit 0
fi

# Group entries by runner.
NODE_TEST_FILES=()
TSX_TEST_FILES=()
BASH_TEST_FILES=()
RUN_PREFLIGHT=0
RUN_JOURNEYS=0

for row in "${SELECTED_LINES[@]}"; do
  IFS=$'\t' read -r p runner _reason <<< "$row"
  case "$runner" in
    node-test) NODE_TEST_FILES+=("$p") ;;
    tsx-single) TSX_TEST_FILES+=("$p") ;;
    bash-test) BASH_TEST_FILES+=("$p") ;;
    preflight) RUN_PREFLIGHT=1 ;;
    journeys) RUN_JOURNEYS=1 ;;
    *) echo "[WARN] unknown runner: $runner" >&2 ;;
  esac
done

FAILED_FILES=()
run_label() {
  echo "[run] $*"
}

report_failure() {
  local label="$1"
  local output_file="$2"
  echo "[FAIL] $label"
  if [[ -s "$output_file" ]]; then
    local total
    total=$(wc -l < "$output_file" | tr -d ' ')
    head -n 20 "$output_file" | sed 's/^/  /'
    if [[ "$total" -gt 20 ]]; then
      local rest=$((total - 20))
      echo "  [...$rest lines truncated]"
    fi
  else
    echo "  (no output captured)"
  fi
}

run_one() {
  local label="$1"; shift
  local output="$TMP_DIR/out.$(printf '%s' "$label" | tr '/.:' '___').log"
  run_label "$label"
  if [[ -n "${WAVEMILL_RUN_RELATED_FAKE_RUNNER:-}" ]]; then
    echo "[FAKE] $label"
    echo "[OK] $label"
    return 0
  fi
  if ( cd "$REPO_ROOT" && "$@" ) > "$output" 2>&1; then
    echo "[OK] $label"
    return 0
  else
    FAILED_FILES+=("$label"$'\t'"$output")
    return 0
  fi
}

# Preflight runs first (fast, catches structural errors early).
if [[ "$RUN_PREFLIGHT" -eq 1 ]]; then
  run_one "preflight (npm run test:preflight)" npm run test:preflight
fi

# Unit tests via node --test (single invocation batches them).
if [[ ${#NODE_TEST_FILES[@]} -gt 0 ]]; then
  run_one "node --test (${#NODE_TEST_FILES[@]} files)" node --test "${NODE_TEST_FILES[@]}"
fi

# Custom-harness TS tests under tsx.
for tf in "${TSX_TEST_FILES[@]}"; do
  run_one "tsx $tf" npx tsx "$tf"
done

# Bash tests under bash.
for sf in "${BASH_TEST_FILES[@]}"; do
  run_one "bash $sf" bash "$sf"
done

# Journeys last (longest).
if [[ "$RUN_JOURNEYS" -eq 1 ]]; then
  echo "[mill-core] running journey suite" >&2
  run_one "journeys (tests/journeys/run-journeys.sh)" bash tests/journeys/run-journeys.sh
fi

elapsed=$(( $(date +%s) - timestamp_start ))

if [[ ${#FAILED_FILES[@]} -eq 0 ]]; then
  echo "[OK] all ${#SELECTED_LINES[@]} selected tests passed"
  echo "[elapsed] ${elapsed}s"
  exit 0
fi

echo
echo "[run-related] ${#FAILED_FILES[@]} failing:"
for row in "${FAILED_FILES[@]}"; do
  IFS=$'\t' read -r label output_file <<< "$row"
  report_failure "$label" "$output_file"
done
echo "[elapsed] ${elapsed}s"
exit 1
