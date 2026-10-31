#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1: ${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d)"
HARNESS="$REPO_DIR/.tmp-native-command-sandbox-harness-$$.ts"
ROOT="$TMP_ROOT/root"
OUTSIDE="$TMP_ROOT/outside"
TRANSCRIPT_PATH="$TMP_ROOT/command-transcript.jsonl"
SENTINEL="$ROOT/sentinel.txt"
trap 'rm -rf "$TMP_ROOT"; rm -f "$HARNESS"' EXIT

mkdir -p "$ROOT" "$OUTSIDE"
printf 'still-here\n' > "$SENTINEL"

cat > "$HARNESS" <<'EOF'
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';

import { runCommand } from '__REPO_DIR__/shared/lib/native-agent/command-substrate.ts';
import { TranscriptWriter, parseTranscriptJsonl } from '__REPO_DIR__/shared/lib/native-agent/transcript.ts';

const root = process.argv[2];
const outside = process.argv[3];
const transcriptPath = process.argv[4];
const sentinel = process.argv[5];

if (!root || !outside || !transcriptPath || !sentinel) {
  throw new Error('usage: harness <root> <outside> <transcriptPath> <sentinel>');
}

const TEST_SECRET_KEY = 'WAVEMILL_TEST_SECRET';
const writer = new TranscriptWriter({
  sessionId: 'native-command-sandbox',
  model: 'hokusai-mini',
  api: 'hokusai-mock',
  provider: 'hokusai',
  path: transcriptPath,
});

function rejectedSpawnSpy() {
  let calls = 0;
  return {
    fn() {
      calls += 1;
      throw new Error('spawn should not be called');
    },
    getCalls() {
      return calls;
    },
  };
}

async function main() {
  process.env[TEST_SECRET_KEY] = 'supersecret';
  const linkPath = path.join(root, 'escape-link');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, linkPath);

  const safe = await runCommand({
    command: ['node', '-e', 'process.stdout.write("ok")'],
    cwd: root,
    allowedRoots: [root],
  });
  emit({
    scenario: 'safe_command',
    approval: safe.approval,
    commandClass: safe.commandClass,
    exitCode: safe.exitCode,
    stdout: safe.stdout,
  });

  const dangerousSpy = rejectedSpawnSpy();
  const dangerous = await runCommand({
    command: 'rm -rf /tmp/x',
    cwd: root,
    allowedRoots: [root],
    spawnFn: dangerousSpy.fn as never,
  });
  emit({
    scenario: 'dangerous_pattern_blocked',
    approval: dangerous.approval,
    rejectionReason: dangerous.rejectionReason,
    spawnCalls: dangerousSpy.getCalls(),
    sentinelExists: existsSync(sentinel),
  });

  const outsideSpy = rejectedSpawnSpy();
  const outsideResult = await runCommand({
    command: ['ls'],
    cwd: outside,
    allowedRoots: [root],
    spawnFn: outsideSpy.fn as never,
  });
  emit({
    scenario: 'cwd_outside_blocked',
    approval: outsideResult.approval,
    rejectionReason: outsideResult.rejectionReason,
    spawnCalls: outsideSpy.getCalls(),
  });

  const symlinkSpy = rejectedSpawnSpy();
  const symlinkResult = await runCommand({
    command: ['pwd'],
    cwd: linkPath,
    allowedRoots: [root],
    spawnFn: symlinkSpy.fn as never,
  });
  emit({
    scenario: 'symlink_escape_blocked',
    approval: symlinkResult.approval,
    rejectionReason: symlinkResult.rejectionReason,
    spawnCalls: symlinkSpy.getCalls(),
  });

  const envBlocked = await runCommand({
    command: ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'],
    cwd: root,
    allowedRoots: [root],
  });
  const envAllowed = await runCommand({
    command: ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'],
    cwd: root,
    allowedRoots: [root],
    allowedEnvKeys: [TEST_SECRET_KEY],
  });
  emit({
    scenario: 'env_allowlist_enforced',
    blockedHasSecret: Object.hasOwn(JSON.parse(envBlocked.stdout) as Record<string, unknown>, TEST_SECRET_KEY),
    allowedSecret: (JSON.parse(envAllowed.stdout) as Record<string, string | undefined>)[TEST_SECRET_KEY] ?? null,
  });

  const outputCap = await runCommand({
    command: ['node', '-e', 'process.stdout.write("A".repeat(1500))'],
    cwd: root,
    allowedRoots: [root],
    maxOutputBytes: 1000,
  });
  emit({
    scenario: 'output_cap_applied',
    truncated: outputCap.truncated,
    stdoutEndsWithMarker: outputCap.stdout.endsWith('[output truncated]'),
    stdoutBytes: Buffer.byteLength(outputCap.stdout, 'utf8'),
  });

  await runCommand({
    command: ['node', '-e', `process.stdout.write(process.env.${TEST_SECRET_KEY} ?? "")`],
    cwd: root,
    allowedRoots: [root],
    allowedEnvKeys: [TEST_SECRET_KEY],
    redactValues: ['supersecret'],
    transcriptWriter: writer,
    toolName: 'run_tests',
  });
  const transcriptText = readFileSync(transcriptPath, 'utf8');
  const transcript = parseTranscriptJsonl(transcriptText);
  const commandEvent = transcript.find((event) => event.type === 'command_result');
  emit({
    scenario: 'transcript_redaction',
    rawContainsSecret: transcriptText.includes('supersecret'),
    rawContainsMarker: transcriptText.includes('«redacted»'),
    approval: commandEvent?.type === 'command_result' ? commandEvent.approval : null,
  });
}

