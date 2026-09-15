## Your Task: Review & PR Creation

You are in the **REVIEW PHASE** of a multi-phase workflow (mode: {{REVIEW_MODE}}).

The implementation is complete. Your job is to review and create a PR.

### Your Responsibilities

1. **Run self-review tool** (up to 3 iterations):
   IMPORTANT: Run from your current directory (the worktree). Do NOT change directories.
   IMPORTANT: This tool calls the Claude API and takes 2-5 minutes. Configure your tool's built-in timeout (for Claude Code's Bash tool: `timeout: 600000` — 600000 ms = 10 minutes) so the call is not killed at the default cap. Do NOT prefix the command with the external `timeout` binary — it is not installed by default on macOS and will fail with `command not found: timeout`.
   npx tsx {{TOOLS_DIR}}/review-changes.ts {{BASE_BRANCH}} --json --operating-mode {{OPERATING_MODE}}
   {{REVIEWER_NOTE}}
   Track `FINAL_REVIEW_EXIT_CODE`, `REVIEW_ITERATIONS`, final verdict, blocker count, warning count, the `failureCategory` field from the final review JSON when present, and any review-tool stderr for the last run.
   - Exit code 0 = review passed → proceed to step 3
   - Exit code 1 = issues found → fix blockers and re-run (step 2)
   - Exit code 2 = error → log comprehensive diagnostics, record `verdict: "error"`, and proceed to PR creation in step 3 without readiness certification
   The output is structured JSON with verdict, codeReviewFindings, and optional uiFindings.

   When exit code 2 occurs, you MUST log the following diagnostics to help debug the failure:
   ```
   ⚠️  Review tool failed with exit code 2

   Diagnostics:
   - Command: npx tsx {{TOOLS_DIR}}/review-changes.ts {{BASE_BRANCH}} --json --operating-mode {{OPERATING_MODE}}
   - Working directory: $(pwd)
   - Tool path: {{TOOLS_DIR}}/review-changes.ts
   - Tool exists: $(ls -lh {{TOOLS_DIR}}/review-changes.ts 2>&1 || echo "NOT FOUND")
   - Git root: $(git rev-parse --show-toplevel 2>&1)
   - Current branch: $(git rev-parse --abbrev-ref HEAD 2>&1)
   - Base branch exists: $(git rev-parse --verify {{BASE_BRANCH}} 2>&1 || echo "NOT FOUND")
   - STDERR output: [paste the actual stderr from the failed command]

   Proceeding to PR creation without `wm:ready` per instructions.
   ```
   This diagnostic information is CRITICAL for debugging recurring tool failures.

2. **For each iteration where issues are found**:
   - Read the review JSON output carefully
   - Fix all blockers (severity: blocker) and straightforward warnings
   - **Dismissing a disproved blocker**: if you investigate a blocker and prove it is a false positive (e.g. a scope finding caused by a stale/diverged diff base while the actual PR diff is clean), do NOT fix non-existent problems, do NOT lie about the count, and do NOT park the task. Instead record the blocker as *dismissed* in step 4's `dismissedBlockers` artifact field. A dismissal REQUIRES a non-empty `justification` explaining why the finding is invalid, and SHOULD include `evidence` citing the exact verification you ran (e.g. `git log {{BASE_BRANCH}}..HEAD -- <paths>` and its output). A dismissal without justification is rejected by the ready gate and the blocker still counts.
   - Make targeted fixes only — do not refactor unrelated code
   - Run the review scope guard immediately before committing:
     `npx tsx {{TOOLS_DIR}}/check-review-scope.ts --repo-dir .`
   - If the guard exits 1, preserve the index, report the violation, and stop review-fix committing/PR progression. No review commit may be created until the guard passes.
   - If the guard exits 2, scope could not be verified (tool/git failure — infrastructure, not a violation): capture the guard's stderr, note "review scope unverified (infrastructure)" in the commit message body and PR body, and proceed with the commit. Do not treat exit 2 as a scope violation.
   - If the guard exits 3, scope passed but no PR exists yet for this branch (the normal pre-PR state, not a violation): proceed exactly as for exit 0.
   - Commit fixes: git commit -m "fix: Address self-review findings (iteration N)"
   - Re-run the review tool (step 1)

