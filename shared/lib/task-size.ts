/**
 * Task-size estimation and the packet §12 size section (HOK-3469).
 *
 * One estimator answers "how big is this task?" for both the hold decision at
 * the picker and the degraded-mode packet shrinker. The file list comes from
 * the existing touch-set predictor run over the packet's §2 Key Files section
 * (plus listed paths that do not exist yet — new files); the added-lines
 * number is the LLM's `Estimated added lines:` line from §3.
 *
 * The estimate is written into the packet as a deterministic, machine-readable
 * `## 12. Size Estimate` section. It travels with the Linear description, so
 * the picker reads it from the backlog record it already has and re-evaluates
 * the verdict against the *current* limits — tuning a limit takes effect
 * without re-expanding. No new store, no LLM on the picker path.
 */
import posix from 'node:path/posix';
import { loadPromptTemplate } from './prompt-utils.ts';
import { callHeadlessLLM, type HeadlessLLMOptions } from './headless-llm.ts';
import { resolveWavemillPromptPath } from './native-agent/install-paths.ts';
import type { TaskSizeConfig } from './config.ts';
import {
  createGitRepoProbe,
  extractPathCandidates,
  predictTouchSetDeterministic,
  type RepoProbe,
} from './touch-set-predictor.ts';

/** Fully-resolved limits. */
export type TaskSizeLimits = Required<TaskSizeConfig>;

export type SizeReason = 'lines' | 'files' | 'core';

export type LinesSource = 'llm' | 'missing';

export interface TaskSizeEstimate {
  /** Estimated added lines, or null when the packet does not record one. */
  addedLines: number | null;
  /** Repo-relative paths the task is expected to touch, sorted. */
  files: string[];
  /** The subset of `files` that are configured core files, sorted. */
  coreFiles: string[];
  linesSource: LinesSource;
}

export interface TaskSizeVerdict {
  oversized: boolean;
  reasons: SizeReason[];
}

export interface TaskSizeSlice {
  title: string;
  scope: string;
  files: string[];
  estimatedAddedLines: number | null;
}

/** The machine-readable content of packet §12. */
export interface ParsedTaskSize {
  addedLines: number | null;
  files: string[];
  coreFiles: string[];
  linesSource: LinesSource;
  slices: TaskSizeSlice[];
  slicesUnavailable: boolean;
  /** Slice issue ids recorded after the operator accepted the proposal. */
  accepted: string[];
}

export const TASK_SIZE_SECTION_NUMBER = 12;
export const TASK_SIZE_SECTION_HEADING = '## 12. Size Estimate';
export const TASK_SIZE_SLICES_HEADING = '### Proposed Slices';
export const MIN_PROPOSED_SLICES = 2;
export const MAX_PROPOSED_SLICES = 4;
/** Characters of the packet sent to the slice-proposal LLM. */
export const SLICE_PROMPT_MAX_CHARS = 12_000;

const ESTIMATED_ADDED_LINES_RE = /\bEstimated added lines[\s*:]*~?\s*([\d,]+)/i;
const SIZE_HEADING_RE = /^##\s+12\.\s+Size Estimate\s*$/im;
const SIZE_SECTION_BODY_LINE_RES = [
  /^\s*-\s+[A-Za-z][A-Za-z0-9 ]*:\s*.*$/,
  /^###\s+Proposed Slices\s*$/i,
  /^\s*\d+\.\s+\*\*.+\*\*\s*$/,
  /^unavailable\s*$/i,
];

/**
 * Locate the extent of the §12 block.
 *
 * The block ends at the first non-blank line that is not part of the section's
 * grammar (estimate bullets, the slices heading, numbered slice entries). That
 * keeps any trailing content — a `## 13. …` section, a preserved authored-links
 * footer appended below §12 — with the packet instead of swallowing it when the
 * section is replaced.
 */
