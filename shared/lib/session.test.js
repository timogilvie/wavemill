import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createSession,
  updateSession,
  completeSession,
  getLatestSession,
  getSession,
} from './session.js';

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'session-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('createSession', () => {
  it('creates a session and returns a sessionId', async () => {
    const id = await createSession({
      workflowType: 'feature',
      prompt: 'Add authentication',
      model: 'claude-opus-4-6',
      repoDir: tempDir,
    });
    assert.ok(id, 'should return a sessionId');
    assert.ok(typeof id === 'string');
    assert.ok(id.length > 0);
  });

  it('persists latest.json and archive file', async () => {
    const id = await createSession({
      workflowType: 'feature',
      prompt: 'Add auth',
      model: 'test-model',
      repoDir: tempDir,
    });
    const sessionsDir = join(tempDir, '.wavemill', 'sessions');
    assert.ok(existsSync(join(sessionsDir, 'latest.json')));
    assert.ok(existsSync(join(sessionsDir, `${id}.json`)));
  });

  it('writes all required fields', async () => {
    const id = await createSession({
      workflowType: 'bugfix',
      prompt: 'Fix crash on login',
      model: 'claude-opus-4-6',
      issueId: 'HOK-701',
      repoDir: tempDir,
    });
    const sessionsDir = join(tempDir, '.wavemill', 'sessions');
    const data = JSON.parse(await readFile(join(sessionsDir, 'latest.json'), 'utf-8'));

    assert.equal(data.sessionId, id);
    assert.equal(data.schemaVersion, '1.0.0');
    assert.equal(data.workflowType, 'bugfix');
    assert.equal(data.prompt, 'Fix crash on login');
    assert.equal(data.model, 'claude-opus-4-6');
    assert.equal(data.issueId, 'HOK-701');
    assert.equal(data.status, 'running');
    assert.ok(data.startedAt);
  });

  it('returns null and warns on invalid input (never throws)', async () => {
    const id = await createSession(null);
    assert.equal(id, null);
  });

  it('omits optional fields when not provided', async () => {
    const id = await createSession({
      workflowType: 'plan',
      prompt: 'Plan the migration',
      model: 'test-model',
      repoDir: tempDir,
    });
    const sessionsDir = join(tempDir, '.wavemill', 'sessions');
    const data = JSON.parse(await readFile(join(sessionsDir, `${id}.json`), 'utf-8'));

    assert.equal(data.issueId, undefined);
    assert.equal(data.modelVersion, undefined);
  });
});

describe('updateSession', () => {
  it('merges updates into existing session', async () => {
    const id = await createSession({
      workflowType: 'feature',
      prompt: 'Add feature',
      model: 'test-model',
      repoDir: tempDir,
    });
    const result = await updateSession(id, { prIdentifier: 'https://github.com/pr/42' }, tempDir);
    assert.equal(result, true);

    const session = await getSession(id, tempDir);
    assert.equal(session.prIdentifier, 'https://github.com/pr/42');
    assert.equal(session.workflowType, 'feature'); // original field preserved
  });

  it('returns false on missing session', async () => {
    const result = await updateSession('nonexistent-id', { prIdentifier: 'x' }, tempDir);
    assert.equal(result, false);
  });
});

describe('completeSession', () => {
  it('finalizes a session with completion details', async () => {
    const id = await createSession({
      workflowType: 'feature',
      prompt: 'test',
      model: 'test-model',
      repoDir: tempDir,
    });
    const result = await completeSession(id, {
      status: 'completed',
      executionTimeMs: 15000,
      userWaitTimeMs: 5000,
      prIdentifier: 'https://github.com/pr/99',
      repoDir: tempDir,
    });
    assert.equal(result, true);

    const session = await getSession(id, tempDir);
    assert.equal(session.status, 'completed');
    assert.equal(session.executionTimeMs, 15000);
    assert.equal(session.userWaitTimeMs, 5000);
    assert.equal(session.prIdentifier, 'https://github.com/pr/99');
    assert.ok(session.completedAt);
  });

  it('records failed status with error message', async () => {
    const id = await createSession({
      workflowType: 'bugfix',
      prompt: 'test',
      model: 'test-model',
      repoDir: tempDir,
    });
    await completeSession(id, {
      status: 'failed',
      error: 'Build failed',
      repoDir: tempDir,
    });

    const session = await getSession(id, tempDir);
    assert.equal(session.status, 'failed');
    assert.equal(session.error, 'Build failed');
  });
});

describe('getLatestSession', () => {
  it('returns the most recently created session', async () => {
    await createSession({
      workflowType: 'feature',
      prompt: 'first',
      model: 'model-1',
      repoDir: tempDir,
    });
    const id2 = await createSession({
      workflowType: 'bugfix',
      prompt: 'second',
      model: 'model-2',
      repoDir: tempDir,
    });

    const latest = await getLatestSession(tempDir);
    assert.equal(latest.sessionId, id2);
    assert.equal(latest.prompt, 'second');
  });

  it('returns null when no sessions exist', async () => {
    const result = await getLatestSession(tempDir);
    assert.equal(result, null);
  });
});

describe('getSession', () => {
  it('retrieves a session by ID', async () => {
    const id = await createSession({
      workflowType: 'plan',
      prompt: 'plan test',
      model: 'test-model',
      repoDir: tempDir,
    });
    const session = await getSession(id, tempDir);
    assert.equal(session.sessionId, id);
    assert.equal(session.workflowType, 'plan');
  });

  it('returns null for nonexistent session', async () => {
    const result = await getSession('no-such-id', tempDir);
    assert.equal(result, null);
  });
});

describe('full lifecycle', () => {
  it('create → update → complete → get produces valid session with all fields', async () => {
    const id = await createSession({
      workflowType: 'feature',
      prompt: 'Full lifecycle test',
      model: 'claude-opus-4-6',
      issueId: 'HOK-999',
      repoDir: tempDir,
    });

    await updateSession(id, { prIdentifier: 'https://github.com/pr/100' }, tempDir);

    await completeSession(id, {
      status: 'completed',
      executionTimeMs: 30000,
      userWaitTimeMs: 10000,
      prIdentifier: 'https://github.com/pr/100',
      repoDir: tempDir,
    });

    const session = await getLatestSession(tempDir);
    const requiredFields = [
      'sessionId', 'workflowType', 'prompt', 'model',
      'startedAt', 'completedAt', 'executionTimeMs', 'status',
    ];
    const missing = requiredFields.filter((f) => !(f in session));
    assert.equal(missing.length, 0, `Missing fields: ${missing.join(', ')}`);
    assert.equal(session.prIdentifier, 'https://github.com/pr/100');
    assert.equal(session.issueId, 'HOK-999');
    assert.equal(session.userWaitTimeMs, 10000);
  });
});
