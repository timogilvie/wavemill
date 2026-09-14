#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import { collectStaticFeatures } from '../shared/lib/static-feature-collector.ts';
import { execArgvCommand } from '../shared/lib/shell-utils.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

interface PrRefs {
  baseRef: string;
  headRef: string;
}

function bucketToConclusion(bucket: string | null | undefined): string | null {
  switch (bucket) {
    case 'pass': return 'success';
    case 'fail': return 'failure';
    case 'skipping': return 'skipped';
    case 'cancel': return 'cancelled';
    case 'pending': return null;
    default: return null;
  }
}

function readPrRefs(checkoutDir: string, prNumber: string): PrRefs {
  const result = execArgvCommand(
    'gh',
    ['pr', 'view', prNumber, '--json', 'baseRefName,baseRefOid,headRefOid'],
    { cwd: checkoutDir, encoding: 'utf8', timeout: 15_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`gh pr view failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout || '{}') as {
    baseRefName?: string;
    baseRefOid?: string;
    headRefOid?: string;
  };
  const baseRef = parsed.baseRefOid || parsed.baseRefName;
  const headRef = parsed.headRefOid;
  if (!baseRef || !headRef) {
    throw new Error('gh pr view did not return base/head refs');
  }
  return { baseRef, headRef };
}

function readCiEvidence(checkoutDir: string, prNumber: string): { ran: boolean; allTerminal: boolean; passed: boolean } {
  const result = execArgvCommand(
    'gh',
    ['pr', 'checks', prNumber, '--json', 'name,state,bucket'],
    { cwd: checkoutDir, encoding: 'utf8', timeout: 15_000 },
  );
  if (result.exitCode !== 0) {
    return { ran: false, allTerminal: false, passed: true };
  }
  let checks: Array<{ bucket?: string }> = [];
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    checks = Array.isArray(parsed) ? parsed : [];
  } catch {
    checks = [];
  }
  const conclusions = checks.map((check) => bucketToConclusion(check.bucket));
  return {
    ran: checks.length > 0,
    allTerminal: checks.every((_, index) => conclusions[index] !== null),
    passed: conclusions.every((conclusion) => conclusion !== 'failure' && conclusion !== 'cancelled'),
  };
}

runTool({
  name: 'collect-static-features',
  description: 'Collect S1 Static candidate features from a checkout plus base/head or PR number',
  options: {
    checkout: { type: 'string', description: 'Candidate checkout directory (default: current directory)' },
    pr: { type: 'string', description: 'GitHub PR number; resolves base/head and CI evidence with gh' },
    base: { type: 'string', description: 'Base ref/SHA for complexity delta' },
    head: { type: 'string', description: 'Head ref/SHA (default: HEAD)' },
  },
  examples: [
    'npx tsx tools/collect-static-features.ts --checkout . --pr 123',
    'npx tsx tools/collect-static-features.ts --checkout . --base main --head HEAD',
  ],
  run({ args }) {
    const checkoutDir = resolve((args.checkout as string | undefined) || '.');
    const prNumber = args.pr as string | undefined;
    let baseRef = args.base as string | undefined;
    let headRef = args.head as string | undefined;
    let ciEvidence: { ran: boolean; allTerminal: boolean; passed: boolean } | null = null;

    if (prNumber) {
      const refs = readPrRefs(checkoutDir, prNumber);
      baseRef ??= refs.baseRef;
      headRef ??= refs.headRef;
      ciEvidence = readCiEvidence(checkoutDir, prNumber);
    }

    if (!baseRef) {
      throw new Error('Missing --base (or --pr to resolve one)');
    }

    const result = collectStaticFeatures({
      checkoutDir,
      baseRef,
      headRef,
      expectedHeadSha: headRef,
      ciEvidence,
    });
    console.log(JSON.stringify(result, null, 2));
  },
});
