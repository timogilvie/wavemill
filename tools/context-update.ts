#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { callClaude } from '../shared/lib/llm-cli.ts';
import type { Subsystem } from '../shared/lib/subsystem-detector.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ────────────────────────────────────────────────────────────────
// Helper Functions
// ────────────────────────────────────────────────────────────────

/**
 * Extract key files from a subsystem spec.
 */
function extractKeyFiles(specContent: string): string[] {
  const files: string[] = [];
  const lines = specContent.split('\n');

  let inKeyFilesSection = false;
  for (const line of lines) {
    if (line.startsWith('## Key Files')) {
      inKeyFilesSection = true;
      continue;
    }
    if (inKeyFilesSection && line.startsWith('##')) {
      break;
    }
    if (inKeyFilesSection && line.startsWith('| `')) {
      const match = line.match(/\| `([^`]+)` \|/);
      if (match) files.push(match[1]);
    }
  }

  return files;
}

/**
 * Read source files for a subsystem.
 */
function readSourceFiles(files: string[], repoDir: string, maxSize = 30000): string {
  const contents: string[] = [];

  for (const file of files) {
    const fullPath = join(repoDir, file);
    if (!existsSync(fullPath)) {
      contents.push(`// File not found: ${file}`);
      continue;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      contents.push(`// File: ${file}\n${content}\n`);
    } catch (error) {
      contents.push(`// Error reading ${file}: ${error}`);
    }
  }

  const combined = contents.join('\n\n');
  return combined.length > maxSize ? combined.substring(0, maxSize) + '\n\n// ... (truncated)' : combined;
}

/**
 * Get recent git changes for subsystem files.
 */
function getRecentChanges(files: string[], repoDir: string): string {
  try {
    const fileList = files.map(f => `'${f}'`).join(' ');
    const cmd = `git log --oneline --since="30 days ago" -- ${fileList} | head -10`;
    const output = execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim();
    return output || '*(No recent changes)*';
  } catch {
    return '*(Unable to fetch git history)*';
  }
}

/**
 * Generate updated spec using LLM.
 */
