#!/usr/bin/env bash
# HOK-3100: guard test that forbids repo-relative or cwd-relative resolution
# of wavemill install assets. Any shell or TypeScript file that joins the
# milled repo path onto `tools/`, `shared/`, `dspy/`, `claude/` or `codex/`
# would silently break when wavemill runs on a non-wavemill repository.
#
# Each hit prints as `<file>:<line>: <rule>: <excerpt>`. The scanner is also
# self-tested against fixtures that must fail (to prevent weakening the regex
# accidentally) and against an allow-marked line that must pass.
#
# Escape hatch: a trailing `install-paths: allow <reason>` comment on the line.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP_DIR="$(mktemp -d -t wm-check-install-paths-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

HIT_FILE="$TMP_DIR/hits.txt"
: > "$HIT_FILE"

PASS=0
FAIL=0

pass() { echo "ok $1"; PASS=$((PASS + 1)); }
fail() { echo "not ok $1"; echo "  $2" >&2; FAIL=$((FAIL + 1)); }

ALLOW_MARKER_RE='install-paths: allow'

# Shell patterns — each is an ERE used with `grep -nE`.
SH_RULES_NAMES=(
  "repo-relative install asset"
  "repo-relative fallback"
  "cwd-relative tsx tool"
  "legacy WAVEMILL_REPO_DIR"
)
SH_RULES_PATTERNS=(
  '\$\{?(REPO_DIR|repo_dir|MAIN_REPO|main_repo|WORKTREE_DIR|worktree_dir|wt_dir|PWD)\}?/(tools|shared|dspy|claude|codex)/'
  ':-\$\{?(REPO_DIR|repo_dir|PWD)\}?/(tools|shared|dspy|claude|codex)'
  '(npx[[:space:]]+tsx|node[[:space:]]+--import[[:space:]]+tsx)[[:space:]]+["'\'']?(\./)?tools/'
  'WAVEMILL_REPO_DIR'
)

# TypeScript patterns.
TS_RULES_NAMES=(
  "repo/cwd-joined install asset"
  "bare tools/*.ts argv literal"
  "cwd-relative prompt load (fn)"
  "cwd-relative default prompt path"
  "legacy WAVEMILL_REPO_DIR"
)
TS_RULES_PATTERNS=(
  '(join|resolve)\(.*(repoDir|repoRoot|cwd|process\.cwd\(\)|worktreeDir).*,[[:space:]]*["'\''`](tools|dspy|shared|claude|codex)(/|["'\''`])'
  '["'\'']tools/[a-zA-Z0-9._/-]+\.ts["'\'']'
  '(loadPromptTemplate|readFileSync)\([[:space:]]*["'\'']tools/'
  '(\?\?|=)[[:space:]]*["'\'']tools/prompts/'
  'WAVEMILL_REPO_DIR'
)

# scan_files <flavour> <rules-array-name> <patterns-array-name> <file...>
# Appends `path:line: rule: excerpt` to $HIT_FILE for every matching line
# that is not allow-marked and not a comment-only line.
scan_files() {
  local flavour="$1" names_var="$2" patterns_var="$3"
  shift 3
  local -n names_ref="$names_var"
  local -n patterns_ref="$patterns_var"
  local i rule pattern raw file line excerpt comment_re
  if [[ "$flavour" == "shell" ]]; then
    comment_re='^[[:space:]]*#'
  else
    comment_re='^[[:space:]]*(//|\*|/\*)'
  fi
  for i in "${!names_ref[@]}"; do
    rule="${names_ref[$i]}"
    pattern="${patterns_ref[$i]}"
    while IFS=: read -r file line raw; do
      [[ -z "$file" ]] && continue
      excerpt="$raw"
      [[ "$excerpt" =~ $ALLOW_MARKER_RE ]] && continue
      [[ "$excerpt" =~ $comment_re ]] && continue
      printf '%s:%s: %s: %s\n' "$file" "$line" "$rule" "$excerpt" >> "$HIT_FILE"
    done < <(grep -HnE "$pattern" -- "$@" 2>/dev/null || true)
  done
}

# ------------------------------------------------------------------------------
# Self-tests on temp fixtures: proves the regexes still match. Weakening them
# fails CI.
# ------------------------------------------------------------------------------

