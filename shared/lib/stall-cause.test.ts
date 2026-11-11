import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateStallCauses,
  aggregateStallGates,
  deriveGateTimeline,
  deriveStallCause,
  deriveStallGate,
  type CauseSpan,
  type GateEvidence,
} from './stall-cause.ts';

// protects: the gate timeline names the gate that held a task from the same
// records the report reads, and the coarse cause never disagrees with it.
describe('stall-cause gate timeline', () => {
  const T = Date.parse('2026-11-05T18:00:00Z');
  const at = (minutes: number) => T + minutes * 60_000;

  const gateAt = (evidence: GateEvidence, endMinutes: number, minutes: number) => {
    const spans = deriveGateTimeline(evidence, { endMs: at(endMinutes) });
    return spans.find((span) => span.fromMs <= at(minutes) && span.toMs > at(minutes));
  };

  it('names plan-approval after the planning agent parks for a human', () => {
    // protects: a planning window whose agent went idle/waiting is a human
    // approval wait, not planning-agent time.
    const evidence: GateEvidence = {
      launches: [{ kind: 'planning', stage: 'planning', atMs: at(0) }],
      stageResults: [{ stage: 'planning', status: 'completed', startedAtMs: at(0), finishedAtMs: at(60) }],
      agentRecords: [
        { atMs: at(30), state: 'idle' },
        { atMs: at(35), state: 'waiting' },
      ],
      planApprovalMs: at(60),
    };
    assert.equal(gateAt(evidence, 120, 10)?.gate, 'planning-agent');
    const approval = gateAt(evidence, 120, 45);
    assert.equal(approval?.gate, 'plan-approval');
    assert.equal(approval?.stage, 'planning');
    assert.equal(approval?.detail, 'plan approval');
    const decision = deriveStallGate({ fromMs: at(40), toMs: at(50) }, deriveGateTimeline(evidence, { endMs: at(120) }));
    assert.equal(decision.gate, 'plan-approval');
    assert.equal(decision.cause, 'operator-attention');
  });

  it('names review-park for a running not_ready or error result after the reviewer stops', () => {
    // protects: a reviewer that recorded a non-passing verdict but never
    // completed is parked waiting for a person, not actively reviewing.
    for (const verdict of ['not_ready', 'error']) {
      const evidence: GateEvidence = {
        launches: [{ kind: 'review', stage: 'review', atMs: at(0) }],
        stageResults: [{ stage: 'review', status: 'running', startedAtMs: at(0), finishedAtMs: null, verdict }],
        agentRecords: [{ atMs: at(10), state: 'working' }],
        helperLaunches: [{ atMs: at(20) }],
      };
      assert.equal(gateAt(evidence, 120, 5)?.gate, 'review-agent');
      const parked = gateAt(evidence, 120, 60);
      assert.equal(parked?.gate, 'review-park');
      assert.equal(parked?.stage, 'review');
      const decision = deriveStallGate({ fromMs: at(30), toMs: at(90) }, deriveGateTimeline(evidence, { endMs: at(120) }));
      assert.equal(decision.gate, 'review-park');
      assert.equal(decision.cause, 'stage-agent');
    }
  });

  it('keeps review-agent for a completed passing review', () => {
    // protects: only a parked result becomes review-park.
    const evidence: GateEvidence = {
      launches: [{ kind: 'review', stage: 'review', atMs: at(0) }],
      stageResults: [{ stage: 'review', status: 'completed', startedAtMs: at(0), finishedAtMs: at(60), verdict: 'ready' }],
    };
    assert.equal(gateAt(evidence, 120, 30)?.gate, 'review-agent');
    assert.equal(gateAt(evidence, 120, 90)?.gate, 'unknown');
  });

  it('names operator-attention when a Ready remediation agent is waiting, ready-remediation when it is not', () => {
    // protects: a remediation that parked at a prompt is operator attention;
    // an idle remediation agent is Ready remediation work.
    const waiting: GateEvidence = {
      launches: [{ kind: 'ready-remediation', atMs: at(0) }],
      agentRecords: [{ atMs: at(1), state: 'waiting' }],
    };
    const waitingDecision = deriveStallGate({ fromMs: at(30), toMs: at(90) }, deriveGateTimeline(waiting, { endMs: at(120) }));
    assert.equal(waitingDecision.gate, 'operator-attention');
    assert.equal(waitingDecision.stage, 'ready');

    const idle: GateEvidence = {
      launches: [{ kind: 'ready-remediation', atMs: at(0) }],
      agentRecords: [{ atMs: at(1), state: 'idle' }],
    };
    const idleDecision = deriveStallGate({ fromMs: at(30), toMs: at(90) }, deriveGateTimeline(idle, { endMs: at(120) }));
    assert.equal(idleDecision.gate, 'ready-remediation');
    assert.equal(idleDecision.stage, 'ready');
  });

  it('names ready-checks between review completion and Ready completion', () => {
    // protects: the post-review wait is Ready checks, not review time.
    const evidence: GateEvidence = {
      launches: [{ kind: 'review', stage: 'review', atMs: at(0) }],
      stageResults: [{ stage: 'review', status: 'completed', startedAtMs: at(0), finishedAtMs: at(30), verdict: 'ready' }],
      reviewCompleteMs: at(30),
      readyCompleteMs: at(90),
    };
    const span = gateAt(evidence, 120, 60);
    assert.equal(span?.gate, 'ready-checks');
    assert.equal(span?.stage, 'ready');
    const decision = deriveStallGate({ fromMs: at(45), toMs: at(80) }, deriveGateTimeline(evidence, { endMs: at(120) }));
    assert.equal(decision.gate, 'ready-checks');
    assert.equal(decision.cause, 'ci');
  });

  it('lets the merge lane win over stage windows it overlaps', () => {
    // protects: once tend owns the PR, the merge lane is the gate.
    const evidence: GateEvidence = {
      stageResults: [{ stage: 'review', status: 'completed', startedAtMs: at(0), finishedAtMs: at(120), verdict: 'ready' }],
      laneEnteredMs: at(0),
      mergedMs: at(120),
    };
    const spans = deriveGateTimeline(evidence, { endMs: at(120) });
    assert.ok(spans.length > 0);
    for (const span of spans) assert.equal(span.gate, 'merge-lane');
  });

  it('lists the missing records on unknown spans', () => {
    // protects: an unattributable gap says which record was absent.
    const missing = ['no .review-result.json', 'no tend lane receipt (.wavemill/merge-lane/1807/progress.json)'];
    const evidence: GateEvidence = {
      launches: [{ kind: 'planning', stage: 'planning', atMs: at(0) }],
      planApprovalMs: at(30),
      missingRecords: missing,
    };
    const spans = deriveGateTimeline(evidence, { endMs: at(120) });
    const unknown = spans.find((span) => span.gate === 'unknown');
    assert.ok(unknown);
    assert.deepEqual(unknown.missing, missing);
    assert.ok(spans.filter((span) => span.gate === 'planning-agent').every((span) => span.missing === undefined));
  });

  it('splits one interval across the gates that covered it', () => {
    // protects: gate hours reconcile with stuck time — the split covers the
    // whole interval.
    const evidence: GateEvidence = {
      launches: [
        { kind: 'coding', stage: 'coding', atMs: at(0) },
        { kind: 'review', stage: 'review', atMs: at(60) },
      ],
      stageResults: [
        { stage: 'coding', status: 'completed', startedAtMs: at(0), finishedAtMs: at(60) },
        { stage: 'review', status: 'completed', startedAtMs: at(60), finishedAtMs: at(120), verdict: 'ready' },
      ],
    };
    const decision = deriveStallGate({ fromMs: at(30), toMs: at(90) }, deriveGateTimeline(evidence, { endMs: at(120) }));
    const split = new Map(decision.gateSplit.map((entry) => [entry.gate, entry.ms]));
    assert.equal(split.get('coding-agent'), 30 * 60_000);
    assert.equal(split.get('review-agent'), 30 * 60_000);
    assert.equal(decision.gateSplit.reduce((sum, entry) => sum + entry.ms, 0), 60 * 60_000);
    // Equal overlap: precedence names review-agent over coding-agent.
    assert.equal(decision.gate, 'review-agent');
  });

  it('aggregates gate hours so they sum to total stuck hours', () => {
    // protects: the per-gate table reconciles with the stuck total.
    const rows = aggregateStallGates([
      {
        issue: 'HOK-1',
        durationMs: 2 * 60 * 60_000,
        gateSplit: [{ gate: 'review-park', stage: 'review', ms: 2 * 60 * 60_000 }],
        endedByPerson: true,
        offHoursMs: 60 * 60_000,
      },
      {
        issue: 'HOK-2',
        durationMs: 60 * 60_000,
        gateSplit: [
          { gate: 'coding-agent', stage: 'coding', ms: 30 * 60_000 },
          { gate: 'ready-checks', stage: 'ready', ms: 30 * 60_000 },
        ],
        endedByPerson: false,
        offHoursMs: 30 * 60_000,
      },
    ]);
    assert.equal(rows.reduce((sum, row) => sum + row.hours, 0), 3);
    const reviewPark = rows.find((row) => row.gate === 'review-park');
    assert.deepEqual(reviewPark, {
      gate: 'review-park',
      tasks: 1,
      intervals: 1,
      hours: 2,
      endedByPerson: 1,
      offHoursHours: 1,
      waitedForPersonHours: 1,
      byStage: { review: 2 },
    });
    const readyChecks = rows.find((row) => row.gate === 'ready-checks');
    assert.equal(readyChecks?.hours, 0.5);
    assert.equal(readyChecks?.endedByPerson, 0);
    // A tolerated tie counts only the primary gate as ended by a person.
    const coding = rows.find((row) => row.gate === 'coding-agent');
    assert.equal(coding?.endedByPerson, 0);
  });

  it('uses the largest split as the primary gate, not the first listed', () => {
    // protects: an unsorted caller still gets the interval's real gate.
    const rows = aggregateStallGates([
      {
        issue: 'HOK-3',
        durationMs: 60 * 60_000,
        gateSplit: [
          { gate: 'ready-checks', stage: 'ready', ms: 10 * 60_000 },
          { gate: 'review-park', stage: 'review', ms: 50 * 60_000 },
        ],
        endedByPerson: true,
        offHoursMs: 60 * 60_000,
      },
    ]);
    assert.equal(rows.find((row) => row.gate === 'review-park')?.endedByPerson, 1);
    assert.equal(rows.find((row) => row.gate === 'ready-checks')?.endedByPerson, 0);
  });
});

