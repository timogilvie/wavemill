#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

make_legacy_repo() {
  local repo="$1"
  mkdir -p "$repo"
  cat > "$repo/.wavemill-config.json" <<'JSON'
{
  "modelRegistry": {"models": {"legacy-model": {}}, "ladders": {"coder": ["legacy-model"]}},
  "router": {
    "enabled": true,
    "defaultAgent": "claude",
    "defaultModel": "legacy-model",
    "models": ["legacy-model"],
    "availableModels": {"coder": ["legacy-model"]},
    "agentMap": {"legacy-model": "native-openrouter"}
  },
  "challenge": {
    "enabled": true,
    "models": ["legacy-model"],
    "comparisonModel": "legacy-judge"
  },
  "providers": {
    "openrouter": {
      "enabled": true,
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "models": ["legacy-model"],
      "stages": ["coder"]
    },
    "deepseek": {
      "enabled": true,
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": ["deepseek-legacy"],
      "stages": ["coder"]
    }
  },
  "nativeAgent": {
    "providers": {
      "openai": {"enabled": true, "apiKeyEnv": "OPENAI_API_KEY", "models": ["gpt-legacy"]},
      "openrouter": {"enabled": true, "apiKeyEnv": "OPENROUTER_API_KEY", "models": ["openrouter/legacy"]}
    }
  }
}
JSON
}

assert_contains() {
  local label="$1" file="$2" needle="$3"
  if ! grep -q "$needle" "$file"; then
    echo "FAIL: $label"
    echo "expected: $needle"
    echo "actual:"
    cat "$file" 2>/dev/null || true
    exit 1
  fi
}

FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/bash-stub" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$WAVEMILL_BASH_STUB_LOG"
exit 0
EOF
cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$WAVEMILL_TMUX_STUB_LOG"
exit 0
EOF
# Positive-control npx (in its own PATH dir): pretends the mill config
# preflight passes so the second case can assert that a successful preflight
# does not block dry-run startup. Kept out of FAKE_BIN so the first case still
# runs the real preflight tool.
PASS_BIN="$TMP_DIR/pass"
mkdir -p "$PASS_BIN"
cat > "$PASS_BIN/npx" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BIN/bash-stub" "$FAKE_BIN/tmux" "$PASS_BIN/npx"

legacy_repo="$TMP_DIR/legacy"
make_legacy_repo "$legacy_repo"
stderr_file="$TMP_DIR/preflight.stderr"
bash_log="$TMP_DIR/bash.log"
tmux_log="$TMP_DIR/tmux.log"
: > "$bash_log"
: > "$tmux_log"

set +e
(
  cd "$legacy_repo"
  unset WAVEMILL_MILL_ACTIVE
  PATH="$FAKE_BIN:$PATH" \
    BASH="$FAKE_BIN/bash-stub" \
    SKIP_CONTEXT_CHECK=true \
    WAVEMILL_BASH_STUB_LOG="$bash_log" \
    WAVEMILL_TMUX_STUB_LOG="$tmux_log" \
    "$REPO_DIR/wavemill" mill --dry-run
) >"$TMP_DIR/preflight.stdout" 2>"$stderr_file"
rc=$?
set -e

if (( rc == 0 )); then
  echo "FAIL: legacy config should fail mill preflight"
  exit 1
fi
assert_contains "preflight failure is printed" "$stderr_file" "Mill preflight failed"
assert_contains "migration command is printed" "$stderr_file" "wavemill config migrate-model-settings"
if [[ -s "$bash_log" || -s "$tmux_log" ]]; then
  echo "FAIL: mill startup proceeded after failed preflight"
  cat "$bash_log" "$tmux_log"
  exit 1
fi

skip_stderr="$TMP_DIR/skip.stderr"
set +e
(
  cd "$legacy_repo"
  unset WAVEMILL_MILL_ACTIVE
  PATH="$PASS_BIN:$FAKE_BIN:$PATH" \
    BASH="$FAKE_BIN/bash-stub" \
    SKIP_CONTEXT_CHECK=true \
    WAVEMILL_BASH_STUB_LOG="$bash_log" \
    WAVEMILL_TMUX_STUB_LOG="$tmux_log" \
    "$REPO_DIR/wavemill" mill --dry-run
) >"$TMP_DIR/skip.stdout" 2>"$skip_stderr"
skip_rc=$?
set -e

# Positive control: a passing preflight (stubbed npx) does not block startup.
assert_contains "passing preflight proceeds into dry-run startup" "$skip_stderr" "Dry-run requires WAVEMILL_DRY_RUN_BACKLOG_FILE"
if [[ -s "$bash_log" || -s "$tmux_log" ]]; then
  echo "FAIL: dry-run startup invoked the bash/tmux stubs before the backlog check"
  cat "$bash_log" "$tmux_log"
  exit 1
fi

echo "PASS: mill config preflight aborts before startup and a passing preflight does not block"
