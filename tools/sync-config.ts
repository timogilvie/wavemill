#!/usr/bin/env -S npx tsx
/**
 * Sync/upgrade .wavemill-config.json to the latest version.
 *
 * This tool:
 * 1. Loads the current config (if exists)
 * 2. Merges with the canonical template
 * 3. Preserves all user-configured values
 * 4. Adds missing sections and fields
 * 5. Updates configVersion to current
 * 6. Creates backup before modifying
 *
 * Usage:
 *   npx tsx tools/sync-config.ts [--yes] [--dry-run]
 *
 * Options:
 *   --yes      Skip confirmation prompt
 *   --dry-run  Show changes without writing
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadWavemillConfig, CURRENT_CONFIG_VERSION } from '../shared/lib/config.ts';

// Canonical template matching the comprehensive config from wavemill init
const CANONICAL_TEMPLATE = {
  configVersion: '1.0.0',
  linear: {
    project: '',
  },
  mill: {
    session: 'wavemill',
    maxParallel: 3,
    pollSeconds: 10,
    baseBranch: 'main',
    worktreeRoot: '../worktrees',
    agentCmd: 'claude',
    requireConfirm: true,
    planningMode: 'skip',
    maxRetries: 3,
    retryDelay: 2,
  },
  expand: {
    maxSelect: 3,
    maxDisplay: 9,
  },
  plan: {
    maxDisplay: 9,
    research: false,
    model: 'claude-opus-4-6',
    interactive: true,
  },
  eval: {
    aggregation: {
      repos: [],
      outputPath: '.wavemill/evals/aggregated-evals.jsonl',
    },
    evalsDir: '.wavemill/evals',
    judge: {
      model: 'claude-sonnet-4-5-20250929',
      provider: 'anthropic',
    },
    pricing: {
      'claude-opus-4-6': { inputCostPerMTok: 15, outputCostPerMTok: 75, cacheWriteCostPerMTok: 18.75, cacheReadCostPerMTok: 1.50 },
      'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.30 },
      'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.80, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1.00, cacheReadCostPerMTok: 0.08 },
      'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheReadCostPerMTok: 0.44 },
    },
    interventionPenalties: {
      reviewComment: 0.05,
      postPrCommit: 0.08,
      manualEdit: 0.10,
      testFix: 0.06,
      sessionRedirect: 0.12,
      selfReviewWarning: 0.05,
      selfReviewBlocker: 0.20,
    },
  },
  autoEval: false,
  review: {
    maxIterations: 3,
    enabled: true,
    metricsLog: '.wavemill/review-log.json',
    personas: ['general'],
  },
  router: {
    enabled: true,
    defaultModel: 'claude-sonnet-4-5-20250929',
    minRecords: 20,
    minModels: 2,
    models: [],
    defaultAgent: 'claude',
    agentMap: {
      'claude-opus-4-6': 'claude',
      'claude-sonnet-4-5-20250929': 'claude',
      'claude-haiku-4-5-20251001': 'claude',
      'gpt-5.3-codex': 'codex',
    },
    mode: 'auto',
    llmModel: 'gpt-4o-mini',
    llmProvider: 'openai',
  },
  validation: {
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
  },
  constraints: {
    enabled: true,
    cleanupAfterMerge: false,
  },
  ui: {
    visualVerification: true,
    designStandards: true,
    creativeDirection: false,
  },
  permissions: {
    autoApprovePatterns: [
      'find *',
      'ls *',
      'cat *',
      'head *',
      'tail *',
      'wc *',
      'git status*',
      'git log*',
      'git show*',
      'git diff*',
      'git branch --list*',
      'git branch -l*',
      'git worktree list*',
      'gh pr view*',
      'gh pr list*',
      'gh pr status*',
      'gh issue view*',
      'gh issue list*',
      'grep *',
      'rg *',
      'npm list*',
      'npm ls*',
    ],
    worktreeMode: {
      enabled: true,
      autoApproveReadOnly: true,
    },
  },
};

/**
 * Deep merge two objects, preserving user values from source.
 * Arrays are replaced (not merged).
 */
