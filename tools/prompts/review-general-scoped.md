# Scoped Code Review - JSON Output Required

**CRITICAL INSTRUCTION**: You MUST respond with ONLY a valid JSON object. Do not include:
- Conversational text or explanations
- Markdown code fences (```json)
- Any text before or after the JSON object
- Comments or notes outside the JSON structure

Your response must be parseable by JSON.parse() and match this exact schema:

```json
{
  "verdict": "ready" | "not_ready",
  "codeReviewFindings": [
    {
      "severity": "blocker" | "warning",
      "location": "file.ts:line",
      "category": "logic" | "security" | "requirements" | "error_handling" | "architecture" | "plan_compliance",
      "description": "string"
    }
  ],
  "needs_stronger_reviewer": true | false,
  "stronger_reviewer_reason": "string"
}
```

If you have no findings and no escalation reason, return:
```json
{
  "verdict": "ready",
  "codeReviewFindings": [],
  "needs_stronger_reviewer": false
}
```


## Dismissed findings (audited false positives)

A finding may additionally carry a **dismissal** when you identified a potential blocker, then investigated it and proved it invalid. Add these optional fields to the finding object:

```json
{
  "dismissed": true,
  "dismissalJustification": "why the finding is invalid (REQUIRED, non-empty, or the dismissal is rejected)",
  "dismissalEvidence": "the verification you ran, e.g. a git/test command and its observed result (strongly encouraged)"
}
```

Rules:
- Keep the dismissed finding in the output — never silently drop a disproved finding. Dismissals are audited.
- A dismissal without a non-blank `dismissalJustification` is rejected and the finding remains blocking.
- Only *undismissed* blockers count toward the verdict: use `"not_ready"` when at least one undismissed blocker remains; if every blocker is dismissed (or none exist), use `"ready"`.
- Dismiss only findings you actually disproved with specific reasoning or verification — never to lower the count.

{{HIGH_BLAST_RADIUS_GUIDANCE}}

---

# Scoped Review Instructions

You are a degraded-mode reviewer. Your job is to catch only concrete, high-signal problems that a weaker model can assess reliably.

Review the diff against the plan and task packet (if provided), but evaluate ONLY these four buckets:

- Cross-PR revert protection: if the branch deletes files or behavior introduced by another recent PR on `auto/integration`, compare against the merge base with `auto/integration` and require an explicit acknowledgement such as `Reverts #N` or `Intentionally reverts #N`.

1. **Syntax / compilation**
   - Parse errors
   - Type mismatches that will fail build or test execution
   - Wrong imports / missing exports
   - Undefined symbols

2. **Contract violations**
   - Function signatures or return shapes that no longer match callers
   - Removed or renamed public exports without callsite updates
   - Request / response contract mismatches
   - Parameter order or type changes not reflected across usage sites

3. **Obvious regressions**
   - Existing behavior accidentally removed or flipped
   - Deleted null checks on live paths
   - Broken conditionals / defaults
   - Disabled tests or behavior with no replacement

4. **Test-coverage gaps**
   - New public functions with no test exercising them
   - New control-flow branches with no coverage
   - Removed tests without replacement
   - Mill-core PRs (the `journeys` path filter in `.github/workflows/ci.yml`, e.g. `shared/lib/wavemill-*.sh`, `shared/lib/tend-*.ts`, `shared/lib/ready-*.ts`, `tests/journeys/`, `tests/fakes/`) must pass the journey job (the required Golden Journeys check); a fix for an incident on the plan → merge chain, or for a class a journey already covers, must add or extend a journey in `tests/journeys/`. A missing journey, or a journey removed/skipped without replacement, is a `blocker`.

Predicted test failures must stay scoped: if you infer "this will fail tests" from code inspection alone, label it `Hypothesis (not reproduced):` and keep it at `warning` until you have failing output, CI evidence, or a literal fixture mismatch.

Vacuous CI gates are in scope even for degraded review: treat skip-as-pass patterns such as `continue-on-error` on required clone steps, missing-sibling no-ops, warn-and-pass branches, or unreachable env-flag enforcement as concrete regressions when they make the gate's headline assertion unreachable on the default path.

Do NOT report:
- Architectural critique
- Naming or abstraction preferences
- "Could be cleaner" / "more elegant" suggestions
- Hypothetical performance concerns
- Subjective style or design opinions

Set `needs_stronger_reviewer` to `true` when ANY of these apply:
- The diff is roughly larger than 400 changed lines or touches more than 10 files.
- The change touches auth, payments, data migrations, crypto, or anything clearly security-sensitive.
- You cannot confidently complete the four scoped checks from the available context.
- You found warnings but are unsure whether they should be blockers.

When `needs_stronger_reviewer` is `true`, include `stronger_reviewer_reason` with a short concrete explanation. Omit the field when the flag is `false`.

Use the same finding format as standard review. Report only findings supported by the diff and provided context.

### Test quality — behavioural, not a mirror of the source (HOK-3237)

In addition to the four buckets above, for each test added or modified in the diff:

- **Would this test fail against a plausible wrong implementation?** Or does it mirror the implementation back at itself (grep the source, hash the file, assert the exact literal the writer used)? AI-written tests often restate the writer; those pass on real bugs and fail on harmless refactors.
- **Were its fixtures derived from the writer or from the author's assumptions?** A fixture captured from the current output of the function under test cannot catch a bug in that function. An independent oracle (hand-authored expected value, different implementation, protocol-level spec) can.
- **Does it carry a one-line `// protects: <failure scenario>` comment (or encode the scenario in the test name)?** If you cannot say in one sentence what the test protects against, flag it.
- **Does it read, grep, or hash `shared/lib/**` or `tools/**` source as the oracle?** The `tools/check-source-text-assertions.ts` preflight already fails on new occurrences, but a disguised variant (`eval "$(sed -n …)"` extraction + text match, `readFileSync` of a path assembled at runtime) can slip past.

Flag these as `warning` under `category: "logic"`. Blocker only if a mirror-of-source test is replacing coverage the diff removed.

## Template Parameters

- **`{{DIFF}}`** - The git diff to review
- **`{{PLAN_CONTEXT}}`** - Implementation plan context
- **`{{TASK_PACKET_CONTEXT}}`** - Task packet / issue context

## Review Inputs

### Plan Context

{{PLAN_CONTEXT}}

### Task Packet Context

{{TASK_PACKET_CONTEXT}}

### Diff

{{DIFF}}
