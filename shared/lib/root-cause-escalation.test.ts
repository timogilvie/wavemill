import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  investigateConfirmedIncident,
  preparePayloadForTransport,
  renderInvestigatedCommentBody,
  renderInvestigatedIssueBody,
  type InvestigationPayload,
} from './root-cause-escalation.ts';
import { createIncidentDraft, type IncidentRecord } from './wavemill-incident-model.ts';
import { DEFAULT_INCIDENT_LINEAR_CONFIG, type ObserverLinearConfig } from './incident-to-linear-synchronizer.ts';
import type { IncidentFilingReconciliation } from './incident-filing-reconciler.ts';
import type { LLMCallResult } from './llm-cli.ts';

function makeIncident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return createIncidentDraft({
    id: 'incident-1',
    fingerprint: 'f'.repeat(64),
    taskId: 'HOK-1',
    session: 'wavemill',
    category: 'product_defect',
    severity: 'high',
    confidence: 'definite',
    lifecycle: 'active',
    createdAt: '2026-08-04T12:00:00.000Z',
    lastObservedAt: '2026-08-04T12:10:00.000Z',
    occurrenceCount: 3,
    rootCauseClass: 'observer_crash',
    summary: 'Observer crashed while reading artifact.',
    operatorAction: 'Fix artifact parsing and add a regression test.',
    evidence: [{
      type: 'log_excerpt',
      source: '/Users/timothy/project/.wavemill/logs/mill.log',
      timestamp: '2026-08-04T12:10:00.000Z',
      lineNumber: 42,
      redactedData: 'ERROR token=supersecret model=gpt-test user=person@example.com',
      key: 'crash',
    }],
    metadata: { thresholdTriggered: true, escalatedAt: '2026-08-04T12:10:00.000Z' },
    ...overrides,
  });
}

function confirmedActive(): IncidentFilingReconciliation {
  return { outcome: 'confirmed_active', evidence: { jobId: 'job-1', status: 'failed' } };
}

function recovered(): IncidentFilingReconciliation {
  return { outcome: 'recovered', evidence: { jobId: 'job-1', status: 'succeeded' } };
}

function makeRunner(payload: InvestigationPayload) {
  return async (): Promise<LLMCallResult> => ({
    ok: true,
    output: JSON.stringify(payload),
    modelId: 'gpt-test',
    provider: 'codex',
    exitCode: 0,
    costUsd: 0.001,
    latencyMs: 100,
    tokenUsage: { input: 100, output: 50 },
  });
}

function config(): ObserverLinearConfig {
  return { ...DEFAULT_INCIDENT_LINEAR_CONFIG, enabled: true, team: 'HOK', project: 'Wavemill' };
}

