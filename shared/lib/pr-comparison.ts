import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectVariedDimensions,
  type ChallengeComparisonDimensions,
  type ChallengeComparison,
  type ChallengeCriterionRationales,
  type ChallengeDiffIdentity,
  type ChallengeRoutingMeta,
  type ChallengeSideExecutionProvenance,
  type ChallengeProvenanceValidation,
} from './challenge-comparison.ts';
import type { ChallengeStageEval } from './eval-schema.ts';
import { formatRubricForJudgePrompt } from './rubric.ts';
import { errorMessage } from './error-utils.ts';
import { fillPromptTemplate } from './prompt-utils.ts';
import { callClaude, parseJsonFromLLM, type LLMCallOptions, type LLMCallResult } from './llm-cli.ts';
import { hashString } from './prompt-hash.ts';

export type PresentationOrder = 'primary-first' | 'challenger-first';

type CandidateLabel = 'Candidate A' | 'Candidate B';
type CandidateKey = 'A' | 'B';

export const LOSER_PATCH_MAX_BYTES = 10 * 1024 * 1024;

export interface BlindComparisonDimensions {
  completeness: { A: number; B: number };
  correctness: { A: number; B: number };
  code_quality: { A: number; B: number };
  intervention_impact: { A: number; B: number };
  autonomy: { A: number; B: number };
}

export type BlindComparisonCriterionRationales = {
  [K in keyof ChallengeComparisonDimensions]: { rationale: string };
};

export interface BlindComparisonResult {
  winner: CandidateKey;
  rationale: string;
  workflowInsight?: string;
  dimensions: BlindComparisonDimensions;
  criterionRationales: BlindComparisonCriterionRationales;
}

export const ARBITER_JUDGE_PROMPT_TEMPLATE_PATH = 'tools/prompts/arbiter-judge.md';

export const DEFAULT_ARBITER_JUDGE_PROMPT_TEMPLATE = `You are judging two candidate pull requests (Candidate A and Candidate B) for the same task.

Return JSON only with this exact structure:
{
  "winner": "A" | "B",
  "rationale": "short explanation",
  "workflowInsight": "optional observation about how routing differences may have influenced the result",
  "dimensions": {
    "completeness": { "A": number, "B": number },
    "correctness": { "A": number, "B": number },
    "code_quality": { "A": number, "B": number },
    "intervention_impact": { "A": number, "B": number },
    "autonomy": { "A": number, "B": number }
  },
  "criterionRationales": {
    "completeness": { "rationale": "why the completeness scores differ or tie" },
    "correctness": { "rationale": "why the correctness scores differ or tie" },
    "code_quality": { "rationale": "why the code_quality scores differ or tie" },
    "intervention_impact": { "rationale": "why the intervention_impact scores differ or tie" },
    "autonomy": { "rationale": "why the autonomy scores differ or tie" }
  }
}

Scores must be integers from 1 to 10.
Every criterionRationales entry is required and its rationale must be a non-empty string.

Use these criterion definitions exactly:
{{RUBRIC}}

{{WORKFLOW_CONTEXT}}

{{STAGE_EVIDENCE_CONTEXT}}

Task context:
{{ISSUE_PROMPT}}{{SHARED_PREFIX_CONTEXT}}

Candidate A diff:
{{CANDIDATE_A_DIFF}}

Candidate B diff:
{{CANDIDATE_B_DIFF}}`;

const REQUIRED_DIMENSION_KEYS: Array<keyof ChallengeComparisonDimensions> = [
  'completeness',
  'correctness',
  'code_quality',
  'intervention_impact',
  'autonomy',
];

export type ValidatedComparisonResult = Omit<
  ChallengeComparison,
  | 'challengePairId'
  | 'primaryModel'
  | 'challengerModel'
  | 'primaryPrUrl'
  | 'challengerPrUrl'
  | 'primaryEvalScore'
  | 'challengerEvalScore'
  | 'winnerModel'
  | 'timestamp'
  | 'primaryRouting'
  | 'challengerRouting'
  | 'variedDimensions'
  | 'challengeType'
  | 'variedStage'
  | 'stageEvidenceMode'
  | 'presentationOrder'
  // Schema-carrier fields populated outside the judge verdict (HOK-2794)
  | 'forkStage'
  | 'forkCommit'
  | 'sharedPrefix'
  | 'primaryInheritedStages'
  | 'challengerInheritedStages'
  | 'primaryDiffIdentity'
  | 'challengerDiffIdentity'
  | 'judge_model'
  | 'judge_prompt_hash'
  | 'primary_cost_usd'
  | 'challenger_cost_usd'
  | 'noComparisonReason'
>;

export function resolvePresentationOrder(
  explicit?: string,
  rng: () => number = Math.random,
): PresentationOrder {
  if (explicit === undefined || explicit === '' || explicit === 'random') {
    return rng() < 0.5 ? 'primary-first' : 'challenger-first';
  }
  if (explicit === 'primary-first' || explicit === 'challenger-first') {
    return explicit;
  }
  throw new Error(`Invalid presentation order: ${explicit}. Expected primary-first, challenger-first, or random.`);
}