function emit(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
EOF

python3 - <<'PY' "$HARNESS" "$REPO_DIR"
from pathlib import Path
import sys
path = Path(sys.argv[1])
repo_dir = sys.argv[2]
path.write_text(path.read_text().replace('__REPO_DIR__', repo_dir))
PY

RESULTS="$TMP_ROOT/results.jsonl"
node "$HARNESS" "$ROOT" "$OUTSIDE" "$TRANSCRIPT_PATH" "$SENTINEL" > "$RESULTS"

assert_scenario() {
  local label="$1"
  local expr="$2"
  if jq -e "select(.scenario == \"$label\") | $expr" "$RESULTS" >/dev/null; then
    pass "$label"
  else
    fail "$label" "$(jq -c "select(.scenario == \"$label\")" "$RESULTS")"
  fi
}

assert_scenario "safe_command" '.approval == "approved" and .commandClass == "safe" and .exitCode == 0 and .stdout == "ok"'
assert_scenario "dangerous_pattern_blocked" '.approval == "rejected" and .rejectionReason == "dangerous-command-pattern" and .spawnCalls == 0 and .sentinelExists == true'
assert_scenario "cwd_outside_blocked" '.approval == "rejected" and .rejectionReason == "cwd-outside-allowed-roots" and .spawnCalls == 0'
assert_scenario "symlink_escape_blocked" '.approval == "rejected" and .rejectionReason == "cwd-outside-allowed-roots" and .spawnCalls == 0'
assert_scenario "env_allowlist_enforced" '.blockedHasSecret == false and .allowedSecret == "supersecret"'
assert_scenario "output_cap_applied" '.truncated == true and .stdoutEndsWithMarker == true and .stdoutBytes >= 1000'
assert_scenario "transcript_redaction" '.rawContainsSecret == false and .rawContainsMarker == true and .approval == "approved"'

if [[ -f "$SENTINEL" ]]; then
  pass "sentinel preserved"
else
  fail "sentinel preserved" "sentinel file missing after dangerous command rejection"
fi

echo "--- Results: $PASS passed, $FAIL failed ---"
if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
