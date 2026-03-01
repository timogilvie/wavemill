/**
 * Task Packet Validator
 *
 * Two-layer validation system for expanded task packets:
 * - Layer 1: Deterministic checks (file existence, structure)
 * - Layer 2: LLM critic (vague specs, contradictions)
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { callClaude, parseJsonFromLLM } from './llm-cli.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Types of validation issues that can be detected
 */
export type ValidationIssueType =
  | 'file-not-found'
  | 'boilerplate-validation'
  | 'empty-scope'
  | 'insufficient-criteria'
  | 'vague-spec'
  | 'contradiction'
  | 'missing-requirement'
  | 'assumption';

/**
 * Severity level of a validation issue
 */
export type ValidationSeverity = 'error' | 'warning';

/**
 * Individual validation issue found in a task packet
 */
export interface ValidationIssue {
  /** Type of issue */
  type: ValidationIssueType;
  /** Severity level */
  severity: ValidationSeverity;
  /** Section name where issue was found */
  section: string;
  /** Line number if applicable */
  line?: number;
  /** Human-readable description of the problem */
  description: string;
  /** Suggested fix (one sentence) */
  suggestedFix: string;
}

/**
 * Result of validating a task packet
 */
export interface ValidationResult {
  /** Whether the task packet passed validation */
  passed: boolean;
  /** List of issues found (empty if passed) */
  issues: ValidationIssue[];
  /** Layer 1 (deterministic) issues */
  layer1Issues: ValidationIssue[];
  /** Layer 2 (LLM) issues */
  layer2Issues: ValidationIssue[];
}

/**
 * Configuration for validation behavior
 */
export interface ValidationConfig {
  /** Whether validation is enabled */
  enabled: boolean;
  /** Layer 1 configuration */
  layer1: {
    enabled: boolean;
  };
  /** Layer 2 configuration */
  layer2: {
    enabled: boolean;
    model: string;
    provider: 'claude-cli' | 'anthropic';
  };
  /** Behavior on validation failure */
  onFailure: 'conservative' | 'auto-fix' | 'proceed';
}

/**
 * Default validation configuration
 */
export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  enabled: true,
  layer1: {
    enabled: true,
  },
  layer2: {
    enabled: true,
    model: 'claude-haiku-4-5-20251001',
    provider: 'claude-cli',
  },
  onFailure: 'conservative',
};

const TIMEOUT_MS = 30_000; // 30 seconds for Layer 2 LLM call

// ============================================================================
// LAYER 1: DETERMINISTIC VALIDATION
// ============================================================================

/**
 * Extract file paths from markdown sections
 * Looks for code blocks, bullet lists with paths, and inline code paths
 */
