// allow-session-ownership: this file *is* the session-ownership guard; its
// pattern table names every forbidden shape. It is auto-excluded from its own
// scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the session-ownership invariant (HOK-3328).
 *
 * "Which sessions belong to this task, under which stage, and what do they
 * cost together?" has exactly one answer: the launch rows in
 * `.session-ownership.jsonl` (`shared/lib/session-ownership.ts` and its shell
 * twin), measured by `@hokusai/costs` (`sdk-task-cost/meter.ts`). This guard
 * fails on the shapes that used to answer it a second way:
 *
 * 1. Building a session's `stageRole` anywhere but `ownershipStageRole`
 *    (`stage-role-construction`), or emitting the retired `timestamp_window`
 *    stage tier (`timestamp-window-tier`).
 * 2. Comparing session/turn timestamps against a stage window, or reviving
 *    the window machinery (`session-window-overlap`).
 * 3. Selecting one harness's summary as a task's cost, or adding summaries'
 *    totals up in Wavemill (`single-harness-pick`, `summary-total-sum`).
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const SESSION_OWNERSHIP_GUARD: GuardSpec = {
  name: 'session-ownership',
  findingNoun: 'session-ownership violation(s)',
  suppressionMarker: 'allow-session-ownership',
  allowlistFile: 'tools/session-ownership-allowlist.txt',
  invariantPaths: [
    'shared/lib/session-ownership.ts',
    'shared/lib/session-ownership.sh',
    'shared/lib/session-ownership-guard.ts',
  ],
  patterns: [
    {
      name: 'stage-role-construction',
      description: 'session stageRole built outside session-ownership.ts — read it with ownershipStageRole(row)',
      lang: 'ts',
      re: /\bstageRole\s*(?::|=(?!=))\s*\{/,
    },
    {
      name: 'timestamp-window-tier',
      description: 'retired timestamp_window stage attribution (HOK-3328) — the launch row names the stage',
      lang: 'ts',
      re: /\bconfidence\s*:\s*['"]timestamp_window['"]/,
    },
    {
      name: 'session-window-overlap',
      description: 'session timestamps compared against a stage window (HOK-3328) — read the stage from the ownership row',
      lang: 'ts',
      re: /\b(?:attributeStage|buildStageWindows|StageWindow|stageWindows?)\b|[<>]=?\s*window\.(?:startedAt|finishedAt)\b|\bwindow\.(?:startedAt|finishedAt)\s*[<>]|\btimestampMs\s*[<>]=?\s*window\w*|\bstage\w*\.(?:startedAt|finishedAt)\b[^;]*[<>]=?\s*\w*(?:session|turn)|\b(?:session|turn)\w*\.(?:startedAt|endedAt|timestamp)\w*\b[^;]*[<>]=?[^;]*\bstage\w*\.(?:startedAt|finishedAt)\b/,
    },
    {
      name: 'single-harness-pick',
      description: "one harness's summary chosen as the task cost (HOK-3328) — workflowCost is the @hokusai/costs totalUsd",
      lang: 'ts',
      re: /\b(?:selectPrimaryTaskCostSummary|HARNESS_ORDER|AGENT_TYPE_HARNESS)\b|\.find\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.harness\s*===/,
    },
    {
      name: 'summary-total-sum',
      description: 'task-cost summaries added up in Wavemill (HOK-3328) — the SDK report combines harnesses',
      lang: 'ts',
      re: /\.reduce\([^;]*\btotal_cost_usd\b|\btotal_cost_usd\b[^;]*\+\s*\w+\.total_cost_usd\b/,
    },
  ],
  remediation: [
    'Session ownership is written once, at launch: appendOwnershipRow()/recordLaunch() in',
    'shared/lib/session-ownership.ts (session_ownership_append in session-ownership.sh).',
    'Stage labels read ownershipStageRole(row); the executed model reads the rows for its',
    'stage; cost is meterWorkflowCost() in shared/lib/sdk-task-cost/meter.ts, i.e. the',
    '@hokusai/costs report over the owned session ids (HOK-3328).',
  ],
};
