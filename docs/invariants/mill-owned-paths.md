# Mill-owned paths

Each path Wavemill writes inside a task worktree is declared once in
`shared/lib/mill-owned-paths.ts` with its evidence, telemetry, or runtime
disposition. Dirty-status readers, monitor scope checks, cleanup discard, and
the generated `.gitignore` section use the generated Bash/TypeScript contract.
Unknown paths remain task work; tracked changes are never hidden by the
inventory. Telemetry writers resolve the main milled repository.

Guard: `tools/check-mill-owned-paths.ts` (run by preflight). Update generated
files with `npx tsx tools/check-mill-owned-paths.ts --write`.
