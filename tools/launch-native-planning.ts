#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { launchNativePlanning } from '../shared/lib/native-agent/launch-planning.ts';
import {
  resolveNativePlanningApprovalMode,
  runNativePlanningApprovalGate,
} from '../shared/lib/native-agent/planning-approval.ts';

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return firstNonEmpty(process.argv[index + 1]);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

async function main(): Promise<void> {
  const session = firstNonEmpty(readOption('session'), process.env.WAVEMILL_SESSION) ?? '';
  const issue = firstNonEmpty(readOption('issue'), process.env.WAVEMILL_ISSUE) ?? '';
  const slug = firstNonEmpty(readOption('slug'), process.env.WAVEMILL_FEATURE_SLUG, process.env.WAVEMILL_SLUG) ?? '';
  const wtDir = resolve(firstNonEmpty(readOption('wt-dir'), process.env.WAVEMILL_WT_DIR) ?? process.cwd());
  const repoDir = resolve(firstNonEmpty(readOption('repo-dir'), process.env.WAVEMILL_MILLED_REPO_DIR) ?? process.cwd());

  if (!session || !issue || !slug) {
    throw new Error('session, issue, and slug are required');
  }

  const result = await launchNativePlanning({
    session,
    issue,
    slug,
    wtDir,
    repoDir,
    phase: 'planning',
    planDepth: firstNonEmpty(readOption('plan-depth'), process.env.WAVEMILL_PLAN_DEPTH) ?? 'light',
    operatingMode: firstNonEmpty(readOption('operating-mode'), process.env.WAVEMILL_OPERATING_MODE) ?? 'normal',
    branch: firstNonEmpty(readOption('branch'), process.env.WAVEMILL_BRANCH),
    baseBranch: firstNonEmpty(readOption('base-branch'), process.env.WAVEMILL_BASE_BRANCH),
    title: firstNonEmpty(readOption('title'), process.env.WAVEMILL_TITLE),
    issueContext: firstNonEmpty(readOption('issue-context'), process.env.WAVEMILL_ISSUE_CONTEXT),
    linearIssue: firstNonEmpty(readOption('linear-issue'), process.env.WAVEMILL_LINEAR_ISSUE),
    resolvedModel: firstNonEmpty(readOption('model'), process.env.WAVEMILL_RESOLVED_MODEL),
  });

  const approvalMode = resolveNativePlanningApprovalMode(
    firstNonEmpty(readOption('approval-mode'), process.env.WAVEMILL_NATIVE_PLANNING_APPROVAL_MODE),
  );
  await runNativePlanningApprovalGate({
    issue,
    planPath: result.planPath,
    approvalMarkerPath: result.approvalMarkerPath,
    workflowAbortMarkerPath: resolve(wtDir, 'features', slug, '.workflow-aborted'),
    transcriptPath: result.transcriptPath,
    provider: result.provider,
    model: result.model,
    mode: approvalMode,
  });
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
