/**
 * Review diff budget: keep the diff handed to the reviewer model inside its
 * input limit.
 *
 * A PR that ships generated output (bundles, lockfiles) or large data
 * fixtures can produce a multi-megabyte diff. Reviewer CLIs reject that
 * outright (codex caps input at 1,048,576 characters), and the review then
 * fails as `review-tool-error` on every retry, because retrying cannot shrink
 * the diff. This module drops generated files unconditionally, then drops the
 * largest remaining files until the diff fits the budget, and prepends a note
 * naming every omitted file so the reviewer neither flags them as missing nor
 * guesses at their contents.
 *
 * Only the diff text given to the model is compacted. Callers keep using the
 * full changed-file list for scope checks and metadata.
 */

import { execFileSync } from 'node:child_process';

/** Default character budget for the diff portion of the review prompt. */
export const DEFAULT_REVIEW_DIFF_MAX_CHARS = 400_000;

/** Omitted files listed individually in the note before collapsing to a count. */
const MAX_LISTED_OMISSIONS = 200;

const GENERATED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(dist|build)\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|go\.sum)$/,
];

export type ReviewDiffOmissionReason = 'generated' | 'size-budget';

export interface ReviewDiffOmission {
  path: string;
  reason: ReviewDiffOmissionReason;
  chars: number;
  additions: number;
  deletions: number;
}

export interface CompactReviewDiffResult {
  /** Diff to hand to the reviewer, prefixed with an omission note when anything was dropped. */
  diff: string;
  omitted: ReviewDiffOmission[];
  originalChars: number;
  keptChars: number;
}

export interface CompactReviewDiffOptions {
  /** Character budget for the kept file sections (default: env or {@link DEFAULT_REVIEW_DIFF_MAX_CHARS}). */
  maxChars?: number;
  /** Extra paths to treat as generated, e.g. from `.gitattributes` linguist-generated. */
  generatedPaths?: ReadonlySet<string>;
}

interface DiffFileSection {
  path: string;
  text: string;
  additions: number;
  deletions: number;
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
 * Compact a unified git diff for review. Returns the input unchanged (with an
 * empty `omitted` list) when nothing is generated and it already fits.
 */
export function compactReviewDiff(
  diff: string,
  options: CompactReviewDiffOptions = {},
): CompactReviewDiffResult {
  const maxChars = options.maxChars ?? resolveReviewDiffMaxChars();
  const { preamble, sections } = splitDiffByFile(diff);
  const omitted: ReviewDiffOmission[] = [];
  const omit = (section: DiffFileSection, reason: ReviewDiffOmissionReason) => {
    omitted.push({
      path: section.path,
      reason,
      chars: section.text.length,
      additions: section.additions,
      deletions: section.deletions,
    });
  };

  let kept: DiffFileSection[] = [];
  for (const section of sections) {
    if (isGeneratedReviewPath(section.path) || options.generatedPaths?.has(section.path)) {
      omit(section, 'generated');
    } else {
      kept.push(section);
    }
  }

  let keptChars = preamble.length + kept.reduce((sum, section) => sum + section.text.length, 0);
  if (keptChars > maxChars) {
    // Drop the largest files first so as many files as possible stay reviewable.
    const bySizeDesc = [...kept].sort((a, b) => b.text.length - a.text.length);
    const dropped = new Set<DiffFileSection>();
    for (const section of bySizeDesc) {
      if (keptChars <= maxChars) break;
      dropped.add(section);
      keptChars -= section.text.length;
      omit(section, 'size-budget');
    }
    kept = kept.filter((section) => !dropped.has(section));
  }

  if (omitted.length === 0) {
    return { diff, omitted, originalChars: diff.length, keptChars: diff.length };
  }

  const body = preamble + kept.map((section) => section.text).join('');
  return {
    diff: formatOmissionNote(omitted, kept.length) + body,
    omitted,
    originalChars: diff.length,
    keptChars: body.length,
  };
}

/**
 * Paths among `paths` that `.gitattributes` marks `linguist-generated`.
 * Best-effort: any git failure yields an empty set.
 */
export function readLinguistGeneratedPaths(repoDir: string, paths: readonly string[]): Set<string> {
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

/** Changed file paths in a unified diff, in order. */
export function listDiffPaths(diff: string): string[] {
  return splitDiffByFile(diff).sections.map((section) => section.path);
}

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
    return { path: sectionPath(text), text, ...countChangedLines(text) };
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
  const lines = [
    `# Review diff note: ${omitted.length} changed file(s) were omitted from this diff to fit the reviewer's input budget; ${keptCount} file(s) follow in full.`,
    '# The omitted files are still part of this change. Do not report them as missing, and do not guess at their contents.',
  ];
  for (const entry of omitted.slice(0, MAX_LISTED_OMISSIONS)) {
    const reason = entry.reason === 'generated' ? 'generated output' : `too large, ${entry.chars} chars`;
    lines.push(`#   - ${entry.path} (${reason}; +${entry.additions}/-${entry.deletions} lines)`);
  }
  if (omitted.length > MAX_LISTED_OMISSIONS) {
    lines.push(`#   ... and ${omitted.length - MAX_LISTED_OMISSIONS} more`);
  }
  return `${lines.join('\n')}\n\n`;
}
