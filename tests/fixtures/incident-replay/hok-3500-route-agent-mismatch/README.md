# HOK-3500 route-agent mismatch — replay fixture (HOK-3511)

Provenance: `.wavemill/incidents/2026-11-17-HOK-3500-route-agent-mismatch/`
(operator checkout), sanitised — absolute paths and the operator's user name
stripped; `recovery-contract-validate.json` and `mill-log.txt` are verbatim
evidence; `challenge-intent.json` was regenerated with the production builder
(`tests/fixtures/build-challenge-intent.ts`) to the sealed route the mill log
records (planner challenge, primary coder `claude-opus-5-5`, agent carried as
`claude`); `phase-config.json` reconstructs the incident file from the
contract echoed in the validator output.

The incident: the expanded route moved the primary coder from
`claude-opus-5-5` to `kimi-k2.7-code`, the reseal persisted the new model
with the *carried* `claude`/`anthropic` executor, the coding retry was then
refused with `agent_unsupported_for_model`, and the mill stalled silently for
two hours.

Consumed by `shared/lib/stage-executor-replay.test.ts`: enrichment must carry
models only, the one writer must persist the derived `native-openrouter`
executor, and the incident's own `phase-config.json` — stale executor and all
— must now validate with the derived agent.
