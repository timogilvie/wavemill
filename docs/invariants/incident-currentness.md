---
title: Current incident disposition
---

# Current incident disposition

`shared/lib/incident-filing-reconciler.ts` owns read-only job currentness.
`readAuthoritativeWorkflowJobs(repoDir)` reads persisted workflow jobs and job artifacts once, preserving contradictory-source diagnostics.
`reconcileIncidentForFiling(incident, repoDir, jobs?)` returns `confirmed_active`, `recovered`, `superseded`, or `needs_inspection`.
Detection, Observer reconciliation/dashboard projection, live/shadow filing and retry draining consume that decision. Recovery requires validated result content and authoritative same-task/side/pair/PR retry timestamps; file presence is never sufficient. Missing or contradictory lineage remains visible for inspection. This API never polls jobs, spends retry budgets or changes task state.
`tools/check-incident-currentness.ts` enforces the shared reader and forbids the retired presence/re-observation decisions.

## Fleet correlation (HOK-3509)

`shared/lib/fleet-incident-correlation.ts` owns the one cross-task correlation step. `correlateFleetFailures({facts, window, threshold})` groups recent per-attempt failure facts by cause key `(endpoint, faultClass)` and returns one correlation per key that reaches `threshold` distinct tasks inside `window`. `fleetCauseKey(fact)` is the only writer of that key. `buildFleetIncident(correlation)` emits the fleet record with `taskId: null`, root cause `fleet_shared_endpoint_failure` (or `remote_dependency_rate_limited` for a dependency endpoint) and the cause key, endpoint, endpoint evidence, raw fault class and `fleetFaultClass` under `metadata.fleet`. `coveredTaskCandidates(correlation, candidates)` drops the per-task candidates the fleet covers so the dashboard shows one row, not N plus one. `fleetCauseForAttempt({issueId, incidents, stage})` is the one reader a failure-row builder calls to shift attribution from the task to the endpoint — `classifyArmFault` routes `fleetCause.fleetFaultClass` through unless the kind is `cancelled`/`policy-denied`, and `buildArmReliabilityRecord` records the fingerprint and cause key on the row. The window and threshold come from `incidents.detection.{cooldownMinutes, dependencyThreshold}`; no new config keys. `reconcileIncidentCycle` runs correlation inside the one incident path when the caller supplies `failureSources` and `correlation`. `tools/check-incident-currentness.ts` forbids a private cause-key derivation (`\w*[Cc]auseKey\(`) and a hand-written fleet root-cause class outside the correlation module.