function sizeSectionBounds(markdown: string): { start: number; bodyStart: number; bodyEnd: number } | null {
  const heading = markdown.match(SIZE_HEADING_RE);
  if (!heading || heading.index === undefined) return null;
  const start = heading.index;
  const bodyStart = start + heading[0].length;
  const rest = markdown.slice(bodyStart);
  const lines = rest.split('\n');
  let offset = 0;
  let bodyEnd = markdown.length;
  for (const line of lines) {
    if (line.trim() !== '' && !SIZE_SECTION_BODY_LINE_RES.some((re) => re.test(line))) {
      bodyEnd = bodyStart + offset;
      break;
    }
    offset += line.length + 1;
  }
  return { start, bodyStart, bodyEnd };
}

/** Normalize a repo-relative path for comparison; null for absolute/parent paths. */
export function normalizeSizePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.includes('://') || trimmed.startsWith('/')) return null;
  const normalized = posix.normalize(trimmed).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}

function dedupeSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function parseInteger(raw: string | undefined): number | null {
  if (!raw) return null;
  const digits = raw.replace(/,/g, '').trim();
  if (!/^\d+$/.test(digits)) return null;
  return Number.parseInt(digits, 10);
}

/**
 * Extract the body of the packet's §2 `Key Files` section. Falls back to the
 * §11 `**Files to Modify**` list when Key Files is missing or empty.
 */
