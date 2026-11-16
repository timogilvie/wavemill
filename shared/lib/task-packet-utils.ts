/**
 * Task Packet Utilities
 *
 * Provides utilities for working with task packets - structured documents
 * that describe implementation tasks for AI agents.
 *
 * Supports both legacy (single-file) and progressive disclosure (header/details)
 * formats.
 *
 * @module task-packet-utils
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Result of splitting a task packet into header and details sections.
 */
export interface TaskPacketParts {
  /** Brief header (~50 lines) with objective, key files, top constraints */
  header: string;
  /** Full details with all 9 sections */
  details: string;
  /** Complete content (header + details) for backward compatibility */
  fullContent: string;
}

/** Required fields of the `## Release Readiness` section, in gate order (HOK-3499). */
export const RELEASE_READINESS_FIELDS = [
  'database_change_risk',
  'env_changes',
  'config_changes',
  'manual_steps',
] as const;

export type ReleaseReadinessField = (typeof RELEASE_READINESS_FIELDS)[number];

/**
 * Structured release-readiness metadata extracted from a task packet.
 * Used by the ready-stage engine to compare implementation against planning expectations.
 */
export interface ReleaseReadiness {
  /**
   * Whether the task is expected to involve database schema changes.
   * `undefined` when the plan omits the field — a missing declaration is
   * reported through {@link ParsedReleaseReadiness.missingFields}, never
   * invented as `none`.
   */
  databaseChangeRisk?: 'none' | 'possible' | 'required';
  /** Environment variables that must be added or changed for deployment */
  envChanges: string[];
  /** Configuration file changes required for deployment */
  configChanges: string[];
  /** Manual steps required before or after merge */
  manualSteps: string[];
}

/** The single parse of a `## Release Readiness` section (HOK-3499). */
export interface ParsedReleaseReadiness extends ReleaseReadiness {
  /** Required fields the section does not declare (or declares empty). */
  missingFields: ReleaseReadinessField[];
  /** Values as written, before enum/list normalization. For diagnostics. */
  rawFields: Partial<Record<ReleaseReadinessField, string>>;
}

