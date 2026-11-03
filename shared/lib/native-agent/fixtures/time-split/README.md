# Native stage time-split fixtures

## `hok-3374-attempt-2`

**Provenance:** sanitized replay transcription of the HOK-3374 attempt-2
native coding session, recorded 2026-11-01.  The source evidence is the
incident's `coding-HOK-3374.jsonl` session stream and its coding-failure
handoff/decision records; this fixture retains only the timestamped transcript
facts required to derive the time split.  It is an incident replay fixture,
not hand-authored scenario data.

The production capture is deliberately not copied wholesale: its absolute
paths, task identifiers, prompts, and tool payloads are removed.  The adjacent
JSON handoff and decision files preserve the expected budget-exhaustion output.
Synthetic cases remain inline in `stage-time-split.test.ts` and are labelled
there as synthetic event builders.
