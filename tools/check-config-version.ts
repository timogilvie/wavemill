#!/usr/bin/env -S npx tsx
/**
 * Check if the wavemill config version is up to date.
 *
 * Exit codes:
 *  0 - Config is current or newer
 *  1 - Config is missing, has no version, or is outdated
 *  2 - Error (invalid config, etc.)
 *
 * Usage:
 *   npx tsx tools/check-config-version.ts [--json]
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadWavemillConfig, CURRENT_CONFIG_VERSION } from '../shared/lib/config.ts';

interface VersionCheckResult {
  status: 'missing' | 'no-version' | 'outdated' | 'current' | 'newer';
  currentVersion: string;
  configVersion?: string;
  message: string;
  needsUpgrade: boolean;
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

function checkConfigVersion(repoDir: string = process.cwd()): VersionCheckResult {
  const configPath = resolve(repoDir, '.wavemill-config.json');

  // Check if config file exists
  if (!existsSync(configPath)) {
    return {
      status: 'missing',
      currentVersion: CURRENT_CONFIG_VERSION,
      message: 'No .wavemill-config.json found. Run "wavemill init" to create one.',
      needsUpgrade: true,
    };
  }

  // Load config
  let config;
  try {
    config = loadWavemillConfig(repoDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'missing',
      currentVersion: CURRENT_CONFIG_VERSION,
      message: `Failed to load config: ${message}`,
      needsUpgrade: false,
    };
  }

  // Check if version field exists
  if (!config.configVersion) {
    return {
      status: 'no-version',
      currentVersion: CURRENT_CONFIG_VERSION,
      message: 'Config has no version field (pre-versioning). Consider upgrading to get latest features.',
      needsUpgrade: true,
    };
  }

  // Compare versions
  const comparison = compareVersions(config.configVersion, CURRENT_CONFIG_VERSION);

  if (comparison < 0) {
    return {
      status: 'outdated',
      currentVersion: CURRENT_CONFIG_VERSION,
      configVersion: config.configVersion,
      message: `Config version ${config.configVersion} is outdated (current: ${CURRENT_CONFIG_VERSION}). Upgrade recommended.`,
      needsUpgrade: true,
    };
  }

  if (comparison > 0) {
    return {
      status: 'newer',
      currentVersion: CURRENT_CONFIG_VERSION,
      configVersion: config.configVersion,
      message: `Config version ${config.configVersion} is newer than current ${CURRENT_CONFIG_VERSION}. You may be using an older wavemill version.`,
      needsUpgrade: false,
    };
  }

  return {
    status: 'current',
    currentVersion: CURRENT_CONFIG_VERSION,
    configVersion: config.configVersion,
    message: `Config version is current (${CURRENT_CONFIG_VERSION}).`,
    needsUpgrade: false,
  };
}

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  try {
    const result = checkConfigVersion();

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
    }

    // Exit code: 0 if current/newer, 1 if needs upgrade, 2 on error
    process.exit(result.needsUpgrade ? 1 : 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (jsonOutput) {
      console.log(JSON.stringify({
        status: 'error',
        currentVersion: CURRENT_CONFIG_VERSION,
        message,
        needsUpgrade: false,
      }, null, 2));
    } else {
      console.error(`Error: ${message}`);
    }

    process.exit(2);
  }
}

main();
