/**
 * Durable certification identity invalidation (HOK-3143).
 *
 * Shared by the runtime (`loop.ts` + launchers) and the operator CLI
 * (`tools/native-agent-certifications-identity.ts`). The runtime invokes
 * {@link invalidateCertificationIdentity} on a provider-identity mismatch;
 * the CLI calls the audit writer to log operator-initiated invalidations.
 *
 * Writes are atomic (tmp → fsync → rename) and idempotent: an artifact that
 * already carries `identityInvalidation` is left unchanged (first-writer
 * wins), so concurrent challenge arms are safe.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { readCertification, writeCertificationToAbsolutePath } from './store.ts';
import {
  isRevisionAwareArtifact,
  type IdentityInvalidation,
  type IdentityInvalidationSource,
  type NativeCertificationArtifact,
} from './schema.ts';

export type IdentityAuditOperation = 'reidentify' | 'invalidate';

/**
 * Shape of the on-disk audit record under `<storageRoot>/.audits/`.
 * Written by both the operator CLI and the runtime on hard invalidation,
 * so operators can trace every identity change in one place.
 */
export interface IdentityAuditArtifact {
  schemaVersion: 1;
  operation: IdentityAuditOperation;
  dryRun: boolean;
  reason: string;
  createdAt: string;
  requested: {
    provider: string;
    model: string;
  };
  oldSubjects: unknown[];
  newSubject?: unknown;
  affectedArtifactPaths: string[];
  recertificationCommands: string[];
}

export type IdentityInvalidationStatus =
  | 'invalidated'
  | 'already-invalidated'
  | 'legacy-artifact'
  | 'skipped';

export interface IdentityInvalidationResult {
  status: IdentityInvalidationStatus;
  /** Absolute path of the artifact that was examined. */
  artifactPath: string;
  /** Path of the audit record written under `<storageRoot>/.audits/`, when applicable. */
  auditPath?: string;
  /** Suggested recertification command. */
  recertCommand: string;
  /** Diagnostic message when the write was skipped. */
  detail?: string;
}

/**
 * Write a deterministic, sorted-key JSON audit record to
 * `<storageRoot>/.audits/<timestamp>-<operation>-<rand>.json`.
 *
 * Thin wrapper around the standard atomic write dance (write → fsync →
 * rename → directory fsync). Exported so the CLI tool shares one
 * implementation with the runtime.
 */
export function writeIdentityAudit(storageRoot: string, audit: IdentityAuditArtifact): string {
  const finalPath = join(
    storageRoot,
    '.audits',
    `${audit.createdAt.replace(/[:.]/g, '-')}-${audit.operation}-${randomBytes(4).toString('hex')}.json`,
  );
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  writeFileSync(tmpPath, JSON.stringify(sortKeys(audit), null, 2) + '\n', 'utf8');
  try {
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Rename is the durability boundary.
  }
  try {
    renameSync(tmpPath, finalPath);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
  try {
    const dirFd = openSync(dirname(finalPath), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Best effort directory fsync.
  }
  return finalPath;
}

/** Deterministic key-sort (shared with `store.ts.serializeCertification`). */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((v as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return v;
}

/**
 * Rewrite a certification artifact with an `identityInvalidation` record.
 *
 * - If the artifact is missing or malformed, returns `skipped` without raising.
 *   The caller's own abort path still fires; identity-invalidation is defense
 *   in depth, not the only safety.
 * - If the artifact is a legacy (v2) record with no subject, nothing is
 *   rewritten (the launch gate rejects it on schema version instead).
 * - If `identityInvalidation` already exists, nothing is rewritten
 *   (first-writer-wins).
 * - Otherwise, the invalidation record is written and an audit entry is
 *   appended under `<storageRoot>/.audits/`.
 *
 * The audit `storageRoot` is derived from the artifact path by walking up two
 * directories (the on-disk layout is `<root>/<provider>/<model>/<suite>.json`).
 */
export interface InvalidateCertificationIdentityInput {
  artifactPath: string;
  expectedModel: string;
  observedModel: string;
  requestedWireId: string;
  source: IdentityInvalidationSource;
  phase?: string;
  session?: string;
  issue?: string;
  now?: () => Date;
}

export function invalidateCertificationIdentity(
  input: InvalidateCertificationIdentityInput,
): IdentityInvalidationResult {
  const now = (input.now ?? (() => new Date()))();
  const read = readCertification(input.artifactPath);
  const recertCommand = formatRecertCommand(input);

  if (!read.ok) {
    // Discriminated union narrowing is weak under tsconfig strict: false; cast.
    const failed = read as Extract<typeof read, { ok: false }>;
    return {
      status: 'skipped',
      artifactPath: input.artifactPath,
      recertCommand,
      detail: `${failed.error.code}: ${failed.error.message}`,
    };
  }

  if (!isRevisionAwareArtifact(read.artifact)) {
    return {
      status: 'legacy-artifact',
      artifactPath: input.artifactPath,
      recertCommand,
      detail: 'cannot invalidate legacy v2 artifact (recertification required)',
    };
  }

  const current = read.artifact as NativeCertificationArtifact;

  if (current.identityInvalidation) {
    return {
      status: 'already-invalidated',
      artifactPath: input.artifactPath,
      recertCommand,
    };
  }

  const invalidation: IdentityInvalidation = {
    invalidatedAt: now.toISOString(),
    reason: 'identity_mismatch',
    expectedModel: input.expectedModel,
    observedModel: input.observedModel,
    requestedWireId: input.requestedWireId,
    source: input.source,
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.session ? { session: input.session } : {}),
    ...(input.issue ? { issue: input.issue } : {}),
  };

  const rewritten: NativeCertificationArtifact = {
    ...current,
    identityInvalidation: invalidation,
  };

  writeCertificationToAbsolutePath(input.artifactPath, rewritten);

  const storageRoot = resolveStorageRootFromArtifactPath(input.artifactPath);
  let auditPath: string | undefined;
  try {
    const audit: IdentityAuditArtifact = {
      schemaVersion: 1,
      operation: 'invalidate',
      dryRun: false,
      reason: 'identity_mismatch',
      createdAt: now.toISOString(),
      requested: {
        provider: current.provider,
        model: current.model,
      },
      oldSubjects: [current.subject],
      affectedArtifactPaths: [input.artifactPath],
      recertificationCommands: [recertCommand],
    };
    auditPath = writeIdentityAudit(storageRoot, audit);
  } catch (error) {
    // Audit log is best-effort; the artifact rewrite is the authoritative record.
    console.warn(`identity-invalidation audit write failed: ${(error as Error).message}`);
  }

  return {
    status: 'invalidated',
    artifactPath: input.artifactPath,
    ...(auditPath ? { auditPath } : {}),
    recertCommand,
  };
}

function formatRecertCommand(input: InvalidateCertificationIdentityInput): string {
  const parts = [
    'wavemill native-agent certify',
    '--provider openrouter',
    `--model ${input.requestedWireId}`,
    '--phase workflow',
    '--live-coding-canary',
  ];
  return parts.join(' ');
}

/**
 * Walk up two directories from an artifact's absolute path to find the
 * storage root (`<root>/<provider>/<model>/<suite>.json`). Used only for
 * audit log placement — the write itself targets the exact path.
 */
function resolveStorageRootFromArtifactPath(artifactPath: string): string {
  return dirname(dirname(dirname(artifactPath)));
}
