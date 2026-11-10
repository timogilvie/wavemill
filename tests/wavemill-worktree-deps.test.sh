#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB="$REPO_DIR/shared/lib/wavemill-worktree-deps.sh"

PASS=0
FAIL=0

pass() { echo "PASS $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL $1"; FAIL=$((FAIL + 1)); }

mk_sandbox() {
  local d
  d="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-deps-test.XXXXXX")"
  printf '%s\n' "$d"
}

write_pkg() {
  local dir="$1" pkg_mgr="$2" engines="$3" workspaces_json="$4"
  cat > "$dir/package.json" <<JSON
{
  "name": "fixture",
  "version": "1.0.0",
  "packageManager": "$pkg_mgr",
  "engines": { "node": "$engines" },
  "workspaces": $workspaces_json
}
JSON
}

write_lock() {
  local dir="$1" content="$2"
  printf '%s\n' "$content" > "$dir/pnpm-lock.yaml"
}

run_case() {
  local name="$1"
  shift
  if "$@"; then
    pass "$name"
  else
    fail "$name"
  fi
}

case_matching_reuse() {
  local sb bin parent wt logs
  sb="$(mk_sandbox)"
  bin="$sb/bin"; mkdir -p "$bin"
  parent="$sb/parent"; wt="$sb/wt"
  mkdir -p "$parent/node_modules/.bin" "$wt"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/pnpm"; chmod +x "$bin/pnpm"
  write_lock "$parent" "lock-a"; write_lock "$wt" "lock-a"
  write_pkg "$parent" "pnpm@10.0.0" ">=20" '["codex"]'
  write_pkg "$wt" "pnpm@10.0.0" ">=20" '["codex"]'
  echo "v20" > "$parent/.nvmrc"; echo "v20" > "$wt/.nvmrc"
  echo "ok" > "$parent/node_modules/.bin/sentinel"

  logs="$sb/logs.txt"; : > "$logs"
  PATH="$bin:$PATH"
  export WORKTREE_ROOT="$sb/worktrees"
  mkdir -p "$WORKTREE_ROOT"
  startup_log() { echo "$*" >> "$logs"; }
  startup_step() { :; }
  STATUS_LOG_FILE="$sb/status.txt"; export STATUS_LOG_FILE
  STARTUP_TASK_LOG_FILE=""; export STARTUP_TASK_LOG_FILE

  # shellcheck source=/dev/null
  source "$LIB"
  worktree_deps_ensure "$wt" "$parent" "HOK-1"

  [[ -e "$wt/node_modules/.bin/sentinel" ]]
  ! grep -q "installing deps" "$logs"
}

case_opt_out_installs() {
  local sb bin parent wt logs
  sb="$(mk_sandbox)"
  bin="$sb/bin"; mkdir -p "$bin"
  parent="$sb/parent"; wt="$sb/wt"
  mkdir -p "$parent/node_modules" "$wt"
  cat > "$bin/pnpm" <<'SH'
#!/usr/bin/env bash
printf 'pnpm-called\n' >> "${WAVEMILL_TEST_INSTALL_LOG:?}"
exit 0
SH
  chmod +x "$bin/pnpm"
  write_lock "$parent" "lock-a"; write_lock "$wt" "lock-a"
  write_pkg "$parent" "pnpm@10.0.0" ">=20" '["codex"]'
  write_pkg "$wt" "pnpm@10.0.0" ">=20" '["codex"]'
  echo "v20" > "$parent/.nvmrc"; echo "v20" > "$wt/.nvmrc"

  logs="$sb/logs.txt"; : > "$logs"
  PATH="$bin:$PATH"
  export WORKTREE_ROOT="$sb/worktrees"; mkdir -p "$WORKTREE_ROOT"
  export WAVEMILL_WORKTREE_DEPS_FAST_PATH=0
  export WAVEMILL_TEST_INSTALL_LOG="$sb/install.log"; : > "$WAVEMILL_TEST_INSTALL_LOG"
  startup_log() { echo "$*" >> "$logs"; }
  startup_step() { :; }
  STATUS_LOG_FILE="$sb/status.txt"; export STATUS_LOG_FILE
  STARTUP_TASK_LOG_FILE=""; export STARTUP_TASK_LOG_FILE

  # shellcheck source=/dev/null
  source "$LIB"
  worktree_deps_ensure "$wt" "$parent" "HOK-2"

  grep -q "pnpm-called" "$WAVEMILL_TEST_INSTALL_LOG"
  grep -q "installing deps: opt-out" "$logs"
}

