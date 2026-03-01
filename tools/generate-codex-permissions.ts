#!/usr/bin/env -S npx tsx
/**
 * Generate Codex Permission Settings
 *
 * Reads permission patterns from .wavemill-config.json and generates
 * Codex-compatible auto-approval settings.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getPermissionsConfig } from '../shared/lib/config.ts';
import { getDefaultPatterns } from '../shared/lib/permission-patterns.ts';

interface CodexPermissions {
  autoApprovePatterns: string[];
  worktreeMode?: {
    enabled: boolean;
    autoApproveReadOnly: boolean;
  };
}

function generateCodexPermissions(repoDir: string): CodexPermissions {
  const permissionsConfig = getPermissionsConfig(repoDir);

  let patterns = permissionsConfig.autoApprovePatterns || [];

  if (
    permissionsConfig.worktreeMode?.enabled &&
    permissionsConfig.worktreeMode?.autoApproveReadOnly
  ) {
    const defaults = getDefaultPatterns();
    patterns = [...new Set([...patterns, ...defaults])];
  }

  return {
    autoApprovePatterns: patterns,
    worktreeMode: permissionsConfig.worktreeMode,
  };
}

runTool({
  name: 'generate-codex-permissions',
  description: 'Generate Codex permission settings from wavemill config',
  options: {
    output: { type: 'string', description: 'Output file path' },
    stdout: { type: 'boolean', description: 'Print to stdout instead of file' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  examples: [
    '# Generate to default location',
    'npx tsx tools/generate-codex-permissions.ts',
    '',
    '# Generate to custom location',
    'npx tsx tools/generate-codex-permissions.ts --output ./my-settings.json',
    '',
    '# Print to stdout',
    'npx tsx tools/generate-codex-permissions.ts --stdout',
  ],
  run({ args }) {
    const repoDir = process.cwd();
    const settings = generateCodexPermissions(repoDir);
    const json = JSON.stringify(settings, null, 2);

    if (args.stdout) {
      console.log(json);
    } else {
      const outputPath = args.output || resolve(repoDir, '.wavemill/codex-permissions.json');
      const outputDir = dirname(outputPath);

      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      writeFileSync(outputPath, json + '\n', 'utf-8');

      console.log(`✅ Generated Codex settings at: ${outputPath}`);
      console.log('');
      console.log('To apply:');
      console.log('1. Copy to ~/.codex/permissions.json');
      console.log('2. Restart Codex');
      console.log('');
      console.log('See docs/worktree-auto-approve.md for detailed instructions.');
    }
  },
});
