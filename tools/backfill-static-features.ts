#!/usr/bin/env -S npx tsx

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { collectStaticFeatures } from '../shared/lib/static-feature-collector.ts';
import type { EvalRecord, StaticAnalysisOutcome } from '../shared/lib/eval-schema.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import { execArgvCommand } from '../shared/lib/shell-utils.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

interface BackfillSummary {
  file: string;
  apply: boolean;
  recordsScanned: number;
  recordsChanged: number;
  complexityFilled: number;
  buildFilled: number;
  skippedNoPr: number;
  skippedUnresolvable: number;
  notBackfillable: {
    type_errors: 'historical dependency trees are not faithfully reconstructable';
    lint_errors: 'historical dependency trees are not faithfully reconstructable';
  };
}

function defaultEvalLog(repoDir: string): string {
  return join(resolveEvalsDir(undefined, repoDir).dir, 'evals.jsonl');
}

function parsePrNumber(record: Pick<EvalRecord, 'prUrl'>): string | null {
  const match = record.prUrl?.match(/\/pull\/(\d+)/);
  return match?.[1] ?? null;
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

function prRefs(repoDir: string, prNumber: string): { baseRef: string; headRef: string } | null {
  const result = execArgvCommand(
    'gh',
    ['pr', 'view', prNumber, '--json', 'baseRefName,baseRefOid,headRefOid'],
    { cwd: repoDir, encoding: 'utf8', timeout: 15_000 },
  );
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout || '{}') as {
      baseRefName?: string;
      baseRefOid?: string;
      headRefOid?: string;
    };
    const baseRef = parsed.baseRefOid || parsed.baseRefName;
    return baseRef && parsed.headRefOid ? { baseRef, headRef: parsed.headRefOid } : null;
  } catch {
    return null;
  }
}

function ciEvidence(repoDir: string, prNumber: string): { ran: boolean; allTerminal: boolean; passed: boolean } {
  const result = execArgvCommand(
    'gh',
    ['pr', 'checks', prNumber, '--json', 'name,state,bucket'],
    { cwd: repoDir, encoding: 'utf8', timeout: 15_000 },
  );
  if (result.exitCode !== 0) return { ran: false, allTerminal: false, passed: true };
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    const checks = Array.isArray(parsed) ? parsed as Array<{ bucket?: string }> : [];
    const conclusions = checks.map((check) => bucketToConclusion(check.bucket));
    return {
      ran: checks.length > 0,
      allTerminal: checks.every((_, index) => conclusions[index] !== null),
      passed: conclusions.every((conclusion) => conclusion !== 'failure' && conclusion !== 'cancelled'),
    };
  } catch {
    return { ran: false, allTerminal: false, passed: true };
  }
}

function readJsonl(file: string): EvalRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalRecord);
}

function writeJsonlAtomic(file: string, records: EvalRecord[]): void {
  const tmp = join(dirname(file), `.tmp-${Date.now()}-${process.pid}.jsonl`);
  writeFileSync(tmp, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  renameSync(tmp, file);
}

export function backfillStaticFeaturesFile(file: string, repoDir: string, apply: boolean): BackfillSummary {
  const records = readJsonl(file);
  const summary: BackfillSummary = {
    file,
    apply,
    recordsScanned: records.length,
    recordsChanged: 0,
    complexityFilled: 0,
    buildFilled: 0,
    skippedNoPr: 0,
    skippedUnresolvable: 0,
    notBackfillable: {
      type_errors: 'historical dependency trees are not faithfully reconstructable',
      lint_errors: 'historical dependency trees are not faithfully reconstructable',
    },
  };

  for (const record of records) {
    const staticAnalysis = (record.outcomes?.staticAnalysis ?? {}) as StaticAnalysisOutcome;
    const needsComplexity = staticAnalysis.complexity_delta === undefined;
    const needsBuild = staticAnalysis.build_ok === undefined;
    if (!needsComplexity && !needsBuild) continue;

    const prNumber = parsePrNumber(record);
    if (!prNumber) {
      summary.skippedNoPr++;
      continue;
    }
    const refs = prRefs(repoDir, prNumber);
    if (!refs) {
      summary.skippedUnresolvable++;
      continue;
    }

    const features = collectStaticFeatures({
      checkoutDir: repoDir,
      baseRef: refs.baseRef,
      headRef: refs.headRef,
      expectedHeadSha: refs.headRef,
      ciEvidence: ciEvidence(repoDir, prNumber),
      timeouts: { lint: 1, typecheck: 1, build: 1 },
    });

    let changed = false;
    if (needsComplexity) {
      staticAnalysis.complexity_delta = features.complexity_delta;
      summary.complexityFilled++;
      changed = true;
    }
    if (needsBuild) {
      staticAnalysis.build_ok = features.build_ok;
      summary.buildFilled++;
      changed = true;
    }
    if (changed) {
      staticAnalysis.collection = { ...features.collection, backfilled: true };
      record.outcomes ??= {
        success: record.score >= 0.5,
        review: { humanReviewRequired: false, rounds: 0, approvals: 0, changeRequests: 0 },
        rework: { agentIterations: 0 },
        delivery: { prCreated: true, merged: false },
      };
      record.outcomes.staticAnalysis = staticAnalysis;
      summary.recordsChanged++;
    }
  }

  if (apply && summary.recordsChanged > 0) {
    writeJsonlAtomic(file, records);
  }
  return summary;
}

runTool({
  name: 'backfill-static-features',
  description: 'Backfill reconstructable S1 Static fields: complexity_delta and build_ok',
  options: {
    file: { type: 'string', description: 'JSONL eval log (default: configured evals/evals.jsonl)' },
    'repo-dir': { type: 'string', description: 'Repository root used for git objects and gh commands' },
    apply: { type: 'boolean', description: 'Rewrite the JSONL file in place; default is dry-run' },
  },
  examples: [
    'npx tsx tools/backfill-static-features.ts',
    'npx tsx tools/backfill-static-features.ts --file .wavemill/evals/evals.jsonl --apply',
  ],
  run({ args }) {
    const repoDir = resolve((args['repo-dir'] as string | undefined) || '.');
    const file = args.file ? resolve(args.file as string) : defaultEvalLog(repoDir);
    const summary = backfillStaticFeaturesFile(file, repoDir, args.apply === true);
    console.log(JSON.stringify(summary, null, 2));
  },
});