case_lock_mismatch_installs() {
  local sb bin parent wt logs
  sb="$(mk_sandbox)"
  bin="$sb/bin"; mkdir -p "$bin"
  parent="$sb/parent"; wt="$sb/wt"
  mkdir -p "$parent/node_modules" "$wt"
  cat > "$bin/pnpm" <<'SH'
#!/usr/bin/env bash
printf 'pnpm-called\n' >> "${WAVEMILL_TEST_INSTALL_LOG:?}"
exit 0
SH
  chmod +x "$bin/pnpm"
  write_lock "$parent" "lock-a"; write_lock "$wt" "lock-b"
  write_pkg "$parent" "pnpm@10.0.0" ">=20" '["codex"]'
  write_pkg "$wt" "pnpm@10.0.0" ">=20" '["codex"]'
  echo "v20" > "$parent/.nvmrc"; echo "v20" > "$wt/.nvmrc"

  logs="$sb/logs.txt"; : > "$logs"
  PATH="$bin:$PATH"
  export WORKTREE_ROOT="$sb/worktrees"; mkdir -p "$WORKTREE_ROOT"
  export WAVEMILL_TEST_INSTALL_LOG="$sb/install.log"; : > "$WAVEMILL_TEST_INSTALL_LOG"
  unset WAVEMILL_WORKTREE_DEPS_FAST_PATH || true
  startup_log() { echo "$*" >> "$logs"; }
  startup_step() { :; }
  STATUS_LOG_FILE="$sb/status.txt"; export STATUS_LOG_FILE
  STARTUP_TASK_LOG_FILE=""; export STARTUP_TASK_LOG_FILE
  source "$LIB"

  worktree_deps_ensure "$wt" "$parent" "HOK-3"

  grep -q "pnpm-called" "$WAVEMILL_TEST_INSTALL_LOG"
  grep -q "installing deps: lockfile-hash-mismatch" "$logs"
}

case_pm_field_mismatch_installs() {
  local sb bin parent wt logs
  sb="$(mk_sandbox)"
  bin="$sb/bin"; mkdir -p "$bin"
  parent="$sb/parent"; wt="$sb/wt"
  mkdir -p "$parent/node_modules" "$wt"
  cat > "$bin/pnpm" <<'SH'
#!/usr/bin/env bash
printf 'pnpm-called\n' >> "${WAVEMILL_TEST_INSTALL_LOG:?}"
exit 0
SH
  chmod +x "$bin/pnpm"
  write_lock "$parent" "lock-a"; write_lock "$wt" "lock-a"
  write_pkg "$parent" "pnpm@10.0.0" ">=20" '["codex"]'
  write_pkg "$wt" "pnpm@9.0.0" ">=20" '["codex"]'
  echo "v20" > "$parent/.nvmrc"; echo "v20" > "$wt/.nvmrc"

  logs="$sb/logs.txt"; : > "$logs"
  PATH="$bin:$PATH"
  export WORKTREE_ROOT="$sb/worktrees"; mkdir -p "$WORKTREE_ROOT"
  export WAVEMILL_TEST_INSTALL_LOG="$sb/install.log"; : > "$WAVEMILL_TEST_INSTALL_LOG"
  startup_log() { echo "$*" >> "$logs"; }
  startup_step() { :; }
  STATUS_LOG_FILE="$sb/status.txt"; export STATUS_LOG_FILE
  STARTUP_TASK_LOG_FILE=""; export STARTUP_TASK_LOG_FILE
  source "$LIB"

  worktree_deps_ensure "$wt" "$parent" "HOK-4"

  grep -q "installing deps: package-manager-mismatch" "$logs"
}

