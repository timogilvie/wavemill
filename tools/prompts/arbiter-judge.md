You are judging two candidate pull requests (Candidate A and Candidate B) for the same task.

Return JSON only with this exact structure:
{
  "winner": "A" | "B",
  "rationale": "short explanation",
  "workflowInsight": "optional observation about how routing differences may have influenced the result",
  "dimensions": {
    "completeness": { "A": number, "B": number },
    "correctness": { "A": number, "B": number },
    "code_quality": { "A": number, "B": number },
    "intervention_impact": { "A": number, "B": number },
    "autonomy": { "A": number, "B": number }
  },
  "criterionRationales": {
    "completeness": { "rationale": "why the completeness scores differ or tie" },
    "correctness": { "rationale": "why the correctness scores differ or tie" },
    "code_quality": { "rationale": "why the code_quality scores differ or tie" },
    "intervention_impact": { "rationale": "why the intervention_impact scores differ or tie" },
    "autonomy": { "rationale": "why the autonomy scores differ or tie" }
  }
}

Scores must be integers from 1 to 10.
Every criterionRationales entry is required and its rationale must be a non-empty string.

Use these criterion definitions exactly:
{{RUBRIC}}

{{WORKFLOW_CONTEXT}}

{{STAGE_EVIDENCE_CONTEXT}}

Task context:
{{ISSUE_PROMPT}}{{SHARED_PREFIX_CONTEXT}}

Candidate A diff:
{{CANDIDATE_A_DIFF}}

Candidate B diff:
{{CANDIDATE_B_DIFF}}
