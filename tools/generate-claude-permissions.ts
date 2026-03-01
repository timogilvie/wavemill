#!/usr/bin/env -S npx tsx
/**
 * Generate Claude Code Permission Settings
 *
 * Reads permission patterns from .wavemill-config.json and generates
 * Claude Code-compatible auto-approval settings.
 *
 * Usage:
 *   npx tsx tools/generate-claude-permissions.ts [options]
 *
 * Options:
 *   --output <path>  Output file path (default: .wavemill/claude-permissions.json)
 *   --stdout         Print to stdout instead of file
 *   --help           Show help
 *
 * @module generate-claude-permissions
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getPermissionsConfig } from '../shared/lib/config.ts';
import { getDefaultPatterns } from '../shared/lib/permission-patterns.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface ClaudeCodePermissions {
  'claudeCode.autoApprove': {
    bash?: string[];
    read?: string[];
    write?: string[];
    edit?: string[];
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
Generate Claude Code Permission Settings

Reads permission patterns from .wavemill-config.json and generates
Claude Code-compatible auto-approval settings.

Usage:
  npx tsx tools/generate-claude-permissions.ts [options]

Options:
  --output <path>  Output file path (default: .wavemill/claude-permissions.json)
  --stdout         Print to stdout instead of file
  --help           Show help

Examples:
  # Generate to default location
  npx tsx tools/generate-claude-permissions.ts

  # Generate to custom location
  npx tsx tools/generate-claude-permissions.ts --output ./my-settings.json

  # Print to stdout
  npx tsx tools/generate-claude-permissions.ts --stdout
`);
}

// ────────────────────────────────────────────────────────────────
// Permission Generation
// ────────────────────────────────────────────────────────────────

/**
 * Generate Claude Code permission settings from wavemill config
 */
function generateClaudePermissions(repoDir: string): ClaudeCodePermissions {
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

  // Claude Code groups permissions by tool type
  // For now, we'll put all patterns in the bash category since most
  // read-only commands are shell commands
  const settings: ClaudeCodePermissions = {
    'claudeCode.autoApprove': {
      bash: patterns,
    },
  };

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
  const settings = generateClaudePermissions(repoDir);
  const json = JSON.stringify(settings, null, 2);

  if (args.stdout) {
    console.log(json);
  } else {
    const outputPath = args.output || resolve(repoDir, '.wavemill/claude-permissions.json');
    const outputDir = dirname(outputPath);

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(outputPath, json + '\n', 'utf-8');

    console.log(`✅ Generated Claude Code settings at: ${outputPath}`);
    console.log('');
    console.log('To apply:');
    console.log('1. Open Claude Code settings (Cmd+, or Ctrl+,)');
    console.log('2. Navigate to "Extensions" → "Claude Code" → "Tool Permissions"');
    console.log('3. Click "Import Settings"');
    console.log(`4. Select: ${outputPath}`);
    console.log('5. Click "Apply"');
    console.log('6. Restart Claude Code');
    console.log('');
    console.log('Or manually copy to Claude Code settings file:');
    console.log('  macOS: ~/Library/Application Support/Claude Code/User/settings.json');
    console.log('  Linux: ~/.config/Claude Code/User/settings.json');
    console.log('  Windows: %APPDATA%\\Claude Code\\User\\settings.json');
    console.log('');
    console.log('See docs/worktree-auto-approve.md for detailed instructions.');
  }
}

main();
