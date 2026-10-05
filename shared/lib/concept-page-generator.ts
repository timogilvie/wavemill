/**
 * Concept page generator.
 *
 * Generates concept pages via LLM using the concept-page-template.md prompt.
 *
 * @module concept-page-generator
 */

import { loadPromptTemplate } from './prompt-utils.ts';
import { callClaude } from './llm-cli.ts';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConceptsDir } from './context-tool.ts';
import { resolveWavemillPromptPath } from './native-agent/install-paths.ts';

export interface ConceptGenerationOptions {
  /** Concept ID (kebab-case) */
  conceptId: string;
  /** Human-readable concept name (optional, defaults to conceptId) */
  conceptName?: string;
  /** Repository directory */
  repoDir: string;
  /** Subsystem specs to include as context (optional) */
  subsystemIds?: string[];
  /** Whether to include project-context.md (default: true) */
  includeProjectContext?: boolean;
  /** Force overwrite existing concept (default: false) */
  force?: boolean;
}

/**
 * Generate a concept page via LLM.
 */
export async function generateConceptPage(
  options: ConceptGenerationOptions
): Promise<{ conceptPath: string; content: string }> {
  const {
    conceptId,
    conceptName = conceptId.replace(/-/g, ' '),
    repoDir,
    subsystemIds = [],
    includeProjectContext = true,
    force = false,
  } = options;

  // Check if concept already exists
  const conceptsDir = getConceptsDir(repoDir);
  const conceptPath = join(conceptsDir, `${conceptId}.md`);

  if (!force && existsSync(conceptPath)) {
    throw new Error(
      `Concept page already exists: ${conceptPath}\nUse --force to overwrite`
    );
  }

  // Ensure concepts directory exists
  mkdirSync(conceptsDir, { recursive: true });

  // Load prompt template
  const template = await loadPromptTemplate(resolveWavemillPromptPath('concept-page-template.md'));

  // Gather context
  let subsystemContext = '';
  if (subsystemIds.length > 0) {
    subsystemContext = subsystemIds
      .map(id => {
        const specPath = join(repoDir, '.wavemill', 'context', `${id}.md`);
        if (!existsSync(specPath)) {
          console.warn(`Warning: Subsystem spec not found: ${specPath}`);
          return '';
        }
        const content = readFileSync(specPath, 'utf-8');
        return `### Subsystem: ${id}\n\n${content}\n`;
      })
      .filter(Boolean)
      .join('\n---\n\n');
  }

  let projectContext = '';
  if (includeProjectContext) {
    const projectContextPath = join(repoDir, '.wavemill', 'project-context.md');
    if (existsSync(projectContextPath)) {
      projectContext = readFileSync(projectContextPath, 'utf-8');
    }
  }

  let existingContent = '';
  if (existsSync(conceptPath)) {
    existingContent = readFileSync(conceptPath, 'utf-8');
  }

  // Fill template
  const filledTemplate = template
    .replace(/\{\{CONCEPT_ID\}\}/g, conceptId)
    .replace(/\{\{CONCEPT_NAME\}\}/g, conceptName)
    .replace(/\{\{RELEVANT_SUBSYSTEMS\}\}/g, subsystemContext || 'None specified')
    .replace(/\{\{PROJECT_CONTEXT\}\}/g, projectContext || 'Not available')
    .replace(/\{\{EXISTING_CONTENT\}\}/g, existingContent || 'None (new concept)');

  // Call LLM
  console.log(`Generating concept page for "${conceptName}"...`);
  const result = await callClaude(filledTemplate, {
    model: 'claude-opus-4-6',
    taskType: 'planning',
  });
  const content = result.text;

  // Write output
  writeFileSync(conceptPath, content, 'utf-8');
  console.log(`✓ Concept page written to: ${conceptPath}`);

  return { conceptPath, content };
}
