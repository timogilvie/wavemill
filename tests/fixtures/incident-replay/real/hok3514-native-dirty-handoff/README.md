# HOK-3514: native coder parked on a command-created file

Sanitised evidence for two `arm_parked_awaiting_operator_commit` incidents
(2026-11-11). Issue ids, slugs and paths are rewritten; the incident
fingerprints are kept as provenance. The class's generic incident-store
fixture is `../arm_parked_awaiting_operator_commit.json`; these files replay
the native tool sequence that produced the park, which that fixture cannot.

## Shape

The native kimi-k2.7-code coder created a file through `run_tests` (`cp`).
The intended-file tracker recorded only patch/artifact writes, so `git_add`
refused the file as not intended. Dirty-handoff recovery allowed only
`git checkout` / `git restore` (neither removes an untracked file) and `rm`
was classified dangerous. The coder wrote `.coding-complete` on the dirty
tree, `create_marker` accepted it, and the arm parked at needs-user until an
operator committed (HOK-3454) or deleted (HOK-3451) the file.

## Files

- `hok-3454-commit.json`: the fixture file copied into `tests/fixtures/` that
  belonged to the task; the remedy is commit.
- `hok-3451-discard.json`: a scratch test copied into `shared/lib/` (not root
  scratch, so the monitor's quarantine never moved it); the remedy is discard.

## Oracle

`shared/lib/native-agent/hok3514-dirty-handoff-replay.test.ts` replays the
steps through the real native tools and the launcher's command-provenance
hook. In the first session, `.coding-complete` must be refused while the path
is dirty. The remedy (`git_add` + `git_commit`, or `discard_owned_path`) must
succeed, and the marker must then be accepted on a clean tree, with no
recovery relaunch. On the base, the marker is accepted dirty and the remedy is
refused, so both fixtures fail.
