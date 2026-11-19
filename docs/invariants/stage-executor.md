# Stage executor (HOK-3511)

**Rule.** "Which agent and provider run this model?" is answered in exactly one
place: `resolveStageExecutor` in `shared/lib/model-agent-resolution.ts`, which
maps (model, stage, effective registry) to `{agent, provider}`. The provider is
a function of the resolved agent (`providerForAgent`), never a second model
lookup. Every writer of a `.phase-config.json` stage block goes through
`writePersistedContract` in `shared/lib/execution-contract.ts` (shell:
`phase_config_write_stages` → `tools/recovery-contract.ts write`), which takes
models only and derives the executor itself. Recovery
(`readValidatedContract`) re-derives the agent and provider from the persisted
model with the same resolver and registry the launcher uses; it validates only
that the model can launch for the stage, and never compares a stored agent
against the resolver.

**Never:**

- map a model or an agent to a provider outside the resolver (a literal
  `claude → anthropic` table, a `` `native-${...}` `` provider label, a shell
  `case` arm);
- write a `.phase-config.json` stage block's `model`, `agent` or `provider`
  outside `writePersistedContract` (no raw `jq > tmp && mv`, no private
  `mutateJsonState` / `state_mutate` on the file);
- persist an agent carried from a challenge intent, a sealed route, an arm
  record, an operator flag, or an earlier version of the file;
- trust or validate a *stored* agent at recovery time.

**Why.** HOK-3500 (2026-11-17): routing first chose `claude-opus-5-5` (agent
claude) as the coder; the expanded route chose `kimi-k2.7-code`. The reseal
wrote the new model with the *carried* sealed agent, so `.phase-config.json`
recorded `coding: {model: kimi-k2.7-code, agent: claude}`. The first launch
worked (the launcher derives from the model); the retry did not (recovery
validated the persisted agent: `agent_unsupported_for_model`). The mill made
no relaunch, logged nothing, and raised no inbox item for two hours. With one
resolver, one writer, and re-deriving recovery, that mismatch class is
unrepresentable — including for files written before this change.

**Guard.** `tools/check-stage-executor.ts` (spec:
`shared/lib/stage-executor-guard.ts`), in `test:preflight`. Allowlist:
`tools/stage-executor-allowlist.txt` (ratcheting). Suppress one line with
`// allow-stage-executor: <reason>` (`#` in shell).

**Replay.** `shared/lib/stage-executor-replay.test.ts` replays the HOK-3500
evidence (`tests/fixtures/incident-replay/hok-3500-route-agent-mismatch/`):
the incident's own phase-config — stale `claude`/`anthropic` beside
`kimi-k2.7-code` — must validate and return the derived `native-openrouter`
executor.

**Owners.** Resolver: `shared/lib/model-agent-resolution.ts`. Writer:
`shared/lib/execution-contract.ts`. Shell seam: `phase_config_write_stages`
(`shared/lib/wavemill-common.sh`). See also `docs/routing-contract.md`
(Rules), `docs/invariants/stage-launchability.md`,
`docs/invariants/route-override-record.md`.
