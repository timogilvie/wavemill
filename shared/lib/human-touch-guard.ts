/**
 * HOK-3455 — preflight guard enforcing one classifier for operator touches.
 *
 * Built on `tools/lib/source-guard.ts`; the invariant lives in CLAUDE.md.
 */

import type { GuardSpec } from '../tools/lib/source-guard.ts';

export const HUMAN_TOUCH_GUARD: GuardSpec = {
  name: 'human-touch',
  findingNoun: 'secondary human-touch filter(s)',
  suppressionMarker: 'allow-human-touch',
  allowlistFile: 'tools/human-touch-allowlist.txt',
  invariantPaths: [
    'shared/lib/operator-intervention.ts',
    'shared/lib/human-touch-guard.ts',
    'tools/check-human-touch.ts',
    'tools/human-touch-allowlist.txt',
  ],
  patterns: [
    {
      name: 'retired-non-operator-eval-detectors',
      description: 'NON_OPERATOR_EVAL_DETECTORS is retired; route touch classification through shared/lib/operator-intervention.ts',
      lang: 'ts',
      re: /\bNON_OPERATOR_EVAL_DETECTORS\b/,
    },
    {
      name: 'retired-workflow-automation-patterns',
      description: 'WORKFLOW_AUTOMATION_PATTERNS is retired; route automation detection through shared/lib/operator-intervention.ts',
      lang: 'ts',
      re: /\bWORKFLOW_AUTOMATION_PATTERNS\b/,
    },
    {
      name: 'retired-is-workflow-automation-message',
      description: 'isWorkflowAutomationMessage is retired; route automation detection through shared/lib/operator-intervention.ts',
      lang: 'ts',
      re: /\bisWorkflowAutomationMessage\b/,
    },
    {
      name: 'private-automation-regex',
      description: 'regex over known automated text must live in the classifier in shared/lib/operator-intervention.ts',
      lang: 'ts',
      re: /Output token limit|This session is being continued|\^You are working on|local-command-caveat|task-notification|Issue Writer|ready-check failure|Your last response was cut off/,
      excludePaths: ['shared/lib/operator-intervention.ts'],
    },
    {
      name: 'private-touch-classifier-table',
      description: 'secondary (NON_OPERATOR|AUTOMATION|HUMAN)_* pattern tables are forbidden; use classifyOperatorTouch',
      lang: 'ts',
      re: /\b(?:NON_OPERATOR|AUTOMATION|HUMAN)_[A-Z_]+\b/,
      excludePaths: ['shared/lib/operator-intervention.ts'],
    },
    {
      name: 'private-provenance-person-check',
      description: 'reading isMeta, isCompactSummary, promptSource or origin.kind to judge a person must use classifyOperatorTouch',
      lang: 'ts',
      re: /\b(isMeta|isCompactSummary|promptSource|origin(?:\?.|\.)kind)\b/,
      excludePaths: ['shared/lib/operator-intervention.ts'],
    },
  ],
  remediation: [
    'All operator-touch classification must go through shared/lib/operator-intervention.ts classifyOperatorTouch.',
    'Session transcript provenance belongs in the one transcript reader used by the classifier.',
  ],
};