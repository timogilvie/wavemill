---
title: Incident replay fixtures
---

# Incident replay fixtures

`incident-fixture-converter.ts` / `incident-replay-harness.ts` / `incident-reconcile-cycle.ts` - Real-incident replay fixtures (HOK-3231): `tools/incident-to-fixture.ts` converts `.wavemill/incidents/<fingerprint>.evidence.jsonl` into sanitised fixtures under `tests/fixtures/incident-replay/real/` (one per `rootCauseClass`, min 15). Fixtures declare their failure as **data** (`failure: {stage, failureKind?, detail, survivesRelaunches: number | "never"}`), replacing the retired `faultModelFor` switch. Each fixture replays through the real `IncidentStore` cycle (the Observer's `reconcileIncidents` body was extracted into `reconcileIncidentCycle`) and, for stage-failure chains, through `runWithRecoveryLoop`. **A PR that fixes an incident recorded in `.wavemill/incidents/` must include that incident's evidence as a replay fixture**; the rule lives in `tools/prompts/coding-phase.md` and both review prompts.
