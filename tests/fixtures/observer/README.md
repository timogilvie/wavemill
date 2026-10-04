# Observer regression fixtures (HOK-3096)

Each subdirectory is a regression fixture for one state-based observer
detector added in HOK-3096. Timestamps and git history cannot be checked
into static files, so these directories hold *templates* — JSON/text files
with `{{VAR}}` placeholders — that `tools/observer.test.ts` materializes into
a fresh temp directory per test via `materializeObserverFixture()` /
`renderFixtureTemplate()`, substituting real timestamps (and, for
`stale-base`, a real git repository) at test time.

- `stuck-candidate/` — a task parked in `queueState: "merge-candidate"`.
  Used by Detector 1 (`detectStuckMergeCandidates`, REQ-F1/REQ-F2).
- `exhausted-retry/` — a `.retry-<bucket>-exhausted` sentinel and its
  `.retry-<bucket>-head` key file (HOK-2924). Used by Detector 2
  (`detectExhaustedRetries`, REQ-F3).
- `stale-base/` — documents the git topology `tools/observer.test.ts`
  constructs in code (a task branch left behind after its base branch
  advances). Used by Detector 3 (`detectBranchBehindBase`, REQ-F4/REQ-F5).
- `healthy/` — a normally progressing task: `queueState: "ready"`, no retry
  sentinels, branch at parity with its base. Used as the REQ-F7
  no-false-positive regression across all three detectors.
