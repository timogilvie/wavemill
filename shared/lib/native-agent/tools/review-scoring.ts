// ---------------------------------------------------------------------------
// Native review — bounded eval/scoring tools (HOK-3061).
//
// Wraps a small number of pure, read-only scorers behind stable tool contracts
// so the native review agent can request advisory diagnostics without ever
// recursing into another review, mutating routing/reward state, persisting an
// eval record, or contacting the network.
//
// All output is byte-stable given identical evidence: canonical JSON, sorted
// diagnostics, no timestamps, no locale-sensitive formatting, no randomness.
// Missing / malformed / oversized / conflicting evidence returns a structured
// non-score state rather than fabricated zero-confidence metrics.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  analyzeDiffStats,
  computeDifficultyBand,
  computeStratum,
  detectTechStack,
} from '../../difficulty-analyzer.ts';
import {
  analyzeTaskContext,
  type IssueData,
} from '../../task-context-analyzer.ts';
import type {
  DifficultyBand,
  Stratum,
  TaskContext,
  WavemillRouterMeasurementPolicy,
} from '../../eval-schema.ts';
import {
  scorePatchSelection,
  WAVEMILL_PATCH_SELECTION_SCORER_ID,
  type PatchSelectionScoreRecord,
} from '../../../../src/evaluation/scorers/wavemill/patch-selection.ts';
import {
  scoreWavemillSuccessRateUnderBudget,
  WAVEMILL_SUCCESS_RATE_UNDER_BUDGET_SCORER_ID,
  type WavemillRouterScoreRecord,
} from '../../../../src/evaluation/scorers/wavemill/success-rate-under-budget.ts';
import type { ReplayPatchSelectionInstance } from '../../../fixtures/harness-replay/patch-selection-v1/schema.ts';
import { buildTrustMetadata } from '../provenance.ts';
import type { ToolDescriptor, ToolMetadata, WavemillToolResult } from './types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTPUT_MAX_BYTES = 32_768;
const EVIDENCE_MAX_BYTES = 512 * 1024; // per resolved evidence ref
const RECORD_MAX_ITEMS = 200;
const RATIONALE_MAX_BYTES = 2_048;
const DIAGNOSTICS_MAX_BYTES = 4_096;
const DIFF_SUBPROCESS_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_BRANCH = 'auto/integration';
const MEASUREMENT_POLICIES: readonly WavemillRouterMeasurementPolicy[] = Object.freeze([
  'replay_exact_match',
  'challenge_prospective',
  'subagent_model_economics_shadow',
]);
const EVIDENCE_REFS = Object.freeze(['workspace_diff', 'task_packet', 'selected_task']);

const TOOL_VERSIONS = {
  score_diff_difficulty: 'native-review.score_diff_difficulty:v1',
  score_task_context: 'native-review.score_task_context:v1',
  score_patch_selection: 'native-review.score_patch_selection:v1',
  score_success_rate_under_budget: 'native-review.score_success_rate_under_budget:v1',
} as const;

// ---------------------------------------------------------------------------
// Canonicalisation + digest helpers
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

export type EligibilityState =
  | 'eligible'
  | 'missing_evidence'
  | 'malformed_evidence'
  | 'oversized_evidence'
  | 'conflicting_evidence';

export interface EvidenceRecord {
  ref: string;
  digest: string;
  bytes: number;
}

export interface ReviewScoringResult {
  scorer: string;
  toolVersion: string;
  inputDigest: string;
  evidence: EvidenceRecord[];
  eligibility: EligibilityState;
  metrics?: Record<string, number>;
  rationale: string;
  diagnostics: string[];
  advisory: true;
}

export interface ReviewScoringDetails extends ReviewScoringResult {
  truncated?: boolean;
  originalBytes?: number;
  retainedBytes?: number;
}

// ---------------------------------------------------------------------------
// Evidence resolution
// ---------------------------------------------------------------------------

type EvidenceRef = 'workspace_diff' | 'task_packet' | 'selected_task';

interface ResolvedEvidence {
  ref: EvidenceRef;
  digest: string;
  bytes: number;
  text: string;
}

interface EvidenceProblem {
  ref: EvidenceRef;
  state: EligibilityState;
  diagnostic: string;
  originalBytes?: number;
}

type EvidenceOutcome =
  | { kind: 'ok'; evidence: ResolvedEvidence }
  | { kind: 'problem'; problem: EvidenceProblem };

function looksLikeUtf8(buf: Buffer): boolean {
  // Cheap heuristic: reject NUL bytes (binary) and check UTF-8 round-trip.
  for (let i = 0; i < Math.min(buf.length, 8192); i++) {
    if (buf[i] === 0) return false;
  }
  const decoded = buf.toString('utf8');
  const reencoded = Buffer.from(decoded, 'utf8');
  return reencoded.equals(buf);
}

function resolveFeatureDir(worktreePath: string): {
  dir: string | null;
  problem?: EvidenceProblem;
} {
  const featuresRoot = path.join(worktreePath, 'features');
  const bugsRoot = path.join(worktreePath, 'bugs');
  const candidates: string[] = [];
  for (const root of [featuresRoot, bugsRoot]) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      candidates.push(path.join(root, name));
    }
  }
  if (candidates.length === 0) {
    return {
      dir: null,
      problem: {
        ref: 'task_packet',
        state: 'missing_evidence',
        diagnostic: 'no features/ or bugs/ feature directory found under worktree',
      },
    };
  }
  if (candidates.length > 1) {
    return {
      dir: null,
      problem: {
        ref: 'task_packet',
        state: 'conflicting_evidence',
        diagnostic: `multiple feature directories present: ${candidates
          .map((p) => path.relative(worktreePath, p))
          .join(', ')}`,
      },
    };
  }
  return { dir: candidates[0]! };
}

