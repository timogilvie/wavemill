/**
 * Shard balance and weights-manifest logic (HOK-2939).
 *
 * Business logic behind tools/partition-tests.ts and
 * tools/check-shard-balance.ts:
 *
 * - loading and validating the checked-in weights manifest
 *   (tests/ci-test-weights.json);
 * - parsing shard counts straight from .github/workflows/ci.yml so the
 *   preflight check can never disagree with the real matrix;
 * - parsing the runners' registration arrays (the single source of truth for
 *   suite membership);
 * - running the deterministic partitioner over each suite and enforcing
 *   REQ-F1 (exactly-once assignment), REQ-F3 (130%-of-median balance with a
 *   named indivisible-hotspot exception), and manifest hygiene (no stale
 *   entries, no malformed weights).
 *
 * @module shard-balance
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeBalance,
  partitionTests,
  validateWeights,
  type BalanceAnalysis,
  type PartitionResult,
} from './test-partitioner.ts';

/** Checked-in weights manifest shape (tests/ci-test-weights.json). */
export interface WeightsManifest {
  version: number;
  /** Conservative weight in ms for tests without a measurement. */
  defaultMs: number;
  /** Provenance of the samples the medians were computed from. */
  sources: Array<{ runId: string; createdAt: string }>;
  /** Per-suite median elapsed ms per test file. */
  suites: Record<string, Record<string, number>>;
}

/** The suites whose CI jobs use weighted partitioning. */
export const PARTITIONED_SUITES = ['shell', 'unit', 'custom'] as const;
export type PartitionedSuite = (typeof PARTITIONED_SUITES)[number];

/** Default manifest location relative to the repo root. */
export const WEIGHTS_MANIFEST_PATH = 'tests/ci-test-weights.json';

/**
 * Load and validate the weights manifest. Throws a diagnostic naming the
 * problem on any malformed content — a bad manifest must fail loudly rather
 * than silently dropping or defaulting tests.
 */
