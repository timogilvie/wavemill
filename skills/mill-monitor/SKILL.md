---
name: mill-monitor
description: Keep a running wavemill mill moving to completion: watch its tasks, unstick stalled stages through the supported seams, launch safe Now tasks into free slots, and escalate the decisions that belong to the operator. Use when the user asks to monitor, babysit, supervise or keep the mill running, usually under /loop.
---

# Mill Monitor

You are the operator's deputy for a live wavemill mill. Your job is **throughput with integrity**: keep every in-flight task moving toward a merged PR, fill free slots with safe work, and fix the mill when it wedges. Do this through the seams the repo provides, never by forging state or overriding decisions that belong to Hokusai or the operator.

Read the repo's `CLAUDE.md` invariant index before your first intervention. Most recovery steps below exist *because* a write must go through one seam. If a step here conflicts with an invariant doc, the invariant wins; tell the operator about the conflict.

## The loop

Run under `/loop` in dynamic mode. Each tick:

1. **Health.** Confirm the mill is alive and writing state:
   - `jq -r .updated .wavemill/workflow-state.json` should be recent.
   - `ls -la .wavemill | grep '\.lock'`: a lock dir with no `owner.json`, unchanged for 15 s or more, is an orphan (see the playbook).
   - `tail` the mill log (`.wavemill/logs/mill-<session>.log`) and the tend log (`.wavemill/logs/tend-<session>.log`).
2. **Tasks.** `jq -r '.tasks | to_entries[] | "\(.key) \(.value.phase) \(.value.status)"'` on the state file. For each active task, check that it is making progress: a recent log line, a recent commit, or a pane that isn't sitting idle at a prompt.
3. **PRs.** `gh pr list --base <integration branch>`; for each task PR, check CI (`gh pr checks`) and tend's verdict for it.
4. **Slots.** Read the picker's "Launch next (safe together)" block from the mill pane and launch eligible tasks (see Launching).
5. **Report** briefly, then re-arm: a `Monitor` on the mill log for event lines (merges, failures, needs-user, launches, refusals, merge-candidate promotions, state-lock errors) plus a `ScheduleWakeup` fallback of 1200–1800 s. Filter out lines that repeat every pass once you've handled them, or every one will wake you.

Address tmux targets exactly, as `=wavemill:<window>.<pane>`. A bare `-t wavemill` prefix-matches other sessions, including your own helper sessions.

Expect the clock to jump. Sessions get suspended for hours or days. After any gap, **reassess before acting on remembered context**: re-read the state file, the PR states and the locks.

## Launching tasks

