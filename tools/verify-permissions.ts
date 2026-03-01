#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { getPermissionsConfig } from '../shared/lib/config.ts';
import {
  isSafePattern,
  getDefaultPatterns,
  getCategoryNames,
  getPatternsByCategory,
} from '../shared/lib/permission-patterns.ts';

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
}

// ────────────────────────────────────────────────────────────────
// Validation Functions
// ────────────────────────────────────────────────────────────────

/**
 * Validate permission configuration
 */
function validateConfig(repoDir: string, verbose: boolean): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    info: [],
  };

  const permissionsConfig = getPermissionsConfig(repoDir);

  // Check if permissions are configured
  if (!permissionsConfig.autoApprovePatterns && !permissionsConfig.worktreeMode) {
    result.warnings.push('No permissions configured in .wavemill-config.json');
    result.info.push('Add a "permissions" section to enable auto-approval');
    return result;
  }

  // Validate patterns
  const patterns = permissionsConfig.autoApprovePatterns || [];

  if (patterns.length === 0 && !permissionsConfig.worktreeMode?.autoApproveReadOnly) {
    result.warnings.push('No auto-approve patterns configured');
    result.info.push('Add patterns to "permissions.autoApprovePatterns" or enable worktreeMode.autoApproveReadOnly');
  }

  if (verbose) {
    result.info.push(`Found ${patterns.length} custom pattern(s)`);
  }

  // Check each pattern for safety
  const unsafePatterns: string[] = [];
  for (const pattern of patterns) {
    if (!isSafePattern(pattern)) {
      unsafePatterns.push(pattern);
    }
  }

  if (unsafePatterns.length > 0) {
    result.valid = false;
    result.errors.push(`Unsafe patterns detected (${unsafePatterns.length}):`);
    for (const pattern of unsafePatterns) {
      result.errors.push(`  - ${pattern}`);
    }
    result.info.push('Remove unsafe patterns or make them more specific');
  }

  // Check worktreeMode config
  if (permissionsConfig.worktreeMode) {
    if (verbose) {
      result.info.push('Worktree mode: ' + (permissionsConfig.worktreeMode.enabled ? 'enabled' : 'disabled'));
      result.info.push('Auto-approve read-only: ' + (permissionsConfig.worktreeMode.autoApproveReadOnly ? 'yes' : 'no'));
    }

    if (permissionsConfig.worktreeMode.autoApproveReadOnly) {
      const defaults = getDefaultPatterns();
      if (verbose) {
        result.info.push(`Will auto-approve ${defaults.length} default read-only patterns`);
      }
    }
  }

  return result;
}

/**
 * Check Claude Code settings
 */
function checkClaudeSettings(repoDir: string, verbose: boolean): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    info: [],
  };

  const settingsPath = resolve(homedir(), 'Library/Application Support/Claude Code/User/settings.json');

  if (!existsSync(settingsPath)) {
    result.warnings.push('Claude Code settings file not found');
    result.info.push(`Expected at: ${settingsPath}`);
    result.info.push('Run: npx tsx tools/generate-claude-permissions.ts');
    return result;
  }

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const autoApprove = settings['claudeCode.autoApprove'];

    if (!autoApprove) {
      result.warnings.push('No auto-approve settings found in Claude Code');
      result.info.push('Run: npx tsx tools/generate-claude-permissions.ts');
      return result;
    }

    if (verbose) {
      const bashPatterns = autoApprove.bash || [];
      result.info.push(`Claude Code has ${bashPatterns.length} bash auto-approve pattern(s)`);
    }

    result.info.push('✓ Claude Code settings appear configured');
  } catch (err) {
    result.errors.push(`Failed to read Claude Code settings: ${(err as Error).message}`);
    result.valid = false;
  }

  return result;
}

/**
 * Check Codex settings
 */
function checkCodexSettings(repoDir: string, verbose: boolean): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    info: [],
  };

  const settingsPath = resolve(homedir(), '.codex/permissions.json');

  if (!existsSync(settingsPath)) {
    result.warnings.push('Codex permissions file not found');
    result.info.push(`Expected at: ${settingsPath}`);
    result.info.push('Run: npx tsx tools/generate-codex-permissions.ts');
    return result;
  }

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    if (!settings.autoApprovePatterns) {
      result.warnings.push('No auto-approve patterns found in Codex');
      result.info.push('Run: npx tsx tools/generate-codex-permissions.ts');
      return result;
    }

    if (verbose) {
      result.info.push(`Codex has ${settings.autoApprovePatterns.length} auto-approve pattern(s)`);
    }

    result.info.push('✓ Codex settings appear configured');
  } catch (err) {
    result.errors.push(`Failed to read Codex settings: ${(err as Error).message}`);
    result.valid = false;
  }

  return result;
}

/**
 * Print validation result
 */
function printResult(result: ValidationResult, label: string): void {
  console.log(`\n${label}:`);
  console.log('─'.repeat(60));

  if (result.errors.length > 0) {
    console.log('\n❌ Errors:');
    for (const error of result.errors) {
      console.log(`  ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    for (const warning of result.warnings) {
      console.log(`  ${warning}`);
    }
  }

  if (result.info.length > 0) {
    console.log('\nℹ️  Info:');
    for (const info of result.info) {
      console.log(`  ${info}`);
    }
  }

  if (result.valid && result.errors.length === 0 && result.warnings.length === 0) {
    console.log('\n✅ All checks passed');
  }
}

/**
 * Show pattern summary
 */
function showPatternSummary(verbose: boolean): void {
  console.log('\nDefault Pattern Categories:');
  console.log('─'.repeat(60));

  const categories = getCategoryNames();
  for (const category of categories) {
    const patterns = getPatternsByCategory(category);
    console.log(`\n${category} (${patterns.length} patterns):`);

    if (verbose) {
      for (const pattern of patterns.slice(0, 5)) {
        console.log(`  - ${pattern}`);
      }
      if (patterns.length > 5) {
        console.log(`  ... and ${patterns.length - 5} more`);
      }
    }
  }
}

runTool({
  name: 'verify-permissions',
  description: 'Verify permission configuration',
  options: {
    agent: { type: 'string', description: 'Check specific agent (claude|codex)' },
    verbose: { type: 'boolean', short: 'v', description: 'Show detailed output' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  examples: [
    'npx tsx tools/verify-permissions.ts',
    'npx tsx tools/verify-permissions.ts --agent claude',
    'npx tsx tools/verify-permissions.ts --verbose',
  ],
  additionalHelp: `Validates that permission patterns are configured correctly and
checks if they match expected agent settings.`,
  run({ args }) {
    if (args.agent && args.agent !== 'claude' && args.agent !== 'codex') {
      console.error(`Invalid agent: ${args.agent}. Must be 'claude' or 'codex'`);
      process.exit(1);
    }

    const repoDir = process.cwd();
    const verbose = !!args.verbose;

    console.log('🔍 Verifying Permission Configuration');

    const configResult = validateConfig(repoDir, verbose);
    printResult(configResult, 'Configuration Validation');

    if (args.agent === 'claude') {
      const claudeResult = checkClaudeSettings(repoDir, verbose);
      printResult(claudeResult, 'Claude Code Settings');
    } else if (args.agent === 'codex') {
      const codexResult = checkCodexSettings(repoDir, verbose);
      printResult(codexResult, 'Codex Settings');
    }

    if (verbose) {
      showPatternSummary(verbose);
    }

    if (!configResult.valid) {
      console.log('\n❌ Validation failed');
      process.exit(1);
    } else {
      console.log('\n✅ Verification complete');
    }
  },
});
