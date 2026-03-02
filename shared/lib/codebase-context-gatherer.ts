/**
 * Codebase Context Gatherer
 *
 * Gathers contextual information about a codebase to help LLMs understand:
 * - Directory structure
 * - Key conventions and patterns (from project-context.md)
 * - Recent git activity
 * - Files relevant to a specific issue
 * - Subsystem specifications
 *
 * Used primarily by issue expansion (expand-issue.ts) to give AI agents
 * the necessary context to write comprehensive task packets.
 *
 * @module codebase-context-gatherer
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { findRelevantSubsystems, type SubsystemSearchResult } from './subsystem-search.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Options for gathering codebase context.
 */
export interface CodebaseContextOptions {
  /** Path to repository root */
  repoPath: string;
  /** Issue title (used for keyword search) */
  issueTitle: string;
  /** Issue description (optional, used for subsystem search) */
  issueDescription?: string;
  /** Maximum depth for directory tree traversal (default: 3) */
  maxTreeDepth?: number;
  /** Maximum lines to read from key files (default: 1000) */
  keyFilesMaxLines?: number;
  /** Number of recent git commits to include (default: 20) */
  gitActivityLimit?: number;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Gather comprehensive codebase context for an issue.
 *
 * Orchestrates collection of:
 * 1. Directory structure (limited depth)
 * 2. Key files and conventions (project-context.md, CLAUDE.md)
 * 3. Subsystem specifications (relevant to issue)
 * 4. Recent git activity
 * 5. Files matching issue keywords
 *
 * All gathering operations run in parallel for performance.
 *
 * @param options - Gathering options
 * @returns Formatted markdown context
 *
 * @example
 * ```typescript
 * const context = await gatherCodebaseContext({
 *   repoPath: '/path/to/repo',
 *   issueTitle: 'Add authentication to dashboard',
 *   issueDescription: 'Implement JWT auth...',
 * });
 * // Returns markdown with directory tree, key files, subsystems, etc.
 * ```
 */
export async function gatherCodebaseContext(
  options: CodebaseContextOptions
): Promise<string> {
  const {
    repoPath,
    issueTitle,
    issueDescription = '',
    maxTreeDepth = 3,
    keyFilesMaxLines = 1000,
    gitActivityLimit = 20,
  } = options;

  console.log('Gathering codebase context...');

  const [dirTree, keyFiles, gitActivity, relevantFiles, subsystemContext] =
    await Promise.all([
      getDirectoryTree(repoPath, maxTreeDepth),
      getKeyFilesReference(repoPath, keyFilesMaxLines),
      Promise.resolve(getRecentGitActivity(repoPath, gitActivityLimit)),
      findRelevantFiles(repoPath, issueTitle),
      gatherSubsystemContext(repoPath, issueDescription, issueTitle),
    ]);

  return `
# Codebase Context

## Directory Structure
\`\`\`
${dirTree}
\`\`\`

## Key Files & Conventions
${keyFiles}

${subsystemContext}

## Recent Git Activity
\`\`\`
${gitActivity}
\`\`\`

## Relevant Files (keyword search)
${relevantFiles}
`.trim();
}

/**
 * Get directory tree with configurable depth limit.
 *
 * Uses `find` to traverse directories, excluding common noise
 * (node_modules, .git, dist, build).
 *
 * @param repoPath - Repository root path
 * @param maxDepth - Maximum depth to traverse (default: 3)
 * @returns Directory tree as string
 *
 * @example
 * ```typescript
 * const tree = await getDirectoryTree('/path/to/repo', 2);
 * // Returns:
 * // .
 * // ./src
 * // ./src/components
 * // ./tests
 * ```
 */
export async function getDirectoryTree(
  repoPath: string,
  maxDepth: number = 3
): Promise<string> {
  try {
    // Use find with depth limit, exclude common noise
    const cmd = `cd "${repoPath}" && find . -type d -maxdepth ${maxDepth} \
      ! -path "*/node_modules/*" \
      ! -path "*/.git/*" \
      ! -path "*/dist/*" \
      ! -path "*/build/*" \
      | sort | head -100`;

    const result = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return result.trim() || '(No directories found)';
  } catch (error) {
    return '(Directory tree unavailable)';
  }
}

/**
 * Load key files reference (project-context.md, codebase-context.md, or CLAUDE.md).
 *
 * Searches for documentation files in priority order:
 * 1. .wavemill/project-context.md (full content, validated for size)
 * 2. .wavemill/codebase-context.md (limited to maxLines)
 * 3. CLAUDE.md (limited to maxLines)
 *
 * For project-context.md, warns if file exceeds 100KB (should archive old entries).
 *
 * @param repoPath - Repository root path
 * @param maxLines - Maximum lines to read (default: 1000, ignored for project-context.md)
 * @returns File content or fallback message
 *
 * @example
 * ```typescript
 * const keyFiles = await getKeyFilesReference('/path/to/repo');
 * // Returns: "Source: project-context.md\n\n[content...]"
 * ```
 */
export async function getKeyFilesReference(
  repoPath: string,
  maxLines: number = 1000
): Promise<string> {
  const candidates = [
    {
      path: path.join(repoPath, '.wavemill', 'project-context.md'),
      maxLines: Infinity,
    }, // Full content
    {
      path: path.join(repoPath, '.wavemill', 'codebase-context.md'),
      maxLines,
    },
    { path: path.join(repoPath, 'CLAUDE.md'), maxLines },
  ];

  for (const { path: filePath, maxLines: lineLimit } of candidates) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // Validate size for project-context.md
      if (filePath.includes('project-context.md')) {
        const sizeKB = Buffer.byteLength(content, 'utf-8') / 1024;
        if (sizeKB > 100) {
          console.warn(
            `⚠️  project-context.md is ${sizeKB.toFixed(0)}KB (>100KB limit)`
          );
          console.warn(
            '   Consider archiving old "Recent Work" entries to project-context-archive.md'
          );
          // Still proceed but warn
        } else if (sizeKB > 50) {
          console.warn(
            `⚠️  project-context.md is ${sizeKB.toFixed(0)}KB (approaching 100KB limit)`
          );
        }
      }

      // Extract relevant sections (full content for project-context, limited for others)
      const limitedLines =
        lineLimit === Infinity ? lines : lines.slice(0, lineLimit);
      return `Source: ${path.basename(filePath)}\n\n${limitedLines.join('\n')}`;
    } catch {
      continue;
    }
  }

  return '(No codebase context file found)';
}

