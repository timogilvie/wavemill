# HOK-3502: prospective functional endpoint qualification

## Preregistration (before paid requests)

This study follows the immutable November 17 evidence in PR #1873. Its old literal verdicts, certificates and contributions are not reclassified. The captured StreamLake patch is replayed only in deterministic tests of the new functional contract.

Model: `kimi-k2.7-code` (`moonshotai/kimi-k2.7-code`). Reference: exact `moonshotai` catalog tag. Candidate: exact `streamlake` tag. Current endpoint catalogs are captured before calls; fallback is disabled and observed generation hosts must corroborate requests. Observed display names do not attest quantization or deployment variants.

Reference characterization has a **$3 cap** and three repetitions of each fixed workload (standard, workflow, cache-heavy), in that order per repetition. Every probe must be live, functionally correct and metered. The first non-pass stops characterization. There is no adaptive retry of a failed study. Only the existing two outer attempts for transient provider errors apply.

The limits in `limits.json` are fixed before reference calls. Count limits come from the existing production coding budget in `shared/lib/native-agent/launch-coding.ts`: 200 turns and 1,200 tool calls. They replace the tiny compatibility probe's six turns/ten calls for this experiment only. The existing canary's stricter 240-second **model-time**, 60,000-token and $0.50 per-attempt caps remain. This choice uses the established coding count envelope, not the candidate's observed performance. Tool stagnation and production per-call command limits still apply. Model time pauses during harness tool execution. No production coding budget or model policy changes.

If all nine reference runs pass, freeze the exact workload/oracle, NativePatch/command contract, limits and runtime identity in the comparison plan, with a hash of the reference characterization evidence. Candidate comparison has a separate **$20 cap**. The combined $23 reservation fits inside the user's existing $25 authorization after prior measured studies (less than $1). Admission uses the SDK's accounted spend plus the next full two-attempt reserve. Missing accounting stops requests.

The common contract is identical for reference and candidate. Standard compatibility runs precede rotating paired workflow/cache-heavy repetitions. The reliability tolerance remains five percentage points at 95% confidence (73 complete pairs with zero losses, derived through the existing Wilson helper). Candidate p95 end-to-end latency must be no more than twice reference p95. Any non-passing reference stops the comparison. Functional corruption, malformed mutation calls, invalid completion, out-of-scope changes and identity contradictions disqualify; resource/availability outcomes reduce completion without automatically disqualifying. All outcomes and costs remain. No repeated probing to erase failures.

The unchanged baseline test oracle runs again after the model stops. Earlier passing tests cannot certify later edits. Formatting is diagnostic under this prospective contract. Exact-byte NativePatch serialization and escaping tests remain strict. Tests/oracle changes are outside allowed scope.

All attempts retain canonical redacted SDK contributions, actual/estimated coverage, token/cache facts and provider observations. Timestamp facts feed the existing native time-split derivation: the end-to-end window includes retries, final verification and accounting overhead. Unknown time remains unknown. Raw transcripts, ownership records and generation identifiers stay in private evidence outside the repository.

No production routing is enabled. A small or failed study remains insufficient evidence; HOK-3497 stays gated. The command runs from this exact isolated checkout, without claiming that the running mill monitor has been rebuilt.

## Results

Pending execution under the preregistration above.
