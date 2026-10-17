/**
 * Review diff budget: keep the diff handed to the reviewer model inside its
 * input limit by summarizing what does not need line-by-line review.
 *
 * A PR that ships generated output (bundles, lockfiles, exported fixtures) can
 * produce a multi-megabyte diff. Reviewer CLIs reject that outright (codex
 * caps input at 1,048,576 characters) and the review fails as
 * `review-tool-error` on every retry, because retrying cannot shrink the diff.
 * Compaction runs in three layers:
 *
 * 1. Generated files (path patterns, `.gitattributes` linguist-generated, or a
 *    `PROVENANCE.json` manifest that lists them) become one-line summaries
 *    naming their generator. The generator script itself stays in the diff.
 * 2. Near-duplicate families (≥3 new files in one directory with the same
 *    extension that differ only slightly) keep one representative in full and
 *    show each sibling as a compact delta against it.
 * 3. Only if the result still exceeds the budget are the largest remaining
 *    files dropped. That is a last resort: those files go unreviewed, and
 *    callers must surface them loudly (see review-runner's coverage finding).
 *
 * Only the diff text given to the model is compacted. Callers keep using the
 * full changed-file list for scope checks and metadata.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

/** Default character budget for the diff portion of the review prompt. */
export const DEFAULT_REVIEW_DIFF_MAX_CHARS = 400_000;

/** Entries listed individually per note section before collapsing to a count. */
const MAX_LISTED_ENTRIES = 100;
/** Minimum members for a near-duplicate family. */
const MIN_FAMILY_SIZE = 3;
/** Changes listed per family sibling before collapsing to a count. */
const MAX_LISTED_CHANGES = 25;
/** Longest rendered value in a delta line. */
const MAX_DELTA_VALUE_CHARS = 80;

const GENERATED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(dist|build)\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|go\.sum)$/,
];

export type ReviewDiffOmissionReason = 'generated' | 'near-duplicate' | 'size-budget';

export interface ReviewDiffOmission {
  path: string;
  reason: ReviewDiffOmissionReason;
  chars: number;
  additions: number;
  deletions: number;
  /** Command that regenerates the file, when known (generated only). */
  generator?: string;
  /** Family representative the delta is shown against (near-duplicate only). */
  representative?: string;
}

export interface CompactReviewDiffResult {
  /** Diff to hand to the reviewer, prefixed with a note when anything was set aside. */
  diff: string;
  omitted: ReviewDiffOmission[];
  /** Hand-written files dropped to fit the budget: these were not reviewed. */
  unreviewed: ReviewDiffOmission[];
  originalChars: number;
  keptChars: number;
}

/** What is known about a generated file; `generator` names the command that writes it. */
export interface GeneratedFileInfo {
  generator?: string;
}

export interface CompactReviewDiffOptions {
  /** Character budget for the compacted diff (default: env or {@link DEFAULT_REVIEW_DIFF_MAX_CHARS}). */
  maxChars?: number;
  /** Extra generated files, e.g. from {@link readGeneratedFileInfo}. */
  generated?: ReadonlyMap<string, GeneratedFileInfo>;
}

interface DiffFileSection {
  path: string;
  text: string;
  additions: number;
  deletions: number;
  isNewFile: boolean;
}

interface Family {
  representative: DiffFileSection;
  /** Sibling → rendered delta lines against the representative. */
  siblings: Array<{ section: DiffFileSection; delta: string[] }>;
}

/**
 * Resolve the diff budget from `WAVEMILL_REVIEW_DIFF_MAX_CHARS`, falling back
 * to {@link DEFAULT_REVIEW_DIFF_MAX_CHARS} for missing or invalid values.
 */
export function resolveReviewDiffMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.WAVEMILL_REVIEW_DIFF_MAX_CHARS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REVIEW_DIFF_MAX_CHARS;
}

