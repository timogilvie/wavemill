/**
 * OpenRouter registry drift → one Linear maintenance issue.
 *
 * Pull requests no longer fail on catalog drift they did not introduce, so the
 * scheduled audit is what surfaces it. This module decides which findings have
 * persisted across two consecutive audits (a reference price can flap for a
 * few hours) and keeps exactly one open Linear issue describing them, so the
 * mill picks the reconciliation up as ordinary backlog work.
 *
 * This is routine catalog maintenance, not defect escalation: nothing in
 * Wavemill is broken, a provider changed a price.
 *
 * @module openrouter-drift-issue
 */

import type { AliasAuditFinding, AliasAuditReport } from './openrouter-alias-audit.ts';

/** Fixed title: the open issue is found again by this exact text. */
export const DRIFT_ISSUE_TITLE = 'Reconcile model registry with the OpenRouter catalog';
/** Linear priority 2 = High. */
export const DRIFT_ISSUE_PRIORITY = 2;
const FINDINGS_MARKER = '<!-- openrouter-drift-findings:';

const findingKey = (finding: AliasAuditFinding): string => `${finding.alias}\u0000${finding.reason}`;

/**
 * Selectable findings present in both audits, keyed by alias and reason. With
 * no previous report nothing has persisted yet: the next run decides.
 */
export function persistentDriftFindings(
  current: AliasAuditReport,
  previous: AliasAuditReport | null,
): AliasAuditFinding[] {
  if (!previous) return [];
  const seenBefore = new Set(previous.findings.filter((finding) => finding.selectable).map(findingKey));
  return current.findings
    .filter((finding) => finding.selectable && seenBefore.has(findingKey(finding)))
    .sort((a, b) => findingKey(a).localeCompare(findingKey(b)));
}

/** Stable identity of a finding set; a changed price changes it, a new timestamp does not. */
export function driftFingerprint(findings: readonly AliasAuditFinding[]): string {
  return findings
    .map((finding) => [finding.alias, finding.reason, finding.expected ?? '', finding.actual ?? ''].join(':'))
    .sort()
    .join('|');
}

const cell = (value: unknown): string => String(value ?? '—').replace(/\|/g, '\\|');

export function renderDriftIssueDescription(findings: readonly AliasAuditFinding[], auditedAt: string): string {
  return [
    'The scheduled OpenRouter alias audit found registry entries that disagree with the live catalog in two consecutive runs.',
    'Until they are reconciled, cost accounting uses the registry values.',
    '',
    `Last audit: ${auditedAt}`,
    '',
    '| Alias | OpenRouter model | Finding | Registry | Reference | Detail |',
    '| -- | -- | -- | -- | -- | -- |',
    ...findings.map((finding) => (
      `| \`${cell(finding.alias)}\` | \`${cell(finding.wireModelId)}\` | ${cell(finding.reason)} | ${cell(finding.actual)} | ${cell(finding.expected)} | ${cell(finding.detail)} |`
    )),
    '',
    '## What to do',
    '',
    '1. Run `npx tsx tools/audit-openrouter-aliases.ts`. If it reports no selectable findings, the drift cleared upstream: cancel this issue without a change.',
    '2. Otherwise follow the "OpenRouter Catalog Maintenance Runbook" in `docs/model-additions.md`. For `pricing-drift`, set the `capabilities.pricing` field named in the finding to the reference value in `shared/fixtures/model-registry.v1.json`, and keep the mirrored per-million cost scalars consistent.',
    '3. Do not edit the audit, its tolerance or the CI path filters to make a finding disappear.',
    '',
    '## Done when',
    '',
    '`npx tsx tools/audit-openrouter-aliases.ts` exits 0 on the branch.',
    '',
    `${FINDINGS_MARKER}${driftFingerprint(findings)} -->`,
  ].join('\n');
}

/** The fingerprint recorded in an issue description written by {@link renderDriftIssueDescription}. */
export function readDriftFingerprint(description: string | null | undefined): string | null {
  const start = (description ?? '').lastIndexOf(FINDINGS_MARKER);
  if (start === -1) return null;
  const end = description!.indexOf(' -->', start);
  return end === -1 ? null : description!.slice(start + FINDINGS_MARKER.length, end);
}

export interface DriftIssueRef {
  id: string;
  identifier: string;
  description?: string | null;
}

/** The Linear operations the sync needs; injected so tests never reach Linear. */
export interface DriftIssueClient {
  /** The open (not completed, not canceled) issue with exactly this title in the project, if any. */
  findOpenIssue(title: string): Promise<DriftIssueRef | null>;
  fileIssue(input: { title: string; description: string; priority: number }): Promise<DriftIssueRef>;
  updateDescription(issueId: string, description: string): Promise<void>;
}

export type DriftIssueOutcome =
  | { action: 'none'; reason: 'no-persistent-drift' }
  | { action: 'left-open'; identifier: string; reason: 'drift-cleared' }
  | { action: 'unchanged'; identifier: string }
  | { action: 'updated'; identifier: string }
  | { action: 'created'; identifier: string };

/**
 * Keep one open issue in step with the persistent findings. An existing issue
 * is rewritten only when the finding set changes, so repeated runs are quiet.
 * When drift clears, an open issue is left alone: the mill may already be
 * working on it, and its first step is to re-run the audit.
 */
export async function syncDriftIssue(input: {
  findings: readonly AliasAuditFinding[];
  auditedAt: string;
  client: DriftIssueClient;
}): Promise<DriftIssueOutcome> {
  const existing = await input.client.findOpenIssue(DRIFT_ISSUE_TITLE);
  if (input.findings.length === 0) {
    return existing
      ? { action: 'left-open', identifier: existing.identifier, reason: 'drift-cleared' }
      : { action: 'none', reason: 'no-persistent-drift' };
  }
  const description = renderDriftIssueDescription(input.findings, input.auditedAt);
  if (!existing) {
    const created = await input.client.fileIssue({ title: DRIFT_ISSUE_TITLE, description, priority: DRIFT_ISSUE_PRIORITY });
    return { action: 'created', identifier: created.identifier };
  }
  if (readDriftFingerprint(existing.description) === driftFingerprint(input.findings)) {
    return { action: 'unchanged', identifier: existing.identifier };
  }
  await input.client.updateDescription(existing.id, description);
  return { action: 'updated', identifier: existing.identifier };
}