function formatStageEvidenceBlock(
  side: CandidateLabel,
  evidence: ChallengeStageEval,
): string {
  const items = evidence.evidence
    .slice(0, 6)
    .map((item) => `- ${item.label}: ${item.summary}${item.source ? ` [${item.source}]` : ''}`)
    .join('\n');
  return `${side} ${evidence.stage} evidence (${evidence.provenance}): ${evidence.summary}${evidence.fallbackReason ? ` Fallback: ${evidence.fallbackReason}.` : ''}\n${items}`;
}

/**
 * Resolve a pull request number to its GitHub URL.
 */
export function prUrlFromNumber(pr: string, repoDir: string): string {
  if (/^https?:\/\//.test(pr)) {
    return pr;
  }
  try {
    return execFileSync('gh', ['pr', 'view', pr, '--json', 'url', '--jq', '.url'], {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(`Failed to resolve PR URL for ${pr}: ${errorMessage(error)}`);
  }
}

/**
 * Extract a pull request number from either a number-like string or PR URL.
 */
export function prNumberFromValue(pr: string): string {
  const match = pr.match(/\/pull\/(\d+)$/);
  return match?.[1] || pr;
}

export interface PrIdentityMetadata {
  url: string;
  headRefName: string;
  baseRefName: string;
  head_sha: string;
}

export interface DiffIdentityDeps {
  runGit?: (args: string[]) => string;
  runGh?: (args: string[]) => string;
}

function defaultRunGit(repoDir: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed: ${errorMessage(error)}`);
  }
}

function defaultRunGh(repoDir: string, args: string[]): string {
  try {
    return execFileSync('gh', args, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(`gh ${args.join(' ')} failed: ${errorMessage(error)}`);
  }
}

function gitRunner(repoDir: string, deps?: DiffIdentityDeps): (args: string[]) => string {
  return deps?.runGit ?? ((args) => defaultRunGit(repoDir, args));
}

function ghRunner(repoDir: string, deps?: DiffIdentityDeps): (args: string[]) => string {
  return deps?.runGh ?? ((args) => defaultRunGh(repoDir, args));
}

function parsePrIdentityMetadata(raw: string, pr: string): PrIdentityMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse PR metadata for ${pr}: ${errorMessage(error)}`);
  }
  const payload = parsed as Record<string, unknown>;
  const url = typeof payload.url === 'string' ? payload.url.trim() : '';
  const headRefName = typeof payload.headRefName === 'string' ? payload.headRefName.trim() : '';
  const baseRefName = typeof payload.baseRefName === 'string' ? payload.baseRefName.trim() : '';
  const headSha = typeof payload.headRefOid === 'string' ? payload.headRefOid.trim() : '';
  if (!url || !headRefName || !baseRefName || !headSha) {
    throw new Error(`Incomplete PR metadata for ${pr}; expected url, headRefName, baseRefName, and headRefOid`);
  }
  return {
    url,
    headRefName,
    baseRefName,
    head_sha: headSha,
  };
}

export function resolvePrIdentityMetadata(
  pr: string,
  repoDir: string,
  deps?: DiffIdentityDeps,
): PrIdentityMetadata {
  const prNumber = prNumberFromValue(pr);
  const raw = ghRunner(repoDir, deps)([
    'pr',
    'view',
    prNumber,
    '--json',
    'headRefOid,headRefName,baseRefName,url',
  ]);
  return parsePrIdentityMetadata(raw, pr);
}

export function hasCommit(runGit: (args: string[]) => string, sha: string): boolean {
  try {
    runGit(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function ensureLocalComparisonObjects(input: {
  prNumber: string;
  metadata: PrIdentityMetadata;
  forkCommit?: string | null;
  runGit: (args: string[]) => string;
}): void {
  const baseRef = `refs/remotes/origin/${input.metadata.baseRefName}`;
  input.runGit([
    'fetch',
    '--no-tags',
    '--depth=1000',
    'origin',
    `+refs/heads/${input.metadata.baseRefName}:${baseRef}`,
  ]);
  if (!hasCommit(input.runGit, input.metadata.head_sha)) {
    input.runGit([
      'fetch',
      '--no-tags',
      '--depth=1000',
      'origin',
      `+refs/pull/${input.prNumber}/head:refs/remotes/origin/pr/${input.prNumber}`,
    ]);
  }
  if (!hasCommit(input.runGit, input.metadata.head_sha)) {
    throw new Error(`PR ${input.prNumber} head commit is not available locally: ${input.metadata.head_sha}`);
  }
  if (input.forkCommit && !hasCommit(input.runGit, input.forkCommit)) {
    throw new Error(`Fork commit is not available locally for PR ${input.prNumber}: ${input.forkCommit}`);
  }
}

function parseDiffFilePath(line: string): string | undefined {
  if (line === '+++ /dev/null') return undefined;
  if (!line.startsWith('+++ b/')) return undefined;
  return line.slice('+++ b/'.length).replace(/\t.*$/, '');
}

export function parseUnifiedDiffLineRanges(diff: string): ChallengeDiffIdentity['line_ranges'] {
  const ranges: ChallengeDiffIdentity['line_ranges'] = [];
  let currentFile: string | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      currentFile = parseDiffFilePath(line);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk || !currentFile) continue;
    const start = Number.parseInt(hunk[1], 10);
    const count = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) continue;
    ranges.push({
      file: currentFile,
      start,
      end: start + count - 1,
    });
  }
  return ranges;
}

