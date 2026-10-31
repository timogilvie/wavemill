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

TMP_ROOT="$(mktemp -d)"
HARNESS="$REPO_DIR/.tmp-native-agent-shell-operators-harness-$$.ts"
TEST_REPO="$TMP_ROOT/repo"
trap 'rm -rf "$TMP_ROOT"; rm -f "$HARNESS"' EXIT

mkdir -p "$TEST_REPO"
git -C "$TEST_REPO" init >/dev/null 2>&1
git -C "$TEST_REPO" config user.name "Wavemill Test"
git -C "$TEST_REPO" config user.email "wavemill@example.com"
printf "fixture\n" > "$TEST_REPO/package.json"
git -C "$TEST_REPO" add package.json
git -C "$TEST_REPO" commit -m "fixture" >/dev/null 2>&1

cat > "$HARNESS" <<EOF
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { createRunTestsTool } from '$REPO_DIR/shared/lib/native-agent/tools/command-tools.ts';

const repo = process.argv[2];
const cases = [
  { name: 'and', command: 'touch rejected.txt && echo created' },
  { name: 'pipe', command: 'ls -l | grep package.json' },
  { name: 'redirect', command: 'echo "hello" > output.txt' },
  { name: 'semicolon', command: 'sleep 1; echo "done"' },
  { name: 'touch', command: 'touch valid-file.txt' },
  { name: 'ls', command: 'ls -l' },
  { name: 'cat-missing', command: 'cat non-existent-file.txt' },
];

const tool = createRunTestsTool(repo);

for (const testCase of cases) {
  const startedAt = Date.now();
  const result = await tool.execute(\`call-\${testCase.name}\`, { command: testCase.command, timeoutMs: 5000 });
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  const details = result.details;
  process.stdout.write(\`\${JSON.stringify({
    name: testCase.name,
    durationMs: Date.now() - startedAt,
    details,
    status,
    files: {
      rejected: existsSync(path.join(repo, 'rejected.txt')),
      ampamp: existsSync(path.join(repo, '&&')),
      echo: existsSync(path.join(repo, 'echo')),
      created: existsSync(path.join(repo, 'created')),
      output: existsSync(path.join(repo, 'output.txt')),
      valid: existsSync(path.join(repo, 'valid-file.txt')),
    },
  })}\n\`);
}
EOF

OUT="$TMP_ROOT/results.jsonl"
node "$HARNESS" "$TEST_REPO" > "$OUT"

case_json() {
  local name="$1"
  jq -c --arg name "$name" 'select(.name == $name)' "$OUT"
}

assert_rejected() {
  local name="$1"
  local row
  row="$(case_json "$name")"
  if [[ -z "$row" ]]; then
    fail "$name rejected" "missing result"
    return
  fi
  if jq -e '.details.ok == false and .details.error == "unsupported_shell_syntax" and (.details.message | contains("Command rejected: shell operators"))' >/dev/null <<<"$row"; then
    pass "$name rejected"
  else
    fail "$name rejected" "$row"
  fi
}

assert_rejected and
row="$(case_json and)"
if jq -e '.status == "" and (.files.rejected | not) and (.files.ampamp | not) and (.files.echo | not) and (.files.created | not)' >/dev/null <<<"$row"; then
  pass "and leaves no junk"
else
  fail "and leaves no junk" "$row"
fi

assert_rejected pipe
assert_rejected redirect
row="$(case_json redirect)"
if jq -e '(.files.output | not)' >/dev/null <<<"$row"; then
  pass "redirect writes no output file"
else
  fail "redirect writes no output file" "$row"
fi

assert_rejected semicolon
row="$(case_json semicolon)"
if jq -e '.durationMs < 500' >/dev/null <<<"$row"; then
  pass "semicolon rejects quickly"
else
  fail "semicolon rejects quickly" "$row"
fi

row="$(case_json touch)"
if jq -e '.details.ok == true and .details.exitCode == 0 and .status == "?? valid-file.txt\n"' >/dev/null <<<"$row"; then
  pass "valid touch command"
else
  fail "valid touch command" "$row"
fi

row="$(case_json ls)"
if jq -e '.details.ok == true and .details.exitCode == 0 and (.details.stdout | length > 0)' >/dev/null <<<"$row"; then
  pass "valid ls command"
else
  fail "valid ls command" "$row"
fi

row="$(case_json cat-missing)"
if jq -e '.details.ok == true and .details.exitCode != 0 and (.details.stderr | contains("No such file"))' >/dev/null <<<"$row"; then
  pass "failing command preserves stderr"
else
  fail "failing command preserves stderr" "$row"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "native-agent-shell-operators.test.sh: $PASS passed, $FAIL failed" >&2
  exit 1
fi

echo "native-agent-shell-operators.test.sh: $PASS passed"
