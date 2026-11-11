---
title: Review result
---

# Review result

`model-adapters/claude-cli-output.ts` — **One review result (HOK-3448):** the only interpreter of Claude CLI stdout and the only place that extracts or validates a `ReportFindings` tool report. `review-engine.ts` consumes `AdapterInvokeResult.structuredReport` / `structuredReportError`; it never decides review completion from text shape. Enforced by `tools/check-review-report-boundary.ts`.