function deepMerge(target: any, source: any): any {
  if (source === null || source === undefined) {
    return target;
  }

  if (Array.isArray(target)) {
    // For arrays, prefer source if non-empty, otherwise use target
    return Array.isArray(source) && source.length > 0 ? source : target;
  }

  if (typeof target === 'object' && target !== null) {
    const result = { ...target };

    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        if (typeof source[key] === 'object' && !Array.isArray(source[key]) && source[key] !== null) {
          result[key] = deepMerge(target[key] || {}, source[key]);
        } else if (source[key] !== undefined) {
          result[key] = source[key];
        }
      }
    }

    return result;
  }

  return source !== undefined ? source : target;
}

/**
 * Identify what sections/fields were added by the merge.
 */
function identifyAdditions(before: any, after: any, path: string = ''): string[] {
  const additions: string[] = [];

  for (const key in after) {
    const fullPath = path ? `${path}.${key}` : key;

    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      additions.push(fullPath);
    } else if (typeof after[key] === 'object' && !Array.isArray(after[key]) && after[key] !== null) {
      additions.push(...identifyAdditions(before[key] || {}, after[key], fullPath));
    }
  }

  return additions;
}

async function syncConfig(options: { yes?: boolean; dryRun?: boolean } = {}) {
  const repoDir = process.cwd();
  const configPath = resolve(repoDir, '.wavemill-config.json');
  const backupPath = resolve(repoDir, '.wavemill-config.json.backup');

  console.log('🔧 Wavemill Config Sync\n');

  // Load current config or use empty object
  let currentConfig: any = {};
  let configExists = false;

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      currentConfig = JSON.parse(content);
      configExists = true;
      console.log(`✓ Found existing config at ${configPath}`);
    } catch (err) {
      console.error(`✗ Failed to parse existing config: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    console.log(`ℹ No existing config found. Will create new one.`);
  }

  // Merge with template
  const merged = deepMerge(CANONICAL_TEMPLATE, currentConfig);

  // Always update version to current
  merged.configVersion = CURRENT_CONFIG_VERSION;

  // Identify additions
  const additions = configExists ? identifyAdditions(currentConfig, merged) : [];

  // Show summary
  console.log();
  if (additions.length > 0) {
    console.log(`📝 The following sections/fields will be added:\n`);
    additions.forEach(path => console.log(`   + ${path}`));
  } else if (configExists && currentConfig.configVersion === CURRENT_CONFIG_VERSION) {
    console.log(`✓ Config is already up to date (version ${CURRENT_CONFIG_VERSION})`);
    console.log(`  No changes needed.`);
    return;
  } else if (configExists) {
    console.log(`✓ Updating configVersion: ${currentConfig.configVersion || '(none)'} → ${CURRENT_CONFIG_VERSION}`);
  }

  console.log();

  // Dry run mode
  if (options.dryRun) {
    console.log('📄 Merged config (dry-run, not written):\n');
    console.log(JSON.stringify(merged, null, 2));
    return;
  }

  // Confirm
  if (!options.yes && configExists) {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await rl.question('Apply these changes? [Y/n] ');
    rl.close();

    if (answer.toLowerCase() === 'n') {
      console.log('Cancelled.');
      return;
    }
  }

  // Create backup if file exists
  if (configExists) {
    copyFileSync(configPath, backupPath);
    console.log(`✓ Backup created at ${backupPath}`);
  }

  // Write merged config
  try {
    writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    console.log(`✓ Config updated to version ${CURRENT_CONFIG_VERSION}`);
    console.log(`\n✅ Sync complete!`);

    if (configExists) {
      console.log(`   Backup: ${backupPath}`);
    }
  } catch (err) {
    console.error(`✗ Failed to write config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Main
const args = process.argv.slice(2);
const yes = args.includes('--yes');
const dryRun = args.includes('--dry-run');

syncConfig({ yes, dryRun }).catch(err => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
