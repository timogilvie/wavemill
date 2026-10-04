# HOK-2081 fixture

A minimal hermetic session used by the P3 replay / counterfactual pipeline
tests. The fixture is **not** a full checkpoint on disk — the checkpoint
format is versioned and includes a manifest hash that would go stale on
schema changes. Instead, this fixture ships the raw inputs that
`createCheckpoint` accepts (see `session-checkpoint.ts`) so tests can materialize
a fresh checkpoint in a temporary directory each run.

Shape:

- `session.json` — a `CreateCheckpointInput` in JSON. Contains a 2-event
  event stream, a 1-file working tree, a 2-tool menu, and a deterministic
  outcome.

Consumers (unit tests, manual smoke): read `session.json`, pass through to
`createCheckpoint({ ..., repoDir: <tmpDir> })`, then run the replay / runner /
CLI paths against the resulting checkpoint root.

No secrets. No network. No non-hermetic labels.