async function readWorkspaceDiff(
  worktreePath: string,
  signal: AbortSignal | undefined,
): Promise<EvidenceOutcome> {
  const base = process.env.WAVEMILL_REVIEW_BASE_BRANCH || DEFAULT_BASE_BRANCH;
  const diffSpec = `${base}...HEAD`;
  const diffResult = await spawnGitDiff(worktreePath, diffSpec, signal);
  if (diffResult.kind === 'error') {
    return {
      kind: 'problem',
      problem: {
        ref: 'workspace_diff',
        state: 'missing_evidence',
        diagnostic: `git diff failed: ${diffResult.message}`,
      },
    };
  }
  const text = diffResult.stdout;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) {
    return {
      kind: 'problem',
      problem: {
        ref: 'workspace_diff',
        state: 'missing_evidence',
        diagnostic: 'workspace_diff resolved to 0 bytes',
      },
    };
  }
  if (bytes > EVIDENCE_MAX_BYTES) {
    return {
      kind: 'problem',
      problem: {
        ref: 'workspace_diff',
        state: 'oversized_evidence',
        diagnostic: `workspace_diff exceeds ${EVIDENCE_MAX_BYTES}-byte limit`,
        originalBytes: bytes,
      },
    };
  }
  return {
    kind: 'ok',
    evidence: { ref: 'workspace_diff', digest: sha256Hex(text), bytes, text },
  };
}

interface GitDiffOk {
  kind: 'ok';
  stdout: string;
}
interface GitDiffErr {
  kind: 'error';
  message: string;
}

async function spawnGitDiff(
  cwd: string,
  diffSpec: string,
  signal: AbortSignal | undefined,
): Promise<GitDiffOk | GitDiffErr> {
  return await new Promise<GitDiffOk | GitDiffErr>((resolvePromise) => {
    let timedOut = false;
    let settled = false;
    const child = spawn(
      'git',
      ['--no-pager', 'diff', '--no-color', diffSpec],
      {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Best-effort — the process may already have exited.
      }
    }, DIFF_SUBPROCESS_TIMEOUT_MS);

    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ kind: 'error', message: (err as Error).message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut) {
        resolvePromise({
          kind: 'error',
          message: `git diff timed out after ${DIFF_SUBPROCESS_TIMEOUT_MS}ms`,
        });
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        resolvePromise({
          kind: 'error',
          message: stderr || `git diff exited with code ${code}`,
        });
        return;
      }
      resolvePromise({
        kind: 'ok',
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      });
    });
  });
}

function readTaskPacket(
  worktreePath: string,
  featureDir: string,
): EvidenceOutcome {
  const combinedPath = path.join(featureDir, 'task-packet.md');
  const headerPath = path.join(featureDir, 'task-packet-header.md');
  const detailsPath = path.join(featureDir, 'task-packet-details.md');
  const selectedPath = path.join(featureDir, 'selected-task.json');

  const parts: string[] = [];
  let ok = false;
  const relFeature = path.relative(worktreePath, featureDir) || '.';

  if (existsSync(combinedPath)) {
    const outcome = readFileAsText(combinedPath, 'task_packet');
    if (outcome.kind === 'problem') return outcome;
    parts.push(outcome.evidence.text);
    ok = true;
  } else if (existsSync(headerPath) || existsSync(detailsPath)) {
    if (existsSync(headerPath)) {
      const outcome = readFileAsText(headerPath, 'task_packet');
      if (outcome.kind === 'problem') return outcome;
      parts.push(outcome.evidence.text);
    }
    if (existsSync(detailsPath)) {
      const outcome = readFileAsText(detailsPath, 'task_packet');
      if (outcome.kind === 'problem') return outcome;
      parts.push(outcome.evidence.text);
    }
    ok = true;
  } else if (existsSync(selectedPath)) {
    // Fallback: use selected-task.json description as packet body.
    const outcome = readFileAsText(selectedPath, 'task_packet');
    if (outcome.kind === 'problem') return outcome;
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.evidence.text);
    } catch (err) {
      return {
        kind: 'problem',
        problem: {
          ref: 'task_packet',
          state: 'malformed_evidence',
          diagnostic: `selected-task.json is not valid JSON: ${(err as Error).message}`,
        },
      };
    }
    const description =
      parsed && typeof parsed === 'object' && 'description' in parsed
        ? String((parsed as { description?: unknown }).description ?? '')
        : '';
    if (!description) {
      return {
        kind: 'problem',
        problem: {
          ref: 'task_packet',
          state: 'missing_evidence',
          diagnostic: 'no task-packet.md and selected-task.json has no description',
        },
      };
    }
    parts.push(description);
    ok = true;
  }

  if (!ok) {
    return {
      kind: 'problem',
      problem: {
        ref: 'task_packet',
        state: 'missing_evidence',
        diagnostic: `no task packet found in ${relFeature}`,
      },
    };
  }

  const text = parts.join('\n\n');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) {
    return {
      kind: 'problem',
      problem: {
        ref: 'task_packet',
        state: 'missing_evidence',
        diagnostic: `task packet in ${relFeature} is empty`,
      },
    };
  }
  if (bytes > EVIDENCE_MAX_BYTES) {
    return {
      kind: 'problem',
      problem: {
        ref: 'task_packet',
        state: 'oversized_evidence',
        diagnostic: `task_packet exceeds ${EVIDENCE_MAX_BYTES}-byte limit`,
        originalBytes: bytes,
      },
    };
  }
  return {
    kind: 'ok',
    evidence: { ref: 'task_packet', digest: sha256Hex(text), bytes, text },
  };
}

