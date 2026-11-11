import { callHeadlessLLM, type HeadlessLLMOptions } from './headless-llm.ts';
import type { OperatingMode } from './operating-mode.ts';
import { getTaskSizeConfig } from './config.ts';
import { estimateTaskSize, type TaskSizeLimits } from './task-size.ts';
import type { RepoProbe } from './touch-set-predictor.ts';

const SURVIVAL_MAX_FILES = 5;
const CONSTRAINED_MAX_FILES = 10;
const LARGE_PACKET_LINE_THRESHOLD = 400;

function countLines(fullContent: string): number {
  if (fullContent.length === 0) {
    return 0;
  }

  return fullContent.split('\n').length;
}

function buildSplitPrompt(fullContent: string, mode: OperatingMode): string {
  const maxFiles = mode === 'survival' ? SURVIVAL_MAX_FILES : CONSTRAINED_MAX_FILES;
  const modeName = mode.toUpperCase();

  return [
    'You are splitting a large task packet into smaller independent sub-packets for degraded mode execution.',
    `Mode: ${modeName} (at most ${maxFiles} files per sub-packet)`,
    '',
    'Rules:',
    '- Preserve all requirements cumulatively across sub-packets.',
    '- Prefer one-file patches when possible.',
    '- Forbid speculative refactors or cleanup not required for the issue.',
    '- Prefer splitting by feature area or concrete file grouping, not abstract phases.',
    '- Each sub-packet must be independently executable whenever possible.',
    '- Each sub-packet must be complete markdown with: objective, key files, implementation approach, and success criteria.',
    '- Keep each sub-packet narrowly scoped and ready for weaker models to execute.',
    '',
    'Return ONLY valid JSON in this shape:',
    '[{"title":"short title","content":"full markdown packet"}]',
    '',
    'Original packet:',
    '---',
    fullContent,
    '---',
  ].join('\n');
}

function parseSplitResponse(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) {
    throw new Error('split response is not a JSON array');
  }

  const parsed = JSON.parse(trimmed) as Array<{ content?: unknown }>;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('split response did not contain any packets');
  }

  const packets = parsed
    .map(item => typeof item?.content === 'string' ? item.content.trim() : '')
    .filter(Boolean);

  if (packets.length === 0) {
    throw new Error('split response packets were empty');
  }

  return packets;
}

export const scopeShrinkerDeps = {
  callHeadlessLLM,
};

export type { OperatingMode } from './operating-mode.ts';

export function buildScopeConstraintContext(mode: OperatingMode): string {
  if (mode === 'normal') {
    return '';
  }

  const maxFiles = mode === 'survival' ? SURVIVAL_MAX_FILES : CONSTRAINED_MAX_FILES;
  const prefersOneFilePatches = mode === 'survival'
    ? '- Prefer one-file patches whenever possible; only touch additional files when strictly required.\n'
    : '';
  const deferralGuidance = mode === 'survival'
    ? '- Mark deferred work explicitly in Scope Out or follow-up notes instead of partially implementing it.\n'
    : '- If the issue naturally breaks into multiple packets or PRs, choose the smallest independently shippable slice first.\n';

  const lines = [
    '## Degraded Mode Scope Constraints',
    '',
    `Operating mode is \`${mode}\`. Scope the task packet for weaker models and limited quota.`,
    '',
    '- Narrow the task to the smallest complete implementation that satisfies the issue.',
    `- Keep the primary implementation to ${maxFiles} files or fewer unless the issue is impossible to complete otherwise.`,
  ];

  if (prefersOneFilePatches) {
    lines.push(prefersOneFilePatches.replace(/\n$/, ''));
  }

  lines.push(
    '- Forbid speculative refactors, opportunistic cleanup, or incidental renames.',
    '- Do not bundle follow-on enhancements into the same packet.',
    deferralGuidance.replace(/\n$/, ''),
    '- If work must be phased, make the first phase independently valuable and explicitly defer later phases.',
    '',
  );

  return lines.join('\n');
}

export interface ShouldSplitOptions {
  repoDir?: string;
  probe?: RepoProbe | null;
  /** Override the configured limits (tests). */
  limits?: TaskSizeLimits;
}

export function shouldSplitPacket(
  fullContent: string,
  mode: OperatingMode,
  options: ShouldSplitOptions = {},
): boolean {
  if (mode === 'normal') {
    return false;
  }

  // The file count comes from the one task-size estimator (HOK-3469); there is
  // no second file counter.
  const limits = options.limits ?? getTaskSizeConfig(options.repoDir);
  const estimate = estimateTaskSize(fullContent, {
    repoDir: options.repoDir,
    probe: options.probe,
    limits,
  });
  const fileCount = estimate.files.length;
  const lineCount = countLines(fullContent);

  if (mode === 'survival') {
    return fileCount > SURVIVAL_MAX_FILES || lineCount > LARGE_PACKET_LINE_THRESHOLD;
  }

  return fileCount > CONSTRAINED_MAX_FILES || lineCount > LARGE_PACKET_LINE_THRESHOLD;
}

export async function splitPacketIntoSubPackets(
  fullContent: string,
  mode: OperatingMode,
  options: { repoDir?: string } = {}
): Promise<string[]> {
  if (mode === 'normal') {
    return [fullContent];
  }

  const prompt = buildSplitPrompt(fullContent, mode);
  const callOptions: HeadlessLLMOptions = {
    mode: 'stream',
    repoDir: options.repoDir,
    cwd: options.repoDir,
    taskType: 'planning',
    systemInstruction:
      'Return only raw JSON. Do not include markdown fences, commentary, or explanations.',
  };

  try {
    const result = await scopeShrinkerDeps.callHeadlessLLM(prompt, callOptions);
    const packets = parseSplitResponse(result.text);
    return packets.length > 0 ? packets : [fullContent];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Task packet auto-split failed: ${message}`);
    return [fullContent];
  }
}
