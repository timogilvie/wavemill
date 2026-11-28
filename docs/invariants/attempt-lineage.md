# Attempt lineage

Construct SDK task-attempt references only through `projectTaskAttemptRef` in
`shared/lib/attempt-identity.ts` or its shell twin. A missing SDK run ID means
unknown lineage; do not derive a new identity from timestamps, heads or legacy
IDs. A stage launch mints a fresh stage attempt ID and its result and eval
reuse that identity. Guard: `tools/check-attempt-lineage.ts`.
