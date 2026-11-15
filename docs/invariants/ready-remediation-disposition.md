---
title: Ready remediation disposition
---

# Ready remediation disposition

`ready-remediation-disposition.ts` `evaluateReadyRemediationDisposition()` / `ready_remediation_disposition` (`wavemill-monitor.sh`) - The one Ready remediation in-flight/completion decision (HOK-3322), shared by the monitor (through `tools/ready-remediation-disposition.ts`) and the ready-watchdog snapshot. It decides through the HOK-3386 stage-agent disposition (`decideStageAgentDisposition`, sub-stage `ready-remediation` / `conflict-resolution`), so the remediation agent's own session transcript is agent evidence; this module only reads Ready's launch identity and keeps a parked-at-prompt agent in flight. A running `.ready-result.json` and a launch head equal to HEAD are facts about the launch, never liveness: launch identity is read once (`readReadyRemediationLaunch`: the conflict resolver's `.conflict-remediation.json`, else the `ready-remediation` bucket head; launch time from the session-ownership row), and liveness only from the HOK-3101 primitive (`gatherReadyTaskProgress`). The result is `inactive` | `advanced` (head moved: condition expiry + pending re-check) | `in-flight` (the agent's own live record after launch, a blocking prompt, background work, or no evidence yet — hold) | `settled` (idle/errored after launch, exited, or stalled — the controller re-runs its own Ready check, which publishes the handoff only on green current-head checks and otherwise charges the existing `ready-remediation` bucket). It never synthesizes success and adds no marker, bucket or terminal cause. Replay: `tests/journeys/ready-remediation-same-head.journey.sh`. **Never decide "remediation in flight" from running + same head or pane activity — read the disposition.** Enforced by `tools/check-ready-remediation-disposition.ts` (launch-head equality, `remediationPaneActive`, retired `ready_remediation_launch_head` / `conflict_remediation_in_flight`, private launch-identity reads).

After gathering liveness, the shared stage-agent disposition re-reads both
completion markers and the schema-validated JSON stage result. Review can
publish terminal JSON without a marker. A pre-probe running snapshot must
never overwrite a completed result as interrupted. The synchronous recheck
uses the same parser and schema validation as `readStageResult`.