export interface TaskPacketArtifactPaths {
  full: string;
  header: string;
  details: string;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Split a task packet into header and details sections.
 *
 * Uses the `<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->` marker to divide
 * the content. If no marker is found (legacy format), generates a simple
 * header from the objective and key files sections.
 *
 * @param text - Complete task packet content
 * @returns Object with header, details, and fullContent
 *
 * @example
 * ```typescript
 * const taskPacket = await fs.readFile('task-packet.md', 'utf-8');
 * const { header, details, fullContent } = splitTaskPacket(taskPacket);
 *
 * // Save header for quick loading
 * await fs.writeFile('task-packet-header.md', header);
 * await fs.writeFile('task-packet-details.md', details);
 * ```
 */
export function splitTaskPacket(text: string): TaskPacketParts {
  const splitMarker = '<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->';
  const splitIndex = text.indexOf(splitMarker);

  if (splitIndex === -1) {
    // No split marker found - treat entire content as details (backward compat)
    // Generate a simple header from the details
    const objectiveMatch = text.match(/##\s*1\.\s*Objective[\s\S]*?(?=##\s*2\.)/i);
    const keyFilesMatch = text.match(/###\s*Key Files[\s\S]*?(?=###|##)/i);

    const simpleHeader =
      `# Task Packet\n\n` +
      `## Objective\n\n${objectiveMatch ? objectiveMatch[0] : 'See details below'}\n\n` +
      `## Key Files\n\n${keyFilesMatch ? keyFilesMatch[0] : 'See details below'}\n\n` +
      `## Full Details\n\nComplete task packet with all sections available below.\n`;

    return {
      header: simpleHeader,
      details: text,
      fullContent: text,
    };
  }

  // Split at marker
  const header = text.substring(0, splitIndex).trim();
  const details = text.substring(splitIndex + splitMarker.length).trim();

  // Full content for Linear (header + details without marker)
  const fullContent = `${header}\n\n---\n\n${details}`;

  return { header, details, fullContent };
}

/**
 * Validate that output looks like a structured task packet.
 *
 * Checks for presence of expected section headers. This is a lightweight
 * validation to catch cases where the LLM generated conversational text
 * instead of structured markdown.
 *
 * @param text - Text to validate
 * @returns True if text contains expected task packet sections
 *
 * @example
 * ```typescript
 * const output = await callClaude(prompt);
 * if (!isValidTaskPacket(output)) {
 *   throw new Error('LLM output is not a valid task packet');
 * }
 * ```
 */
export function isValidTaskPacket(text: string): boolean {
  // Must contain at least one of the expected section headers
  return /##\s*(1\.|Objective|What|Technical Context|Success Criteria|Implementation)/i.test(
    text
  );
}

/**
 * Classify markdown content as a structured task packet vs raw issue text.
 *
 * Mirrors the shell `is_task_packet()` matcher so controller and TypeScript
 * utilities share the same detection behavior.
 */
export function isTaskPacketContent(text: string): boolean {
  return /(\#{2,}\s+(1\.|Objective|What|Technical Context|Success Criteria)|##\s+(Task Packet|Detailed Sections)|Quick Reference)/i.test(
    text
  );
}

/**
 * Check if a file path points to a task packet (by naming convention).
 *
 * Recognizes both legacy and progressive disclosure formats:
 * - task-packet.md, task-packet-header.md, task-packet-details.md
 * - Any file matching the task-packet*.md pattern
 *
 * @param filePath - File path to check
 * @returns True if file appears to be a task packet
 *
 * @example
 * ```typescript
 * isTaskPacketFile('features/foo/task-packet.md'); // true
 * isTaskPacketFile('features/foo/task-packet-header.md'); // true
 * isTaskPacketFile('features/foo/README.md'); // false
 * ```
 */
export function isTaskPacketFile(filePath: string): boolean {
  return /task-packet.*\.md$/.test(filePath);
}

/**
 * Derive the conventional task-packet artifact paths from the full packet path.
 */
export function getTaskPacketArtifactPaths(outputFile: string): TaskPacketArtifactPaths {
  const parsed = path.parse(outputFile);
  const ext = parsed.ext || '.md';
  const basePath = path.join(parsed.dir, parsed.name);

  return {
    full: outputFile,
    header: `${basePath}-header${ext}`,
    details: `${basePath}-details${ext}`,
  };
}

/**
 * Persist task packet artifacts and ensure the parent directory exists.
 */
export async function writeTaskPacketArtifacts(
  outputFile: string,
  parts: TaskPacketParts
): Promise<TaskPacketArtifactPaths> {
  const paths = getTaskPacketArtifactPaths(outputFile);

  await fs.mkdir(path.dirname(paths.full), { recursive: true });
  await fs.writeFile(paths.header, parts.header, 'utf-8');
  await fs.writeFile(paths.details, parts.details, 'utf-8');
  await fs.writeFile(paths.full, parts.fullContent, 'utf-8');

  return paths;
}

// ────────────────────────────────────────────────────────────────
// Release Readiness Extraction
// ────────────────────────────────────────────────────────────────

const VALID_DB_RISK_VALUES = ['none', 'possible', 'required'] as const;

/**
 * The one Release Readiness grammar (HOK-3499). The planning gate, the
 * task-packet validator and the ready-stage consumer all parse through
 * {@link extractReleaseReadiness}; `tools/check-release-readiness-grammar.ts`
 * fails preflight on a second one.
 *
 * Heading: `##`/`###`, an optional numeric prefix, and an optional suffix
 * after `Release Readiness` (`## Release Readiness (v2)`).
 *
 * Field bullet: optional `-`/`*` marker, bold name with the colon either
 * inside or outside the bold (`**field**: value` and `**field:** value`).
 */
const RELEASE_READINESS_HEADING = /^#{2,3}\s+(?:\d+\.\s*)?Release Readiness\b/im;
const RELEASE_READINESS_FIELD =
  /^[ \t]*(?:[-*][ \t]+)?\*\*[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*:?[ \t]*\*\*[ \t]*:?[ \t]*(.*)$/gm;

/** Blank out fenced code blocks while preserving line breaks and indices. */
function maskFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '));
}

/**
 * Parse a comma-separated list field value into an array of trimmed strings.
 * Returns an empty array for `none`, an empty value, or a value whose first
 * word is `none` (plans often annotate it: `none (no env var remains)`).
 */
function parseListField(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (/^none\b/i.test(trimmed)) return [];
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Extract structured release-readiness metadata from a task packet.
 *
 * This is the only Release Readiness parser: the planning gate
 * (`validateFinalPlanningArtifact`), the task-packet validator
 * (`validateReleaseReadiness`) and the ready-stage consumer all read the
 * section through it, so a plan the gate accepts is always a plan the
 * consumer can parse.
 *
 * Accepts both bold spellings (`**field**:` and `**field:**`), an optional
 * `-`/`*` bullet marker, and a `(v2)`-style heading suffix.
 *
 * Returns `null` if the section is not present (backward compatibility with
 * existing task packets). When the section is present, fields it does not
 * declare are listed in `missingFields`; a missing `database_change_risk`
 * stays `undefined` rather than being invented as `none`.
 *
 * @param markdown - Task packet markdown content
 * @returns Parsed release readiness metadata and missing fields, or null
 *
 * @example
 * ```typescript
 * const readiness = extractReleaseReadiness(taskPacketMarkdown);
 * if (readiness) {
 *   console.log(readiness.databaseChangeRisk); // 'none' | 'possible' | 'required' | undefined
 *   console.log(readiness.envChanges);          // ['NEW_API_KEY', 'FEATURE_FLAG_X']
 *   console.log(readiness.missingFields);       // [] when every required field is present
 * }
 * ```
 */
export function extractReleaseReadiness(markdown: string): ParsedReleaseReadiness | null {
  const masked = maskFencedCode(markdown);
  const heading = RELEASE_READINESS_HEADING.exec(masked);
  if (!heading || heading.index === undefined) {
    return null;
  }

  // Section runs to the next `##` heading; masked code fences cannot end it.
  const sectionStart = heading.index + heading[0].length;
  const rest = masked.substring(sectionStart);
  const nextHeading = /^##\s+\S/m.exec(rest);
  const sectionEnd = nextHeading && nextHeading.index !== undefined
    ? sectionStart + nextHeading.index
    : markdown.length;
  const sectionContent = markdown.substring(sectionStart, sectionEnd);

  const rawFields: Partial<Record<ReleaseReadinessField, string>> = {};
  RELEASE_READINESS_FIELD.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RELEASE_READINESS_FIELD.exec(sectionContent)) !== null) {
    const name = match[1].toLowerCase() as ReleaseReadinessField;
    if (!(RELEASE_READINESS_FIELDS as readonly string[]).includes(name)) continue;
    // First declaration wins; later duplicates are ignored.
    if (rawFields[name] === undefined) rawFields[name] = match[2].trim();
  }

  const missingFields = RELEASE_READINESS_FIELDS.filter(
    (field) => !rawFields[field],
  );

  // Take only the first word to match the enum; an unrecognized value stays
  // readable through `rawFields` for the validator's diagnostic.
  const rawDbRisk = rawFields.database_change_risk?.split(/\s/)[0];
  const databaseChangeRisk = rawDbRisk && (VALID_DB_RISK_VALUES as readonly string[]).includes(rawDbRisk)
    ? (rawDbRisk as ReleaseReadiness['databaseChangeRisk'])
    : rawDbRisk
      ? 'none'
      : undefined;

  return {
    ...(databaseChangeRisk ? { databaseChangeRisk } : {}),
    envChanges: parseListField(rawFields.env_changes),
    configChanges: parseListField(rawFields.config_changes),
    manualSteps: parseListField(rawFields.manual_steps),
    missingFields,
    rawFields,
  };
}
