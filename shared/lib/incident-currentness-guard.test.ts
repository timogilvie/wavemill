import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { INCIDENT_CURRENTNESS_GUARD } from './incident-currentness-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('incident-currentness guard — fleet correlation', () => {
  it('rejects a scratch cross-task grouping outside the incident path', () => {
    const patterns = checkGuardSource(
      INCIDENT_CURRENTNESS_GUARD,
      'shared/lib/scratch-fleet-detector.ts',
      'const groups = failures.reduce((groups, failure) => groups.set(failure.taskId, failure), new Map());\n',
    ).map((finding) => finding.pattern);
    assert.ok(patterns.includes('private-cross-task-grouping'));
  });

  it('passes at HEAD', () => {
    const result = runSourceGuard(INCIDENT_CURRENTNESS_GUARD, repoRoot);
    assert.deepEqual(result.findings, []);
  });
});

describe('incident-currentness guard — job outcome classification', () => {
  it('rejects classifying a job from result-file presence', () => {
    const patterns = checkGuardSource(
      INCIDENT_CURRENTNESS_GUARD,
      'shared/lib/wavemill-incident-detector.ts',
      'const missingResult = job.resultPath ? !existsSync(job.resultPath) : false;\n',
    ).map((finding) => finding.pattern);
    assert.ok(patterns.includes('job-result-presence-classification'));
  });
});
