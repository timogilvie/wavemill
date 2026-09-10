/**
 * Shadow cleanup decision ledger (HOK-2957).
 *
 * Append-only JSONL sink for proposed cleanup decisions. In shadow mode the
 * ledger captures the full evidence that would have supported a delete
 * without executing it; in enforce mode the same entry documents the
 * decision that authorized the delete. Audit tools cross-check both.
 *
 * Writes are best-effort: a filesystem failure never blocks the caller.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { getCleanupConfig, resolveBranchDeletionMode, type BranchDeletionMode, CLEANUP_BRANCH_DELETION_DEFAULT_LEDGER_PATH } from './config.ts';

export interface ShadowCleanupEvidence {
  prNumber?: string | number | null;
  prState?: string | null;
  prHeadSha?: string | null;
  mergeSha?: string | null;
  remoteHead?: string | null;
  localHead?: string | null;
  finalHead?: string | null;
  baseBranch?: string | null;
  commitsAhead?: string | number | null;
  site?: string | null;
  [key: string]: unknown;
}

export interface ShadowCleanupAuthority {
  branchDeletionAuthorized?: boolean;
  deleteBranchAfterMerge?: boolean;
  policy?: string;
  classification?: string;
  cleanupAuthority?: string;
  caller?: string;
  scope?: string;
  [key: string]: unknown;
}

export interface ShadowCleanupDecision {
  ts?: string;
  session?: string;
  issue?: string;
  branch?: string;
  proposedAction?: string;
  classification?: string;
  evidence?: ShadowCleanupEvidence;
  authority?: ShadowCleanupAuthority;
  mode: BranchDeletionMode;
  wouldDelete: boolean;
}

export function resolveShadowLedgerPath(repoDir: string, relative?: string): string {
  const rel = relative && relative.length > 0 ? relative : CLEANUP_BRANCH_DELETION_DEFAULT_LEDGER_PATH;
  return isAbsolute(rel) ? rel : join(repoDir, rel);
}

/**
 * Append a decision to the shadow ledger. Silent no-op on failure.
 */
export function appendShadowCleanupDecision(
  repoDir: string,
  decision: ShadowCleanupDecision,
): void {
  try {
    const cleanup = getCleanupConfig(repoDir);
    const ledgerPath = resolveShadowLedgerPath(repoDir, cleanup.branchDeletion?.ledgerPath);
    const dir = dirname(ledgerPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const entry = {
      ts: decision.ts || new Date().toISOString(),
      session: decision.session || process.env.WAVEMILL_SESSION || '',
      issue: decision.issue || '',
      branch: decision.branch || '',
      proposedAction: decision.proposedAction || 'delete_branch',
      classification: decision.classification || '',
      evidence: decision.evidence || {},
      authority: decision.authority || {},
      mode: decision.mode,
      wouldDelete: decision.wouldDelete,
    };
    appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort: ledger writes never block a cleanup path.
  }
}

/**
 * Read the shadow ledger. Returns an empty array when the file is missing or unreadable.
 */
export function readShadowLedger(
  repoDir: string,
  relative?: string,
): ShadowCleanupDecision[] {
  const cleanup = getCleanupConfig(repoDir);
  const ledgerPath = resolveShadowLedgerPath(repoDir, relative ?? cleanup.branchDeletion?.ledgerPath);
  if (!existsSync(ledgerPath)) return [];
  try {
    const raw = readFileSync(ledgerPath, 'utf-8');
    const entries: ShadowCleanupDecision[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as ShadowCleanupDecision);
      } catch {
        // ignore malformed line
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Compute the effective mode (env override or config default).
 */
export function currentBranchDeletionMode(repoDir: string): BranchDeletionMode {
  return resolveBranchDeletionMode(getCleanupConfig(repoDir).branchDeletion);
}
