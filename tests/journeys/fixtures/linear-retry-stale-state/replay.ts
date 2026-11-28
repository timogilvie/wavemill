import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { drain, type PendingRetryRecord } from '../../../../shared/lib/linear-retry-queue.ts';

const [repoDir, issueId] = process.argv.slice(2);
if (!repoDir || !issueId) throw new Error('usage: replay.ts <repo-dir> <issue-id>');

const path = join(repoDir, '.wavemill', 'registry', 'linear-retry-queue.jsonl');
mkdirSync(dirname(path), { recursive: true });
const pending: PendingRetryRecord = {
  schemaVersion: '1.0',
  recordType: 'pending',
  id: 'journey-hok-3520',
  enqueuedAt: '2026-11-09T16:24:15Z',
  issueIds: [issueId],
  targetState: 'In Progress',
  attempts: 1,
  nextRetryAt: '2026-11-09T16:25:15Z',
  lastError: { category: 'network', httpStatus: null, graphqlErrors: [], isRetryable: true, message: 'timeout', error: 'timeout' },
};
writeFileSync(path, `${JSON.stringify(pending)}\n`);

const result = await drain({ repoDir, now: new Date('2026-11-10T17:20:00Z') });
assert.equal(result.dropped, 1);
const records = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
assert.equal(records.at(-1)?.recordType, 'dropped');
