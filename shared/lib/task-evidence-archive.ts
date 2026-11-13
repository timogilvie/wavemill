/** HOK-3475: capture the shared task inventory before releasing any resources. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveRouteArtifactArchiveDir } from './evals-paths.ts';
import {
  TASK_EVIDENCE_MANIFEST, taskEvidenceNames, resolveTaskArtifactDirs,
  type ArchivedEvidenceFile, type TaskEvidenceManifest,
} from './task-artifact-lookup.ts';
import { discoverOwnedSessionEvidence, resolveCodexSessionRoots } from './session-adapters.ts';
import { appendSessionRefResolution, readOwnershipFiles, SESSION_OWNERSHIP_FILE } from './session-ownership.ts';
import { resolveCodexLaunchNonces } from './codex-rollout-resolver.ts';
import { appendTraceEventSync, loadTraceContext } from './trace-event.ts';

export interface ArchiveTaskEvidenceInput { issueId: string; slug: string; repoDir: string; worktreeDir: string }

function sha256(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }

/** Read-back verification and atomic publication; a failed copy never reports success. */
function capture(archiveDir: string, relativePath: string, source: string, data: Buffer): ArchivedEvidenceFile {
  const path = join(archiveDir, relativePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    const sha = sha256(data);
    if (sha256(readFileSync(tmp)) !== sha) throw new Error(`Archive integrity check failed: ${source}`);
    renameSync(tmp, path);
    return { path: relativePath, sha256: sha, bytes: data.length, source };
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export function archiveTaskEvidence(input: ArchiveTaskEvidenceInput, logger: Pick<Console, 'warn'> = console): TaskEvidenceManifest {
  const archiveDir = resolveRouteArtifactArchiveDir(input.issueId, input.repoDir);
  if (!archiveDir) throw new Error('No task artifact archive directory');
  const dirs = resolveTaskArtifactDirs(input);
  const featureDir = dirs.liveFeatureDirs[0];
  const inventory: TaskEvidenceManifest = {
    schemaVersion: 1, issueId: input.issueId, capturedAt: new Date().toISOString(),
    artifacts: [], absentArtifacts: [], sessions: [],
  };
  if (!featureDir) return inventory;
  // Resolve through the existing nonce contract, before freezing ownership.
  const ownershipFile = join(featureDir, SESSION_OWNERSHIP_FILE);
  let ownership = readOwnershipFiles([ownershipFile]);
  for (const [pending, exact] of resolveCodexLaunchNonces(ownership.rows, resolveCodexSessionRoots(input.repoDir, input.issueId))) {
    appendSessionRefResolution(featureDir, pending, exact);
  }
  ownership = readOwnershipFiles([ownershipFile]);
  if (ownership.malformedLines) logger.warn(`Archive ownership contains ${ownership.malformedLines} malformed line(s); retained as evidence`);
  const sources = discoverOwnedSessionEvidence(ownership.rows, {
    repoDir: input.repoDir, worktreePath: input.worktreeDir, issueId: input.issueId,
  });
  for (const { row, status, files } of sources) {
    const entry: TaskEvidenceManifest['sessions'][number] = {
      sessionRef: row.sessionRef, harness: row.harness, attemptId: row.attemptId,
      ...(row.cwd ? { cwd: row.cwd } : {}), status, files: [],
    };
    const seen = new Set<string>();
    for (const file of files) {
      const hash = sha256(file.data);
      if (seen.has(hash)) continue;
      seen.add(hash);
      const name = basename(file.source).replace(/\.zst$/, '');
      entry.files.push(capture(archiveDir, join('session-evidence', row.harness, hash, name), file.source, file.data));
      if (file.compressedData) {
        const rawHash = sha256(file.compressedData);
        entry.files.push(capture(archiveDir, join('session-evidence', row.harness, rawHash, basename(file.source)), file.source, file.compressedData));
      }
    }
    if (status !== 'archived') logger.warn(`Archive session evidence ${status}: ${row.harness} ${row.sessionRef}`);
    inventory.sessions.push(entry);
  }
  const copyArtifact = (name: string) => {
    const source = join(featureDir, name);
    if (!existsSync(source)) {
      // A previous attempt's result is history, never the current result.
      const previous = join(archiveDir, name);
      if (existsSync(previous)) {
        const data = readFileSync(previous);
        capture(archiveDir, join('.stale-artifacts', 'previous-archive', sha256(data), basename(name)), previous, data);
        unlinkSync(previous);
      }
      inventory.absentArtifacts.push(name);
      return;
    }
    const data = readFileSync(source);
    let status: 'archived' | 'invalid-json' = 'archived';
    if (name.endsWith('.json') || name === '.routing-complete') {
      try { JSON.parse(data.toString('utf8')); }
      catch {
        status = 'invalid-json';
        logger.warn(`Archived invalid ${name.includes('-result') ? 'stage result' : 'artifact'} bytes: ${source}`);
      }
    }
    const file = capture(archiveDir, name, source, data);
    inventory.artifacts = inventory.artifacts.filter(r => r.name !== name);
    inventory.artifacts.push({ ...file, name, status });
  };
  for (const name of taskEvidenceNames(featureDir)) copyArtifact(name);
  const context = loadTraceContext(featureDir);
  if (context) {
    appendTraceEventSync(context, { phase: 'cleanup', event: 'cleanup_archived', status: 'ok', meta: { archiveDir } });
    copyArtifact('trace.jsonl');
  }
  // Commit the index last. Interrupted/failed captures leave bytes for replay,
  // but do not publish a new claim that the whole inventory was preserved.
  capture(archiveDir, TASK_EVIDENCE_MANIFEST, resolve(featureDir), Buffer.from(JSON.stringify(inventory, null, 2) + '\n'));
  return inventory;
}