async function generateUpdatedSpec(opts: {
  subsystemId: string;
  currentSpec: string;
  sourceFiles: string;
  recentChanges: string;
}): Promise<string> {
  const promptPath = join(dirname(dirname(__dirname)), 'tools', 'prompts', 'subsystem-manual-update-template.md');

  // Check if template exists, otherwise use inline prompt
  let prompt: string;
  if (existsSync(promptPath)) {
    const promptTemplate = readFileSync(promptPath, 'utf-8');
    const timestamp = new Date().toISOString();
    prompt = promptTemplate
      .replace('{SUBSYSTEM_ID}', opts.subsystemId)
      .replace('{CURRENT_SPEC}', opts.currentSpec)
      .replace('{SOURCE_FILES}', opts.sourceFiles)
      .replace('{RECENT_CHANGES}', opts.recentChanges)
      .replace(/{TIMESTAMP}/g, timestamp);
  } else {
    // Inline prompt fallback
    const timestamp = new Date().toISOString();
    prompt = `
You are updating a subsystem specification document.

**Subsystem ID:** ${opts.subsystemId}
**Task:** Generate an updated version of the subsystem spec based on current source files.

**Current Spec:**
\`\`\`markdown
${opts.currentSpec}
\`\`\`

**Current Source Files:**
\`\`\`
${opts.sourceFiles}
\`\`\`

**Recent Git Changes:**
${opts.recentChanges}

**Instructions:**
1. Preserve the exact structure and section headings from the current spec
2. Update the "Last updated" timestamp to: ${timestamp}
3. Review source files and update the spec to reflect current implementation
4. Update "Architectural Constraints" (DO/DON'T) based on patterns in source
5. Update "Known Failure Modes" if you see error handling patterns
6. Add recent changes to the "Recent Changes" section
7. Preserve any manual edits in the spec (look for non-templated content)
8. Keep the spec concise and machine-readable (prefer tables/lists over prose)

**Output only the updated markdown spec. No preamble, no explanation.**
`;
  }

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
 * Show diff between current and updated spec.
 */
function showDiff(current: string, updated: string): void {
  const currentPath = '/tmp/context-update-current.md';
  const updatedPath = '/tmp/context-update-updated.md';

  writeFileSync(currentPath, current, 'utf-8');
  writeFileSync(updatedPath, updated, 'utf-8');

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('DIFF: Current vs. Updated Spec');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  try {
    execSync(`diff -u ${currentPath} ${updatedPath} || true`, { stdio: 'inherit' });
  } catch {
    // diff returns non-zero when files differ, ignore
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

/**
 * Prompt user for confirmation.
 */
async function confirm(message: string): Promise<boolean> {
  console.log(message);
  process.stdout.write('Apply this update? [y/N] ');

  return new Promise((resolve) => {
    process.stdin.once('data', (data) => {
      const response = data.toString().trim().toLowerCase();
      resolve(response === 'y' || response === 'yes');
    });
  });
}

async function main(subsystemId: string, repoDir: string, isNoConfirm: boolean) {
  console.log(`Updating subsystem: ${subsystemId}`);
  console.log(`Repository: ${repoDir}`);

  // Check if spec exists
  const contextDir = join(repoDir, '.wavemill', 'context');
  const specPath = join(contextDir, `${subsystemId}.md`);

  if (!existsSync(specPath)) {
    console.error(`Error: Subsystem spec not found: ${specPath}`);
    console.error('');
    console.error('Available subsystems:');
    try {
      const files = execSync(`ls ${contextDir}/*.md 2>/dev/null || true`, { encoding: 'utf-8' })
        .split('\n')
        .filter(Boolean);
      files.forEach(f => {
        const id = f.split('/').pop()?.replace('.md', '');
        console.error(`  - ${id}`);
      });
    } catch {
      console.error('  (none found)');
    }
    process.exit(1);
  }

  // Read current spec
  console.log('Reading current spec...');
  const currentSpec = readFileSync(specPath, 'utf-8');

  // Extract key files
  const keyFiles = extractKeyFiles(currentSpec);
  console.log(`Found ${keyFiles.length} key file(s) in spec`);

  if (keyFiles.length === 0) {
    console.error('Error: No key files found in spec');
    process.exit(1);
  }

  // Read source files
  console.log('Reading source files...');
  const sourceFiles = readSourceFiles(keyFiles, repoDir);

  // Get recent changes
  console.log('Analyzing recent changes...');
  const recentChanges = getRecentChanges(keyFiles, repoDir);

  // Generate updated spec
  console.log('Generating updated spec (using LLM)...');
  const updatedSpec = await generateUpdatedSpec({
    subsystemId,
    currentSpec,
    sourceFiles,
    recentChanges,
  });

  // Show diff
  if (!isNoConfirm) {
    showDiff(currentSpec, updatedSpec);

    // Prompt for confirmation
    const approved = await confirm('Review the diff above.');
    if (!approved) {
      console.log('Update cancelled.');
      process.exit(0);
    }
  }

  // Write updated spec
  console.log('Writing updated spec...');
  writeFileSync(specPath, updatedSpec, 'utf-8');

  console.log('✓ Subsystem spec updated successfully');
  console.log(`  ${specPath}`);
}

runTool({
  name: 'context-update',
  description: 'Refresh a specific subsystem spec',
  options: {
    'no-confirm': { type: 'boolean', description: 'Skip diff confirmation (apply changes automatically)' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'subsystemId repoPath',
    description: 'Subsystem ID and optional repository path',
    multiple: true,
  },
  examples: [
    'npx tsx tools/context-update.ts linear-api',
    'npx tsx tools/context-update.ts linear-api --no-confirm',
  ],
  additionalHelp: `Reads source files and uses LLM to generate an updated specification.
Preserves structure and manual edits where possible.`,
  async run({ args, positional }) {
    const subsystemId = positional[0];
    if (!subsystemId) {
      console.error('Error: Subsystem ID is required');
      process.exit(1);
    }
    const repoPath = positional[1] || process.cwd();
    const repoDir = resolve(repoPath);
    await main(subsystemId, repoDir, !!args['no-confirm']);
  },
});