test('investigateConfirmedIncident skips non-active reconciliations', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    const outcome = await investigateConfirmedIncident({
      incident: makeIncident(),
      repoDir: tmp,
      reconciliation: recovered(),
    });
    assert.equal(outcome.state, 'skipped');
    assert.equal(outcome.reason, 'reconciliation: recovered');
    assert.equal(outcome.payload, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('investigateConfirmedIncident returns ready for append_to_owner payload', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    const payload: InvestigationPayload = {
      incidentFingerprint: 'f'.repeat(64),
      mode: 'append_to_owner',
      targetIssueId: 'HOK-3315',
      title: 'Append evidence to dependency drift owner',
      sections: { why: 'why', change: 'change', notInScope: 'not in scope', acceptance: 'acceptance' },
      modelId: 'gpt-test',
      provider: 'codex',
      generatedAt: new Date().toISOString(),
    };
    const outcome = await investigateConfirmedIncident({
      incident: makeIncident(),
      repoDir: tmp,
      reconciliation: confirmedActive(),
      runInvestigation: makeRunner(payload),
    });
    assert.equal(outcome.state, 'ready');
    assert.equal(outcome.payload?.mode, 'append_to_owner');
    assert.equal(outcome.payload?.targetIssueId, 'HOK-3315');
    const incidentFiles = readdirSync(join(tmp, '.wavemill', 'incidents', 'f'.repeat(64)));
    assert.ok(incidentFiles.some((name) => name.startsWith('investigation-') && name.endsWith('.json')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('investigateConfirmedIncident returns ready for new_consolidation payload', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    const payload: InvestigationPayload = {
      incidentFingerprint: 'f'.repeat(64),
      mode: 'new_consolidation',
      title: 'One observer crash decision',
      sections: { why: 'why', change: 'change', notInScope: 'not in scope', acceptance: 'acceptance' },
      primitivesTable: '| Decision | Primitive |\n| a | b |',
      modelId: 'gpt-test',
      provider: 'codex',
      generatedAt: new Date().toISOString(),
    };
    const outcome = await investigateConfirmedIncident({
      incident: makeIncident(),
      repoDir: tmp,
      reconciliation: confirmedActive(),
      runInvestigation: makeRunner(payload),
    });
    assert.equal(outcome.state, 'ready');
    assert.equal(outcome.payload?.mode, 'new_consolidation');
    assert.match(outcome.payload?.title ?? '', /^One /);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('investigateConfirmedIncident drafts missing sections and reuses artefact', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    let calls = 0;
    const runner = async (): Promise<LLMCallResult> => {
      calls += 1;
      return {
        ok: true,
        output: JSON.stringify({
          incidentFingerprint: 'f'.repeat(64),
          mode: 'new_consolidation',
          title: 'Bad',
          sections: { why: 'why', change: 'change', notInScope: 'not in scope' },
          modelId: 'gpt-test',
          provider: 'codex',
          generatedAt: new Date().toISOString(),
        }),
        modelId: 'gpt-test',
        provider: 'codex',
        exitCode: 0,
        costUsd: 0.001,
        latencyMs: 100,
        tokenUsage: { input: 100, output: 50 },
      };
    };
    const incident = makeIncident();
    const first = await investigateConfirmedIncident({
      incident,
      repoDir: tmp,
      reconciliation: confirmedActive(),
      runInvestigation: runner,
    });
    assert.equal(first.state, 'draft');
    assert.equal(calls, 1);
    const second = await investigateConfirmedIncident({
      incident,
      repoDir: tmp,
      reconciliation: confirmedActive(),
      runInvestigation: runner,
    });
    assert.equal(second.state, 'draft');
    assert.equal(calls, 1); // reused artefact
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('investigateConfirmedIncident drafts malformed model output', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    const outcome = await investigateConfirmedIncident({
      incident: makeIncident(),
      repoDir: tmp,
      reconciliation: confirmedActive(),
      runInvestigation: async () => ({
        ok: true,
        output: 'not json',
        modelId: 'gpt-test',
        provider: 'codex',
        exitCode: 0,
        costUsd: 0.001,
        latencyMs: 100,
        tokenUsage: { input: 100, output: 50 },
      }),
    });
    assert.equal(outcome.state, 'draft');
    assert.equal(outcome.payload?.mode, 'draft');
    assert.deepEqual(outcome.payload?.missingEvidence, ['model_output_malformed']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('preparePayloadForTransport routes outcomes correctly', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rce-'));
  try {
    const incident = makeIncident();
    const skip = preparePayloadForTransport({
      incident,
      payload: null,
      reconciliation: confirmedActive(),
      state: 'pending',
    });
    assert.equal(skip.kind, 'skip');
    assert.equal(skip.reason, 'investigation_pending');

    const recoveredOutcome = await investigateConfirmedIncident({
      incident,
      repoDir: tmp,
      reconciliation: recovered(),
    });
    const skip2 = preparePayloadForTransport(recoveredOutcome);
    assert.equal(skip2.kind, 'skip');

    const ready: InvestigationPayload = {
      incidentFingerprint: incident.fingerprint,
      mode: 'new_consolidation',
      title: 'One issue',
      sections: { why: 'w', change: 'c', notInScope: 'n', acceptance: 'a' },
      modelId: 'gpt-test',
      provider: 'codex',
      generatedAt: new Date().toISOString(),
    };
    const transport = preparePayloadForTransport({
      incident,
      payload: ready,
      reconciliation: confirmedActive(),
      state: 'ready',
    });
    assert.equal(transport.kind, 'transport');
    assert.equal(transport.title, 'One issue');
    assert.match(transport.body, /## Why/);

    const draft: InvestigationPayload = {
      incidentFingerprint: incident.fingerprint,
      mode: 'draft',
      title: 'Draft',
      sections: { why: '', change: '', notInScope: '', acceptance: '' },
      missingEvidence: ['missing_change'],
      modelId: 'gpt-test',
      provider: 'codex',
      generatedAt: new Date().toISOString(),
    };
    const draftResult = preparePayloadForTransport({
      incident,
      payload: draft,
      reconciliation: confirmedActive(),
      state: 'draft',
    });
    assert.equal(draftResult.kind, 'draft');
    assert.ok(existsSync(draftResult.draftPath));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderInvestigatedIssueBody requires non-draft payload', () => {
  const payload: InvestigationPayload = {
    incidentFingerprint: 'f'.repeat(64),
    mode: 'draft',
    title: 'Draft',
    sections: { why: '', change: '', notInScope: '', acceptance: '' },
    missingEvidence: ['x'],
    modelId: 'gpt-test',
    provider: 'codex',
    generatedAt: new Date().toISOString(),
  };
  assert.throws(() => renderInvestigatedIssueBody(makeIncident(), payload), /draft/);
});

test('renderInvestigatedCommentBody renders append payload', () => {
  const payload: InvestigationPayload = {
    incidentFingerprint: 'f'.repeat(64),
    mode: 'append_to_owner',
    targetIssueId: 'HOK-3315',
    title: 'Append',
    sections: { why: 'w', change: 'c', notInScope: 'n', acceptance: 'a' },
    modelId: 'gpt-test',
    provider: 'codex',
    generatedAt: new Date().toISOString(),
  };
  const body = renderInvestigatedCommentBody(makeIncident(), payload, config(), 'rev-1', new Date('2026-08-04T12:15:00.000Z'));
  assert.match(body, /Root-Cause Evidence Update/);
  assert.doesNotMatch(body, /supersecret/);
});
