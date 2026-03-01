#!/usr/bin/env -S npx tsx
/**
 * Generate Codex Permission Settings
 *
 * Reads permission patterns from .wavemill-config.json and generates
 * Codex-compatible auto-approval settings.
 *
 * Usage:
 *   npx tsx tools/generate-codex-permissions.ts [options]
 *
 * Options:
 *   --output <path>  Output file path (default: .wavemill/codex-permissions.json)
 *   --stdout         Print to stdout instead of file
 *   --help           Show help
 *
 * @module generate-codex-permissions
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getPermissionsConfig } from '../shared/lib/config.ts';
import { getDefaultPatterns } from '../shared/lib/permission-patterns.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface CodexPermissions {
  autoApprovePatterns: string[];
  worktreeMode?: {
    enabled: boolean;
    autoApproveReadOnly: boolean;
  };
}

// ────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ────────────────────────────────────────────────────────────────

interface Args {
  output?: string;
  stdout: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    stdout: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--output':
        args.output = argv[++i];
        break;
      case '--stdout':
        args.stdout = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  return args;
}

function showHelp(): void {
  console.log(`
Generate Codex Permission Settings

Reads permission patterns from .wavemill-config.json and generates
Codex-compatible auto-approval settings.

Usage:
  npx tsx tools/generate-codex-permissions.ts [options]

Options:
  --output <path>  Output file path (default: .wavemill/codex-permissions.json)
  --stdout         Print to stdout instead of file
  --help           Show help

Examples:
  # Generate to default location
  npx tsx tools/generate-codex-permissions.ts

  # Generate to custom location
  npx tsx tools/generate-codex-permissions.ts --output ./my-settings.json

  # Print to stdout
  npx tsx tools/generate-codex-permissions.ts --stdout
`);
}

// ────────────────────────────────────────────────────────────────
// Permission Generation
// ────────────────────────────────────────────────────────────────

/**
 * Generate Codex permission settings from wavemill config
 */
function generateCodexPermissions(repoDir: string): CodexPermissions {
  const permissionsConfig = getPermissionsConfig(repoDir);

  // Get patterns from config, fallback to defaults if not configured
  let patterns = permissionsConfig.autoApprovePatterns || [];

  // If worktreeMode is enabled and autoApproveReadOnly is true, include defaults
  if (
    permissionsConfig.worktreeMode?.enabled &&
    permissionsConfig.worktreeMode?.autoApproveReadOnly
  ) {
    const defaults = getDefaultPatterns();
    patterns = [...new Set([...patterns, ...defaults])]; // Deduplicate
  }

  const settings: CodexPermissions = {
    autoApprovePatterns: patterns,
  };

  // Include worktreeMode config if present
  if (permissionsConfig.worktreeMode) {
    settings.worktreeMode = permissionsConfig.worktreeMode;
  }

  return settings;
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const repoDir = process.cwd();
  const settings = generateCodexPermissions(repoDir);
  const json = JSON.stringify(settings, null, 2);

  if (args.stdout) {
    console.log(json);
  } else {
    const outputPath = args.output || resolve(repoDir, '.wavemill/codex-permissions.json');
    const outputDir = dirname(outputPath);

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(outputPath, json + '\n', 'utf-8');

    console.log(`✅ Generated Codex settings at: ${outputPath}`);
    console.log('');
    console.log('To apply:');
    console.log('1. Copy settings to Codex permissions file:');
    console.log('   mkdir -p ~/.codex');
    console.log(`   cp ${outputPath} ~/.codex/permissions.json`);
    console.log('');
    console.log('2. Restart Codex:');
    console.log('   pkill -f codex');
    console.log('   codex');
    console.log('');
    console.log('Or merge with existing permissions:');
    console.log('   jq -s \'.[0].autoApprovePatterns + .[1].autoApprovePatterns | unique | {"autoApprovePatterns": .}\' \\');
    console.log('     ~/.codex/permissions.json \\');
    console.log(`     ${outputPath} > ~/.codex/permissions-new.json`);
    console.log('   mv ~/.codex/permissions-new.json ~/.codex/permissions.json');
    console.log('');
    console.log('See docs/worktree-auto-approve.md for detailed instructions.');
  }
}

main();
