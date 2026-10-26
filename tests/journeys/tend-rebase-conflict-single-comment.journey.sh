#!/usr/bin/env bash
# Golden journey: two PRs touch the same generated file. GitHub's 3-way merge
# of the second is clean, but tend's per-commit rebase conflicts. The mill
# blocks it once, remediates, and merges it with no operator touch (HOK-3316).
#
# Protects against: the PR #1697 loop. Tend wrote wm:blocked and a "Rebase
# failed" comment after every failed rebase; the merge-label reconciler, which
# only saw GitHub MERGEABLE, relabelled wm:ready; tend retried the same rebase
# against the same base ~every 90s (158 comments). Now the failure is one
# condition-keyed fact deriveMergeLabel reads, posted as one standing comment,
# and Ready's conflict resolver is launched once for it.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP tend-rebase-conflict-single-comment journey: $reason"
  exit 0
fi

ISSUE="JRN-4"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/hok-3316/fake-agent" && pwd)"
journey_init tend-rebase-conflict-single-comment
fakes_linear_add_issue "$ISSUE" "Change that also regenerates a generated file" Todo
# The generated file both PRs touch, present on the base before the task starts.
fakes_repo_commit "$JOURNEY_INTEGRATION_BRANCH" "generated.txt" "generated: v0" "seed generated.txt"

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
fact_file() { printf '%s/.tend-attempt-result.json\n' "$(journey_feature_dir "$ISSUE")"; }
tend_blocked_on_rebase() { [[ "$(jq -r '.detail.phase // empty' "$(fact_file)" 2>/dev/null)" == "rebase" ]]; }
resolver_launches() { grep -c "phase=coding issue=$ISSUE role=conflict-resolver" "$FAKE_AGENT_LOG" 2>/dev/null || true; }
resolver_launched() { (( $(resolver_launches) >= 1 )); }
tend_rebase_failures() { grep -c "tend: PR #1 rebase failed" "$JOURNEY_TMP/logs/tend.log" 2>/dev/null || true; }
comment_count() { jq -r '.prs["1"].comments // [] | length' "$FAKE_GH_STATE"; }
blocked_label_writes() {
  jq -r '.prs["1"].history // [] | map(select(.event == "labeled" and .label == "wm:blocked")) | length' "$FAKE_GH_STATE"
}
pr_has_label() { jq -e --arg l "$1" '.prs["1"].labels // [] | index($l)' "$FAKE_GH_STATE" >/dev/null 2>&1; }

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"                 phase_is planning
journey_wait_until "$ISSUE" 25 "tend's per-commit rebase failed and recorded" tend_blocked_on_rebase

# More tend polls against the same (head, base): the PR #1697 loop retried the
# rebase and commented on every one of these.
for _ in 1 2 3; do journey_tend_tick; done
blocked_after_polls="$(pr_has_label wm:blocked && echo yes || echo no)"
comments_after_polls="$(comment_count)"
rebase_failures_after_polls="$(tend_rebase_failures)"

journey_wait_until "$ISSUE" 15 "Ready launched the conflict resolver for tend's fact" resolver_launched
journey_wait_until "$ISSUE" 30 "PR merged by tend after the remediation"     journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"                     journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "the reconciler held wm:blocked across repeated tend polls" test "$blocked_after_polls" = "yes"
journey_assert "tend attempted the conflicting rebase once per (head, base)" test "$rebase_failures_after_polls" = "1"
journey_assert "one PR comment across those polls" test "$comments_after_polls" = "1"
journey_assert "wm:blocked was written once (no reconciler/tend oscillation)" test "$(blocked_label_writes)" = "1"
journey_assert "exactly one conflict resolver launched" test "$(resolver_launches)" = "1"
journey_assert "still one standing merge-status comment at merge time" test "$(comment_count)" = "1"
journey_assert "the standing comment carries the merge-status marker" \
  journey_jq_true '.prs["1"].comments[0].body | startswith("<!-- wavemill-merge-status -->")' "$FAKE_GH_STATE"
journey_assert "the other PR's regenerated file survived the merge" \
  bash -c 'git --git-dir "$1" show "refs/heads/$2:generated.txt" | grep -q "from the other PR"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH"
journey_assert_landed "$ISSUE"

journey_finish