3. **Create a PR** using GitHub CLI with a descriptive title and body:
   gh pr create \
     --base {{BASE_BRANCH}} \
     --title "{{ISSUE}}: <concise summary>" \
     --label "wavemill" \
     --body "<PR body>"
   If `gh pr create` fails because the `wavemill` label does not exist in this repository, create the PR without `--label "wavemill"`, then attempt:
   `gh pr edit "<PR_URL>" --add-label "wavemill"`
   If that also fails, note the missing label in the PR body and proceed.
   The PR body MUST include:
   - A "## Summary" section with 2-4 bullet points describing what changed and why
   - A "## Changes" section listing the key files/modules modified
   - A "## Test plan" section describing how the changes were validated
   - A "## Self-review" section noting the review verdict and iterations run
   - An optional "## Routing" section when route artifacts or `{{FEATURE_DIR}}/routing.jsonl` exist.
     Label it **Non-authoritative routing context**. Wavemill stamps the authoritative
     machine-readable executed planner/coder/reviewer route into `wavemill-meta`
     before `wm:ready`.
     Distinguish these concepts explicitly when the artifacts are available:
     bootstrap route from `{{FEATURE_DIR}}/.initial-route.json`,
     actual planning execution from `{{FEATURE_DIR}}/.planning-result.json`,
     recommended after expansion from `{{FEATURE_DIR}}/.post-expansion-route.json`,
     and active remaining route from `{{FEATURE_DIR}}/.routing-complete` or `{{FEATURE_DIR}}/.phase-config.json`.
     If the expanded planner differs from the executed planning model, label it `Recommended after expansion`;
     do not imply that planner actually ran.
     When `{{FEATURE_DIR}}/routing.jsonl` exists, also include runtime execution telemetry:
     planner/coder/reviewer requested selector, resolved model ID, source layer,
     and fallback reason when present. Ignore malformed lines.
   - A Wavemill metadata block at the end of the body:
     <!-- wavemill-meta
     task: {{ISSUE}}
     -->
   Do NOT use --fill. Write the PR body as a HEREDOC if needed for formatting.
   After creating the PR, add the `wm:ready` label only if there are no *undismissed* blockers — either the final self-review run exited 0 with zero blockers, or every remaining blocker is a disproved false positive you are recording as dismissed with a justification (step 4):
   `gh pr edit "<PR_URL>" --add-label "wm:ready"`
   If the `wm:ready` label does not exist in this repository, note it in the PR body and proceed.
   Do NOT add `wm:ready` if:
   - The self-review found unresolved blockers (exit code 1) that you have not dismissed with a documented justification
   - The final self-review run errored (exit code 2) or did not produce a trustworthy verdict
   - The workflow is in survival/constrained mode and confidence is low
   When you add `wm:ready` on the strength of dismissals, list each dismissed blocker with its justification and evidence in the PR body's "## Self-review" section so an operator can audit the decision.

4. **Record final review evidence** in `{{FEATURE_DIR}}/.review-result.json` after PR creation.
   Use `tools/stage-result-cli.ts` to update the review stage with explicit final self-review outcome fields. `status: "completed"` only means the review phase produced the PR artifact; it does not mean the review passed.
   - If the final run exited 0 with verdict `ready` and zero blockers, record `exitCode: 0`, `verdict: "ready"`, `iterations: <count>`, `blockerCount: 0`, and `warningCount`.
   - If the final run exited 1, record `exitCode: 1`, `verdict: "not_ready"`, `iterations`, `blockerCount`, and `warningCount`. Report the verdict and counts truthfully — never report zero blockers to force readiness.
   - If you disproved blockers (step 2), additionally record `dismissedBlockers`: an array with one entry per dismissed blocker, each `{location, category, description, justification, evidence}`. `justification` is REQUIRED and must be non-empty; `evidence` should cite the verification command you ran. Keep `blockerCount` as the raw count — the orchestrator's ready gate derives the effective (undismissed) count from these entries and passes when every raw blocker is validly dismissed.
   - If the final run exited 2, record `exitCode: 2`, `verdict: "error"`, `iterations`, `blockerCount: 0`, `warningCount: 0`, `reviewToolError`, and `diagnostics`.
   - If the final review JSON contains a `failureCategory`, you MUST record it verbatim in the artifacts (and `reviewToolError` when present). The orchestrator uses `failureCategory` to decide whether a failed review is retryable infrastructure (e.g. `review-scope-unverifiable`) rather than a genuine defect — dropping it stalls the task permanently.
   Example:
   ```bash
   REVIEW_ARTIFACTS=$(jq -cn \
     --argjson pr "$PR_NUMBER" \
     --argjson exitCode "$FINAL_REVIEW_EXIT_CODE" \
     --arg verdict "$FINAL_REVIEW_VERDICT" \
     --argjson iterations "$REVIEW_ITERATIONS" \
     --argjson blockers "$FINAL_BLOCKER_COUNT" \
     --argjson warnings "$FINAL_WARNING_COUNT" \
     --argjson dismissed "${DISMISSED_BLOCKERS_JSON:-[]}" \
     --arg failureCategory "${FINAL_FAILURE_CATEGORY:-}" \
     '{type:"review",prNumber:$pr,exitCode:$exitCode,verdict:$verdict,iterations:$iterations,blockerCount:$blockers,warningCount:$warnings}
      + (if ($dismissed | length) > 0 then {dismissedBlockers:$dismissed} else {} end)
      + (if $failureCategory != "" then {failureCategory:$failureCategory} else {} end)')
   npx tsx {{TOOLS_DIR}}/stage-result-cli.ts update "{{FEATURE_DIR}}" review \
     --status completed \
     --notes "PR #$PR_NUMBER created" \
     --artifacts "$REVIEW_ARTIFACTS"
   ```
   With a dismissal, `DISMISSED_BLOCKERS_JSON` looks like:
   ```json
   [{"location":"scope-guard","category":"plan_compliance",
     "description":"Diff includes files outside task scope",
     "justification":"False positive: the diff base was stale/diverged; the PR's actual diff touches only in-scope files.",
     "evidence":"git log {{BASE_BRANCH}}..HEAD -- <in-scope paths> showed only this task's commit; GitHub PR diff lists only in-scope files."}]
   ```

