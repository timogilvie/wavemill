# Mill-owned paths

Each path Wavemill writes inside a task worktree is declared once in
`shared/lib/mill-owned-paths.ts` with its evidence, telemetry, or runtime
disposition. Dirty-status readers, monitor scope checks, cleanup discard, and
the generated `.gitignore` section use the generated Bash/TypeScript contract.
Unknown paths remain task work; tracked changes are never hidden by the
inventory. Telemetry writers resolve the main milled repository.

Evidence is archive-then-discard. Terminal cleanup captures untracked evidence
through `archiveTaskEvidence` (the `taskEvidenceNames` inventory) and discards a
file only while its bytes match a hash that capture verified (`--release-list`).
An archive failure discards nothing and retains the worktree; bytes written or
never captured after the archive stay on disk. Live tasks never reach discard.

Guard: `tools/check-mill-owned-paths.ts` (run by preflight). Update generated
files with `npx tsx tools/check-mill-owned-paths.ts --write`.
