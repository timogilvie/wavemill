# stuck-candidate fixture

`ready-result.json` is a template for `.ready-result.json` with
`artifacts.queueState === "merge-candidate"`. Materialize it with
`CANDIDATE_PROMOTED_AT` / `CANDIDATE_LAST_PROGRESS_AT` set to ~20 minutes ago
(older than `CANDIDATE_STUCK_MINUTES`) and a `.wavemill-config.json` with no
active merge consumer (`integration.enabled: false`, or `useMillSession:
false`) to reproduce REQ-F1: `detectStuckMergeCandidates` reports a `high`
finding.

Set `CANDIDATE_PROMOTED_AT` to a fresh distinct value across repeated
`buildFindings()` calls against the same repo directory to reproduce REQ-F2
(promote/demote churn): three distinct values within
`CANDIDATE_CHURN_WINDOW_MINUTES` on the same `HEAD_SHA` trip the churn
finding via the observer's own `.wavemill/observer-candidate-churn.json`
journal.

`merge-queue-transitions.json` is a template for the monitor's HOK-3111
`<repoDir>/.wavemill/merge-queue-transitions.json` journal, keyed
`${PR}:${HEAD_SHA}`. With `ESCALATED=true` it reproduces the HOK-3240 durable
churn gate: the churn finding fires even when fewer than three promotions fall
inside the observer's 30-minute window (the mill's real 16-21 min
promote/demote cadence).
