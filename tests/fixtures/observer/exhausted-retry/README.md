# exhausted-retry fixture

Reproduces the HOK-2924 bounded-retry terminal state: `retry-exhausted-reason.txt`
is the literal content of a `.retry-<bucket>-exhausted` sentinel, and
`retry-head.txt` is the template for the paired `.retry-<bucket>-head` key
file (first line = the head SHA the retry budget was keyed to).

Materialize `.retry-failed-ready-recheck-exhausted` with this reason text at
an mtime older than `EXHAUSTED_RETRY_QUIET_MINUTES`, in a task feature
directory whose branch's last commit is *older* than the sentinel and whose
task-progress primitive shows no later activity, to reproduce REQ-F3:
`detectExhaustedRetries` reports a `high` finding whose title includes
"Exhausted retries: Failed to become ready after 3 attempts."

Give `.retry-<bucket>-head` a SHA that does not match the branch's current
tip to exercise the suppression path (HOK-3092 composite-key reset): the
budget is about to reset on its own, so the detector must not fire.
