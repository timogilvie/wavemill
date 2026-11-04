import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it, mock } from 'node:test';
import { clearConfigCache } from './config.ts';
import { saveUserConfig } from './hokusai-consent.ts';
import type { EvalRecord, RoutingDecision } from './eval-schema.ts';
import {
  PROTECTED_EGRESS_FIELD_FIXTURE,
  protectedEgressSentinelValues,
} from './hokusai-redaction.ts';
import { summarizeTriggerLog } from './hokusai-trigger-log.ts';
import {
  formatHokusaiSubmissionTriggerResult,
  hokusaiSubmissionTriggerDeps,
  triggerHokusaiSubmission,
} from './hokusai-submission-trigger.ts';
import type { MeteredWorkflowCost } from './sdk-task-cost/meter.ts';
import type { SessionOwnershipRow } from './session-ownership.ts';

/**
 * A minimal `MeteredWorkflowCost` with one owned coding session, enough to
 * make `buildHokusaiV4Projection` return a projection (not null → not_eligible).
 * HOK-3415: v4 requires at least one `stage_executions[]` entry, so tests that
 * assert on the projection payload must supply an ownership row.
 */
function makeMeteredCost(
  overrides: Partial<SessionOwnershipRow> = {},
): MeteredWorkflowCost {
  // `model` matches `makeRoutingDecision().chosen.modelId` ('gpt-5.4') so the
  // v4 validator ("last coding stage's executed_model must equal
  // selected_models.coder") is satisfied in tests that use the eligible
  // record's default route. Tests that vary the route override this.
  const owned: SessionOwnershipRow = {
    sessionRef: 'owned-session-1',
    harness: 'claude-code',
    kind: 'coding',
    stage: 'coding',
    model: 'gpt-5.4',
    launchedAt: '2026-06-01T11:00:00.000Z',
    attemptId: 'coding@abc1234#1750000000',
    ...overrides,
  };
  return {
    outcome: 'measured',
    reason: 'ok',
    summaries: [],
    owned: [owned],
    sessionCosts: new Map(),
    sessionUsageRows: new Map(),
    sessionHarness: new Map(),
    summariesByKind: new Map(),
  } satisfies MeteredWorkflowCost;
}

/**
 * Stub `resolveStageExecutedModel` so tests that only care about the
 * projection's feature-outcome diagnostic fields never have to put a real
 * `.coding-complete` artifact on disk.
 */
