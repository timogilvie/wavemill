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