export function loadWeightsManifest(filePath: string): WeightsManifest {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`weights manifest: cannot read ${filePath}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`weights manifest: ${filePath} is not valid JSON: ${(error as Error).message}`);
  }
  const manifest = parsed as WeightsManifest;
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error(`weights manifest: ${filePath} must be a JSON object`);
  }
  if (manifest.version !== 1) {
    throw new Error(`weights manifest: unsupported version ${JSON.stringify(manifest.version)} (expected 1)`);
  }
  if (typeof manifest.defaultMs !== 'number' || !Number.isFinite(manifest.defaultMs) || manifest.defaultMs <= 0) {
    throw new Error(`weights manifest: defaultMs must be a finite number > 0, got ${JSON.stringify(manifest.defaultMs)}`);
  }
  if (typeof manifest.suites !== 'object' || manifest.suites === null) {
    throw new Error('weights manifest: missing "suites" object');
  }
  for (const [suite, weights] of Object.entries(manifest.suites)) {
    if (typeof weights !== 'object' || weights === null) {
      throw new Error(`weights manifest: suites.${suite} must be an object`);
    }
    validateWeights(weights, `weights manifest suites.${suite}`);
  }
  return manifest;
}

/**
 * Parse the `shard: [1, 2, ...]` matrix list for a job key straight out of
 * ci.yml, so shard counts used by checks always match the real matrix.
 * Returns the number of shards, or null when the job has no shard matrix.
 */
export function parseShardCount(workflowYaml: string, jobKey: string): number | null {
  const jobsBlock = workflowYaml.match(/^jobs:\n(?<body>[\s\S]*)$/m)?.groups?.body;
  if (!jobsBlock) return null;
  const jobMatches = [...jobsBlock.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  for (let i = 0; i < jobMatches.length; i++) {
    if (jobMatches[i][1] !== jobKey) continue;
    const start = (jobMatches[i].index ?? 0) + jobMatches[i][0].length;
    const end = i + 1 < jobMatches.length ? jobMatches[i + 1].index ?? jobsBlock.length : jobsBlock.length;
    const block = jobsBlock.slice(start, end);
    const shardList = block.match(/^\s*shard:\s*\[(.*?)\]\s*$/m)?.[1];
    if (!shardList) return null;
    const values = shardList.split(',').map((value) => value.trim()).filter(Boolean);
    return values.length > 0 ? values.length : null;
  }
  return null;
}

/**
 * Parse a `NAME=( ... )` bash array block: one path per line, optional
 * trailing comment, comment-only lines ignored. This mirrors the format
 * contract documented in the runners and in tools/check-test-registration.ts.
 */
export function parseShellArray(script: string, arrayName: string): string[] {
  const block = script.match(new RegExp(`^${arrayName}=\\(\\n(?<entries>[\\s\\S]*?)^\\)`, 'm'))?.groups?.entries;
  if (block === undefined) {
    throw new Error(`registration parse: array ${arrayName}=( ... ) not found`);
  }
  return [...block.matchAll(/^\s*([^\s#][^\s]*)\s*(?:#.*)?$/gm)].map((match) => match[1]);
}

/** Registered files per partitioned suite, read from the runners. */
export function readRegisteredSuites(repoDir: string): Record<PartitionedSuite, string[]> {
  const shellScript = readFileSync(join(repoDir, 'tests', 'run-shell-suite.sh'), 'utf8');
  const unitScript = readFileSync(join(repoDir, 'tests', 'run-unit-tests.sh'), 'utf8');
  const customScript = readFileSync(join(repoDir, 'tests', 'run-custom-tests.sh'), 'utf8');
  return {
    shell: parseShellArray(shellScript, 'TESTS'),
    unit: parseShellArray(unitScript, 'TESTS'),
    custom: [
      ...parseShellArray(customScript, 'CUSTOM_TS_TESTS'),
      ...parseShellArray(customScript, 'CUSTOM_SH_TESTS'),
    ],
  };
}

export interface SuiteBalanceReport {
  suite: PartitionedSuite;
  shardCount: number;
  testCount: number;
  partition: PartitionResult;
  balance: BalanceAnalysis;
  /** Manifest entries that reference tests no longer registered. */
  staleWeights: string[];
  /** Registered tests with no manifest entry (assigned defaultMs). */
  unmeasured: string[];
  problems: string[];
  notes: string[];
}

export interface ShardBalanceResult {
  ok: boolean;
  suites: SuiteBalanceReport[];
  problems: string[];
}

/**
 * Run the full preflight shard-balance check for a repo. Never throws for
 * content problems — they are reported in `problems` so every issue surfaces
 * in one pass; only unreadable/malformed inputs throw.
 */
export function checkShardBalance(repoDir: string, { thresholdRatio = 1.3 }: { thresholdRatio?: number } = {}): ShardBalanceResult {
  const workflow = readFileSync(join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  const manifest = loadWeightsManifest(join(repoDir, WEIGHTS_MANIFEST_PATH));
  const registered = readRegisteredSuites(repoDir);

  const suites: SuiteBalanceReport[] = [];
  const globalProblems: string[] = [];

  for (const suite of PARTITIONED_SUITES) {
    const shardCount = parseShardCount(workflow, suite);
    if (shardCount === null) {
      globalProblems.push(`ci.yml: could not parse shard matrix for job "${suite}"`);
      continue;
    }
    const files = registered[suite];
    const weights = manifest.suites[suite] ?? {};
    const problems: string[] = [];
    const notes: string[] = [];

    const fileSet = new Set(files);
    const staleWeights = Object.keys(weights).filter((file) => !fileSet.has(file)).sort();
    if (staleWeights.length > 0) {
      problems.push(
        `${suite}: stale weights manifest entries (tests no longer registered): ${staleWeights.join(', ')} — refresh ${WEIGHTS_MANIFEST_PATH}`
      );
    }
    const unmeasured = files.filter((file) => !Object.prototype.hasOwnProperty.call(weights, file)).sort();

    const partition = partitionTests({ files, weights, defaultMs: manifest.defaultMs, shardCount });

    // Belt-and-braces exactly-once check over the computed assignment (REQ-F1).
    const assigned = partition.shards.flatMap((shard) => shard.files);
    const assignedSet = new Set(assigned);
    if (assigned.length !== files.length || files.some((file) => !assignedSet.has(file))) {
      problems.push(`${suite}: partition did not assign every registered test exactly once`);
    }

    const balance = analyzeBalance(partition, { thresholdRatio });
    for (const hotspot of balance.indivisibleHotspots) {
      notes.push(
        `${suite}: shard ${hotspot.shardIndex + 1}/${shardCount} exceeds ${Math.round(thresholdRatio * 100)}% of median because indivisible test "${hotspot.file}" alone weighs ${Math.round(hotspot.weightMs)}ms (allowed exception)`
      );
    }
    for (const over of balance.overloaded) {
      problems.push(
        `${suite}: shard ${over.shardIndex + 1}/${shardCount} estimate ${Math.round(over.estimatedMs)}ms exceeds ${Math.round(balance.thresholdMs)}ms (${Math.round(thresholdRatio * 100)}% of median ${Math.round(balance.medianMs)}ms) — rebalance or refresh ${WEIGHTS_MANIFEST_PATH}`
      );
    }

    suites.push({
      suite,
      shardCount,
      testCount: files.length,
      partition,
      balance,
      staleWeights,
      unmeasured,
      problems,
      notes,
    });
  }

  const problems = [...globalProblems, ...suites.flatMap((report) => report.problems)];
  return { ok: problems.length === 0, suites, problems };
}

/** Human-readable formatter for the preflight check. */
export function formatShardBalance(result: ShardBalanceResult): string {
  const lines: string[] = [];
  for (const report of result.suites) {
    const estimates = report.partition.shards
      .map((shard, index) => `${index + 1}:${Math.round(shard.estimatedMs / 1000)}s`)
      .join(' ');
    lines.push(
      `shard-balance: ${report.suite} ${report.testCount} tests across ${report.shardCount} shards (${estimates}; median ${Math.round(report.balance.medianMs / 1000)}s)`
    );
    if (report.unmeasured.length > 0) {
      lines.push(`shard-balance: ${report.suite} ${report.unmeasured.length} test(s) using defaultMs (no measurement yet)`);
    }
    for (const note of report.notes) {
      lines.push(`shard-balance: note: ${note}`);
    }
  }
  if (result.ok) {
    lines.push('shard-balance: ok');
  } else {
    lines.push('shard-balance: FAILED:');
    lines.push(...result.problems.map((problem) => `- ${problem}`));
  }
  return lines.join('\n');
}
