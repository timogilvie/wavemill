// Session metadata capture and persistence for wavemill workflows.
// All operations are non-intrusive: wrapped in try/catch, never throw, never block.

import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';

/**
 * @typedef {'feature' | 'bugfix' | 'plan' | 'validate-plan' | 'implement-plan'} WorkflowType
 * @typedef {'running' | 'completed' | 'failed' | 'cancelled'} SessionStatus
 *
 * @typedef {Object} SessionMetadata
 * @property {string} sessionId
 * @property {WorkflowType} workflowType
 * @property {string} [issueId]
 * @property {string} prompt
 * @property {string} model
 * @property {string} [modelVersion]
 * @property {string} startedAt
 * @property {string} [completedAt]
 * @property {number} [executionTimeMs]
 * @property {number} [userWaitTimeMs]
 * @property {string} [prIdentifier]
 * @property {SessionStatus} status
 * @property {string} [error]
 */

const SCHEMA_VERSION = '1.0.0';

/**
 * Resolve the sessions directory, creating it if needed.
 * @param {string} [repoDir]
 * @returns {Promise<string>}
 */
async function sessionsDir(repoDir) {
  const dir = join(repoDir || process.cwd(), '.wavemill', 'sessions');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Write a session to disk (both latest.json and archive).
 * @param {string} dir
 * @param {SessionMetadata} session
 */
async function persist(dir, session) {
  const json = JSON.stringify(session, null, 2);
  await Promise.all([
    writeFile(join(dir, 'latest.json'), json, 'utf-8'),
    writeFile(join(dir, `${session.sessionId}.json`), json, 'utf-8'),
  ]);
}

/**
 * Create a new session and persist it with status 'running'.
 *
 * @param {Object} opts
 * @param {WorkflowType} opts.workflowType
 * @param {string} opts.prompt
 * @param {string} opts.model
 * @param {string} [opts.modelVersion]
 * @param {string} [opts.issueId]
 * @param {string} [opts.repoDir]
 * @returns {Promise<string|null>} sessionId, or null on failure
 */
export async function createSession(opts) {
  try {
    const dir = await sessionsDir(opts?.repoDir);
    const session = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: randomUUID(),
      workflowType: opts.workflowType,
      ...(opts.issueId && { issueId: opts.issueId }),
      prompt: opts.prompt || '',
      model: opts.model || 'unknown',
      ...(opts.modelVersion && { modelVersion: opts.modelVersion }),
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    await persist(dir, session);
    return session.sessionId;
  } catch (err) {
    console.warn(`[session] Failed to create session: ${err.message}`);
    return null;
  }
}

/**
 * Merge updates into an existing session file.
 *
 * @param {string} sessionId
 * @param {Partial<SessionMetadata>} updates
 * @param {string} [repoDir]
 * @returns {Promise<boolean>}
 */
export async function updateSession(sessionId, updates, repoDir) {
  try {
    const dir = await sessionsDir(repoDir);
    const filePath = join(dir, `${sessionId}.json`);
    const existing = JSON.parse(await readFile(filePath, 'utf-8'));
    const merged = { ...existing, ...updates };
    await persist(dir, merged);
    return true;
  } catch (err) {
    console.warn(`[session] Failed to update session ${sessionId}: ${err.message}`);
    return false;
  }
}

/**
 * Finalize a session with completion details.
 *
 * @param {string} sessionId
 * @param {Object} opts
 * @param {number} [opts.executionTimeMs]
 * @param {number} [opts.userWaitTimeMs]
 * @param {SessionStatus} opts.status
 * @param {string} [opts.prIdentifier]
 * @param {string} [opts.error]
 * @param {string} [opts.repoDir]
 * @returns {Promise<boolean>}
 */
export async function completeSession(sessionId, opts) {
  try {
    const dir = await sessionsDir(opts?.repoDir);
    const filePath = join(dir, `${sessionId}.json`);
    const existing = JSON.parse(await readFile(filePath, 'utf-8'));
    const merged = {
      ...existing,
      completedAt: new Date().toISOString(),
      status: opts.status || 'completed',
      ...(opts.executionTimeMs !== undefined && { executionTimeMs: opts.executionTimeMs }),
      ...(opts.userWaitTimeMs !== undefined && { userWaitTimeMs: opts.userWaitTimeMs }),
      ...(opts.prIdentifier && { prIdentifier: opts.prIdentifier }),
      ...(opts.error && { error: opts.error }),
    };
    await persist(dir, merged);
    return true;
  } catch (err) {
    console.warn(`[session] Failed to complete session ${sessionId}: ${err.message}`);
    return false;
  }
}

/**
 * Read the most recent session from latest.json.
 *
 * @param {string} [repoDir]
 * @returns {Promise<SessionMetadata|null>}
 */
export async function getLatestSession(repoDir) {
  try {
    const dir = await sessionsDir(repoDir);
    const filePath = join(dir, 'latest.json');
    return JSON.parse(await readFile(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`[session] Failed to read latest session: ${err.message}`);
    return null;
  }
}

/**
 * Read a specific session by ID.
 *
 * @param {string} sessionId
 * @param {string} [repoDir]
 * @returns {Promise<SessionMetadata|null>}
 */
export async function getSession(sessionId, repoDir) {
  try {
    const dir = await sessionsDir(repoDir);
    const filePath = join(dir, `${sessionId}.json`);
    return JSON.parse(await readFile(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`[session] Failed to read session ${sessionId}: ${err.message}`);
    return null;
  }
}
