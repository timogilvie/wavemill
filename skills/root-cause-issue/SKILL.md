---
name: root-cause-issue
description: Turn a wavemill bug (stuck task, Backstage item, wrong terminal state, manual unstick) into a Linear issue that fixes the root cause by consolidating duplicated decisions onto one primitive, with net code deletion, instead of adding another case-specific check. Use whenever the user wants to file, write or draft an issue for a mill failure, incident, or operator intervention.
---

# Root-Cause Issue

Wavemill bugs mostly come from one source: **the same decision is made in more than one place, and the copies disagree.** A point fix patches one copy, the other copies keep failing, and the next incident arrives as a "new" bug. This skill writes issues that remove the duplication instead.

The governing rules come from the reliability epics (HOK-3173, HOK-3178, HOK-3219) and the invariants documented in the repo's agent instructions file (for example `CLAUDE.md` or `AGENTS.md`, whichever your agent loads):
- One primitive, applied everywhere, enforced by a CI guard.
- A fix that only adds a terminal cause, marker, classifier string, flag or retry bucket gets pushed back. Fixes consolidate, with a net-deletion target.
- Every incident becomes a replay fixture.
- One recovery path: failures go through `failure-policy.ts` → bounded retry → escalation (HOK-3176, HOK-3277).

## Step 0 — Unstick separately

If the mill is stuck right now, unstick it first (use any saved unstick recipes or runbooks you have), and keep that out of the issue. The unstick tells you which state was wrong. It is not the design of the fix. Record what you had to change by hand, because that list is evidence.

## Step 1 — Capture evidence as facts

Collect what actually happened, with timestamps, before you theorise:
- The task row: `jq '.tasks["<ID>"]' .wavemill/workflow-state.json` (phase, status, lifecycle, retention, cleanupEpisode, terminalReconciliations)
- Monitor log lines: `grep "<ID>" /tmp/wavemill-mill-status.log`
- Hook file and terminal history: `/tmp/wavemill-<SESSION>-<ID>.hook`, `features/<slug>/.terminal-history.jsonl`
- Stage results and markers in `features/<slug>/` (`.<stage>-result.json`, `.retry-*`, failure envelopes)
- Pane tail: `tmux capture-pane -p -t <session>:<win>`
- Git truth: worktree HEAD, unpushed commits, dirty files
- **Sibling incidents**: other tasks that hit the same trigger in the same window but came out differently. These are the best evidence that the decision is duplicated.

Save the raw evidence somewhere that will last (the incident dir or the issue body). It becomes the replay fixture.

## Step 2 — Find the decision site, then every copy of it

1. Find the function that made the wrong decision (the line that logged it, or the line that wrote the wrong state). Cite it as `file:line`.
2. Restate the question it was answering in plain words: "is this agent native?", "is the pane's owner gone?", "may this task be reaped?", "is this failure terminal?"
3. **Grep for every other place that answers the same question**: other functions, the shell twin of a TS module, CLI and monitor variants, private hook/TTL readers, copied lists (for example the legacy-writer event list). Build a table:

   | Site | Signal it reads | Outcome it produces |
   |---|---|---|

   If the rows disagree on signal or outcome, that disagreement is the root cause. If there really is only one site, say so explicitly and check Step 3 harder.

## Step 3 — Check history and the existing primitives

- `git log -S '<function or string>' --oneline` and a Linear search for the symptom: **has this class been fixed before, in a different copy?** A chain of issues (A → B → C) is the signal that the fix needs to consolidate.
- Compare against the documented invariants (the "Utilities" section of the agent instructions file: task-progress, failure-policy, bounded-retry, condition-reconciler, session capabilities, task identity, merge labels, launchability, provider identity, workflow-state shape). Usually a primitive already exists and a site is **bypassing** it. Then the fix is "route this site through the primitive and add the guard", not new logic.
- Propose a *new* primitive only when at least 3 sites answer the same question and no existing primitive fits. Say why none of the existing ones fit.

## Step 4 — Align with the backlog

- Search open Linear issues (Backlog / In Progress, wavemill project) for the same decision or subsystem. Read the open reliability epics (HOK-3173, HOK-3178, HOK-3219) and their open children.
- If an open issue already owns the consolidation, **add the incident as evidence on that issue** (a comment with a fixture pointer) instead of filing a new one.
- Merge symptoms: several Backstage items or incidents with one shared root become **one** issue.
- Place the issue: parent it under the relevant epic (usually HOK-3173), link the prior fixes in the class with `relatedTo`, and use `blockedBy` only for real ordering.

## Step 5 — Write the issue

Title: name the consolidation, not the symptom. Pattern: **"One <decision>: <single source of truth>, and <what gets deleted>."**
- Good: "One terminal-cleanup decision: the monitor and the CLI share one decider, and a terminal task's lifecycle (not its pane) decides release"
- Bad: "Cleanup should also accept waiting:Notification"

Body sections, in this order:

```markdown
## Why
Incident: the date, task IDs, and what went wrong in user-visible terms (the stuck task, the operator touch).
Evidence: the log lines, state fields and timestamps from Step 1, plus sibling tasks that behaved differently.
Prior fixes in this class (HOK-…), and which copy each one fixed.

**The root cause is that <decision> is made in N places:**
| Site | Signal | Outcome |   ← from Step 2

## Change
1. **One <decider/primitive>.** <Which module becomes the source of truth>. Callers <call it / act on its result>.
2. **Delete:** <the named functions, branches, copied lists, private readers>.
3. <Inputs that must stop deciding, e.g. pane text, a private TTL, a requested wire id>.
4. Relation to the in-flight epics: <which slice of HOK-3277 / HOK-3178 this is, or what it unblocks>.

## Not in scope
- New terminal causes, refusal reasons, markers, classifier strings, retry buckets or shadow switches. Say which ones the fix makes unreachable.
- <Adjacent work owned by another issue>.
- <Open questions, e.g. what triggered the incident, if the fix makes it harmless regardless.>

## Acceptance
- [ ] Exactly one implementation of <decision>. A preflight guard (on `tools/lib/source-guard.ts`) fails on a new one or on a bypass.
- [ ] Replay fixture built from this incident's evidence passes.
- [ ] A golden journey (`tests/journeys/`, HOK-3228) covers the general case with zero operator touches, not only this incident.
- [ ] <Named functions> are deleted. Net deletion is reported in the PR.
```

Priority: High when the bug parks delivered work or needs an operator touch to make progress. Otherwise Medium.

## Step 6 — Run the anti-pattern check before filing

Reject the draft and rewrite it if any of these is true:
- The Change adds a case: "also handle X", "treat Y like Z", a new `case` arm, a new allowed string.
- The fix is keyed on incident-specific text: a model name, a pane-scrollback regex, an error substring, an issue ID.
- It adds a terminal cause, marker, flag, env var, retry bucket or shadow switch without retiring one.
- Nothing is named for deletion, or the "one decider" still leaves other sites deciding.
- Acceptance only reproduces this incident. It needs the general journey too.
- It re-derives something a documented primitive already provides.
- It duplicates an open issue instead of adding evidence to it.

**Legitimate exception:** an urgent hotfix that unblocks the mill today may be a point fix. File it labelled as a hotfix, **and** file (or update) the consolidation issue that will delete the hotfix, linked with `relatedTo`.

## Step 7 — Review, then file

Show the user the draft(s): title, the duplication table, what gets deleted, and the backlog placement. File after they approve, or straight away if they already asked you to file. Report the issue URL(s), and any existing issues you added evidence to instead of filing.
