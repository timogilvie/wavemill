#!/usr/bin/env -S npx tsx
/**
 * One-shot backfill for the HOK-3315 primary arm (HOK-3358).
 *
 * The HOK-3315 operator abort was recorded nowhere before HOK-3358 — the
 * clearest model-quality failure of the day went into neither reliability
 * records nor evals.jsonl. This script replays the operator abort from the
 * archived artifacts under `.wavemill/evals/artifacts/HOK-3315/` so the
 * failure eval record and reliability record land in the corpus the
 * Hokusai contribution export reads.
 *
 * Defaults to `--dry-run`. Reads the archived `.coding-result.json` for the
 * model, the archived `.session-ownership.jsonl` as supporting evidence,
 * and the operator-recovery `.coding-complete` as the evidence artifact.
 *
 *   npx tsx tools/backfill-hok-3315.ts --dry-run
 *   npx tsx tools/backfill-hok-3315.ts --apply --repo-dir ~/src/wavemill
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';
import { recordArmTermination } from '../shared/lib/arm-termination.ts';

const DEFAULT_ISSUE = 'HOK-3315';
const DEFAULT_KIND = 'completion-protocol';

const options = {
  'repo-dir': { type: 'string', description: 'Repository root (defaults to cwd)' },
  issue: { type: 'string', description: 'Task id to backfill (default HOK-3315)' },
  apply: { type: 'boolean', description: 'Perform the writes. Omit for --dry-run.' },
  'archive-dir': { type: 'string', description: 'Override archive dir; defaults to <repoDir>/.wavemill/evals/artifacts/<issue>' },
  'evidence-path': { type: 'string', description: 'Override evidence artifact; defaults to the archived operator-recovery .coding-complete' },
  kind: { type: 'string', description: `Arm failure kind (default ${DEFAULT_KIND})` },
} as const;

type CliArgs = ParsedArgs<typeof options>;

interface Plan {
  issue: string;
  repoDir: string;
  archiveDir: string;
  evidencePath: string;
  model: string;
  kind: string;
  detail: string;
}

function findOperatorRecoveryEvidence(archiveDir: string): string | null {
  if (!existsSync(archiveDir)) return null;
  const entries = readdirSync(archiveDir)
    .filter((n: string) => n.startsWith('operator-recovery-') || n.startsWith('operator-forfeit-'))
    .sort();
  for (const entry of entries) {
    const dir = join(archiveDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch { continue; }
    const candidate = join(dir, '.coding-complete');
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to a top-level .coding-complete when no recovery dir is present.
  const direct = join(archiveDir, '.coding-complete');
  return existsSync(direct) ? direct : null;
}

function readModelFromArchive(archiveDir: string): string | null {
  // allow-stage-artifact-lookup: one-off HOK-3315 backfill reads a per-issue archive directory, not a live feature dir (HOK-3358)
  const codingResult = join(archiveDir, '.coding-result.json');
  if (existsSync(codingResult)) {
    try {
      const parsed = JSON.parse(readFileSync(codingResult, 'utf-8')) as { executedModel?: string; model?: string };
      if (typeof parsed.executedModel === 'string' && parsed.executedModel) return parsed.executedModel;
      if (typeof parsed.model === 'string' && parsed.model) return parsed.model;
    } catch { /* fall through */ }
  }
  return null;
}

function buildPlan(args: CliArgs): Plan {
  const repoDir = resolveRepoDir(args['repo-dir']);
  const issue = args.issue?.trim() || DEFAULT_ISSUE;
  const archiveDir = args['archive-dir']
    ? args['archive-dir']
    : join(repoDir, '.wavemill', 'evals', 'artifacts', issue);
  if (!existsSync(archiveDir)) {
    throw new Error(`archive directory not found: ${archiveDir}. Pass --archive-dir to override.`);
  }
  const evidencePath = args['evidence-path'] ?? findOperatorRecoveryEvidence(archiveDir);
  if (!evidencePath) {
    throw new Error(`evidence artifact not found under ${archiveDir}; pass --evidence-path.`);
  }
  const model = readModelFromArchive(archiveDir);
  if (!model) {
    throw new Error(`executed model not found under ${archiveDir}/.coding-result.json; pass --evidence-path explicitly.`);
  }
  const kind = args.kind?.trim() || DEFAULT_KIND;
  const detail = `HOK-3358 backfill: ${issue} operator abort replayed from archive (${archiveDir}).`;
  return { issue, repoDir, archiveDir, evidencePath, model, kind, detail };
}

async function runBackfillCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool({
    name: 'backfill-hok-3315',
    description: 'Backfill the HOK-3315 operator abort from its archived artifacts (HOK-3358)',
    options,
    examples: [
      'backfill-hok-3315 --dry-run',
      'backfill-hok-3315 --apply --repo-dir ~/src/wavemill',
    ],
    async run({ args }: { args: CliArgs }): Promise<void> {
      const plan = buildPlan(args);
      console.log(`issue:         ${plan.issue}`);
      console.log(`archive:       ${plan.archiveDir}`);
      console.log(`model:         ${plan.model}`);
      console.log(`kind:          ${plan.kind}`);
      console.log(`evidence:      ${plan.evidencePath}`);
      if (!args.apply) {
        console.log('\n(dry-run) pass --apply to perform the writes.');
        return;
      }
      const result = await recordArmTermination({
        issueId: plan.issue,
        kind: plan.kind as never,
        actor: 'operator',
        detail: plan.detail,
        evidencePath: plan.evidencePath,
        stage: 'coding',
        model: plan.model,
        scope: 'single',
        skipStateMutation: true,
        repoDir: plan.repoDir,
      });
      console.log(`\napplied: faultClass=${result.faultClass}, qualitySignalEligible=${result.qualitySignalEligible}`);
      console.log(`reliability.id=${result.reliability.id}`);
      console.log(`evalRecordId=${result.evalRecordId ?? '<none>'}`);
    },
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runBackfillCli();
}

export { runBackfillCli, buildPlan };