export function extractPacketFileSection(packet: string): string {
  const keyFiles = extractHeadingBody(packet, /^#{2,3}\s+Key Files\s*$/im);
  if (extractPathCandidates(keyFiles).paths.length > 0 || extractPathCandidates(keyFiles).basenames.length > 0) {
    return keyFiles;
  }
  return extractFilesToModifyBody(packet) || keyFiles;
}

function extractHeadingBody(markdown: string, heading: RegExp): string {
  const match = markdown.match(heading);
  if (!match || match.index === undefined) return '';
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.match(/^#{2,4}\s+/m);
  return next && next.index !== undefined ? rest.slice(0, next.index) : rest;
}

function extractFilesToModifyBody(packet: string): string {
  const label = packet.match(/\*\*Files to Modify\*\*/i);
  if (!label || label.index === undefined) return '';
  const rest = packet.slice(label.index + label[0].length);
  const lines: string[] = [];
  for (const line of rest.split('\n')) {
    const trimmed = line.trim();
    if (/^(?:[-*+]|\d+\.)\s+/.test(trimmed)) {
      lines.push(line);
      continue;
    }
    if (trimmed === '' && lines.length > 0) break;
    if (lines.length > 0) break;
    // Skip the "(Auto-detected)" remainder on the label line; keep scanning.
  }
  return lines.join('\n');
}

/** Parse the LLM's `Estimated added lines: <n>` line, if present. */
export function parseEstimatedAddedLines(text: string): number | null {
  const match = text.match(ESTIMATED_ADDED_LINES_RE);
  return match ? parseInteger(match[1]) : null;
}

/**
 * Build a size estimate from a packet.
 *
 * The file count reuses the touch-set predictor (HOK-3131): listed paths that
 * exist or resolve to a unique tracked file are counted as-is, and listed
 * paths that do not exist yet are counted as new files. The added-lines
 * number is parsed from the packet; when absent the estimate is files/core
 * only and never oversized by lines.
 */
export function estimateTaskSize(
  packet: string,
  options: { repoDir?: string; probe?: RepoProbe | null; limits: TaskSizeLimits },
): TaskSizeEstimate {
  const withoutSize = stripSizeSection(packet);
  const section = extractPacketFileSection(withoutSize);
  const candidates = extractPathCandidates(section);
  const probe = options.probe ?? (options.repoDir ? createGitRepoProbe(options.repoDir) : null);

  const files = new Set<string>();

  if (probe) {
    const touchSet = predictTouchSetDeterministic(
      { id: 'task-size', title: '', description: section },
      probe,
    );
    for (const entry of touchSet.entries) files.add(entry.path);
  }

  for (const rawPath of candidates.paths) {
    const path = normalizeSizePath(rawPath);
    if (!path) continue;
    if (!probe) {
      files.add(path);
      continue;
    }
    // A listed path that exists is already in the touch set. A listed path
    // that resolves by suffix is too. Anything else is a new file.
    if (probe.fileExists(path)) continue;
    if (probe.findBySuffix(path).length === 1) continue;
    files.add(path);
  }

  if (!probe) {
    for (const basename of candidates.basenames) {
      const path = normalizeSizePath(basename);
      if (path && !path.includes('/')) files.add(path);
    }
  }

  const coreSet = new Set(
    (options.limits.coreFiles ?? [])
      .map((path) => normalizeSizePath(path))
      .filter((path): path is string => Boolean(path)),
  );
  const allFiles = dedupeSorted(files);
  const coreFiles = allFiles.filter((path) => coreSet.has(path));

  const addedLines = parseEstimatedAddedLines(withoutSize);

  return {
    addedLines,
    files: allFiles,
    coreFiles,
    linesSource: addedLines === null ? 'missing' : 'llm',
  };
}

function coreRuleTrips(coreFiles: Iterable<string>, limits: TaskSizeLimits): boolean {
  const anchor = normalizeSizePath(limits.anchorCoreFile);
  if (!anchor) return false;
  const core = dedupeSorted(
    [...coreFiles].map((path) => normalizeSizePath(path)).filter((path): path is string => Boolean(path)),
  );
  if (!core.includes(anchor)) return false;
  return core.length - 1 >= limits.maxCoreCompanions;
}

/**
 * Apply the three size rules to an estimate. Pure.
 *
 * - `lines`: estimated added lines strictly greater than `maxAddedLines`
 * - `files`: more than `maxFiles` expected files
 * - `core`: the anchor core file plus at least `maxCoreCompanions` other core files
 */
export function evaluateTaskSize(estimate: TaskSizeEstimate, limits: TaskSizeLimits): TaskSizeVerdict {
  if (!limits.enabled) return { oversized: false, reasons: [] };
  const reasons: SizeReason[] = [];
  if (estimate.addedLines !== null && estimate.addedLines > limits.maxAddedLines) reasons.push('lines');
  if (estimate.files.length > limits.maxFiles) reasons.push('files');
  if (coreRuleTrips(estimate.coreFiles, limits)) reasons.push('core');
  return { oversized: reasons.length > 0, reasons };
}

/**
 * Re-evaluate the verdict from the numbers recorded in §12 (the picker path).
 * Only the recorded file count and core-file list are needed; the full path
 * list is not re-read.
 */
export function evaluateRecordedTaskSize(
  recorded: { addedLines: number | null; fileCount: number; coreFiles: string[] },
  limits: TaskSizeLimits,
): TaskSizeVerdict {
  if (!limits.enabled) return { oversized: false, reasons: [] };
  const reasons: SizeReason[] = [];
  if (recorded.addedLines !== null && recorded.addedLines > limits.maxAddedLines) reasons.push('lines');
  if (recorded.fileCount > limits.maxFiles) reasons.push('files');
  if (coreRuleTrips(recorded.coreFiles, limits)) reasons.push('core');
  return { oversized: reasons.length > 0, reasons };
}

function renderList(values: Iterable<string>): string {
  const items = dedupeSorted(values);
  return items.length > 0 ? items.join(', ') : '(none)';
}

/**
 * Render the `## 12. Size Estimate` block. Plain markdown only (heading,
 * bullets, numbered list) and no HTML comments, which Linear may strip.
 * `renderSizeSection` and `parseSizeSection` round-trip.
 */
export function renderSizeSection(
  estimate: TaskSizeEstimate,
  verdict: TaskSizeVerdict,
  slices: TaskSizeSlice[],
  options: { accepted?: string[]; slicesUnavailable?: boolean } = {},
): string {
  const lines: string[] = [
    TASK_SIZE_SECTION_HEADING,
    '',
    `- addedLines: ${estimate.addedLines === null ? 'unknown' : String(estimate.addedLines)}`,
    `- files: ${renderList(estimate.files)}`,
    `- coreFiles: ${renderList(estimate.coreFiles)}`,
    `- source: ${estimate.linesSource}`,
    `- verdict: ${verdict.reasons.length > 0 ? `oversized (${verdict.reasons.join(', ')})` : 'within limits'}`,
  ];

  if (options.accepted && options.accepted.length > 0) {
    lines.push(`- accepted: ${options.accepted.join(', ')}`);
  }
  if (options.slicesUnavailable) {
    lines.push('- slices: unavailable');
  }
  lines.push('');

  if (verdict.oversized) {
    lines.push(TASK_SIZE_SLICES_HEADING, '');
    if (slices.length === 0) {
      lines.push('unavailable', '');
    } else {
      slices.forEach((slice, index) => {
        lines.push(`${index + 1}. **${slice.title.trim()}**`);
        lines.push(`   - Files: ${renderList(slice.files)}`);
        lines.push(`   - Estimated added lines: ${slice.estimatedAddedLines === null ? 'unknown' : String(slice.estimatedAddedLines)}`);
        lines.push(`   - Scope: ${slice.scope.trim().replace(/\s+/g, ' ')}`);
      });
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Extract the `## 12. Size Estimate` block, or null when absent. */
export function extractSizeSection(markdown: string): string | null {
  const bounds = sizeSectionBounds(markdown);
  if (!bounds) return null;
  return markdown.slice(bounds.bodyStart, bounds.bodyEnd);
}

/** Remove any existing §12 block so a re-expansion re-annotates cleanly. */
export function stripSizeSection(markdown: string): string {
  const bounds = sizeSectionBounds(markdown);
  if (!bounds) return markdown;
  const before = markdown.slice(0, bounds.start);
  const after = markdown.slice(bounds.bodyEnd);
  return `${before}${after}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function splitList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '(none)') return [];
  return dedupeSorted(
    trimmed
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseSlices(body: string): { slices: TaskSizeSlice[]; unavailable: boolean } {
  const headingMatch = body.match(/^###\s+Proposed Slices\s*$/im);
  if (!headingMatch || headingMatch.index === undefined) return { slices: [], unavailable: false };
  const rest = body.slice(headingMatch.index + headingMatch[0].length);
  if (/^\s*unavailable\s*$/im.test(rest.split('\n').slice(0, 3).join('\n'))) {
    return { slices: [], unavailable: true };
  }

  const slices: TaskSizeSlice[] = [];
  let current: TaskSizeSlice | null = null;
  for (const line of rest.split('\n')) {
    const title = line.match(/^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/);
    if (title) {
      if (current) slices.push(current);
      current = { title: title[1].trim(), scope: '', files: [], estimatedAddedLines: null };
      continue;
    }
    if (!current) continue;
    const files = line.match(/^\s*-\s+Files:\s*(.*)$/i);
    if (files) {
      current.files = splitList(files[1]);
      continue;
    }
    const added = line.match(/^\s*-\s+Estimated added lines:\s*~?\s*([\d,]+|unknown)\s*$/i);
    if (added) {
      current.estimatedAddedLines = added[1].toLowerCase() === 'unknown' ? null : parseInteger(added[1]);
      continue;
    }
    const scope = line.match(/^\s*-\s+Scope:\s*(.*)$/i);
    if (scope) current.scope = scope[1].trim();
  }
  if (current) slices.push(current);

  if (slices.length === 0) return { slices: [], unavailable: true };
  return { slices, unavailable: false };
}

/** Parse a packet's §12 block. Returns null when the packet has none. */
export function parseSizeSection(markdown: string): ParsedTaskSize | null {
  const body = extractSizeSection(markdown);
  if (body === null) return null;

  let addedLines: number | null = null;
  let files: string[] = [];
  let coreFiles: string[] = [];
  let linesSource: LinesSource = 'missing';
  let accepted: string[] = [];
  let slicesUnavailable = false;

  for (const line of body.split('\n')) {
    const bullet = line.match(/^-\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (!bullet) continue;
    const key = bullet[1];
    const value = bullet[2].trim();
    switch (key) {
      case 'addedLines':
        addedLines = value.toLowerCase() === 'unknown' ? null : parseInteger(value);
        break;
      case 'files':
        files = splitList(value);
        break;
      case 'coreFiles':
        coreFiles = splitList(value);
        break;
      case 'source':
        linesSource = value === 'llm' ? 'llm' : 'missing';
        break;
      case 'accepted':
        accepted = splitList(value);
        break;
      case 'slices':
        if (value.toLowerCase() === 'unavailable') slicesUnavailable = true;
        break;
      default:
        break;
    }
  }

  const parsedSlices = parseSlices(body);
  return {
    addedLines,
    files,
    coreFiles,
    linesSource,
    slices: parsedSlices.slices,
    slicesUnavailable: slicesUnavailable || parsedSlices.unavailable,
    accepted,
  };
}

function stripCodeFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
}

/**
 * Parse the slice-proposal LLM response. Enforces 2–4 slices and drops
 * malformed entries; returns null when the response cannot be used (a failed
 * proposal is never fatal).
 */
export function parseSliceProposal(raw: string): TaskSizeSlice[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const slices: TaskSizeSlice[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    if (!title) continue;
    const scope = typeof record.scope === 'string' ? record.scope.trim() : '';
    const files = Array.isArray(record.files)
      ? dedupeSorted(
        record.files
          .filter((path): path is string => typeof path === 'string')
          .map((path) => normalizeSizePath(path))
          .filter((path): path is string => Boolean(path)),
      )
      : [];
    const added = typeof record.estimatedAddedLines === 'number' && Number.isFinite(record.estimatedAddedLines)
      ? Math.max(0, Math.round(record.estimatedAddedLines))
      : null;
    slices.push({ title, scope, files, estimatedAddedLines: added });
  }

  if (slices.length < MIN_PROPOSED_SLICES || slices.length > MAX_PROPOSED_SLICES) return null;
  return slices;
}

export const taskSizeDeps = {
  callHeadlessLLM,
  loadPromptTemplate,
};

function buildSlicePrompt(packet: string, estimate: TaskSizeEstimate, limits: TaskSizeLimits, template: string): string {
  const body = packet.length > SLICE_PROMPT_MAX_CHARS ? packet.slice(0, SLICE_PROMPT_MAX_CHARS) : packet;
  return template
    .replaceAll('{{LIMITS}}', [
      `Maximum added lines: ${limits.maxAddedLines}`,
      `Maximum files: ${limits.maxFiles}`,
      `Estimated added lines: ${estimate.addedLines ?? 'unknown'}`,
      `Estimated files (${estimate.files.length}): ${estimate.files.join(', ') || '(none)'}`,
    ].join('\n'))
    .replaceAll('{{SLICE_COUNT}}', `${MIN_PROPOSED_SLICES}-${MAX_PROPOSED_SLICES}`)
    .replaceAll('{{PACKET}}', body);
}

/**
 * Ask the planning model for 2–4 independently mergeable slices. Returns null
 * on any failure; callers record `slices: unavailable` and still hold the task.
 */
export async function proposeTaskSlices(
  packet: string,
  estimate: TaskSizeEstimate,
  limits: TaskSizeLimits,
  options: { repoDir?: string } = {},
): Promise<TaskSizeSlice[] | null> {
  try {
    const template = await taskSizeDeps.loadPromptTemplate(resolveWavemillPromptPath('task-size-split.md'));
    const prompt = buildSlicePrompt(packet, estimate, limits, template);
    const callOptions: HeadlessLLMOptions = {
      mode: 'stream',
      repoDir: options.repoDir,
      cwd: options.repoDir,
      taskType: 'planning',
      systemInstruction:
        'Return only raw JSON. Do not include markdown fences, commentary, or explanations.',
    };
    const result = await taskSizeDeps.callHeadlessLLM(prompt, callOptions);
    return parseSliceProposal(result.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Task-size slice proposal failed: ${message}`);
    return null;
  }
}