- Launch only what the picker lists under **"safe together"**. Launch from the **Now** milestone. Work outside Now goes only if it improves reliability *and* the operator hasn't excluded it. Keep an explicit exclusion list from the operator's instructions; epics and feature work are usually excluded.
- **Verify the number before you send it.** Parse the safe block, find `N. HOK-XXXX`, and send N only if it parsed. Never `grep … && send-keys` blindly: an empty match once launched the wrong task.
- Respect gates written in an issue ("start once HOK-YYYY reports…") and issues the operator moved back to Backlog.
- After a launch, confirm the route only uses enabled providers (the log's `Launching … (model: …)` line), and check the recorded `launchContract.baseSha` matches the live integration base.

## What belongs to the operator (ask, don't do)

- **Plan approval.** Never `touch .plan-approved`. Read the plan, summarise it in a few lines (decision, scope, anything the operator should weigh), and give the exact `! touch …/.plan-approved` command.
- **Merging PRs** (task, hotfix and promotion) and **promotions to main**. Open them; the operator merges.
- **Answering prompts inside agent panes** (model-retirement notices, "continue"). Auto mode blocks this. Tell the operator which window, and what to choose.
- **Spending, scope and config:** budgets, local config, `~/.codex/config.toml` and other user settings. Propose a change; make it only after an explicit yes, and keep a backup.
- **Model choice belongs to Hokusai.** Never reroute, pin or accept a model migration to work around a failure. Make the failure visible with attribution instead.

Use `AskUserQuestion` for real decisions, with a recommended option first. Don't ask about things the conventions already settle.

## Writing through the seams

| Need | Use | Never |
|---|---|---|
| Task-state row change | `task_state_mutate_existing` / `state_mutate` (`shared/lib/wavemill-common.sh`) | Raw edits to `workflow-state.json` |
| Delete a stuck row (mill stopped) | `remove_task_state <ID>` | `jq` + write |
| Stage result | `npx tsx tools/stage-result-cli.ts write-with-history <featureDir> <stage> <status> …` (only standard artifact keys; extra keys can drop the artifacts) | Hand-written result JSON |
| Publish a task-branch head | `npx tsx tools/publish-stage-head.ts --worktree … --branch … --state-dir … --issue … --stage … --kind … --actor mill --expected-sha …` | `git push` to a task branch, force pushes |
| Open a task PR | `npx tsx tools/open-task-pr.ts …` (title and body come from review artifacts `prTitle`/`prBody`) | `gh pr create` for task branches |
| End a stage agent | source `shared/lib/stage-teardown.sh`, then `stage_agent_teardown <ID> <featureDir> <reason> --phase <p> --worktree <wt>` | `tmux kill-window`, keystrokes |
| Retire an arm or record a termination | `source .env`, then `npx tsx tools/record-arm-termination.ts --issue … --kind cancelled\|policy-denied … --feature-dir <the arm's own feature dir>` | Editing abort records |
| Re-run review or Ready | type `re-review <ID>` into the mill pane (review/ready phase only) | Clearing markers by hand |
| Move finished coding to review | `advance <ID>` (needs a blocked-completion note whose `commit` is the current head) | Writing `.coding-complete` |

Before any write: back up what you'll change to the scratchpad, and say what you changed and where the backup is. **Check your target path.** A glob can pick a stray directory (`features/*` once matched an unrelated tracked folder), so use exact paths.

## Stall playbook

Match the symptom, check it, then fix it.

**Mill frozen; every write logs "Timed out acquiring state lock".** Cause: an ownerless lock dir (`.wavemill/<state>.lock` with no `owner.json`). Runtime reclaim needs an owner, so it never clears on its own. Check: same inode/mtime across 15 s, and `lsof +D <lock>` is empty. Then move it to the scratchpad. Check every `*.lock` (for example `quota-state.lock` too). A restart also clears it.

**A stage is "running" but the agent is idle.** For example: an idle Codex prompt, "Ask Codex to do anything", a coder that ended its turn without `.coding-complete`, or "command execution host is missing". The mill counts a live pane as progress. Read the agent's last message from its pane, or its session file (`~/.codex/sessions/…/rollout-*.jsonl`, `~/.claude/projects/…`). Then:
- If it stopped half-done, have the operator type a nudge in its window.
- If the reviewer is dead, run `stage_agent_teardown`. Then write the review result as `failed` with `--model-attribution-eligible false` and a reason like "Interrupted: … (agent-stalled)", and send `re-review`.

**Review "settled without a result (agent-idle-after-launch)", repeatedly.** Read the reviewer's session. It usually stopped at the **review-scope guard**. Run `npx tsx tools/check-review-scope.ts --repo-dir <wt> --feature-dir <fd>` yourself:
- **"Unexpected change outside task scope" listing the task's own key files:** the packet has no `## Files to Modify` heading with full paths, so scope came from prose. Add that section to the local `task-packet.md`, with the paths the plan names; verify each one belongs.
- **`cross-pr-revert` "appears to revert PR #N":** check whether the change really undoes #N (look at the overlapping files) or is a planned removal. If it's planned, the acknowledgement must appear in **commit messages** (review guard) **and the PR title or body** (Ready guard): `Reverts #N (<why>)`.
- **`deletion-budget`:** a file outside the review baseline lost many lines. If it's in scope, move `.review-scope-baseline.json` aside so it's rebuilt from the launch base.
- **A false finding is a finding about a real problem until shown otherwise.** One "scope" finding turned out to be deleted test suites. Check before you widen scope.

**A launch base or run ID from days ago** (`launch-base baseRef: <old sha>`, or run IDs with an old date). The mill process inherited stale tmux globals (`WAVEMILL_RESOLVED_BASE_SHA`, `WAVEMILL_RUN_EPOCH`, …). Unsetting the global doesn't fix the running mill. For each affected task, rewrite `lifecycle.launchContract.baseSha` to `git merge-base <wt HEAD> origin/<base>` via `task_state_mutate_existing`, and move stale scope baselines aside. Then restart with all `WAVEMILL_*` globals cleared (`tmux show-environment -g`).

**Ready loops on "neither ancestor nor descendant" / "refusing to overwrite the remote branch".** The local and remote heads diverged, for example after an agent amended a published commit, or a fresh attempt reused an old branch name. Don't force-push. Either:
- create a commit with the correct tree on top of the remote head: `git commit-tree <tree> -p <remote>`, then `reset --soft`; or
- `git merge -s ours <remote-head>`, which keeps the tree and fast-forwards.

Verify the tree is unchanged, then publish through the seam.

**A green PR labelled `wm:ready` that tend won't merge** (`eligible=0 blocked=1`, no reason given). Call tend's gate directly: `applyChallengePairGates` in `shared/lib/tend-challenge-gate.ts` on the PR JSON prints the reason. Known reasons:
- **`pair-unresolved:no-comparison`** or **`invalid_challenge (missing_challenge_intent)`:** retire the challenger with `record-arm-termination --kind cancelled` (a harness fault). The pair resolves as "sibling-challenge-aborted".
- **`pair-unresolved:branch-pair`:** a stale `…-challenger` branch exists for a single-model attempt. Archive it to `archive/<id>-challenger-<date>`, then delete it (operator approval needed).
- **`head-mismatch`:** wait for Ready to re-run at the new head.

**Retry counters "attempt 1/3" every time.** Each remediation commit resets the budget. Check whether each round fixes a *different* failure (it's converging, so let it run) or the same one (it's spinning, so step in).

**"Recorded task spend budget exhausted".** The budget lives in the task's route record (`maxCostUsd`), not only in config, and spend counts all of the task's owned sessions. That label can also be misapplied to other terminal causes, so read the actual detail. Raising it is the operator's call.

**Merged issues keep returning to In Progress.** Look at the reopen times. If they're about daily and stop while the mill is down, check `.wavemill/registry/linear-retry-queue.jsonl` for a stale pending write before blaming Linear's settings. After any promotion, list In Progress issues and re-close the ones whose PRs are merged (`gh pr list --state merged`).

**GitHub rate limit (`HTTP 403 API rate limit`).** `gh api rate_limit` gives the reset time. Look for the mill hot loop that's burning calls, and back off until the reset.

## Restart and promotion

When fixes on the integration branch need to reach the mill, or the process carries stale state:

1. `wavemill promote`; the operator merges the promotion PR.
2. Fast-forward the main checkout (`git merge --ff-only origin/main`). First check that the incoming diff doesn't touch the operator's local edits.
3. Quit the mill (`q` in its pane; again if needed), confirm the session is gone, back up and clear **every** `WAVEMILL_*` tmux global, and check for orphan locks.
4. Restart in a helper session with a non-colliding name (for example `millboot`, not `wavemill-*`). Answer the resume prompt (`r`). Confirm the first new launch records the live base and a fresh run ID.
5. List In Progress issues in Linear and re-close any the promotion reopened.

## Root causes, not just unsticks

Every manual unstick is evidence of a harness defect. Before filing, search Linear for an existing issue. File new ones in Backlog with the symptom, the exact evidence (log lines, file contents, timestamps), hypotheses marked as unverified, and "Done when" criteria. Keep issue IDs out of PR titles, branch names and commit subjects for supporting PRs; put them in the body. Use the `root-cause-issue` skill when the operator wants a full consolidation write-up.

## Delegation

Hand a fix that needs reproduction and real edits (a failing journey, a test restore, a review blocker) to a subagent. Give it: the exact worktree path, the evidence, the constraints from `CLAUDE.md`, that it commits locally and doesn't push, and what to report. Run tests one file at a time when memory is tight. You publish its commit through the seam afterwards. Don't run a subagent's work in parallel with a live stage agent in the same worktree.

## Reporting

Keep updates short. Lead with what changed and what needs the operator. Give exact commands for anything they must do. Report outcomes faithfully: say when something failed, when you were wrong, or when a fix is unverified. Send a `PushNotification` when the operator must act (a plan approval, a merge, a prompt) or when a stall needs a decision. Routine progress doesn't need one.
