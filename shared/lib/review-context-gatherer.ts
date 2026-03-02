/**
 * Review context gathering utility for code and UI review tools.
 *
 * Collects git diff, task packet, plan, and design context into a structured
 * object that can be used by review tools to analyze code changes and UI updates.
 *
 * @module review-context-gatherer
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePackageJson } from './package-json-parser.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface DesignContext {
  /** Tailwind config theme excerpts (colors, spacing, fonts) */
  tailwindConfig?: string;
  /** Detected component library and version */
  componentLibrary?: string;
  /** DESIGN.md or style guide content */
  designGuide?: string;
  /** CSS custom property definitions */
  cssVariables?: string;
  /** Design token file content */
  designTokens?: string;
  /** Whether Storybook is configured */
  storybook?: boolean;
}

export interface ReviewContextMetadata {
  /** Current branch name */
  branch: string;
  /** List of files changed in the diff */
  files: string[];
  /** Line count statistics */
  lineCount: { added: number; removed: number };
  /** True if diff touches UI-related files */
  hasUiChanges: boolean;
}

export interface ReviewContext {
  /** Git diff output */
  diff: string;
  /** Task packet content (null if not found) */
  taskPacket: string | null;
  /** Plan document content (null if not found) */
  plan: string | null;
  /** Design context (null if disabled or no artifacts found) */
  designContext: DesignContext | null;
  /** Metadata about the changes */
  metadata: ReviewContextMetadata;
}

export interface GatherReviewContextOptions {
  /** Enable design standards discovery (default: true) */
  designStandards?: boolean;
}

// ────────────────────────────────────────────────────────────────
// Git Operations
// ────────────────────────────────────────────────────────────────

/**
 * Get current git branch name.
 */
function getCurrentBranch(repoDir: string): string {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf-8',
      cwd: repoDir,
    }).trim();
  } catch (error) {
    throw new Error(
      `Failed to get current branch in ${repoDir}\n` +
      `  Error: ${(error as Error).message}\n` +
      `  Possible causes:\n` +
      `    - Not in a git repository\n` +
      `    - Git is not installed or not in PATH\n` +
      `    - Repository is corrupted\n` +
      `  Troubleshooting: Run 'git status' in the directory to verify git is working`
    );
  }
}

/**
 * Get git diff against target branch.
 *
 * Captures both staged and unstaged changes.
 */
