/**
 * Permission Patterns - Centralized Read-Only Command Patterns
 *
 * This module defines safe, read-only command patterns that can be auto-approved
 * in agent workflows without user confirmation. Patterns use glob-style matching
 * for simplicity and readability.
 *
 * @module permission-patterns
 */

/**
 * Category of read-only command patterns
 */
export interface PatternCategory {
  /** Category name */
  name: string;
  /** Description of this category */
  description: string;
  /** List of command patterns in this category */
  patterns: string[];
}

/**
 * File system read operations - safe commands for reading file system information
 */
export const FILE_SYSTEM_READ: PatternCategory = {
  name: 'File System Read',
  description: 'Commands that read file system information without modification',
  patterns: [
    'find *',
    'ls *',
    'cat *',
    'head *',
    'tail *',
    'wc *',
    'file *',
    'stat *',
    'du *',
    'tree *',
    'pwd',
    'realpath *',
    'readlink *',
    'basename *',
    'dirname *',
  ],
};

/**
 * Git read operations - safe git commands that only read repository state
 */
export const GIT_READ: PatternCategory = {
  name: 'Git Read',
  description: 'Git commands that read repository state without making changes',
  patterns: [
    'git status*',
    'git log*',
    'git show*',
    'git diff*',
    'git branch --list*',
    'git branch -l*',
    'git branch --all*',
    'git branch -a*',
    'git remote*',
    'git config --list*',
    'git config --get*',
    'git config -l*',
    'git worktree list*',
    'git rev-parse*',
    'git describe*',
    'git tag --list*',
    'git tag -l*',
    'git ls-files*',
    'git ls-tree*',
    'git blame*',
    'git reflog*',
    'git shortlog*',
  ],
};

/**
 * GitHub CLI read operations - gh commands that only fetch data
 */
export const GITHUB_CLI_READ: PatternCategory = {
  name: 'GitHub CLI Read',
  description: 'GitHub CLI commands that fetch data without making changes',
  patterns: [
    'gh pr view*',
    'gh pr list*',
    'gh pr status*',
    'gh pr checks*',
    'gh pr diff*',
    'gh issue view*',
    'gh issue list*',
    'gh issue status*',
    'gh repo view*',
    'gh repo list*',
    'gh release view*',
    'gh release list*',
    'gh run view*',
    'gh run list*',
    'gh workflow view*',
    'gh workflow list*',
    'gh api repos/*/pulls/*',
    'gh api repos/*/issues/*',
  ],
};

/**
 * Process and system read operations - commands for system information
 */
export const PROCESS_SYSTEM_READ: PatternCategory = {
  name: 'Process & System Read',
  description: 'Commands that read process and system information',
  patterns: [
    'ps *',
    'top -l 1*',
    'which *',
    'whereis *',
    'env',
    'printenv*',
    'echo *',
    'date*',
    'uptime*',
    'hostname*',
    'uname*',
    'whoami',
  ],
};

/**
 * Package manager read operations - npm, pnpm, yarn read commands
 */
export const PACKAGE_MANAGER_READ: PatternCategory = {
  name: 'Package Manager Read',
  description: 'Package manager commands that read dependency information',
  patterns: [
    'npm list*',
    'npm ls*',
    'npm outdated*',
    'npm view*',
    'npm show*',
    'npm info*',
    'npm search*',
    'pnpm list*',
    'pnpm ls*',
    'pnpm outdated*',
    'yarn list*',
    'yarn info*',
    'yarn why*',
    'bun pm ls*',
  ],
};

/**
 * Text search operations - grep, ripgrep, ag, ack
 */
export const TEXT_SEARCH: PatternCategory = {
  name: 'Text Search',
  description: 'Commands that search through text files',
  patterns: [
    'grep *',
    'rg *',
    'ag *',
    'ack *',
    'fgrep *',
    'egrep *',
  ],
};

/**
 * All default read-only pattern categories
 */