### Authorship Attribution

Before creating the PR, determine whether you are the principal author:

1. **Check commit authorship** using:
   ```bash
   git shortlog -sn --no-merges {{BASE_BRANCH}}..HEAD
   ```

2. **Principal author determination**:
   - If you authored >50% of commits on this branch, you ARE the principal author
   - If you authored ≤50% of commits, you are NOT the principal author

3. **Attribution rules**:
   - **If you ARE the principal author**: Add standard co-authored-by trailer when creating commits:
     ```
     Co-authored-by: Claude [Model] <noreply@anthropic.com>
     ```
   - **If you are NOT the principal author**: Do NOT add co-authored-by trailers
     - You are reviewing or contributing to someone else's work
     - Use "Reviewed-by" tag if appropriate, or simply omit attribution
     - Never override the PR author field if someone else created the branch

4. **Link the PR to {{ISSUE}}**

{{OPERATING_MODE_GUIDANCE}}

### Review Mode: {{REVIEW_MODE}}

{{MODE_GUIDANCE}}

{{DRAFT_PR_INSTRUCTION}}

### Success Criteria
- [ ] Self-review tool executed (unless mode is 'none')
- [ ] Blockers fixed (if any were found)
- [ ] PR created with descriptive summary
- [ ] PR linked to {{ISSUE}}

### Important Notes
- Do not skip the review - it's a required step
- Fix blockers before creating PR
- Make targeted fixes only - no scope creep
- If review tool fails with exit code 2, document the failure and proceed

### FORBIDDEN: Merge Lifecycle

You MUST NEVER perform any of the following actions:
- Add the `wm:merging` label (for example: `gh pr edit ... --add-label wm:merging`)
- Add the `wm:merged` label (for example: `gh pr edit ... --add-label wm:merged`)
- Merge the PR yourself (for example: `gh pr merge ...`)
- Enable auto-merge (for example: `gh pr merge --auto`)

The Wavemill controller manages all merge operations. Agent interference with the merge lifecycle is explicitly prohibited.

### CRITICAL: Phase Boundary Rules

You are ONLY allowed to:
- Run the self-review tool
- Fix issues identified by self-review (targeted fixes only)
- Create the PR via gh pr create
- Create git commits for review fixes

You are FORBIDDEN from:
- Implementing new features or enhancements beyond what's already coded
- Refactoring code that wasn't flagged by the review tool
- Modifying plan.md or task-packet files
- Re-running the planning or coding phases

### Handling User Abort Requests

If the user asks you to stop work, close the issue, abort, or otherwise discontinue this workflow:
- Create the abort marker: touch "{{FEATURE_DIR}}/.workflow-aborted"
- Do NOT create additional completion output or a PR
- Inform the user that the workflow is being stopped
- Stop after creating the marker and reporting the abort.