function readSelectedTask(
  worktreePath: string,
  featureDir: string,
): EvidenceOutcome {
  const selectedPath = path.join(featureDir, 'selected-task.json');
  const relFeature = path.relative(worktreePath, featureDir) || '.';
  if (!existsSync(selectedPath)) {
    return {
      kind: 'problem',
      problem: {
        ref: 'selected_task',
        state: 'missing_evidence',
        diagnostic: `no selected-task.json in ${relFeature}`,
      },
    };
  }
  const outcome = readFileAsText(selectedPath, 'selected_task');
  if (outcome.kind === 'problem') return outcome;
  try {
    JSON.parse(outcome.evidence.text);
  } catch (err) {
    return {
      kind: 'problem',
      problem: {
        ref: 'selected_task',
        state: 'malformed_evidence',
        diagnostic: `selected-task.json is not valid JSON: ${(err as Error).message}`,
      },
    };
  }
  return outcome;
}

function readFileAsText(absPath: string, ref: EvidenceRef): EvidenceOutcome {
  let stat;
  try {
    stat = statSync(absPath);
  } catch (err) {
    return {
      kind: 'problem',
      problem: {
        ref,
        state: 'missing_evidence',
        diagnostic: `cannot stat file: ${(err as Error).message}`,
      },
    };
  }
  if (stat.size > EVIDENCE_MAX_BYTES) {
    return {
      kind: 'problem',
      problem: {
        ref,
        state: 'oversized_evidence',
        diagnostic: `${ref} exceeds ${EVIDENCE_MAX_BYTES}-byte limit`,
        originalBytes: stat.size,
      },
    };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch (err) {
    return {
      kind: 'problem',
      problem: {
        ref,
        state: 'missing_evidence',
        diagnostic: `cannot read file: ${(err as Error).message}`,
      },
    };
  }
  if (!looksLikeUtf8(buf)) {
    return {
      kind: 'problem',
      problem: {
        ref,
        state: 'malformed_evidence',
        diagnostic: `${ref} is not valid UTF-8`,
      },
    };
  }
  const text = buf.toString('utf8');
  return {
    kind: 'ok',
    evidence: { ref, digest: sha256Hex(buf), bytes: buf.length, text },
  };
}

function parseIssueFromSelectedTask(text: string): IssueData {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const rec = parsed as Record<string, unknown>;
  const labelsField = rec.labels;
  let labels: string[] | undefined;
  if (Array.isArray(labelsField)) {
    labels = labelsField
      .map((l) => (typeof l === 'string' ? l : (l && typeof l === 'object' && 'name' in (l as object) ? String((l as { name?: unknown }).name ?? '') : '')))
      .filter((s) => s.length > 0);
  }
  return {
    ...(typeof rec.title === 'string' ? { title: rec.title } : {}),
    ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
    ...(typeof rec.identifier === 'string'
      ? { identifier: rec.identifier }
      : typeof rec.taskId === 'string'
        ? { identifier: rec.taskId }
        : typeof rec.id === 'string'
          ? { identifier: rec.id }
          : {}),
    ...(labels ? { labels } : {}),
  };
}

// ---------------------------------------------------------------------------
// Envelope building
// ---------------------------------------------------------------------------

interface BuildEnvelopeInput {
  scorer: string;
  toolVersion: string;
  inputDigest: string;
  evidence: EvidenceRecord[];
  eligibility: EligibilityState;
  metrics?: Record<string, number>;
  rationale: string;
  diagnostics: string[];
}

function buildEnvelope(input: BuildEnvelopeInput): {
  content: WavemillToolResult<ReviewScoringDetails>['content'];
  details: ReviewScoringDetails;
} {
  const rationale = truncateUtf8(input.rationale, RATIONALE_MAX_BYTES);
  const diagnostics = capDiagnostics([...input.diagnostics].sort());
  const evidence = [...input.evidence].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  const envelope: ReviewScoringResult = {
    scorer: input.scorer,
    toolVersion: input.toolVersion,
    inputDigest: input.inputDigest,
    evidence,
    eligibility: input.eligibility,
    ...(input.metrics ? { metrics: input.metrics } : {}),
    rationale,
    diagnostics,
    advisory: true,
  };

  const canonical = canonicalJson(envelope);
  const originalBytes = Buffer.byteLength(canonical, 'utf8');
  const details: ReviewScoringDetails = { ...envelope };
  let text = canonical;
  if (originalBytes > OUTPUT_MAX_BYTES) {
    // Rationale is the only shrinkable field big enough to matter — recompute
    // with a shorter rationale so both content and details stay parseable.
    const overshoot = originalBytes - OUTPUT_MAX_BYTES;
    const rationaleBudget = Math.max(0, Buffer.byteLength(rationale, 'utf8') - overshoot - 64);
    const shorterRationale = truncateUtf8(rationale, rationaleBudget);
    const smaller: ReviewScoringResult = {
      ...envelope,
      rationale: shorterRationale,
    };
    text = canonicalJson(smaller);
    details.rationale = shorterRationale;
    details.truncated = true;
    details.originalBytes = originalBytes;
    details.retainedBytes = Buffer.byteLength(text, 'utf8');
  }

  return {
    content: [{ type: 'text', text }],
    details,
  };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

function capDiagnostics(diagnostics: string[]): string[] {
  const out: string[] = [];
  let total = 0;
  for (const entry of diagnostics) {
    const size = Buffer.byteLength(entry, 'utf8') + 1;
    if (total + size > DIAGNOSTICS_MAX_BYTES) {
      out.push('[diagnostics truncated to fit output cap]');
      break;
    }
    out.push(entry);
    total += size;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

interface ScoreDiffDifficultyParams {
  evidence?: 'workspace_diff';
}

async function executeScoreDiffDifficulty(
  worktreePath: string,
  params: ScoreDiffDifficultyParams,
  signal: AbortSignal | undefined,
): Promise<WavemillToolResult<ReviewScoringDetails>> {
  const scorer = 'wavemill.native-review.diff_difficulty:v1';
  const toolVersion = TOOL_VERSIONS.score_diff_difficulty;
  const ref = params?.evidence ?? 'workspace_diff';
  if (ref !== 'workspace_diff') {
    return finalize(
      buildEnvelope({
        scorer,
        toolVersion,
        inputDigest: sha256Hex(canonicalJson({ ref })),
        evidence: [],
        eligibility: 'malformed_evidence',
        rationale: 'score_diff_difficulty accepts only the workspace_diff evidence ref.',
        diagnostics: [`evidence: unsupported ref "${ref}"`],
      }),
    );
  }
  if (signal?.aborted) return abortedResult(scorer, toolVersion);
  const diffOutcome = await readWorkspaceDiff(worktreePath, signal);
  if (diffOutcome.kind === 'problem') {
    return finalize(problemEnvelope(scorer, toolVersion, [diffOutcome.problem]));
  }
  if (signal?.aborted) return abortedResult(scorer, toolVersion);
  const stats = analyzeDiffStats(diffOutcome.evidence.text);
  if (!stats) {
    return finalize(
      buildEnvelope({
        scorer,
        toolVersion,
        inputDigest: sha256Hex(diffOutcome.evidence.digest),
        evidence: [
          { ref: diffOutcome.evidence.ref, digest: diffOutcome.evidence.digest, bytes: diffOutcome.evidence.bytes },
        ],
        eligibility: 'malformed_evidence',
        rationale: 'workspace_diff did not parse as a git diff (numstat or unified).',
        diagnostics: ['workspace_diff: unparseable'],
      }),
    );
  }
  const band: DifficultyBand = computeDifficultyBand(stats);
  const techStack = detectTechStack(diffOutcome.evidence.text);
  const stratum: Stratum = computeStratum(techStack, stats);
  const metrics: Record<string, number> = {
    loc_touched: stats.locTouched,
    files_touched: stats.filesTouched,
  };
  return finalize(
    buildEnvelope({
      scorer,
      toolVersion,
      inputDigest: sha256Hex(diffOutcome.evidence.digest),
      evidence: [
        { ref: diffOutcome.evidence.ref, digest: diffOutcome.evidence.digest, bytes: diffOutcome.evidence.bytes },
      ],
      eligibility: 'eligible',
      metrics,
      rationale: `Diff parsed: locTouched=${stats.locTouched} filesTouched=${stats.filesTouched} band=${band} techStack=${techStack} stratum=${stratum}. Advisory only.`,
      diagnostics: [
        `difficulty_band: ${band}`,
        `stratum: ${stratum}`,
        `tech_stack: ${techStack}`,
      ],
    }),
    { sourceKind: 'diff' },
  );
}

interface ScoreTaskContextParams {
  evidence?: Array<'task_packet' | 'selected_task' | 'workspace_diff'>;
}

async function executeScoreTaskContext(
  worktreePath: string,
  params: ScoreTaskContextParams,
  signal: AbortSignal | undefined,
): Promise<WavemillToolResult<ReviewScoringDetails>> {
  const scorer = 'wavemill.native-review.task_context:v1';
  const toolVersion = TOOL_VERSIONS.score_task_context;
  const requested: readonly ('task_packet' | 'selected_task' | 'workspace_diff')[] =
    params?.evidence?.length ? params.evidence : ['task_packet', 'selected_task'];
  for (const ref of requested) {
    if (!EVIDENCE_REFS.includes(ref)) {
      return finalize(
        buildEnvelope({
          scorer,
          toolVersion,
          inputDigest: sha256Hex(canonicalJson({ refs: requested })),
          evidence: [],
          eligibility: 'malformed_evidence',
          rationale: `score_task_context received an unsupported evidence ref: ${ref}`,
          diagnostics: [`evidence: unsupported ref "${ref}"`],
        }),
      );
    }
  }
  const includeTaskPacket = requested.includes('task_packet');
  const includeSelectedTask = requested.includes('selected_task');
  const includeDiff = requested.includes('workspace_diff');

  const featureLookup = resolveFeatureDir(worktreePath);
  const problems: EvidenceProblem[] = [];
  const evidences: ResolvedEvidence[] = [];
  let issue: IssueData | undefined;
  let taskPacketText: string | undefined;

  if (featureLookup.problem && (includeTaskPacket || includeSelectedTask)) {
    problems.push(featureLookup.problem);
  }

  if (featureLookup.dir && includeTaskPacket) {
    const outcome = readTaskPacket(worktreePath, featureLookup.dir);
    if (outcome.kind === 'problem') {
      problems.push(outcome.problem);
    } else {
      evidences.push(outcome.evidence);
      taskPacketText = outcome.evidence.text;
    }
  }

  if (featureLookup.dir && includeSelectedTask) {
    const outcome = readSelectedTask(worktreePath, featureLookup.dir);
    if (outcome.kind === 'problem') {
      problems.push(outcome.problem);
    } else {
      evidences.push(outcome.evidence);
      issue = parseIssueFromSelectedTask(outcome.evidence.text);
    }
  }

  if (includeDiff) {
    if (signal?.aborted) return abortedResult(scorer, toolVersion);
    const outcome = await readWorkspaceDiff(worktreePath, signal);
    if (outcome.kind === 'problem') {
      // A missing diff is not fatal for task-context; downgrade to diagnostics only.
      problems.push(outcome.problem);
    } else {
      evidences.push(outcome.evidence);
    }
  }

  if (problems.length > 0 && evidences.length === 0) {
    return finalize(problemEnvelope(scorer, toolVersion, problems));
  }

  const diffText = includeDiff
    ? evidences.find((e) => e.ref === 'workspace_diff')?.text
    : undefined;
  const diffStats = diffText ? analyzeDiffStats(diffText) : null;

  // Header/details packet conflict detection.
  if (
    featureLookup.dir &&
    includeTaskPacket &&
    existsSync(path.join(featureLookup.dir, 'task-packet.md')) &&
    (existsSync(path.join(featureLookup.dir, 'task-packet-header.md')) ||
      existsSync(path.join(featureLookup.dir, 'task-packet-details.md')))
  ) {
    problems.push({
      ref: 'task_packet',
      state: 'conflicting_evidence',
      diagnostic: 'both task-packet.md and split header/details forms exist',
    });
    return finalize(problemEnvelope(scorer, toolVersion, problems));
  }

  const context: TaskContext = analyzeTaskContext({
    issue,
    ...(diffText ? { prDiff: diffText } : {}),
    ...(diffStats ? { filesTouched: diffStats.filesTouched, locTouched: diffStats.locTouched } : {}),
  });

  const metrics: Record<string, number> = {};
  if (typeof context.complexity === 'number') {
    metrics.complexity = context.complexity;
  }
  if (typeof context.filesTouchedEstimate === 'number') {
    metrics.files_touched_estimate = context.filesTouchedEstimate;
  }
  if (typeof context.expectedLoCChange === 'number') {
    metrics.expected_loc_change = context.expectedLoCChange;
  }

  const evidenceRecords: EvidenceRecord[] = evidences.map((e) => ({
    ref: e.ref,
    digest: e.digest,
    bytes: e.bytes,
  }));
  const inputDigest = sha256Hex(
    canonicalJson({ refs: evidences.map((e) => ({ ref: e.ref, digest: e.digest })) }),
  );

  const diagnostics = [
    `task_type: ${context.taskType}`,
    `change_kind: ${context.changeKind}`,
    `complexity: ${String(context.complexity)}`,
    ...(problems.length > 0
      ? problems.map((p) => `${p.ref}: ${p.state}: ${p.diagnostic}`)
      : []),
  ];
  if (taskPacketText && evidences.some((e) => e.ref === 'selected_task')) {
    // No cross-source contradiction detection today beyond structure — record
    // that both were consulted so downstream reviewers can audit.
    diagnostics.push('task_packet and selected_task both consulted');
  }

  return finalize(
    buildEnvelope({
      scorer,
      toolVersion,
      inputDigest,
      evidence: evidenceRecords,
      eligibility: 'eligible',
      metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
      rationale:
        `Task classified as ${context.taskType}/${context.changeKind} ` +
        `with complexity=${String(context.complexity)}. Advisory only.`,
      diagnostics,
    }),
    { sourceKind: evidences.some((e) => e.ref === 'workspace_diff') ? 'diff' : 'wavemill_artifact' },
  );
}

interface ScorePatchSelectionParams {
  measurementPolicy: WavemillRouterMeasurementPolicy;
  allowPatchFallback?: boolean;
  records: PatchSelectionScoreRecord[];
}

async function executeScorePatchSelection(
  _worktreePath: string,
  params: ScorePatchSelectionParams,
  signal: AbortSignal | undefined,
): Promise<WavemillToolResult<ReviewScoringDetails>> {
  const scorer = WAVEMILL_PATCH_SELECTION_SCORER_ID;
  const toolVersion = TOOL_VERSIONS.score_patch_selection;
  const validationError = validateMeasurementPolicy(params?.measurementPolicy);
  if (validationError) {
    return finalize(malformedEnvelope(scorer, toolVersion, params, [validationError]));
  }
  const records = params?.records;
  if (!Array.isArray(records)) {
    return finalize(
      malformedEnvelope(scorer, toolVersion, params, [
        'records: must be an array',
      ]),
    );
  }
  if (records.length > RECORD_MAX_ITEMS) {
    return finalize(
      buildEnvelope({
        scorer,
        toolVersion,
        inputDigest: sha256Hex(canonicalJson({ count: records.length })),
        evidence: [],
        eligibility: 'oversized_evidence',
        rationale: `records exceeds ${RECORD_MAX_ITEMS}-item limit`,
        diagnostics: [`records: ${records.length} items exceeds ${RECORD_MAX_ITEMS}-item cap`],
      }),
    );
  }
  const issues: string[] = [];
  const seen = new Map<string, string>();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const err = validatePatchSelectionRecord(rec, i);
    if (err) issues.push(err);
    if (rec && typeof rec === 'object' && typeof rec.instanceId === 'string') {
      const priorSelection = seen.get(rec.instanceId);
      if (
        priorSelection !== undefined &&
        priorSelection !== (typeof rec.selectedPatchOrId === 'string' ? rec.selectedPatchOrId : '')
      ) {
        issues.push(
          `records[${i}]: duplicate instanceId "${rec.instanceId}" with divergent selection`,
        );
      } else if (priorSelection === undefined) {
        seen.set(
          rec.instanceId,
          typeof rec.selectedPatchOrId === 'string' ? rec.selectedPatchOrId : '',
        );
      }
    }
  }
  if (issues.length > 0) {
    const hasDup = issues.some((s) => s.includes('duplicate instanceId'));
    return finalize(
      buildEnvelope({
        scorer,
        toolVersion,
        inputDigest: sha256Hex(canonicalJson({ recordCount: records.length })),
        evidence: [],
        eligibility: hasDup ? 'conflicting_evidence' : 'malformed_evidence',
        rationale: 'One or more records failed schema validation.',
        diagnostics: issues,
      }),
    );
  }
  if (signal?.aborted) return abortedResult(scorer, toolVersion);
  const canonical = canonicalJson(records);
  const inputDigest = sha256Hex(canonical);
  const result = scorePatchSelection(records, {
    measurementPolicy: params.measurementPolicy,
    ...(typeof params.allowPatchFallback === 'boolean'
      ? { allowPatchFallback: params.allowPatchFallback }
      : {}),
  });
  const metrics: Record<string, number> = {
    patch_selection_accuracy: result.patch_selection_accuracy,
    scoreable_coverage: result.wavemill_router_diagnostics.scoreable_coverage,
    total_records: result.wavemill_router_diagnostics.total_records,
    scoreable_records: result.wavemill_router_diagnostics.scoreable_records,
    invalid_route_records: result.wavemill_router_diagnostics.invalid_route_records,
    correct_selection_count:
      (result.wavemill_router_diagnostics as unknown as { correct_selection_count?: number })
        .correct_selection_count ?? 0,
  };
  return finalize(
    buildEnvelope({
      scorer,
      toolVersion,
      inputDigest,
      evidence: [
        {
          ref: `inline:records[${records.length}]`,
          digest: sha256Hex(canonical),
          bytes: Buffer.byteLength(canonical, 'utf8'),
        },
      ],
      eligibility: 'eligible',
      metrics,
      rationale: `Scored ${result.wavemill_router_diagnostics.scoreable_records}/${result.wavemill_router_diagnostics.total_records} records; accuracy=${result.patch_selection_accuracy}. Advisory only.`,
      diagnostics: [
        `measurement_policy: ${result.wavemill_router_scoring.measurement_policy}`,
        `scorer_id: ${result.wavemill_router_scoring.scorer_id}`,
      ],
    }),
    { sourceKind: 'wavemill_artifact' },
  );
}

interface ScoreSuccessRateParams {
  measurementPolicy: WavemillRouterMeasurementPolicy;
  records: WavemillRouterScoreRecord[];
}

async function executeScoreSuccessRate(
  _worktreePath: string,
  params: ScoreSuccessRateParams,
  signal: AbortSignal | undefined,
): Promise<WavemillToolResult<ReviewScoringDetails>> {
  const scorer = WAVEMILL_SUCCESS_RATE_UNDER_BUDGET_SCORER_ID;
  const toolVersion = TOOL_VERSIONS.score_success_rate_under_budget;
  const validationError = validateMeasurementPolicy(params?.measurementPolicy);
  if (validationError) {
    return finalize(malformedEnvelope(scorer, toolVersion, params, [validationError]));
  }
  const records = params?.records;
  if (!Array.isArray(records)) {
    return finalize(
      malformedEnvelope(scorer, toolVersion, params, [
        'records: must be an array',
      ]),
    );
  }
  if (records.length > RECORD_MAX_ITEMS) {
    return finalize(
      buildEnvelope({
        scorer,
        toolVersion,
        inputDigest: sha256Hex(canonicalJson({ count: records.length })),
        evidence: [],
        eligibility: 'oversized_evidence',
        rationale: `records exceeds ${RECORD_MAX_ITEMS}-item limit`,
        diagnostics: [`records: ${records.length} items exceeds ${RECORD_MAX_ITEMS}-item cap`],
      }),
    );
  }
  const issues: string[] = [];
  const seen = new Map<string, string>();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const err = validateRouterScoreRecord(rec, i);
    if (err) issues.push(err);
    const key = rec && typeof rec === 'object' ? rec.joinKey ?? rec.issueId : undefined;
    if (typeof key === 'string' && key.length > 0) {
      const canonicalRow = canonicalJson(rec);
      const prior = seen.get(key);
      if (prior !== undefined && prior !== canonicalRow) {
        issues.push(`records[${i}]: duplicate key "${key}" with divergent fields`);
      } else if (prior === undefined) {
        seen.set(key, canonicalRow);
      }
    }
  }
  if (issues.length > 0) {
    const hasDup = issues.some((s) => s.includes('duplicate key'));
    return finalize(
      buildEnvelope({
        scorer,
        toolVersion,
        inputDigest: sha256Hex(canonicalJson({ recordCount: records.length })),
        evidence: [],
        eligibility: hasDup ? 'conflicting_evidence' : 'malformed_evidence',
        rationale: 'One or more records failed schema validation.',
        diagnostics: issues,
      }),
    );
  }
  if (signal?.aborted) return abortedResult(scorer, toolVersion);
  const canonical = canonicalJson(records);
  const inputDigest = sha256Hex(canonical);
  const result = scoreWavemillSuccessRateUnderBudget(records, {
    measurementPolicy: params.measurementPolicy,
  });
  const metrics: Record<string, number> = {
    workflow_success_rate_under_budget: result.workflow_success_rate_under_budget,
    scoreable_coverage: result.wavemill_router_diagnostics.scoreable_coverage,
    total_records: result.wavemill_router_diagnostics.total_records,
    scoreable_records: result.wavemill_router_diagnostics.scoreable_records,
    invalid_route_records: result.wavemill_router_diagnostics.invalid_route_records,
    budget_compliance_rate: result.wavemill_router_diagnostics.budget_compliance_rate,
    completion_success_rate: result.wavemill_router_diagnostics.completion_success_rate,
  };
  return finalize(
    buildEnvelope({
      scorer,
      toolVersion,
      inputDigest,
      evidence: [
        {
          ref: `inline:records[${records.length}]`,
          digest: sha256Hex(canonical),
          bytes: Buffer.byteLength(canonical, 'utf8'),
        },
      ],
      eligibility: 'eligible',
      metrics,
      rationale: `Scored ${result.wavemill_router_diagnostics.scoreable_records}/${result.wavemill_router_diagnostics.total_records} records; success_rate=${result.workflow_success_rate_under_budget}. Advisory only.`,
      diagnostics: [
        `measurement_policy: ${result.wavemill_router_scoring.measurement_policy}`,
        `scorer_id: ${result.wavemill_router_scoring.scorer_id}`,
      ],
    }),
    { sourceKind: 'wavemill_artifact' },
  );
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateMeasurementPolicy(value: unknown): string | null {
  if (typeof value !== 'string') return 'measurementPolicy: required string';
  if (!MEASUREMENT_POLICIES.includes(value as WavemillRouterMeasurementPolicy)) {
    return `measurementPolicy: must be one of ${MEASUREMENT_POLICIES.join(', ')}`;
  }
  return null;
}

function validatePatchSelectionRecord(
  rec: PatchSelectionScoreRecord | undefined,
  idx: number,
): string | null {
  if (!rec || typeof rec !== 'object') return `records[${idx}]: must be an object`;
  if (typeof rec.instanceId !== 'string' || rec.instanceId.length === 0) {
    return `records[${idx}].instanceId: required string`;
  }
  if (typeof rec.selectedPatchOrId !== 'string') {
    return `records[${idx}].selectedPatchOrId: required string`;
  }
  const instance = rec.instance as ReplayPatchSelectionInstance | undefined;
  if (!instance || typeof instance !== 'object') {
    return `records[${idx}].instance: required object`;
  }
  if (typeof instance.id !== 'string' || !Array.isArray(instance.candidates)) {
    return `records[${idx}].instance: missing id or candidates`;
  }
  if (typeof instance.knownGoodCandidateId !== 'string') {
    return `records[${idx}].instance.knownGoodCandidateId: required string`;
  }
  return null;
}

function validateRouterScoreRecord(
  rec: WavemillRouterScoreRecord | undefined,
  idx: number,
): string | null {
  if (!rec || typeof rec !== 'object') return `records[${idx}]: must be an object`;
  if (typeof rec.route_valid !== 'boolean') return `records[${idx}].route_valid: required boolean`;
  if (
    rec.actual_cost_usd !== undefined &&
    (typeof rec.actual_cost_usd !== 'number' || !Number.isFinite(rec.actual_cost_usd))
  ) {
    return `records[${idx}].actual_cost_usd: must be a finite number when present`;
  }
  if (
    rec.max_cost_usd !== undefined &&
    (typeof rec.max_cost_usd !== 'number' || !Number.isFinite(rec.max_cost_usd))
  ) {
    return `records[${idx}].max_cost_usd: must be a finite number when present`;
  }
  if (rec.completed_successfully !== undefined && typeof rec.completed_successfully !== 'boolean') {
    return `records[${idx}].completed_successfully: must be a boolean when present`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function problemEnvelope(
  scorer: string,
  toolVersion: string,
  problems: EvidenceProblem[],
): ReturnType<typeof buildEnvelope> {
  const worst = problems[0]!;
  const state: EligibilityState = pickWorst(problems.map((p) => p.state));
  const diagnostics = problems.map(
    (p) => `${p.ref}: ${p.state}: ${p.diagnostic}`,
  );
  const inputDigest = sha256Hex(
    canonicalJson(problems.map((p) => ({ ref: p.ref, state: p.state }))),
  );
  return buildEnvelope({
    scorer,
    toolVersion,
    inputDigest,
    evidence: [],
    eligibility: state,
    rationale: `Non-score state ${state}: ${worst.diagnostic}`,
    diagnostics,
  });
}

function malformedEnvelope(
  scorer: string,
  toolVersion: string,
  params: unknown,
  issues: string[],
): ReturnType<typeof buildEnvelope> {
  return buildEnvelope({
    scorer,
    toolVersion,
    inputDigest: sha256Hex(canonicalJson({ params })),
    evidence: [],
    eligibility: 'malformed_evidence',
    rationale: 'Input parameters failed schema validation.',
    diagnostics: issues,
  });
}

function pickWorst(states: EligibilityState[]): EligibilityState {
  // Deterministic precedence: conflicting > oversized > malformed > missing.
  const order: EligibilityState[] = [
    'conflicting_evidence',
    'oversized_evidence',
    'malformed_evidence',
    'missing_evidence',
    'eligible',
  ];
  for (const candidate of order) {
    if (states.includes(candidate)) return candidate;
  }
  return 'missing_evidence';
}

function finalize(
  built: ReturnType<typeof buildEnvelope>,
  trust: { sourceKind: 'diff' | 'wavemill_artifact' } = { sourceKind: 'wavemill_artifact' },
): WavemillToolResult<ReviewScoringDetails> {
  return {
    content: built.content,
    details: built.details,
    metadata: {
      trust: buildTrustMetadata({
        sourceKind: trust.sourceKind,
        content: built.content,
        // Details include only digests + template rationale — safe to pass.
        details: built.details,
      }),
    },
  };
}

function abortedResult(
  scorer: string,
  toolVersion: string,
): WavemillToolResult<ReviewScoringDetails> {
  return finalize(
    buildEnvelope({
      scorer,
      toolVersion,
      inputDigest: sha256Hex('aborted'),
      evidence: [],
      eligibility: 'missing_evidence',
      rationale: 'Execution aborted before evidence could be resolved.',
      diagnostics: ['abort: signal received'],
    }),
  );
}

// ---------------------------------------------------------------------------
// JSON Schema definitions
// ---------------------------------------------------------------------------

const SCORE_DIFF_DIFFICULTY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    evidence: {
      type: 'string',
      enum: ['workspace_diff'],
      description: 'Evidence reference (only workspace_diff is supported).',
    },
  },
} as const;

const SCORE_TASK_CONTEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    evidence: {
      type: 'array',
      items: { type: 'string', enum: ['task_packet', 'selected_task', 'workspace_diff'] },
      uniqueItems: true,
      maxItems: 3,
      description:
        'Evidence references to resolve (default: task_packet + selected_task).',
    },
  },
} as const;

const MEASUREMENT_POLICY_SCHEMA = {
  type: 'string',
  enum: [...MEASUREMENT_POLICIES],
  description: 'Measurement policy tag; recorded on the scorer output.',
} as const;

const SCORE_PATCH_SELECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['measurementPolicy', 'records'],
  properties: {
    measurementPolicy: MEASUREMENT_POLICY_SCHEMA,
    allowPatchFallback: { type: 'boolean' },
    records: {
      type: 'array',
      maxItems: RECORD_MAX_ITEMS,
      items: { type: 'object' },
    },
  },
} as const;

