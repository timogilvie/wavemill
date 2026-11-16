# Native provider execution evidence

HOK-3495 starts by retaining observed OpenRouter generation metadata alongside the SDK cost report. `nativeProviderExecutions` on a local eval record contains one observation per owned native response, including responses from failed stages. It does not certify or select a host.

Each observation keeps the runtime session reference, recorded ownership attempt IDs, response ID, transport, requested model from the session-start event, response model from the assistant event, and generation metadata returned by the existing OpenRouter lookup. A historical reused session can have several ownership attempts; the record lists them without inventing a per-attempt allocation. Missing transcript evidence is null. Owned-session scans and retention discover native candidates independently of issue-name hints, then select the exact recorded session IDs. A canonical Linear ID must not filter out its owned challenger session, and a sibling's unowned session must never contribute.

`generation.providerName` is the observed upstream display name. Neither the model slug's vendor prefix nor the `openrouter` transport establishes that host. Display names also do not prove a regional endpoint, service tier, deployment revision, or quantization. Those facts remain unverified until an upstream contract supplies them.

`generation.totalCostUsd` is a billed charge, including a genuine billed zero. Missing billing is null, even when provider metadata is available. The same metadata lookup feeds `@hokusai/costs`; when no charge is available, the SDK retains its existing estimate and coverage behavior. Wavemill does not add another cost reducer. Repeated/archived response copies are deduplicated through the same session observation projection for both cost and evidence.

Lookup remains best effort and asynchronous to model execution. A failed lookup cannot fail an otherwise completed task. Reattaching incomplete evidence to an eval preserves previously known host/model/charge facts. Historical eval records remain readable without this field.

## Remaining HOK-3495 work

This local evidence patch is the first reviewable part of the issue. It does not satisfy the canonical Hokusai export/ingestion acceptance criteria yet:

- Adopt HOK-3447's final lossless launch-history/metering seam and consume HOK-3476 lineage when present, without duplicating either migration.
- Capture the requested endpoint restriction and rate snapshot at request time, distinct from observed host evidence.
- Extend the owning `@hokusai/core` contribution contract, Wavemill projection, and canonical ingestion together. The installed contribution schema currently accepts only stage/model/harness/task-cost facts, so endpoint fields must not be added privately to Wavemill's re-export shim or sent to an incompatible consumer.
- Preserve the same facts for every terminal/forfeited attempt and retain correct model/provider/harness fault attribution, including failures excluded from model-quality training.
- Keep actual endpoint charges authoritative through canonical ingestion and make endpoint estimate trust explicit. Preserve linkage to the original routing decision.

Production routing restrictions remain governed by the existing registry/certification contract. Endpoint qualification and provider selection belong to HOK-3496 and HOK-3497.