/** True when a path matches a known generated-output pattern. */
export function isGeneratedReviewPath(path: string): boolean {
  return GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Compact a unified git diff for review. Returns the input unchanged (with
 * empty `omitted`) when nothing is generated or duplicated and it already fits.
 */
export function compactReviewDiff(
  diff: string,
  options: CompactReviewDiffOptions = {},
): CompactReviewDiffResult {
  const maxChars = options.maxChars ?? resolveReviewDiffMaxChars();
  const { preamble, sections } = splitDiffByFile(diff);
  const omitted: ReviewDiffOmission[] = [];
  const omit = (section: DiffFileSection, reason: ReviewDiffOmissionReason, extra: Partial<ReviewDiffOmission> = {}) => {
    omitted.push({
      path: section.path,
      reason,
      chars: section.text.length,
      additions: section.additions,
      deletions: section.deletions,
      ...extra,
    });
  };

  // Layer 1: generated files become summaries.
  const handWritten: DiffFileSection[] = [];
  for (const section of sections) {
    const info = options.generated?.get(section.path);
    if (info || isGeneratedReviewPath(section.path)) {
      omit(section, 'generated', info?.generator ? { generator: info.generator } : {});
    } else {
      handWritten.push(section);
    }
  }

  // Layer 2: near-duplicate families keep a representative plus deltas.
  const families = findNearDuplicateFamilies(handWritten);
  const familySiblings = new Set<DiffFileSection>();
  for (const family of families) {
    for (const { section } of family.siblings) {
      familySiblings.add(section);
      omit(section, 'near-duplicate', { representative: family.representative.path });
    }
  }
  let kept = handWritten.filter((section) => !familySiblings.has(section));
  const familyBlocks = families.map(formatFamilyBlock);

  if (omitted.length === 0 && diff.length <= maxChars) {
    return { diff, omitted, unreviewed: [], originalChars: diff.length, keptChars: diff.length };
  }

  // Layer 3 (last resort): drop the largest remaining files until it fits.
  const fixedChars = preamble.length + familyBlocks.reduce((sum, block) => sum + block.length, 0);
  let keptChars = fixedChars + kept.reduce((sum, section) => sum + section.text.length, 0);
  if (keptChars > maxChars) {
    const dropped = new Set<DiffFileSection>();
    for (const section of [...kept].sort((a, b) => b.text.length - a.text.length)) {
      if (keptChars <= maxChars) break;
      dropped.add(section);
      keptChars -= section.text.length;
      omit(section, 'size-budget');
    }
    kept = kept.filter((section) => !dropped.has(section));
  }

  if (omitted.length === 0) {
    return { diff, omitted, unreviewed: [], originalChars: diff.length, keptChars: diff.length };
  }

  const body = preamble + kept.map((section) => section.text).join('') + familyBlocks.join('');
  return {
    diff: formatOmissionNote(omitted, kept.length) + body,
    omitted,
    unreviewed: omitted.filter((entry) => entry.reason === 'size-budget'),
    originalChars: diff.length,
    keptChars: body.length,
  };
}

/**
 * Generated files among `paths`: those `.gitattributes` marks
 * `linguist-generated`, and those listed by a `PROVENANCE.json` manifest in
 * their directory or an ancestor (its `command` names the generator).
 * Best-effort: unreadable attributes or manifests are ignored.
 */
export function readGeneratedFileInfo(repoDir: string, paths: readonly string[]): Map<string, GeneratedFileInfo> {
  const generated = new Map<string, GeneratedFileInfo>();
  for (const path of readLinguistGeneratedPaths(repoDir, paths)) {
    generated.set(path, {});
  }
  const manifests = new Map<string, ProvenanceManifest | null>();
  for (const path of paths) {
    for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
      const manifest = loadProvenanceManifest(repoDir, dir, manifests);
      const relative = dir === '.' ? path : posix.relative(dir, path);
      if (manifest?.files.has(relative)) {
        generated.set(path, manifest.command ? { generator: manifest.command } : {});
        break;
      }
      if (dir === '.' || dir === '/') break;
    }
  }
  return generated;
}

/** Changed file paths in a unified diff, in order. */
export function listDiffPaths(diff: string): string[] {
  return splitDiffByFile(diff).sections.map((section) => section.path);
}

interface ProvenanceManifest {
  files: Set<string>;
  command?: string;
}

function loadProvenanceManifest(
  repoDir: string,
  dir: string,
  cache: Map<string, ProvenanceManifest | null>,
): ProvenanceManifest | null {
  if (cache.has(dir)) return cache.get(dir) ?? null;
  let manifest: ProvenanceManifest | null = null;
  const file = posix.join(repoDir, dir, 'PROVENANCE.json');
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { files?: unknown; command?: unknown };
      const files = Array.isArray(parsed.files)
        ? parsed.files.filter((name): name is string => typeof name === 'string')
        : parsed.files && typeof parsed.files === 'object' ? Object.keys(parsed.files) : [];
      if (files.length > 0) {
        manifest = { files: new Set(files), ...(typeof parsed.command === 'string' ? { command: parsed.command } : {}) };
      }
    }
  } catch {
    // A malformed manifest marks nothing as generated.
  }
  cache.set(dir, manifest);
  return manifest;
}