export function getGitDiff(targetBranch: string, repoDir?: string): string {
  const cwd = repoDir ? resolve(repoDir) : process.cwd();

  try {
    return execSync(`git diff ${targetBranch}`, {
      encoding: 'utf-8',
      cwd,
      maxBuffer: 50 * 1024 * 1024, // 50MB max
    });
  } catch (error) {
    throw new Error(
      `Failed to get git diff against '${targetBranch}' in ${cwd}\n` +
      `  Error: ${(error as Error).message}\n` +
      `  Possible causes:\n` +
      `    - Branch '${targetBranch}' does not exist\n` +
      `    - Diff is larger than 50MB (exceeds buffer limit)\n` +
      `    - Git is not installed or not in PATH\n` +
      `    - Repository is corrupted\n` +
      `  Troubleshooting:\n` +
      `    - Run 'git diff ${targetBranch}' manually to verify\n` +
      `    - Check that target branch exists: git branch -a | grep ${targetBranch}\n` +
      `    - If diff is very large, try reviewing smaller changesets`
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Task Packet & Plan Discovery
// ────────────────────────────────────────────────────────────────

/**
 * Extract slug from branch name.
 *
 * Supports patterns like:
 * - task/my-feature-slug
 * - feature/my-feature-slug
 * - bugfix/my-bug-slug
 * - bug/my-bug-slug
 */
function extractSlugFromBranch(branchName: string): string | null {
  const match = branchName.match(/^(?:task|feature|bugfix|bug)\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Find and read task packet for the current branch.
 *
 * Checks multiple locations:
 * - features/{slug}/task-packet-header.md + task-packet-details.md (new split format)
 * - features/{slug}/task-packet.md (legacy single-file format)
 * - bugs/{slug}/task-packet.md (bugfix workflow)
 *
 * Returns null if not found.
 */
export function findTaskPacket(branchName: string, repoDir?: string): string | null {
  const cwd = repoDir ? resolve(repoDir) : process.cwd();
  const slug = extractSlugFromBranch(branchName);

  if (!slug) {
    return null;
  }

  // Try new split format (header + details)
  const featureHeaderPath = join(cwd, 'features', slug, 'task-packet-header.md');
  const featureDetailsPath = join(cwd, 'features', slug, 'task-packet-details.md');

  if (existsSync(featureHeaderPath)) {
    try {
      let content = readFileSync(featureHeaderPath, 'utf-8');

      // If details file exists, append it
      if (existsSync(featureDetailsPath)) {
        const details = readFileSync(featureDetailsPath, 'utf-8');
        content = `${content}\n\n---\n\n${details}`;
      }

      return content;
    } catch (error) {
      // Continue to try other locations
    }
  }

  // Try legacy single-file format in features/
  const featureLegacyPath = join(cwd, 'features', slug, 'task-packet.md');
  if (existsSync(featureLegacyPath)) {
    try {
      return readFileSync(featureLegacyPath, 'utf-8');
    } catch (error) {
      // Continue to bugs/
    }
  }

  // Try bugs/ directory
  const bugsHeaderPath = join(cwd, 'bugs', slug, 'task-packet-header.md');
  const bugsDetailsPath = join(cwd, 'bugs', slug, 'task-packet-details.md');

  if (existsSync(bugsHeaderPath)) {
    try {
      let content = readFileSync(bugsHeaderPath, 'utf-8');

      if (existsSync(bugsDetailsPath)) {
        const details = readFileSync(bugsDetailsPath, 'utf-8');
        content = `${content}\n\n---\n\n${details}`;
      }

      return content;
    } catch (error) {
      // Continue
    }
  }

  // Try legacy format in bugs/
  const bugsLegacyPath = join(cwd, 'bugs', slug, 'task-packet.md');
  if (existsSync(bugsLegacyPath)) {
    try {
      return readFileSync(bugsLegacyPath, 'utf-8');
    } catch (error) {
      // Not found
    }
  }

  return null;
}

/**
 * Find and read plan document for the current branch.
 *
 * Checks:
 * - features/{slug}/plan.md
 * - bugs/{slug}/plan.md
 *
 * Returns null if not found.
 */
export function findPlan(branchName: string, repoDir?: string): string | null {
  const cwd = repoDir ? resolve(repoDir) : process.cwd();
  const slug = extractSlugFromBranch(branchName);

  if (!slug) {
    return null;
  }

  // Try features/ directory
  const featurePlanPath = join(cwd, 'features', slug, 'plan.md');
  if (existsSync(featurePlanPath)) {
    try {
      return readFileSync(featurePlanPath, 'utf-8');
    } catch (error) {
      // Continue to bugs/
    }
  }

  // Try bugs/ directory
  const bugsPlanPath = join(cwd, 'bugs', slug, 'plan.md');
  if (existsSync(bugsPlanPath)) {
    try {
      return readFileSync(bugsPlanPath, 'utf-8');
    } catch (error) {
      // Not found
    }
  }

  return null;
}

// ────────────────────────────────────────────────────────────────
// Diff Analysis
// ────────────────────────────────────────────────────────────────

/**
 * UI file extensions to detect UI changes.
 */
const UI_FILE_EXTENSIONS = [
  '.tsx',
  '.jsx',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.vue',
  '.svelte',
];

/**
 * Analyze diff to extract metadata.
 *
 * Returns:
 * - List of files changed
 * - Line count statistics (added/removed)
 * - Whether UI files were touched
 */
export function analyzeDiffMetadata(diff: string): {
  files: string[];
  lineCount: { added: number; removed: number };
  hasUiChanges: boolean;
} {
  const files: string[] = [];
  let added = 0;
  let removed = 0;

  const lines = diff.split('\n');

  for (const line of lines) {
    // Extract file paths from diff headers
    if (line.startsWith('diff --git')) {
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      if (match) {
        // Use the "b/" path (target file)
        files.push(match[2]);
      }
    }

    // Count added/removed lines
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
    }
  }

  // Check if any files have UI extensions
  const hasUiChanges = files.some((file) =>
    UI_FILE_EXTENSIONS.some((ext) => file.endsWith(ext))
  );

  return {
    files,
    lineCount: { added, removed },
    hasUiChanges,
  };
}

// ────────────────────────────────────────────────────────────────
// Design Context Discovery
// ────────────────────────────────────────────────────────────────

/**
 * Gather design context from repository artifacts.
 *
 * Scans for:
 * - Tailwind config
 * - Component libraries (package.json)
 * - Design guides (DESIGN.md, STYLE-GUIDE.md)
 * - CSS variables (global stylesheets)
 * - Design tokens
 * - Storybook configuration
 *
 * Returns null if disabled or no artifacts found.
 */
export function gatherDesignContext(
  repoDir: string,
  options?: { designStandards?: boolean }
): DesignContext | null {
  // Check if design standards are enabled (default: true)
  if (options?.designStandards === false) {
    return null;
  }

  // Parse package.json once for component library and Storybook detection
  const packageJson = parsePackageJson(repoDir);

  const context: DesignContext = {};
  let foundAny = false;

  // 1. Look for design guide
  const designGuidePaths = [
    'DESIGN.md',
    'docs/DESIGN.md',
    'STYLE-GUIDE.md',
    'docs/STYLE-GUIDE.md',
    'docs/style-guide.md',
  ];

  for (const path of designGuidePaths) {
    const fullPath = join(repoDir, path);
    if (existsSync(fullPath)) {
      try {
        context.designGuide = readFileSync(fullPath, 'utf-8');
        foundAny = true;
        break;
      } catch {
        // Continue
      }
    }
  }

  // 2. Extract Tailwind config theme
  const tailwindPaths = [
    'tailwind.config.js',
    'tailwind.config.ts',
    'tailwind.config.mjs',
    'tailwind.config.cjs',
  ];

  for (const path of tailwindPaths) {
    const fullPath = join(repoDir, path);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');

        // Extract theme section (simple regex-based extraction)
        const themeMatch = content.match(/theme:\s*\{[\s\S]*?\n\s*\}/);
        if (themeMatch) {
          context.tailwindConfig = themeMatch[0];
          foundAny = true;
        } else {
          // If no theme match, include first 500 chars as excerpt
          context.tailwindConfig = content.substring(0, 500);
          foundAny = true;
        }
        break;
      } catch {
        // Continue
      }
    }
  }

  // 3. Detect component library from package.json
  if (packageJson.dependencies || packageJson.devDependencies) {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    // Check for common component libraries
    if (deps['@radix-ui/react-primitive'] || deps['@radix-ui/react-avatar']) {
      const version = deps['@radix-ui/react-primitive'] || deps['@radix-ui/react-avatar'];
      context.componentLibrary = `Radix UI ${version}`;
      foundAny = true;
    } else if (deps['@headlessui/react'] || deps['@headlessui/vue']) {
      const version = deps['@headlessui/react'] || deps['@headlessui/vue'];
      context.componentLibrary = `Headless UI ${version}`;
      foundAny = true;
    } else if (deps['@mui/material']) {
      context.componentLibrary = `Material UI ${deps['@mui/material']}`;
      foundAny = true;
    } else if (deps.antd) {
      context.componentLibrary = `Ant Design ${deps.antd}`;
      foundAny = true;
    }
  }

  // Check for shadcn/ui (identified by components.json)
  const componentsJsonPath = join(repoDir, 'components.json');
  if (existsSync(componentsJsonPath)) {
    context.componentLibrary = 'shadcn/ui';
    foundAny = true;
  }

  // 4. Scan for CSS variables in global stylesheets
  const globalStylePaths = [
    'styles/globals.css',
    'app/globals.css',
    'src/index.css',
    'src/styles/globals.css',
  ];

  for (const path of globalStylePaths) {
    const fullPath = join(repoDir, path);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');

        // Extract :root blocks with custom properties
        const rootMatch = content.match(/:root\s*\{[\s\S]*?\n\}/);
        if (rootMatch) {
          context.cssVariables = rootMatch[0];
          foundAny = true;
          break;
        }
      } catch {
        // Continue
      }
    }
  }

  // 5. Look for design tokens
  const tokenPaths = [
    'tokens.json',
    'design-tokens.json',
    'theme.json',
    'design/tokens.json',
    'design/design-tokens.json',
  ];

  for (const path of tokenPaths) {
    const fullPath = join(repoDir, path);
    if (existsSync(fullPath)) {
      try {
        context.designTokens = readFileSync(fullPath, 'utf-8');
        foundAny = true;
        break;
      } catch {
        // Continue
      }
    }
  }

  // 6. Detect Storybook
  const storybookDir = join(repoDir, '.storybook');
  if (existsSync(storybookDir)) {
    context.storybook = true;
    foundAny = true;
  } else if (packageJson.dependencies || packageJson.devDependencies) {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    if (deps['@storybook/react'] || deps['@storybook/vue'] || deps.storybook) {
      context.storybook = true;
      foundAny = true;
    }
  }

  // Return null if no design artifacts found
  return foundAny ? context : null;
}

// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

/**
 * Gather review context for the current branch.
 *
 * Collects:
 * - Git diff against target branch
 * - Task packet (if found)
 * - Plan document (if found)
 * - Design context (if enabled and artifacts exist)
 * - Metadata (branch, files, line counts, UI changes)
 *
 * @param targetBranch - Branch to diff against (e.g., "main")
 * @param repoDir - Repository directory (defaults to cwd)
 * @param options - Configuration options
 * @returns Complete review context object
 */
export function gatherReviewContext(
  targetBranch: string,
  repoDir?: string,
  options?: GatherReviewContextOptions
): ReviewContext {
  const cwd = repoDir ? resolve(repoDir) : process.cwd();

  // Get current branch
  const branch = getCurrentBranch(cwd);

  // Get git diff
  const diff = getGitDiff(targetBranch, cwd);

  // Analyze diff metadata
  const { files, lineCount, hasUiChanges } = analyzeDiffMetadata(diff);

  // Find task packet and plan
  const taskPacket = findTaskPacket(branch, cwd);
  const plan = findPlan(branch, cwd);

  // Gather design context if enabled
  const designContext = gatherDesignContext(cwd, options);

  return {
    diff,
    taskPacket,
    plan,
    designContext,
    metadata: {
      branch,
      files,
      lineCount,
      hasUiChanges,
    },
  };
}
