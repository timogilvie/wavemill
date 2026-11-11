---
title: Output reservation
---

# Output reservation

`model-adapters/transport-adapter.ts` — `AdapterLimits.reservedOutputTokens` is context space for input preflight, distinct from the explicit invocation cap `AdapterInvokeOptions.maxOutputTokens`. CLI review uses the adapter's model-aware output contract; it never imports the native concise-JSON ceiling or forwards a reservation as a cap. `AdapterInvokeResult` carries a validated `structuredReport` and `structuredReportError` for the claude CLI `ReportFindings` tool report (HOK-3448). Enforced by `tools/check-output-reservation.ts`.