case_node_sig_mismatch_installs() {
  local sb bin parent wt logs
  sb="$(mk_sandbox)"
  bin="$sb/bin"; mkdir -p "$bin"
  parent="$sb/parent"; wt="$sb/wt"
  mkdir -p "$parent/node_modules" "$wt"
  cat > "$bin/pnpm" <<'SH'
#!/usr/bin/env bash
printf 'pnpm-called\n' >> "${WAVEMILL_TEST_INSTALL_LOG:?}"
exit 0
SH
  chmod +x "$bin/pnpm"
  write_lock "$parent" "lock-a"; write_lock "$wt" "lock-a"
  write_pkg "$parent" "pnpm@10.0.0" ">=20" '["codex"]'
  write_pkg "$wt" "pnpm@10.0.0" ">=18" '["codex"]'
  echo "v20" > "$parent/.nvmrc"; echo "v20" > "$wt/.nvmrc"

  logs="$sb/logs.txt"; : > "$logs"
  PATH="$bin:$PATH"
  export WORKTREE_ROOT="$sb/worktrees"; mkdir -p "$WORKTREE_ROOT"
  export WAVEMILL_TEST_INSTALL_LOG="$sb/install.log"; : > "$WAVEMILL_TEST_INSTALL_LOG"
  startup_log() { echo "$*" >> "$logs"; }
  startup_step() { :; }
  STATUS_LOG_FILE="$sb/status.txt"; export STATUS_LOG_FILE
  STARTUP_TASK_LOG_FILE=""; export STARTUP_TASK_LOG_FILE
  source "$LIB"

  worktree_deps_ensure "$wt" "$parent" "HOK-5"

  grep -q "installing deps: node-signature-mismatch" "$logs"
}

case_workspace_mismatch_installs() {
  local sb bin parent wt logs
  sb="$(mk_sandbox)"
  bin="$sb/bin"; mkdir -p "$bin"
  parent="$sb/parent"; wt="$sb/wt"
  mkdir -p "$parent/node_modules" "$wt"
  cat > "$bin/pnpm" <<'SH'
#!/usr/bin/env bash
printf 'pnpm-called\n' >> "${WAVEMILL_TEST_INSTALL_LOG:?}"
exit 0
SH
  chmod +x "$bin/pnpm"
  write_lock "$parent" "lock-a"; write_lock "$wt" "lock-a"
  write_pkg "$parent" "pnpm@10.0.0" ">=20" '["codex"]'
  write_pkg "$wt" "pnpm@10.0.0" ">=20" '["other"]'
  echo "v20" > "$parent/.nvmrc"; echo "v20" > "$wt/.nvmrc"

  logs="$sb/logs.txt"; : > "$logs"
  PATH="$bin:$PATH"
  export WORKTREE_ROOT="$sb/worktrees"; mkdir -p "$WORKTREE_ROOT"
  export WAVEMILL_TEST_INSTALL_LOG="$sb/install.log"; : > "$WAVEMILL_TEST_INSTALL_LOG"
  startup_log() { echo "$*" >> "$logs"; }
  startup_step() { :; }
  STATUS_LOG_FILE="$sb/status.txt"; export STATUS_LOG_FILE
  STARTUP_TASK_LOG_FILE=""; export STARTUP_TASK_LOG_FILE
  source "$LIB"

  worktree_deps_ensure "$wt" "$parent" "HOK-6"

  grep -q "installing deps: workspaces-mismatch" "$logs"
}

case_missing_pm_warns_and_skips() {
  local sb parent wt logs
  sb="$(mk_sandbox)"
  parent="$sb/parent"; wt="$sb/wt"
  mkdir -p "$parent/node_modules" "$wt"
  write_lock "$wt" "lock-a"

  logs="$sb/logs.txt"; : > "$logs"
  PATH="/usr/bin:/bin"
  export WORKTREE_ROOT="$sb/worktrees"; mkdir -p "$WORKTREE_ROOT"
  startup_log() { echo "$*" >> "$logs"; }
  startup_step() { :; }
  STATUS_LOG_FILE="$sb/status.txt"; export STATUS_LOG_FILE
  STARTUP_TASK_LOG_FILE=""; export STARTUP_TASK_LOG_FILE
  source "$LIB"

  worktree_deps_ensure "$wt" "$parent" "HOK-7"

  grep -q "not on PATH; skipping dep install" "$logs"
}