function extractFilePaths(markdown: string): string[] {
  const paths = new Set<string>();

  // Match paths in bullet lists: - `path/to/file.ts`
  const bulletRegex = /^[-*]\s+`([^`]+\.[a-z]{1,4})`/gm;
  let match;
  while ((match = bulletRegex.exec(markdown)) !== null) {
    paths.add(match[1]);
  }

  // Match paths in sentences: path/to/file.ts or `path/to/file.ts`
  const pathRegex = /(?:^|\s|`)([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-z]{1,4})(?:`|\s|$)/gm;
  while ((match = pathRegex.exec(markdown)) !== null) {
    const path = match[1];
    // Filter out URLs and overly generic patterns
    if (!path.startsWith('http') && !path.startsWith('//') && path.includes('/')) {
      paths.add(path);
    }
  }

  return Array.from(paths);
}

/**
 * Extract a markdown section by heading
 */
function extractSection(markdown: string, heading: string): string | null {
  // Match ## Heading or ### Heading (case insensitive)
  const headingRegex = new RegExp(`^#{2,3}\\s+${heading}\\s*$`, 'im');
  const match = markdown.match(headingRegex);

  if (!match || match.index === undefined) {
    return null;
  }

  const startIndex = match.index + match[0].length;

  // Find the next heading of same or higher level, but not inside code blocks
  const restOfDoc = markdown.substring(startIndex);

  // Remove code blocks before searching for next heading
  const withoutCodeBlocks = restOfDoc.replace(/```[\s\S]*?```/g, match => ' '.repeat(match.length));
  const nextHeadingMatch = withoutCodeBlocks.match(/^#{1,3}\s+\w/m);

  const endIndex = nextHeadingMatch && nextHeadingMatch.index !== undefined
    ? startIndex + nextHeadingMatch.index
    : markdown.length;

  return markdown.substring(startIndex, endIndex).trim();
}

/**
 * Count bullet points in a markdown section
 */
function countBulletPoints(markdown: string): number {
  const bullets = markdown.match(/^[-*]\s+/gm);
  return bullets ? bullets.length : 0;
}

/**
 * Count checkboxes in a markdown section
 */
function countCheckboxes(markdown: string): number {
  const checkboxes = markdown.match(/^[-*]\s+\[\s*[xX ]?\s*\]/gm);
  return checkboxes ? checkboxes.length : 0;
}

/**
 * Check if validation steps are just boilerplate
 */
function isBoilerplateValidation(validationSteps: string): boolean {
  // Extract commands from code blocks
  const codeBlockMatch = validationSteps.match(/```(?:bash|sh)?\s*\n([\s\S]*?)```/);
  if (!codeBlockMatch) {
    return true; // No code block at all
  }

  const commands = codeBlockMatch[1]
    .split('\n')
    .filter(line => !line.trim().startsWith('#')) // Ignore comments
    .filter(line => !line.trim().startsWith('//')) // Ignore JS comments
    .filter(line => line.trim().length > 0)
    .map(line => line.trim());

  // If there are no executable commands after filtering, it's boilerplate
  if (commands.length === 0) {
    return true;
  }

  // Check if ALL commands are boilerplate (not just some)
  const boilerplateCommands = ['pnpm lint', 'pnpm test', 'pnpm build', 'npm run lint', 'npm test', 'npm run build'];
  const allBoilerplate = commands.every(cmd => {
    return boilerplateCommands.some(bp => cmd === bp || cmd.startsWith(bp));
  });

  return allBoilerplate;
}

/**
 * Layer 1: File existence validation
 */
export function validateFileExistence(taskPacket: string, repoPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check "Key Files" section
  const keyFilesSection = extractSection(taskPacket, 'Key Files');
  if (keyFilesSection) {
    const filePaths = extractFilePaths(keyFilesSection);

    for (const filePath of filePaths) {
      const fullPath = resolve(repoPath, filePath);
      if (!existsSync(fullPath)) {
        issues.push({
          type: 'file-not-found',
          severity: 'error',
          section: 'Key Files',
          description: `File does not exist: ${filePath}`,
          suggestedFix: `Verify the file path or remove from Key Files if not needed`,
        });
      }
    }
  }

  // Check "Files to Modify" section (alternative naming)
  const filesToModifySection = extractSection(taskPacket, 'Files to Modify');
  if (filesToModifySection) {
    const filePaths = extractFilePaths(filesToModifySection);

    for (const filePath of filePaths) {
      const fullPath = resolve(repoPath, filePath);
      if (!existsSync(fullPath)) {
        issues.push({
          type: 'file-not-found',
          severity: 'warning', // Warning because these files might be created
          section: 'Files to Modify',
          description: `File does not exist: ${filePath}`,
          suggestedFix: `If this is a new file, move to "Files to Create" section`,
        });
      }
    }
  }

  return issues;
}

/**
 * Layer 1: Validation steps boilerplate check
 */
export function validateValidationSteps(taskPacket: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const validationSection = extractSection(taskPacket, 'Validation Steps');
  if (!validationSection) {
    issues.push({
      type: 'boilerplate-validation',
      severity: 'error',
      section: 'Validation Steps',
      description: 'Validation Steps section is missing',
      suggestedFix: 'Add specific validation steps for this feature',
    });
    return issues;
  }

  if (isBoilerplateValidation(validationSection)) {
    issues.push({
      type: 'boilerplate-validation',
      severity: 'warning',
      section: 'Validation Steps',
      description: 'Validation steps contain only generic lint/test/build commands',
      suggestedFix: 'Add feature-specific validation steps (e.g., curl commands, specific test assertions)',
    });
  }

  return issues;
}

/**
 * Layer 1: Scope boundaries validation
 */
export function validateScopeBoundaries(taskPacket: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const scopeInSection = extractSection(taskPacket, 'Scope In');
  const scopeOutSection = extractSection(taskPacket, 'Scope Out');

  if (!scopeInSection) {
    issues.push({
      type: 'empty-scope',
      severity: 'error',
      section: 'Scope In',
      description: 'Scope In section is missing',
      suggestedFix: 'Add at least 2 bullet points defining what is in scope',
    });
  } else {
    const scopeInCount = countBulletPoints(scopeInSection);
    if (scopeInCount < 2) {
      issues.push({
        type: 'empty-scope',
        severity: 'error',
        section: 'Scope In',
        description: `Only ${scopeInCount} item(s) in Scope In (need at least 2)`,
        suggestedFix: 'Add more specific items defining what is included in this task',
      });
    }
  }

  if (!scopeOutSection) {
    issues.push({
      type: 'empty-scope',
      severity: 'error',
      section: 'Scope Out',
      description: 'Scope Out section is missing',
      suggestedFix: 'Add at least 2 bullet points defining what is explicitly excluded',
    });
  } else {
    const scopeOutCount = countBulletPoints(scopeOutSection);
    if (scopeOutCount < 2) {
      issues.push({
        type: 'empty-scope',
        severity: 'error',
        section: 'Scope Out',
        description: `Only ${scopeOutCount} item(s) in Scope Out (need at least 2)`,
        suggestedFix: 'Add more items to prevent scope creep (what will NOT be done)',
      });
    }
  }

  return issues;
}

/**
 * Layer 1: Acceptance criteria count validation
 */
export function validateAcceptanceCriteria(taskPacket: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const functionalReqSection = extractSection(taskPacket, 'Functional Requirements');

  if (!functionalReqSection) {
    issues.push({
      type: 'insufficient-criteria',
      severity: 'error',
      section: 'Functional Requirements',
      description: 'Functional Requirements section is missing',
      suggestedFix: 'Add at least 3 specific, testable acceptance criteria',
    });
    return issues;
  }

  const criteriaCount = countCheckboxes(functionalReqSection);

  if (criteriaCount < 3) {
    issues.push({
      type: 'insufficient-criteria',
      severity: 'warning',
      section: 'Functional Requirements',
      description: `Only ${criteriaCount} acceptance criteria found (recommended: at least 3)`,
      suggestedFix: 'Add more specific, measurable requirements to reduce ambiguity',
    });
  }

  return issues;
}

/**
 * Run all Layer 1 validations
 */
export function runLayer1Validation(taskPacket: string, repoPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  issues.push(...validateFileExistence(taskPacket, repoPath));
  issues.push(...validateValidationSteps(taskPacket));
  issues.push(...validateScopeBoundaries(taskPacket));
  issues.push(...validateAcceptanceCriteria(taskPacket));

  return issues;
}

// ============================================================================
// LAYER 2: LLM-BASED VALIDATION
// ============================================================================

/**
 * LLM review response structure
 */
interface LLMReviewResponse {
  status: 'PASS' | 'FAIL';
  issues: Array<{
    section: string;
    problemType: 'vague' | 'contradiction' | 'missing' | 'assumption' | 'edge-case';
    description: string;
    suggestedFix: string;
  }>;
}

/**
 * Call Claude CLI with a prompt
 */
async function callClaudeCLI(prompt: string, model: string): Promise<string> {
  const result = await callClaude(prompt, {
    mode: 'sync',
    model,
    timeout: TIMEOUT_MS, // 30000
    maxBuffer: 5 * 1024 * 1024,
  });

  if (!result.text) {
    throw new Error('Empty response from Claude CLI');
  }

  return result.text;
}

/**
 * Parse LLM review response
 */
function parseLLMReviewResponse(raw: string): LLMReviewResponse {
  const parsed = parseJsonFromLLM<LLMReviewResponse>(raw);

  if (!parsed.status || !['PASS', 'FAIL'].includes(parsed.status)) {
    throw new Error(`Invalid status: ${parsed.status}. Must be PASS or FAIL.`);
  }

  if (!Array.isArray(parsed.issues)) {
    parsed.issues = [];
  }

  return parsed;
}

/**
 * Map LLM issue type to ValidationIssueType
 */
function mapLLMIssueType(llmType: string): ValidationIssueType {
  const mapping: Record<string, ValidationIssueType> = {
    vague: 'vague-spec',
    contradiction: 'contradiction',
    missing: 'missing-requirement',
    assumption: 'assumption',
    'edge-case': 'missing-requirement',
  };

  return mapping[llmType] || 'vague-spec';
}

/**
 * Layer 2: LLM-based validation
 */
export async function runLayer2Validation(
  taskPacket: string,
  config: ValidationConfig
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  // Load reviewer prompt template
  const templatePath = resolve(__dirname, '../../tools/prompts/task-packet-reviewer.md');
  let template: string;
  try {
    template = await readFile(templatePath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to load task-packet-reviewer.md: ${error}`);
  }

  // Build prompt
  const prompt = template.replace('{{TASK_PACKET}}', taskPacket);

  // Call LLM
  let response: string;
  try {
    response = await callClaudeCLI(prompt, config.layer2.model);
  } catch (error) {
    throw new Error(`LLM validation failed: ${error}`);
  }

  // Parse response
  let reviewResult: LLMReviewResponse;
  try {
    reviewResult = parseLLMReviewResponse(response);
  } catch (error) {
    throw new Error(`Failed to parse LLM response: ${error}. Response: ${response.substring(0, 200)}`);
  }

  // Convert LLM issues to ValidationIssue format
  if (reviewResult.status === 'FAIL') {
    for (const llmIssue of reviewResult.issues) {
      issues.push({
        type: mapLLMIssueType(llmIssue.problemType),
        severity: 'warning', // LLM issues are warnings, not errors
        section: llmIssue.section,
        description: llmIssue.description,
        suggestedFix: llmIssue.suggestedFix,
      });
    }
  }

  return issues;
}

// ============================================================================
// MAIN VALIDATION ORCHESTRATION
// ============================================================================

/**
 * Run full validation on a task packet
 */
export async function validateTaskPacket(
  taskPacket: string,
  repoPath: string,
  config: ValidationConfig = DEFAULT_VALIDATION_CONFIG
): Promise<ValidationResult> {
  const layer1Issues: ValidationIssue[] = [];
  const layer2Issues: ValidationIssue[] = [];

  // Run Layer 1 if enabled
  if (config.enabled && config.layer1.enabled) {
    layer1Issues.push(...runLayer1Validation(taskPacket, repoPath));
  }

  // Run Layer 2 if enabled and Layer 1 didn't find blocking errors
  if (config.enabled && config.layer2.enabled) {
    const hasBlockingErrors = layer1Issues.some(issue => issue.severity === 'error');
    if (!hasBlockingErrors) {
      try {
        layer2Issues.push(...(await runLayer2Validation(taskPacket, config)));
      } catch (error) {
        // Layer 2 failure is non-blocking — just log it
        console.warn(`Layer 2 validation failed: ${error}`);
      }
    }
  }

  const allIssues = [...layer1Issues, ...layer2Issues];

  // Validation passes if there are no error-level issues
  const passed = !allIssues.some(issue => issue.severity === 'error');

  return {
    passed,
    issues: allIssues,
    layer1Issues,
    layer2Issues,
  };
}