function readLinguistGeneratedPaths(repoDir: string, paths: readonly string[]): Set<string> {
  const generated = new Set<string>();
  if (paths.length === 0) return generated;
  try {
    const output = execFileSync('git', ['check-attr', '-z', '--stdin', 'linguist-generated'], {
      cwd: repoDir,
      input: paths.join('\0') + '\0',
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    // -z output is NUL-separated triples: <path> NUL <attr> NUL <value> NUL
    const fields = output.split('\0');
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const value = fields[i + 2];
      if (value === 'set' || value === 'true') generated.add(fields[i]);
    }
  } catch {
    // No git, not a repo, or no attributes: fall back to path patterns only.
  }
  return generated;
}

// ────────────────────────────────────────────────────────────────
// Near-duplicate families
// ────────────────────────────────────────────────────────────────

/**
 * Group new files by directory and extension, then greedily cluster each group
 * around its smallest remaining member. Deterministic: members are visited in
 * size order, ties broken by path.
 */
function findNearDuplicateFamilies(sections: readonly DiffFileSection[]): Family[] {
  const groups = new Map<string, DiffFileSection[]>();
  for (const section of sections) {
    if (!section.isNewFile) continue;
    const key = `${posix.dirname(section.path)}\0${posix.extname(section.path)}`;
    groups.set(key, [...(groups.get(key) ?? []), section]);
  }

  const families: Family[] = [];
  for (const group of groups.values()) {
    let remaining = [...group].sort((a, b) => a.text.length - b.text.length || a.path.localeCompare(b.path));
    while (remaining.length >= MIN_FAMILY_SIZE) {
      const [representative, ...rest] = remaining;
      const siblings = rest
        .map((section) => ({ section, delta: nearDuplicateDelta(representative, section) }))
        .filter((entry): entry is { section: DiffFileSection; delta: string[] } => entry.delta !== null);
      if (siblings.length + 1 >= MIN_FAMILY_SIZE) {
        families.push({ representative, siblings });
        const clustered = new Set(siblings.map((entry) => entry.section));
        remaining = rest.filter((section) => !clustered.has(section));
      } else {
        remaining = rest;
      }
    }
  }
  return families;
}

/** Delta lines when `sibling` is a near-duplicate of `representative`, else null. */
function nearDuplicateDelta(representative: DiffFileSection, sibling: DiffFileSection): string[] | null {
  const repText = addedContent(representative.text);
  const sibText = addedContent(sibling.text);
  if (posix.extname(representative.path) === '.json') {
    const repLeaves = parseJsonLeaves(repText);
    const sibLeaves = parseJsonLeaves(sibText);
    if (repLeaves && sibLeaves) {
      const changes: string[] = [];
      for (const [path, value] of repLeaves) {
        if (!sibLeaves.has(path)) changes.push(`${path}: removed (was ${clip(value)})`);
        else if (sibLeaves.get(path) !== value) changes.push(`${path}: ${clip(value)} → ${clip(sibLeaves.get(path)!)}`);
      }
      for (const [path, value] of sibLeaves) {
        if (!repLeaves.has(path)) changes.push(`${path}: added ${clip(value)}`);
      }
      return isNear(changes.length, Math.max(repLeaves.size, sibLeaves.size)) ? changes : null;
    }
  }
  // Text fallback: positional line comparison, which suits generated variants
  // that mutate values in place.
  const repLines = repText.split('\n');
  const sibLines = sibText.split('\n');
  const changes: string[] = [];
  for (let i = 0; i < Math.max(repLines.length, sibLines.length); i += 1) {
    if (repLines[i] !== sibLines[i]) {
      changes.push(`line ${i + 1}: ${clip(JSON.stringify(repLines[i] ?? null))} → ${clip(JSON.stringify(sibLines[i] ?? null))}`);
    }
  }
  return isNear(changes.length, Math.max(repLines.length, sibLines.length)) ? changes : null;
}

/** At most 5% of units changed (but always allow a handful), and at least one. */
function isNear(changed: number, total: number): boolean {
  return changed > 0 && changed <= Math.max(10, Math.floor(total * 0.05));
}

function parseJsonLeaves(text: string): Map<string, string> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const leaves = new Map<string, string>();
  const visit = (node: unknown, path: string) => {
    if (node !== null && typeof node === 'object' && Object.keys(node).length > 0) {
      for (const [key, child] of Object.entries(node)) {
        visit(child, Array.isArray(node) ? `${path}[${key}]` : `${path}.${key}`);
      }
    } else {
      leaves.set(path, JSON.stringify(node));
    }
  };
  visit(value, '$');
  return leaves;
}

