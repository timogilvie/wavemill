#!/usr/bin/env bash
# HOK-3322 — bash parity test for shared/lib/ready-remediation-disposition.sh.
#
# Evaluates every row of tests/fixtures/ready-remediation-disposition-cases.json
# (the same rows shared/lib/ready-remediation-disposition.test.ts asserts
# against the TS module) through the shell twin the monitor calls, with the
# real TS CLI deciding the owner from a real hook file and ownership row. Also
# pins the twin's fail-safe: an unavailable CLI holds (in-flight) instead of
# settling.
#
# protects: the monitor's Ready disposition drifting from the watchdog's on
# identical inputs (the HOK-3316 same-head strand).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$REPO_DIR/tests/fixtures/ready-remediation-disposition-cases.json"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"
export TOOLS_DIR="$REPO_DIR/tools"

pass=0
fail=0
tmpdir="$(mktemp -d)"
SESSION="ready-disposition-parity-$$"
export WAVEMILL_SESSION="$SESSION"
ISSUE="HOK-0000"
HOOK_FILE="/tmp/wavemill-${SESSION}-${ISSUE}.hook"
trap 'rm -rf "$tmpdir"; rm -f "$HOOK_FILE" "/tmp/wavemill-${SESSION}-${ISSUE}.progress.json"' EXIT

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL  $label: expected '$expected', got '$actual'"
    fail=$((fail + 1))
  fi
}

iso_seconds_ago() {
  node -e 'process.stdout.write(new Date(Date.now() - Number(process.argv[1]) * 1000).toISOString())' "$1"
}

count="$(jq '.cases | length' "$FIXTURE")"
for ((i = 0; i < count; i++)); do
  row="$(jq -c ".cases[$i]" "$FIXTURE")"
  name="$(jq -r '.name' <<< "$row")"
  state_dir="$tmpdir/case-$i"
  mkdir -p "$state_dir"
  rm -f "$HOOK_FILE"

  ready_status="$(jq -r '.readyStatus // empty' <<< "$row")"
  if [[ -n "$ready_status" ]]; then
    jq -cn --arg status "$ready_status" \
      '{stage:"ready", status:$status, startedAt:"2026-10-26T19:00:00Z", agent:"claude", artifacts:{type:"ready"}}' \
      > "$state_dir/.ready-result.json"
  fi
  if jq -e '.hook != null' <<< "$row" >/dev/null; then
    now="$(date +%s)"
    jq -c --argjson now "$now" \
      '.hook | {state, event, agent:"claude", timestamp:($now - .ageSeconds)} | . + {writer:"agent", agentRecord:.}' \
      <<< "$row" > "$HOOK_FILE"
  fi
  if jq -e '.launchedAgeSeconds != null' <<< "$row" >/dev/null; then
    launched_at="$(iso_seconds_ago "$(jq -r '.launchedAgeSeconds' <<< "$row")")"
    jq -cn --arg at "$launched_at" \
      '{schemaVersion:1, type:"launch", sessionRef:"remediation-session", harness:"claude-code", kind:"ready-remediation", model:"claude-opus-4-7", launchedAt:$at, attemptId:"ready-remediation@fixture"}' \
      > "$state_dir/.session-ownership.jsonl"
  fi

  expected="$(jq -r '.expected' <<< "$row")"
  actual="$(ready_remediation_disposition "$ISSUE" "$state_dir" \
    "$(jq -r '.launchHead' <<< "$row")" "$(jq -r '.currentHead' <<< "$row")")"
  check "$name" "$expected" "$actual"
done

# Fail-safe: when the CLI cannot run, a same-head running remediation holds.
state_dir="$tmpdir/fail-safe"
mkdir -p "$state_dir"
printf '{"stage":"ready","status":"running","artifacts":{"type":"ready"}}\n' > "$state_dir/.ready-result.json"
now="$(date +%s)"
jq -cn --argjson ts "$now" '{state:"idle", event:"Stop", agent:"claude", timestamp:$ts} | . + {writer:"agent", agentRecord:.}' > "$HOOK_FILE"
actual="$(TOOLS_DIR="$tmpdir/no-tools" ready_remediation_disposition "$ISSUE" "$state_dir" "aaaa111" "aaaa111")"
check "unavailable CLI fails safe to in-flight" "in-flight" "$actual"

echo "ready-remediation-disposition parity: $pass passed, $fail failed"
(( fail == 0 ))
