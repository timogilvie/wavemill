# HOK-3406 planning-failure replay fixture

Replay evidence for the HOK-3406 incident (2026-11-16): Hokusai routed native
planning to `glm-5.3-flash` and four attempts failed — three rejected as
`missing_actionable_structure`, the fourth rejected as
`missing_release_readiness_database_change_risk` after using its whole turn
budget. Every attempt's `.planning-result.json` recorded `executedModel: null`
and `executionEvidence.status: "contradicted"`, so the failure never reached
Hokusai as model evidence (HOK-3498).

## Provenance

Reduced from the operator's incident capture
(`.wavemill/incidents/2026-11-16-HOK-3406-planning-unattributed/`):

- `ownership.jsonl` — the four `.session-ownership.jsonl` launch rows verbatim,
  with `cwd` rewritten to the redacted worktree path.
- `planning-HOK-3406.jsonl` — every `session_started` and `assistant_message`
  event from the transcript (`planning-HOK-3406.jsonl`), keeping the
  identity-bearing fields (`model`, `responseModel`, `responseId`, timestamps,
  session id) and dropping content, usage and tool events. `worktreePath` is
  redacted. All four attempts used `z-ai/glm-5.3-flash` on OpenRouter and every
  assistant turn carried a `responseId`.

The fixture is consumed by `shared/lib/executed-model-resolver.test.ts`
(`resolveStageExecutionTruth (HOK-3498)`), which asserts the resolver yields
`direct` / `provider-response` / `z-ai/glm-5.3-flash` and that
`classifyFailure` attributes the retryable `planning-artifact-invalid`
failure to the model.