function formatFamilyBlock(family: Family): string {
  const lines = [
    `# Near-duplicate family: ${family.siblings.length} sibling(s) of ${family.representative.path} (shown in full above).`,
    '# Each sibling is new in this change and differs from the representative only as listed:',
  ];
  for (const { section, delta } of family.siblings) {
    lines.push(`#   ${section.path}: ${delta.length} change(s)`);
    for (const change of delta.slice(0, MAX_LISTED_CHANGES)) {
      lines.push(`#     ${change}`);
    }
    if (delta.length > MAX_LISTED_CHANGES) {
      lines.push(`#     ... and ${delta.length - MAX_LISTED_CHANGES} more`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function clip(value: string): string {
  return value.length > MAX_DELTA_VALUE_CHARS ? `${value.slice(0, MAX_DELTA_VALUE_CHARS - 1)}…` : value;
}

// ────────────────────────────────────────────────────────────────
// Diff parsing and the omission note
// ────────────────────────────────────────────────────────────────

function splitDiffByFile(diff: string): { preamble: string; sections: DiffFileSection[] } {
  const starts: number[] = [];
  const headerPattern = /^diff --git /gm;
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(diff)) !== null) {
    starts.push(match.index);
  }
  if (starts.length === 0) {
    return { preamble: diff, sections: [] };
  }

  const sections = starts.map((start, index) => {
    const text = diff.slice(start, starts[index + 1] ?? diff.length);
    const header = text.slice(0, text.search(/^@@/m) >>> 0);
    return {
      path: sectionPath(text),
      text,
      isNewFile: /^new file mode/m.test(header) || /^--- \/dev\/null$/m.test(header),
      ...countChangedLines(text),
    };
  });
  return { preamble: diff.slice(0, starts[0]), sections };
}

function sectionPath(text: string): string {
  const newPath = /^\+\+\+ b\/(.+)$/m.exec(text);
  if (newPath) return newPath[1];
  // Deletions report the new side as /dev/null; use the old side instead.
  const oldPath = /^--- a\/(.+)$/m.exec(text);
  if (oldPath) return oldPath[1];
  const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(text);
  return header ? header[2] : '(unknown path)';
}

/** Content of a new file: its added lines after the first hunk header. */
function addedContent(text: string): string {
  const hunk = text.search(/^@@/m);
  if (hunk < 0) return '';
  return text
    .slice(hunk)
    .split('\n')
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1))
    .join('\n');
}

function countChangedLines(text: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function formatOmissionNote(omitted: readonly ReviewDiffOmission[], keptCount: number): string {
  const byReason = (reason: ReviewDiffOmissionReason) => omitted.filter((entry) => entry.reason === reason);
  const generated = byReason('generated');
  const duplicates = byReason('near-duplicate');
  const unreviewed = byReason('size-budget');
  const lines = [
    `# Review diff note: ${omitted.length} changed file(s) are summarized instead of shown in full; ${keptCount} file(s) follow in full.`,
    '# Summarized files are still part of this change. Do not report them as missing, and do not guess at their contents.',
  ];
  const list = (entries: readonly ReviewDiffOmission[], render: (entry: ReviewDiffOmission) => string) => {
    for (const entry of entries.slice(0, MAX_LISTED_ENTRIES)) lines.push(`#   - ${render(entry)}`);
    if (entries.length > MAX_LISTED_ENTRIES) lines.push(`#   ... and ${entries.length - MAX_LISTED_ENTRIES} more`);
  };
  const counts = (entry: ReviewDiffOmission) => `+${entry.additions}/-${entry.deletions} lines`;
  if (generated.length > 0) {
    lines.push('# Generated output (review the generator, not its output):');
    list(generated, (entry) => `${entry.path} (${counts(entry)}${entry.generator ? `; generator: ${entry.generator}` : ''})`);
  }
  if (duplicates.length > 0) {
    lines.push('# Near-duplicates (shown as deltas against a representative, after the full diff):');
    list(duplicates, (entry) => `${entry.path} (${counts(entry)}; vs ${entry.representative})`);
  }
  if (unreviewed.length > 0) {
    lines.push('# NOT REVIEWED: dropped to fit the reviewer input budget. Flag anything that depends on them:');
    list(unreviewed, (entry) => `${entry.path} (${counts(entry)}; ${entry.chars} chars)`);
  }
  return `${lines.join('\n')}\n\n`;
}
