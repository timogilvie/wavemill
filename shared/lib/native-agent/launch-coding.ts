import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentContext, LoopResult, WavemillLoopConfig } from './loop.ts';
import { runWavemillLoop } from './loop.ts';
import { CODING_MAX_OUTPUT_TOKENS } from './output-limits.ts';
import type { AgentMessage, AgentTurn, Message } from './messages.ts';
import {
  buildNativeProviderResolutionFailureMessage,
  getNativeProviderApiKey,
  resolveNativeAgentProviders,
  type ReadyNativeProviderEntry,
} from './providers.ts';
import { TranscriptWriter } from './transcript.ts';
import { SessionStreamWriter, resolveSessionEventStreamPath } from './session-stream.ts';
import type { SessionStreamConfig } from './loop.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from './tools/read-only.ts';
import {
  createGitCommitTools,
  createGitTools,
  gitAfterToolCall,
  gitMutationAfterToolCall,
  gitMutationToolPolicyConfig,
  gitToolPolicyConfig,
} from './tools/git.ts';
import {
  commandToolsAfterToolCall,
  createCommandTools,
} from './tools/command-tools.ts';
import {
  codingMutationAfterToolCall,
  codingMutationPolicyConfig,
  createCodingMutationTools,
} from './tools/mutation-tools.ts';
import {
  createIntendedFileTracker,
  intendedFilesAfterToolCall,
} from './tools/intended-files.ts';
import { createToolRegistry } from './tools/registry.ts';
import type { AgentTool } from './tools/pi-adapter.ts';
import type { ToolDescriptor, ToolMetadata } from './tools/types.ts';
import {
  createLaunchMenuProvider,
  formatMenuDenials,
} from './tools/menu-resolver.ts';
import { inferCertificationSnapshotForPhase } from './tools/certification-snapshot.ts';
import { loadWavemillConfig } from '../config.ts';
import { validateCodingArtifacts, type CodingArtifacts } from './coding-artifacts.ts';
import {
  buildCompletionArtifactRetryGuidance,
  normalizeBlockedCompletionContent,
  normalizeCodingCompleteContent,
  noVerificationEvidenceError,
  type CompletionArtifact,
  type RetryGuidanceError,
} from './completion-normalizer.ts';
import { registerAndRecordNativeProvenance } from './prompts.ts';
import { buildNativePatchGuidance } from './patch-contract.ts';
import {
  CODING_FAILURE_HANDOFF_SCHEMA_VERSION,
  getCodingFailureHandoffPath,
  writeCodingFailureHandoff,
  type CodingFailureToolError,
  type CodingFailureValidationError,
} from './coding-failure-handoff.ts';
import { classifyProviderError } from './provider-error-classifier.ts';
import {
  assertOpenRouterBalanceSufficient,
  capOpenRouterMaxTokensForBalance,
} from './openrouter-credits-guard.ts';
import { updateStageResult } from '../stage-result.ts';
import { getNativeContextManagementConfig } from '../config.ts';
import { equivalentOpenRouterModelIds, type NormalizedPricing } from '../openrouter-catalog.ts';
import { logPromptUsage } from '../prompt-registry.ts';
import type { ResourceRef } from '../resource-registry.ts';
import {
  getBlockedCompletionPath,
} from '../blocked-completion.ts';

const CODING_PROMPT_PATH = new URL('../../../tools/prompts/coding-phase.md', import.meta.url);
const CODING_PROMPT_FILE = fileURLToPath(CODING_PROMPT_PATH);
const MAX_ARTIFACT_RETRIES = 2;

type HookState = 'working' | 'idle' | 'error';

interface MutationFailureTracker {
  count: number;
  last: CodingFailureToolError | null;
}

interface ToolCallFailureContext {
  toolCall: { name: string };
  result: { details: unknown; content?: Array<{ type: string; text: string }> };
}

type CompletionInspectionResult =
  | { kind: 'complete' }
  | { kind: 'blocked' }
  | {
    kind: 'invalid';
    artifact: CompletionArtifact;
    path: string;
    errors: RetryGuidanceError[];
  };

export interface LaunchNativeCodingOptions {
  session: string;
  issue: string;
  slug: string;
  wtDir: string;
  repoDir: string;
  codeDepth?: string;
  operatingMode?: string;
  branch?: string;
  baseBranch?: string;
  title?: string;
  issueContext?: string;
  resolvedModel?: string;
  featureDir?: string;
  taskPacketPath?: string;
  planPath?: string;
  hookPath?: string;
  providerEntries?: readonly ReadyNativeProviderEntry[];
  loopModelOverride?: WavemillLoopConfig['model'];
  registryMetadataOverride?: readonly ToolMetadata[];
  extraDescriptors?: readonly ToolDescriptor[];
  signal?: AbortSignal;
}

export interface LaunchNativeCodingResult {
  featureDir: string;
  hookPath: string;
  provider: string;
  model: string;
  stopReason: string;
  transcriptPath: string;
  completion: 'complete' | 'blocked';
}

