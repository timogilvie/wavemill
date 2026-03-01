/**
 * Subsystem specification updater.
 *
 * Updates subsystem specs after PR merge based on diff analysis.
 * Detects affected subsystems and generates targeted updates.
 *
 * @module subsystem-updater
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callClaude } from './llm-cli.ts';
import type { Subsystem } from './subsystem-detector.ts';
import { detectAffectedSubsystems } from './subsystem-mapper.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface SubsystemUpdateContext {
  /** Issue ID (e.g., HOK-123) */
  issueId: string;
  /** Issue title */
  issueTitle: string;
  /** PR URL */
  prUrl: string;
  /** PR diff (full) */
  prDiff: string;
  /** Issue description */
  issueDescription: string;
  /** Repository directory */
  repoDir: string;
}

// ────────────────────────────────────────────────────────────────
// Update Functions
// ────────────────────────────────────────────────────────────────

/**
 * Update subsystem specs affected by a PR.
 *
 * Detects which subsystems were modified, then updates their specs.
 */
export async function updateAffectedSubsystems(
  subsystems: Subsystem[],
  context: SubsystemUpdateContext
): Promise<void> {
  const { prDiff, repoDir } = context;

  // Detect affected subsystems
  const affected = detectAffectedSubsystems(prDiff, subsystems, repoDir);

  if (affected.length === 0) {
    console.log('Subsystem update: No subsystems affected by this PR');
    return;
  }

  console.log(`Subsystem update: ${affected.length} subsystem(s) affected:`);
  affected.forEach(s => console.log(`  - ${s.name}`));

  // Update each affected subsystem
  for (const subsystem of affected) {
    try {
      await updateSubsystemSpec(subsystem, context);
      console.log(`Subsystem update: ✓ Updated ${subsystem.name}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Subsystem update: ⚠ Failed to update ${subsystem.name}: ${message}`);
    }
  }
}

/**
 * Update a single subsystem spec using LLM analysis.
 */
export async function updateSubsystemSpec(
  subsystem: Subsystem,
  context: SubsystemUpdateContext
): Promise<void> {
  const { issueId, issueTitle, prUrl, prDiff, issueDescription, repoDir } = context;

  // Load current spec
  const contextDir = join(repoDir, '.wavemill', 'context');
  const specPath = join(contextDir, `${subsystem.id}.md`);

  if (!existsSync(specPath)) {
    console.warn(`Subsystem spec not found: ${specPath}`);
    return;
  }

  const currentSpec = readFileSync(specPath, 'utf-8');

  // Filter diff to subsystem files only
  const filteredDiff = filterDiffToSubsystem(prDiff, subsystem);

  // Generate update using LLM
  const updatedSpec = await generateSubsystemUpdate({
    subsystem,
    currentSpec,
    issueId,
    issueTitle,
    prUrl,
    filteredDiff,
    issueDescription,
  });

  // Write updated spec
  writeFileSync(specPath, updatedSpec, 'utf-8');
}

/**
 * Generate subsystem update using Claude CLI.
 */
async function generateSubsystemUpdate(opts: {
  subsystem: Subsystem;
  currentSpec: string;
  issueId: string;
  issueTitle: string;
  prUrl: string;
  filteredDiff: string;
  issueDescription: string;
}): Promise<string> {
  const promptPath = join(dirname(dirname(__dirname)), 'tools', 'prompts', 'subsystem-update-template.md');
  const promptTemplate = readFileSync(promptPath, 'utf-8');

  // Fill in template
  const timestamp = new Date().toISOString();
  const prompt = promptTemplate
    .replace('{SUBSYSTEM_NAME}', opts.subsystem.name)
    .replace('{SUBSYSTEM_ID}', opts.subsystem.id)
    .replace('{ISSUE_ID}', opts.issueId)
    .replace('{ISSUE_TITLE}', opts.issueTitle)
    .replace('{PR_URL}', opts.prUrl)
    .replace('{CURRENT_SPEC}', opts.currentSpec)
    .replace('{PR_DIFF}', opts.filteredDiff.substring(0, 30000)) // Limit diff size
    .replace('{ISSUE_DESCRIPTION}', opts.issueDescription)
    .replace(/{TIMESTAMP}/g, timestamp);

  const claudeCmd = process.env.CLAUDE_CMD || 'claude';
  const result = await callClaude(prompt, {
    mode: 'stream',
    claudeCmd,
    cliFlags: [
      '--tools', '',
      '--append-system-prompt',
      'You have NO tools available. Output ONLY the updated subsystem spec markdown. No conversational text, no preamble, no XML tags. Start directly with the heading.',
    ],
  });

  return result.text;
}

/**
 * Filter PR diff to only include files from a specific subsystem.
 */
function filterDiffToSubsystem(prDiff: string, subsystem: Subsystem): string {
  const lines = prDiff.split('\n');
  const filtered: string[] = [];
  let inSubsystemFile = false;
  let currentFile = '';

  for (const line of lines) {
    // Check for diff header
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (diffMatch) {
      currentFile = diffMatch[2];
      inSubsystemFile = subsystem.keyFiles.some(f => currentFile.startsWith(f) || f.startsWith(currentFile));
    }

    if (inSubsystemFile || line.startsWith('@@')) {
      filtered.push(line);
    }
  }

  return filtered.join('\n');
}

/**
 * Check if a new subsystem should be created based on PR changes.
 *
 * Returns true if:
 * - PR creates files in a new directory not covered by existing subsystems
 * - Multiple related files are added together
 */
export function shouldCreateNewSubsystem(
  prDiff: string,
  existingSubsystems: Subsystem[]
): { shouldCreate: boolean; suggestedName?: string; files?: string[] } {
  // Extract added files
  const addedFiles: string[] = [];
  const lines = prDiff.split('\n');

  for (const line of lines) {
    const match = line.match(/^\+\+\+ b\/(.+?)$/);
    if (match && match[1] !== '/dev/null') {
      addedFiles.push(match[1]);
    }
  }

  // Need at least 3 new files to justify a new subsystem
  if (addedFiles.length < 3) {
    return { shouldCreate: false };
  }

  // Check if files are in a common new directory
  const commonPrefix = findCommonPrefix(addedFiles);
  if (!commonPrefix || commonPrefix.split('/').length < 2) {
    return { shouldCreate: false };
  }

  // Check if this directory is already covered by existing subsystems
  const isCovered = existingSubsystems.some(s =>
    s.keyFiles.some(f => f.startsWith(commonPrefix) || commonPrefix.startsWith(f))
  );

  if (isCovered) {
    return { shouldCreate: false };
  }

  // Suggest creating a new subsystem
  const suggestedName = commonPrefix.split('/').pop() || 'new-subsystem';

  return {
    shouldCreate: true,
    suggestedName,
    files: addedFiles,
  };
}

/**
 * Find common prefix of file paths.
 */
function findCommonPrefix(files: string[]): string {
  if (files.length === 0) return '';

  const parts = files[0].split('/');
  let prefix = parts[0];

  for (const file of files) {
    const fileParts = file.split('/');
    for (let i = 0; i < Math.min(parts.length, fileParts.length); i++) {
      if (parts[i] !== fileParts[i]) {
        prefix = parts.slice(0, i).join('/');
        break;
      }
    }
  }

  return prefix;
}
