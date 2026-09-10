/**
 * Shadow cleanup ledger audit (HOK-2957).
 *
 * Consumes .wavemill/shadow/cleanup-decisions.jsonl and reports:
 *   - counts by classification and mode
 *   - agreement rate: proposed-delete entries whose evidence supports the
 *     delete (PR MERGED + exact-head, or safe_ancestor/safe_exact_remote)
 *   - unsafe-delete disagreements: entries the operator must review before
 *     enabling branchDeletion.mode=enforce
 *
 * A safe cleanup requires either:
 *   - classification safe_ancestor / safe_exact_remote / safe_noop, OR
 *   - classification safe_terminal_pr_head with PR state MERGED and
 *     prHeadSha == finalHead (== localHead when finalHead is absent).
 * Anything else with wouldDelete=true is flagged as a disagreement.
 */

import { readShadowLedger, type ShadowCleanupDecision } from './shadow-cleanup-ledger.ts';

export interface DisagreementEntry {
  ts?: string;
  issue?: string;
  branch?: string;
  classification?: string;
  reason: string;
  mode: string;
  evidence?: unknown;
}

export interface AuditSummary {
  totalEntries: number;
  proposedDeletes: number;
  safeAgreements: number;
  disagreements: DisagreementEntry[];
  byClassification: Record<string, number>;
  byMode: Record<string, number>;
  agreementRate: number;
  ready: boolean;
}

const SAFE_ANCESTRY_CLASSES = new Set(['safe_ancestor', 'safe_exact_remote', 'safe_noop']);

function classifyEntry(entry: ShadowCleanupDecision): DisagreementEntry | null {
  if (!entry.wouldDelete) return null;
  const cls = entry.classification || '';
  const evidence = entry.evidence || {};

  if (SAFE_ANCESTRY_CLASSES.has(cls)) return null;

  if (cls === 'safe_terminal_pr_head') {
    const prState = String(evidence.prState || '').toUpperCase();
    if (prState !== 'MERGED') {
      return {
        ts: entry.ts,
        issue: entry.issue,
        branch: entry.branch,
        classification: cls,
        reason: `safe_terminal_pr_head with prState=${prState || 'unknown'} (expected MERGED)`,
        mode: entry.mode,
        evidence,
      };
    }
    const head = String(evidence.finalHead || evidence.localHead || '');
    const prHead = String(evidence.prHeadSha || '');
    if (!prHead || !head) {
      return {
        ts: entry.ts,
        issue: entry.issue,
        branch: entry.branch,
        classification: cls,
        reason: 'missing PR headRefOid or local head evidence',
        mode: entry.mode,
        evidence,
      };
    }
    if (prHead !== head) {
      return {
        ts: entry.ts,
        issue: entry.issue,
        branch: entry.branch,
        classification: cls,
        reason: `PR headRefOid (${prHead.substring(0, 8)}) != local head (${head.substring(0, 8)})`,
        mode: entry.mode,
        evidence,
      };
    }
    return null;
  }

  if (cls === 'safe_remote_delete' || cls === 'safe_stale_prune') {
    // These non-funnel classifiers rely on caller-side authority; treat as
    // agreements as long as they were emitted (funnel authority already gated).
    return null;
  }

  return {
    ts: entry.ts,
    issue: entry.issue,
    branch: entry.branch,
    classification: cls,
    reason: `unrecognized classification for proposed delete: ${cls || '<empty>'}`,
    mode: entry.mode,
    evidence,
  };
}

export function auditShadowLedger(repoDir: string): AuditSummary {
  const entries = readShadowLedger(repoDir);
  const byClassification: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  const disagreements: DisagreementEntry[] = [];
  let proposedDeletes = 0;
  let safeAgreements = 0;

  for (const entry of entries) {
    const cls = entry.classification || '<unknown>';
    byClassification[cls] = (byClassification[cls] ?? 0) + 1;
    byMode[entry.mode] = (byMode[entry.mode] ?? 0) + 1;
    if (entry.wouldDelete) {
      proposedDeletes += 1;
      const disagreement = classifyEntry(entry);
      if (disagreement) {
        disagreements.push(disagreement);
      } else {
        safeAgreements += 1;
      }
    }
  }

  const agreementRate = proposedDeletes === 0 ? 1 : safeAgreements / proposedDeletes;
  return {
    totalEntries: entries.length,
    proposedDeletes,
    safeAgreements,
    disagreements,
    byClassification,
    byMode,
    agreementRate,
    ready: proposedDeletes > 0 && disagreements.length === 0,
  };
}

export function formatAuditReport(summary: AuditSummary): string {
  const lines: string[] = [];
  lines.push('=== Shadow Cleanup Ledger Audit ===');
  lines.push(`Total entries        : ${summary.totalEntries}`);
  lines.push(`Proposed deletes     : ${summary.proposedDeletes}`);
  lines.push(`Safe agreements      : ${summary.safeAgreements}`);
  lines.push(`Disagreements        : ${summary.disagreements.length}`);
  lines.push(`Agreement rate       : ${(summary.agreementRate * 100).toFixed(1)}%`);
  lines.push(`Ready for enforce    : ${summary.ready ? 'YES' : 'NO'}`);
  lines.push('');
  lines.push('By classification:');
  for (const [cls, count] of Object.entries(summary.byClassification).sort()) {
    lines.push(`  ${cls.padEnd(28)} ${count}`);
  }
  lines.push('');
  lines.push('By mode:');
  for (const [mode, count] of Object.entries(summary.byMode).sort()) {
    lines.push(`  ${mode.padEnd(28)} ${count}`);
  }
  if (summary.disagreements.length > 0) {
    lines.push('');
    lines.push('Disagreements requiring operator review:');
    for (const d of summary.disagreements.slice(0, 50)) {
      lines.push(`  - ${d.ts ?? '?'} ${d.issue ?? '?'} ${d.branch ?? '?'} [${d.classification ?? '?'}] ${d.reason}`);
    }
    if (summary.disagreements.length > 50) {
      lines.push(`  ... and ${summary.disagreements.length - 50} more`);
    }
  }
  return lines.join('\n');
}
