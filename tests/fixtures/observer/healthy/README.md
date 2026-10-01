# healthy fixture

`ready-result.json` is a template for a normal `queueState: "ready"` task
(never promoted to `merge-candidate`). Paired in `tools/observer.test.ts`
with a git repo whose branch is at parity with its base and a feature
directory with no `.retry-*-exhausted` sentinels, to reproduce REQ-F7: none
of the three new detectors report a finding.
