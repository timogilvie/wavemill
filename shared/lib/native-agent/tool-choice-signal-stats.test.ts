import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzeSignal,
  doublyRobust,
  fitLogistic,
  selfNormalizedIps,
  stratifiedContrasts,
} from './tool-choice-signal-stats.ts';
import type { ToolDecisionRow } from './tool-decision-schema.ts';
import { TOOL_DECISION_SCHEMA_VERSION } from './tool-decision-schema.ts';

function mkRow(overrides: Partial<ToolDecisionRow> = {}): ToolDecisionRow {
  return {
    schemaVersion: TOOL_DECISION_SCHEMA_VERSION,
    decisionId: `d-${Math.random().toString(36).slice(2)}`,
    sessionId: 's-1',
    traceId: 't-1',
    phase: 'coding',
    turnIndex: 0,
    stepIndex: 0,
    sourceEventIds: ['e1'],
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    runtime: 'native',
    kind: 'tool_call',
    chosenTool: 'read',
    toolMenu: { digest: 'menu-1', toolNames: ['read', 'edit'] },
    providerMenu: { digest: 'p-1', toolCount: 2 },
    state: {
      priorToolCallCount: 0,
      priorErrorFlag: false,
      priorErrorCount: 0,
      terminalSynthesis: false,
      priorPolicyDenials: 0,
    },
    propensity: { provenance: 'unavailable' },
    result: { status: 'success' },
    timestamp: 1_759_000_000_000,
    causalEventIds: ['e1'],
    ...overrides,
  };
}

describe('fitLogistic', () => {
  it('recovers a known coefficient sign on a linearly separable-ish dataset', () => {
    // y = 1 when x > 0 with noise
    const X: number[][] = [];
    const y: number[] = [];
    // Deterministic pseudo-random via LCG so no seed drift.
    let s = 42;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return (s / 0x100000000) - 0.5;
    };
    for (let i = 0; i < 200; i++) {
      const x = rand() * 4;
      const noise = rand() * 0.5;
      X.push([1, x]);
      y.push(x + noise > 0 ? 1 : 0);
    }
    const fit = fitLogistic({ X, y, featureNames: ['intercept', 'x'] });
    assert.ok(fit.converged);
    assert.ok(fit.coefficients[1] > 1, `expected positive slope, got ${fit.coefficients[1]}`);
  });
});

describe('stratifiedContrasts', () => {
  it('emits a non-gated contrast when both tools clear the cell floor', () => {
    const rows: ToolDecisionRow[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(
        mkRow({
          traceId: `t-${i}`,
          decisionId: `d-${i}`,
          chosenTool: 'read',
          result: { status: 'success' },
        }),
      );
    }
    for (let i = 0; i < 40; i++) {
      rows.push(
        mkRow({
          traceId: `t-b-${i}`,
          decisionId: `db-${i}`,
          chosenTool: 'edit',
          result: { status: i < 10 ? 'success' : 'error' },
        }),
      );
    }
    const res = stratifiedContrasts(rows, {
      minCellSize: 30,
      bootstrap: { iterations: 50, seed: 1 },
    });
    const nonGated = res.contrasts.filter((c) => !c.gated);
    assert.ok(nonGated.length >= 1);
    const c = nonGated[0];
    assert.ok(Math.abs(c.diff) > 0);
    assert.ok(c.treatment.n >= 30);
  });

  it('gates tiny cells with an insufficient_cell_size tag', () => {
    const rows = [
      mkRow({ traceId: 't-1', chosenTool: 'read' }),
      mkRow({ traceId: 't-2', chosenTool: 'edit' }),
    ];
    const res = stratifiedContrasts(rows, {
      minCellSize: 30,
      bootstrap: { iterations: 20, seed: 1 },
    });
    assert.ok(res.contrasts.some((c) => c.gated === 'insufficient_cell_size'));
  });
});

describe('selfNormalizedIps', () => {
  it('refuses when no exact propensity rows exist', () => {
    const rows = [
      mkRow({ propensity: { provenance: 'surrogate' } }),
      mkRow({ propensity: { provenance: 'unavailable' } }),
    ];
    const res = selfNormalizedIps(rows, 'read');
    assert.ok('refused' in res && res.refused);
    if ('refused' in res) {
      assert.equal(res.reason, 'no_exact_propensity_rows');
      assert.equal(res.basis, 'mixed');
    }
  });

  it('recovers a hand-computable estimate on exact-propensity rows', () => {
    // Two rows, target = "read": p=0.5, reward 1; p=0.25, reward 0.
    // num = 1/0.5 * 1 + 1/0.25 * 0 = 2, den = 1/0.5 + 1/0.25 = 6 → 2/6 = 0.333
    const rows = [
      mkRow({
        propensity: { provenance: 'exact', distribution: { read: 0.5, edit: 0.5 } },
        chosenTool: 'read',
        result: { status: 'success' },
      }),
      mkRow({
        propensity: { provenance: 'exact', distribution: { read: 0.25, edit: 0.75 } },
        chosenTool: 'read',
        result: { status: 'error' },
      }),
    ];
    const res = selfNormalizedIps(rows, 'read');
    assert.ok(!('refused' in res && res.refused));
    if (!('refused' in res && res.refused)) {
      assert.ok(Math.abs(res.estimate - 1 / 3) < 1e-6);
      assert.equal(res.basis, 'exact');
    }
  });
});

describe('doublyRobust', () => {
  it('refuses without exact propensity', () => {
    const rows = [mkRow({ propensity: { provenance: 'surrogate' } })];
    const res = doublyRobust(rows, 'read', () => 0.5);
    assert.ok('refused' in res && res.refused);
  });

  it('returns exact-basis estimates when supplied a q̂ model', () => {
    const rows = [
      mkRow({
        propensity: { provenance: 'exact', distribution: { read: 0.5 } },
        chosenTool: 'read',
        result: { status: 'success' },
      }),
    ];
    const res = doublyRobust(rows, 'read', (_r, tool) => (tool === 'read' ? 0.5 : 0.0));
    assert.ok(!('refused' in res && res.refused));
    if (!('refused' in res && res.refused)) {
      assert.equal(res.basis, 'exact');
      assert.equal(res.method, 'dr');
    }
  });
});

describe('analyzeSignal', () => {
  it('reports zero tracesJoined when no rows carry a joined outcome', () => {
    const rows = [mkRow()];
    const res = analyzeSignal({ rows });
    assert.equal(res.covariateNotes.tracesJoined, 0);
  });

  it('runs end-to-end with sensitivity sweeps and IPS refusal when appropriate', () => {
    const rows: ToolDecisionRow[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push(
        mkRow({
          traceId: `t-${i}`,
          decisionId: `d-${i}`,
          chosenTool: i % 2 === 0 ? 'read' : 'edit',
          outcome: { status: 'joined', issue: 'HOK-1' },
        }),
      );
    }
    const res = analyzeSignal({
      rows,
      bootstrap: { iterations: 40, seed: 7 },
    });
    assert.ok(res.sensitivity);
    assert.ok('refused' in res.offPolicy.ips && res.offPolicy.ips.refused);
    assert.equal(res.covariateNotes.tracesJoined, 60);
  });
});