export function buildDiffIdentity(input: {
  metadata: PrIdentityMetadata;
  merge_sha: string;
  nameOnlyDiff: string;
  unifiedDiff: string;
}): ChallengeDiffIdentity {
  return {
    head_sha: input.metadata.head_sha,
    merge_sha: input.merge_sha,
    files_touched: input.nameOnlyDiff.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    line_ranges: parseUnifiedDiffLineRanges(input.unifiedDiff),
  };
}

export function resolvePrDiffIdentity(input: {
  pr: string;
  repoDir: string;
  forkCommit?: string | null;
  deps?: DiffIdentityDeps;
}): ChallengeDiffIdentity {
  const runGit = gitRunner(input.repoDir, input.deps);
  const prNumber = prNumberFromValue(input.pr);
  const metadata = resolvePrIdentityMetadata(input.pr, input.repoDir, input.deps);
  ensureLocalComparisonObjects({
    prNumber,
    metadata,
    forkCommit: input.forkCommit,
    runGit,
  });
  const mergeSha = input.forkCommit
    || runGit(['merge-base', `refs/remotes/origin/${metadata.baseRefName}`, metadata.head_sha]);
  const nameOnlyDiff = runGit(['diff', '--name-only', mergeSha, metadata.head_sha]);
  const unifiedDiff = runGit(['diff', '--unified=0', mergeSha, metadata.head_sha]);
  return buildDiffIdentity({
    metadata,
    merge_sha: mergeSha,
    nameOnlyDiff,
    unifiedDiff,
  });
}

export interface ForkAwareComparisonDiffs {
  sharedPrefixDiff: string;
  primaryDiff: string;
  challengerDiff: string;
  primaryMetadata: PrIdentityMetadata;
  challengerMetadata: PrIdentityMetadata;
  forkTree: string;
}

