#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d "/tmp/wavemill-global-parity.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

REPO_DIR="$TMP_DIR/repo"
GLOBAL_ROOT="$TMP_DIR/global"
mkdir -p "$REPO_DIR" "$GLOBAL_ROOT"

cat > "$REPO_DIR/.wavemill-config.json" <<'JSON'
{
  "challenge": { "enabled": true, "rate": 1, "models": ["claude-sonnet-5"] },
  "router": { "defaultAgent": "claude" },
  "providers": { "openrouter": { "enabled": true, "apiKeyEnv": "TEST_PARITY_OPENROUTER_KEY" } }
}
JSON

set +e
WAVEMILL_NATIVE_CERTIFICATION_ROOT="$GLOBAL_ROOT" node "$ROOT_DIR/tools/parity-report.ts" --json --repo-dir "$REPO_DIR" >/tmp/wavemill-parity-forbidden.json
forbidden_rc=$?
set -e

if [[ "$forbidden_rc" != "2" ]]; then
  echo "expected forbidden config exit 2, got $forbidden_rc" >&2
  exit 1
fi

if ! jq -e '.forbiddenLocalConfig[] | select(.path == "challenge.models")' /tmp/wavemill-parity-forbidden.json >/dev/null; then
  echo "expected challenge.models forbidden config in JSON report" >&2
  exit 1
fi

cat > "$REPO_DIR/.wavemill-config.json" <<'JSON'
{
  "challenge": { "enabled": true, "rate": 1 },
  "router": { "defaultAgent": "claude" },
  "providers": { "openrouter": { "enabled": true, "apiKeyEnv": "TEST_PARITY_OPENROUTER_KEY" } }
}
JSON

set +e
WAVEMILL_NATIVE_CERTIFICATION_ROOT="$GLOBAL_ROOT" node "$ROOT_DIR/tools/parity-report.ts" --json --strict-challenge --repo-dir "$REPO_DIR" >/tmp/wavemill-parity-strict.json
strict_rc=$?
set -e

if [[ "$strict_rc" != "3" ]]; then
  echo "expected strict challenge exit 3, got $strict_rc" >&2
  exit 1
fi

if ! jq -e '.challengePairAvailability.coding == false' /tmp/wavemill-parity-strict.json >/dev/null; then
  echo "expected coding challenge pair to be unavailable" >&2
  exit 1
fi