_run_self_tests() {
  local sh_bad="$TMP_DIR/bad.sh"
  cat > "$sh_bad" <<'EOF'
#!/usr/bin/env bash
if [ -f "$REPO_DIR/tools/check-drift.ts" ]; then
  echo "bad"
fi
cd "$REPO_DIR" && npx tsx tools/foo.ts
status_script="${LIB_DIR:-$REPO_DIR/shared/lib}/wavemill-status.sh"
export WAVEMILL_REPO_DIR=/tmp/x
EOF

  local ts_bad="$TMP_DIR/bad.ts"
  cat > "$ts_bad" <<'EOF'
import { join } from 'node:path';
const p = join(repoDir, 'tools', 'route-task.ts');
const q = resolve(repoDir || '.', 'dspy/artifacts/x.json');
const args = ['tsx', 'tools/foo.ts'];
const t = await loadPromptTemplate('tools/prompts/x.md');
const envRepo = process.env.WAVEMILL_REPO_DIR;
EOF

  local sh_allow="$TMP_DIR/allow.sh"
  cat > "$sh_allow" <<'EOF'
#!/usr/bin/env bash
echo "$REPO_DIR/tools/foo.ts"  # install-paths: allow self-reference
EOF

  : > "$HIT_FILE"
  scan_files shell SH_RULES_NAMES SH_RULES_PATTERNS "$sh_bad"
  if [[ -s "$HIT_FILE" ]] \
     && grep -q "repo-relative install asset" "$HIT_FILE" \
     && grep -q "cwd-relative tsx tool" "$HIT_FILE" \
     && grep -q "repo-relative fallback" "$HIT_FILE" \
     && grep -q "legacy WAVEMILL_REPO_DIR" "$HIT_FILE"; then
    pass "self-test: shell fixture flagged all rules"
  else
    fail "self-test: shell fixture flagged all rules" "hits were: $(cat "$HIT_FILE")"
  fi

  : > "$HIT_FILE"
  scan_files ts TS_RULES_NAMES TS_RULES_PATTERNS "$ts_bad"
  if [[ -s "$HIT_FILE" ]] \
     && grep -q "repo/cwd-joined install asset" "$HIT_FILE" \
     && grep -q "bare tools/\*.ts argv literal" "$HIT_FILE" \
     && grep -q "cwd-relative prompt load" "$HIT_FILE" \
     && grep -q "legacy WAVEMILL_REPO_DIR" "$HIT_FILE"; then
    pass "self-test: ts fixture flagged all rules"
  else
    fail "self-test: ts fixture flagged all rules" "hits were: $(cat "$HIT_FILE")"
  fi

  : > "$HIT_FILE"
  scan_files shell SH_RULES_NAMES SH_RULES_PATTERNS "$sh_allow"
  if [[ ! -s "$HIT_FILE" ]]; then
    pass "self-test: allow marker suppresses hits"
  else
    fail "self-test: allow marker suppresses hits" "unexpected hits: $(cat "$HIT_FILE")"
  fi

  : > "$HIT_FILE"
}

_run_self_tests

# ------------------------------------------------------------------------------
# Scan production files.
# ------------------------------------------------------------------------------

SHELL_FILES=()
if [[ -f wavemill ]]; then
  SHELL_FILES+=("wavemill")
fi
while IFS= read -r f; do
  SHELL_FILES+=("$f")
done < <(
  find shared tools codex -type f -name '*.sh' \
    -not -name '*.test.sh' 2>/dev/null | sort
)

if ((${#SHELL_FILES[@]} > 0)); then
  scan_files shell SH_RULES_NAMES SH_RULES_PATTERNS "${SHELL_FILES[@]}"
fi

TS_FILES=()
while IFS= read -r f; do
  TS_FILES+=("$f")
done < <(
  find shared tools -type f -name '*.ts' \
    -not -name '*.test.ts' \
    -not -path '*/node_modules/*' 2>/dev/null | sort
)

if ((${#TS_FILES[@]} > 0)); then
  scan_files ts TS_RULES_NAMES TS_RULES_PATTERNS "${TS_FILES[@]}"
fi

if [[ -s "$HIT_FILE" ]]; then
  echo ""
  echo "Found forbidden install-asset path patterns:" >&2
  cat "$HIT_FILE" >&2
  echo "" >&2
  echo "Fix each line to resolve the asset from the wavemill install:" >&2
  echo "  TS:    import { resolveWavemillToolPath, resolveWavemillPromptPath, resolveWavemillAssetPath }" >&2
  echo "         from 'shared/lib/native-agent/install-paths.ts'" >&2
  echo "  Shell: use \"\$TOOLS_DIR/foo.ts\" or \$(wavemill_tool_path foo.ts)" >&2
  echo "" >&2
  echo "If a hit is legitimate, mark the line with a trailing" >&2
  echo "  # install-paths: allow <short reason>" >&2
  fail "install-path sweep" "$(wc -l < "$HIT_FILE") offending line(s)"
else
  pass "install-path sweep: no repo-relative install assets"
fi

echo ""
echo "# $PASS passed, $FAIL failed"
if (( FAIL > 0 )); then
  exit 1
fi
exit 0
