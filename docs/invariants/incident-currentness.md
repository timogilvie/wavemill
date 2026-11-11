---
title: Current incident disposition
---

# Current incident disposition

`shared/lib/incident-filing-reconciler.ts` owns read-only job currentness.
`readAuthoritativeWorkflowJobs(repoDir)` reads persisted workflow jobs and job artifacts once, preserving contradictory-source diagnostics.
`reconcileIncidentForFiling(incident, repoDir, jobs?)` returns `confirmed_active`, `recovered`, `superseded`, or `needs_inspection`.
Detection, Observer reconciliation/dashboard projection, live/shadow filing and retry draining consume that decision. Recovery requires validated result content and authoritative same-task/side/pair/PR retry timestamps; file presence is never sufficient. Missing or contradictory lineage remains visible for inspection. This API never polls jobs, spends retry budgets or changes task state.
`tools/check-incident-currentness.ts` enforces the shared reader and forbids the retired presence/re-observation decisions.

