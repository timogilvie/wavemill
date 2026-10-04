import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { readJsonlFile } from '../shared/lib/jsonl-utils.ts';
import { readChallengeRecordVoids } from '../shared/lib/challenge-record-void.ts';
import type { StoredChallengeComparison } from '../shared/lib/challenge-comparison.ts';
import {
  buildArbiterR6Report,
  formatArbiterR6ReportJson,
  formatArbiterR6ReportMarkdown,
  type R6EvalRow,
  type R6TypedFailureCounts,
} from '../shared/lib/arbiter-r6-report.ts';

interface R6Args {
  'repo-dir'?: string;
  file?: string;
  evals?: string;
  since?: string;
  until?: string;
  'strict-cohort'?: boolean;
  'canary-count'?: string;
  'challenge-rate-unchanged'?: string;
  'typed-failures'?: string;
  json?: boolean;
}

interface CorpusMetadata {
  path: string;
  bytes: number;
  sha256: string | null;
}

function fingerprint(path: string): CorpusMetadata {
  if (!existsSync(path)) return { path, bytes: 0, sha256: null };
  const bytes = statSync(path).size;
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { path, bytes, sha256: hash };
}

function parseTypedFailures(pathOrJson: string): Map<string, R6TypedFailureCounts> {
  const parsed = existsSync(pathOrJson)
    ? JSON.parse(readFileSync(pathOrJson, 'utf-8'))
    : JSON.parse(pathOrJson);
  const map = new Map<string, R6TypedFailureCounts>();
  if (parsed && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === 'object') {
        map.set(key, value as R6TypedFailureCounts);
      }
    }
  }
  return map;
}

runTool({
  name: 'arbiter-r6-analysis',
  description: 'HOK-2815 — measure net pair yield before/after the reviewer-stage fork',
  options: {
    'repo-dir': { type: 'string', description: 'Repository root; defaults to CWD' },
    file: { type: 'string', description: 'Path to challenge-records.jsonl (default: <repo>/.wavemill/evals/challenge-records.jsonl)' },
    evals: { type: 'string', description: 'Path to evals.jsonl for native funnel and cost/time attribution' },
    since: { type: 'string', description: 'ISO datetime, inclusive lower bound on record timestamp' },
    until: { type: 'string', description: 'ISO datetime, inclusive upper bound on record timestamp' },
    'strict-cohort': {
      type: 'boolean',
      description: 'When set, non-empty ambiguous or other-fork buckets abort with a non-zero exit code',
    },
    'canary-count': {
      type: 'string',
      description: 'Fresh passing coding-canary count for the coder-stage gate (integer)',
    },
    'challenge-rate-unchanged': {
      type: 'string',
      description: 'Operator attestation that challenge.rate was unchanged: "true" or "false" (default: true)',
    },
    'typed-failures': {
      type: 'string',
      description: 'Path or inline JSON mapping "provider|canonicalModel" to {timeout, providerFailure, invalidResponse, other}',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON instead of Markdown' },
  },
  examples: [
    'npx tsx tools/arbiter-r6-analysis.ts',
    'npx tsx tools/arbiter-r6-analysis.ts --repo-dir ../wavemill --since 2026-09-10 --json',
    'npx tsx tools/arbiter-r6-analysis.ts --strict-cohort --canary-count 2 --typed-failures native-failures.json',
  ],
  additionalHelp: [
    '',
    'The report is analysis-only. It reads --file and --evals as an append-only',
    'corpus and never mutates production state. When no corpus is present the',
    'recommendation is always "no-go: insufficient evidence"; the September 22',
    'rollout gates and the September 9 valid-label update apply to every run.',
    '',
    'For the coder-stage decision, supply --canary-count from the mill preflight',
    'or `wavemill native-agent certifications` output and --typed-failures from',
    'HOK-3064 selection-health telemetry so the gate checks can observe them.',
  ].join('\n'),
  async run({ args }) {
    const typed = args as R6Args;
    const repoDir = resolve(typed['repo-dir'] ?? process.cwd());
    const evalsDir = join(repoDir, '.wavemill', 'evals');
    const recordsFile = resolve(typed.file ?? join(evalsDir, 'challenge-records.jsonl'));
    const evalsFile = resolve(typed.evals ?? join(evalsDir, 'evals.jsonl'));

    const comparisons: StoredChallengeComparison[] = existsSync(recordsFile)
      ? readJsonlFile<StoredChallengeComparison>(recordsFile)
      : [];
    const evals: R6EvalRow[] = existsSync(evalsFile)
      ? readJsonlFile<R6EvalRow>(evalsFile)
      : [];
    const voids = existsSync(evalsDir) ? readChallengeRecordVoids(evalsDir) : [];

    const since = typed.since ? new Date(typed.since) : undefined;
    const until = typed.until ? new Date(typed.until) : undefined;
    if (typed.since && Number.isNaN(since?.getTime())) {
      console.error(`Invalid --since: ${typed.since}`);
      process.exit(1);
    }
    if (typed.until && Number.isNaN(until?.getTime())) {
      console.error(`Invalid --until: ${typed.until}`);
      process.exit(1);
    }

    const freshCodingCanaryCount = typed['canary-count'] !== undefined
      ? Number.parseInt(typed['canary-count'], 10)
      : undefined;
    if (freshCodingCanaryCount !== undefined && Number.isNaN(freshCodingCanaryCount)) {
      console.error(`Invalid --canary-count: ${typed['canary-count']}`);
      process.exit(1);
    }

    const challengeRateUnchanged = typed['challenge-rate-unchanged'] !== undefined
      ? typed['challenge-rate-unchanged'] !== 'false'
      : true;

    const nativeFailuresByIdentity = typed['typed-failures']
      ? parseTypedFailures(typed['typed-failures'])
      : undefined;

    const report = buildArbiterR6Report({
      comparisons,
      voids,
      evals,
      since,
      until,
      freshCodingCanaryCount,
      challengeRateUnchanged,
      nativeFailuresByIdentity,
    });

    if (typed['strict-cohort'] && (report.totals.ambiguousProvenance > 0 || report.totals.excludedByCohort > 0)) {
      console.error(`strict-cohort violation: ambiguous=${report.totals.ambiguousProvenance} excluded=${report.totals.excludedByCohort}`);
      process.exit(2);
    }

    const corpusMeta = {
      records: fingerprint(recordsFile),
      evals: fingerprint(evalsFile),
    };

    if (typed.json) {
      console.log(JSON.stringify({ corpus: corpusMeta, report: formatArbiterR6ReportJson(report) }, null, 2));
    } else {
      console.log(formatArbiterR6ReportMarkdown(report));
      console.log('');
      console.log('## Corpus fingerprints');
      console.log('');
      console.log('| File | Bytes | SHA-256 |');
      console.log('|------|-------|---------|');
      console.log(`| ${corpusMeta.records.path} | ${corpusMeta.records.bytes} | ${corpusMeta.records.sha256 ?? '(missing)'} |`);
      console.log(`| ${corpusMeta.evals.path} | ${corpusMeta.evals.bytes} | ${corpusMeta.evals.sha256 ?? '(missing)'} |`);
    }
  },
});
