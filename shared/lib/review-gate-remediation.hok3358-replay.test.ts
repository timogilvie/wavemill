/**
 * HOK-3358 replay: review-scope silent stall (HOK-3457).
 *
 * Pre-HOK-3457 the review scope guard refused the diff, the prompt told the
 * agent to "stop review-fix committing" without writing any typed finding,
 * and the monitor's failure classifier never saw the scope stop. The task
 * parked until an operator intervened.
 *
 * Post-HOK-3457 `tools/check-review-scope.ts` writes a typed
 * `.review-scope-stop.json` marker through `writeMarker` before the agent
 * exits. The fixture here is the marker shape the real HOK-3358 incident
 * would have produced; the oracle is the agent-delivered `code-failure`
 * decision that routes the task back to coding without an operator touch.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  decideReviewGateRemediation,
  type ReviewGateEvidence,
  type ReviewGateFinding,
} from './review-gate-remediation.ts';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tests',
  'fixtures',
  'incident-replay',
  'real',
  'hok3358-scope-stall',
);

interface ScopeStopMarker {
  schemaVersion: number;
  kind: 'review-scope-stop';
  headSha: string;
  reason: string;
  detail: {
    findings: ReviewGateFinding[];
    offendingPaths: string[];
  };
}

interface ExpectedDecision {
  disposition: 'code-failure' | 'retryable' | 'terminal';
  deliverTo: 'agent' | 'operator' | 'infra-recovery';
  deliveryPayload?: { finding: ReviewGateFinding };
}

test('HOK-3358 replay: scope-stop marker produces a code-failure routed back to coding', () => {
  const marker: ScopeStopMarker = JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'scope-stop-marker.json'), 'utf-8'),
  );
  const expected: ExpectedDecision = JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'expected-decision.json'), 'utf-8'),
  );

  const evidence: ReviewGateEvidence = {
    stage: 'review',
    stateDir: '/tmp/hok3358-replay',
    headSha: marker.headSha,
    findings: marker.detail.findings,
    artifact: { kind: 'review-result', identity: 'hok3358-replay' },
  };

  const decision = decideReviewGateRemediation(evidence);

  // The oracle: agent-delivered code-failure, never the pre-HOK-3457 terminal
  // disposition that silently parked the task.
  assert.strictEqual(decision.disposition, expected.disposition);
  assert.strictEqual(decision.deliverTo, expected.deliverTo);
  assert.deepStrictEqual(decision.deliveryPayload, expected.deliveryPayload);
  assert.notStrictEqual(decision.disposition, 'terminal');
  assert.notStrictEqual(decision.deliverTo, 'operator');
});
