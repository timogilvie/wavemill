#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import { launchNativeCoding } from '../shared/lib/native-agent/launch-coding.ts';

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

  await launchNativeCoding({
    session,
    issue,
    slug,
    wtDir,
    repoDir,
    codeDepth: firstNonEmpty(readOption('code-depth'), process.env.WAVEMILL_CODE_DEPTH) ?? 'medium',
    operatingMode: firstNonEmpty(readOption('operating-mode'), process.env.WAVEMILL_OPERATING_MODE) ?? 'normal',
    branch: firstNonEmpty(readOption('branch'), process.env.WAVEMILL_BRANCH),
    baseBranch: firstNonEmpty(readOption('base-branch'), process.env.WAVEMILL_BASE_BRANCH),
    title: firstNonEmpty(readOption('title'), process.env.WAVEMILL_TITLE),
    issueContext: firstNonEmpty(readOption('issue-context'), process.env.WAVEMILL_ISSUE_CONTEXT),
    resolvedModel: firstNonEmpty(readOption('model'), process.env.WAVEMILL_RESOLVED_MODEL),
  });
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