const SCORE_SUCCESS_RATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['measurementPolicy', 'records'],
  properties: {
    measurementPolicy: MEASUREMENT_POLICY_SCHEMA,
    records: {
      type: 'array',
      maxItems: RECORD_MAX_ITEMS,
      items: { type: 'object' },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

function baseMetadata(name: string, description: string, logicalName: string): ToolMetadata {
  return {
    name,
    description,
    class: 'read-only',
    allowedPhases: ['review'],
    executionMode: 'parallel',
    family: 'eval',
    logicalId: `eval.${logicalName}`,
    exposure: 'opt-in',
    certificationRequirement: 'read-only',
    outputCapPolicy: { strategy: 'truncate', maxBytes: OUTPUT_MAX_BYTES },
    policy: {
      pathMode: 'read-only',
      network: 'deny',
      mutatesGit: false,
      mutatesExternalSystems: false,
      requiresApproval: false,
      timeoutMs: 10_000,
      maxOutputBytes: OUTPUT_MAX_BYTES,
      maxOutputTokens: 8_192,
      redactionProfile: 'default',
    },
  };
}

/**
 * Create the four bounded review-scoring tool descriptors bound to a specific
 * worktree. The caller should only include these in the review-phase registry
 * when `nativeAgent.advanced.eval` is enabled — the exposure engine and
 * per-turn menu resolver enforce the same gate as defense in depth.
 */
export function createReviewScoringTools(worktreePath: string): ToolDescriptor[] {
  const absWorktree = path.resolve(worktreePath);
  return [
    {
      metadata: baseMetadata(
        'score_diff_difficulty',
        'Advisory scorer: compute diff difficulty (LOC touched, files touched, difficulty band, stratum, tech stack) from the workspace diff. Read-only; output is advisory and never sets the review verdict.',
        'score_diff_difficulty',
      ),
      parameters: SCORE_DIFF_DIFFICULTY_SCHEMA,
      async execute(_toolCallId, params, signal) {
        return executeScoreDiffDifficulty(absWorktree, params as ScoreDiffDifficultyParams, signal);
      },
    } as ToolDescriptor<ScoreDiffDifficultyParams, ReviewScoringDetails>,

    {
      metadata: baseMetadata(
        'score_task_context',
        'Advisory scorer: classify the task packet and selected task into a TaskContext (type, change kind, complexity band). Read-only; output is advisory and never sets the review verdict.',
        'score_task_context',
      ),
      parameters: SCORE_TASK_CONTEXT_SCHEMA,
      async execute(_toolCallId, params, signal) {
        return executeScoreTaskContext(absWorktree, params as ScoreTaskContextParams, signal);
      },
    } as ToolDescriptor<ScoreTaskContextParams, ReviewScoringDetails>,

    {
      metadata: baseMetadata(
        'score_patch_selection',
        'Advisory scorer: score inline patch-selection records against the Hokusai replay-corpus ground truth. Read-only; requires the agent to supply already-known records — never fetches remote data.',
        'score_patch_selection',
      ),
      parameters: SCORE_PATCH_SELECTION_SCHEMA,
      async execute(_toolCallId, params, signal) {
        return executeScorePatchSelection(absWorktree, params as ScorePatchSelectionParams, signal);
      },
    } as ToolDescriptor<ScorePatchSelectionParams, ReviewScoringDetails>,

    {
      metadata: baseMetadata(
        'score_success_rate_under_budget',
        'Advisory scorer: score inline wavemill router records for success-rate-under-budget. Read-only; requires the agent to supply the records — never mutates routing or reward state.',
        'score_success_rate_under_budget',
      ),
      parameters: SCORE_SUCCESS_RATE_SCHEMA,
      async execute(_toolCallId, params, signal) {
        return executeScoreSuccessRate(absWorktree, params as ScoreSuccessRateParams, signal);
      },
    } as ToolDescriptor<ScoreSuccessRateParams, ReviewScoringDetails>,
  ];
}