export const DEFAULT_CATEGORIES: PatternCategory[] = [
  FILE_SYSTEM_READ,
  GIT_READ,
  GITHUB_CLI_READ,
  PROCESS_SYSTEM_READ,
  PACKAGE_MANAGER_READ,
  TEXT_SEARCH,
];

/**
 * Get all default read-only patterns as a flat array
 */
export function getDefaultPatterns(): string[] {
  return DEFAULT_CATEGORIES.flatMap((category) => category.patterns);
}

/**
 * Check if a command matches a pattern using glob-style matching
 *
 * Pattern syntax:
 * - `*` matches any characters
 * - Patterns are case-sensitive
 * - Pattern must match from the start of the command
 *
 * @param command - The command to check
 * @param pattern - The pattern to match against
 * @returns true if command matches pattern
 *
 * @example
 * ```typescript
 * matchesPattern('git status', 'git status*') // true
 * matchesPattern('git status --short', 'git status*') // true
 * matchesPattern('git commit', 'git status*') // false
 * ```
 */
export function matchesPattern(command: string, pattern: string): boolean {
  // Escape special regex characters except *
  const escapedPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  // Pattern must match from start of command
  const regex = new RegExp(`^${escapedPattern}$`);
  return regex.test(command);
}

/**
 * Check if a command matches any pattern in a list
 *
 * @param command - The command to check
 * @param patterns - List of patterns to match against
 * @returns true if command matches at least one pattern
 *
 * @example
 * ```typescript
 * const patterns = ['git status*', 'git log*'];
 * matchesAnyPattern('git status --short', patterns) // true
 * matchesAnyPattern('git commit', patterns) // false
 * ```
 */
export function matchesAnyPattern(command: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(command, pattern));
}

/**
 * Validate that a pattern is safe (doesn't match destructive commands)
 *
 * This is a safety check to prevent accidental auto-approval of destructive
 * commands. It checks against a list of known dangerous command prefixes.
 *
 * @param pattern - The pattern to validate
 * @returns true if pattern is safe, false if potentially dangerous
 *
 * @example
 * ```typescript
 * isSafePattern('git status*') // true
 * isSafePattern('rm *') // false
 * isSafePattern('git push*') // false
 * ```
 */
export function isSafePattern(pattern: string): boolean {
  const dangerousPatterns = [
    'rm *',
    'rmdir *',
    'delete *',
    'del *',
    'git push*',
    'git commit*',
    'git reset*',
    'git rebase*',
    'git merge*',
    'git cherry-pick*',
    'git clean*',
    'git branch -d*',
    'git branch -D*',
    'git branch -m*',
    'git branch -M*',
    'git worktree remove*',
    'git worktree prune*',
    'gh pr create*',
    'gh pr merge*',
    'gh pr close*',
    'gh issue create*',
    'gh issue close*',
    'npm install*',
    'npm uninstall*',
    'npm publish*',
    'yarn add*',
    'yarn remove*',
    'pnpm add*',
    'pnpm remove*',
    'chmod *',
    'chown *',
    'sudo *',
    'kill *',
    'pkill *',
  ];

  // Check if pattern starts with any dangerous pattern
  const normalizedPattern = pattern.toLowerCase().trim();
  return !dangerousPatterns.some((dangerous) => {
    const normalizedDangerous = dangerous.toLowerCase().trim();
    return normalizedPattern.startsWith(normalizedDangerous.replace('*', ''));
  });
}

/**
 * Get patterns for a specific category by name
 *
 * @param categoryName - The category name to get patterns for
 * @returns Array of patterns for that category, or empty array if not found
 */
export function getPatternsByCategory(categoryName: string): string[] {
  const category = DEFAULT_CATEGORIES.find((c) => c.name === categoryName);
  return category ? category.patterns : [];
}

/**
 * Get all category names
 */
export function getCategoryNames(): string[] {
  return DEFAULT_CATEGORIES.map((c) => c.name);
}