// protects: stall cause majority overlap and tie-breaking precedence
describe('stall-cause', () => {
  it('picks the cause with the most overlap when it covers >= 50%', () => {
    const interval = { fromMs: 0, toMs: 120 * 60 * 1000 };
    const spans: CauseSpan[] = [
      { cause: 'stage-agent', fromMs: 0, toMs: 70 * 60 * 1000 },
      { cause: 'operator-attention', fromMs: 60 * 60 * 1000, toMs: 120 * 60 * 1000 },
    ];
    const result = deriveStallCause(interval, spans);
    assert.equal(result.cause, 'stage-agent');
  });

  it('returns unknown when no cause reaches 50%', () => {
    const interval = { fromMs: 0, toMs: 120 * 60 * 1000 };
    const spans: CauseSpan[] = [
      { cause: 'stage-agent', fromMs: 0, toMs: 40 * 60 * 1000 },
      { cause: 'operator-attention', fromMs: 80 * 60 * 1000, toMs: 120 * 60 * 1000 },
    ];
    const result = deriveStallCause(interval, spans);
    assert.equal(result.cause, 'unknown');
  });

  it('uses precedence on exact ties', () => {
    const interval = { fromMs: 0, toMs: 120 * 60 * 1000 };
    const spans: CauseSpan[] = [
      { cause: 'stage-agent', fromMs: 0, toMs: 120 * 60 * 1000 },
      { cause: 'operator-attention', fromMs: 0, toMs: 120 * 60 * 1000, detail: 'plan-approval' },
    ];
    const result = deriveStallCause(interval, spans);
    assert.equal(result.cause, 'operator-attention');
    assert.equal(result.causeDetail, 'plan-approval');
  });

  it('returns unknown for an empty span list', () => {
    assert.equal(deriveStallCause({ fromMs: 0, toMs: 100 }, []).cause, 'unknown');
  });

  it('aggregates only stalls over 1h by cause', () => {
    const intervals = [
      { durationMs: 30 * 60 * 1000, cause: 'stage-agent' as const },
      { durationMs: 90 * 60 * 1000, cause: 'stage-agent' as const },
      { durationMs: 120 * 60 * 1000, cause: 'unknown' as const },
    ];
    const result = aggregateStallCauses(intervals);
    assert.equal(result['stage-agent'].stalls, 1);
    assert.equal(result['stage-agent'].hours, 1.5);
    assert.equal(result.unknown.stalls, 1);
    assert.equal(result.unknown.hours, 2);
    assert.equal(result['operator-attention'].stalls, 0);
  });
});
