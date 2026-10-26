#!/usr/bin/env bash
# Contract tests for the shared external-edge fakes (HOK-3226).
#
# Protects against: the fakes drifting from the real services they stand in
# for — a fake that answers a shape GitHub/Linear never would makes every test
# built on it pass against a fiction (the HOK-3212 failure mode, one level
# down). Shapes are pinned to recordings of the real gh CLI
# (tests/fakes/recordings/); behaviour is pinned to what production relies on.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }
check() {
  local description="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi
}

if ! git merge-tree --write-tree HEAD HEAD >/dev/null 2>&1 && ! git -C "$SCRIPT_DIR" merge-tree --write-tree HEAD HEAD >/dev/null 2>&1; then
  echo "SKIP fakes contract: git >= 2.38 required"
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fakes-contract.XXXXXX")"
trap 'fakes_teardown; rm -rf "$TMP"' EXIT
fakes_setup "$TMP/world" "acme/contract" main
cd "$FAKE_REPO_DIR"

shape='def shape: if type=="object" then with_entries(.value|=shape) elif type=="array" then (if length>0 then [.[0]|shape] else [] end) else type end; shape'

echo "gh: PR lifecycle"
git checkout -q -b task/one
printf 'one\n' > one.txt && git add one.txt && git commit -q -m one && git push -q -u origin task/one
check "pr create refuses an unpushed head" bash -c '! gh pr create --head task/nope --base main --title x --body y'
url="$(gh pr create --head task/one --base main --title "T1" --body "b" --label wavemill)"
check "pr create prints the PR url" test "$url" = "https://github.com/acme/contract/pull/1"
check "pr create refuses a second open PR for the same head" bash -c '! gh pr create --head task/one --base main --title x --body y'
check "pr view headRefOid tracks the pushed branch" \
  test "$(gh pr view 1 --json headRefOid --jq .headRefOid)" = "$(git rev-parse HEAD)"
printf 'more\n' >> one.txt && git commit -qam more && git push -q
check "a later push is visible to the next pr view" \
  test "$(gh pr view 1 --json headRefOid --jq .headRefOid)" = "$(git rev-parse HEAD)"
check "pr view with no selector resolves the current branch" test "$(gh pr view --json number --jq .number)" = 1
check "pr list --search head: finds the PR (batched PR cache shape)" \
  test "$(gh pr list --state all --search 'head:task/one head:task/other' --json number --jq 'length')" = 1
check "pr list --label filters" test "$(gh pr list --label wm:ready --json number --jq 'length')" = 0

echo "gh: shapes match recorded real responses"
fields="$(jq -r 'keys | join(",")' "$SCRIPT_DIR/recordings/pr-view.shape.json")"
gh pr edit 1 --add-label wm:ready >/dev/null
fake_shape="$(gh pr view 1 --json "$fields" | jq -S "$shape | del(.mergeCommit, .mergedAt, .closedAt)")"
real_shape="$(jq -S 'del(.mergeCommit, .mergedAt, .closedAt)' "$SCRIPT_DIR/recordings/pr-view.shape.json")"
if [[ "$fake_shape" == "$real_shape" ]]; then pass "pr view shape (open PR) matches recording"; else
  fail "pr view shape (open PR) matches recording"; diff <(echo "$real_shape") <(echo "$fake_shape") | sed 's/^/        /' | head -20; fi
fake_checks="$(gh pr checks 1 --json name,state,bucket,startedAt,completedAt,link,workflow | jq -S "$shape")"
if [[ "$fake_checks" == "$(jq -S . "$SCRIPT_DIR/recordings/pr-checks.shape.json")" ]]; then pass "pr checks shape matches recording"; else
  fail "pr checks shape matches recording"; fi

echo "gh: labels via the REST endpoints production uses"
echo '["wm:merging"]' | gh api --method POST repos/acme/contract/issues/1/labels --input - >/dev/null
gh api --method DELETE "repos/acme/contract/issues/1/labels/wm%3Aready" >/dev/null
check "POST adds and DELETE (url-encoded) removes labels" \
  test "$(gh pr view 1 --json labels --jq '[.labels[].name] | join(",")')" = "wavemill,wm:merging"
check "DELETE of an absent label fails like GitHub (404)" \
  bash -c '! gh api --method DELETE repos/acme/contract/issues/1/labels/nope'

echo "gh: checks, required checks and merge"
fakes_gh_state '.checks.byPr["1"] = [{name:"ci",conclusion:"PENDING"}]'
set +e; gh pr checks 1 --json name >/dev/null; rc=$?; set -e
check "pr checks exits 8 while pending (as real gh does)" test "$rc" = 8
check "pending checks report mergeStateStatus BLOCKED" test "$(gh pr view 1 --json mergeStateStatus --jq .mergeStateStatus)" = BLOCKED
fakes_gh_state '.requiredChecks = ["ci"]'
check "pr merge refuses while a required check is not green" bash -c '! gh pr merge 1 --squash'
fakes_gh_state '.checks.byPr["1"] = [{name:"ci",conclusion:"SUCCESS"}]'
base_before="$(git --git-dir "$FAKE_GH_ORIGIN" rev-parse refs/heads/main)"
check "pr merge --squash succeeds once green" gh pr merge 1 --squash
check "squash merge is one commit on top of the old base" \
  test "$(git --git-dir "$FAKE_GH_ORIGIN" rev-parse refs/heads/main^)" = "$base_before"
