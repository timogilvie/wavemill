import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { saveUserConfig } from './hokusai-consent.ts';
import type { ContributionRow } from './hokusai-contribution-schema.ts';
import { summarizeHokusaiLedger } from './hokusai-ledger.ts';
import { HOKUSAI_CONTRIBUTION_ENDPOINT, LEGACY_UNSCOPED_ENDPOINT } from './hokusai-local-config.ts';
import { drainContributionQueue } from './hokusai-queue-drain.ts';
import { enqueueContribution, hokusaiQueueStatus, readPending, requeueDeadLetterEntries } from './hokusai-queue.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepo(overrides: Record<string, unknown> = {}): { repoDir: string; configDir: string } {
  const repoDir = makeTempDir('hokusai-drain-repo-');
  const configDir = makeTempDir('hokusai-drain-config-');
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify({
    hokusai: {
      dataSubmission: { consentVersion: '1.0' },
      contributions: {
        enabled: true,
        endpoint: 'https://example.com/contributions',
        batchSize: 2,
        maxRetries: 2,
        backoffInitialMs: 1000,
        backoffMaxMs: 1000,
        timeoutMs: 2000,
        ...overrides,
      },
    },
  }, null, 2)}\n`);
  saveUserConfig({
    hokusai: {
      enabled: true,
      consentedAt: '2026-05-30T12:00:00.000Z',
      consentVersion: '1.0',
    },
  }, configDir);
  return { repoDir, configDir };
}

function makeRow(taskId: string): ContributionRow {
  return {
    success_under_budget: true,
    task_id: taskId,
    harness: 'wavemill',
  };
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearConfigCache();
});

describe('hokusai-queue-drain', () => {
  it('does not fetch when consent/config gate is disabled', async () => {
    const { repoDir, configDir } = makeRepo({ enabled: false });
    let called = false;

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => {
        called = true;
        return new Response(null, { status: 204 });
      },
    });

    assert.equal(result.status, 'disabled');
    assert.equal(called, false);
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai')), false);
  });

  it('accepts 200 responses and records returned job ids', async () => {
    const { repoDir, configDir } = makeRepo({ batchSize: 1 });
    await enqueueContribution(makeRow('a'), { repoDir, configDir });

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(JSON.stringify({ jobIds: ['job-1'], tokenReward: 5 }), { status: 200 }),
    });

    assert.equal(result.status, 'uploaded');
    assert.deepEqual(result.jobIds, ['job-1']);
    assert.equal(hokusaiQueueStatus({ repoDir, configDir }).processedLineCount, 1);
    const summary = summarizeHokusaiLedger({ repoDir, configDir });
    assert.equal(summary.acceptedSubmissionCount, 1);
    assert.equal(summary.tokenRewards.awarded, 5);
  });

  it('loads endpoint token from repo .env using HOKUSAI_API_KEY alias', async () => {
    const { repoDir, configDir } = makeRepo({ batchSize: 1, endpointTokenEnv: 'HOKUSAI_API_TOKEN' });
    await enqueueContribution(makeRow('a'), { repoDir, configDir });
    writeFileSync(join(repoDir, '.env'), 'HOKUSAI_API_KEY=repo-secret\n');
    const originalApiKey = process.env.HOKUSAI_API_KEY;
    delete process.env.HOKUSAI_API_KEY;
    let authorization = '';

    try {
      const result = await drainContributionQueue({
        repoDir,
        configDir,
        fetchImpl: async (_input, init) => {
          authorization = String((init?.headers as Record<string, string>).authorization ?? '');
          return new Response(null, { status: 204 });
        },
      });

      assert.equal(result.status, 'uploaded');
      assert.equal(authorization, 'Bearer repo-secret');
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.HOKUSAI_API_KEY;
      } else {
        process.env.HOKUSAI_API_KEY = originalApiKey;
      }
    }
  });

  it('uploads only the redacted rows, never the local provenance envelope (HOK-2787)', async () => {
    const { repoDir, configDir } = makeRepo({ batchSize: 1 });
    await enqueueContribution(makeRow('redacted-abc123'), {
      repoDir,
      configDir,
      provenance: { evalId: 'eval-private-identifier', source: 'live', identityFingerprint: 'fp-1' },
    });
    let capturedBody = '';

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async (_input, init) => {
        capturedBody = String(init?.body);
        return new Response(null, { status: 204 });
      },
    });

    assert.equal(result.status, 'uploaded');
    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['metadata', 'rows']);
    assert.deepEqual(Object.keys(body.metadata as Record<string, unknown>), ['idempotency_key']);
    assert.deepEqual(body.rows, [makeRow('redacted-abc123')]);
    assert.ok(!capturedBody.includes('eval-private-identifier'));
    assert.ok(!capturedBody.includes('provenance'));
    assert.ok(!capturedBody.includes('fp-1'));
  });

  it('accepts 204 empty responses', async () => {
    const { repoDir, configDir } = makeRepo();
    await enqueueContribution(makeRow('a'), { repoDir, configDir });

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    assert.equal(result.status, 'uploaded');
    assert.deepEqual(result.jobIds, []);
    const summary = summarizeHokusaiLedger({ repoDir, configDir });
    assert.equal(summary.tokenRewards.pending, 1);
  });

  it('treats explicit tokenReward 0 as none', async () => {
    const { repoDir, configDir } = makeRepo();
    await enqueueContribution(makeRow('a'), { repoDir, configDir });
    await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(JSON.stringify({ tokenReward: 0 }), { status: 200 }),
    });
    const summary = summarizeHokusaiLedger({ repoDir, configDir });
    assert.equal(summary.tokenRewards.none, 1);
  });

  it('drains more than batchSize in bounded batches', async () => {
    const { repoDir, configDir } = makeRepo();
    await enqueueContribution(makeRow('a'), { repoDir, configDir });
    await enqueueContribution(makeRow('b'), { repoDir, configDir });
    await enqueueContribution(makeRow('c'), { repoDir, configDir });

    const first = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    const second = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    assert.equal(first.uploadedCount, 2);
    assert.equal(second.uploadedCount, 1);
  });

  it('retries transient network failures with backoff', async () => {
    const { repoDir, configDir } = makeRepo();
    const now = new Date('2026-05-31T12:00:00.000Z');
    await enqueueContribution(makeRow('a'), { repoDir, configDir, now });

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      now,
      random: () => 1,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });

    assert.equal(result.status, 'retry_scheduled');
    const pending = readPending({
      repoDir,
      configDir,
      now: new Date('2026-05-31T12:00:00.500Z'),
    });
    assert.equal(pending.status, 'waiting');
  });

  it('moves exhausted transient failures to dead-letter', async () => {
    const { repoDir, configDir } = makeRepo({ maxRetries: 1 });
    await enqueueContribution(makeRow('a'), { repoDir, configDir });

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response('oops', { status: 503 }),
    });

    assert.equal(result.status, 'dead_lettered');
    const deadLetterPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'dead-letter.jsonl');
    assert.equal(readFileSync(deadLetterPath, 'utf-8').trim().split('\n').length, 1);
    const summary = summarizeHokusaiLedger({ repoDir, configDir });
    assert.equal(summary.rejectedSubmissionCount, 1);
    assert.equal(summary.tokenRewards.unknown, 1);
  });

  it('moves permanent failures to dead-letter and allows later batches to continue', async () => {
    const { repoDir, configDir } = makeRepo({ batchSize: 1 });
    await enqueueContribution(makeRow('a'), { repoDir, configDir });
    await enqueueContribution(makeRow('b'), { repoDir, configDir });

    const first = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { rows: Array<{ task_id?: string }> };
        const firstTask = body.rows[0]?.task_id;
        return firstTask === 'a'
          ? new Response(JSON.stringify({ error: 'bad row' }), { status: 422 })
          : new Response(null, { status: 204 });
      },
    });
    const second = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    assert.equal(first.status, 'permanent_failure');
    assert.equal(second.status, 'uploaded');
    const summary = summarizeHokusaiLedger({ repoDir, configDir });
    assert.equal(summary.rejectedSubmissionCount, 1);
  });

  it('migrates a legacy local endpoint overlay before posting', async () => {
    const { repoDir, configDir } = makeRepo({ batchSize: 1 });
    writeFileSync(join(repoDir, '.wavemill-config.local.json'), `${JSON.stringify({
      hokusai: {
        contributions: {
          endpoint: LEGACY_UNSCOPED_ENDPOINT,
          endpointTokenEnv: 'HOKUSAI_API_KEY',
        },
      },
    }, null, 2)}\n`, 'utf-8');
    clearConfigCache(repoDir);
    await enqueueContribution(makeRow('a'), { repoDir, configDir });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    let postedEndpoint = '';
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      const result = await drainContributionQueue({
        repoDir,
        configDir,
        fetchImpl: async (input) => {
          postedEndpoint = String(input);
          return new Response(JSON.stringify({ jobIds: ['job-migrated'] }), { status: 200 });
        },
      });

      assert.equal(result.status, 'uploaded');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(postedEndpoint, HOKUSAI_CONTRIBUTION_ENDPOINT);
    assert.match(warnings.join('\n'), /migrated legacy unscoped endpoint/);
    const overlay = JSON.parse(readFileSync(join(repoDir, '.wavemill-config.local.json'), 'utf-8')) as {
      hokusai: { contributions: { endpoint: string; endpointTokenEnv: string } };
    };
    assert.equal(overlay.hokusai.contributions.endpoint, HOKUSAI_CONTRIBUTION_ENDPOINT);
    assert.equal(overlay.hokusai.contributions.endpointTokenEnv, 'HOKUSAI_API_KEY');
  });

  it('includes endpoint diagnostics when a permanent 404 occurs', async () => {
    const endpoint = 'https://example.com/wrong';
    const { repoDir, configDir } = makeRepo({ batchSize: 1, endpoint });
    await enqueueContribution(makeRow('a'), { repoDir, configDir });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      const result = await drainContributionQueue({
        repoDir,
        configDir,
        fetchImpl: async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
      });

      assert.equal(result.status, 'permanent_failure');
    } finally {
      console.warn = originalWarn;
    }

    const warning = warnings.join('\n');
    assert.match(warning, /endpoint=https:\/\/example\.com\/wrong/);
    assert.match(warning, /model-scoped at \/api\/v1\/models\/\{model_id\}\/contributions/);
    assert.match(warning, /wavemill hokusai migrate/);
  });

  it('requeues a dead-lettered permanent failure and uploads it after configuration is fixed', async () => {
    const { repoDir, configDir } = makeRepo({ batchSize: 1 });
    await enqueueContribution(makeRow('a'), { repoDir, configDir });

    const failed = await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
    });
    assert.equal(failed.status, 'permanent_failure');
    assert.equal(hokusaiQueueStatus({ repoDir, configDir }).deadLetterCount, 1);

    const requeued = await requeueDeadLetterEntries({}, {
      repoDir,
      configDir,
      now: new Date('2026-06-03T12:00:00.000Z'),
    });
    assert.equal(requeued.status, 'requeued');

    const uploaded = await drainContributionQueue({
      repoDir,
      configDir,
      now: new Date('2026-06-03T12:00:00.000Z'),
      fetchImpl: async () => new Response(JSON.stringify({ jobIds: ['job-recovered'] }), { status: 200 }),
    });

    assert.equal(uploaded.status, 'uploaded');
    assert.deepEqual(uploaded.jobIds, ['job-recovered']);
    const deadLetterPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'dead-letter.jsonl');
    assert.equal(readFileSync(deadLetterPath, 'utf-8'), '');
    assert.equal(hokusaiQueueStatus({ repoDir, configDir }).deadLetterCount, 0);
  });

  it('deduplicates accepted submissions by job id in summary', async () => {
    const { repoDir, configDir } = makeRepo({ batchSize: 1 });
    await enqueueContribution(makeRow('a'), { repoDir, configDir });
    await enqueueContribution(makeRow('b'), { repoDir, configDir });
    await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(JSON.stringify({ jobIds: ['job-1'] }), { status: 200 }),
    });
    await drainContributionQueue({
      repoDir,
      configDir,
      fetchImpl: async () => new Response(JSON.stringify({ jobIds: ['job-1'] }), { status: 200 }),
    });

    const summary = summarizeHokusaiLedger({ repoDir, configDir });
    assert.equal(summary.acceptedSubmissionCount, 1);
  });
});
