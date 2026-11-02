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

## Step 2b — Decompose the fix before designing it

The decision that failed is rarely the only decision the fix makes. Before checking primitives, write your intended Change as a list of the **decisions it makes and mechanisms it adds**: every check, timer, deadline, counter, tracker, parser, stored field, classification and recovery action. Each one is a decision in its own right and goes through Steps 3–4 on its own, exactly like the decision that failed. A fix that adds a mechanism nobody has checked is not done.

Also ask the reverse of Step 2: **does the mechanism that fired answer more than one question?** Example: a fixed wall-clock timeout answering both "is the model looping?" and "is the harness hung?". If it does, the fix splits it so each question goes to its own primitive. Tuning it (raising the limit, clamping inputs to it, re-labelling who gets blamed) is not a fix.

## Step 3 — Check history and the existing primitives

- `git log -S '<function or string>' --oneline` and a Linear search for the symptom: **has this class been fixed before, in a different copy?** A chain of issues (A → B → C) is the signal that the fix needs to consolidate.
- **Fill in a primitive lookup table for every decision from Step 2 and Step 2b.** Build the "existing owner" column by restating each "Utilities" entry in the agent instructions file as the plain-language question it answers, then matching on the *question*, never on keywords from the incident. The words a primitive uses ("liveness", "deadline", "derived duration") are usually not the words the incident uses ("budget", "timeout", "stuck").

  | Decision (plain question) | Existing primitive / contract that answers it | Its guard | Extend it, or why it doesn't fit |
  |---|---|---|---|

  Seed questions (check each one still exists before citing it):
  - Is the agent making progress, alive, stalled, busy with its own background work? → `task-progress.ts` (HOK-3101)
  - A step is past its deadline with no progress: what now? → `ledger-recovery.ts` `decideRecovery` (HOK-3185 / HOK-3277)
  - Is this failure terminal, retryable or a code failure? → `failure-policy.ts` (HOK-3176)
  - Relaunch after a failure, with what limit? → `bounded-retry` (HOK-2924)
  - How long did X take; whose time was it? → derived duration functions over recorded events, never stored (HOK-3338 rule 3, HOK-3340)
  - Which attempt or run is this? → `task_attempt/v1` (HOK-3372)
  - Which model actually ran? → `executed-model-resolver.ts` (HOK-3369)
  - Does a marker's condition still hold? → `condition-reconciler.sh` (HOK-3172)
  - Which merge label should this PR have? → `merge-labels.ts` `deriveMergeLabel` (HOK-3181)
  - Does a consumer exist for this work? → `resolveSessionCapabilities` (HOK-3102)
  - What workflow-state fields exist? → `workflow-state.ts` / `workflow-task.schema.json` (HOK-3220)
  - Who launched this session, and what did it cost? → `session-ownership.ts` / `meterWorkflowCost` (HOK-3328)
  - What command is this (native tools)? → `native-agent/command-argv.ts`
- **Check the cross-repo contracts too.** List the Hokusai SDK project's open issues and read the design rules of any contract (task cost, attempt identity, lifecycle events) that names a field, duration or fault class your fix would produce. "Facts, not interpretations" and "durations derived, never stored" are constraints on wavemill code even though they're filed in another project.
- Usually a primitive already exists and a site is **bypassing** it. Then the fix is "route this site through the primitive and add the guard", not new logic.
- Propose a *new* primitive only when at least 3 sites answer the same question and no existing primitive fits. Say why none of the existing ones fit.
- **Verify every value and behaviour you cite** (a limit, a default, a threshold, what a function does) by reading the code in this session. Don't propose "raise X to Y" without reading Y.

## Step 4 — Align with the backlog

Search three ways, not one:

1. **Symptom:** the incident's own words, to find history and duplicates.
2. **Owner:** for each primitive in the Step 3 table, the open and in-flight issues that touch its module or name it. Use `list_issues` across **all projects** (wavemill, Hokusai SDK, Native Agent Launch Readiness, …) in every non-closed state, including Triage and In Review. An In Progress or In Review issue that is changing a primitive you depend on sets the design's starting point.
3. **Files:** open PRs that touch the same files. Read their diffs (`gh pr diff <n>`). Design against the state after they merge, not against `main`.

Then:
- Read the plan document (the Linear "Wavemill priority list" doc and the Now milestone) and the open reliability epics (HOK-3173, HOK-3178, HOK-3219) with their open children.
- If an open issue already owns the consolidation, **add the incident as evidence on that issue** (a comment with a fixture pointer) instead of filing a new one. If an open issue owns a primitive your fix depends on, comment there with the dependency and any invariant it must keep for you. Don't expand its scope.
- Merge symptoms: several Backstage items or incidents with one shared root become **one** issue.
- Place the issue: parent it under the relevant epic (usually HOK-3173), link the prior fixes in the class with `relatedTo`, and use `blockedBy` for real ordering, including "both edit the same file, land this one first".
- **Slice when dependencies become ready at different times.** If parts of the fix depend on issues that will be ready weeks apart, file numbered slices (`<Name> 1/N`), each blocked only by what it needs. Put the slice that fixes Hokusai attribution (fault class, executed model, cost) first, since that is goal 1 of the plan. Don't file one issue blocked on everything.

## Step 5 — Write the issue

Title: name the consolidation, not the symptom. Pattern: **"One <decision>: <single source of truth>, and <what gets deleted>."** Keep it under ~90 characters: the mill derives branch and worktree names from the title, and a slug past the 255-byte ref limit fails the launch with "cannot lock ref". Put the deletions in the body.
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

**Primitives reused:**
| Decision | Primitive / contract | Extended how |   ← from Step 3

## Sequencing
- Blocked by: <issues whose primitive this extends>. Lands before: <issues touching the same files>.
- Plan placement: <Now / Next / Later, and the priority-list line this adds>.
- Slice: <N of M, if sliced; what the other slices are>.

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
- It answers a model failure by changing which model runs (a minimum model strength, a pin, avoiding a model for some files, pausing challenges). Model selection is Hokusai's decision (`AGENTS.md`). Rewrite the fix so the failure reaches Hokusai: executed model, correct fault class, cost, outcome.
- It adds a **mechanism** (a timer or deadline, a progress or stagnation tracker, a counter, a parser or classifier, a stored duration or derived field, a ceiling constant) that has no row in the Step 3 table naming the primitive it extends.
- A value is chosen from this incident's numbers ("3 hours, because this run took 60 minutes") instead of coming from an existing configuration or primitive.
- It cites a value, threshold or behaviour you haven't read in the code during this session.
- It keeps a mechanism that answers two questions and only tunes it (Step 2b).
- It is one issue blocked on dependencies that become ready at very different times.
- It conflicts with an open PR on the same files, or with a primitive an in-flight issue is rewriting, and says nothing about the order.

**Legitimate exception:** an urgent hotfix that unblocks the mill today may be a point fix. File it labelled as a hotfix, **and** file (or update) the consolidation issue that will delete the hotfix, linked with `relatedTo`.

## Step 7 — Review, then file

Show the user the draft(s): title, the duplication table, **the primitive lookup table from Step 3**, what gets deleted, the backlog placement and the sequencing. The reuse decisions are the part most likely to be wrong, so don't leave them out of the review. File after they approve, or straight away if they already asked you to file. Report the issue URL(s), any existing issues you added evidence or dependency notes to instead of filing, and any change to the plan document.