case_non_js_noop() {
  local sb parent wt logs
  sb="$(mk_sandbox)"
  parent="$sb/parent"; wt="$sb/wt"
  mkdir -p "$parent" "$wt"

  logs="$sb/logs.txt"; : > "$logs"
  export WORKTREE_ROOT="$sb/worktrees"; mkdir -p "$WORKTREE_ROOT"
  startup_log() { echo "$*" >> "$logs"; }
  startup_step() { :; }
  STATUS_LOG_FILE="$sb/status.txt"; export STATUS_LOG_FILE
  STARTUP_TASK_LOG_FILE=""; export STARTUP_TASK_LOG_FILE
  source "$LIB"

  worktree_deps_ensure "$wt" "$parent" "HOK-8"

  [[ ! -s "$logs" ]]
}

case_reuse_failure_falls_back_and_cleans() {
  local sb bin parent wt logs
  sb="$(mk_sandbox)"
  bin="$sb/bin"; mkdir -p "$bin"
  parent="$sb/parent"; wt="$sb/wt"
  mkdir -p "$parent/node_modules" "$wt"
  echo "ok" > "$parent/node_modules/sentinel"

  cat > "$bin/pnpm" <<'SH'
#!/usr/bin/env bash
printf 'pnpm-called\n' >> "${WAVEMILL_TEST_INSTALL_LOG:?}"
exit 0
SH
  chmod +x "$bin/pnpm"
  cat > "$bin/cp" <<'SH'
#!/usr/bin/env bash
mkdir -p "$3/.partial"
exit 1
SH
  chmod +x "$bin/cp"
  cat > "$bin/ln" <<'SH'
#!/usr/bin/env bash
exit 1
SH
  chmod +x "$bin/ln"

  write_lock "$parent" "lock-a"; write_lock "$wt" "lock-a"
  write_pkg "$parent" "pnpm@10.0.0" ">=20" '["codex"]'
  write_pkg "$wt" "pnpm@10.0.0" ">=20" '["codex"]'
  echo "v20" > "$parent/.nvmrc"; echo "v20" > "$wt/.nvmrc"

  logs="$sb/logs.txt"; : > "$logs"
  PATH="$bin:/usr/bin:/bin"
  export WORKTREE_ROOT="$sb/worktrees"; mkdir -p "$WORKTREE_ROOT"
  export WAVEMILL_TEST_INSTALL_LOG="$sb/install.log"; : > "$WAVEMILL_TEST_INSTALL_LOG"
  startup_log() { echo "$*" >> "$logs"; }
  startup_step() { :; }
  STATUS_LOG_FILE="$sb/status.txt"; export STATUS_LOG_FILE
  STARTUP_TASK_LOG_FILE=""; export STARTUP_TASK_LOG_FILE
  source "$LIB"

  worktree_deps_ensure "$wt" "$parent" "HOK-9"

  [[ ! -e "$wt/node_modules" ]]
  grep -q "pnpm-called" "$WAVEMILL_TEST_INSTALL_LOG"
  grep -q "installing deps: reuse-failed-symlink" "$logs"
}

run_case "matching metadata reuses parent deps" case_matching_reuse
run_case "fast-path opt-out forces install" case_opt_out_installs
run_case "lock mismatch falls back to install" case_lock_mismatch_installs
run_case "packageManager mismatch falls back" case_pm_field_mismatch_installs
run_case "node signature mismatch falls back" case_node_sig_mismatch_installs
run_case "workspace mismatch falls back" case_workspace_mismatch_installs
run_case "missing package manager warns+skips" case_missing_pm_warns_and_skips
run_case "non-js repo is noop" case_non_js_noop
run_case "failed reuse cleans and installs" case_reuse_failure_falls_back_and_cleans

echo "Passed: $PASS"
echo "Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