function isAncestor(runGit: (args: string[]) => string, ancestor: string, descendant: string): boolean {
  try {
    runGit(['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch the three diff sections needed for a forked pair: the shared prefix
 * once, then each arm's post-fork contribution. The legacy full-PR diff path
 * remains outside this helper so independent pairs keep their prompt bytes.
 */
export function resolveForkAwareComparisonDiffs(input: {
  primaryPr: string;
  challengerPr: string;
  forkCommit: string;
  repoDir: string;
  deps?: DiffIdentityDeps;
}): ForkAwareComparisonDiffs {
  const runGit = gitRunner(input.repoDir, input.deps);
  const primaryNumber = prNumberFromValue(input.primaryPr);
  const challengerNumber = prNumberFromValue(input.challengerPr);
  const primaryMetadata = resolvePrIdentityMetadata(input.primaryPr, input.repoDir, input.deps);
  const challengerMetadata = resolvePrIdentityMetadata(input.challengerPr, input.repoDir, input.deps);

  ensureLocalComparisonObjects({
    prNumber: primaryNumber,
    metadata: primaryMetadata,
    forkCommit: input.forkCommit,
    runGit,
  });
  ensureLocalComparisonObjects({
    prNumber: challengerNumber,
    metadata: challengerMetadata,
    forkCommit: input.forkCommit,
    runGit,
  });

  if (!isAncestor(runGit, input.forkCommit, primaryMetadata.head_sha)) {
    throw new Error(`Fork commit ${input.forkCommit} is not an ancestor of primary PR ${primaryNumber} head ${primaryMetadata.head_sha}`);
  }
  if (!isAncestor(runGit, input.forkCommit, challengerMetadata.head_sha)) {
    throw new Error(`Fork commit ${input.forkCommit} is not an ancestor of challenger PR ${challengerNumber} head ${challengerMetadata.head_sha}`);
  }

  const forkTree = runGit(['rev-parse', `${input.forkCommit}^{tree}`]).trim();
  const sharedBase = runGit(['merge-base', `refs/remotes/origin/${primaryMetadata.baseRefName}`, input.forkCommit]).trim();
  return {
    sharedPrefixDiff: runGit(['diff', sharedBase, input.forkCommit]),
    primaryDiff: runGit(['diff', input.forkCommit, primaryMetadata.head_sha]),
    challengerDiff: runGit(['diff', input.forkCommit, challengerMetadata.head_sha]),
    primaryMetadata,
    challengerMetadata,
    forkTree,
  };
}

export interface LoserPatchRetentionResult {
  path: string;
  written: boolean;
  bytes: number;
  skippedReason?: 'missing_identity' | 'too_large';
}

export interface LoserPatchRetentionDeps {
  readPatch?: (args: string[], maxBytes: number) => Buffer | 'too_large';
}

function defaultReadPatch(repoDir: string, args: string[], maxBytes: number): Buffer | 'too_large' {
  const result = spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'buffer',
    maxBuffer: maxBytes + 1,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const spawnErrorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (result.error && (result.error.message.includes('maxBuffer') || spawnErrorCode === 'ENOBUFS')) {
    return 'too_large';
  }
  if (result.error) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf-8').trim() : '';
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
  return stdout.length > maxBytes ? 'too_large' : stdout;
}

export function retainLoserPatch(input: {
  challengePairId: string;
  loserIdentity: ChallengeDiffIdentity;
  evalsDir: string;
  repoDir: string;
  maxBytes?: number;
  deps?: LoserPatchRetentionDeps;
}): LoserPatchRetentionResult {
  const artifactPath = join(input.evalsDir, 'artifacts', input.challengePairId, 'loser.patch');
  if (!input.loserIdentity.merge_sha || !input.loserIdentity.head_sha) {
    return {
      path: artifactPath,
      written: false,
      bytes: 0,
      skippedReason: 'missing_identity',
    };
  }
  const maxBytes = input.maxBytes ?? LOSER_PATCH_MAX_BYTES;
  const readPatch = input.deps?.readPatch ?? ((args, cap) => defaultReadPatch(input.repoDir, args, cap));
  const patch = readPatch(['diff', input.loserIdentity.merge_sha, input.loserIdentity.head_sha], maxBytes);
  if (patch === 'too_large') {
    return {
      path: artifactPath,
      written: false,
      bytes: maxBytes + 1,
      skippedReason: 'too_large',
    };
  }
  mkdirSync(join(input.evalsDir, 'artifacts', input.challengePairId), { recursive: true });
  writeFileSync(artifactPath, patch);
  return {
    path: artifactPath,
    written: true,
    bytes: patch.length,
  };
}

/**
 * Build the LLM prompt used to compare two challenge PRs.
 */
export function buildComparisonPrompt(input: {
  issuePrompt: string;
  primaryDiff: string;
  challengerDiff: string;
  sharedPrefixDiff?: string;
  presentationOrder: PresentationOrder;
  promptTemplate?: string;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
  challengeType?: string;
  primaryStageEval?: ChallengeStageEval;
  challengerStageEval?: ChallengeStageEval;
  primaryExecution?: ChallengeSideExecutionProvenance;
  challengerExecution?: ChallengeSideExecutionProvenance;
}): string {
  let workflowContext = '';
  let stageEvidenceContext = '';
  const sideA = sideView(input.presentationOrder, 'A', input);
  const sideB = sideView(input.presentationOrder, 'B', input);

  if (input.primaryRouting && input.challengerRouting) {
    const variedDimensions = detectVariedDimensions(input.primaryRouting, input.challengerRouting);
    const variedFields: string[] = [];
    if (variedDimensions) {
      if (variedDimensions.planner) variedFields.push('planner');
      if (variedDimensions.coder) variedFields.push('coder');
      if (variedDimensions.reviewer) variedFields.push('reviewer');
      if (variedDimensions.planDepth) variedFields.push('planDepth');
      if (variedDimensions.codeDepth) variedFields.push('codeDepth');
      if (variedDimensions.reviewMode) variedFields.push('reviewMode');
    }

    workflowContext = `

## Workflow Context

Intended routing:
Candidate A side:
- Planner: ${sideA.routing?.planner} | Coder: ${sideA.routing?.coder} | Reviewer: ${sideA.routing?.reviewer}
- Plan depth: ${sideA.routing?.planDepth} | Code depth: ${sideA.routing?.codeDepth} | Review mode: ${sideA.routing?.reviewMode}

Candidate B side:
- Planner: ${sideB.routing?.planner} | Coder: ${sideB.routing?.coder} | Reviewer: ${sideB.routing?.reviewer}
- Plan depth: ${sideB.routing?.planDepth} | Code depth: ${sideB.routing?.codeDepth} | Review mode: ${sideB.routing?.reviewMode}

Variables that differed: ${variedFields.join(', ') || 'none'}
${formatExecutionPromptContext(sideA.execution, sideB.execution)}
Consider whether routing differences (not just code differences) may have influenced the outcome.
`;
  }

  if (
    (input.challengeType === 'planner-only' || input.challengeType === 'reviewer-only')
    && sideA.stageEval?.provenance === 'direct'
    && sideB.stageEval?.provenance === 'direct'
  ) {
    stageEvidenceContext = `

## Direct Stage Evidence

Use this evidence as the primary signal for the varied stage.

${formatStageEvidenceBlock('Candidate A', sideA.stageEval)}

${formatStageEvidenceBlock('Candidate B', sideB.stageEval)}
`;
  }

  const sharedPrefixContext = input.sharedPrefixDiff === undefined ? '' : `

Shared prefix diff (common context for both candidates; do not score as a candidate-specific contribution):
${input.sharedPrefixDiff}`;

  return fillPromptTemplate(input.promptTemplate ?? DEFAULT_ARBITER_JUDGE_PROMPT_TEMPLATE, {
    RUBRIC: formatRubricForJudgePrompt(),
    WORKFLOW_CONTEXT: workflowContext,
    STAGE_EVIDENCE_CONTEXT: stageEvidenceContext,
    ISSUE_PROMPT: input.issuePrompt,
    SHARED_PREFIX_CONTEXT: sharedPrefixContext,
    CANDIDATE_A_DIFF: sideA.diff,
    CANDIDATE_B_DIFF: sideB.diff,
  });
}

function sideView(
  order: PresentationOrder,
  candidate: CandidateKey,
  input: {
    primaryDiff: string;
    challengerDiff: string;
    primaryRouting?: ChallengeRoutingMeta;
    challengerRouting?: ChallengeRoutingMeta;
    primaryStageEval?: ChallengeStageEval;
    challengerStageEval?: ChallengeStageEval;
    primaryExecution?: ChallengeSideExecutionProvenance;
    challengerExecution?: ChallengeSideExecutionProvenance;
  },
): {
  diff: string;
  routing?: ChallengeRoutingMeta;
  stageEval?: ChallengeStageEval;
  execution?: ChallengeSideExecutionProvenance;
} {
  const isPrimary = order === 'primary-first' ? candidate === 'A' : candidate === 'B';
  return isPrimary
    ? {
        diff: input.primaryDiff,
        routing: input.primaryRouting,
        stageEval: input.primaryStageEval,
        execution: input.primaryExecution,
      }
    : {
        diff: input.challengerDiff,
        routing: input.challengerRouting,
        stageEval: input.challengerStageEval,
        execution: input.challengerExecution,
      };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function prefixWithinByteBudget(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (byteLength(candidate) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function truncateDiffForPrompt(text: string, label: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;

  let kept = prefixWithinByteBudget(text, maxBytes);
  for (let i = 0; i < 8; i++) {
    const marker = `\n[... TRUNCATED ${label} diff from ${byteLength(text)} bytes to fit comparison prompt ...]\n`;
    const remainingForContent = maxBytes - byteLength(marker);
    const nextKept = prefixWithinByteBudget(text, remainingForContent);
    if (nextKept === kept) {
      return `${kept}${marker}`;
    }
    kept = nextKept;
  }

  return kept;
}

export function buildCappedComparisonPrompt(
  input: Parameters<typeof buildComparisonPrompt>[0],
  maxPromptBytes: number,
): { prompt: string; truncated: boolean; originalBytes: number; finalBytes: number } {
  const originalPrompt = buildComparisonPrompt(input);
  const originalBytes = byteLength(originalPrompt);
  if (!Number.isFinite(maxPromptBytes) || maxPromptBytes <= 0 || originalBytes <= maxPromptBytes) {
    return { prompt: originalPrompt, truncated: false, originalBytes, finalBytes: originalBytes };
  }

  const scaffoldBytes = byteLength(buildComparisonPrompt({
    ...input,
    primaryDiff: '',
    challengerDiff: '',
    ...(input.sharedPrefixDiff !== undefined ? { sharedPrefixDiff: '' } : {}),
  }));
  let availableDiffBytes = Math.max(0, maxPromptBytes - scaffoldBytes);
  const sharedPrefixBytes = byteLength(input.sharedPrefixDiff ?? '');
  const primaryBytes = byteLength(input.primaryDiff);
  const challengerBytes = byteLength(input.challengerDiff);
  const totalDiffBytes = sharedPrefixBytes + primaryBytes + challengerBytes;
  const sharedPrefixBudget = totalDiffBytes > 0
    ? Math.floor(availableDiffBytes * (sharedPrefixBytes / totalDiffBytes))
    : 0;
  const primaryBudget = totalDiffBytes > 0
    ? Math.floor(availableDiffBytes * (primaryBytes / totalDiffBytes))
    : 0;
  const challengerBudget = Math.max(0, availableDiffBytes - sharedPrefixBudget - primaryBudget);

  let prompt = buildComparisonPrompt({
    ...input,
    ...(input.sharedPrefixDiff !== undefined
      ? { sharedPrefixDiff: truncateDiffForPrompt(input.sharedPrefixDiff, 'shared prefix', sharedPrefixBudget) }
      : {}),
    primaryDiff: truncateDiffForPrompt(
      input.primaryDiff,
      input.presentationOrder === 'primary-first' ? 'candidate A' : 'candidate B',
      primaryBudget,
    ),
    challengerDiff: truncateDiffForPrompt(
      input.challengerDiff,
      input.presentationOrder === 'primary-first' ? 'candidate B' : 'candidate A',
      challengerBudget,
    ),
  });

  while (byteLength(prompt) > maxPromptBytes && availableDiffBytes > 0) {
    availableDiffBytes = Math.floor(availableDiffBytes * 0.9);
    const nextSharedPrefixBudget = totalDiffBytes > 0
      ? Math.floor(availableDiffBytes * (sharedPrefixBytes / totalDiffBytes))
      : 0;
    const nextPrimaryBudget = totalDiffBytes > 0
      ? Math.floor(availableDiffBytes * (primaryBytes / totalDiffBytes))
      : 0;
    const nextChallengerBudget = Math.max(0, availableDiffBytes - nextSharedPrefixBudget - nextPrimaryBudget);
    prompt = buildComparisonPrompt({
      ...input,
      ...(input.sharedPrefixDiff !== undefined
        ? { sharedPrefixDiff: truncateDiffForPrompt(input.sharedPrefixDiff, 'shared prefix', nextSharedPrefixBudget) }
        : {}),
      primaryDiff: truncateDiffForPrompt(
        input.primaryDiff,
        input.presentationOrder === 'primary-first' ? 'candidate A' : 'candidate B',
        nextPrimaryBudget,
      ),
      challengerDiff: truncateDiffForPrompt(
        input.challengerDiff,
        input.presentationOrder === 'primary-first' ? 'candidate B' : 'candidate A',
        nextChallengerBudget,
      ),
    });
  }

  return {
    prompt,
    truncated: true,
    originalBytes,
    finalBytes: byteLength(prompt),
  };
}

export type ComparisonPromptInput = Parameters<typeof buildComparisonPrompt>[0];

export type BlindJudgeCall = (
  prompt: string,
  options?: LLMCallOptions,
) => Promise<LLMCallResult>;

export interface BlindJudgeInput extends ComparisonPromptInput {
  promptTemplate: string;
  model: string;
  maxPromptBytes: number;
  deps?: {
    callLlm?: BlindJudgeCall;
  };
}

export interface BlindJudgeOutcome {
  verdict: ValidatedComparisonResult;
  judgePrompt: string;
  judgePromptHash: string;
  judgeModel: string;
  costUsd: number | null;
  usage?: LLMCallResult['usage'];
  truncated: boolean;
  promptBytes: {
    original: number;
    final: number;
  };
  retriedStricterJson: boolean;
}

export const STRICTER_JSON_RETRY_SUFFIX = `IMPORTANT: Return ONLY valid JSON. Do NOT use:
- JavaScript shorthand properties (use "key": value, not key)
- Spread syntax (...rest)
- Unquoted property names
- Code comments or explanations

Return a raw JSON object with no code fences, no comments, and no JavaScript syntax.`;

/**
 * Run the production blind PR comparison judge.
 *
 * This is extracted from tools/compare-prs.ts so replay harnesses measure the
 * same prompt, cap, model call, validation, side mapping, and stricter-JSON
 * retry path as the production adjudicator.
 */
export async function runBlindJudge(input: BlindJudgeInput): Promise<BlindJudgeOutcome> {
  const cappedPrompt = buildCappedComparisonPrompt(input, input.maxPromptBytes);
  const callLlm = input.deps?.callLlm ?? callClaude;
  let successfulJudgePrompt = cappedPrompt.prompt;
  let retriedStricterJson = false;

  let response = await callLlm(cappedPrompt.prompt, {
    mode: 'sync',
    model: input.model,
    timeout: 180_000,
    retry: true,
    maxRetries: 2,
  });

  let verdict: ValidatedComparisonResult;
  try {
    verdict = mapBlindVerdictToSides(
      validateComparisonJson(parseJsonFromLLM(response.text)),
      input.presentationOrder,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('JavaScript code instead of JSON')) {
      throw error;
    }

    retriedStricterJson = true;
    const stricterPrompt = `${cappedPrompt.prompt}\n\n${STRICTER_JSON_RETRY_SUFFIX}`;
    response = await callLlm(stricterPrompt, {
      mode: 'sync',
      model: input.model,
      timeout: 180_000,
      retry: false,
    });
    successfulJudgePrompt = stricterPrompt;
    verdict = mapBlindVerdictToSides(
      validateComparisonJson(parseJsonFromLLM(response.text)),
      input.presentationOrder,
    );
  }

  return {
    verdict,
    judgePrompt: successfulJudgePrompt,
    judgePromptHash: hashString(successfulJudgePrompt),
    judgeModel: input.model,
    costUsd: response.costUsd ?? null,
    usage: response.usage,
    truncated: cappedPrompt.truncated,
    promptBytes: {
      original: cappedPrompt.originalBytes,
      final: cappedPrompt.finalBytes,
    },
    retriedStricterJson,
  };
}

/**
 * Validate and normalize the LLM comparison response payload.
 */
export function validateComparisonJson(parsed: any): BlindComparisonResult {
  const winner = parsed?.winner;
  const rationale = parsed?.rationale;
  const dimensions = parsed?.dimensions;
  const workflowInsight = parsed?.workflowInsight;
  const criterionRationales = parsed?.criterionRationales;

  if (winner === 'primary' || winner === 'challenger') {
    throw new Error('Unblinded comparison winner keys are not allowed. Use A or B.');
  }
  if (winner !== 'A' && winner !== 'B') {
    throw new Error(`Invalid blind winner: ${winner}`);
  }
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    throw new Error('Comparison rationale must be a non-empty string');
  }
  if (workflowInsight !== undefined && typeof workflowInsight !== 'string') {
    throw new Error('workflowInsight must be a string if provided');
  }
  for (const key of REQUIRED_DIMENSION_KEYS) {
    const dimension = dimensions?.[key];
    if (dimension?.primary !== undefined || dimension?.challenger !== undefined) {
      throw new Error(`Unblinded comparison dimension keys are not allowed for ${key}. Use A and B.`);
    }
    if (!dimension || typeof dimension.A !== 'number' || typeof dimension.B !== 'number') {
      throw new Error(`Invalid dimension payload for ${key}`);
    }
    if (
      !Number.isInteger(dimension.A) ||
      !Number.isInteger(dimension.B) ||
      dimension.A < 1 ||
      dimension.A > 10 ||
      dimension.B < 1 ||
      dimension.B > 10
    ) {
      throw new Error(
        `Invalid ${key} scores: A=${dimension.A}, B=${dimension.B}. ` +
        'Expected integers from 1 to 10.'
      );
    }
  }

  if (dimensions?.scopeDiscipline !== undefined || dimensions?.codeQuality !== undefined) {
    throw new Error('Legacy comparison keys are not allowed. Use canonical rubric keys only.');
  }
  if (!criterionRationales || typeof criterionRationales !== 'object' || Array.isArray(criterionRationales)) {
    throw new Error('criterionRationales must be an object keyed by canonical rubric criterion');
  }
  if (
    criterionRationales.primary !== undefined ||
    criterionRationales.challenger !== undefined ||
    criterionRationales.A !== undefined ||
    criterionRationales.B !== undefined
  ) {
    throw new Error('Unblinded or side-level criterionRationales keys are not allowed. Use criterion keys only.');
  }
  if (criterionRationales.scopeDiscipline !== undefined || criterionRationales.codeQuality !== undefined) {
    throw new Error('Legacy criterionRationales keys are not allowed. Use canonical rubric keys only.');
  }

  const normalizedCriterionRationales = {} as BlindComparisonCriterionRationales;
  for (const key of REQUIRED_DIMENSION_KEYS) {
    const entry = criterionRationales[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid criterionRationales payload for ${key}`);
    }
    if (entry.primary !== undefined || entry.challenger !== undefined || entry.A !== undefined || entry.B !== undefined) {
      throw new Error(`Unblinded or side-level criterionRationales keys are not allowed for ${key}. Use rationale only.`);
    }
    if (typeof entry.rationale !== 'string' || entry.rationale.trim().length === 0) {
      throw new Error(`criterionRationales.${key}.rationale must be a non-empty string`);
    }
    normalizedCriterionRationales[key] = { rationale: entry.rationale.trim() };
  }

  const result: BlindComparisonResult = {
    winner,
    rationale: rationale.trim(),
    dimensions: dimensions as BlindComparisonDimensions,
    criterionRationales: normalizedCriterionRationales,
  };
  if (workflowInsight && workflowInsight.trim().length > 0) {
    result.workflowInsight = workflowInsight.trim();
  }
  return result;
}

export function mapBlindVerdictToSides(
  verdict: BlindComparisonResult,
  order: PresentationOrder,
): ValidatedComparisonResult {
  const aSide = order === 'primary-first' ? 'primary' : 'challenger';
  const bSide = order === 'primary-first' ? 'challenger' : 'primary';
  const winner = verdict.winner === 'A' ? aSide : bSide;
  const dimensions = Object.fromEntries(
    Object.entries(verdict.dimensions).map(([key, scores]) => [
      key,
      {
        primary: aSide === 'primary' ? scores.A : scores.B,
        challenger: aSide === 'challenger' ? scores.A : scores.B,
      },
    ]),
  ) as ChallengeComparisonDimensions;
  const criterionRationales = Object.fromEntries(
    Object.entries(verdict.criterionRationales).map(([key, entry]) => [
      key,
      { rationale: entry.rationale },
    ]),
  ) as ChallengeCriterionRationales;

  const result: ValidatedComparisonResult = {
    winner,
    rationale: verdict.rationale,
    dimensions,
    criterionRationales,
  };
  if (verdict.workflowInsight) {
    result.workflowInsight = verdict.workflowInsight;
  }
  return result;
}

/**
 * Run a GitHub CLI command and return trimmed stdout.
 */
export function runGh(args: string[], repoDir: string): string {
  try {
    return execFileSync('gh', args, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(`gh ${args.join(' ')} failed: ${errorMessage(error)}`);
  }
}

/**
 * Run a GitHub CLI command and warn instead of throwing on failure.
 */
export function tryGh(args: string[], repoDir: string, label: string): void {
  try {
    runGh(args, repoDir);
  } catch (error) {
    console.warn(`[compare-prs] ${label} failed: ${errorMessage(error)}`);
  }
}

/**
 * Write a temporary body file for `gh` commands and clean it up afterward.
 */
export function withBodyFile<T>(body: string, fn: (filePath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-compare-'));
  const filePath = join(dir, 'body.txt');
  writeFileSync(filePath, body, 'utf-8');
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Build the PR comment body for a challenge comparison result.
 */
export function buildChallengeCommentBody(input: {
  pairId: string;
  winner?: 'primary' | 'challenger';
  winnerModel?: string;
  rationale: string;
  otherPrUrl: string;
  routingSummary?: string;
  provenanceValidation?: ChallengeProvenanceValidation;
}): string {
  const commentParts = [
    `Challenge comparison for \`${input.pairId}\``,
    ``,
  ];

  if (input.routingSummary) {
    commentParts.push(input.routingSummary, '');
  }

  if (input.provenanceValidation && !input.provenanceValidation.valid) {
    commentParts.push(
      `Comparison outcome: ${input.provenanceValidation.outcome ?? 'invalid'}`,
      `Other PR: ${input.otherPrUrl}`,
      ``,
      input.rationale,
    );
    return commentParts.join('\n');
  }

  commentParts.push(
    `Recommended winner: ${input.winner} (${input.winnerModel})`,
    `Other PR: ${input.otherPrUrl}`,
    ``,
    input.rationale,
  );

  return commentParts.join('\n');
}

function formatExecutedStage(stage: ChallengeSideExecutionProvenance[keyof ChallengeSideExecutionProvenance]): string {
  const agent = stage.agent || 'unknown-agent';
  const model = stage.model || 'unknown-model';
  const status = stage.status || 'unknown-status';
  const path = stage.artifactPath ? ` @ ${stage.artifactPath}` : '';
  return `${agent}/${model} [${status}, ${stage.source}${path}]`;
}

function formatExecutionPromptContext(
  candidateAExecution?: ChallengeSideExecutionProvenance,
  candidateBExecution?: ChallengeSideExecutionProvenance,
): string {
  if (!candidateAExecution || !candidateBExecution) return '';
  return `
Executed provenance:
- Candidate A planner: ${formatExecutedStage(candidateAExecution.planning)}
- Candidate A coder: ${formatExecutedStage(candidateAExecution.coding)}
- Candidate A reviewer: ${formatExecutedStage(candidateAExecution.review)}
- Candidate B planner: ${formatExecutedStage(candidateBExecution.planning)}
- Candidate B coder: ${formatExecutedStage(candidateBExecution.coding)}
- Candidate B reviewer: ${formatExecutedStage(candidateBExecution.review)}
`;
}

/**
 * Format routing metadata for PR comment output.
 */
export function formatRoutingSummary(
  primaryRouting?: ChallengeRoutingMeta,
  challengerRouting?: ChallengeRoutingMeta,
  challengeType?: string,
  primaryExecution?: ChallengeSideExecutionProvenance,
  challengerExecution?: ChallengeSideExecutionProvenance,
  provenanceValidation?: ChallengeProvenanceValidation,
): string {
  if (!primaryRouting || !challengerRouting) {
    return '';
  }

  const parts: string[] = [];

  parts.push(
    `Primary intended ${primaryRouting.planner || 'unknown'} (planner) + ${primaryRouting.coder} (coder)` +
    (primaryRouting.reviewer ? ` + ${primaryRouting.reviewer} (reviewer)` : '')
  );
  parts.push(
    `Challenger intended ${challengerRouting.planner || 'unknown'} (planner) + ${challengerRouting.coder} (coder)` +
    (challengerRouting.reviewer ? ` + ${challengerRouting.reviewer} (reviewer)` : '')
  );

  let summary = parts.join(' vs ');

  if (primaryExecution && challengerExecution) {
    summary += `\nExecuted primary: planner ${formatExecutedStage(primaryExecution.planning)}; coder ${formatExecutedStage(primaryExecution.coding)}; reviewer ${formatExecutedStage(primaryExecution.review)}`;
    summary += `\nExecuted challenger: planner ${formatExecutedStage(challengerExecution.planning)}; coder ${formatExecutedStage(challengerExecution.coding)}; reviewer ${formatExecutedStage(challengerExecution.review)}`;
  }

  if (provenanceValidation && !provenanceValidation.valid) {
    const reasonLines = provenanceValidation.issues.map((issue) => {
      const path = issue.artifactPath ? ` path=${issue.artifactPath}` : '';
      const intended = issue.intendedModel ? ` intended=${issue.intendedModel}` : '';
      const executed = issue.executedModel ? ` executed=${issue.executedModel}` : '';
      return `- ${issue.side} ${issue.role}: ${issue.reason}${intended}${executed}${path}`;
    });
    summary += `\nProvenance validation: ${provenanceValidation.outcome ?? 'invalid'}\n${reasonLines.join('\n')}`;
  }

  if (challengeType) {
    summary += `\nChallenge type: ${challengeType}`;
  }

  return summary;
}
