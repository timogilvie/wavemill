#!/usr/bin/env bash
# Golden journey: an external publication succeeds, then its controller dies
# before recording the local acknowledgement.
#
# Protects against: repeating an uncertain external effect after restart. The
# replacement controller must read the authoritative remote ref, record the
# acknowledgement, and never issue another push.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP intent-apply-ack-fault journey: $reason"
  exit 0
fi

journey_init intent-apply-ack-fault
journey_set_tick_budget 1

WORKTREE="$FAKE_REPO_DIR"
BRANCH="task/intent-apply-ack"
STATE_DIR="$JOURNEY_TMP/state"
mkdir -p "$STATE_DIR"

git -C "$WORKTREE" switch -q -c "$BRANCH"
printf 'external effect\n' > "$WORKTREE/effect.txt"
git -C "$WORKTREE" add effect.txt
git -C "$WORKTREE" commit -q -m 'intent apply ack fixture'
HEAD_SHA="$(git -C "$WORKTREE" rev-parse HEAD)"

# Intent is durable before apply. The child dies immediately after the real
# push, deliberately leaving no local head-move acknowledgement behind.
printf '{"effect":"publish-branch","branch":"%s","head":"%s"}\n' "$BRANCH" "$HEAD_SHA" > "$STATE_DIR/intent.json"
set +e
fakes_spawn bash -c 'git -C "$1" push -q origin "$2"; kill -KILL $$' _ "$WORKTREE" "$BRANCH"
APPLIER_PID="$FAKES_LAST_SPAWN_PID"
wait "$APPLIER_PID"
APPLIER_RC=$?
set -e

REMOTE_SHA="$(git -C "$WORKTREE" ls-remote origin "refs/heads/$BRANCH" | awk '{print $1}')"
journey_assert "the controller crashed after the external push" test "$APPLIER_RC" = "137"
journey_assert "the external effect succeeded before acknowledgement" test "$REMOTE_SHA" = "$HEAD_SHA"
journey_assert "the crashed controller left no local acknowledgement" test ! -e "$STATE_DIR/.head-moves.jsonl"

# A second push is now forbidden. A restart may read the remote, but succeeds
# only if the live publication seam observes the matching effect and reuses it.
REJECT_MARKER="$JOURNEY_TMP/rejected-second-push"
printf '#!/usr/bin/env bash\nprintf rejected > %q\nexit 1\n' "$REJECT_MARKER" > "$FAKE_GH_ORIGIN/hooks/pre-receive"
chmod +x "$FAKE_GH_ORIGIN/hooks/pre-receive"

RESTART_RESULT="$JOURNEY_TMP/restart-result.json"
(cd "$JOURNEY_INSTALL_DIR" && npx tsx tools/publish-stage-head.ts \
  --worktree "$WORKTREE" --branch "$BRANCH" --state-dir "$STATE_DIR" \
  --issue JRN-ACK --stage coding --kind coding --expected-sha "$HEAD_SHA") > "$RESTART_RESULT"

journey_assert "restart reused the observed external effect" \
  jq -e --arg head "$HEAD_SHA" '.ok == true and .outcome == "reused" and .remoteSha == $head' "$RESTART_RESULT"
journey_assert "restart acknowledged the applied effect locally" \
  jq -e --arg head "$HEAD_SHA" 'select(.to == $head and .issue == "JRN-ACK")' "$STATE_DIR/.head-moves.jsonl"
journey_assert "restart never repeated the completed external effect" test ! -e "$REJECT_MARKER"

journey_finish