check "merged base contains the PR's change" git --git-dir "$FAKE_GH_ORIGIN" cat-file -e refs/heads/main:one.txt
check "merged PR reports MERGED with a merge commit" \
  test "$(gh pr view 1 --json state,mergeCommit --jq '.state + (.mergeCommit.oid | length | tostring)')" = MERGED40

echo "gh: conflicts, lag, faults, unhandled"
git checkout -q main && git pull -q
git checkout -q -b task/a && printf 'a\n' > clash.txt && git add clash.txt && git commit -qm a && git push -q -u origin task/a
git checkout -q main && git checkout -q -b task/b && printf 'b\n' > clash.txt && git add clash.txt && git commit -qm b && git push -q -u origin task/b
gh pr create --head task/a --base main --title A --body a >/dev/null
gh pr create --head task/b --base main --title B --body b >/dev/null
gh pr merge 2 --squash
check "a conflicting PR cannot be merged" bash -c '! gh pr merge 3 --squash'
check "a conflicting PR reads CONFLICTING/DIRTY (real merge, as on GitHub)" \
  test "$(gh pr view 3 --json mergeable,mergeStateStatus --jq '.mergeable + "/" + .mergeStateStatus')" = CONFLICTING/DIRTY
old_head="$(gh pr view 3 --json headRefOid --jq .headRefOid)"
fakes_gh_state '.headLag["3"] = 2'
git checkout -q task/b && printf 'b2\n' >> clash.txt && git commit -qam b2 && git push -q
check "lagged read 1 still reports the old head" test "$(gh pr view 3 --json headRefOid --jq .headRefOid)" = "$old_head"
check "lagged read 2 still reports the old head" test "$(gh pr view 3 --json headRefOid --jq .headRefOid)" = "$old_head"
check "read 3 reports the pushed head" test "$(gh pr view 3 --json headRefOid --jq .headRefOid)" = "$(git rev-parse HEAD)"
fakes_gh_state '.faults = [{cmd:"pr view", remaining:1, exit:1, stderr:"HTTP 502: Bad Gateway"}]'
check "an injected fault fails exactly once" bash -c '! gh pr view 3 --json number'
check "and the next call succeeds" gh pr view 3 --json number
: > "$FAKE_GH_UNHANDLED"
check "an unmodelled command fails" bash -c '! gh release list'
check "and is recorded as unhandled" test -s "$FAKE_GH_UNHANDLED"

echo "Linear: the real tools against the fake"
fakes_linear_add_issue CON-7 "Contract issue" Todo
run_tool() { (cd "$FAKES_INSTALL_DIR" && node --experimental-strip-types --no-warnings "tools/$1" "${@:2}"); }
check "get-issue.ts --json returns the issue" \
  bash -c 'cd "$1" && node --experimental-strip-types --no-warnings tools/get-issue.ts CON-7 --json | jq -e ".identifier == \"CON-7\""' _ "$FAKES_INSTALL_DIR"
check "list-backlog-json.ts includes a Todo issue" \
  bash -c 'cd "$1" && node --experimental-strip-types --no-warnings tools/list-backlog-json.ts | jq -e "map(.identifier) | index(\"CON-7\") != null"' _ "$FAKES_INSTALL_DIR"
run_tool set-issue-state.ts CON-7 "In Progress" >/dev/null
check "set-issue-state.ts transitions the issue" test "$(fakes_linear_state_of CON-7)" = "In Progress"
check "the transition is recorded" \
  bash -c 'jq -e ".transitions[-1] == {identifier:\"CON-7\", from:\"Todo\", to:\"In Progress\"} + {at: .transitions[-1].at}" "$1"' _ "$FAKE_LINEAR_STATE"
run_tool set-issue-state.ts CON-7 Done >/dev/null
check "get-issue-state.ts reports completed after Done" \
  bash -c 'cd "$1" && node --experimental-strip-types --no-warnings tools/get-issue-state.ts CON-7 | grep -q completed' _ "$FAKES_INSTALL_DIR"
check "no unmodelled Linear queries" test ! -s "$FAKE_LINEAR_UNHANDLED"
check "non-Linear network access is refused" \
  bash -c 'node -e "fetch(\"https://example.com\").then(()=>process.exit(0),()=>process.exit(1))" && exit 1 || exit 0'

echo ""
echo "--- fakes-contract: $PASS passed, $FAIL failed ---"
(( FAIL == 0 ))
