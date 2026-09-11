# Decision Log Entry - HOK-2968

Date: 2026-09-10 America/New_York

Entry:

**2026-09-10 - HOK-2968 - wavemill -> data pipeline / SDK / website** - The Arbiter contract now separates a **delivery verdict** (which arm shipped) from a **stage attribution** (whether one arm's stage was causally better under matched inputs). `deliveryVerdict.outcome` is one of `primary`, `challenger`, `tie`, or `null`; it continues to be produced by the generic final-PR arbiter and remains Model A's candidate-selection target (HOK-2817). `stageAttribution.status` is one of `valid`, `invalid`, or `insufficient_evidence`; it is a new causal claim, gated by matched fork identity (task-packet, plan, prompt, tool-config hashes) and direct executed-review evidence. Invalid or insufficient results **never** count toward model-stage coverage or routing training, though their delivery verdict remains usable. Direct evidence does not compensate for divergent pre-stage inputs; that rule is codified as `divergentInputsSuppressedDirectEvidence`. Executed identities are recorded separately for review orchestration, substantive analysis and remediation; a pinning failure on any of them makes stage attribution invalid or insufficient. Historical records are preserved untouched - the schema evolution is additive.

Manual follow-up: copy this entry into the Program Decision Log Linear document
`arbiter-program-brief-and-decision-log-0e9fa05622a1` after merge.