/**
 * Get recent git activity to understand active areas.
 *
 * Uses `git log --oneline --name-only` to show recent commits and
 * files touched.
 *
 * @param repoPath - Repository root path
 * @param limit - Number of commits to include (default: 20)
 * @returns Git log output as string
 *
 * @example
 * ```typescript
 * const activity = getRecentGitActivity('/path/to/repo', 10);
 * // Returns:
 * // abc1234 Fix login bug
 * // src/auth/login.ts
 * // def5678 Add tests
 * // tests/auth.test.ts
 * ```
 */
export function getRecentGitActivity(
  repoPath: string,
  limit: number = 20
): string {
  try {
    const cmd = `cd "${repoPath}" && git log --oneline --name-only -${limit}`;
    const result = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return result.trim() || '(No recent commits found)';
  } catch (error) {
    return '(Git history unavailable)';
  }
}

/**
 * Find files matching keywords from issue title.
 *
 * Extracts meaningful keywords (excluding stop words like "add", "fix", "the"),
 * then greps for matches in TypeScript/JavaScript/Markdown files.
 *
 * @param repoPath - Repository root path
 * @param issueTitle - Issue title to extract keywords from
 * @returns Markdown-formatted search results
 *
 * @example
 * ```typescript
 * const files = await findRelevantFiles('/path/to/repo', 'Add authentication flow');
 * // Searches for "authentication" and "flow"
 * // Returns:
 * // Keyword: "authentication"
 * // ./src/auth/login.ts
 * // ./src/auth/signup.ts
 * ```
 */