function stubExecutedModelResolver(): void {
  // Matches `makeMeteredCost` and `makeRoutingDecision` so the v4 validator's
  // "last coding stage's executed_model must equal selected_models.coder"
  // rule holds.
  mock.method(hokusaiSubmissionTriggerDeps, 'resolveStageExecutedModel', () => ({
    executedModel: 'gpt-5.4',
    evidenceStatus: 'direct' as const,
    evidenceSource: 'session-stream' as const,
  }));
  mock.method(hokusaiSubmissionTriggerDeps, 'resolveRepairStageExecutedModel', () => ({
    executedModel: 'gpt-5.4',
    evidenceStatus: 'missing' as const,
    evidenceSource: 'launch-record' as const,
    harness: 'claude-code' as const,
  }));
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeRepoConfig(repoDir: string, enabled: boolean): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify({
    hokusai: {
      dataSubmission: {
        enabled,
        consentVersion: '1.0',
      },
      contributions: {
        enabled: true,
        endpoint: 'https://example.com/contributions',
        batchSize: 10,
      },
    },
  }, null, 2)}\n`);
}

function makeRepo(enabled = true): { repoDir: string; configDir: string } {
  const repoDir = makeTempDir('hokusai-submission-repo-');
  const configDir = makeTempDir('hokusai-submission-config-');
  writeRepoConfig(repoDir, enabled);
  saveUserConfig({
    hokusai: {
      enabled: true,
      consentedAt: '2026-05-31T12:00:00.000Z',
      consentVersion: '1.0',
    },
  }, configDir);
  return { repoDir, configDir };
}

function makeRoutingDecision(): RoutingDecision {
  return {
    candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
    chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
    decisionPolicyVersion: 'baseline',
    decisionRationale: 'Use the implementation model.',
  };
}

function makeEligibleRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'eval-123',
    issueId: 'HOK-1243',
    schemaVersion: '1.27.0',
    originalPrompt: 'Trigger Hokusai after eval completion',
    modelId: 'gpt-5.4',
    modelVersion: 'gpt-5.4',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 4_242,
    phaseDurationsSeconds: {
      planning: 4_000,
      coding: 42,
      review: 200,
      total: 4_242,
    },
    timestamp: '2026-06-01T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 1,
    interventionDetails: ['Clarified one edge case'],
    rationale: 'Looks good.',
    workflowCost: 3.5,
    outcomes: {
      success: true,
    },
    routingDecision: makeRoutingDecision(),
    constraints: {
      maxCostUsd: 5,
    },
    ...overrides,
  };
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearConfigCache();
  mock.restoreAll();
  // HOK-3415: every trigger test that reaches `buildHokusaiV4Projection` needs
  // the executed-model resolver stubbed — the real resolver reads on-disk
  // ownership artifacts (`.coding-complete`, `.session-ownership.jsonl`) that
  // tmpdir-only tests never create. Tests that override these see their own
  // mock win.
  stubExecutedModelResolver();
});

describe('hokusai-submission-trigger', () => {
  it('reports repo-config details when data submission is disabled', async () => {
    const { repoDir, configDir } = makeRepo(false);
    const warn = mock.method(console, 'warn', () => undefined);

    const result = await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: 'a'.repeat(64),
    });

    assert.equal(result.status, 'disabled');
    assert.equal(result.source, 'repo_config');
    assert.match(result.detail, /base=false local=unset/);
    assert.match(formatHokusaiSubmissionTriggerResult(result), /disabled \(repo_config:/);
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl')), false);
    assert.equal(summarizeTriggerLog(repoDir)?.counts.disabled, 1);
    assert.equal(warn.mock.calls.length, 0);
  });

  it('reports consent blockers when the user store disables submission', async () => {
    const { repoDir, configDir } = makeRepo(true);
    saveUserConfig({
      hokusai: {
        enabled: false,
        consentedAt: '2026-05-31T12:00:00.000Z',
        consentVersion: '1.0',
      },
    }, configDir);
    const warn = mock.method(console, 'warn', () => undefined);

    const result = await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: 'a'.repeat(64),
      meteredCost: makeMeteredCost(),
    });

    assert.equal(result.status, 'disabled');
    assert.equal(result.source, 'consent');
    assert.match(result.detail, /user_store_disabled/);
    assert.match(result.detail, new RegExp(join(configDir, 'config.json').replaceAll('/', '\\/')));
    assert.match(result.detail, /wavemill hokusai enable/);
    assert.match(formatHokusaiSubmissionTriggerResult(result), /disabled \(consent:/);
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl')), false);
    assert.equal(summarizeTriggerLog(repoDir)?.counts.disabled, 1);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /\[hokusai\] submission disabled by consent gate/);
  });

  it('redacts and enqueues an eligible record when submission is enabled', async () => {
    const { repoDir, configDir } = makeRepo(true);

    await triggerHokusaiSubmission(makeEligibleRecord({
      attempted_model: 'qwen/qwen3-coder',
      model_alias: 'qwen-3-coder',
    }), {
      repoDir,
      configDir,
      redactionSalt: 'b'.repeat(64),
      meteredCost: makeMeteredCost(),
      launchPriorityValidation: {
        catalogGeneratedAt: '2026-07-13T15:00:00.000Z',
        catalogSourceHash: 'catalog-hash',
        launchPriorityListVersion: 'model_30_launch_priority_models.v1.json',
        launchPriorityFixtureHash: 'fixture-hash',
      },
    });

    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    const lines = readFileSync(pendingPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);

    // HOK-3415: v4 row carries the per-role models directly under
    // `selected_models`, not inside a legacy `inputs` dict (deleted).
    const entry = JSON.parse(lines[0]) as {
      row: {
        schema_version?: string;
        task_id?: string;
        harness?: string;
        success_under_budget?: boolean;
        actual_cost_usd?: number;
        wall_clock_seconds?: number;
        selected_models?: { planner?: string; coder?: string; reviewer?: string };
        inputs?: unknown;
      };
    };

    assert.equal(entry.row.schema_version, 'technical_task_router_row/v4');
    assert.match(entry.row.task_id ?? '', /^redacted-[a-f0-9]{16}$/);
    assert.notEqual(entry.row.task_id, 'HOK-1243');
    assert.equal(entry.row.harness, 'wavemill');
    assert.equal(entry.row.success_under_budget, true);
    assert.equal(entry.row.actual_cost_usd, 3.5);
    assert.equal(entry.row.wall_clock_seconds, 42);
    assert.equal(entry.row.selected_models?.planner, 'gpt-5.4');
    assert.equal(entry.row.selected_models?.coder, 'gpt-5.4');
    assert.equal(entry.row.selected_models?.reviewer, 'gpt-5.4');
    // Legacy `inputs` dict is gone from v4 — the row has no such key.
    assert.equal(entry.row.inputs, undefined);
    assert.equal(readFileSync(pendingPath, 'utf-8').includes('HOK-1243'), false);
  });

  // protects: Hokusai receiving "the executed model failed" with no join key or override (HOK-3363 / HOK-3329 replay).
  it('queues the Hokusai join key and every route override on the contribution row', async () => {
    const { repoDir, configDir } = makeRepo(true);

    // The HOK-3364 chain invariant: the last override's `to` for a role must
    // equal `selected_models[role]`, which `toHokusaiSubmission` derives from
    // `record.routingDecision.chosen.modelId` (default 'gpt-5.4'). So the
    // coder chain ends at 'gpt-5.4' and the executed-model stub also returns
    // 'gpt-5.4'.
    await triggerHokusaiSubmission(makeEligibleRecord({
      routeProvenance: {
        decisionSource: 'expanded',
        hokusaiInferenceLogId: 'b41b1171-0000-4000-8000-000000000001',
        stageRoutes: {
          planner: { executed: 'gpt-5.4', overrides: [] },
          coder: {
            hokusai: { requestId: 'b41b1171-0000-4000-8000-000000000001', recommended: 'claude-haiku-4-5' },
            executed: 'gpt-5.4',
            overrides: [
              {
                source: 'escalation',
                from: 'claude-haiku-4-5',
                to: 'glm-5.3-flash',
                reason: 'hokusai_reask_below_floor',
                at: '2026-10-30T10:00:00.000Z',
                triggers: [{ metric: 'confidence', value: 0.334, threshold: 0.4 }],
              },
              {
                source: 'operator',
                from: 'glm-5.3-flash',
                to: 'gpt-5.4',
                reason: 'operator_force_reroute',
                at: '2026-10-30T14:00:00.000Z',
              },
            ],
          },
          reviewer: { executed: 'gpt-5.4', overrides: [] },
        },
      },
    }), { repoDir, configDir, redactionSalt: 'c'.repeat(64), meteredCost: makeMeteredCost() });

    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    const [line] = readFileSync(pendingPath, 'utf-8').trim().split('\n');
    // HOK-3415: the join key and overrides live at the row top level now (the
    // v3 routing-outcome block), not under a legacy `inputs` dict.
    const row = (JSON.parse(line) as { row: {
      inference_log_id?: string;
      overrides?: Array<{ role: string; source: string; from: string; to: string; reason: string }>;
    } }).row;
    assert.equal(row.inference_log_id, 'b41b1171-0000-4000-8000-000000000001');
    assert.ok(Array.isArray(row.overrides));
    assert.equal(row.overrides!.length, 2);
    assert.deepEqual(row.overrides!.map((o) => o.role), ['coder', 'coder']);
    assert.deepEqual(row.overrides!.map((o) => o.source), ['escalation', 'operator']);
    assert.deepEqual(row.overrides!.map((o) => o.from), ['claude-haiku-4-5', 'glm-5.3-flash']);
    assert.deepEqual(row.overrides!.map((o) => o.to), ['glm-5.3-flash', 'gpt-5.4']);
    assert.deepEqual(row.overrides!.map((o) => o.reason), ['hokusai_reask_below_floor', 'operator_force_reroute']);
  });

  // protects: a locally routed task inventing a join key or an empty override list.
  it('adds no route-record inputs for a record with neither a join key nor overrides', async () => {
    const { repoDir, configDir } = makeRepo(true);
    await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: 'd'.repeat(64),
      meteredCost: makeMeteredCost(),
    });
    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    const [line] = readFileSync(pendingPath, 'utf-8').trim().split('\n');
    // HOK-3415: without a Hokusai join key the routing-outcome block is
    // entirely omitted; the row carries no `inference_log_id` and no
    // `overrides` key.
    const row = (JSON.parse(line) as { row: {
      inference_log_id?: string;
      overrides?: unknown;
    } }).row;
    assert.equal(row.inference_log_id, undefined);
    assert.equal(row.overrides, undefined);
  });

  it('keeps protected vendor-telemetry and reviewer-evidence strings out of the queued row (HOK-2787)', async () => {
    const { repoDir, configDir } = makeRepo(true);

    const pollutedRecord = {
      ...makeEligibleRecord({
        originalPrompt: `Fix the bug reported by ${PROTECTED_EGRESS_FIELD_FIXTURE.user.email}`,
        rationale: `Transcript at ${PROTECTED_EGRESS_FIELD_FIXTURE.transcript_path}`,
        interventionDetails: [PROTECTED_EGRESS_FIELD_FIXTURE.review_findings],
      }),
      // Raw vendor telemetry spread onto the record must never reach the row:
      // the projection is an explicit allowlisted safe-field builder.
      ...structuredClone(PROTECTED_EGRESS_FIELD_FIXTURE),
    } as EvalRecord;

    const result = await triggerHokusaiSubmission(pollutedRecord, {
      repoDir,
      configDir,
      redactionSalt: 'd'.repeat(64),
      meteredCost: makeMeteredCost(),
    });
    assert.equal(result.status, 'enqueued');

    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    const [line] = readFileSync(pendingPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(line) as { row: Record<string, unknown>; provenance?: { evalId?: string } };
    const serializedRow = JSON.stringify(entry.row);

    for (const sentinel of protectedEgressSentinelValues()) {
      const needle = JSON.stringify(sentinel).slice(1, -1);
      assert.ok(
        !serializedRow.includes(needle),
        `protected value must not reach the queued contribution row: ${sentinel}`,
      );
    }

    // Queue provenance (evalId) is local-only bookkeeping: it may live in the
    // envelope but must never leak into the uploadable row payload.
    assert.equal(entry.provenance?.evalId, 'eval-123');
    assert.ok(!serializedRow.includes('eval-123'));
    assert.ok(!serializedRow.includes('HOK-1243'));
  });

  it('enqueues missing cost as null without counting it under budget', async () => {
    const { repoDir, configDir } = makeRepo(true);

    await triggerHokusaiSubmission(makeEligibleRecord({ workflowCost: undefined }), {
      repoDir,
      configDir,
      redactionSalt: 'c'.repeat(64),
      meteredCost: makeMeteredCost(),
    });

    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    const [line] = readFileSync(pendingPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(line) as {
      row: {
        actual_cost_usd?: number | null;
        success_under_budget?: boolean;
        inputs?: unknown;
      };
    };

    assert.equal(entry.row.actual_cost_usd, null);
    assert.equal(entry.row.success_under_budget, false);
    // HOK-3415: v4 has no `inputs` dict; legacy launch-priority audit fields
    // (coder_attempted_model, coder_model_alias) are gone with it.
    assert.equal(entry.row.inputs, undefined);
  });

  it('enqueues coding execution time as wall_clock_seconds, not queue-inflated elapsed time', async () => {
    const { repoDir, configDir } = makeRepo(true);

    // Regression for HOK-2895: a task that sat queued for ~19h submitted
    // 81,308s as the coder model's latency when it only ran for 845.707s.
    await triggerHokusaiSubmission(makeEligibleRecord({
      timeSeconds: 81_308.214,
      phaseDurationsSeconds: {
        planning: 69_968.308,
        coding: 845.707,
        review: 10_494.199,
        total: 81_308.214,
      },
    }), {
      repoDir,
      configDir,
      redactionSalt: 'd'.repeat(64),
      meteredCost: makeMeteredCost(),
    });

    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    const [line] = readFileSync(pendingPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(line) as { row: { wall_clock_seconds?: number } };

    assert.equal(entry.row.wall_clock_seconds, 845.707);
  });

  it('omits wall_clock_seconds instead of falling back to elapsed time when no coding duration exists', async () => {
    const { repoDir, configDir } = makeRepo(true);

    await triggerHokusaiSubmission(makeEligibleRecord({
      phaseDurationsSeconds: undefined,
    }), {
      repoDir,
      configDir,
      redactionSalt: 'e'.repeat(64),
      meteredCost: makeMeteredCost(),
    });

    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    const [line] = readFileSync(pendingPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(line) as { row: Record<string, unknown> };

    assert.equal('wall_clock_seconds' in entry.row, false);
  });

  it('submits compatible rows when verification telemetry is present on the eval record', async () => {
    const { repoDir, configDir } = makeRepo(true);

    await triggerHokusaiSubmission(makeEligibleRecord({
      verificationTelemetry: {
        schema_version: '1.0',
        local_verification: {
          ran: true,
          passed: false,
          first_failure_category: 'lint',
          first_failure_fingerprint: 'a'.repeat(64),
        },
        operator_override: {
          applied: true,
          reason: 'manual approval from reviewer@example.com',
        },
      },
    }), {
      repoDir,
      configDir,
      redactionSalt: '9'.repeat(64),
      meteredCost: makeMeteredCost(),
    });

    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    const [line] = readFileSync(pendingPath, 'utf-8').trim().split('\n');
    // HOK-3415: planner_model lives under selected_models now, not inputs.
    const entry = JSON.parse(line) as {
      row: { selected_models?: { planner?: string } };
    };

    assert.equal(line.includes('manual approval'), false);
    assert.equal(line.includes('reviewer@example.com'), false);
    assert.equal(line.includes('first_failure_fingerprint'), false);
    assert.equal(entry.row.selected_models?.planner, 'gpt-5.4');
  });

  it('warns and swallows redaction failures', async () => {
    const { repoDir, configDir } = makeRepo(true);
    const warn = mock.method(console, 'warn', () => undefined);
    mock.method(hokusaiSubmissionTriggerDeps, 'redactHokusaiSubmission', () => {
      throw new Error('redaction failed');
    });

    await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: 'd'.repeat(64),
    });

    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /\[hokusai\] submission trigger failed: redaction failed/);
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl')), false);
    assert.equal(summarizeTriggerLog(repoDir)?.counts.failed, 1);
  });

  it('warns and swallows enqueue failures', async () => {
    const { repoDir, configDir } = makeRepo(true);
    const warn = mock.method(console, 'warn', () => undefined);
    mock.method(hokusaiSubmissionTriggerDeps, 'enqueueContribution', async () => {
      throw new Error('queue unavailable');
    });

    await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: 'e'.repeat(64),
      meteredCost: makeMeteredCost(),
    });

    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /\[hokusai\] submission trigger failed: queue unavailable/);
    assert.equal(summarizeTriggerLog(repoDir)?.counts.failed, 1);
  });

  it('does not change the returned result when trigger log append fails', async () => {
    const { repoDir, configDir } = makeRepo(true);
    const warn = mock.method(console, 'warn', () => undefined);
    mock.method(hokusaiSubmissionTriggerDeps, 'appendTriggerLogEntry', () => {
      throw new Error('disk full');
    });

    const result = await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: '8'.repeat(64),
      meteredCost: makeMeteredCost(),
    });

    assert.equal(result.status, 'enqueued');
    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /failed to append trigger log: disk full/);
  });

  it('warns asynchronously when opportunistic drain rejects', async () => {
    const { repoDir, configDir } = makeRepo(true);
    const warn = mock.method(console, 'warn', () => undefined);
    mock.method(hokusaiSubmissionTriggerDeps, 'drainContributionQueue', async () => {
      throw new Error('drain failed');
    });

    await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: 'f'.repeat(64),
      meteredCost: makeMeteredCost(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /\[hokusai\] opportunistic drain failed: drain failed/);
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl')), true);
  });

  it('does not await the opportunistic drain', async () => {
    const { repoDir, configDir } = makeRepo(true);
    let resolveDrain: (() => void) | undefined;

    mock.method(hokusaiSubmissionTriggerDeps, 'drainContributionQueue', () => new Promise((resolve) => {
      resolveDrain = resolve;
    }));

    const result = await Promise.race([
      triggerHokusaiSubmission(makeEligibleRecord(), {
        repoDir,
        configDir,
        redactionSalt: '0'.repeat(64),
      }).then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 25)),
    ]);

    assert.equal(result, 'resolved');
    resolveDrain?.();
  });

  // HOK-2262: feature outcome diagnostics threaded through contribution row
  it('passes feature outcome diagnostics to the contribution row when present on record', async () => {
    const { repoDir, configDir } = makeRepo(true);
    const capturedRows: unknown[] = [];

    stubExecutedModelResolver();
    mock.method(hokusaiSubmissionTriggerDeps, 'buildTechnicalTaskRouterRowV4', (projection: unknown) => {
      capturedRows.push(projection);
      return { schema_version: 'technical_task_router_row/v4' };
    });
    mock.method(hokusaiSubmissionTriggerDeps, 'enqueueContribution', async () => ({
      status: 'enqueued' as const,
      entry: { entryId: 'e1' },
    }));
    mock.method(hokusaiSubmissionTriggerDeps, 'drainContributionQueue', async () => ({}));

    const record = makeEligibleRecord({
      featureOutcomeDiagnostics: {
        present: true,
        valid: true,
        used: true,
        sourceFile: 'feature-state.json',
        sourceHash: 'a'.repeat(64),
        reason: 'loaded',
        eligibilityDiagnostic: 'eligible',
        missingFields: [],
        invalidFields: [],
        conflictsWithReconstruction: false,
      },
    } as unknown as Partial<EvalRecord>);

    await triggerHokusaiSubmission(record, {
      repoDir,
      configDir,
      redactionSalt: '1'.repeat(64),
      meteredCost: makeMeteredCost(),
    });

    assert.equal(capturedRows.length, 1);
    const proj = capturedRows[0] as Record<string, unknown>;
    assert.equal(proj.outcomeDiagnostic, 'eligible');
    assert.equal(proj.outcomeSource, 'feature_outcome_artifact');
    assert.equal(proj.outcomeArtifactPresent, true);
    assert.equal(proj.outcomeArtifactValid, true);
    assert.equal(proj.outcomeArtifactUsed, true);
  });

  it('omits outcome diagnostic fields from projection when record has no featureOutcomeDiagnostics', async () => {
    const { repoDir, configDir } = makeRepo(true);
    const capturedRows: unknown[] = [];

    stubExecutedModelResolver();
    mock.method(hokusaiSubmissionTriggerDeps, 'buildTechnicalTaskRouterRowV4', (projection: unknown) => {
      capturedRows.push(projection);
      return { schema_version: 'technical_task_router_row/v4' };
    });
    mock.method(hokusaiSubmissionTriggerDeps, 'enqueueContribution', async () => ({
      status: 'enqueued' as const,
      entry: { entryId: 'e2' },
    }));
    mock.method(hokusaiSubmissionTriggerDeps, 'drainContributionQueue', async () => ({}));

    const record = makeEligibleRecord();
    delete (record as Record<string, unknown>).featureOutcomeDiagnostics;

    await triggerHokusaiSubmission(record, {
      repoDir,
      configDir,
      redactionSalt: '2'.repeat(64),
      meteredCost: makeMeteredCost(),
    });

    assert.equal(capturedRows.length, 1);
    const proj = capturedRows[0] as Record<string, unknown>;
    assert.equal(proj.outcomeDiagnostic, undefined);
    assert.equal(proj.outcomeSource, undefined);
    assert.equal(proj.outcomeArtifactPresent, undefined);
  });

  it('does not project local planning execution outcome to Hokusai contribution rows', async () => {
    const { repoDir, configDir } = makeRepo(true);
    const capturedRows: unknown[] = [];

    stubExecutedModelResolver();
    mock.method(hokusaiSubmissionTriggerDeps, 'buildTechnicalTaskRouterRowV4', (projection: unknown) => {
      capturedRows.push(projection);
      return { schema_version: 'technical_task_router_row/v4' };
    });
    mock.method(hokusaiSubmissionTriggerDeps, 'enqueueContribution', async () => ({
      status: 'enqueued' as const,
      entry: { entryId: 'e-planning' },
    }));
    mock.method(hokusaiSubmissionTriggerDeps, 'drainContributionQueue', async () => ({}));

    const legacyRecord = makeEligibleRecord();
    delete (legacyRecord as Record<string, unknown>).planningExecutionOutcome;

    const recordWithPlanningOutcome = makeEligibleRecord({
      id: 'eval-456',
      planningExecutionOutcome: {
        agent: 'native',
        model: 'moonshotai/kimi-k2.7-code',
        status: 'failed',
        failureReason: 'turn_limit',
        planArtifactValid: false,
        approvalReady: false,
        bounds: { maxTurns: 40, maxToolCalls: 120, maxWallClockMs: 1200000 },
        usage: {
          turnsCompleted: 40,
          toolCallsExecuted: 72,
          wallClockMs: 900000,
          totalInputTokens: 100000,
          totalOutputTokens: 20000,
          totalCostUsd: 0.32,
        },
        promptRef: { id: 'native-planning', version: 'sha256:test' },
        source: '.planning-result.json',
      },
    });

    await triggerHokusaiSubmission(legacyRecord, {
      repoDir,
      configDir,
      redactionSalt: '3'.repeat(64),
      meteredCost: makeMeteredCost(),
    });
    await triggerHokusaiSubmission(recordWithPlanningOutcome, {
      repoDir,
      configDir,
      redactionSalt: '4'.repeat(64),
      meteredCost: makeMeteredCost(),
    });

    assert.equal(capturedRows.length, 2);
    for (const projection of capturedRows as Record<string, unknown>[]) {
      const serialized = JSON.stringify(projection);
      assert.equal('planningExecutionOutcome' in projection, false);
      assert.equal(serialized.includes('turn_limit'), false);
      assert.equal(serialized.includes('maxTurns'), false);
    }
  });

  it('marks invalid feature outcome artifacts as unknown instead of reconstructed', async () => {
    const { repoDir, configDir } = makeRepo(true);
    const capturedRows: unknown[] = [];

    stubExecutedModelResolver();
    mock.method(hokusaiSubmissionTriggerDeps, 'buildTechnicalTaskRouterRowV4', (projection: unknown) => {
      capturedRows.push(projection);
      return { schema_version: 'technical_task_router_row/v4' };
    });
    mock.method(hokusaiSubmissionTriggerDeps, 'enqueueContribution', async () => ({
      status: 'enqueued' as const,
      entry: { entryId: 'e3' },
    }));
    mock.method(hokusaiSubmissionTriggerDeps, 'drainContributionQueue', async () => ({}));

    const record = makeEligibleRecord({
      featureOutcomeDiagnostics: {
        present: true,
        valid: false,
        used: false,
        sourceFile: 'feature-state.json',
        sourceHash: 'd'.repeat(64),
        reason: 'invalid_outcome',
        eligibilityDiagnostic: 'unknown',
        missingFields: ['readyEvidence'],
        invalidFields: [],
        conflictsWithReconstruction: false,
      },
    } as unknown as Partial<EvalRecord>);

    await triggerHokusaiSubmission(record, {
      repoDir,
      configDir,
      redactionSalt: '3'.repeat(64),
      meteredCost: makeMeteredCost(),
    });

    assert.equal(capturedRows.length, 1);
    const proj = capturedRows[0] as Record<string, unknown>;
    assert.equal(proj.outcomeSource, 'unknown');
    assert.equal(proj.outcomeArtifactPresent, true);
    assert.equal(proj.outcomeArtifactValid, false);
    assert.equal(proj.outcomeArtifactUsed, false);
  });
});
