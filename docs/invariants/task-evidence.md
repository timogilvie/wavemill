# Task evidence survives cleanup

`taskEvidenceNames` in `shared/lib/task-artifact-lookup.ts` is the artifact
inventory. `discoverOwnedSessionEvidence` in `session-adapters.ts` selects
transcripts from the existing ownership record and shared discovery roots.
Never infer ownership by recursively searching arbitrary JSON strings for paths,
or maintain a shell stage whitelist alongside the typed inventory.

`archiveTaskEvidence` captures this inventory into the existing per-issue eval
archive before completed or aborted cleanup releases resources. Preserve Ready
results, failed sidecars, ownership and operator/outcome facts. An earlier head
publication is not Ready completion. Invalid JSON is retained as invalid evidence;
readers still validate results. Missing, unresolved and foreign-cwd sessions are
explicit gaps, never fabricated labels. A read, decode or copy failure must fail
cleanup and retain its resources.

The archive manifest publishes last. Transcript copies have SHA-256 and byte
counts; discovery exposes only verified in-archive JSONL. Compressed Codex bytes
are retained alongside decoded JSONL for the SDK. Usage/pricing, executed identity
and intervention classification remain owned by their existing primitives.
Optional current artifacts absent from a new capture cannot leave an older
canonical result masquerading as current: old bytes move to stale history.

Storage stays in the existing per-issue eval artifact directory (the default is
`.wavemill/evals/artifacts/<issue>`). Reaping a task does not delete that archive;
there is currently no automatic artifact TTL. This change adds no retention
scheduler or separate Stall Risk store. Removing an issue archive removes its
retained evidence too. Size is the sum of selected transcript bytes and artifact
bytes; compressed rollouts also retain one decoded copy. Content hashes reuse
identical captures, but changed session snapshots remain until archive removal.
The manifest records each file's byte count for footprint inspection. Already missing bytes remain missing. Full launch
lineage and ownership dedup semantics belong to HOK-3447/HOK-3476.

Guard: `tools/check-task-evidence.ts`, wired into `npm run test:preflight`.
Replay: `task-evidence-archive.test.ts` and the happy-path golden journey remove
original sources and verify retained SDK cost, model identity and intervention facts.