export async function findRelevantFiles(
  repoPath: string,
  issueTitle: string
): Promise<string> {
  // Extract meaningful keywords (exclude common words)
  const stopWords = new Set([
    'add',
    'fix',
    'update',
    'the',
    'a',
    'an',
    'to',
    'for',
    'in',
    'on',
    'and',
    'or',
    'with',
  ]);
  const keywords = issueTitle
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 3 && !stopWords.has(word))
    .slice(0, 3); // Top 3 keywords

  if (keywords.length === 0) {
    return '(No relevant keywords found)';
  }

  const results: string[] = [];

  for (const keyword of keywords) {
    try {
      const cmd = `cd "${repoPath}" && grep -r --include="*.{ts,js,tsx,jsx,md}" -l "${keyword}" . 2>/dev/null \
        | grep -v node_modules \
        | grep -v .git \
        | head -10`;

      const output = execSync(cmd, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      if (output.trim()) {
        results.push(`Keyword: "${keyword}"\n${output.trim()}`);
      }
    } catch {
      // Grep returns non-zero if no matches, that's okay
    }
  }

  return results.length > 0
    ? results.join('\n\n')
    : '(No matching files found)';
}

/**
 * Gather subsystem context for an issue.
 *
 * Searches .wavemill/context/ directory for relevant subsystem specs
 * based on issue description and title. Uses hybrid search (keywords +
 * file path matching) from subsystem-search.ts.
 *
 * @param repoPath - Repository root path
 * @param issueDescription - Issue description text
 * @param issueTitle - Issue title
 * @returns Formatted subsystem context or knowledge gap warning
 *
 * @example
 * ```typescript
 * const context = await gatherSubsystemContext(
 *   '/path/to/repo',
 *   'Fix auth bug in login flow',
 *   'Login bug'
 * );
 * // Returns subsystem specs for auth-related subsystems
 * ```
 */
export async function gatherSubsystemContext(
  repoPath: string,
  issueDescription: string,
  issueTitle: string
): Promise<string> {
  const contextDir = path.join(repoPath, '.wavemill', 'context');

  // Skip if no subsystem specs exist
  if (!existsSync(contextDir)) {
    return '';
  }

  try {
    console.log('Searching for relevant subsystem specs...');

    const subsystems = findRelevantSubsystems(
      issueDescription,
      issueTitle,
      repoPath,
      { limit: 10, includeFullSpecs: false }
    );

    if (subsystems.length === 0) {
      console.log('⚠️  No relevant subsystem specs found (potential knowledge gap)\n');
      return formatKnowledgeGapWarning();
    }

    console.log(`✓ Found ${subsystems.length} relevant subsystem spec(s)\n`);
    return formatSubsystemContext(subsystems);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Subsystem search failed: ${message}`);
    return '';
  }
}

// ────────────────────────────────────────────────────────────────
// Internal Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Format subsystem context for inclusion in codebase context.
 * @internal
 */
function formatSubsystemContext(subsystems: SubsystemSearchResult[]): string {
  let context = '\n## Subsystem Specifications\n\n';
  context += 'The following subsystem specs are relevant to this issue:\n\n';

  for (const subsystem of subsystems.slice(0, 10)) {
    // Limit to 10 for token budget
    context += `### ${subsystem.subsystemName}\n\n`;
    context += `**Spec Path**: \`.wavemill/context/${subsystem.subsystemId}.md\`\n\n`;

    for (const section of subsystem.relevantSections) {
      context += `**${section.section}**:\n`;
      // Truncate long sections to stay within token budget
      const truncated = section.content.substring(0, 500);
      context += truncated;
      if (section.content.length > 500) context += '...';
      context += '\n\n';
    }

    context += '---\n\n';
  }

  return context;
}

/**
 * Format knowledge gap warning when no subsystem specs match.
 * @internal
 */
function formatKnowledgeGapWarning(): string {
  return `
## Subsystem Specifications

⚠️ **Knowledge Gap Detected**: No subsystem specs found for this issue.

This may indicate:
- A new subsystem is being introduced
- Existing subsystem specs are incomplete
- The issue description lacks file/pattern references

**Recommendation**: After implementing this issue, run:
\`\`\`bash
wavemill context init --force
\`\`\`

This will create or update subsystem specs, enabling "persistent downstream
acceleration" for future tasks (per Codified Context paper, Case Study 3).

---
`;
}
