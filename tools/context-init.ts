#!/usr/bin/env -S npx tsx
/**
 * Context Init - Bootstrap subsystem documentation
 *
 * Analyzes a codebase and generates initial .wavemill/context/{subsystem}.md files.
 * This is part of the three-tier memory system:
 * - Hot memory: project-context.md (always loaded)
 * - Cold memory: context/{subsystem}.md (loaded on-demand)
 * - Agent memory: session-specific context
 *
 * Usage:
 *   npx tsx tools/context-init.ts [repo-path] [options]
 *   npx tsx tools/context-init.ts --force [repo-path]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectSubsystems } from '../shared/lib/subsystem-detector.ts';
import { writeSubsystemSpecs } from '../shared/lib/subsystem-spec-generator.ts';

// ────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isForce = args.includes('--force') || args.includes('-f');
const isInteractive = args.includes('--interactive') || args.includes('-i');
const isHelp = args.includes('--help') || args.includes('-h');

const repoPath = args.find((arg) => !arg.startsWith('-')) || process.cwd();
const repoDir = resolve(repoPath);

if (isHelp) {
  console.log(`
Context Init - Bootstrap subsystem documentation

Analyzes a codebase and generates subsystem specs in .wavemill/context/.

Usage:
  npx tsx tools/context-init.ts [repo-path] [options]

Arguments:
  [repo-path]    Path to repository (default: current directory)

Options:
  --force, -f        Overwrite existing subsystem specs
  --interactive, -i  Prompt for confirmation before creating specs
  --help, -h         Show this help message

Examples:
  # Initialize in current directory
  npx tsx tools/context-init.ts

  # Initialize in specific repo
  npx tsx tools/context-init.ts /path/to/repo

  # Regenerate all specs (overwrite existing)
  npx tsx tools/context-init.ts --force

  # Interactive mode (confirm each subsystem)
  npx tsx tools/context-init.ts --interactive
  `);
  process.exit(0);
}

// ────────────────────────────────────────────────────────────────
// Main Logic
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Analyzing repository: ${repoDir}`);

  // Check if .wavemill directory exists
  const wavemillDir = join(repoDir, '.wavemill');
  if (!existsSync(wavemillDir)) {
    console.error('Error: .wavemill directory not found');
    console.error('Initialize project context first: npx tsx tools/init-project-context.ts');
    process.exit(1);
  }

  // Check if context directory exists
  const contextDir = join(wavemillDir, 'context');
  const contextExists = existsSync(contextDir);

  if (contextExists && !isForce) {
    // Check for existing specs
    const existingSpecs = readdirSync(contextDir).filter(f => f.endsWith('.md'));

    if (existingSpecs.length > 0) {
      console.log(`Found ${existingSpecs.length} existing subsystem spec(s) in ${contextDir}`);
      console.log('');
      console.log('Run with --force to regenerate all specs, or use individual update commands.');
      console.log('');
      console.log('To update a specific subsystem:');
      console.log('  wavemill context update <subsystem-id>');
      console.log('');
      console.log('To check for stale documentation:');
      console.log('  wavemill context check');
      process.exit(2); // Exit code 2 = already initialized
    }
  }

  // Create context directory if it doesn't exist
  if (!existsSync(contextDir)) {
    console.log('Creating .wavemill/context directory...');
    mkdirSync(contextDir, { recursive: true });
  }

  // Detect subsystems
  console.log('Detecting subsystems...');
  const subsystems = detectSubsystems(repoDir, {
    minFiles: 3,
    useGitAnalysis: true,
    maxSubsystems: 20,
  });

  if (subsystems.length === 0) {
    console.log('No subsystems detected (repo may be too small or unstructured)');
    process.exit(0);
  }

  console.log(`Found ${subsystems.length} subsystem(s):`);
  subsystems.forEach(s => {
    const confidence = (s.confidence * 100).toFixed(0);
    console.log(`  - ${s.name} (${s.keyFiles.length} files, confidence: ${confidence}%)`);
  });
  console.log('');

  // Interactive confirmation
  if (isInteractive) {
    console.log('Proceed with creating subsystem specs?');
    console.log('Press Enter to continue, Ctrl+C to cancel...');

    // Wait for user input
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve());
    });
  }

  // Generate subsystem specs
  console.log('Generating subsystem specifications...');
  writeSubsystemSpecs(subsystems, contextDir, {
    repoDir,
    includeGitHistory: true,
  });

  console.log(`✓ Created ${subsystems.length} subsystem spec(s) in ${contextDir}`);
  console.log('');

  // Update project-context.md to reference subsystem docs (if not already there)
  const projectContextPath = join(wavemillDir, 'project-context.md');
  if (existsSync(projectContextPath)) {
    const projectContext = readFileSync(projectContextPath, 'utf-8');

    // Check if subsystem section already exists
    if (!projectContext.includes('## Subsystem Documentation')) {
      console.log('Updating project-context.md with subsystem references...');

      const subsystemLinks = subsystems
        .map(s => `- [${s.name}](context/${s.id}.md) - ${s.description}`)
        .join('\n');

      const subsystemSection = `\n\n## Subsystem Documentation\n\nFor detailed documentation on specific subsystems, see \`.wavemill/context/\`:\n\n${subsystemLinks}\n\n---`;

      // Insert before "Recent Work" section
      const updatedContext = projectContext.replace(
        /## Recent Work/,
        subsystemSection + '\n## Recent Work'
      );

      writeFileSync(projectContextPath, updatedContext, 'utf-8');
      console.log('✓ Updated project-context.md');
    }
  }

  console.log('');
  console.log('Next steps:');
  console.log('1. Review subsystem specs in .wavemill/context/');
  console.log('2. Add domain-specific details to each spec');
  console.log('3. Use "wavemill context check" to monitor freshness');
  console.log('4. Use "wavemill context search <query>" to find relevant context');
  console.log('');
  console.log('Subsystem specs are auto-updated after each PR merge.');
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
