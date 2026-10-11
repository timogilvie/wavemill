#!/usr/bin/env bash
# HOK-3182: `wavemill report reliability` end to end on a temp repo (no
# network): per-class touch counts, archive fallback, time-stuck coverage,
# absolute --since, and the human summary lines.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$(cd "$SCRIPT_DIR/.." && pwd)/tools/report-reliability.ts"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

repo="$tmp/repo"
mkdir -p "$repo"
git -C "$repo" init -q -b main
git -C "$repo" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m "base"
GIT_COMMITTER_DATE="2026-10-08T12:00:00Z" git -C "$repo" -c user.name=t -c user.email=t@example.com \
  commit -q --allow-empty -m "HOK-1: reaped task (#5)"
GIT_COMMITTER_DATE="2026-10-08T13:00:00Z" git -C "$repo" -c user.name=t -c user.email=t@example.com \
  commit -q --allow-empty -m "HOK-2: untouched task (#6)"

# HOK-1 was reaped: only its archive remains.
archive="$repo/.wavemill/evals/artifacts/HOK-1"
mkdir -p "$archive"
printf '%s\n' '{"seq":1,"command":"advance","at":"2026-10-08T10:30:00Z"}' \
  '{"seq":2,"command":"challenge-void","at":"2026-10-08T11:30:00Z"}' > "$archive/operator-events.jsonl"
printf '%s\n' '{"stage":"coding","status":"completed","startedAt":"2026-10-08T09:00:00Z","finishedAt":"2026-10-08T09:20:00Z"}' > "$archive/coding-result.json"
# HOK-1 also has an interactive state edit in the repo touch log.
printf '%s\n' '{"at":"2026-10-08T11:00:00Z","kind":"state-edit","issue":"HOK-1"}' > "$repo/.wavemill/operator-touches.jsonl"

out="$(cd "$repo" && npx tsx "$TOOL" --since 2026-10-01 --branches main --no-github --json --repo-dir "$repo" 2>/dev/null)"

[[ "$(jq -r '.overall.merged' <<<"$out")" == "2" ]] || fail "merged count: $(jq -c '.overall' <<<"$out")"
[[ "$(jq -r '.overall.unattended' <<<"$out")" == "1" ]] || fail "unattended count"
[[ "$(jq -c '.overall.touchClasses' <<<"$out")" == '{"O":1,"L":0,"S":0,"R":2}' ]] || fail "touch classes: $(jq -c '.overall.touchClasses' <<<"$out")"
[[ "$(jq -r '.tasks[] | select(.task.issue=="HOK-1") | .stuckCoverage' <<<"$out")" == "partial" ]] || fail "HOK-1 coverage"
[[ "$(jq -r '[.tasks[] | select(.task.issue=="HOK-1") | .touches[].class] | all(. != null)' <<<"$out")" == "true" ]] || fail "touch rows carry a class"
[[ "$(jq -r '.sources.githubEnabled' <<<"$out")" == "false" ]] || fail "github should be off"

text="$(cd "$repo" && npx tsx "$TOOL" --since 2026-10-01 --branches main --no-github --repo-dir "$repo" 2>/dev/null)"
grep -q "Unattended rate: *50.0% (1/2)" <<<"$text" || fail "missing unattended line: $text"
grep -q "Touches by class: *O=1  L=0  S=0  R=2" <<<"$text" || fail "missing per-class line: $text"
grep -q "P90 time stuck:" <<<"$text" || fail "missing p90 line"

echo "report-reliability-cli test passed"