function writeHookStatus(
  hookPath: string,
  state: HookState,
  event: string,
  detail: string,
  agent: string,
): void {
  const tmpPath = `${hookPath}.tmp.${process.pid}.${Date.now()}`;
  let base: Record<string, unknown> = {};
  if (existsSync(hookPath)) {
    try {
      base = JSON.parse(readFileSync(hookPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify({
    ...base,
    state,
    event,
    agent,
    timestamp: Math.floor(Date.now() / 1000),
    ...(detail !== '' ? { detail } : {}),
  })}\n`, 'utf-8');
  renameSync(tmpPath, hookPath);
}

function writeTextStatus(session: string, issue: string, text: string): void {
  if (!session || !issue) return;
  try {
    writeFileSync(`/tmp/${session}-${issue}-status.txt`, `${text}\n`, 'utf-8');
  } catch {
    // Best-effort dashboard text; hook JSON remains authoritative.
  }
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
  renameSync(tmpPath, path);
}

function defaultHookPath(session: string, issue: string): string {
  return `/tmp/wavemill-${session}-${issue}.hook`;
}

function makeTranscriptPath(repoDir: string, session: string, issue: string): string {
  const safeIssue = issue.replace(/[^A-Za-z0-9._-]+/g, '-');
  const baseDir = process.env.WAVEMILL_RUN_DIR
    ? join(process.env.WAVEMILL_RUN_DIR, 'native-sessions')
    : join(repoDir, '.wavemill', 'runs', session, 'native-sessions');
  mkdirSync(baseDir, { recursive: true });
  return join(baseDir, `coding-${safeIssue}.jsonl`);
}

function canonicalNativeModelIds(modelId: string | undefined): Set<string> {
  const trimmed = modelId?.trim();
  return trimmed ? new Set(equivalentOpenRouterModelIds(trimmed)) : new Set();
}

function selectReadyProvider(
  providerEntries: readonly ReadyNativeProviderEntry[],
  resolvedModel: string | undefined,
): ReadyNativeProviderEntry | undefined {
  const requestedIds = canonicalNativeModelIds(resolvedModel);
  if (requestedIds.size === 0) {
    return providerEntries[0];
  }

  return providerEntries.find((entry) => {
    const entryIds = canonicalNativeModelIds(entry.modelId);
    if (entry.model.name) {
      for (const id of canonicalNativeModelIds(entry.model.name)) {
        entryIds.add(id);
      }
    }
    return [...requestedIds].some((id) => entryIds.has(id));
  });
}

function normalizedPricingFromModel(model: WavemillLoopConfig['model']): NormalizedPricing {
  const cost = (model as { cost?: { input?: unknown; output?: unknown } }).cost;
  const inputPerMTok = typeof cost?.input === 'number' && Number.isFinite(cost.input) && cost.input > 0
    ? cost.input
    : null;
  const outputPerMTok = typeof cost?.output === 'number' && Number.isFinite(cost.output) && cost.output > 0
    ? cost.output
    : null;
  return { inputPerMTok, outputPerMTok };
}

function formatReadyProviderList(providerEntries: readonly ReadyNativeProviderEntry[]): string {
  return providerEntries.length === 0
    ? 'none'
    : providerEntries.map((entry) => `${entry.providerName}:${entry.modelId}`).join(', ');
}

function loadCodingPrompt(repoDir: string): { content: string; promptRef: ResourceRef | null } {
  let content = [
    'You are a native coding agent.',
    'Use the provided tools to implement, verify, commit, and write coding completion artifacts.',
  ].join('\n');
  const promptPath = CODING_PROMPT_FILE;
  try {
    if (existsSync(promptPath)) {
      content = readFileSync(promptPath, 'utf-8');
    }
  } catch {
    // Fallback prompt above is sufficient for controlled tests and failure recovery.
  }
  return { content, promptRef: logPromptUsage(promptPath, content, { dir: repoDir }) };
}

function buildDepthGuidance(codeDepth: string): string {
  if (codeDepth === 'deep') {
    return '- Implement comprehensive error handling\n- Add extensive test coverage\n- Consider edge cases and performance';
  }
  if (codeDepth === 'light') {
    return '- Focus on the critical path\n- Add targeted verification';
  }
  return '- Implement core functionality with good error handling\n- Add reasonable test coverage';
}

function buildModeGuidance(operatingMode: string): string {
  if (operatingMode === 'survival') {
    return 'Keep scope minimal, commit after every 1-2 file changes, and prefer targeted verification.';
  }
  if (operatingMode === 'constrained') {
    return 'Keep changes tightly scoped, commit after each plan phase, and run focused checks between phases.';
  }
  return '';
}

export function renderCodingSystemPrompt(input: {
  template: string;
  codeDepth: string;
  operatingMode: string;
  featureDir: string;
  planPath: string;
  slug: string;
  blockedCompletionPath: string;
}): string {
  const rendered = input.template
    .replace(/\{\{CODE_DEPTH\}\}/g, input.codeDepth)
    .replace(/\{\{SLUG\}\}/g, input.slug)
    .replace(/\{\{FEATURE_DIR\}\}/g, input.featureDir)
    .replace(/\{\{PLAN_PATH\}\}/g, input.planPath)
    .replace(/\{\{DEPTH_GUIDANCE\}\}/g, buildDepthGuidance(input.codeDepth))
    .replace(/\{\{MODE_GUIDANCE\}\}/g, buildModeGuidance(input.operatingMode));

  return [
    rendered,
    '',
    '### Native Coding Tool Rules',
    '- Use apply_patch for source edits; do not use whole-file writes for source files.',
    '',
    '#### apply_patch NativePatch Contract',
    buildNativePatchGuidance(),
    '',
    '- Use write_artifact/create_marker only for Wavemill-owned artifacts under the feature directory.',
    '- Use run_tests/run_format for verification and formatting commands inside the worktree. Commands run without a shell: use one program per call, pass cwd instead of cd ... &&, and avoid pipes, redirects, &&/;, $VAR, and backticks; POSIX-style quoting is honored.',
    '- Use git_add/git_commit to commit intended changed files before completion.',
    `- Prefer .coding-complete when full verification passes; otherwise write ${input.blockedCompletionPath} only when implementation is complete, scoped checks passed, changes are committed, and remaining blockers are unrelated or environmental.`,
  ].join('\n');
}

function buildUserPrompt(options: {
  issue: string;
  slug: string;
  title?: string;
  branch?: string;
  baseBranch?: string;
  issueContext?: string;
  planPath: string;
  taskPacketPath: string;
  taskPacket?: string;
  planText?: string;
}): string {
  return [
    `Issue: ${options.issue}`,
    `Slug: ${options.slug}`,
    `Title: ${options.title || options.issue}`,
    `Branch: ${options.branch || ''}`,
    `Base branch: ${options.baseBranch || ''}`,
    '',
    options.issueContext ? `Issue Context:\n${options.issueContext.trim()}\n` : '',
    `Plan path: ${options.planPath}`,
    options.planText ? `Plan:\n${options.planText.trim()}\n` : '',
    `Task packet path: ${options.taskPacketPath}`,
    options.taskPacket ? `Task Packet:\n${options.taskPacket.trim()}\n` : '',
    'Implement the plan, verify, commit intended changes, then write the appropriate coding completion artifact.',
  ].filter(Boolean).join('\n');
}

function readOptional(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
  } catch {
    return undefined;
  }
}

function hasCompletionArtifact(featureDir: string): boolean {
  return existsSync(join(featureDir, '.coding-complete')) || existsSync(getBlockedCompletionPath(featureDir));
}

function archiveStaleCodingArtifacts(featureDir: string): string[] {
  const candidates = [
    '.coding-complete',
    '.coding-blocked-completion.json',
    '.blocked-completion-announced',
    '.coding-uncommitted-output-announced',
    '.coding-failure-handoff.json',
  ];
  const present = candidates.filter((name) => existsSync(join(featureDir, name)));
  if (present.length === 0) {
    return [];
  }

  const stamp = new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const archiveDir = join(featureDir, '.stale-artifacts', `coding-${stamp}`);
  mkdirSync(archiveDir, { recursive: true });

  const archived: string[] = [];
  for (const name of present) {
    renameSync(join(featureDir, name), join(archiveDir, name));
    archived.push(name);
  }
  return archived;
}

function isMutationToolName(toolName: string): boolean {
  return [
    'apply_patch',
    'write_artifact',
    'create_marker',
    'update_status',
    'run_tests',
    'run_format',
    'run_command',
    'git_add',
    'git_commit',
  ].includes(toolName);
}

function recordMutationFailure(
  tracker: MutationFailureTracker,
  context: ToolCallFailureContext,
  isError = false,
): void {
  const details = context.result.details;
  const hasStructuredFailure = details
    && typeof details === 'object'
    && 'ok' in details
    && (details as { ok?: unknown }).ok === false;
  if (!hasStructuredFailure && !isError) {
    return;
  }
  const raw = hasStructuredFailure ? details as Record<string, unknown> : {};
  const tool = typeof raw.tool === 'string' ? raw.tool : context.toolCall.name;
  const rawError = raw.error;
  const message = formatToolErrorMessage(raw, context.result.content);
  const error = formatToolErrorCode(rawError, message);
  tracker.count += 1;
  tracker.last = {
    tool,
    error,
    message,
    ...(typeof raw.retryHint === 'string' ? { retryHint: raw.retryHint } : {}),
    ...(Object.prototype.hasOwnProperty.call(raw, 'diagnostics') ? { diagnostics: raw.diagnostics } : {}),
  };
}

function formatToolErrorCode(rawError: unknown, message?: string): string {
  if (typeof rawError === 'string') {
    return rawError;
  }
  if (rawError && typeof rawError === 'object' && typeof (rawError as { code?: unknown }).code === 'string') {
    return (rawError as { code: string }).code;
  }
  const prefix = message?.match(/^([a-z][a-z0-9_]*):/i)?.[1];
  if (prefix) {
    return prefix;
  }
  return 'tool_error';
}

function formatToolErrorMessage(
  raw: Record<string, unknown>,
  content?: Array<{ type: string; text: string }>,
): string {
  if (typeof raw.message === 'string') {
    return raw.message;
  }
  const rawError = raw.error;
  if (rawError && typeof rawError === 'object' && typeof (rawError as { message?: unknown }).message === 'string') {
    return (rawError as { message: string }).message;
  }
  const text = content?.find((block) => block.type === 'text')?.text;
  if (text) {
    return text;
  }
  return 'Tool call failed.';
}

function buildNoCompletionRecoveryPrompt(tracker: MutationFailureTracker): string {
  const last = tracker.last;
  const lastError = last
    ? [
      `Last failed mutation tool: ${last.tool}`,
      `Error code: ${last.error}`,
      `Message: ${last.message}`,
      last.retryHint ? `Retry hint: ${last.retryHint}` : '',
      last.diagnostics ? `Diagnostics: ${JSON.stringify(last.diagnostics, null, 2)}` : '',
    ].filter(Boolean).join('\n')
    : 'No structured last mutation-tool error was recorded.';
  const incident = last
    ? 'The previous coding turn stopped normally without writing .coding-complete or .coding-blocked-completion.json after a mutation tool failure.'
    : 'The previous coding turn stopped normally without writing .coding-complete or .coding-blocked-completion.json. It may have produced no actionable tool calls or stopped before creating the required artifact.';

  return [
    incident,
    '',
    lastError,
    '',
    'Recover now: retry the needed edit with the documented NativePatch contract, then verify, commit, and write .coding-complete. If implementation is complete but verification is blocked by unrelated or environmental failures, write .coding-blocked-completion.json instead.',
    '',
    buildNativePatchGuidance(),
  ].join('\n');
}

function buildFailureHandoffInput(input: {
  stopReason: string;
  tracker: MutationFailureTracker;
  recoveryAttempted: boolean;
  invalidArtifact?: {
    validationErrors: CodingFailureValidationError[];
    quarantinedArtifacts: string[];
  };
}): Parameters<typeof writeCodingFailureHandoff>[1] {
  const invalidArtifact = input.invalidArtifact;
  return {
    stage: 'coding',
    reason: invalidArtifact ? 'invalid_completion_artifact' : 'no_completion_artifact',
    stopReason: input.stopReason,
    mutationFailures: input.tracker.count,
    lastToolError: input.tracker.last,
    recoveryAttempted: input.recoveryAttempted,
    suggestedAction: invalidArtifact
      ? 'Rewrite the completion artifact to match the seam contract; validation errors and quarantined artifacts are preserved on this handoff.'
      : input.tracker.last
        ? 'Retry native coding with the documented tool contract and the preserved last tool error.'
        : 'Review the transcript and rerun native coding; the model stopped without a completion artifact.',
    createdAt: new Date().toISOString(),
    schemaVersion: CODING_FAILURE_HANDOFF_SCHEMA_VERSION,
    ...(invalidArtifact
      ? {
        validationErrors: invalidArtifact.validationErrors,
        quarantinedArtifacts: invalidArtifact.quarantinedArtifacts,
      }
      : {}),
  };
}

function buildProviderErrorSuggestedAction(kind: string): string {
  switch (kind) {
    case 'provider-credit-exhausted':
      return 'Top up OpenRouter credits at https://openrouter.ai/credits, then rerun native coding.';
    case 'provider-config-error':
      return 'Fix native provider authentication/model configuration, then rerun native coding.';
    case 'context-window-exceeded':
      return 'Rerun with compressed context or a larger-context model.';
    case 'provider-transient-error':
    case 'provider-unknown-error':
      return 'Rerun native coding; the transcript and completed tool-call counts are preserved in this handoff.';
    default:
      return 'Inspect the provider error and rerun native coding when the upstream condition is resolved.';
  }
}

function throwProviderErrorWithHandoff(input: {
  featureDir: string;
  result: LoopResult;
  errorMessage: string;
  mutationFailureTracker: MutationFailureTracker;
  recoveryAttempted: boolean;
  transcriptPath: string;
}): never {
  const classified = input.result.providerError
    ?? {
      ...classifyProviderError(input.errorMessage),
      attempts: 0,
      errorMessage: input.errorMessage,
      turnsAtFailure: input.result.turnsCompleted,
    };
  const recoveryAttempted = input.recoveryAttempted || classified.attempts > 0;
  writeCodingFailureHandoff(input.featureDir, {
    stage: 'coding',
    reason: 'provider_error',
    stopReason: input.result.stopReason,
    mutationFailures: input.mutationFailureTracker.count,
    lastToolError: input.mutationFailureTracker.last,
    recoveryAttempted,
    suggestedAction: buildProviderErrorSuggestedAction(classified.kind),
    createdAt: new Date().toISOString(),
    schemaVersion: CODING_FAILURE_HANDOFF_SCHEMA_VERSION,
    providerError: {
      kind: classified.kind,
      errorMessage: input.errorMessage,
      turnsCompleted: classified.turnsAtFailure,
      toolCallsExecuted: input.result.toolCallsExecuted,
      attempts: classified.attempts,
      transcriptPath: input.transcriptPath,
    },
  });
  const handoffRelativePath = relative(process.cwd(), getCodingFailureHandoffPath(input.featureDir));
  throw new Error(`${classified.kind}: ${input.errorMessage}; structured handoff: ${handoffRelativePath}`);
}

function toHandoffValidationErrors(errors: readonly RetryGuidanceError[]): CodingFailureValidationError[] {
  return errors.map((error) => ({
    code: error.code,
    ...(error.path ?? error.field ? { field: error.path ?? error.field } : {}),
    message: error.message,
  }));
}

function findFinalAssistantErrorMessage(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if ((message as { role?: string }).role !== 'assistant') continue;
    const errorMessage = (message as AgentTurn).errorMessage?.trim();
    if (errorMessage) return errorMessage;
  }
  return '';
}

function loadCodingArtifacts(featureDir: string, trackerCommitCount: number): CodingArtifacts {
  const resultPath = join(featureDir, '.coding-result.json');
  const existing = readOptional(resultPath);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      const validation = validateCodingArtifacts(parsed);
      if (validation.ok) {
        return validation.value;
      }
    } catch {
      // Fall through to minimal derived artifact.
    }
  }

  return {
    type: 'coding',
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commitCount: trackerCommitCount,
  };
}

function removeAgentCodingArtifactBeforeStageResult(featureDir: string): void {
  const resultPath = join(featureDir, '.coding-result.json');
  const existing = readOptional(resultPath);
  if (!existing) {
    return;
  }
  try {
    const validation = validateCodingArtifacts(JSON.parse(existing) as unknown);
    if (validation.ok) {
      rmSync(resultPath, { force: true });
    }
  } catch {
    // Malformed result files should be left in place so updateStageResult can
    // surface its existing diagnostics and replace them atomically.
  }
}

async function inspectCompletion(input: {
  featureDir: string;
  intendedModel: string;
  model: string;
  trackerCommitCount: number;
  stopReason: string;
  mutationFailureTracker: MutationFailureTracker;
  recoveryAttempted: boolean;
  coerceUnverifiedCompletionClaim: boolean;
}): Promise<CompletionInspectionResult> {
  const markerPath = join(input.featureDir, '.coding-complete');
  if (existsSync(markerPath)) {
    const raw = readFileSync(markerPath, 'utf-8');
    const normalized = normalizeCodingCompleteContent(raw);
    if (!normalized.ok) {
      return {
        kind: 'invalid',
        artifact: 'coding-complete',
        path: markerPath,
        errors: normalized.errors,
      };
    }
    if (normalized.changed) {
      atomicWriteText(markerPath, normalized.canonicalContent);
    }
    const artifacts = loadCodingArtifacts(input.featureDir, input.trackerCommitCount);
    removeAgentCodingArtifactBeforeStageResult(input.featureDir);
    await updateStageResult(input.featureDir, 'coding', {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      agent: 'native',
      model: input.model,
      intendedModel: input.intendedModel,
      executedModel: input.model,
      executionEvidence: {
        status: 'direct',
        source: 'native-runtime',
        recordedAt: new Date().toISOString(),
      },
      modelAttributionEligible: input.intendedModel === input.model,
      ...(input.intendedModel === input.model ? {} : { modelAttributionIneligibleReason: 'runtime_fallback' as const }),
      notes: [
        `Native coding completed with ${normalized.value.confidence} confidence`,
        ...normalized.warnings,
      ].join('\n'),
      artifacts,
      failureReason: null,
    });
    return { kind: 'complete' };
  }

  const blockedPath = getBlockedCompletionPath(input.featureDir);
  if (existsSync(blockedPath)) {
    const raw = readFileSync(blockedPath, 'utf-8');
    const normalized = normalizeBlockedCompletionContent(raw);
    if (!normalized.ok) {
      return {
        kind: 'invalid',
        artifact: 'blocked-completion',
        path: blockedPath,
        errors: normalized.errors,
      };
    }
    if (normalized.coercedUnverifiedClaim && !input.coerceUnverifiedCompletionClaim) {
      return {
        kind: 'invalid',
        artifact: 'blocked-completion',
        path: blockedPath,
        errors: [noVerificationEvidenceError()],
      };
    }
    if (normalized.changed) {
      atomicWriteText(blockedPath, normalized.canonicalContent);
    }
    const artifacts = loadCodingArtifacts(input.featureDir, input.trackerCommitCount);
    removeAgentCodingArtifactBeforeStageResult(input.featureDir);
    await updateStageResult(input.featureDir, 'coding', {
      status: 'running',
      finishedAt: null,
      agent: 'native',
      model: input.model,
      intendedModel: input.intendedModel,
      executedModel: input.model,
      executionEvidence: {
        status: 'direct',
        source: 'native-runtime',
        recordedAt: new Date().toISOString(),
      },
      modelAttributionEligible: false,
      modelAttributionIneligibleReason: 'stage_not_completed',
      notes: [
        'Native coding produced a blocked-completion handoff for monitor recovery',
        ...normalized.warnings,
      ].join('\n'),
      artifacts,
      failureReason: null,
    });
    return { kind: 'blocked' };
  }

  writeCodingFailureHandoff(input.featureDir, buildFailureHandoffInput({
    stopReason: input.stopReason,
    tracker: input.mutationFailureTracker,
    recoveryAttempted: input.recoveryAttempted,
  }));
  const handoffRelativePath = relative(process.cwd(), getCodingFailureHandoffPath(input.featureDir));
  const last = input.mutationFailureTracker.last;
  const lastErrorText = last ? `; last tool error (${last.tool}/${last.error}): ${last.message}` : '';
  throw new Error(
    'Native coding completed without .coding-complete or .coding-blocked-completion.json'
    + `${lastErrorText}; structured handoff: ${handoffRelativePath}`,
  );
}

function preserveInvalidArtifact(path: string, attempt: number): string {
  const preservedPath = `${path}.invalid-${attempt}`;
  rmSync(preservedPath, { force: true });
  renameSync(path, preservedPath);
  return preservedPath;
}

function formatInvalidArtifactError(
  inspection: Extract<CompletionInspectionResult, { kind: 'invalid' }>,
  attempts: number,
): string {
  const errors = inspection.errors.map((error) => `${error.code} at ${error.path}: ${error.message}`).join('; ');
  const filename = inspection.artifact === 'coding-complete'
    ? '.coding-complete'
    : '.coding-blocked-completion.json';
  return `Native coding wrote invalid ${filename} after ${attempts} artifact retry attempt(s): ${errors}`;
}

export async function launchNativeCoding(options: LaunchNativeCodingOptions): Promise<LaunchNativeCodingResult> {
  const featureDir = options.featureDir ?? join(options.wtDir, 'features', options.slug);
  const taskPacketPath = options.taskPacketPath ?? join(featureDir, 'task-packet.md');
  const planPath = options.planPath ?? join(featureDir, 'plan.md');
  const hookPath = options.hookPath ?? defaultHookPath(options.session, options.issue);
  const codeDepth = options.codeDepth ?? 'medium';
  const operatingMode = options.operatingMode ?? 'normal';

  mkdirSync(featureDir, { recursive: true });
  const archivedStaleArtifacts = archiveStaleCodingArtifacts(featureDir);
  writeHookStatus(hookPath, 'working', 'launch_native_coding', options.loopModelOverride?.name ?? 'native', 'native');
  writeTextStatus(options.session, options.issue, 'native coding starting');
  if (archivedStaleArtifacts.length > 0) {
    writeTextStatus(
      options.session,
      options.issue,
      `archived stale coding artifacts: ${archivedStaleArtifacts.join(', ')}`,
    );
  }

  try {
    const tracker = createIntendedFileTracker();
    const descriptors = [
      ...createReadOnlyTools(options.wtDir),
      ...createGitTools(options.wtDir),
      ...createCommandTools(options.wtDir),
      ...createCodingMutationTools(options.wtDir, { phase: 'coding' }),
      ...createGitCommitTools(options.wtDir, { tracker }),
      ...(options.extraDescriptors ?? []),
    ];
    const registry = createToolRegistry(descriptors);
    const registryMetadata = options.registryMetadataOverride ?? registry.list();

    const providerEntries = options.providerEntries
      ?? resolveNativeAgentProviders(options.repoDir, { phase: 'coding' });
    const readyProviders = providerEntries.filter(
      (entry): entry is ReadyNativeProviderEntry => entry.status === 'ready',
    );
    const readyProvider = selectReadyProvider(readyProviders, options.resolvedModel);

    if (options.resolvedModel?.trim() && readyProviders.length > 0 && !readyProvider && !options.loopModelOverride) {
      throw new Error(
        `Native coding requested model "${options.resolvedModel.trim()}", but no ready native provider matched it. `
        + `Ready providers: ${formatReadyProviderList(readyProviders)}. `
        + 'Run wavemill native-agent models report --json to inspect current artifact eligibility.',
      );
    }
    if (!readyProvider && !options.loopModelOverride) {
      throw new Error(buildNativeProviderResolutionFailureMessage('coding', providerEntries, 'patch'));
    }

    const apiKey = readyProvider ? getNativeProviderApiKey(readyProvider) : undefined;
    const model = options.loopModelOverride ?? {
      ...readyProvider!.model,
      headers: {
        ...(readyProvider!.model.headers ?? {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    };
    const modelName = model.name ?? model.id;
    const requestedModelName = options.resolvedModel?.trim() || modelName;
    const transcriptPath = makeTranscriptPath(options.repoDir, options.session, options.issue);
    const transcriptWriter = new TranscriptWriter({
      sessionId: `${options.session}-coding-${options.issue}`,
      model: modelName,
      api: model.api,
      provider: model.provider,
      worktreePath: options.wtDir,
      gitBranch: options.branch,
      path: transcriptPath,
    });

    // Construct session stream configuration and create persistent writer
    const codingNativeSessionId = `${options.session}-coding-${options.issue}`;
    const eventStreamPath = resolveSessionEventStreamPath(codingNativeSessionId, options.repoDir);

    // Create a persistent session stream writer for the entire launch lifecycle
    let persistentSessionStreamWriter: SessionStreamWriter | undefined;
    try {
      persistentSessionStreamWriter = new SessionStreamWriter({
        sessionId: codingNativeSessionId,
        traceId: options.session,
        phase: 'coding',
        path: eventStreamPath,
      }, options.repoDir);
      persistentSessionStreamWriter.writeSessionStarted({
        initialConfigDigest: `model:${model.provider}:${modelName}`,
      });
    } catch (error) {
      console.warn(`Failed to create persistent session stream writer: ${(error as Error).message}`);
      persistentSessionStreamWriter = undefined;
    }

    const sessionStreamConfig: SessionStreamConfig = {
      sessionId: codingNativeSessionId,
      traceId: options.session,
      phase: 'coding',
      eventStreamPath,
      repoDir: options.repoDir,
      initialConfigDigest: `model:${model.provider}:${modelName}`,
      externalWriterManagesSessionBoundaries: true, // Launch level manages session boundaries
      writerInstance: persistentSessionStreamWriter, // Reuse writer to maintain seq counter
    };

    const { content: promptTemplate, promptRef } = loadCodingPrompt(options.repoDir);
    registerAndRecordNativeProvenance({
      sessionId: options.session,
      phase: 'coding',
      provider: model.provider,
      model: modelName,
      api: model.api,
      tools: registryMetadata.map((meta) => ({ name: meta.name, class: meta.class })),
      promptRef,
      repoDir: options.repoDir,
    });

    await updateStageResult(featureDir, 'coding', {
      status: 'running',
      finishedAt: null,
      agent: 'native',
      model: modelName,
      intendedModel: requestedModelName,
      executedModel: modelName,
      executionEvidence: {
        status: 'direct',
        source: 'native-runtime',
        recordedAt: new Date().toISOString(),
      },
      modelAttributionEligible: false,
      modelAttributionIneligibleReason: 'stage_not_completed',
      notes: 'Native coding running',
      failureReason: null,
    });

    const menuLaunchProvider = createLaunchMenuProvider({
      phase: 'coding',
      config: loadWavemillConfig(options.repoDir),
      certification: inferCertificationSnapshotForPhase({
        phase: 'coding',
        readyProviderPresent: Boolean(readyProvider),
        loopModelOverridePresent: Boolean(options.loopModelOverride),
      }),
      descriptors,
    });
    if (menuLaunchProvider.initialMenu.denials.length > 0) {
      const formatted = formatMenuDenials(menuLaunchProvider.initialMenu.denials);
      if (formatted) {
        console.warn(`[native-coding] menu denials:\n${formatted}`);
      }
    }
    const context: AgentContext = {
      systemPrompt: renderCodingSystemPrompt({
        template: promptTemplate,
        codeDepth,
        operatingMode,
        featureDir,
        planPath,
        slug: options.slug,
        blockedCompletionPath: relative(options.wtDir, getBlockedCompletionPath(featureDir)),
      }),
      messages: [{
        role: 'user',
        content: buildUserPrompt({
          issue: options.issue,
          slug: options.slug,
          title: options.title,
          branch: options.branch,
          baseBranch: options.baseBranch,
          issueContext: options.issueContext,
          planPath,
          taskPacketPath,
          planText: readOptional(planPath),
          taskPacket: readOptional(taskPacketPath),
        }),
        timestamp: 0,
      }],
      tools: menuLaunchProvider.providerToolsForContext as AgentTool<unknown, unknown>[],
    };

    const mutationFailureTracker: MutationFailureTracker = { count: 0, last: null };

    const pricing = normalizedPricingFromModel(model);
    const effectiveMaxTokens = model.provider === 'openrouter' && !options.loopModelOverride
      ? capOpenRouterMaxTokensForBalance({
        requestedMaxTokens: CODING_MAX_OUTPUT_TOKENS,
        pricing,
        repoDir: options.repoDir,
      }) ?? CODING_MAX_OUTPUT_TOKENS
      : CODING_MAX_OUTPUT_TOKENS;
    if (model.provider === 'openrouter' && !options.loopModelOverride) {
      assertOpenRouterBalanceSufficient({
        repoDir: options.repoDir,
        model: modelName,
        pricing,
        reservedOutputTokens: effectiveMaxTokens,
      });
    }

    const runCodingLoop = () => runWavemillLoop({
      model,
      context,
      maxTokens: effectiveMaxTokens,
      contextManagement: getNativeContextManagementConfig(options.repoDir),
      convertToLlm: (messages) => messages as unknown as Message[],
      signal: options.signal,
      promptSizeLog: options.repoDir ? {
        repoDir: options.repoDir,
        stage: 'coding',
        session: options.session,
        issue: options.issue,
      } : undefined,
      sessionStreamConfig,
      menuProvider: menuLaunchProvider.menuProvider,
      afterToolCall: async (toolContext, signal) => {
        await intendedFilesAfterToolCall(toolContext, tracker);

        const commandResult = await commandToolsAfterToolCall(toolContext);
        if (commandResult?.isError) {
          recordMutationFailure(mutationFailureTracker, toolContext);
          return commandResult;
        }

        const gitResult = await gitAfterToolCall(toolContext);
        if (gitResult?.isError) return gitResult;

        const gitMutationResult = await gitMutationAfterToolCall(toolContext);
        if (gitMutationResult?.isError) {
          recordMutationFailure(mutationFailureTracker, toolContext);
          return gitMutationResult;
        }

        const codingMutationResult = await codingMutationAfterToolCall(toolContext);
        if (codingMutationResult?.isError) {
          recordMutationFailure(mutationFailureTracker, toolContext);
        }
        return codingMutationResult;
      },
      toolPolicy: {
        phase: 'coding',
        worktreePath: options.wtDir,
        registry: registryMetadata,
        config: {
          pathFieldsByTool: {
            ...READ_ONLY_PATH_FIELDS,
            ...gitToolPolicyConfig.pathFieldsByTool,
            ...gitMutationToolPolicyConfig.pathFieldsByTool,
            ...codingMutationPolicyConfig.pathFieldsByTool,
          },
        },
      },
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.isError) {
          const details = (event.result as { details?: unknown } | undefined)?.details;
          const alreadyRecordedByAfterToolCall = Boolean(
            details
            && typeof details === 'object'
            && 'ok' in details
            && (details as { ok?: unknown }).ok === false,
          );
          if (!alreadyRecordedByAfterToolCall && isMutationToolName(event.toolName)) {
            recordMutationFailure(mutationFailureTracker, {
              toolCall: { name: event.toolName },
              result: {
                details,
                content: (event.result as { content?: Array<{ type: string; text: string }> } | undefined)?.content,
              },
            }, true);
          }
        }
        transcriptWriter.handleEvent(event);
      },
    });

    writeHookStatus(hookPath, 'working', 'run_native_model', modelName, 'native');
    let result = await runCodingLoop();
    let recoveryAttempted = false;

    const providerError = findFinalAssistantErrorMessage(result.messages);
    if (providerError) {
      throwProviderErrorWithHandoff({
        featureDir,
        result,
        errorMessage: providerError,
        mutationFailureTracker,
        recoveryAttempted,
        transcriptPath,
      });
    }

    if (
      result.stopReason === 'stop'
      && !hasCompletionArtifact(featureDir)
    ) {
      recoveryAttempted = true;
      // Log session_resume and approval events for recovery attempt
      try {
        if (persistentSessionStreamWriter) {
          persistentSessionStreamWriter.writeApproval({
            stage: 'ready',
            notes: mutationFailureTracker.count > 0
              ? 'recovery: implicit approval to retry after mutation failure'
              : 'recovery: implicit approval to retry after no completion artifact',
          });
          persistentSessionStreamWriter.writeSessionResume({
            reason: mutationFailureTracker.count > 0
              ? 'recovery: no completion artifact after mutation failure'
              : 'recovery: no completion artifact after normal stop',
          });
        }
      } catch (error) {
        console.warn(`Failed to log recovery events: ${(error as Error).message}`);
      }

      writeHookStatus(hookPath, 'working', 'native_coding_recovery', 'no completion artifact after normal stop', 'native');
      context.messages = [
        ...result.messages,
        {
          role: 'user',
          content: buildNoCompletionRecoveryPrompt(mutationFailureTracker),
          timestamp: Date.now(),
        } as AgentMessage,
      ];
      result = await runCodingLoop();
      const recoveryProviderError = findFinalAssistantErrorMessage(result.messages);
      if (recoveryProviderError) {
        throwProviderErrorWithHandoff({
          featureDir,
          result,
          errorMessage: recoveryProviderError,
          mutationFailureTracker,
          recoveryAttempted,
          transcriptPath,
        });
      }
    }

    let inspection = await inspectCompletion({
      featureDir,
      intendedModel: requestedModelName,
      model: modelName,
      trackerCommitCount: tracker.commitCount,
      stopReason: result.stopReason,
      mutationFailureTracker,
      recoveryAttempted,
      coerceUnverifiedCompletionClaim: false,
    });
    let artifactRetryAttempt = 0;
    const quarantinedArtifacts: string[] = [];
    while (inspection.kind === 'invalid' && artifactRetryAttempt < MAX_ARTIFACT_RETRIES) {
      artifactRetryAttempt += 1;
      const preservedPath = preserveInvalidArtifact(inspection.path, artifactRetryAttempt);
      quarantinedArtifacts.push(relative(options.wtDir, preservedPath));

      // Log approval and retry events for artifact validation failure
      try {
        if (persistentSessionStreamWriter) {
          const approvalEvent = persistentSessionStreamWriter.writeApproval({
            stage: 'ready',
            notes: `artifact retry: implicit approval to retry after ${inspection.artifact} validation failed`,
          });
          persistentSessionStreamWriter.writeRetry({
            failedEventId: approvalEvent.eventId,
            reason: `${inspection.artifact} validation failed: ${inspection.errors.map((e) => `${e.code}:${e.message}`).join('; ')}`,
            retryCount: artifactRetryAttempt,
          });
        }
      } catch (error) {
        console.warn(`Failed to log artifact retry events: ${(error as Error).message}`);
      }

      writeHookStatus(
        hookPath,
        'working',
        'native_coding_artifact_retry',
        `${inspection.artifact} validation failed; preserved ${relative(options.wtDir, preservedPath)}`,
        'native',
      );
      context.messages = [
        ...result.messages,
        {
          role: 'user',
          content: buildCompletionArtifactRetryGuidance(inspection.artifact, inspection.errors),
          timestamp: Date.now(),
        } as AgentMessage,
      ];
      result = await runCodingLoop();
      const retryProviderError = findFinalAssistantErrorMessage(result.messages);
      if (retryProviderError) {
        throwProviderErrorWithHandoff({
          featureDir,
          result,
          errorMessage: retryProviderError,
          mutationFailureTracker,
          recoveryAttempted,
          transcriptPath,
        });
      }
      inspection = await inspectCompletion({
        featureDir,
        intendedModel: requestedModelName,
        model: modelName,
        trackerCommitCount: tracker.commitCount,
        stopReason: result.stopReason,
        mutationFailureTracker,
        recoveryAttempted,
        coerceUnverifiedCompletionClaim: false,
      });
    }

    if (inspection.kind === 'invalid') {
      if (
        inspection.artifact === 'blocked-completion'
        && inspection.errors.some((error) => (
          error.code === 'NO_VERIFICATION_EVIDENCE'
          || (error.code === 'INVALID_FIELD_TYPE' && 'field' in error && error.field === 'passingChecks')
        ))
      ) {
        inspection = await inspectCompletion({
          featureDir,
          intendedModel: requestedModelName,
          model: modelName,
          trackerCommitCount: tracker.commitCount,
          stopReason: result.stopReason,
          mutationFailureTracker,
          recoveryAttempted,
          coerceUnverifiedCompletionClaim: true,
        });
      }
      if (inspection.kind === 'invalid') {
        const preservedPath = preserveInvalidArtifact(inspection.path, artifactRetryAttempt + 1);
        quarantinedArtifacts.push(relative(options.wtDir, preservedPath));
        writeCodingFailureHandoff(featureDir, buildFailureHandoffInput({
          stopReason: result.stopReason,
          tracker: mutationFailureTracker,
          recoveryAttempted,
          invalidArtifact: {
            validationErrors: toHandoffValidationErrors(inspection.errors),
            quarantinedArtifacts,
          },
        }));
        const handoffRelativePath = relative(process.cwd(), getCodingFailureHandoffPath(featureDir));
        throw new Error(`${formatInvalidArtifactError(inspection, artifactRetryAttempt)}; structured handoff: ${handoffRelativePath}`);
      }
    }

    const completion = inspection.kind;
    writeHookStatus(hookPath, completion === 'complete' ? 'idle' : 'working', 'process_exit', completion, 'native');
    writeTextStatus(options.session, options.issue, completion === 'complete' ? 'coding complete' : 'coding blocked-completion');

    // Ensure the monitor has a compact result artifact even when the model only
    // used .coding-complete and skipped .coding-result.json.
    const resultPath = join(featureDir, '.coding-result.json');
    if (!existsSync(resultPath)) {
      const stageStatus = completion === 'complete' ? 'completed' : 'running';
      atomicWriteText(resultPath, JSON.stringify({
        stage: 'coding',
        status: stageStatus,
        agent: 'native',
        model: modelName,
        intendedModel: requestedModelName,
        executedModel: modelName,
        executionEvidence: {
          status: 'direct',
          source: 'native-runtime',
          recordedAt: new Date().toISOString(),
        },
        modelAttributionEligible: stageStatus === 'completed' && requestedModelName === modelName,
        ...(stageStatus !== 'completed'
          ? { modelAttributionIneligibleReason: 'stage_not_completed' }
          : requestedModelName === modelName
            ? {}
            : { modelAttributionIneligibleReason: 'runtime_fallback' }),
      }, null, 2));
    }

    // Write session_ended event
    try {
      if (persistentSessionStreamWriter) {
        persistentSessionStreamWriter.writeSessionEnded({
          stopReason: result.stopReason,
          totalTurns: result.turnsCompleted,
          totalToolCalls: result.toolCallsExecuted,
          totalTokens: result.totalInputTokens + result.totalOutputTokens,
        });
      }
    } catch (error) {
      console.warn(`Failed to write session_ended event: ${(error as Error).message}`);
    }

    return {
      featureDir,
      hookPath,
      provider: model.provider,
      model: modelName,
      stopReason: result.stopReason,
      transcriptPath,
      completion,
    };
  } catch (error) {
    const message = (error as Error).message;
    await updateStageResult(featureDir, 'coding', {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      agent: 'native',
      model: options.loopModelOverride?.name ?? options.resolvedModel ?? '',
      intendedModel: options.resolvedModel ?? options.loopModelOverride?.name ?? null,
      executedModel: null,
      executionEvidence: {
        status: 'contradicted',
        source: 'native-runtime',
        detail: message,
        recordedAt: new Date().toISOString(),
      },
      modelAttributionEligible: false,
      modelAttributionIneligibleReason: 'execution_contradicted',
      notes: `Native coding failed: ${message}`,
      failureReason: message,
    });
    writeHookStatus(hookPath, 'error', 'process_exit', message, 'native');
    writeTextStatus(options.session, options.issue, 'native coding error');
    throw error;
  }
}
